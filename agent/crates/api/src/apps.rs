//! The taskbar apps: the list, the icons and reading the taskbar again. The list lives in the state (read from the cache at start, so the
//! phone has keys at once), is refreshed in the background when the pinned folder changed, and is rebuilt on "Atualizar".
use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};
use ssd_core::taskbar::{
    folder_signature, read_cache, to_apps, write_cache, App, Cache, TaskbarItem,
};

use crate::{error_json, with_security, AppState};

/// Every pinned item and the version of the list (it goes up whenever the list changes).
#[derive(Default)]
pub struct AppsState {
    pub items: Vec<TaskbarItem>,
    pub signature: String,
    pub rev: u64,
}

fn hidden(state: &AppState) -> Vec<String> {
    let config = state.config.lock().unwrap();
    match config.get("hidden") {
        Some(Value::Array(ids)) => ids
            .iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

/// The apps of the Apps page (hidden ones left out).
pub fn visible(state: &AppState) -> Vec<App> {
    to_apps(&state.apps.lock().unwrap().items, &hidden(state))
}

/// The list from the last run, at once (empty on the very first start).
pub fn load_cached(state: &AppState) {
    if let Some(cache) = read_cache(&state.cache_file()) {
        let mut apps = state.apps.lock().unwrap();
        apps.items = cache.items;
        apps.signature = cache.signature;
    }
}

/// Brings the list up to date. Without `force` and with an unchanged folder it does nothing. Returns whether the list changed.
pub async fn refresh(state: &Arc<AppState>, force: bool) -> Result<bool, String> {
    let Some(taskbar) = state.platform.taskbar.clone() else {
        return Ok(false);
    };
    let signature = taskbar
        .folder()
        .map_or_else(|| "none".to_owned(), |dir| folder_signature(&dir));
    if !force {
        let current = state.apps.lock().unwrap();
        if !current.items.is_empty() && current.signature == signature {
            return Ok(false);
        }
    }
    let icon_dir = state.icon_dir();
    let items = tokio::task::spawn_blocking(move || taskbar.read(&icon_dir))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let changed = {
        let mut apps = state.apps.lock().unwrap();
        let changed = apps.items != items;
        apps.items = items.clone();
        apps.signature = signature.clone();
        if changed {
            apps.rev += 1;
        }
        changed
    };
    if let Err(problem) = write_cache(&state.cache_file(), &Cache { signature, items }) {
        tracing::warn!(
            "could not save the apps cache (the next start reads the taskbar again): {problem}"
        );
    }
    Ok(changed)
}

pub fn list(state: &AppState) -> Response {
    let apps: Vec<Value> = visible(state).iter().map(|a| json!({ "id": a.id, "name": a.name, "hasIcon": a.has_icon, "iconVersion": a.icon_version })).collect();
    crate::json(StatusCode::OK, json!({ "host": state.host, "apps": apps }))
}

/// The icon of any taskbar app (hidden ones too: the editor lists them all). The URL carries `?v=<icon version>`, so a cached copy is never stale.
pub async fn icon(state: &AppState, id: &str) -> Response {
    let known = to_apps(&state.apps.lock().unwrap().items, &[])
        .into_iter()
        .find(|app| app.id == id && app.has_icon);
    let Some(app) = known else {
        return error_json(StatusCode::NOT_FOUND, "not found");
    };
    let Ok(bytes) = tokio::fs::read(state.icon_dir().join(format!("{}.png", app.id))).await else {
        return error_json(StatusCode::NOT_FOUND, "not found");
    };
    let mut response = Response::new(Body::from(bytes));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("max-age=31536000, immutable"),
    );
    with_security(response)
}

pub async fn refresh_route(state: &Arc<AppState>) -> Response {
    match refresh(state, true).await {
        Ok(_) => {
            // the Node agent behind this one keeps its own copy of the list for the routes it still serves
            if let Some(upstream) = state.upstream {
                crate::proxy::notify(upstream, state.guard.token(), "/api/refresh").await;
            }
            crate::json(StatusCode::OK, json!({ "count": visible(state).len() }))
        }
        Err(problem) => error_json(StatusCode::INTERNAL_SERVER_ERROR, &problem),
    }
}
