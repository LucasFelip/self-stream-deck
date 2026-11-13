//! The HTTP side of the agent. A request crosses `access::guard` (Host, lockout, token, Origin), then finds its route in `routes::table`
//! (each module lists its own) or, failing that, a file of the interface; what nothing answers is a JSON 404.
mod access;
mod apps;
mod audio;
mod camera;
mod editor;
pub mod embedded;
mod events;
mod media;
mod monitorroutes;
mod powerroutes;
mod routes;
mod shortcuts;
mod statics;
mod stats;
mod winroutes;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use axum::Router;
use ssd_core::config::Config;
use ssd_core::guard::Guard;
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

/// The ports of the PC. A module without its port answers 404.
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
    /// the build of web/ (web/dist); an empty path means the interface packed inside the executable
    pub web_dir: PathBuf,
    /// what the PC offers (or fakes of it): a module without its port answers 404
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

/// The whole HTTP side: the table of routes, the interface's files for what no route answers, and the guard in front of everything.
pub fn router(state: Arc<AppState>) -> Router {
    routes::table()
        .fallback(access::static_or_not_found)
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            access::guard,
        ))
        .with_state(state)
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

#[cfg(test)]
mod tests;
