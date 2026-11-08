//! Static files of the interface (web/dist): only known web file types, nothing outside the folder, ETag + 304 so an unchanged file costs no body.
use std::path::{Component, Path};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use axum::body::Body;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use ssd_core::guard::percent_decode;

use crate::{json, with_security, AppState};

fn content_type(extension: &str) -> Option<&'static str> {
    Some(match extension {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "webmanifest" => "application/manifest+json",
        "map" | "json" => "application/json",
        _ => return None,
    })
}

/// Types a browser may fetch from the interface; `/data.json` is a known type but not a file, so it is a 404 later.
pub fn is_static_path(path: &str) -> bool {
    path == "/"
        || path == "/v2"
        || path == "/v2/"
        || Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| content_type(&e.to_lowercase()).is_some())
}

pub async fn serve(state: &Arc<AppState>, if_none_match: Option<&str>, path: &str) -> Response {
    let not_found = || {
        json(
            StatusCode::NOT_FOUND,
            serde_json::json!({ "error": "not found" }),
        )
    };
    if path == "/v2" || path == "/v2/" {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::FOUND;
        response
            .headers_mut()
            .insert(header::LOCATION, HeaderValue::from_static("/"));
        return with_security(response);
    }
    let Some(decoded) = percent_decode(path) else {
        return not_found();
    };
    let relative = if decoded == "/" {
        "index.html".to_owned()
    } else {
        decoded.trim_start_matches(['/', '\\']).to_owned()
    };
    // no ".." or drive/backslash tricks: every component must be a plain name
    if relative.contains('\\')
        || relative.contains(':')
        || !Path::new(&relative)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
    {
        return not_found();
    }
    let file = state.web_dir.join(&relative);
    let Some(kind) = file
        .extension()
        .and_then(|e| e.to_str())
        .and_then(|e| content_type(&e.to_lowercase()))
    else {
        return not_found();
    };

    let Ok(meta) = tokio::fs::metadata(&file).await else {
        return not_found();
    };
    if !meta.is_file() {
        return not_found();
    }
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let etag = format!("\"{:x}-{:x}\"", meta.len(), modified);
    let mut response = if if_none_match == Some(etag.as_str()) {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NOT_MODIFIED;
        response
    } else {
        let Ok(bytes) = tokio::fs::read(&file).await else {
            return not_found();
        };
        let mut response = Response::new(Body::from(bytes));
        response
            .headers_mut()
            .insert(header::CONTENT_TYPE, HeaderValue::from_static(kind));
        response
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    if let Ok(value) = HeaderValue::from_str(&etag) {
        response.headers_mut().insert(header::ETAG, value);
    }
    with_security(response)
}
