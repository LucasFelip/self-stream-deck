//! The table of the API: every route the agent answers, each module listing its own next to the code that answers them, and what the
//! modules share (how a request reaches a handler, the error answers, the numbers of a JSON body). What is not in the table is a JSON 404;
//! so is a route whose part of the PC this agent does not have (a module without its port).
#![allow(clippy::result_large_err)] // the Err of a route step is the whole HTTP answer to send
use ssd_core::sync::Locked;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{FromRequest, Request};
use axum::http::{Method, StatusCode};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde_json::{json, Map, Value};
use ssd_core::ports::{Percent, PortError};

use crate::{json, AppState};

/// How much body each route reads (the Node agent used 64 KB for the layout and 4 KB for everything else).
pub fn body_limit(path: &str) -> usize {
    if path == "/api/camera/frame" {
        crate::camera::MAX_FRAME
    } else if path == "/api/editor/macros" {
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
    let config = state.config.locked();
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

/// Every route of the API. `access::guard` runs in front of all of them (lib.rs).
pub(crate) fn table() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/ping", get(ping).fallback(not_found))
        .route("/api/pair-code", get(pair_code).fallback(not_found))
        .route("/api/layout", get(layout).post(layout).fallback(not_found))
        .route("/api/events", get(events).fallback(not_found))
        .merge(crate::audio::routes())
        .merge(crate::media::routes())
        .merge(crate::shortcuts::routes())
        .merge(crate::apps::routes())
        .merge(crate::winroutes::routes())
        .merge(crate::powerroutes::routes())
        .merge(crate::monitorroutes::routes())
        .merge(crate::editor::routes())
        .merge(crate::camera::routes())
}

/// What a handler gets of a request: the state, whether it changes something, the path, the query and the body (read up to the limit of
/// its route; a GET has none).
pub(crate) struct Call {
    pub(crate) state: Arc<AppState>,
    pub(crate) post: bool,
    pub(crate) path: String,
    pub(crate) query: String,
    pub(crate) body: Bytes,
}

#[axum::async_trait]
impl FromRequest<Arc<AppState>> for Call {
    type Rejection = Response;

    async fn from_request(request: Request, state: &Arc<AppState>) -> Result<Self, Response> {
        let post = request.method() == Method::POST;
        let path = request.uri().path().to_owned();
        let query = request.uri().query().unwrap_or("").to_owned();
        let body = if post {
            axum::body::to_bytes(request.into_body(), body_limit(&path))
                .await
                .map_err(|_| error(StatusCode::PAYLOAD_TOO_LARGE, "body too large"))?
        } else {
            Bytes::new()
        };
        Ok(Self {
            state: state.clone(),
            post,
            path,
            query,
            body,
        })
    }
}

/// The answer of a route that is not there: another method on a known path, or a module this agent does not have.
pub(crate) async fn not_found() -> Response {
    error(StatusCode::NOT_FOUND, "not found")
}

async fn ping() -> Response {
    json(StatusCode::OK, json!({ "ok": true }))
}

async fn pair_code(call: Call) -> Response {
    json(StatusCode::OK, json!({ "code": call.state.guard.token() }))
}

async fn layout(call: Call) -> Response {
    if call.post {
        save_layout(&call.state, &call.body)
    } else {
        json(StatusCode::OK, tile_order(&call.state))
    }
}

async fn events(call: Call) -> Response {
    crate::events::subscribe(&call.state, &call.query).await
}

fn save_layout(state: &Arc<AppState>, body: &[u8]) -> Response {
    if state.config.locked().get("editor") == Some(&Value::Bool(false)) {
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
    if let Err(problem) = state.config.locked().update(&patch) {
        return error(StatusCode::BAD_REQUEST, &problem.to_string());
    }
    json(StatusCode::OK, tile_order(state))
}

// ---- what the modules share --------------------------------------------------------------------------------------------------------

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

pub(crate) fn ok() -> Response {
    json(StatusCode::OK, json!({ "ok": true }))
}

/// One parameter of a query string, as a form sends it (`+` is a space); empty when it is not there.
pub(crate) fn query_value(query: &str, name: &str) -> String {
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
