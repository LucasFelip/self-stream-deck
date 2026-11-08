//! The HTTP side of the agent: the same request flow as `legacy/server/src/app.js` (Host check, lockout, token, Origin, static files, routes),
//! then a transition proxy that hands every route not yet ported to the Node agent running as a child on an internal port (plan 3.1).
//! Each route that gets ported is answered here and stops being proxied.
mod proxy;
mod routes;
mod statics;
mod stats;

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::response::Response;
use axum::Router;
use ssd_core::config::Config;
use ssd_core::guard::{percent_decode, Guard};
use ssd_core::ports::AudioPort;

/// Sent with every response: the page only ever loads its own files, cannot be framed, and nothing is sniffed or leaked.
pub const SECURITY_HEADERS: [(&str, &str); 5] = [
    ("content-security-policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"),
    ("x-content-type-options", "nosniff"),
    ("x-frame-options", "DENY"),
    ("referrer-policy", "no-referrer"),
    ("cross-origin-resource-policy", "same-origin"),
];

pub struct AppState {
    pub guard: Guard,
    /// config.json, shared by the routes that read or write it
    pub config: Mutex<Config>,
    /// the build of web/ (web/dist)
    pub web_dir: PathBuf,
    /// where the Node agent listens while it still serves the routes that are not ported
    pub upstream: Option<SocketAddr>,
    /// Core Audio (or a fake): without it the audio routes stay with the Node agent
    pub audio: Option<Arc<dyn AudioPort>>,
    counts: Mutex<HashMap<String, u64>>,
    since: String,
}

impl AppState {
    pub fn new(
        config: Config,
        machine_name: &str,
        web_dir: PathBuf,
        upstream: Option<SocketAddr>,
        audio: Option<Arc<dyn AudioPort>>,
    ) -> Arc<Self> {
        let guard = Guard::new(config.token(), machine_name);
        Arc::new(Self {
            guard,
            config: Mutex::new(config),
            web_dir,
            upstream,
            audio,
            counts: Mutex::new(HashMap::new()),
            since: stats::iso_now(),
        })
    }
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new().fallback(handle).with_state(state)
}

pub(crate) fn with_security(mut response: Response) -> Response {
    for (name, value) in SECURITY_HEADERS {
        response
            .headers_mut()
            .insert(name, HeaderValue::from_static(value));
    }
    response
}

pub(crate) fn json(status: StatusCode, body: serde_json::Value) -> Response {
    let mut response = Response::new(Body::from(body.to_string()));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    with_security(response)
}

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

fn query_param(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        (key == name).then(|| percent_decode(value).unwrap_or_default())
    })
}

/// Files a browser fetches without the pairing token and that hold nothing private: the manifest, the icons and the pairing page's script.
fn is_public_asset(path: &str) -> bool {
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

#[axum::debug_handler]
async fn handle(State(state): State<Arc<AppState>>, request: Request) -> Response {
    let ip: IpAddr = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip())
        .unwrap_or(IpAddr::from([127, 0, 0, 1]));
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let query = request.uri().query().unwrap_or("").to_owned();
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    // copied up front, in a block of their own: a borrow of the request must not live across an await (its body is not Sync)
    let (x_token, cookie, accept, origin, if_none_match) = {
        let header_of = |name: &str| {
            request
                .headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        };
        (
            header_of("x-token"),
            header_of("cookie"),
            header_of("accept"),
            header_of("origin"),
            header_of("if-none-match"),
        )
    };
    let guard = &state.guard;

    if !guard.is_allowed_host(&host) {
        return json(
            StatusCode::MISDIRECTED_REQUEST,
            serde_json::json!({ "error": "unexpected host" }),
        );
    }
    if guard.is_locked_out(ip) {
        return json(
            StatusCode::TOO_MANY_REQUESTS,
            serde_json::json!({ "error": "too many attempts, try again in a minute" }),
        );
    }
    if method == Method::GET && is_public_asset(&path) {
        return statics::serve(&state, if_none_match.as_deref(), &path).await;
    }

    let token_in_query = query_param(&query, "token");
    if !guard.is_authenticated(
        token_in_query.as_deref(),
        x_token.as_deref(),
        cookie.as_deref(),
    ) {
        // A browser opening the deck without a (valid) token gets the pairing page instead of a bare 401: a Home Screen app on iPhone keeps its
        // cookies apart from Safari, so it has to be paired once. Only a wrong token counts as a failed attempt.
        if method == Method::GET && path == "/" && accept.is_some_and(|a| a.contains("text/html")) {
            if token_in_query.is_none() {
                return statics::serve(&state, if_none_match.as_deref(), "/pair.html").await;
            }
            guard.record_failure(ip);
            return redirect("/?error=1", None);
        }
        guard.record_failure(ip);
        return json(
            StatusCode::UNAUTHORIZED,
            serde_json::json!({ "error": "unauthorized" }),
        );
    }

    if method != Method::GET && !guard.is_same_origin(origin.as_deref(), &host) {
        return json(
            StatusCode::FORBIDDEN,
            serde_json::json!({ "error": "cross-origin request refused" }),
        );
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

    if method == Method::GET && statics::is_static_path(&path) {
        // Pairing link: /?token=... stores the token in a cookie and drops it from the URL.
        if token_in_query.is_some() {
            return redirect(&path, Some(guard.pairing_cookie(false)));
        }
        return statics::serve(&state, if_none_match.as_deref(), &path).await;
    }

    // routes ported to Rust are answered here; the rest still belongs to the Node agent
    if routes::is_ported(&state, &method, &path) {
        let body = if method == Method::GET {
            Default::default()
        } else {
            match axum::body::to_bytes(request.into_body(), routes::body_limit(&path)).await {
                Ok(bytes) => bytes,
                Err(_) => {
                    return json(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        serde_json::json!({ "error": "body too large" }),
                    )
                }
            }
        };
        return routes::answer(&state, &method, &path, &body).await;
    }
    match state.upstream {
        Some(upstream) => proxy::forward(upstream, guard.token(), request).await,
        None => json(
            StatusCode::NOT_FOUND,
            serde_json::json!({ "error": "not found" }),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;

    fn app() -> (Router, PathBuf) {
        app_with(None)
    }

    fn app_with(audio: Option<Arc<dyn AudioPort>>) -> (Router, PathBuf) {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        // one folder per test: they run in parallel and each writes its own config.json
        let dir = std::env::temp_dir().join(format!(
            "ssd-api-web-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), "<title>deck</title>").unwrap();
        std::fs::write(dir.join("pair.html"), "<title>pair</title>").unwrap();
        std::fs::write(dir.join("app.js"), "1").unwrap();
        std::fs::write(dir.join("manifest.webmanifest"), "{}").unwrap();
        let config_dir = dir.join("data");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(config_dir.join("config.json"), r#"{"token":"tok"}"#).unwrap();
        let config = Config::load(&config_dir).unwrap();
        (
            router(AppState::new(config, "PC", dir.clone(), None, audio)),
            dir,
        )
    }

    async fn call(app: &Router, method: &str, uri: &str, headers: &[(&str, &str)]) -> Response {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header("host", "127.0.0.1:7878");
        for (k, v) in headers {
            builder = builder.header(*k, *v);
        }
        app.clone()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn a_stranger_host_is_421_and_a_missing_token_is_401() {
        let (app, _) = app();
        let mut request = Request::builder()
            .uri("/api/x")
            .header("host", "evil.example.com")
            .body(Body::empty())
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from(([10, 0, 0, 9], 1))));
        assert_eq!(
            app.clone().oneshot(request).await.unwrap().status(),
            StatusCode::MISDIRECTED_REQUEST
        );
        assert_eq!(
            call(&app, "GET", "/api/x", &[]).await.status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            call(&app, "GET", "/index.html", &[]).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn a_browser_without_a_token_gets_the_pairing_page_and_the_manifest_is_public() {
        let (app, _) = app();
        let page = call(&app, "GET", "/", &[("accept", "text/html")]).await;
        assert_eq!(page.status(), StatusCode::OK);
        assert_eq!(
            call(&app, "GET", "/manifest.webmanifest", &[])
                .await
                .status(),
            StatusCode::OK
        );
        let wrong = call(&app, "GET", "/?token=nope", &[("accept", "text/html")]).await;
        assert_eq!(wrong.status(), StatusCode::FOUND);
        assert_eq!(wrong.headers()["location"], "/?error=1");
    }

    #[tokio::test]
    async fn the_pairing_link_sets_the_cookie_and_the_cookie_then_opens_the_interface() {
        let (app, _) = app();
        let paired = call(&app, "GET", "/?token=tok", &[("accept", "text/html")]).await;
        assert_eq!(paired.status(), StatusCode::FOUND);
        assert_eq!(paired.headers()["location"], "/");
        let cookie = paired.headers()["set-cookie"].to_str().unwrap().to_owned();
        assert!(
            cookie.contains("ssd_token=tok")
                && cookie.contains("HttpOnly")
                && cookie.contains("SameSite=Lax")
        );
        let home = call(&app, "GET", "/", &[("cookie", "ssd_token=tok")]).await;
        assert_eq!(home.status(), StatusCode::OK);
        assert_eq!(home.headers()["x-frame-options"], "DENY");
        assert!(home.headers().contains_key("etag"));
    }

    #[tokio::test]
    async fn an_unchanged_file_answers_304_and_paths_cannot_leave_the_folder() {
        let (app, _) = app();
        let auth = [("x-token", "tok")];
        let first = call(&app, "GET", "/app.js", &auth).await;
        let etag = first.headers()["etag"].to_str().unwrap().to_owned();
        let second = call(
            &app,
            "GET",
            "/app.js",
            &[("x-token", "tok"), ("if-none-match", &etag)],
        )
        .await;
        assert_eq!(second.status(), StatusCode::NOT_MODIFIED);
        for bad in [
            "/..%2f..%2fCargo.toml",
            "/%2e%2e/Cargo.toml",
            "/..%5c..%5cCargo.toml",
            "/nope.js",
            "/data.json",
        ] {
            assert_eq!(
                call(&app, "GET", bad, &auth).await.status(),
                StatusCode::NOT_FOUND,
                "{bad}"
            );
        }
    }

    #[tokio::test]
    async fn a_post_from_another_origin_is_refused_and_with_no_upstream_an_unported_route_is_404() {
        let (app, _) = app();
        let refused = call(
            &app,
            "POST",
            "/api/launch/x",
            &[("x-token", "tok"), ("origin", "https://evil.example.com")],
        )
        .await;
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            call(&app, "GET", "/api/ping", &[("x-token", "tok")])
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn ten_wrong_tokens_lock_the_address_out() {
        let (app, _) = app();
        for _ in 0..10 {
            assert_eq!(
                call(&app, "GET", "/api/x", &[("x-token", "bad")])
                    .await
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        assert_eq!(
            call(&app, "GET", "/api/x", &[("x-token", "tok")])
                .await
                .status(),
            StatusCode::TOO_MANY_REQUESTS
        );
    }

    async fn body_of(response: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn post(app: &Router, uri: &str, body: &str) -> Response {
        let request = Request::builder()
            .method("POST")
            .uri(uri)
            .header("host", "127.0.0.1:7878")
            .header("x-token", "tok")
            .body(Body::from(body.to_owned()))
            .unwrap();
        app.clone().oneshot(request).await.unwrap()
    }

    #[tokio::test]
    async fn pair_code_and_layout_are_answered_here() {
        let (app, _) = app();
        let auth = [("x-token", "tok")];
        let code = body_of(call(&app, "GET", "/api/pair-code", &auth).await).await;
        assert_eq!(code, serde_json::json!({ "code": "tok" }));
        let layout = body_of(call(&app, "GET", "/api/layout", &auth).await).await;
        assert_eq!(layout, serde_json::json!({ "apps": [], "shortcuts": [] }));

        let saved = post(
            &app,
            "/api/layout",
            r#"{"page":"apps","order":["a:one","s:two","a:one"]}"#,
        )
        .await;
        assert_eq!(saved.status(), StatusCode::OK);
        assert_eq!(
            body_of(saved).await,
            serde_json::json!({ "apps": ["a:one", "s:two"], "shortcuts": [] })
        );
        let again = body_of(call(&app, "GET", "/api/layout", &auth).await).await;
        assert_eq!(again["apps"], serde_json::json!(["a:one", "s:two"]));
    }

    #[tokio::test]
    async fn a_bad_layout_is_a_400_and_a_huge_one_is_refused() {
        let (app, _) = app();
        for bad in [
            r#"{"page":"power","order":[]}"#,
            r#"{"page":"apps","order":"x"}"#,
            r#"{"page":"apps","order":["nope"]}"#,
            "{ nope",
        ] {
            assert_eq!(
                post(&app, "/api/layout", bad).await.status(),
                StatusCode::BAD_REQUEST,
                "{bad}"
            );
        }
        let huge = format!(
            r#"{{"page":"apps","order":[],"pad":"{}"}}"#,
            "x".repeat(70_000)
        );
        assert_eq!(
            post(&app, "/api/layout", &huge).await.status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
    }

    #[tokio::test]
    async fn audio_routes_belong_to_node_until_the_agent_has_an_audio_port() {
        let (app, _) = app();
        assert_eq!(
            call(&app, "GET", "/api/volume", &[("x-token", "tok")])
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn volume_mic_and_the_mixer_work_through_the_audio_port() {
        let (app, _) = app_with(Some(Arc::new(ssd_core::ports::FakeAudio::default())));
        let auth = [("x-token", "tok")];
        assert_eq!(
            body_of(call(&app, "GET", "/api/volume", &auth).await).await,
            serde_json::json!({ "level": 30, "muted": false })
        );
        let set = post(&app, "/api/volume", r#"{"level":"41.6","muted":"toggle"}"#).await;
        assert_eq!(
            body_of(set).await,
            serde_json::json!({ "level": 42, "muted": true })
        );
        let loud = post(&app, "/api/volume", r#"{"level":500}"#).await;
        assert_eq!(
            body_of(loud).await,
            serde_json::json!({ "level": 100, "muted": false })
        );
        assert_eq!(
            post(&app, "/api/volume", r#"{"level":"abc"}"#)
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );

        assert_eq!(
            body_of(post(&app, "/api/mic", r#"{"muted":"toggle"}"#).await).await,
            serde_json::json!({ "available": true, "muted": true })
        );
        assert_eq!(
            post(&app, "/api/mic", r#"{"muted":"yes"}"#).await.status(),
            StatusCode::BAD_REQUEST
        );

        let audio = body_of(call(&app, "GET", "/api/audio", &auth).await).await;
        assert_eq!(audio["playback"][0]["id"], "out1");
        assert_eq!(audio["sessions"][0]["system"], true);

        assert_eq!(
            post(&app, "/api/audio/default", r#"{"id":"out2"}"#)
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            post(&app, "/api/audio/default", r#"{"id":"nope"}"#)
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            post(
                &app,
                "/api/audio/device",
                r#"{"id":"in1","level":10,"muted":true}"#
            )
            .await
            .status(),
            StatusCode::OK
        );
        let after = body_of(call(&app, "GET", "/api/audio", &auth).await).await;
        assert_eq!(after["playback"][1]["default"], true);
        assert_eq!(after["capture"][0]["level"], 10);
        assert_eq!(after["capture"][0]["muted"], true);

        assert_eq!(
            post(
                &app,
                "/api/audio/session",
                r#"{"pid":11,"level":20,"muted":true}"#
            )
            .await
            .status(),
            StatusCode::OK
        );
        for bad in [r#"{"pid":-1}"#, r#"{"pid":1.5}"#, r#"{}"#] {
            assert_eq!(
                post(&app, "/api/audio/session", bad).await.status(),
                StatusCode::BAD_REQUEST,
                "{bad}"
            );
        }
        let sessions = body_of(call(&app, "GET", "/api/audio", &auth).await).await;
        assert_eq!(sessions["sessions"][1]["level"], 20);
        assert_eq!(sessions["sessions"][1]["muted"], true);
    }
}
