//! The webhooks (ADR 0010): what scripts, CI and home automation may do to the panel. They show a notice, switch the page, reload the panel and
//! keep values (with an optional time to live) for the cards to show. They never press a key, run a macro, open an app or touch the power:
//! whoever holds the webhook key can at most fill the panel with noise. `access::guard` lets the webhook key in here and nowhere else.
#![allow(clippy::result_large_err)] // the Err of a route step is the whole HTTP answer to send
use ssd_core::sync::Locked;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};
use ssd_core::push::{PushError, MAX_TTL_SEC};

use crate::access::query_param;
use crate::routes::{error, not_found};
use crate::{json, AppState};

/// The longest body a webhook reads.
const MAX_BODY: usize = 8 * 1024;
const MAX_TEXT: usize = 500;
const MAX_TITLE: usize = 120;

pub(crate) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/hook/notify", post(notify).fallback(not_found))
        .route("/api/hook/goto/*page", post(goto).fallback(not_found))
        .route("/api/hook/refresh", post(refresh).fallback(not_found))
        .route("/api/hook/push", get(list).fallback(not_found))
        .route(
            "/api/hook/push/*key",
            get(value)
                .post(set_value)
                .put(set_value)
                .delete(remove_value)
                .fallback(not_found),
        )
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// The body, up to the limit; empty for a request that has none.
async fn body_of(request: Request) -> Result<Vec<u8>, Response> {
    axum::body::to_bytes(request.into_body(), MAX_BODY)
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|_| error(StatusCode::PAYLOAD_TOO_LARGE, "body too large"))
}

/// JSON when the body is JSON, else the text itself (a sender that cannot do JSON posts `21.5` or `done`).
fn value_of(bytes: &[u8]) -> Option<Value> {
    let text = std::str::from_utf8(bytes).ok()?.trim();
    if text.is_empty() {
        return None;
    }
    Some(serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.to_owned())))
}

fn too_long(text: &str, limit: usize) -> bool {
    text.chars().count() > limit
}

pub(crate) fn persist(state: &AppState) {
    if let Err(problem) = state.push.locked().persist() {
        tracing::warn!("could not save the pushed values: {problem}");
    }
}

/// `POST /api/hook/notify`: `{ "title"?, "text" }` or the text itself.
async fn notify(State(state): State<Arc<AppState>>, request: Request) -> Response {
    let bytes = match body_of(request).await {
        Ok(bytes) => bytes,
        Err(response) => return response,
    };
    let (title, text) = match value_of(&bytes) {
        Some(Value::Object(map)) => (
            map.get("title").and_then(Value::as_str).map(str::to_owned),
            map.get("text").and_then(Value::as_str).map(str::to_owned),
        ),
        Some(Value::String(text)) => (None, Some(text)),
        Some(other) => (None, Some(other.to_string())),
        None => (None, None),
    };
    let Some(text) = text.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()) else {
        return error(StatusCode::BAD_REQUEST, "text is required");
    };
    if too_long(&text, MAX_TEXT) || title.as_deref().is_some_and(|t| too_long(t, MAX_TITLE)) {
        return error(
            StatusCode::BAD_REQUEST,
            "the text is up to 500 characters and the title up to 120",
        );
    }
    let seq = state.push.locked().push_event(
        "notify",
        json!({ "title": title.unwrap_or_default(), "text": text }),
        now_ms(),
    );
    json(StatusCode::OK, json!({ "ok": true, "seq": seq }))
}

/// `POST /api/hook/goto/{page}`: the panel opens that page (an unknown page is ignored by the panel).
async fn goto(State(state): State<Arc<AppState>>, request: Request) -> Response {
    let page = request
        .uri()
        .path()
        .strip_prefix("/api/hook/goto/")
        .unwrap_or_default();
    if !ssd_core::push::valid_page(page) {
        return error(
            StatusCode::BAD_REQUEST,
            "the page is 1-32 characters: a-z, 0-9 and '-'",
        );
    }
    let seq = state
        .push
        .locked()
        .push_event("goto", json!({ "page": page }), now_ms());
    json(StatusCode::OK, json!({ "ok": true, "seq": seq }))
}

/// `POST /api/hook/refresh`: the panel reloads what it shows.
async fn refresh(State(state): State<Arc<AppState>>) -> Response {
    let seq = state
        .push
        .locked()
        .push_event("refresh", Value::Null, now_ms());
    json(StatusCode::OK, json!({ "ok": true, "seq": seq }))
}

/// `GET /api/hook/push`: every value and the version.
async fn list(State(state): State<Arc<AppState>>) -> Response {
    json(StatusCode::OK, state.push.locked().to_json(now_ms()))
}

fn key_of(request: &Request) -> String {
    request
        .uri()
        .path()
        .strip_prefix("/api/hook/push/")
        .and_then(ssd_core::guard::percent_decode)
        .unwrap_or_default()
}

/// `GET /api/hook/push/{key}`
async fn value(State(state): State<Arc<AppState>>, request: Request) -> Response {
    let key = key_of(&request);
    match state.push.locked().get(&key, now_ms()) {
        Some(item) => json(
            StatusCode::OK,
            json!({ "data": item.data, "at": item.at, "expiresAt": item.expires_at }),
        ),
        None => error(StatusCode::NOT_FOUND, "no such value"),
    }
}

/// `POST|PUT /api/hook/push/{key}?ttl=seconds`: JSON or plain text; the value is gone after the time to live.
async fn set_value(State(state): State<Arc<AppState>>, request: Request) -> Response {
    let key = key_of(&request);
    let ttl = match query_param(request.uri().query().unwrap_or(""), "ttl") {
        None => None,
        Some(text) => match text.parse::<u64>() {
            Ok(seconds) if seconds <= MAX_TTL_SEC => Some(seconds),
            _ => {
                return error(
                    StatusCode::BAD_REQUEST,
                    "ttl is a number of seconds up to 30 days",
                )
            }
        },
    };
    let bytes = match body_of(request).await {
        Ok(bytes) => bytes,
        Err(response) => return response,
    };
    let Some(data) = value_of(&bytes) else {
        return error(StatusCode::BAD_REQUEST, "the value is empty or not text");
    };
    let result = state.push.locked().set(&key, data, ttl, now_ms());
    match result {
        Ok(()) => {
            persist(&state);
            let version = state.push.locked().version();
            json(
                StatusCode::OK,
                json!({ "ok": true, "key": key, "version": version }),
            )
        }
        Err(PushError::Io(problem)) => {
            tracing::warn!("{problem}");
            error(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
        }
        Err(problem) => error(StatusCode::BAD_REQUEST, &problem.to_string()),
    }
}

/// `DELETE /api/hook/push/{key}`
async fn remove_value(State(state): State<Arc<AppState>>, request: Request) -> Response {
    let key = key_of(&request);
    let removed = state.push.locked().remove(&key, now_ms());
    if !removed {
        return error(StatusCode::NOT_FOUND, "no such value");
    }
    persist(&state);
    json(StatusCode::OK, json!({ "ok": true }))
}
