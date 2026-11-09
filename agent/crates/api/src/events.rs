//! Server-sent events: the PC tells the phone when something changed instead of the phone asking every second or two. Same behavior as
//! `legacy/server/src/events.js`: a topic's producer runs only while somebody listens to it, a new value is sent only when it differs from the
//! last one (by its signature), and a client that joins a running topic gets the last value at once.
//!
//! Transition: the topics this agent has the ports for are produced here; the others (state, power, notifications, monitor, processes, game)
//! are read from the Node agent behind this one and merged into the same response, so the phone keeps a single stream.
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use http_body_util::BodyExt;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use serde_json::{json, Value};
use ssd_core::windows::visible_windows;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;

use crate::{apps, error_json, with_security, AppState};

/// Every topic the phone may ask for.
pub const TOPICS: [&str; 9] = [
    "windows",
    "state",
    "audio",
    "media",
    "notifications",
    "monitor",
    "processes",
    "power",
    "game",
];
const KEEPALIVE: Duration = Duration::from_secs(20);
const RETRY_LINE: &[u8] = b"retry: 2000\n\n";

struct Topic {
    clients: HashMap<u64, mpsc::Sender<Bytes>>,
    last_json: Option<String>,
    last_signature: Option<String>,
    task: Option<JoinHandle<()>>,
}

#[derive(Default)]
pub struct Hub {
    topics: Mutex<HashMap<&'static str, Topic>>,
    next_client: AtomicU64,
}

/// Does this agent produce the topic itself (it has the port), or does the Node agent behind it?
fn owned(state: &AppState, name: &str) -> bool {
    match name {
        "windows" => state.platform.windows.is_some(),
        "audio" => state.platform.audio.is_some(),
        "media" => state.platform.media.is_some(),
        "monitor" | "game" | "processes" => state.platform.monitor.is_some(),
        "state" => crate::powerroutes::state_ready(state),
        "power" => state.platform.power.is_some() && state.platform.windows.is_some(),
        _ => false,
    }
}

fn interval(name: &str) -> Duration {
    Duration::from_millis(match name {
        "windows" => 600,
        "media" => 1500,
        "game" => 1000,
        "state" | "processes" => 3000,
        "power" => 5000,
        _ => 2000,
    })
}

fn frame(name: &str, json: &str) -> Bytes {
    Bytes::from(format!("event: {name}\ndata: {json}\n\n"))
}

/// A title that only changes its leading spinner glyph (a terminal at work) is not news.
fn without_spinner(title: &str) -> &str {
    title.trim_start_matches(|c: char| !c.is_alphanumeric())
}

/// What a topic holds now, and the signature that says whether it changed.
async fn produce(state: &Arc<AppState>, name: &str) -> Option<(String, String)> {
    match name {
        "windows" => {
            let windows = state.platform.windows.clone()?;
            let snapshot = tokio::task::spawn_blocking(move || windows.snapshot())
                .await
                .ok()?
                .ok()?;
            let signature = snapshot
                .windows
                .iter()
                .map(|w| {
                    format!(
                        "{}|{}|{}|{}|{}|{}|{}|{}|{}",
                        w.handle,
                        without_spinner(&w.title),
                        w.name,
                        w.state,
                        w.monitor,
                        w.x,
                        w.y,
                        w.w,
                        w.h
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            let data = json!({ "windows": visible_windows(&snapshot, &apps::visible(state)) });
            Some((data.to_string(), signature))
        }
        "audio" => {
            let audio = state.platform.audio.clone()?;
            let (devices, sessions) =
                tokio::task::spawn_blocking(move || (audio.devices(), audio.sessions()))
                    .await
                    .ok()?;
            let devices = devices.ok()?;
            let data = json!({ "playback": devices.playback, "capture": devices.capture, "sessions": sessions.unwrap_or_default() }).to_string();
            Some((data.clone(), data))
        }
        "media" => {
            let media = state.platform.media.clone()?;
            let current = tokio::task::spawn_blocking(move || media.state())
                .await
                .ok()?
                .ok()?;
            // the playback position moves all the time: it is resent every 5 s, the rest only when it changes
            let mut stable = serde_json::to_value(&current).ok()?;
            if let Some(sessions) = stable.get_mut("sessions").and_then(Value::as_array_mut) {
                for session in sessions {
                    let bucket = session
                        .get("position")
                        .and_then(Value::as_f64)
                        .map_or(0.0, |p| (p / 5.0).floor());
                    session["position"] = json!(bucket);
                }
            }
            Some((json!(current).to_string(), stable["sessions"].to_string()))
        }
        // always sent, even when it looks the same: a sample is a moment, not a state
        "monitor" | "processes" => {
            let what = if name == "monitor" {
                "sample"
            } else {
                "processes"
            };
            let data = crate::monitorroutes::read(state, what).await.ok()?;
            Some((data.to_string(), state.hub.tick()))
        }
        "game" => {
            let data = crate::monitorroutes::read(state, "fps").await.ok()?;
            Some((data.to_string(), data.to_string()))
        }
        "state" => {
            let data = crate::powerroutes::build_state(state).await?;
            let signature = without_countdown(&data);
            Some((data.to_string(), signature))
        }
        "power" => {
            let data = crate::powerroutes::build_power(state).await?;
            let signature = without_countdown(&data);
            Some((data.to_string(), signature))
        }
        _ => None,
    }
}

/// The countdown of a scheduled shutdown is counted by the phone itself, so it is not part of what "changed" means.
fn without_countdown(data: &Value) -> String {
    let mut stable = data.clone();
    if let Some(scheduled) = stable.get_mut("scheduled").filter(|s| s.is_object()) {
        scheduled["inSec"] = json!(0);
    }
    stable.to_string()
}

impl Hub {
    /// A signature that is never the same twice, for the topics that are sent on every turn.
    fn tick(&self) -> String {
        self.next_client.fetch_add(1, Ordering::Relaxed).to_string()
    }

    fn publish(&self, name: &str, json: String, signature: String) {
        let mut topics = self.topics.lock().unwrap();
        let Some(topic) = topics.get_mut(name) else {
            return;
        };
        if topic.last_signature.as_deref() == Some(signature.as_str()) {
            return; // nothing new
        }
        let bytes = frame(name, &json);
        topic.last_json = Some(json);
        topic.last_signature = Some(signature);
        // a client that cannot keep up misses this one; the next value catches it up
        for client in topic.clients.values() {
            let _ = client.try_send(bytes.clone());
        }
    }

    fn leave(&self, id: u64, wanted: &[&'static str]) {
        let mut topics = self.topics.lock().unwrap();
        for name in wanted {
            let Some(topic) = topics.get_mut(name) else {
                continue;
            };
            topic.clients.remove(&id);
            if topic.clients.is_empty() {
                if let Some(task) = topic.task.take() {
                    task.abort();
                }
                topic.last_json = None;
                topic.last_signature = None;
            }
        }
    }
}

fn start_producer(state: &Arc<AppState>, name: &'static str) -> JoinHandle<()> {
    let state = state.clone();
    tokio::spawn(async move {
        // the windows are pushed when the platform can (focus, open, close, move, rename...); the others are asked on a timer
        let (quick, slow) = (
            Arc::new(tokio::sync::Notify::new()),
            Arc::new(tokio::sync::Notify::new()),
        );
        let watch = (name == "windows")
            .then(|| state.platform.windows.clone())
            .flatten()
            .and_then(|windows| {
                let (quick, slow) = (quick.clone(), slow.clone());
                windows.watch(Arc::new(move |title_only| {
                    if title_only {
                        slow.notify_one()
                    } else {
                        quick.notify_one()
                    }
                }))
            });
        loop {
            if let Some((json, signature)) = produce(&state, name).await {
                state.hub.publish(name, json, signature);
            }
            if watch.is_some() {
                // a change, or 5 s as a safety net; a burst is one read after a short pause (a title that keeps changing, a terminal's spinner,
                // is announced at most about twice a second)
                tokio::select! {
                    () = quick.notified() => tokio::time::sleep(Duration::from_millis(40)).await,
                    () = slow.notified() => tokio::time::sleep(Duration::from_millis(600)).await,
                    () = tokio::time::sleep(Duration::from_secs(5)) => {}
                }
            } else {
                tokio::time::sleep(interval(name)).await;
            }
        }
    })
}

/// Reads the topics this agent does not produce from the Node agent behind it and passes them on, minus the stream's own first line.
async fn relay_upstream(
    state: Arc<AppState>,
    topics: Vec<&'static str>,
    sender: mpsc::Sender<Bytes>,
) {
    let Some(upstream) = state.upstream else {
        return;
    };
    let uri = format!("http://{upstream}/api/events?topics={}", topics.join(","));
    let Ok(request) = axum::http::Request::builder()
        .uri(uri)
        .header(header::HOST, upstream.to_string())
        .header("x-token", state.guard.token())
        .body(Body::empty())
    else {
        return;
    };
    let client: Client<_, Body> = Client::builder(TokioExecutor::new()).build_http();
    let Ok(answer) = client.request(request).await else {
        return;
    };
    let mut body = answer.into_body();
    let mut first = true;
    while let Some(Ok(frame)) = body.frame().await {
        let Ok(mut data) = frame.into_data() else {
            continue;
        };
        if first {
            first = false;
            if data.starts_with(RETRY_LINE) {
                data = data.slice(RETRY_LINE.len()..);
            }
        }
        if !data.is_empty() && sender.send(data).await.is_err() {
            return; // the phone left: dropping the upstream connection stops what Node was producing for it
        }
    }
}

/// `GET /api/events?topics=windows,state`: keeps the response open and pushes a topic's new value when it changes.
pub async fn subscribe(state: &Arc<AppState>, query: &str) -> Response {
    let requested: Vec<String> = query
        .split('&')
        .find_map(|pair| pair.strip_prefix("topics="))
        .map(|list| ssd_core::guard::percent_decode(list).unwrap_or_default())
        .unwrap_or_default()
        .split(',')
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .collect();
    let wanted: Vec<&'static str> = {
        let mut seen = Vec::new();
        for name in &requested {
            match TOPICS.iter().find(|known| **known == name) {
                Some(known) => {
                    if !seen.contains(known) {
                        seen.push(*known);
                    }
                }
                None => {
                    return error_json(
                        StatusCode::BAD_REQUEST,
                        &format!("topics: {}", TOPICS.join(", ")),
                    )
                }
            }
        }
        seen
    };
    if wanted.is_empty() {
        return error_json(
            StatusCode::BAD_REQUEST,
            &format!("topics: {}", TOPICS.join(", ")),
        );
    }

    let (sender, receiver) = mpsc::channel::<Bytes>(64);
    let _ = sender.try_send(Bytes::from_static(RETRY_LINE));
    let id = state.hub.next_client.fetch_add(1, Ordering::Relaxed);
    let (mine, theirs): (Vec<&'static str>, Vec<&'static str>) =
        wanted.iter().partition(|name| owned(state, name));

    {
        let mut topics = state.hub.topics.lock().unwrap();
        for name in &mine {
            let topic = topics.entry(name).or_insert_with(|| Topic {
                clients: HashMap::new(),
                last_json: None,
                last_signature: None,
                task: None,
            });
            topic.clients.insert(id, sender.clone());
            match (&topic.task, &topic.last_json) {
                (None, _) => topic.task = Some(start_producer(state, name)),
                (Some(_), Some(json)) => {
                    let _ = sender.try_send(frame(name, json));
                }
                _ => {}
            }
        }
    }
    if !theirs.is_empty() {
        tokio::spawn(relay_upstream(state.clone(), theirs, sender.clone()));
    }
    // the keep-alive comment, and the cleanup when the phone goes away (the receiver is dropped with the response)
    let guard = state.clone();
    let keepalive = sender.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                () = keepalive.closed() => break,
                () = tokio::time::sleep(KEEPALIVE) => { let _ = keepalive.try_send(Bytes::from_static(b": keep-alive\n\n")); }
            }
        }
        guard.hub.leave(id, &mine);
    });
    drop(sender);

    let stream = ReceiverStream::new(receiver).map(Ok::<Bytes, Infallible>);
    let mut response = Response::new(Body::from_stream(stream));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert("x-accel-buffering", HeaderValue::from_static("no"));
    with_security(response)
}
