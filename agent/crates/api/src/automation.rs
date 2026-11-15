//! Runs the automation rules (ADR 0011): a step a second reads what the rules ask about the PC (only that), lets `ssd_core::rules::Engine`
//! decide, and carries the effects out on the panel: a page switch, a notice, a value. Nothing here acts on the PC. With no rule on, a step
//! reads nothing. `GET /api/rules` says where the rules stand and `POST /api/rules/pause` stops them for a while.
#![allow(clippy::result_large_err)] // the Err of a route step is the whole HTTP answer to send
use ssd_core::sync::Locked;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};
use ssd_core::rules::{self, Condition, Engine, Facts, Rule, MAX_PAUSE_MIN};

use crate::hooks::{now_ms, persist};
use crate::routes::{error, not_found, Call};
use crate::{json, AppState};

/// How long a CPU reading is reused (the sample of the PC is not free).
const CPU_EVERY_MS: u64 = 2000;

#[derive(Default)]
pub struct Runtime {
    engine: Engine,
    /// the `rules` key of `config.json` as it was when the rules were last read
    source: String,
    rules: Vec<Rule>,
    error: Option<String>,
    /// the notifications already seen (`id|time`); `None` before the first look, so what was waiting is not news
    seen: Option<HashSet<String>>,
    cpu: Option<(u64, f64)>,
}

pub(crate) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/rules", get(status).fallback(not_found))
        .route("/api/rules/pause", post(pause).fallback(not_found))
}

pub(crate) fn spawn(state: Arc<AppState>) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            tick(&state, now_ms()).await;
        }
    });
}

fn wants(rules: &[Rule], what: fn(&Condition) -> bool) -> bool {
    rules.iter().any(|rule| what(&rule.when))
}

/// Re-reads `rules` from the config when it changed; an invalid list is refused as a whole and said once in the log.
fn load(state: &AppState) -> Vec<Rule> {
    let value = state
        .config
        .locked()
        .get("rules")
        .cloned()
        .unwrap_or(Value::Array(Vec::new()));
    let source = value.to_string();
    let mut runtime = state.rules.locked();
    if runtime.source != source {
        match rules::parse(&value) {
            Ok(list) => {
                runtime.rules = list;
                runtime.error = None;
            }
            Err(problem) => {
                tracing::warn!("{problem}");
                runtime.rules = Vec::new();
                runtime.error = Some(problem.to_string());
            }
        }
        runtime.source = source;
    }
    runtime.rules.clone()
}

/// What the rules ask about the PC right now; what no rule asks about is not read.
async fn gather(state: &Arc<AppState>, rules: &[Rule], now: u64) -> Facts {
    let mut facts = Facts::default();
    if wants(rules, |c| matches!(c, Condition::CpuAbove(_))) {
        let cached = state
            .rules
            .locked()
            .cpu
            .filter(|(at, _)| now.saturating_sub(*at) < CPU_EVERY_MS);
        facts.cpu = match (cached, state.platform.monitor.clone()) {
            (Some((_, usage)), _) => Some(usage),
            (None, Some(monitor)) => {
                let sample = tokio::task::spawn_blocking(move || monitor.sample())
                    .await
                    .ok()
                    .and_then(Result::ok);
                let usage = sample.and_then(|s| s["cpu"]["usage"].as_f64());
                if let Some(usage) = usage {
                    state.rules.locked().cpu = Some((now, usage));
                }
                usage
            }
            (None, None) => None,
        };
    }
    if wants(rules, |c| matches!(c, Condition::MediaPlaying)) {
        if let Some(media) = state.platform.media.clone() {
            let current = tokio::task::spawn_blocking(move || media.state())
                .await
                .ok()
                .and_then(Result::ok);
            facts.media_playing = current
                .is_some_and(|s| s.sessions.iter().any(|session| session.status == "playing"));
        }
    }
    if wants(rules, |c| matches!(c, Condition::WindowTitleContains(_))) {
        if let Some(windows) = state.platform.windows.clone() {
            let snapshot = tokio::task::spawn_blocking(move || windows.snapshot())
                .await
                .ok()
                .and_then(Result::ok);
            facts.window_titles = snapshot
                .map(|s| s.windows.iter().map(|w| w.title.to_lowercase()).collect())
                .unwrap_or_default();
        }
    }
    if wants(rules, |c| matches!(c, Condition::NotificationFrom(_))) {
        if let Some(port) = state.platform.notifications.clone() {
            let listing = tokio::task::spawn_blocking(move || port.list())
                .await
                .ok()
                .and_then(Result::ok);
            if let Some(listing) = listing {
                let items = listing["notifications"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                let key = |item: &Value| format!("{}|{}", item["id"], item["time"]);
                let mut runtime = state.rules.locked();
                if let Some(seen) = &runtime.seen {
                    for item in items.iter().filter(|item| !seen.contains(&key(item))) {
                        for field in ["app", "aumid"] {
                            if let Some(name) = item[field].as_str() {
                                facts.notified_apps.push(name.to_lowercase());
                            }
                        }
                    }
                }
                runtime.seen = Some(items.iter().map(key).collect());
            }
        }
    }
    facts.minute = state
        .platform
        .clock
        .as_ref()
        .map_or_else(utc_minute, |c| c.minute_of_day());
    facts
}

/// Without a clock port the time windows follow UTC rather than not working.
fn utc_minute() -> u16 {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    u16::try_from(seconds / 60 % 1440).unwrap_or(0)
}

/// Carries one effect out: an event for the phones, or a value kept (or removed).
fn apply(state: &AppState, effects: &[rules::Effect], now: u64) {
    for effect in effects {
        let Some((kind, data)) = effect.describe() else {
            continue;
        };
        match kind {
            "push" => {
                let key = data["key"].as_str().unwrap_or_default();
                let result =
                    state
                        .push
                        .locked()
                        .set(key, data["value"].clone(), data["ttl"].as_u64(), now);
                match result {
                    Ok(()) => persist(state),
                    Err(problem) => tracing::warn!("rule: {problem}"),
                }
            }
            "unpush" => {
                let key = data["key"].as_str().unwrap_or_default();
                if state.push.locked().remove(key, now) {
                    persist(state);
                }
            }
            other => {
                state.push.locked().push_event(other, data, now);
            }
        }
    }
}

/// One step of the rules.
pub(crate) async fn tick(state: &Arc<AppState>, now: u64) {
    let rules = load(state);
    let facts = if rules.is_empty() {
        Facts::default()
    } else {
        gather(state, &rules, now).await
    };
    let effects = state.rules.locked().engine.step(&rules, &facts, now);
    if !effects.is_empty() {
        for effect in &effects {
            if let rules::Effect::Run { rule, .. } = effect {
                tracing::info!(target: "audit", rule, "rule fired");
            }
        }
        apply(state, &effects, now);
    }
}

/// `GET /api/rules`
async fn status(call: Call) -> Response {
    let state = &call.state;
    let _ = load(state);
    let runtime = state.rules.locked();
    let ids: Vec<&str> = runtime.rules.iter().map(|r| r.id.as_str()).collect();
    json(
        StatusCode::OK,
        json!({
            "rules": ids,
            "active": runtime.engine.active(),
            "pausedUntil": runtime.engine.paused_until(now_ms()),
            "error": runtime.error,
        }),
    )
}

/// `POST /api/rules/pause` with `{ "minutes": 0..1440 }`: 0 resumes.
async fn pause(call: Call) -> Response {
    let minutes = serde_json::from_slice::<Value>(&call.body)
        .ok()
        .and_then(|body| body["minutes"].as_u64())
        .filter(|m| *m <= MAX_PAUSE_MIN);
    let Some(minutes) = minutes else {
        return error(
            StatusCode::BAD_REQUEST,
            "minutes is a whole number from 0 to 1440 (0 resumes the rules)",
        );
    };
    let now = now_ms();
    let mut runtime = call.state.rules.locked();
    runtime.engine.pause(minutes, now);
    json(
        StatusCode::OK,
        json!({ "ok": true, "pausedUntil": runtime.engine.paused_until(now) }),
    )
}
