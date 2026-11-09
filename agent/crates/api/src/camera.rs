//! The phone's camera as a webcam for the PC. The deck page on the phone sends JPEG frames (`POST /api/camera/frame`) and this module hands the
//! newest one to whoever watches the MJPEG stream (`GET /api/camera/stream`): OBS shows that stream in a Browser Source and publishes it as its
//! Virtual Camera. When the direct virtual camera is installed the frames also go to it. Nothing is stored: only the latest frame, in memory.
//! Parity with `legacy/server/src/camera.js` and `routes/camera.js`.
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;

use crate::routes::error;
use crate::{json, with_security, AppState};

const BOUNDARY: &str = "ssdframe";
pub const MAX_FRAME: usize = 3 * 1024 * 1024 / 2; // 1.5 MB
/// No frame for this long means the phone stopped sending.
const LIVE: Duration = Duration::from_secs(2);
/// A picture for when the phone is silent, so the stream never looks frozen.
const NO_SIGNAL: &[u8] = include_bytes!("../assets/nosignal.jpg");

struct Frames {
    latest: Option<(Bytes, Instant)>,
    recent: Vec<Instant>,
    bytes_recent: Vec<(Instant, usize)>,
}

#[derive(Default)]
pub struct Camera {
    frames: Mutex<Option<Frames>>,
    viewers: Mutex<HashMap<u64, mpsc::Sender<Bytes>>>,
    next: AtomicU64,
    keepalive_running: Mutex<bool>,
}

fn part(jpeg: &[u8]) -> Bytes {
    let mut out = format!(
        "--{BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n",
        jpeg.len()
    )
    .into_bytes();
    out.extend_from_slice(jpeg);
    out.extend_from_slice(b"\r\n");
    Bytes::from(out)
}

impl Camera {
    fn is_live(&self) -> bool {
        self.frames
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|f| f.latest.as_ref())
            .is_some_and(|(_, at)| at.elapsed() < LIVE)
    }

    /// Does anybody use the picture right now? An OBS source watching the stream, or an app that has the direct virtual camera open.
    /// The phone sends full speed only then; otherwise it drops to one frame a second.
    pub fn wanted(&self, vcam_in_use: bool) -> bool {
        !self.viewers.lock().unwrap().is_empty() || vcam_in_use
    }

    fn push(&self, frame: Bytes) -> Result<(), &'static str> {
        if frame.len() < 4 || frame.len() > MAX_FRAME || frame[0] != 0xff || frame[1] != 0xd8 {
            return Err("not a JPEG frame");
        }
        let now = Instant::now();
        {
            let mut guard = self.frames.lock().unwrap();
            let frames = guard.get_or_insert_with(|| Frames {
                latest: None,
                recent: Vec::new(),
                bytes_recent: Vec::new(),
            });
            frames.latest = Some((frame.clone(), now));
            frames.recent.push(now);
            frames.bytes_recent.push((now, frame.len()));
            frames
                .recent
                .retain(|at| now.duration_since(*at) <= Duration::from_secs(2));
            frames
                .bytes_recent
                .retain(|(at, _)| now.duration_since(*at) <= Duration::from_secs(2));
        }
        let bytes = part(&frame);
        // a slow viewer drops frames instead of making the agent buffer them
        for sender in self.viewers.lock().unwrap().values() {
            let _ = sender.try_send(bytes.clone());
        }
        Ok(())
    }

    pub fn status(&self, vcam_in_use: bool) -> Map<String, Value> {
        // is_live() takes the same lock: ask it first
        let live = self.is_live();
        let guard = self.frames.lock().unwrap();
        let (fps, kbps, age) = match guard.as_ref() {
            Some(frames) => {
                let span = match (frames.recent.first(), frames.recent.last()) {
                    (Some(first), Some(last)) if frames.recent.len() > 1 => {
                        last.duration_since(*first).as_secs_f64()
                    }
                    _ => 0.0,
                };
                let kb: f64 = frames
                    .bytes_recent
                    .iter()
                    .map(|(_, size)| *size as f64)
                    .sum::<f64>()
                    / 1024.0;
                (
                    if live && span > 0.0 {
                        ((frames.recent.len() - 1) as f64 / span).round() as i64
                    } else {
                        0
                    },
                    if live { (kb / 2.0).round() as i64 } else { 0 },
                    frames
                        .latest
                        .as_ref()
                        .map(|(_, at)| at.elapsed().as_millis() as u64),
                )
            }
            None => (0, 0, None),
        };
        let mut map = Map::new();
        map.insert("live".into(), json!(live));
        map.insert("fps".into(), json!(fps));
        map.insert("kbps".into(), json!(kbps));
        map.insert("viewers".into(), json!(self.viewers.lock().unwrap().len()));
        map.insert("wanted".into(), json!(self.wanted(vcam_in_use)));
        map.insert("ageMs".into(), json!(age));
        map
    }

    /// While somebody watches and the phone is silent, repeat the "no signal" picture every second.
    fn keep_alive(self: &Arc<Self>) {
        let mut running = self.keepalive_running.lock().unwrap();
        if *running {
            return;
        }
        *running = true;
        let camera = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let mut viewers = camera.viewers.lock().unwrap();
                viewers.retain(|_, sender| !sender.is_closed());
                if viewers.is_empty() {
                    *camera.keepalive_running.lock().unwrap() = false;
                    return;
                }
                if !camera.is_live() {
                    let bytes = part(NO_SIGNAL);
                    for sender in viewers.values() {
                        let _ = sender.try_send(bytes.clone());
                    }
                }
            }
        });
    }
}

fn link(state: &AppState) -> String {
    let config = state.config.lock().unwrap();
    format!(
        "http://127.0.0.1:{}/camera.html?token={}",
        config.port(),
        config.token()
    )
}

fn vcam_in_use(state: &AppState) -> bool {
    state.platform.vcam.as_ref().is_some_and(|v| v.in_use())
}

pub async fn camera_route(state: &Arc<AppState>, post: bool, path: &str, body: Bytes) -> Response {
    let Some(vcam) = state.platform.vcam.clone() else {
        return error(StatusCode::NOT_FOUND, "not found");
    };
    match (post, path) {
        (true, "/api/camera/frame") => match state.camera.push(body.clone()) {
            Ok(()) => {
                let frame = body.to_vec();
                // the direct virtual camera, when it is installed (a thread of its own decodes it)
                let vcam = vcam.clone();
                tokio::task::spawn_blocking(move || vcam.feed(&frame));
                let mut response = Response::new(Body::empty());
                *response.status_mut() = StatusCode::NO_CONTENT;
                // tells the phone whether anyone uses the picture: if not, it only needs to send a frame now and then
                let wanted = if state.camera.wanted(vcam_in_use(state)) {
                    "1"
                } else {
                    "0"
                };
                response
                    .headers_mut()
                    .insert("x-camera-wanted", HeaderValue::from_static(wanted));
                with_security(response)
            }
            Err(message) => error(StatusCode::BAD_REQUEST, message),
        },
        (false, "/api/camera/stream") => stream(state),
        (false, "/api/camera/status") => {
            let mut status = state.camera.status(vcam_in_use(state));
            status.insert("link".into(), json!(link(state)));
            let direct = tokio::task::spawn_blocking(move || vcam.status()).await;
            status.insert(
                "direct".into(),
                direct.ok().and_then(Result::ok).unwrap_or(Value::Null),
            );
            json(StatusCode::OK, Value::Object(status))
        }
        (true, "/api/camera/direct/install" | "/api/camera/direct/uninstall") => {
            let confirmed =
                serde_json::from_slice::<Value>(if body.is_empty() { b"{}" } else { &body })
                    .ok()
                    .is_some_and(|v| v["confirm"] == true);
            if !confirmed {
                return error(StatusCode::BAD_REQUEST, "confirm must be true");
            }
            let installing = path.ends_with("install") && !path.ends_with("uninstall");
            let worker = vcam.clone();
            let outcome = tokio::task::spawn_blocking(move || {
                if installing {
                    worker.install()
                } else {
                    worker.uninstall()
                }
            })
            .await;
            match outcome {
                Ok(Ok(())) => json(
                    StatusCode::OK,
                    tokio::task::spawn_blocking(move || vcam.status())
                        .await
                        .ok()
                        .and_then(Result::ok)
                        .unwrap_or(Value::Null),
                ),
                Ok(Err(problem)) => crate::routes::port_error(problem),
                Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "internal error"),
            }
        }
        // puts the link for OBS's Browser Source on this PC's clipboard, so nobody has to type a token
        (true, "/api/camera/copy-link") => {
            let text = link(state);
            match tokio::task::spawn_blocking(move || vcam.copy_to_clipboard(&text)).await {
                Ok(Ok(())) => json(StatusCode::OK, json!({ "ok": true })),
                Ok(Err(problem)) => crate::routes::port_error(problem),
                Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "internal error"),
            }
        }
        _ => error(StatusCode::NOT_FOUND, "not found"),
    }
}

fn stream(state: &Arc<AppState>) -> Response {
    let camera = state.camera.clone();
    let (sender, receiver) = mpsc::channel::<Bytes>(8);
    let first = match camera
        .frames
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|f| f.latest.clone())
    {
        Some((frame, at)) if at.elapsed() < LIVE => part(&frame),
        _ => part(NO_SIGNAL),
    };
    let _ = sender.try_send(first);
    let id = camera.next.fetch_add(1, Ordering::Relaxed);
    camera.viewers.lock().unwrap().insert(id, sender);
    camera.keep_alive();
    // the viewer is forgotten when its receiver goes away with the response
    let cleanup = camera.clone();
    let stream = ReceiverStream::new(receiver).map(Ok::<Bytes, Infallible>);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let mut viewers = cleanup.viewers.lock().unwrap();
            if viewers.get(&id).is_none_or(|s| s.is_closed()) {
                viewers.remove(&id);
                return;
            }
        }
    });
    let mut response = Response::new(Body::from_stream(stream));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&format!("multipart/x-mixed-replace; boundary={BOUNDARY}"))
            .expect("a valid header"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    with_security(response)
}
