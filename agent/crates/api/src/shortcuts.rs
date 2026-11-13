//! The keyboard shortcuts of `config.json` and the global media keys (`InputPort`): the phone names one by its id, never the keys.
#![allow(clippy::result_large_err)] // the Err of a route step is the whole HTTP answer to send
use std::sync::Arc;

use axum::http::{Method, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};

use crate::routes::{error, not_found, port_error, Call};
use crate::{json, AppState};

pub(crate) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/shortcuts", get(handle).fallback(not_found))
        .route("/api/shortcut/*id", post(handle).fallback(not_found))
        .route("/api/mediakey/*key", post(handle).fallback(not_found))
}

async fn handle(call: Call) -> Response {
    let method = if call.post { Method::POST } else { Method::GET };
    shortcut_route(&call.state, &method, &call.path).await
}

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
