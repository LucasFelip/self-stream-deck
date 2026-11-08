//! The routes already answered by this agent (plan 3.2, in order). Anything not listed here goes to the Node agent through the proxy.
//! Ported so far: the ones that only read or write `config.json` (`/api/pair-code`, `/api/layout`) and the audio module
//! (`/api/volume`, `/api/mic`, `/api/audio*`), the last one only when the agent has an `AudioPort`.
#![allow(clippy::result_large_err)] // the Err of a route step is the whole HTTP answer to send
use std::sync::Arc;

use axum::http::{Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Map, Value};
use ssd_core::ports::{AudioPort, Mute, Percent, PortError};

use crate::{json, AppState};

/// How much body each route reads (the Node agent used 64 KB for the layout and 4 KB for everything else).
pub fn body_limit(path: &str) -> usize {
    if path == "/api/layout" {
        64 * 1024
    } else {
        4096
    }
}

/// A key of the Apps or Atalhos page: `a:<app>`, `s:<shortcut>`, `m:<macro>` or `c:<camera>`.
fn is_tile_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    bytes.len() >= 3
        && bytes.len() <= 50
        && matches!(bytes[0], b'a' | b's' | b'm' | b'c')
        && bytes[1] == b':'
        && bytes[2..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'-')
}

fn tile_order(state: &AppState) -> Value {
    let config = state.config.lock().unwrap();
    let stored = config
        .get("tileOrder")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut order = Map::new();
    order.insert("apps".into(), json!([]));
    order.insert("shortcuts".into(), json!([]));
    for (key, value) in stored {
        order.insert(key, value);
    }
    Value::Object(order)
}

fn error(status: StatusCode, message: &str) -> Response {
    json(status, json!({ "error": message }))
}

fn port_error(error_: PortError) -> Response {
    match error_ {
        PortError::NotFound(message) => error(StatusCode::NOT_FOUND, &message),
        PortError::Failed(message) => error(StatusCode::INTERNAL_SERVER_ERROR, &message),
    }
}

/// True when this agent answers the route.
pub fn is_ported(state: &AppState, method: &Method, path: &str) -> bool {
    match (method, path) {
        (&Method::GET, "/api/pair-code") | (&Method::GET | &Method::POST, "/api/layout") => true,
        (&Method::GET | &Method::POST, "/api/volume")
        | (&Method::GET, "/api/audio")
        | (
            &Method::POST,
            "/api/mic" | "/api/audio/default" | "/api/audio/device" | "/api/audio/session",
        ) => state.audio.is_some(),
        _ => false,
    }
}

pub async fn answer(state: &Arc<AppState>, method: &Method, path: &str, body: &[u8]) -> Response {
    match (method, path) {
        (&Method::GET, "/api/pair-code") => {
            json(StatusCode::OK, json!({ "code": state.guard.token() }))
        }
        (&Method::GET, "/api/layout") => json(StatusCode::OK, tile_order(state)),
        (&Method::POST, "/api/layout") => save_layout(state, body),
        _ => match &state.audio {
            Some(audio) => {
                let (audio, path, body) = (audio.clone(), path.to_owned(), body.to_vec());
                let post = method == Method::POST;
                // COM calls block: they run on a thread of their own, never on the ones that serve requests
                tokio::task::spawn_blocking(move || audio_route(audio.as_ref(), post, &path, &body))
                    .await
                    .unwrap_or_else(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "internal error"))
            }
            None => error(StatusCode::NOT_FOUND, "not found"),
        },
    }
}

fn save_layout(state: &Arc<AppState>, body: &[u8]) -> Response {
    if state.config.lock().unwrap().get("editor") == Some(&Value::Bool(false)) {
        return error(
            StatusCode::FORBIDDEN,
            "the editor is turned off in config.json",
        );
    }
    let Ok(Value::Object(request)) =
        serde_json::from_slice::<Value>(if body.is_empty() { b"{}" } else { body })
    else {
        return error(StatusCode::BAD_REQUEST, "invalid JSON");
    };
    let Some(page) = request
        .get("page")
        .and_then(Value::as_str)
        .filter(|p| *p == "apps" || *p == "shortcuts")
    else {
        return error(StatusCode::BAD_REQUEST, "invalid page");
    };
    let order = request
        .get("order")
        .and_then(Value::as_array)
        .filter(|o| o.len() <= 200 && o.iter().all(|k| k.as_str().is_some_and(is_tile_key)));
    let Some(order) = order else {
        return error(StatusCode::BAD_REQUEST, "invalid order");
    };

    // repeated keys keep their first place
    let mut seen = std::collections::HashSet::new();
    let unique: Vec<Value> = order
        .iter()
        .filter(|k| seen.insert(k.as_str().unwrap_or_default().to_owned()))
        .cloned()
        .collect();

    let mut next = tile_order(state).as_object().cloned().unwrap_or_default();
    next.insert(page.to_owned(), Value::Array(unique));
    let mut patch = Map::new();
    patch.insert("tileOrder".into(), Value::Object(next));
    if let Err(problem) = state.config.lock().unwrap().update(&patch) {
        return error(StatusCode::BAD_REQUEST, &problem.to_string());
    }
    json(StatusCode::OK, tile_order(state))
}

// ---- audio -------------------------------------------------------------------------------------------------------------------------

/// JavaScript's `Number(value)` for what a JSON body can hold: a missing field or something that is not a number is `None`.
fn js_number(value: Option<&Value>) -> Option<f64> {
    let number = match value? {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => match s.trim() {
            "" => 0.0,
            text => text.parse::<f64>().ok()?,
        },
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Null => 0.0,
        _ => return None,
    };
    number.is_finite().then_some(number)
}

/// `percent()` of the Node agent: a number, rounded, held between 0 and 100.
fn percent(value: Option<&Value>, name: &str) -> Result<Percent, Response> {
    js_number(value)
        .map(|n| n.round().clamp(0.0, 100.0) as Percent)
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, &format!("{name} must be a number")))
}

fn mute_of(value: &Value) -> Option<Mute> {
    match value {
        Value::Bool(b) => Some(Mute::Set(*b)),
        Value::String(s) if s == "toggle" => Some(Mute::Toggle),
        _ => None,
    }
}

fn ok() -> Response {
    json(StatusCode::OK, json!({ "ok": true }))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tile_keys_are_a_letter_a_colon_and_up_to_48_safe_characters() {
        for ok in ["a:app1", "s:copy", "m:abc-123", "c:camera"] {
            assert!(is_tile_key(ok), "{ok}");
        }
        for bad in [
            "x:app",
            "a:",
            "a-app",
            "a:a b",
            "a:../x",
            &format!("a:{}", "z".repeat(49)),
        ] {
            assert!(!is_tile_key(bad), "{bad}");
        }
    }

    #[test]
    fn numbers_follow_javascript_number() {
        assert_eq!(js_number(Some(&json!(41.6))), Some(41.6));
        assert_eq!(js_number(Some(&json!("50"))), Some(50.0));
        assert_eq!(js_number(Some(&json!(""))), Some(0.0));
        assert_eq!(js_number(Some(&json!(null))), Some(0.0));
        assert_eq!(js_number(Some(&json!(true))), Some(1.0));
        assert_eq!(js_number(Some(&json!("abc"))), None);
        assert_eq!(js_number(Some(&json!([1]))), None);
        assert_eq!(js_number(None), None);
    }
}
