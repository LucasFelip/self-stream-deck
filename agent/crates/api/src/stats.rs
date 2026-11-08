//! `GET /api/requests`: how often each route is used, for judging what the phone costs.
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::http::Method;
use serde_json::{json, Map, Value};

/// "2026-11-08T21:30:00.000Z" without a date crate (civil-from-days, Howard Hinnant's algorithm).
pub fn iso_now() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let (days, rest) = ((now.as_secs() / 86_400) as i64, now.as_secs() % 86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60,
        now.subsec_millis()
    )
}

/// `/api/media/art/0123456789ab` counts as `/api/media/art/:id`, so one route is one line.
fn route_key(path: &str, is_static: bool) -> String {
    if is_static {
        return "static".into();
    }
    match path.rsplit_once('/') {
        Some((head, last))
            if last.len() >= 8
                && last
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) =>
        {
            format!("{head}/:id")
        }
        _ => path.to_owned(),
    }
}

pub fn count(counts: &Mutex<HashMap<String, u64>>, method: &Method, path: &str, is_static: bool) {
    *counts
        .lock()
        .unwrap()
        .entry(format!("{method} {}", route_key(path, is_static)))
        .or_insert(0) += 1;
}

pub fn report(counts: &Mutex<HashMap<String, u64>>, since: &str) -> Value {
    let mut entries: Vec<(String, u64)> = counts
        .lock()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), *v))
        .collect();
    entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let counts: Map<String, Value> = entries.into_iter().map(|(k, v)| (k, json!(v))).collect();
    json!({ "since": since, "counts": counts })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_clock_is_iso_8601() {
        let now = iso_now();
        assert_eq!(now.len(), 24);
        assert!(
            now.starts_with("20") && now.ends_with('Z') && now.as_bytes()[10] == b'T',
            "{now}"
        );
    }

    #[test]
    fn ids_are_folded_and_static_files_count_as_one() {
        assert_eq!(route_key("/api/icon/0123456789", false), "/api/icon/:id");
        assert_eq!(route_key("/api/state", false), "/api/state");
        assert_eq!(route_key("/assets/index-abc.js", true), "static");
    }
}
