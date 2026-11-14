//! Volume, microphone, devices and the per-app mixer (`AudioPort`).
#![allow(clippy::result_large_err)] // the Err of a route step is the whole HTTP answer to send
use std::sync::Arc;

use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Map, Value};
use ssd_core::ports::{AudioPort, Mute};

use crate::routes::{error, js_number, not_found, ok, percent, port_error, Call};
use crate::{json, AppState};

pub(crate) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/volume", get(handle).post(handle).fallback(not_found))
        .route("/api/audio", get(handle).fallback(not_found))
        .route("/api/mic", post(handle).fallback(not_found))
        .route("/api/audio/default", post(handle).fallback(not_found))
        .route("/api/audio/device", post(handle).fallback(not_found))
        .route("/api/audio/session", post(handle).fallback(not_found))
}

async fn handle(call: Call) -> Response {
    let Some(audio) = call.state.platform.audio.clone() else {
        return not_found().await;
    };
    // COM calls block: they run on a thread of their own, never on the ones that serve requests
    tokio::task::spawn_blocking(move || {
        audio_route(audio.as_ref(), call.post, &call.path, &call.body)
    })
    .await
    .unwrap_or_else(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "internal error"))
}

fn mute_of(value: &Value) -> Option<Mute> {
    match value {
        Value::Bool(b) => Some(Mute::Set(*b)),
        Value::String(s) if s == "toggle" => Some(Mute::Toggle),
        _ => None,
    }
}

fn audio_route(audio: &dyn AudioPort, post: bool, path: &str, body: &[u8]) -> Response {
    let request = if post {
        match serde_json::from_slice::<Value>(if body.is_empty() { b"{}" } else { body }) {
            Ok(Value::Object(map)) => map,
            _ => return error(StatusCode::BAD_REQUEST, "invalid JSON"),
        }
    } else {
        Map::new()
    };
    let result: Result<Response, Response> = (|| {
        let known = |id: Option<&Value>| -> Result<String, Response> {
            let id = id.and_then(Value::as_str).unwrap_or_default().to_owned();
            let devices = audio.devices().map_err(port_error)?;
            if devices
                .playback
                .iter()
                .chain(devices.capture.iter())
                .any(|d| d.id == id)
            {
                Ok(id)
            } else {
                Err(error(StatusCode::NOT_FOUND, "unknown device"))
            }
        };
        match (post, path) {
            (false, "/api/volume") => Ok(json(
                StatusCode::OK,
                json!(audio.volume().map_err(port_error)?),
            )),
            (true, "/api/volume") => {
                let mut result = None;
                if request.contains_key("level") && !request["level"].is_null() {
                    result = Some(
                        audio
                            .set_volume(percent(request.get("level"), "level")?)
                            .map_err(port_error)?,
                    );
                }
                if let Some(mute) = request.get("muted").and_then(mute_of) {
                    result = Some(audio.set_mute(mute).map_err(port_error)?);
                }
                let volume = match result {
                    Some(volume) => volume,
                    None => audio.volume().map_err(port_error)?,
                };
                Ok(json(StatusCode::OK, json!(volume)))
            }
            (true, "/api/mic") => {
                let Some(mute) = request.get("muted").and_then(mute_of) else {
                    return Err(error(
                        StatusCode::BAD_REQUEST,
                        "muted must be true, false or \"toggle\"",
                    ));
                };
                Ok(json(
                    StatusCode::OK,
                    json!(audio.set_mic(mute).map_err(port_error)?),
                ))
            }
            (false, "/api/audio") => {
                let devices = audio.devices().map_err(port_error)?;
                let sessions = audio.sessions().unwrap_or_default();
                Ok(json(
                    StatusCode::OK,
                    json!({ "playback": devices.playback, "capture": devices.capture, "sessions": sessions }),
                ))
            }
            (true, "/api/audio/default") => {
                audio
                    .set_default_device(&known(request.get("id"))?)
                    .map_err(port_error)?;
                Ok(ok())
            }
            (true, "/api/audio/device") => {
                let id = known(request.get("id"))?;
                if request.get("level").is_some_and(|v| !v.is_null()) {
                    audio
                        .set_device_volume(&id, percent(request.get("level"), "level")?)
                        .map_err(port_error)?;
                }
                if let Some(Value::Bool(muted)) = request.get("muted") {
                    audio.set_device_mute(&id, *muted).map_err(port_error)?;
                }
                Ok(ok())
            }
            (true, "/api/audio/session") => {
                let system = request.get("system") == Some(&Value::Bool(true));
                let pid = if system {
                    0.0
                } else {
                    js_number(request.get("pid"))
                        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "pid must be a number"))?
                };
                if pid.fract() != 0.0 || !(0.0..=f64::from(u32::MAX)).contains(&pid) {
                    return Err(error(StatusCode::BAD_REQUEST, "invalid pid"));
                }
                let pid = pid as u32;
                if request.get("level").is_some_and(|v| !v.is_null()) {
                    audio
                        .set_session_volume(pid, system, percent(request.get("level"), "level")?)
                        .map_err(port_error)?;
                }
                if let Some(Value::Bool(muted)) = request.get("muted") {
                    audio
                        .set_session_mute(pid, system, *muted)
                        .map_err(port_error)?;
                }
                Ok(ok())
            }
            _ => Ok(error(StatusCode::NOT_FOUND, "not found")),
        }
    })();
    result.unwrap_or_else(|response| response)
}
