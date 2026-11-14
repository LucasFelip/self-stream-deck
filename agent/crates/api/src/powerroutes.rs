//! Energia and the state of the header: `GET/POST /api/power` and `GET /api/state`. Parity with `legacy/server/src/routes/pc.js` (power) and
//! `routes/apps.js` (state); the rules of the power actions are in `ssd_core::power`.
use ssd_core::sync::Locked;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{json, Map, Value};
use ssd_core::power::{perform, schedule_view, Request, ACTIONS};

use crate::routes::error;
use crate::{apps, json, AppState};

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

fn blocking_failed() -> Response {
    error(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

/// The scheduled shutdown as the phone sees it (and forgets it once its time has passed).
pub fn scheduled_now(state: &AppState) -> Option<Value> {
    schedule_view(&mut state.scheduled.locked(), now_ms())
}

/// `GET /api/power`.
pub async fn build_power(state: &Arc<AppState>) -> Option<Value> {
    let power = state.platform.power.clone()?;
    let windows = state.platform.windows.clone()?;
    let raw = tokio::task::spawn_blocking(move || (power.raw(), windows.snapshot()))
        .await
        .ok()?;
    let (raw, snapshot) = (raw.0.ok()?, raw.1.unwrap_or_default());
    let names: Vec<(String, String)> = apps::visible(state)
        .into_iter()
        .filter_map(|app| app.proc.map(|proc| (proc, app.name)))
        .collect();
    let now = now_ms();
    let enabled = state.config.locked().get("powerControls") != Some(&Value::Bool(false));
    let mut body = Map::new();
    body.insert("enabled".into(), json!(enabled));
    body.extend(ssd_core::power::info(
        &raw,
        &snapshot,
        &names,
        scheduled_now(state),
        now,
    ));
    Some(Value::Object(body))
}

/// The newest modification time under the interface folder: the page reloads itself when it changes (an updated interface appears without
/// closing and reopening the app). Cached for 1.5 s.
fn ui_version(state: &AppState) -> u64 {
    fn newest(dir: &Path, best: &mut u64) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_dir() {
                newest(&path, best);
            } else if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
                *best = (*best).max(
                    modified
                        .duration_since(UNIX_EPOCH)
                        .map_or(0, |d| d.as_millis() as u64),
                );
            }
        }
    }
    let mut cache = state.ui_cache.locked();
    if cache
        .0
        .is_none_or(|at| at.elapsed() > Duration::from_millis(1500))
    {
        let mut best = 0;
        if state.web_dir.as_os_str().is_empty() {
            best = crate::embedded::newest_ms();
        } else {
            newest(&state.web_dir, &mut best);
        }
        *cache = (Some(Instant::now()), best);
    }
    cache.1
}

/// What is playing, for the header's mini player (and shared for 1.5 s: several pages ask within the same second).
async fn now_playing(state: &Arc<AppState>) -> Value {
    if state.config.locked().get("miniPlayer") == Some(&Value::Bool(false)) {
        return Value::Null;
    }
    if let Some((at, value)) = state.playing_cache.locked().as_ref() {
        if at.elapsed() < Duration::from_millis(1500) {
            return value.clone();
        }
    }
    let value = async {
        let media = state.platform.media.clone()?;
        let current = tokio::task::spawn_blocking(move || media.state()).await.ok()?.ok()?;
        let session = current.sessions.iter().find(|s| Some(&s.id) == current.current.as_ref()).or_else(|| current.sessions.iter().find(|s| s.status == "playing")).or_else(|| current.sessions.first())?;
        Some(json!({ "session": session.id, "title": session.title, "artist": session.artist, "app": session.app, "status": session.status, "canToggle": session.can_play || session.can_pause }))
    }
    .await
    .unwrap_or(Value::Null);
    *state.playing_cache.locked() = Some((Instant::now(), value.clone()));
    value
}

/// Everything the header and the volume strip show, in one object (`GET /api/state` and the "state" event).
pub async fn build_state(state: &Arc<AppState>) -> Option<Value> {
    let windows = state.platform.windows.clone()?;
    let audio = state.platform.audio.clone()?;
    let snapshot = tokio::task::spawn_blocking(move || windows.snapshot())
        .await
        .ok()?
        .unwrap_or_default();
    let (mic, volume) =
        tokio::task::spawn_blocking(move || (audio.mic().ok(), audio.volume().ok()))
            .await
            .ok()?;
    let playing = now_playing(state).await;
    let apps_now = apps::visible(state);
    let on = |wanted: &dyn Fn(&str) -> bool| -> Vec<&str> {
        apps_now
            .iter()
            .filter(|a| a.proc.as_deref().is_some_and(wanted))
            .map(|a| a.id.as_str())
            .collect()
    };
    let running = on(&|proc| snapshot.running.iter().any(|name| name == proc));
    let open = on(&|proc| snapshot.windows.iter().any(|w| w.name == proc));
    Some(json!({
        "running": running,
        "open": open,
        "scheduled": scheduled_now(state),
        "mic": mic,
        "volume": volume,
        "playing": playing,
        "miniPlayer": state.config.locked().get("miniPlayer") != Some(&Value::Bool(false)),
        "ui": ui_version(state),
        "appsRev": state.apps.locked().rev,
    }))
}

/// `/api/state` needs the windows, the audio, the media and the power ports (it is made of all of them).
pub fn state_ready(state: &AppState) -> bool {
    let p = &state.platform;
    p.windows.is_some() && p.audio.is_some() && p.media.is_some() && p.power.is_some()
}

pub async fn state_route(state: &Arc<AppState>) -> Response {
    match build_state(state).await {
        Some(body) => json(StatusCode::OK, body),
        None => blocking_failed(),
    }
}

pub async fn power_route(state: &Arc<AppState>, post: bool, body: &[u8]) -> Response {
    if !post {
        return match build_power(state).await {
            Some(info) => json(StatusCode::OK, info),
            None => blocking_failed(),
        };
    }
    let Some(power) = state.platform.power.clone() else {
        return error(StatusCode::NOT_FOUND, "not found");
    };
    if state.config.locked().get("powerControls") == Some(&Value::Bool(false)) {
        return error(
            StatusCode::FORBIDDEN,
            "power controls are disabled in config.json",
        );
    }
    let request = match serde_json::from_slice::<Value>(if body.is_empty() { b"{}" } else { body })
    {
        Ok(Value::Object(map)) => map,
        Ok(_) => Map::new(),
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid JSON"),
    };
    let action = request
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if !ACTIONS.contains(&action.as_str()) {
        return error(StatusCode::BAD_REQUEST, "unknown action");
    }
    // a destructive action must say so explicitly; the UI asks the person to hold the button
    if action != "cancel" && request.get("confirm") != Some(&Value::Bool(true)) {
        return error(StatusCode::BAD_REQUEST, "confirmation required");
    }
    let asked = Request {
        action,
        delay: request.get("delaySec").cloned(),
        force: request.get("force") == Some(&Value::Bool(true)),
        hybrid: request.get("hybrid") == Some(&Value::Bool(true)),
    };
    let state = state.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let mut scheduled = state.scheduled.locked();
        perform(power.as_ref(), &asked, &mut scheduled, now_ms())
    })
    .await;
    match outcome {
        Ok(Ok(result)) => {
            let mut body = Map::new();
            body.insert("ok".into(), json!(true));
            if let Value::Object(extra) = result {
                body.extend(extra);
            }
            json(StatusCode::OK, Value::Object(body))
        }
        Ok(Err(problem)) => error(
            StatusCode::from_u16(problem.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            &problem.message,
        ),
        Err(_) => blocking_failed(),
    }
}

pub(crate) fn routes() -> axum::Router<Arc<AppState>> {
    use crate::routes::not_found;
    use axum::routing::get;
    axum::Router::new()
        .route("/api/power", get(power).post(power).fallback(not_found))
        .route("/api/state", get(header_state).fallback(not_found))
}

async fn power(call: crate::routes::Call) -> Response {
    if call.state.platform.power.is_none() || call.state.platform.windows.is_none() {
        return crate::routes::not_found().await;
    }
    power_route(&call.state, call.post, &call.body).await
}

async fn header_state(call: crate::routes::Call) -> Response {
    if !state_ready(&call.state) {
        return crate::routes::not_found().await;
    }
    state_route(&call.state).await
}
