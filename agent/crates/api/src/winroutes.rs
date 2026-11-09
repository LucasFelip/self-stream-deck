//! Windows, screens and launching an app. Parity with `legacy/server/src/routes/windows.js` and `POST /api/launch/:id`: an action names a window
//! by handle, and the platform only acts on handles that are in the live window list.
#![allow(clippy::result_large_err)] // the Err of a route step is the whole HTTP answer to send
use std::sync::Arc;

use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{json, Map, Value};
use ssd_core::ports::{PortError, Projection, WindowAction, Zone};
use ssd_core::windows::visible_windows;

use crate::routes::{error, js_number, percent, port_error};
use crate::{apps, json, AppState};

fn object(body: &[u8]) -> Result<Map<String, Value>, Response> {
    match serde_json::from_slice::<Value>(if body.is_empty() { b"{}" } else { body }) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Ok(Map::new()),
        Err(_) => Err(error(StatusCode::BAD_REQUEST, "invalid JSON")),
    }
}

fn bad(message: &str) -> Response {
    error(StatusCode::BAD_REQUEST, message)
}

fn handle_of(request: &Map<String, Value>) -> Result<i64, Response> {
    match js_number(request.get("handle")) {
        Some(n) if n.fract() == 0.0 && n > 0.0 && n <= 9_007_199_254_740_991.0 => Ok(n as i64),
        _ => Err(bad("invalid window handle")),
    }
}

fn monitor_of(request: &Map<String, Value>) -> Result<usize, Response> {
    match js_number(request.get("monitor")) {
        Some(n) if n.fract() == 0.0 && (0.0..=15.0).contains(&n) => Ok(n as usize),
        _ => Err(bad("invalid monitor")),
    }
}

fn done(result: Result<(), PortError>) -> Response {
    match result {
        Ok(()) => json(StatusCode::OK, json!({ "ok": true })),
        Err(problem) => port_error(problem),
    }
}

/// A blocking platform call, on a thread of its own.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, Response> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "internal error"))
}

pub async fn windows_route(
    state: &Arc<AppState>,
    post: bool,
    path: &str,
    query: &str,
    body: &[u8],
) -> Response {
    match route(state, post, path, query, body).await {
        Ok(response) | Err(response) => response,
    }
}

async fn route(
    state: &Arc<AppState>,
    post: bool,
    path: &str,
    query: &str,
    body: &[u8],
) -> Result<Response, Response> {
    let Some(windows) = state.platform.windows.clone() else {
        return Ok(error(StatusCode::NOT_FOUND, "not found"));
    };
    if !post {
        return match path {
            "/api/windows" => {
                let snapshot = blocking({
                    let windows = windows.clone();
                    move || windows.snapshot()
                })
                .await?
                .map_err(port_error)?;
                Ok(json(
                    StatusCode::OK,
                    json!({ "windows": visible_windows(&snapshot, &apps::visible(state)) }),
                ))
            }
            _ => {
                // ?brightness=0 skips the slow DDC/CI reads when only the layout is needed
                let with_brightness = !query.split('&').any(|pair| pair == "brightness=0");
                let monitors = blocking(move || windows.monitors(with_brightness))
                    .await?
                    .map_err(port_error)?;
                Ok(json(StatusCode::OK, json!({ "monitors": monitors })))
            }
        };
    }
    let request = object(body)?;
    Ok(match path {
        "/api/windows/action" => {
            let action = match request.get("action").and_then(Value::as_str) {
                Some("focus") => WindowAction::Focus,
                Some("minimize") => WindowAction::Minimize,
                Some("maximize") => WindowAction::Maximize,
                Some("restore") => WindowAction::Restore,
                Some("close") => WindowAction::Close,
                _ => return Err(bad("invalid action")),
            };
            let handle = handle_of(&request)?;
            done(blocking(move || windows.action(handle, action)).await?)
        }
        "/api/windows/move" => {
            let monitor = monitor_of(&request)?;
            let handle = handle_of(&request)?;
            done(blocking(move || windows.move_to_monitor(handle, monitor)).await?)
        }
        // the position inside the virtual desktop is in real pixels; the page draws the layout to scale
        "/api/windows/place" => {
            let number = |name: &str| {
                js_number(request.get(name))
                    .map(f64::round)
                    .ok_or_else(|| bad(&format!("{name} must be a number")))
            };
            let (x, y) = (number("x")?, number("y")?);
            if x.abs() > 100_000.0 || y.abs() > 100_000.0 {
                return Err(bad("position out of range"));
            }
            let handle = handle_of(&request)?;
            done(blocking(move || windows.place(handle, x as i32, y as i32)).await?)
        }
        "/api/windows/snap" => {
            let monitor = monitor_of(&request)?;
            let zone = match request.get("zone").and_then(Value::as_str) {
                Some("left") => Zone::Left,
                Some("right") => Zone::Right,
                Some("full") => Zone::Full,
                _ => return Err(bad("invalid zone")),
            };
            let handle = handle_of(&request)?;
            done(blocking(move || windows.snap(handle, monitor, zone)).await?)
        }
        "/api/screens/brightness" => {
            let device = request
                .get("device")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let known = blocking({
                let windows = windows.clone();
                move || windows.monitors(false)
            })
            .await?
            .map_err(port_error)?
            .iter()
            .any(|monitor| monitor.device == device);
            if !known {
                return Err(error(StatusCode::NOT_FOUND, "unknown screen"));
            }
            let level = percent(request.get("level"), "level")?;
            done(blocking(move || windows.set_brightness(&device, level)).await?)
        }
        "/api/screens/off" => done(blocking(move || windows.screens_off()).await?),
        // Windows' own projection switcher. The single-screen modes can leave one monitor black, so they must be confirmed.
        "/api/screens/project" => {
            let mode = match request.get("mode").and_then(Value::as_str) {
                Some("extend") => Projection::Extend,
                Some("clone") => Projection::Clone,
                Some("first") => Projection::FirstOnly,
                Some("second") => Projection::SecondOnly,
                _ => return Err(bad("invalid mode")),
            };
            if matches!(mode, Projection::FirstOnly | Projection::SecondOnly)
                && request.get("confirm") != Some(&Value::Bool(true))
            {
                return Err(bad("confirmation required"));
            }
            done(blocking(move || windows.project(mode)).await?)
        }
        _ => error(StatusCode::NOT_FOUND, "not found"),
    })
}

/// Only ids from the taskbar list can be launched, never arbitrary paths. An app that already has a window is brought to the front instead
/// of being started again.
/// Brings the app's window to the front when it has one, else starts it (like a click on the taskbar).
pub(crate) async fn launch_app(
    state: &Arc<AppState>,
    app: &ssd_core::taskbar::App,
) -> Result<&'static str, PortError> {
    let (Some(windows), Some(taskbar)) = (
        state.platform.windows.clone(),
        state.platform.taskbar.clone(),
    ) else {
        return Err(PortError::Failed(
            "launching is not available on this agent".into(),
        ));
    };
    let app = app.clone();
    let work = move || -> Result<&'static str, PortError> {
        if let Some(process) = &app.proc {
            let open = windows
                .snapshot()
                .map(|s| s.windows.iter().any(|w| &w.name == process))
                .unwrap_or(false);
            // a window that cannot be focused is not a reason to fail: the app is started instead
            if open && windows.focus_process(process).unwrap_or(false) {
                return Ok("focused");
            }
        }
        taskbar.launch(&app.lnk)?;
        Ok("launched")
    };
    tokio::task::spawn_blocking(work)
        .await
        .unwrap_or_else(|_| Err(PortError::Failed("internal error".into())))
}

/// Only ids from the taskbar list can be launched, never arbitrary paths.
pub async fn launch(state: &Arc<AppState>, id: &str) -> Response {
    let Some(app) = apps::visible(state).into_iter().find(|app| app.id == id) else {
        return error(StatusCode::NOT_FOUND, "unknown app");
    };
    match launch_app(state, &app).await {
        Ok(action) => json(
            StatusCode::OK,
            json!({ "ok": true, "name": app.name, "action": action }),
        ),
        Err(problem) => port_error(problem),
    }
}
