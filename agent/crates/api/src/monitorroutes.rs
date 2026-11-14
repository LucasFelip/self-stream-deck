//! `GET /api/monitor/{sample,fps,processes,info}`. Parity with `legacy/server/src/routes/pc.js`: the sample is also pushed as the `monitor` event,
//! the frame rate as `game` and the program list as `processes`; the static description is read once and kept.
use ssd_core::sync::Locked;
use std::sync::Arc;

use axum::http::StatusCode;
use axum::response::Response;
use serde_json::Value;

use crate::routes::{error, port_error};
use crate::{json, AppState};

/// A blocking read of the monitor port, on a thread of its own.
pub async fn read(
    state: &Arc<AppState>,
    what: &'static str,
) -> Result<Value, ssd_core::ports::PortError> {
    let monitor = state.platform.monitor.clone().ok_or_else(|| {
        ssd_core::ports::PortError::Failed("the monitor is not available on this agent".into())
    })?;
    if what == "info" {
        if let Some(cached) = state.info_cache.locked().clone() {
            return Ok(cached);
        }
    }
    let value = tokio::task::spawn_blocking(move || match what {
        "sample" => monitor.sample(),
        "fps" => monitor.fps(),
        "processes" => monitor.processes(),
        _ => monitor.info(),
    })
    .await
    .map_err(|_| ssd_core::ports::PortError::Failed("internal error".into()))??;
    if what == "info" {
        *state.info_cache.locked() = Some(value.clone());
    }
    Ok(value)
}

pub async fn route(state: &Arc<AppState>, path: &str) -> Response {
    let what = match path {
        "/api/monitor/sample" => "sample",
        "/api/monitor/fps" => "fps",
        "/api/monitor/processes" => "processes",
        "/api/monitor/info" => "info",
        _ => return error(StatusCode::NOT_FOUND, "not found"),
    };
    match read(state, what).await {
        Ok(value) => json(StatusCode::OK, value),
        Err(problem) => port_error(problem),
    }
}

pub(crate) fn routes() -> axum::Router<Arc<AppState>> {
    use crate::routes::not_found;
    use axum::routing::get;
    axum::Router::new()
        .route("/api/monitor/sample", get(handle).fallback(not_found))
        .route("/api/monitor/fps", get(handle).fallback(not_found))
        .route("/api/monitor/processes", get(handle).fallback(not_found))
        .route("/api/monitor/info", get(handle).fallback(not_found))
}

async fn handle(call: crate::routes::Call) -> Response {
    if call.state.platform.monitor.is_none() {
        return crate::routes::not_found().await;
    }
    route(&call.state, &call.path).await
}
