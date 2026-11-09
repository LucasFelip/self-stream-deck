//! `GET /api/monitor/{sample,fps,processes,info}`. Parity with `legacy/server/src/routes/pc.js`: the sample is also pushed as the `monitor` event,
//! the frame rate as `game` and the program list as `processes`; the static description is read once and kept.
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
        if let Some(cached) = state.info_cache.lock().unwrap().clone() {
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
        *state.info_cache.lock().unwrap() = Some(value.clone());
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
