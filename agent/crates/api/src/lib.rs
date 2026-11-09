//! The HTTP side of the agent: the same request flow as `legacy/server/src/app.js` (Host check, lockout, token, Origin, static files, routes),
//! then a transition proxy that hands every route not yet ported to the Node agent running as a child on an internal port (plan 3.1).
//! Each route that gets ported is answered here and stops being proxied.
mod apps;
mod camera;
mod editor;
mod events;
mod monitorroutes;
mod powerroutes;
mod proxy;
mod routes;
mod statics;
mod stats;
mod winroutes;

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
use ssd_core::media::ArtCache;
use ssd_core::ports::{
    AudioPort, InputPort, MediaPort, MonitorPort, NotificationsPort, PowerPort, TaskbarPort,
    VcamPort, WindowsPort,
};
use ssd_core::power::Scheduled;

/// Sent with every response: the page only ever loads its own files, cannot be framed, and nothing is sniffed or leaked.
pub const SECURITY_HEADERS: [(&str, &str); 5] = [
    ("content-security-policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"),
    ("x-content-type-options", "nosniff"),
    ("x-frame-options", "DENY"),
    ("referrer-policy", "no-referrer"),
    ("cross-origin-resource-policy", "same-origin"),
];

/// The ports of the PC. `None` leaves that module to the Node agent behind this one.
#[derive(Clone, Default)]
pub struct Platform {
    pub audio: Option<Arc<dyn AudioPort>>,
    pub media: Option<Arc<dyn MediaPort>>,
    pub input: Option<Arc<dyn InputPort>>,
    pub taskbar: Option<Arc<dyn TaskbarPort>>,
    pub windows: Option<Arc<dyn WindowsPort>>,
    pub power: Option<Arc<dyn PowerPort>>,
    pub monitor: Option<Arc<dyn MonitorPort>>,
    pub notifications: Option<Arc<dyn NotificationsPort>>,
    pub vcam: Option<Arc<dyn VcamPort>>,
}

/// Put on a request that arrived over TLS: the pairing cookie then carries `Secure`.
#[derive(Clone, Copy)]
pub struct Secure;

pub struct AppState {
    pub guard: Guard,
    /// config.json, shared by the routes that read or write it
    pub config: Mutex<Config>,
    /// the build of web/ (web/dist)
    pub web_dir: PathBuf,
    /// where the Node agent listens while it still serves the routes that are not ported
    pub upstream: Option<SocketAddr>,
    /// what the PC offers (or fakes of it): a module without its port stays with the Node agent
    pub platform: Platform,
    /// cover art of the tracks already fetched
    pub art: Mutex<ArtCache>,
    /// the taskbar apps
    pub apps: Mutex<apps::AppsState>,
    /// who listens to which live topic
    pub hub: events::Hub,
    /// the phone's camera as a webcam
    pub camera: Arc<camera::Camera>,
    /// the shutdown this agent scheduled, for the countdown on the phone
    pub scheduled: Mutex<Option<Scheduled>>,
    /// macros being run (one run of each at a time)
    /// the static description of the PC, read once
    pub info_cache: Mutex<Option<serde_json::Value>>,
    pub running_macros: Mutex<std::collections::HashSet<String>>,
    ui_cache: Mutex<(Option<std::time::Instant>, u64)>,
    playing_cache: Mutex<Option<(std::time::Instant, serde_json::Value)>>,
    /// this PC's name, as the Apps page shows it
    pub host: String,
    counts: Mutex<HashMap<String, u64>>,
    since: String,
}

impl AppState {
    pub fn new(
        config: Config,
        machine_name: &str,
        web_dir: PathBuf,
        upstream: Option<SocketAddr>,
        platform: Platform,
    ) -> Arc<Self> {
        let guard = Guard::new(config.token(), machine_name);
        let state = Arc::new(Self {
            guard,
            host: machine_name.to_owned(),
            apps: Mutex::new(apps::AppsState::default()),
            hub: events::Hub::default(),
            camera: Arc::new(camera::Camera::default()),
            scheduled: Mutex::new(None),
            info_cache: Mutex::new(None),
            running_macros: Mutex::new(Default::default()),
            ui_cache: Mutex::new((None, 0)),
            playing_cache: Mutex::new(None),
            config: Mutex::new(config),
            web_dir,
            upstream,
            platform,
            art: Mutex::new(ArtCache::default()),
            counts: Mutex::new(HashMap::new()),
            since: stats::iso_now(),
        });
        apps::load_cached(&state);
        state
    }

    pub(crate) fn cache_file(&self) -> PathBuf {
        self.config.lock().unwrap().dir().join("apps-cache.json")
    }

    pub(crate) fn icon_dir(&self) -> PathBuf {
        self.config.lock().unwrap().dir().join("icons")
    }

    /// Reads the taskbar when it changed since the last run (the first start has no list yet). Meant to run in the background at start.
    pub async fn refresh_apps(self: &Arc<Self>) {
        if let Err(problem) = apps::refresh(self, false).await {
            tracing::warn!("could not read the taskbar: {problem}");
        }
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

pub(crate) fn error_json(status: StatusCode, message: &str) -> Response {
    json(status, serde_json::json!({ "error": message }))
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
    let secure = request.extensions().get::<Secure>().is_some();
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
            return redirect(&path, Some(guard.pairing_cookie(secure)));
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
        return routes::answer(&state, &method, &path, &query, &body).await;
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
        app_on(Platform {
            audio,
            media: None,
            input: None,
            taskbar: None,
            windows: None,
            power: None,
            monitor: None,
            notifications: None,
            vcam: None,
        })
    }

    fn app_on(platform: Platform) -> (Router, PathBuf) {
        app_configured(platform, r#"{"token":"tok"}"#)
    }

    fn app_configured(platform: Platform, config_json: &str) -> (Router, PathBuf) {
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
        std::fs::write(config_dir.join("config.json"), config_json).unwrap();
        let config = Config::load(&config_dir).unwrap();
        (
            router(AppState::new(config, "PC", dir.clone(), None, platform)),
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
            call(&app, "GET", "/api/not-a-route", &[("x-token", "tok")])
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

    #[tokio::test]
    async fn now_playing_state_control_and_art_work_through_the_media_port() {
        let (app, _) = app_on(Platform {
            audio: None,
            media: Some(Arc::new(ssd_core::ports::FakeMedia::default())),
            input: None,
            taskbar: None,
            windows: None,
            power: None,
            monitor: None,
            notifications: None,
            vcam: None,
        });
        let auth = [("x-token", "tok")];
        let media = body_of(call(&app, "GET", "/api/media", &auth).await).await;
        assert_eq!(media["current"], "s1");
        assert_eq!(media["sessions"][0]["canSeek"], true);
        assert_eq!(media["sessions"][0]["artKey"], "0123456789ab");

        let paused = post(
            &app,
            "/api/media/control",
            r#"{"session":"s1","action":"toggle"}"#,
        )
        .await;
        assert_eq!(
            body_of(paused).await,
            serde_json::json!({ "ok": true, "accepted": true })
        );
        let seek = post(
            &app,
            "/api/media/control",
            r#"{"session":"s1","action":"seek","position":"90"}"#,
        )
        .await;
        assert_eq!(seek.status(), StatusCode::OK);
        let after = body_of(call(&app, "GET", "/api/media", &auth).await).await;
        assert_eq!(after["sessions"][0]["status"], "paused");
        assert_eq!(after["sessions"][0]["position"], 90.0);
        for (bad, why) in [
            (r#"{"session":"","action":"play"}"#, "empty session"),
            (r#"{"action":"play"}"#, "no session"),
            (r#"{"session":"s1","action":"explode"}"#, "unknown action"),
            (
                r#"{"session":"s1","action":"seek"}"#,
                "seek needs a position",
            ),
            (
                r#"{"session":"s1","action":"seek","position":-1}"#,
                "negative",
            ),
            (
                r#"{"session":"s1","action":"seek","position":999999999}"#,
                "too far",
            ),
        ] {
            assert_eq!(
                post(&app, "/api/media/control", bad).await.status(),
                StatusCode::BAD_REQUEST,
                "{why}"
            );
        }

        let art = call(
            &app,
            "GET",
            "/api/media/art?session=s1&key=0123456789ab",
            &auth,
        )
        .await;
        assert_eq!(art.status(), StatusCode::OK);
        assert_eq!(art.headers()["content-type"], "image/png");
        assert_eq!(
            art.headers()["cache-control"],
            "max-age=31536000, immutable"
        );
        for bad in [
            "/api/media/art?session=s1&key=NOPE",
            "/api/media/art?key=0123456789ab",
        ] {
            assert_eq!(
                call(&app, "GET", bad, &auth).await.status(),
                StatusCode::BAD_REQUEST,
                "{bad}"
            );
        }
    }

    #[tokio::test]
    async fn shortcuts_and_media_keys_press_the_right_virtual_keys() {
        let input = Arc::new(ssd_core::ports::FakeInput::default());
        let (app, _) = app_configured(
            Platform {
                audio: None,
                media: None,
                input: Some(input.clone()),
                taskbar: None,
                windows: None,
                power: None,
                monitor: None,
                notifications: None,
                vcam: None,
            },
            r#"{"token":"tok","shortcuts":[{"id":"tm","label":"Gerenciador","keys":"ctrl+shift+esc"},{"keys":"alt+f4"},{"id":"bad","keys":"ctrl+nope"}]}"#,
        );
        let auth = [("x-token", "tok")];
        let list = body_of(call(&app, "GET", "/api/shortcuts", &auth).await).await;
        assert_eq!(
            list,
            serde_json::json!({ "shortcuts": [
                { "id": "tm", "label": "Gerenciador", "display": "Ctrl+Shift+Esc" },
                { "id": "shortcut-1", "label": "alt+f4", "display": "Alt+F4" }
            ] })
        );
        let pressed = post(&app, "/api/shortcut/tm", "").await;
        assert_eq!(
            body_of(pressed).await,
            serde_json::json!({ "ok": true, "label": "Gerenciador" })
        );
        assert_eq!(
            post(&app, "/api/shortcut/shortcut-1", "").await.status(),
            StatusCode::OK
        );
        assert_eq!(
            post(&app, "/api/shortcut/bad", "").await.status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            post(&app, "/api/mediakey/playpause", "").await.status(),
            StatusCode::OK
        );
        assert_eq!(
            post(&app, "/api/mediakey/explode", "").await.status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            input.pressed(),
            vec![vec![0x11, 0x10, 0x1b], vec![0x12, 0x73], vec![0xb3]]
        );
    }

    #[tokio::test]
    async fn the_taskbar_apps_the_icons_and_the_hidden_ones() {
        let hidden_id = ssd_core::taskbar::id_of("02 Code.lnk");
        let (app, _) = app_configured(
            Platform {
                taskbar: Some(Arc::new(ssd_core::ports::FakeTaskbar::default())),
                ..Platform::default()
            },
            &format!(r#"{{"token":"tok","hidden":["{hidden_id}"]}}"#),
        );
        let auth = [("x-token", "tok")];
        // nothing is read until the first refresh (the agent does it in the background at start)
        let empty = body_of(call(&app, "GET", "/api/apps", &auth).await).await;
        assert_eq!(empty["apps"], serde_json::json!([]));

        let count = post(&app, "/api/refresh", "").await;
        assert_eq!(body_of(count).await, serde_json::json!({ "count": 2 }));
        let apps = body_of(call(&app, "GET", "/api/apps", &auth).await).await;
        assert_eq!(apps["host"], "PC");
        let names: Vec<&str> = apps["apps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["Brave", "Terminal"]);
        assert_eq!(apps["apps"][0]["hasIcon"], true);
        assert_eq!(apps["apps"][0]["iconVersion"].as_str().unwrap().len(), 8);

        let brave = apps["apps"][0]["id"].as_str().unwrap().to_owned();
        let icon = call(&app, "GET", &format!("/api/icon/{brave}"), &auth).await;
        assert_eq!(icon.status(), StatusCode::OK);
        assert_eq!(icon.headers()["content-type"], "image/png");
        assert_eq!(
            icon.headers()["cache-control"],
            "max-age=31536000, immutable"
        );
        // a hidden app still has its icon (the editor lists every app)
        assert_eq!(
            call(&app, "GET", &format!("/api/icon/{hidden_id}"), &auth)
                .await
                .status(),
            StatusCode::OK
        );
        for bad in ["/api/icon/nope", "/api/icon/..%2f..%2fconfig", "/api/icon/"] {
            assert_eq!(
                call(&app, "GET", bad, &auth).await.status(),
                StatusCode::NOT_FOUND,
                "{bad}"
            );
        }
    }

    #[tokio::test]
    async fn windows_screens_and_launching_an_app() {
        let windows = Arc::new(ssd_core::ports::FakeWindows::default());
        let taskbar = Arc::new(ssd_core::ports::FakeTaskbar::default());
        let (app, _) = app_on(Platform {
            windows: Some(windows.clone()),
            taskbar: Some(taskbar.clone()),
            ..Platform::default()
        });
        let auth = [("x-token", "tok")];
        post(&app, "/api/refresh", "").await;

        let listed = body_of(call(&app, "GET", "/api/windows", &auth).await).await;
        assert_eq!(listed["windows"][0]["app"], "Brave");
        assert!(listed["windows"][0]["appId"].is_string());
        assert_eq!(listed["windows"][1]["app"], "Notepad");
        assert!(listed["windows"][1]["appId"].is_null());

        let act = |body: &'static str| post(&app, "/api/windows/action", body);
        assert_eq!(
            act(r#"{"handle":101,"action":"minimize"}"#).await.status(),
            StatusCode::OK
        );
        assert_eq!(
            act(r#"{"handle":999,"action":"close"}"#).await.status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            act(r#"{"handle":101,"action":"explode"}"#).await.status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            act(r#"{"handle":-5,"action":"close"}"#).await.status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            post(&app, "/api/windows/move", r#"{"handle":101,"monitor":1}"#)
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            post(&app, "/api/windows/move", r#"{"handle":101,"monitor":16}"#)
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            post(
                &app,
                "/api/windows/place",
                r#"{"handle":102,"x":10.6,"y":"20"}"#
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            post(
                &app,
                "/api/windows/place",
                r#"{"handle":102,"x":1e9,"y":0}"#
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            post(
                &app,
                "/api/windows/snap",
                r#"{"handle":102,"monitor":0,"zone":"left"}"#
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            post(
                &app,
                "/api/windows/snap",
                r#"{"handle":102,"monitor":0,"zone":"top"}"#
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            windows.log(),
            [
                "Minimize 101",
                "move 101 1",
                "place 102 11,20",
                "snap 102 0 Left"
            ]
        );

        let screens = body_of(call(&app, "GET", "/api/screens", &auth).await).await;
        assert_eq!(screens["monitors"][0]["device"], "\\\\.\\DISPLAY1");
        assert_eq!(screens["monitors"][0]["brightness"], 60);
        let flat = body_of(call(&app, "GET", "/api/screens?brightness=0", &auth).await).await;
        assert!(flat["monitors"][1]["brightness"].is_null());
        assert_eq!(
            post(
                &app,
                "/api/screens/brightness",
                r#"{"device":"\\\\.\\DISPLAY2","level":"35"}"#
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            post(
                &app,
                "/api/screens/brightness",
                r#"{"device":"nope","level":35}"#
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            post(&app, "/api/screens/off", "").await.status(),
            StatusCode::OK
        );
        assert_eq!(
            post(&app, "/api/screens/project", r#"{"mode":"first"}"#)
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            post(
                &app,
                "/api/screens/project",
                r#"{"mode":"first","confirm":true}"#
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            post(&app, "/api/screens/project", r#"{"mode":"extend"}"#)
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            post(&app, "/api/screens/project", r#"{"mode":"sideways"}"#)
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );

        // an app with a window is brought to the front; one without is started; an unknown id is refused
        let apps = body_of(call(&app, "GET", "/api/apps", &auth).await).await;
        let id_of = |name: &str| {
            apps["apps"]
                .as_array()
                .unwrap()
                .iter()
                .find(|a| a["name"] == name)
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        let focused = post(&app, &format!("/api/launch/{}", id_of("Brave")), "").await;
        assert_eq!(
            body_of(focused).await,
            serde_json::json!({ "ok": true, "name": "Brave", "action": "focused" })
        );
        let started = post(&app, &format!("/api/launch/{}", id_of("Code")), "").await;
        assert_eq!(body_of(started).await["action"], "launched");
        assert_eq!(taskbar.launched(), ["C:\\TaskBar\\02 Code.lnk"]);
        assert_eq!(
            post(&app, "/api/launch/nope", "").await.status(),
            StatusCode::NOT_FOUND
        );
    }

    /// Reads the stream until `needle` shows up (or gives up after 3 s).
    async fn read_until(body: &mut axum::body::Body, needle: &str) -> String {
        use http_body_util::BodyExt;
        let mut text = String::new();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
        while !text.contains(needle) {
            let frame = tokio::time::timeout_at(deadline, body.frame())
                .await
                .unwrap_or_else(|_| panic!("no `{needle}` in the stream so far: {text}"))
                .unwrap()
                .unwrap();
            if let Ok(data) = frame.into_data() {
                text.push_str(&String::from_utf8_lossy(&data));
            }
        }
        text
    }

    #[tokio::test]
    async fn the_event_stream_pushes_a_topic_and_refuses_unknown_ones() {
        let (app, _) = app_on(Platform {
            audio: Some(Arc::new(ssd_core::ports::FakeAudio::default())),
            windows: Some(Arc::new(ssd_core::ports::FakeWindows::default())),
            ..Platform::default()
        });
        let auth = [("x-token", "tok")];
        for bad in [
            "/api/events",
            "/api/events?topics=",
            "/api/events?topics=audio,nope",
        ] {
            assert_eq!(
                call(&app, "GET", bad, &auth).await.status(),
                StatusCode::BAD_REQUEST,
                "{bad}"
            );
        }

        let response = call(&app, "GET", "/api/events?topics=audio,windows", &auth).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "text/event-stream");
        let mut body = response.into_body();
        let mut all = read_until(&mut body, "event: windows").await;
        if !all.contains("event: audio") {
            all.push_str(&read_until(&mut body, "event: audio").await);
        }
        assert!(
            all.starts_with(
                "retry: 2000

"
            ),
            "{all}"
        );
        assert!(
            all.contains(
                "event: audio
data: {\"playback\":"
            ),
            "{all}"
        );
        assert!(
            all.contains(
                "event: windows
data: {\"windows\":["
            ),
            "{all}"
        );
        // a topic only goes again when it changed: with nothing changing, the next thing on the wire is the keep-alive or nothing
        assert_eq!(all.matches("event: audio").count(), 1, "{all}");
    }

    fn everything() -> Platform {
        Platform {
            audio: Some(Arc::new(ssd_core::ports::FakeAudio::default())),
            media: Some(Arc::new(ssd_core::ports::FakeMedia::default())),
            input: None,
            taskbar: Some(Arc::new(ssd_core::ports::FakeTaskbar::default())),
            windows: Some(Arc::new(ssd_core::ports::FakeWindows::default())),
            power: Some(Arc::new(ssd_core::ports::FakePower::default())),
            monitor: Some(Arc::new(ssd_core::ports::FakeMonitor)),
            notifications: Some(Arc::new(ssd_core::ports::FakeNotifications)),
            vcam: Some(Arc::new(ssd_core::ports::FakeVcam::default())),
        }
    }

    #[tokio::test]
    async fn power_actions_need_confirmation_and_the_countdown_shows_in_the_state() {
        let (app, _) = app_on(everything());
        let auth = [("x-token", "tok")];
        post(&app, "/api/refresh", "").await;

        let power = body_of(call(&app, "GET", "/api/power", &auth).await).await;
        assert_eq!(power["enabled"], true);
        assert_eq!(power["uptimeSec"], 3600);
        assert_eq!(
            (power["hibernate"].clone(), power["fastStartup"].clone()),
            (true.into(), true.into())
        );
        assert_eq!(power["scheduled"], serde_json::Value::Null);
        assert!(power["openApps"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["name"] == "Brave"));

        for (body, status) in [
            (
                r#"{"action":"explode","confirm":true}"#,
                StatusCode::BAD_REQUEST,
            ),
            (r#"{"action":"shutdown"}"#, StatusCode::BAD_REQUEST),
            (
                r#"{"action":"shutdown","confirm":true,"delaySec":-4}"#,
                StatusCode::BAD_REQUEST,
            ),
        ] {
            assert_eq!(
                post(&app, "/api/power", body).await.status(),
                status,
                "{body}"
            );
        }
        let asked = post(
            &app,
            "/api/power",
            r#"{"action":"shutdown","confirm":true,"delaySec":120,"force":true}"#,
        )
        .await;
        assert_eq!(asked.status(), StatusCode::OK);
        let asked = body_of(asked).await;
        assert_eq!(
            (asked["ok"].clone(), asked["action"].clone()),
            (true.into(), "shutdown".into())
        );
        assert!(asked["at"].as_i64().unwrap() > 0);

        let state = body_of(call(&app, "GET", "/api/state", &auth).await).await;
        assert_eq!(state["scheduled"]["action"], "shutdown");
        assert!(state["scheduled"]["inSec"].as_i64().unwrap() > 100);
        assert_eq!(state["scheduled"]["force"], true);

        let cancelled = post(&app, "/api/power", r#"{"action":"cancel"}"#).await;
        assert_eq!(
            body_of(cancelled).await,
            serde_json::json!({ "ok": true, "action": "cancel", "cancelled": true, "note": null })
        );
        let after = body_of(call(&app, "GET", "/api/state", &auth).await).await;
        assert!(after["scheduled"].is_null());
    }

    #[tokio::test]
    async fn the_state_of_the_header_is_made_of_the_other_modules() {
        let (app, _) = app_on(everything());
        let auth = [("x-token", "tok")];
        post(&app, "/api/refresh", "").await;
        let apps = body_of(call(&app, "GET", "/api/apps", &auth).await).await;
        let brave = apps["apps"][0]["id"].clone();

        let state = body_of(call(&app, "GET", "/api/state", &auth).await).await;
        assert_eq!(state["running"], serde_json::json!([brave]));
        assert_eq!(state["open"], serde_json::json!([brave]));
        assert_eq!(
            state["volume"],
            serde_json::json!({ "level": 30, "muted": false })
        );
        assert_eq!(
            state["mic"],
            serde_json::json!({ "available": true, "muted": false })
        );
        assert_eq!(state["playing"]["session"], "s1");
        assert_eq!(state["playing"]["canToggle"], true);
        assert_eq!(state["miniPlayer"], true);
        assert!(
            state["ui"].as_u64().unwrap() > 0,
            "the build folder has files"
        );
        assert_eq!(
            state["appsRev"], 1,
            "one change since the start: the first read"
        );
    }

    #[tokio::test]
    async fn power_controls_can_be_turned_off_in_the_config() {
        let (app, _) = app_configured(
            everything(),
            r#"{"token":"tok","powerControls":false,"miniPlayer":false}"#,
        );
        let off = post(
            &app,
            "/api/power",
            r#"{"action":"shutdown","confirm":true}"#,
        )
        .await;
        assert_eq!(off.status(), StatusCode::FORBIDDEN);
        let auth = [("x-token", "tok")];
        assert_eq!(
            body_of(call(&app, "GET", "/api/power", &auth).await).await["enabled"],
            false
        );
        let state = body_of(call(&app, "GET", "/api/state", &auth).await).await;
        assert_eq!(
            (state["miniPlayer"].clone(), state["playing"].clone()),
            (false.into(), serde_json::Value::Null)
        );
    }

    fn with_input(input: Arc<ssd_core::ports::FakeInput>) -> Platform {
        Platform {
            input: Some(input),
            ..everything()
        }
    }

    #[tokio::test]
    async fn the_editor_saves_shortcuts_macros_and_hidden_apps() {
        let (app, _) = app_on(everything());
        let auth = [("x-token", "tok")];
        post(&app, "/api/refresh", "").await;
        let apps = body_of(call(&app, "GET", "/api/apps", &auth).await).await;
        let brave = apps["apps"][0]["id"].as_str().unwrap().to_owned();

        let editor = body_of(call(&app, "GET", "/api/editor", &auth).await).await;
        assert_eq!(editor["apps"][0]["canPlace"], true);
        assert_eq!(editor["apps"][0]["hidden"], false);
        assert_eq!(
            editor["devices"]["playback"][0],
            serde_json::json!({ "id": "out1", "name": "Alto-falantes" })
        );
        assert_eq!(editor["screens"], 2);
        assert!(editor["shortcuts"].as_array().unwrap().len() >= 9);

        let saved = post(&app, "/api/editor/shortcuts", r#"{"items":[{"id":"copy","label":"Copiar","keys":"Ctrl+C"},{"label":"Fechar","keys":"alt+f4"}]}"#).await;
        let saved = body_of(saved).await;
        assert_eq!(
            saved["shortcuts"][0],
            serde_json::json!({ "id": "copy", "label": "Copiar", "keys": "ctrl+c", "display": "Ctrl+C" })
        );
        assert!(saved["shortcuts"][1]["id"]
            .as_str()
            .unwrap()
            .starts_with("fechar-"));
        assert_eq!(
            post(
                &app,
                "/api/editor/shortcuts",
                r#"{"items":[{"label":"x","keys":"ctrl+nope"}]}"#
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );

        let macros = format!(
            r#"{{"items":[{{"label":"Jogar","page":"apps","steps":[{{"type":"launch","app":"{brave}"}},{{"type":"wait","ms":100}}]}}]}}"#
        );
        let saved = body_of(post(&app, "/api/editor/macros", &macros).await).await;
        assert_eq!(saved["macros"][0]["label"], "Jogar");
        let unknown = r#"{"items":[{"label":"x","steps":[{"type":"launch","app":"nope"}]}]}"#;
        assert_eq!(
            post(&app, "/api/editor/macros", unknown).await.status(),
            StatusCode::BAD_REQUEST
        );

        let hidden = format!(r#"{{"hidden":["{brave}","{brave}"]}}"#);
        assert_eq!(
            post(&app, "/api/editor/apps", &hidden).await.status(),
            StatusCode::OK
        );
        assert_eq!(
            post(&app, "/api/editor/apps", r#"{"hidden":["nope"]}"#)
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
        let after = body_of(call(&app, "GET", "/api/apps", &auth).await).await;
        assert!(
            after["apps"]
                .as_array()
                .unwrap()
                .iter()
                .all(|a| a["id"] != brave.as_str()),
            "a hidden app leaves the Apps page"
        );
        let editor = body_of(call(&app, "GET", "/api/editor", &auth).await).await;
        assert_eq!(
            editor["apps"][0]["hidden"], true,
            "but the editor still lists it"
        );

        let list = body_of(call(&app, "GET", "/api/macros", &auth).await).await;
        assert_eq!(list["macros"][0]["page"], "apps");
        assert_eq!(list["macros"][0]["steps"], 2);
    }

    #[tokio::test]
    async fn the_editor_can_be_turned_off() {
        let (app, _) = app_configured(everything(), r#"{"token":"tok","editor":false}"#);
        assert_eq!(
            call(&app, "GET", "/api/editor", &[("x-token", "tok")])
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            post(&app, "/api/editor/shortcuts", r#"{"items":[]}"#)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn a_macro_runs_its_steps_reports_each_one_and_hands_the_camera_back() {
        let input = Arc::new(ssd_core::ports::FakeInput::default());
        let (app, _) = app_configured(
            with_input(input.clone()),
            r#"{"token":"tok","macros":[{"id":"m1","label":"Mix","page":"shortcuts","steps":[
                {"type":"keys","keys":"ctrl+c"},{"type":"media","key":"next"},{"type":"volume","level":55},{"type":"mute","muted":true},
                {"type":"output","device":"out2","name":"Fone"},{"type":"output","device":"gone","name":"Sumiu"},
                {"type":"launch","app":"nope"},{"type":"wait","ms":100},{"type":"camera","on":true}]}]}"#,
        );
        let auth = [("x-token", "tok")];
        let ran = body_of(post(&app, "/api/macro/m1", "").await).await;
        assert_eq!(ran["ok"], false, "two steps failed");
        assert_eq!(ran["label"], "Mix");
        let steps = ran["steps"].as_array().unwrap();
        assert_eq!(steps.len(), 9);
        assert_eq!(steps[0], serde_json::json!({ "type": "keys", "ok": true }));
        assert_eq!(
            steps[5],
            serde_json::json!({ "type": "output", "ok": false, "error": "device not found: Sumiu" })
        );
        assert_eq!(
            steps[6],
            serde_json::json!({ "type": "launch", "ok": false, "error": "app not on the taskbar anymore" })
        );
        assert_eq!(
            ran["client"],
            serde_json::json!([{ "type": "camera", "on": true }])
        );
        assert_eq!(input.pressed(), vec![vec![0x11, b'C'], vec![0xb0]]);
        let volume = body_of(call(&app, "GET", "/api/volume", &auth).await).await;
        assert_eq!(volume, serde_json::json!({ "level": 55, "muted": true }));
        let audio = body_of(call(&app, "GET", "/api/audio", &auth).await).await;
        assert_eq!(audio["playback"][1]["default"], true);
        assert_eq!(
            post(&app, "/api/macro/nope", "").await.status(),
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn the_monitor_routes_and_the_streams_that_carry_them() {
        let (app, _) = app_on(everything());
        let auth = [("x-token", "tok")];
        let sample = body_of(call(&app, "GET", "/api/monitor/sample", &auth).await).await;
        assert_eq!(sample["cpu"]["usage"], 12.5);
        assert!(body_of(call(&app, "GET", "/api/monitor/fps", &auth).await)
            .await
            .is_null());
        let top = body_of(call(&app, "GET", "/api/monitor/processes", &auth).await).await;
        assert_eq!(top["cpu"][0]["name"], "game");
        let info = body_of(call(&app, "GET", "/api/monitor/info", &auth).await).await;
        assert_eq!(info["host"], "FAKE-PC");

        // the sample is pushed as the `monitor` event, the program list as `processes`, and the frame rate as `game`
        let response = call(
            &app,
            "GET",
            "/api/events?topics=monitor,processes,game",
            &auth,
        )
        .await;
        let mut body = response.into_body();
        let mut seen = read_until(&mut body, "event: monitor").await;
        for topic in ["event: processes", "event: game"] {
            if !seen.contains(topic) {
                seen.push_str(&read_until(&mut body, topic).await);
            }
        }
        assert!(seen.contains("event: game\ndata: null"), "{seen}");
    }

    async fn post_bytes(app: &Router, uri: &str, body: Vec<u8>) -> Response {
        let request = Request::builder()
            .method("POST")
            .uri(uri)
            .header("host", "127.0.0.1:7878")
            .header("x-token", "tok")
            .body(Body::from(body))
            .unwrap();
        app.clone().oneshot(request).await.unwrap()
    }

    #[tokio::test]
    async fn the_phone_camera_frames_the_stream_the_status_and_the_direct_camera() {
        let vcam = Arc::new(ssd_core::ports::FakeVcam::default());
        let (app, _) = app_on(Platform {
            vcam: Some(vcam.clone()),
            ..Platform::default()
        });
        let auth = [("x-token", "tok")];
        let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe0];
        jpeg.extend(std::iter::repeat_n(7u8, 2000));

        // nothing yet: the stream shows the "no signal" picture, the status says nobody is sending
        let idle = body_of(call(&app, "GET", "/api/camera/status", &auth).await).await;
        assert_eq!(
            (
                idle["live"].clone(),
                idle["fps"].clone(),
                idle["wanted"].clone()
            ),
            (false.into(), 0.into(), false.into())
        );
        assert!(idle["link"]
            .as_str()
            .unwrap()
            .contains("/camera.html?token=tok"));
        assert_eq!(idle["direct"]["name"], "Stream Deck Camera");

        let mut stream = call(&app, "GET", "/api/camera/stream", &auth).await;
        assert!(stream.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("multipart/x-mixed-replace; boundary="));
        let first = read_until(stream.body_mut(), "image/jpeg").await;
        assert!(first.starts_with("--ssdframe"), "{first:.60}");

        // a frame is answered with 204 and tells the phone somebody watches (this stream)
        let sent = post_bytes(&app, "/api/camera/frame", jpeg.clone()).await;
        assert_eq!(sent.status(), StatusCode::NO_CONTENT);
        assert_eq!(sent.headers()["x-camera-wanted"], "1");
        for bad in [
            vec![1, 2, 3, 4, 5],
            vec![0xff, 0xd8],
            vec![0xff, 0xd8, 0xff, 0xe0]
                .into_iter()
                .chain(std::iter::repeat_n(0, 1_600_000))
                .collect::<Vec<u8>>(),
        ] {
            assert!(post_bytes(&app, "/api/camera/frame", bad)
                .await
                .status()
                .is_client_error());
        }
        let live = body_of(call(&app, "GET", "/api/camera/status", &auth).await).await;
        assert_eq!(live["live"], true);
        assert_eq!(live["viewers"], 1);
        assert!(live["ageMs"].as_u64().unwrap() < 2000);
        drop(stream);
        assert_eq!(
            vcam.log(),
            vec!["feed 2004".to_owned()],
            "the direct camera got the good frame only"
        );

        // the direct camera needs an explicit confirmation; copy-link puts the OBS link on the clipboard
        assert_eq!(
            post(&app, "/api/camera/direct/install", "{}")
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            post(&app, "/api/camera/direct/install", r#"{"confirm":true}"#)
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            post(&app, "/api/camera/direct/uninstall", r#"{"confirm":true}"#)
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            post(&app, "/api/camera/copy-link", "").await.status(),
            StatusCode::OK
        );
        let log = vcam.log();
        assert_eq!(&log[1..3], ["install", "uninstall"]);
        assert!(
            log[3].starts_with("clipboard http://127.0.0.1:")
                && log[3].contains("/camera.html?token=tok"),
            "{log:?}"
        );
    }
}
