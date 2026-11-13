//! The button editor and the macros: `GET /api/editor`, `POST /api/editor/{shortcuts,macros,apps}`, `GET /api/macros` and
//! `POST /api/macro/:id`. Parity with `legacy/server/src/routes/editor.js` and `routes/macros.js`; what may be saved is validated in
//! `ssd_core::macros`, and a macro can only do what its whitelisted steps say.
#![allow(clippy::result_large_err)] // the Err of a route step is the whole HTTP answer to send
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{json, Map, Value};
use ssd_core::macros::{macro_list, normalize_macros, normalize_shortcuts};
use ssd_core::ports::{Mute, Zone};
use ssd_core::taskbar::{to_apps, App};

use crate::routes::error;
use crate::shortcuts::shortcuts;
use crate::winroutes::launch_app;
use crate::{json, AppState};

fn all_apps(state: &AppState) -> Vec<App> {
    to_apps(&state.apps.lock().unwrap().items, &[])
}

/// The editor can be turned off with `"editor": false`.
fn editor_on(state: &AppState) -> Result<(), Response> {
    if state.config.lock().unwrap().get("editor") == Some(&Value::Bool(false)) {
        Err(error(
            StatusCode::FORBIDDEN,
            "the editor is turned off in config.json",
        ))
    } else {
        Ok(())
    }
}

fn save(state: &AppState, key: &str, value: Vec<Value>) -> Result<(), Response> {
    let mut patch = Map::new();
    patch.insert(key.to_owned(), Value::Array(value));
    state
        .config
        .lock()
        .unwrap()
        .update(&patch)
        .map_err(|problem| error(StatusCode::BAD_REQUEST, &problem.to_string()))
}

fn shortcut_list(state: &AppState) -> Vec<Value> {
    shortcuts(state)
        .iter()
        .map(|s| json!({ "id": s.id, "label": s.label, "keys": s.keys, "display": s.display }))
        .collect()
}

fn macros_now(state: &AppState) -> Vec<Value> {
    macro_list(state.config.lock().unwrap().get("macros"))
        .into_iter()
        .map(Value::Object)
        .collect()
}

fn body_object(body: &[u8]) -> Result<Map<String, Value>, Response> {
    match serde_json::from_slice::<Value>(if body.is_empty() { b"{}" } else { body }) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Ok(Map::new()),
        Err(_) => Err(error(StatusCode::BAD_REQUEST, "invalid JSON")),
    }
}

pub async fn editor_route(state: &Arc<AppState>, post: bool, path: &str, body: &[u8]) -> Response {
    match route(state, post, path, body).await {
        Ok(response) | Err(response) => response,
    }
}

async fn route(
    state: &Arc<AppState>,
    post: bool,
    path: &str,
    body: &[u8],
) -> Result<Response, Response> {
    editor_on(state)?;
    if !post {
        let hidden: HashSet<String> = match state.config.lock().unwrap().get("hidden") {
            Some(Value::Array(ids)) => ids
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect(),
            _ => HashSet::new(),
        };
        let (devices, monitors) =
            match (state.platform.audio.clone(), state.platform.windows.clone()) {
                (Some(audio), Some(windows)) => tokio::task::spawn_blocking(move || {
                    (
                        audio.devices().unwrap_or_default(),
                        windows.monitors(false).unwrap_or_default(),
                    )
                })
                .await
                .unwrap_or_default(),
                _ => (Default::default(), Vec::new()),
            };
        let names = |list: &[ssd_core::ports::AudioDevice]| {
            list.iter()
                .map(|d| json!({ "id": d.id, "name": d.name }))
                .collect::<Vec<_>>()
        };
        let apps: Vec<Value> = all_apps(state)
            .iter()
            .map(|a| json!({ "id": a.id, "name": a.name, "hasIcon": a.has_icon, "iconVersion": a.icon_version, "hidden": hidden.contains(&a.id), "canPlace": a.proc.is_some() }))
            .collect();
        return Ok(json(
            StatusCode::OK,
            json!({
                "shortcuts": shortcut_list(state),
                "macros": macros_now(state),
                "apps": apps,
                "devices": { "playback": names(&devices.playback), "capture": names(&devices.capture) },
                "screens": monitors.len().max(1),
            }),
        ));
    }
    let request = body_object(body)?;
    Ok(match path {
        "/api/editor/shortcuts" => {
            let typing = state.config.lock().unwrap().flag("typingKeys");
            let items = normalize_shortcuts(request.get("items"), typing)
                .map_err(|e| error(StatusCode::BAD_REQUEST, &e.0))?;
            save(state, "shortcuts", items)?;
            json(StatusCode::OK, json!({ "shortcuts": shortcut_list(state) }))
        }
        "/api/editor/macros" => {
            let known: HashSet<String> = all_apps(state).into_iter().map(|a| a.id).collect();
            let typing = state.config.lock().unwrap().flag("typingKeys");
            let items = normalize_macros(request.get("items"), &known, typing)
                .map_err(|e| error(StatusCode::BAD_REQUEST, &e.0))?;
            save(state, "macros", items)?;
            json(StatusCode::OK, json!({ "macros": macros_now(state) }))
        }
        "/api/editor/apps" => {
            let known: HashSet<String> = all_apps(state).into_iter().map(|a| a.id).collect();
            let Some(Value::Array(hidden)) = request.get("hidden") else {
                return Err(error(StatusCode::BAD_REQUEST, "invalid hidden"));
            };
            if hidden.len() > 200
                || hidden
                    .iter()
                    .any(|id| !id.as_str().is_some_and(|id| known.contains(id)))
            {
                return Err(error(StatusCode::BAD_REQUEST, "invalid hidden"));
            }
            let mut seen = HashSet::new();
            let unique: Vec<Value> = hidden
                .iter()
                .filter(|id| seen.insert(id.as_str().unwrap_or_default().to_owned()))
                .cloned()
                .collect();
            save(state, "hidden", unique)?;
            json(StatusCode::OK, json!({ "ok": true }))
        }
        _ => error(StatusCode::NOT_FOUND, "not found"),
    })
}

// ---- macros ------------------------------------------------------------------------------------------------------------------------

pub fn macros_list(state: &AppState) -> Response {
    let list: Vec<Value> = macros_now(state)
        .iter()
        .map(|m| json!({ "id": m["id"], "label": m["label"], "page": m["page"].as_str().unwrap_or("shortcuts"), "steps": m["steps"].as_array().map_or(0, Vec::len) }))
        .collect();
    json(StatusCode::OK, json!({ "macros": list }))
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())
}

fn text_of(step: &Value, key: &str) -> String {
    step.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn mute_of(step: &Value) -> Mute {
    match step.get("muted") {
        Some(Value::Bool(b)) => Mute::Set(*b),
        _ => Mute::Toggle,
    }
}

/// One step. A failing step is reported and the macro goes on.
async fn run_step(state: &Arc<AppState>, step: &Value) -> Result<(), String> {
    let missing = |what: &str| format!("{what} is not available on this agent");
    match step.get("type").and_then(Value::as_str).unwrap_or_default() {
        "launch" => {
            let id = text_of(step, "app");
            let Some(app) = all_apps(state).into_iter().find(|a| a.id == id) else {
                return Err("app not on the taskbar anymore".into());
            };
            launch_app(state, &app)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        "keys" => {
            let vks = ssd_core::keys::parse(&text_of(step, "keys"))?;
            let input = state
                .platform
                .input
                .clone()
                .ok_or_else(|| missing("the keyboard"))?;
            blocking(move || input.press_keys(&vks))
                .await?
                .map_err(|e| e.to_string())
        }
        "media" => {
            let vk = match text_of(step, "key").as_str() {
                "prev" => 0xb1,
                "playpause" => 0xb3,
                _ => 0xb0,
            };
            let input = state
                .platform
                .input
                .clone()
                .ok_or_else(|| missing("the keyboard"))?;
            blocking(move || input.press_keys(&[vk]))
                .await?
                .map_err(|e| e.to_string())
        }
        "volume" => {
            let audio = state
                .platform
                .audio
                .clone()
                .ok_or_else(|| missing("the audio"))?;
            let level = step
                .get("level")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .min(100) as u8;
            blocking(move || audio.set_volume(level))
                .await?
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        "mute" => {
            let audio = state
                .platform
                .audio
                .clone()
                .ok_or_else(|| missing("the audio"))?;
            let mute = mute_of(step);
            blocking(move || audio.set_mute(mute))
                .await?
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        "mic" => {
            let audio = state
                .platform
                .audio
                .clone()
                .ok_or_else(|| missing("the audio"))?;
            let mute = mute_of(step);
            blocking(move || audio.set_mic(mute))
                .await?
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        "output" => {
            let audio = state
                .platform
                .audio
                .clone()
                .ok_or_else(|| missing("the audio"))?;
            let (device, name) = (text_of(step, "device"), text_of(step, "name"));
            let known = {
                let (audio, device) = (audio.clone(), device.clone());
                blocking(move || {
                    audio
                        .devices()
                        .map(|d| {
                            d.playback
                                .iter()
                                .chain(d.capture.iter())
                                .any(|x| x.id == device)
                        })
                        .unwrap_or(false)
                })
                .await?
            };
            if !known {
                return Err(format!(
                    "device not found{}",
                    if name.is_empty() {
                        String::new()
                    } else {
                        format!(": {name}")
                    }
                ));
            }
            blocking(move || audio.set_default_device(&device))
                .await?
                .map_err(|e| e.to_string())
        }
        // brings an app's window to a screen's half or full size, waiting a few seconds for the window to exist (it may just have been launched)
        "place" => {
            let id = text_of(step, "app");
            let Some(app) = all_apps(state).into_iter().find(|a| a.id == id) else {
                return Err("app not found".into());
            };
            let Some(process) = app.proc.clone() else {
                return Err("app not found".into());
            };
            let windows = state
                .platform
                .windows
                .clone()
                .ok_or_else(|| missing("the window manager"))?;
            let monitor = step.get("monitor").and_then(Value::as_u64).unwrap_or(0) as usize;
            let zone = match text_of(step, "zone").as_str() {
                "left" => Zone::Left,
                "right" => Zone::Right,
                _ => Zone::Full,
            };
            let until = Instant::now() + Duration::from_secs(8);
            loop {
                let (windows_now, process) = (windows.clone(), process.clone());
                let found = blocking(move || {
                    windows_now.snapshot().ok().and_then(|s| {
                        s.windows
                            .into_iter()
                            .find(|w| w.name == process && !w.title.is_empty())
                    })
                })
                .await?;
                if let Some(window) = found {
                    let windows = windows.clone();
                    return blocking(move || windows.snap(window.handle, monitor, zone))
                        .await?
                        .map_err(|e| e.to_string());
                }
                if Instant::now() > until {
                    return Err(format!("{} has no window", app.name));
                }
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        }
        other => Err(format!("no handler for {other}")),
    }
}

pub async fn run_macro(state: &Arc<AppState>, id: &str) -> Response {
    let Some(found) = macros_now(state).into_iter().find(|m| m["id"] == id) else {
        return error(StatusCode::NOT_FOUND, "unknown macro");
    };
    if !state.running_macros.lock().unwrap().insert(id.to_owned()) {
        return error(StatusCode::CONFLICT, "this macro is already running");
    }
    let (mut results, mut client) = (Vec::new(), Vec::new());
    for step in found["steps"].as_array().cloned().unwrap_or_default() {
        let kind = text_of(&step, "type");
        let outcome = match kind.as_str() {
            // the camera belongs to the phone: the step is handed back to be run there
            "camera" => {
                client.push(step.clone());
                Ok(())
            }
            "wait" => {
                tokio::time::sleep(Duration::from_millis(
                    step.get("ms").and_then(Value::as_u64).unwrap_or(0),
                ))
                .await;
                Ok(())
            }
            _ => run_step(state, &step).await,
        };
        results.push(match outcome {
            Ok(()) => json!({ "type": kind, "ok": true }),
            Err(message) => json!({ "type": kind, "ok": false, "error": message }),
        });
    }
    state.running_macros.lock().unwrap().remove(id);
    let failed = results.iter().filter(|r| r["ok"] == false).count();
    json(
        StatusCode::OK,
        json!({ "ok": failed == 0, "label": found["label"], "steps": results, "client": client }),
    )
}

pub(crate) fn routes() -> axum::Router<Arc<AppState>> {
    use crate::routes::not_found;
    use axum::routing::{get, post};
    axum::Router::new()
        .route("/api/editor", get(editor).fallback(not_found))
        .route("/api/editor/shortcuts", post(editor).fallback(not_found))
        .route("/api/editor/macros", post(editor).fallback(not_found))
        .route("/api/editor/apps", post(editor).fallback(not_found))
        .route("/api/macros", get(macros).fallback(not_found))
        .route("/api/macro/*id", post(run).fallback(not_found))
}

async fn editor(call: crate::routes::Call) -> Response {
    editor_route(&call.state, call.post, &call.path, &call.body).await
}

async fn macros(call: crate::routes::Call) -> Response {
    macros_list(&call.state)
}

/// A macro can open apps, press keys, change the audio and place windows: without all of those parts there is nothing to run.
async fn run(call: crate::routes::Call) -> Response {
    let platform = &call.state.platform;
    if platform.audio.is_none()
        || platform.windows.is_none()
        || platform.input.is_none()
        || platform.taskbar.is_none()
    {
        return crate::routes::not_found().await;
    }
    let id = call.path.strip_prefix("/api/macro/").unwrap_or_default();
    run_macro(&call.state, id).await
}
