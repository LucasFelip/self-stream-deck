//! Who gets in. Every request crosses `guard` before any route sees it, in this order: the `Host` it was sent to, the lockout of an address
//! that kept guessing, the few files that need no token, the token itself, and the `Origin` of anything that changes something. What no
//! route answers ends in `static_or_not_found`: a file of the interface, or a JSON 404.
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use ssd_core::guard::percent_decode;

use crate::{json, statics, stats, with_security, AppState, Secure};

fn redirect(location: &str, cookie: Option<String>) -> Response {
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::FOUND;
    if let Ok(value) = HeaderValue::from_str(location) {
        response.headers_mut().insert(header::LOCATION, value);
    }
    if let Some(Ok(value)) = cookie.map(|c| HeaderValue::from_str(&c)) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    with_security(response)
}

/// One parameter of a query string, percent-decoded (`+` stays a plus: a token never has a space).
pub(crate) fn query_param(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        (key == name).then(|| percent_decode(value).unwrap_or_default())
    })
}

/// Files a browser fetches without the pairing token and that hold nothing private: the manifest, the icons and the pairing page's script.
pub(crate) fn is_public_asset(path: &str) -> bool {
    path == "/manifest.webmanifest"
        || path == "/pair.js"
        || path
            .strip_prefix("/icons/")
            .and_then(|name| name.strip_suffix(".png"))
            .is_some_and(|stem| {
                !stem.is_empty()
                    && stem
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            })
}

fn header_of(request: &Request, name: &str) -> Option<String> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
}

fn refused(status: StatusCode, message: &str) -> Response {
    json(status, serde_json::json!({ "error": message }))
}

/// The address a request came from (the loopback one when a test calls the router without a connection).
fn peer(request: &Request) -> IpAddr {
    request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip())
        .unwrap_or(IpAddr::from([127, 0, 0, 1]))
}

/// The middleware in front of every route.
pub(crate) async fn guard(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    let ip = peer(&request);
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let host = header_of(&request, "host").unwrap_or_default();
    let if_none_match = header_of(&request, "if-none-match");
    let guard = &state.guard;

    if !guard.is_allowed_host(&host) {
        return refused(StatusCode::MISDIRECTED_REQUEST, "unexpected host");
    }
    if guard.is_locked_out(ip) {
        return refused(
            StatusCode::TOO_MANY_REQUESTS,
            "too many attempts, try again in a minute",
        );
    }
    if method == Method::GET && is_public_asset(&path) {
        return statics::serve(&state, if_none_match.as_deref(), &path).await;
    }

    let token_in_query = query_param(request.uri().query().unwrap_or(""), "token");
    if !guard.is_authenticated(
        token_in_query.as_deref(),
        header_of(&request, "x-token").as_deref(),
        header_of(&request, "cookie").as_deref(),
    ) {
        // A browser opening the deck without a (valid) token gets the pairing page instead of a bare 401: a Home Screen app on iPhone keeps its
        // cookies apart from Safari, so it has to be paired once. Only a wrong token counts as a failed attempt.
        let wants_page = header_of(&request, "accept").is_some_and(|a| a.contains("text/html"));
        if method == Method::GET && path == "/" && wants_page {
            if token_in_query.is_none() {
                return statics::serve(&state, if_none_match.as_deref(), "/pair.html").await;
            }
            guard.record_failure(ip);
            tracing::warn!(%ip, "a pairing link with a wrong token");
            return redirect("/?error=1", None);
        }
        guard.record_failure(ip);
        tracing::warn!(%ip, %method, path, "a request without a valid token");
        return refused(StatusCode::UNAUTHORIZED, "unauthorized");
    }

    if method != Method::GET
        && !guard.is_same_origin(header_of(&request, "origin").as_deref(), &host)
    {
        tracing::warn!(%ip, %method, path, "a cross-origin request refused");
        return refused(StatusCode::FORBIDDEN, "cross-origin request refused");
    }

    // how often each route is used (static files count as one): GET /api/requests shows it, for judging what the phone costs
    if path == "/api/requests" && method == Method::GET {
        return json(StatusCode::OK, stats::report(&state.counts, &state.since));
    }
    stats::count(
        &state.counts,
        &method,
        &path,
        statics::is_static_path(&path),
    );

    let started = std::time::Instant::now();
    let response = next.run(request).await;
    tracing::debug!(
        %ip,
        %method,
        path,
        status = response.status().as_u16(),
        ms = started.elapsed().as_millis() as u64,
        "request"
    );
    response
}

/// What no route answered: a file of the interface (a GET of a known type), else a JSON 404.
pub(crate) async fn static_or_not_found(
    State(state): State<Arc<AppState>>,
    request: Request,
) -> Response {
    let path = request.uri().path();
    if request.method() != Method::GET || !statics::is_static_path(path) {
        return refused(StatusCode::NOT_FOUND, "not found");
    }
    // Pairing link: /?token=... stores the token in a cookie and drops it from the URL.
    if query_param(request.uri().query().unwrap_or(""), "token").is_some() {
        let secure = request.extensions().get::<Secure>().is_some();
        return redirect(path, Some(state.guard.pairing_cookie(secure)));
    }
    statics::serve(
        &state,
        header_of(&request, "if-none-match").as_deref(),
        path,
    )
    .await
}
