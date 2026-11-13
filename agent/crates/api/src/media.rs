//! What is playing (the system media sessions): the list, the controls of one player and the cover art (`MediaPort`).
use std::sync::Arc;

use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};
use ssd_core::media::{is_art_key, sniff_mime};
use ssd_core::ports::MediaAction;

use crate::routes::{error, js_number, not_found, port_error, query_value, Call};
use crate::{json, AppState};

pub(crate) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/media", get(handle).fallback(not_found))
        .route("/api/media/art", get(handle).fallback(not_found))
        .route("/api/media/control", post(handle).fallback(not_found))
}

async fn handle(call: Call) -> Response {
    media_route(&call.state, &call.path, &call.query, &call.body).await
}

const MEDIA_ACTIONS: [&str; 6] = ["toggle", "play", "pause", "next", "previous", "seek"];

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
