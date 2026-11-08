//! The transition proxy: a request for a route that is not ported yet goes to the Node agent on an internal port and its answer (a stream, so
//! SSE keeps working) goes back. The request has already passed the guard here, so the proxy hands Node the token and drops the `Origin`
//! (Node would compare it with the rewritten `Host`).
use std::net::SocketAddr;

use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderName, HeaderValue, StatusCode, Uri};
use axum::response::Response;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;

use crate::json;

const HOP_BY_HOP: [&str; 8] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
];

pub async fn forward(upstream: SocketAddr, token: &str, request: Request) -> Response {
    let (mut parts, body) = request.into_parts();
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/");
    let Ok(uri) = format!("http://{upstream}{path_and_query}").parse::<Uri>() else {
        return json(
            StatusCode::BAD_REQUEST,
            serde_json::json!({ "error": "bad request" }),
        );
    };
    parts.uri = uri;
    for name in HOP_BY_HOP {
        parts.headers.remove(name);
    }
    parts.headers.remove(header::ORIGIN);
    parts.headers.remove(header::COOKIE);
    parts.headers.insert(
        header::HOST,
        HeaderValue::from_str(&upstream.to_string()).expect("an address is a valid header"),
    );
    if let Ok(value) = HeaderValue::from_str(token) {
        parts
            .headers
            .insert(HeaderName::from_static("x-token"), value);
    }

    let client: Client<_, Body> = Client::builder(TokioExecutor::new()).build_http();
    match client.request(Request::from_parts(parts, body)).await {
        Ok(answer) => {
            let (parts, incoming) = answer.into_parts();
            crate::with_security(Response::from_parts(parts, Body::new(incoming)))
        }
        Err(error) => {
            tracing::warn!("upstream unavailable: {error}");
            json(
                StatusCode::BAD_GATEWAY,
                serde_json::json!({ "error": "the agent behind this one is not answering" }),
            )
        }
    }
}
