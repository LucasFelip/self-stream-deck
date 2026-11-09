//! The routes already answered by this agent (plan 3.2, in order). Anything not listed here goes to the Node agent through the proxy.
//! Ported so far: the ones that only read or write `config.json` (`/api/pair-code`, `/api/layout`) and the audio module
//! (`/api/volume`, `/api/mic`, `/api/audio*`), the last one only when the agent has an `AudioPort`.
#![allow(clippy::result_large_err)] // the Err of a route step is the whole HTTP answer to send
use std::sync::Arc;

use axum::http::{Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Map, Value};
use ssd_core::media::{is_art_key, sniff_mime};
use ssd_core::ports::{AudioPort, MediaAction, Mute, Percent, PortError};

use crate::{json, AppState};

/// How much body each route reads (the Node agent used 64 KB for the layout and 4 KB for everything else).
pub fn body_limit(path: &str) -> usize {
    if path == "/api/editor/macros" {
        128 * 1024
    } else if path == "/api/layout" || path.starts_with("/api/editor/") {
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

pub(crate) fn error(status: StatusCode, message: &str) -> Response {
    json(status, json!({ "error": message }))
}

pub(crate) fn port_error(error_: PortError) -> Response {
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
        ) => state.platform.audio.is_some(),
        (&Method::GET, "/api/media" | "/api/media/art") | (&Method::POST, "/api/media/control") => {
            state.platform.media.is_some()
        }
        (&Method::GET, "/api/shortcuts" | "/api/events" | "/api/editor" | "/api/macros") => true,
        (
            &Method::GET,
            "/api/monitor/sample"
            | "/api/monitor/fps"
            | "/api/monitor/processes"
            | "/api/monitor/info",
        ) => state.platform.monitor.is_some(),
        (&Method::POST, "/api/editor/shortcuts" | "/api/editor/macros" | "/api/editor/apps") => {
            true
        }
        (&Method::POST, p) if p.starts_with("/api/macro/") => {
            let p = &state.platform;
            p.audio.is_some() && p.windows.is_some() && p.input.is_some() && p.taskbar.is_some()
        }
        (&Method::GET | &Method::POST, "/api/power") => {
            state.platform.power.is_some() && state.platform.windows.is_some()
        }
        (&Method::GET, "/api/state") => crate::powerroutes::state_ready(state),
        (&Method::GET, "/api/windows" | "/api/screens")
        | (
            &Method::POST,
            "/api/windows/action"
            | "/api/windows/move"
            | "/api/windows/place"
            | "/api/windows/snap"
            | "/api/screens/brightness"
            | "/api/screens/off"
            | "/api/screens/project",
        ) => state.platform.windows.is_some(),
        (&Method::POST, p) if p.starts_with("/api/launch/") => {
            state.platform.windows.is_some() && state.platform.taskbar.is_some()
        }
        (&Method::GET, "/api/apps") | (&Method::POST, "/api/refresh") => {
            state.platform.taskbar.is_some()
        }
        (&Method::GET, p) if p.starts_with("/api/icon/") => state.platform.taskbar.is_some(),
        (&Method::POST, p)
            if p.starts_with("/api/shortcut/") || p.starts_with("/api/mediakey/") =>
        {
            state.platform.input.is_some()
        }
        _ => false,
    }
}

pub async fn answer(
    state: &Arc<AppState>,
    method: &Method,
    path: &str,
    query: &str,
    body: &[u8],
) -> Response {
    match (method, path) {
        (&Method::GET, "/api/pair-code") => {
            json(StatusCode::OK, json!({ "code": state.guard.token() }))
        }
        (&Method::GET, "/api/layout") => json(StatusCode::OK, tile_order(state)),
        (&Method::POST, "/api/layout") => save_layout(state, body),
        _ if path == "/api/shortcuts"
            || path.starts_with("/api/shortcut/")
            || path.starts_with("/api/mediakey/") =>
        {
            shortcut_route(state, method, path).await
        }
        (&Method::GET, "/api/events") => crate::events::subscribe(state, query).await,
        (&Method::GET, p) if p.starts_with("/api/monitor/") => {
            crate::monitorroutes::route(state, p).await
        }
        (&Method::GET, "/api/editor") => {
            crate::editor::editor_route(state, false, path, body).await
        }
        (&Method::POST, p) if p.starts_with("/api/editor/") => {
            crate::editor::editor_route(state, true, path, body).await
        }
        (&Method::GET, "/api/macros") => crate::editor::macros_list(state),
        (&Method::POST, p) if p.starts_with("/api/macro/") => {
            crate::editor::run_macro(state, &p["/api/macro/".len()..]).await
        }
        (&Method::GET | &Method::POST, "/api/power") => {
            crate::powerroutes::power_route(state, method == Method::POST, body).await
        }
        (&Method::GET, "/api/state") => crate::powerroutes::state_route(state).await,
        _ if path.starts_with("/api/windows") || path.starts_with("/api/screens") => {
            crate::winroutes::windows_route(state, method == Method::POST, path, query, body).await
        }
        (&Method::POST, p) if p.starts_with("/api/launch/") => {
            crate::winroutes::launch(state, &p["/api/launch/".len()..]).await
        }
        (&Method::GET, "/api/apps") => crate::apps::list(state),
        (&Method::POST, "/api/refresh") => crate::apps::refresh_route(state).await,
        (&Method::GET, p) if p.starts_with("/api/icon/") => {
            let id = p.strip_prefix("/api/icon/").unwrap_or_default();
            crate::apps::icon(state, id).await
        }
        _ if path.starts_with("/api/media") => media_route(state, path, query, body).await,
        _ => match &state.platform.audio {
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
pub(crate) fn js_number(value: Option<&Value>) -> Option<f64> {
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
pub(crate) fn percent(value: Option<&Value>, name: &str) -> Result<Percent, Response> {
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

// ---- media -------------------------------------------------------------------------------------------------------------------------

const MEDIA_ACTIONS: [&str; 6] = ["toggle", "play", "pause", "next", "previous", "seek"];

fn query_value(query: &str, name: &str) -> String {
    query
        .split('&')
        .find_map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (key == name).then(|| {
                ssd_core::guard::percent_decode(&value.replace('+', " ")).unwrap_or_default()
            })
        })
        .unwrap_or_default()
}

async fn media_route(state: &Arc<AppState>, path: &str, query: &str, body: &[u8]) -> Response {
    let Some(media) = state.platform.media.clone() else {
        return error(StatusCode::NOT_FOUND, "not found");
    };
    match path {
        "/api/media" => match tokio::task::spawn_blocking(move || media.state()).await {
            Ok(Ok(media_state)) => json(StatusCode::OK, json!(media_state)),
            Ok(Err(problem)) => port_error(problem),
            Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "internal error"),
        },
        "/api/media/control" => {
            let Ok(Value::Object(request)) =
                serde_json::from_slice::<Value>(if body.is_empty() { b"{}" } else { body })
            else {
                return error(StatusCode::BAD_REQUEST, "invalid JSON");
            };
            let session = match request.get("session").and_then(Value::as_str) {
                Some(s) if !s.is_empty() && s.chars().count() <= 300 => s.to_owned(),
                _ => return error(StatusCode::BAD_REQUEST, "invalid session"),
            };
            let name = request
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !MEDIA_ACTIONS.contains(&name) {
                return error(StatusCode::BAD_REQUEST, "invalid action");
            }
            let action = match name {
                "toggle" => MediaAction::Toggle,
                "play" => MediaAction::Play,
                "pause" => MediaAction::Pause,
                "next" => MediaAction::Next,
                "previous" => MediaAction::Previous,
                _ => {
                    let Some(position) = js_number(request.get("position")) else {
                        return error(StatusCode::BAD_REQUEST, "position must be a number");
                    };
                    if !(0.0..=7.0 * 24.0 * 3600.0).contains(&position) {
                        return error(StatusCode::BAD_REQUEST, "invalid position");
                    }
                    MediaAction::Seek(position)
                }
            };
            match tokio::task::spawn_blocking(move || media.control(&session, action)).await {
                Ok(Ok(accepted)) => {
                    json(StatusCode::OK, json!({ "ok": true, "accepted": accepted }))
                }
                Ok(Err(problem)) => port_error(problem),
                Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "internal error"),
            }
        }
        _ => media_art(state, media, query).await,
    }
}

/// Cover art is fetched once per track (the key changes with title, artist and album) and kept in memory.
async fn media_art(
    state: &Arc<AppState>,
    media: Arc<dyn ssd_core::ports::MediaPort>,
    query: &str,
) -> Response {
    let (session, key) = (query_value(query, "session"), query_value(query, "key"));
    if session.is_empty() || !is_art_key(&key) {
        return error(StatusCode::BAD_REQUEST, "invalid art request");
    }
    let cached = state.art.lock().unwrap().get(&key).cloned();
    let entry = match cached {
        Some(entry) => entry,
        None => {
            let wanted = session.clone();
            let art = match tokio::task::spawn_blocking(move || media.art(&wanted)).await {
                Ok(Ok(art)) => art,
                Ok(Err(problem)) => return port_error(problem),
                Err(_) => return error(StatusCode::INTERNAL_SERVER_ERROR, "internal error"),
            };
            let entry = art.filter(|a| !a.data.is_empty()).map(|a| {
                (
                    a.mime.unwrap_or_else(|| sniff_mime(&a.data).to_owned()),
                    a.data,
                )
            });
            state.art.lock().unwrap().remember(&key, entry.clone());
            entry
        }
    };
    let Some((mime, data)) = entry else {
        return error(StatusCode::NOT_FOUND, "no artwork");
    };
    let mut response = Response::new(axum::body::Body::from(data));
    if let Ok(value) = axum::http::HeaderValue::from_str(&mime) {
        response
            .headers_mut()
            .insert(axum::http::header::CONTENT_TYPE, value);
    }
    // the key changes per track, so the phone may keep the image for good
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("max-age=31536000, immutable"),
    );
    crate::with_security(response)
}

// ---- shortcuts and media keys ------------------------------------------------------------------------------------------------------

pub(crate) struct Shortcut {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) keys: String,
    pub(crate) display: String,
    pub(crate) vks: Vec<u8>,
}

/// What JavaScript's `String(value)` gives for what a config file can hold.
fn js_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// The shortcuts of `config.json` (or of the editor, which validates them); one that does not parse is left out, like the Node agent does.
pub(crate) fn shortcuts(state: &AppState) -> Vec<Shortcut> {
    let config = state.config.lock().unwrap();
    let Some(Value::Array(entries)) = config.get("shortcuts") else {
        return Vec::new();
    };
    entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            let keys = js_string(entry.get("keys")?)?;
            let id = entry
                .get("id")
                .and_then(js_string)
                .unwrap_or_else(|| format!("shortcut-{index}"));
            let label = entry
                .get("label")
                .and_then(js_string)
                .unwrap_or_else(|| keys.clone());
            Some(Shortcut {
                id,
                label,
                display: ssd_core::keys::display(&keys).ok()?,
                keys: keys.clone(),
                vks: ssd_core::keys::parse(&keys).ok()?,
            })
        })
        .collect()
}

/// The global media keys (what the strip buttons send); the Media page talks to a specific player instead.
fn media_key(name: &str) -> Option<u8> {
    match name {
        "prev" => Some(0xb1),
        "playpause" => Some(0xb3),
        "next" => Some(0xb0),
        _ => None,
    }
}

async fn press(state: &Arc<AppState>, vks: Vec<u8>) -> Result<(), Response> {
    let Some(input) = state.platform.input.clone() else {
        return Err(error(StatusCode::NOT_FOUND, "not found"));
    };
    match tokio::task::spawn_blocking(move || input.press_keys(&vks)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(problem)) => Err(port_error(problem)),
        Err(_) => Err(error(StatusCode::INTERNAL_SERVER_ERROR, "internal error")),
    }
}

async fn shortcut_route(state: &Arc<AppState>, method: &Method, path: &str) -> Response {
    if method == Method::GET {
        let list: Vec<Value> = shortcuts(state)
            .iter()
            .map(|s| json!({ "id": s.id, "label": s.label, "display": s.display }))
            .collect();
        return json(StatusCode::OK, json!({ "shortcuts": list }));
    }
    let param = |prefix: &str| {
        path.strip_prefix(prefix)
            .and_then(ssd_core::guard::percent_decode)
            .filter(|p| !p.contains('/'))
    };
    if let Some(id) = param("/api/shortcut/") {
        let Some(found) = shortcuts(state).into_iter().find(|s| s.id == id) else {
            return error(StatusCode::NOT_FOUND, "unknown shortcut");
        };
        return match press(state, found.vks).await {
            Ok(()) => json(StatusCode::OK, json!({ "ok": true, "label": found.label })),
            Err(response) => response,
        };
    }
    let Some(vk) = param("/api/mediakey/").and_then(|key| media_key(&key)) else {
        return error(StatusCode::NOT_FOUND, "unknown media key");
    };
    match press(state, vec![vk]).await {
        Ok(()) => json(StatusCode::OK, json!({ "ok": true })),
        Err(response) => response,
    }
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
