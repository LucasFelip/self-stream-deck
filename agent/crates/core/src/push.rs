//! What scripts, CI and home automation push into the panel through the webhooks (ADR 0010): values with an optional time to live, and a short
//! queue of events for the phone (a notice, a page switch, a reload). No clock and no socket in here: the caller passes `now` (unix ms), so
//! everything is tested without waiting. Values survive a restart (`data.json` beside `config.json`); events do not.
use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::path::PathBuf;

use serde_json::{json, Value};

/// How many values the store holds; one more is refused until something is removed or expires.
pub const MAX_ITEMS: usize = 200;
/// How many events wait for a phone that is late; older ones are dropped.
pub const MAX_EVENTS: usize = 50;
/// The longest time to live of a value (30 days); a longer one is cut to it.
pub const MAX_TTL_SEC: u64 = 30 * 24 * 3600;

#[derive(Debug, thiserror::Error)]
pub enum PushError {
    #[error("the key must be 1-64 characters: letters, digits, '.', '_' or '-'")]
    BadKey,
    #[error("too many values (at most {MAX_ITEMS}); delete some first")]
    TooMany,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// A key of a value: 1 to 64 characters of `A-Z a-z 0-9 . _ -`.
pub fn valid_key(key: &str) -> bool {
    (1..=64).contains(&key.len())
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// A page a `goto` may name: 1 to 32 characters of `a-z`, `0-9` and `-`.
pub fn valid_page(page: &str) -> bool {
    (1..=32).contains(&page.len())
        && page
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub data: Value,
    /// unix ms of the last write
    pub at: u64,
    /// unix ms after which the value is gone; `None` keeps it until it is removed
    pub expires_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub seq: u64,
    /// `notify`, `goto` or `refresh`
    pub kind: String,
    pub data: Value,
    pub at: u64,
}

#[derive(Debug, Default)]
pub struct PushStore {
    items: BTreeMap<String, Item>,
    events: VecDeque<Event>,
    seq: u64,
    version: u64,
    file: Option<PathBuf>,
}

impl PushStore {
    /// A store that keeps its values in `file`. A file that cannot be read starts an empty store (the values are a cache of what the senders
    /// push again, not something to lose the pairing over).
    pub fn load(file: PathBuf) -> Self {
        let mut store = Self {
            file: Some(file.clone()),
            ..Self::default()
        };
        let stored = fs::read_to_string(&file).ok().and_then(|text| {
            serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')).ok()
        });
        if let Some(Value::Object(map)) = stored {
            for (key, value) in map {
                let at = value.get("at").and_then(Value::as_u64).unwrap_or(0);
                let expires_at = value.get("expiresAt").and_then(Value::as_u64);
                if valid_key(&key) && store.items.len() < MAX_ITEMS {
                    let data = value.get("data").cloned().unwrap_or(Value::Null);
                    store.items.insert(
                        key,
                        Item {
                            data,
                            at,
                            expires_at,
                        },
                    );
                }
            }
        }
        store
    }

    /// Changes whenever a value is set, removed or expires; the phone refetches the values when it changes.
    pub fn version(&self) -> u64 {
        self.version
    }

    /// The number of the last event, so a phone that has just started does not replay what happened before.
    pub fn seq(&self) -> u64 {
        self.seq
    }

    fn purge(&mut self, now: u64) {
        let before = self.items.len();
        self.items
            .retain(|_, item| item.expires_at.is_none_or(|end| end > now));
        if self.items.len() != before {
            self.version += 1;
        }
    }

    /// Stores a value. `ttl_sec` of `None` or `0` keeps it until it is removed; an overwrite never counts against the limit.
    pub fn set(
        &mut self,
        key: &str,
        data: Value,
        ttl_sec: Option<u64>,
        now: u64,
    ) -> Result<(), PushError> {
        if !valid_key(key) {
            return Err(PushError::BadKey);
        }
        self.purge(now);
        if !self.items.contains_key(key) && self.items.len() >= MAX_ITEMS {
            return Err(PushError::TooMany);
        }
        let expires_at = ttl_sec
            .filter(|ttl| *ttl > 0)
            .map(|ttl| now + ttl.min(MAX_TTL_SEC) * 1000);
        self.items.insert(
            key.to_owned(),
            Item {
                data,
                at: now,
                expires_at,
            },
        );
        self.version += 1;
        Ok(())
    }

    /// Removes a value; `false` when there was none.
    pub fn remove(&mut self, key: &str, now: u64) -> bool {
        self.purge(now);
        let found = self.items.remove(key).is_some();
        if found {
            self.version += 1;
        }
        found
    }

    pub fn get(&mut self, key: &str, now: u64) -> Option<Item> {
        self.purge(now);
        self.items.get(key).cloned()
    }

    /// The values now and the version they belong to: what the `push` topic and `GET /api/hook/push` carry.
    pub fn to_json(&mut self, now: u64) -> Value {
        self.purge(now);
        let values: serde_json::Map<String, Value> = self
            .items
            .iter()
            .map(|(key, item)| {
                (
                    key.clone(),
                    json!({ "data": item.data, "at": item.at, "expiresAt": item.expires_at }),
                )
            })
            .collect();
        json!({ "values": values, "version": self.version })
    }

    /// Queues an event for the phones and returns its number.
    pub fn push_event(&mut self, kind: &str, data: Value, now: u64) -> u64 {
        self.seq += 1;
        self.events.push_back(Event {
            seq: self.seq,
            kind: kind.to_owned(),
            data,
            at: now,
        });
        while self.events.len() > MAX_EVENTS {
            self.events.pop_front();
        }
        self.seq
    }

    /// The queued events and the number of the last one: what the `panel` topic carries.
    pub fn events_json(&self) -> Value {
        let events: Vec<Value> = self
            .events
            .iter()
            .map(|e| json!({ "seq": e.seq, "kind": e.kind, "data": e.data, "at": e.at }))
            .collect();
        json!({ "seq": self.seq, "events": events })
    }

    /// Writes the values to the file (beside the new one, then renamed, like `config.json`). A store without a file writes nothing.
    pub fn persist(&self) -> Result<(), PushError> {
        let Some(file) = &self.file else {
            return Ok(());
        };
        let map: serde_json::Map<String, Value> = self
            .items
            .iter()
            .map(|(key, item)| {
                (
                    key.clone(),
                    json!({ "data": item.data, "at": item.at, "expiresAt": item.expires_at }),
                )
            })
            .collect();
        let text = serde_json::to_string(&Value::Object(map)).expect("a JSON object serializes");
        let temporary = file.with_extension("json.tmp");
        fs::write(&temporary, text)?;
        fs::rename(&temporary, file)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_000_000;

    #[test]
    fn keys_are_short_and_plain() {
        for ok in ["a", "temp.cpu", "ci_build-1", &"x".repeat(64)] {
            assert!(valid_key(ok), "{ok}");
        }
        for bad in ["", "a b", "a/b", "ação", &"x".repeat(65), "../x"] {
            assert!(!valid_key(bad), "{bad}");
        }
    }

    #[test]
    fn a_page_is_a_short_plain_name() {
        for ok in ["pc", "shortcuts-1", &"a".repeat(32)] {
            assert!(valid_page(ok), "{ok}");
        }
        for bad in ["", "Pc", "a b", "a/b", &"a".repeat(33)] {
            assert!(!valid_page(bad), "{bad}");
        }
    }

    #[test]
    fn a_value_expires_and_the_version_moves_each_time() {
        let mut store = PushStore::default();
        let v0 = store.version();
        store.set("a", json!(1), Some(10), T0).unwrap();
        assert!(store.version() > v0);
        assert!(store.get("a", T0 + 9_999).is_some());
        let before = store.version();
        assert!(store.get("a", T0 + 10_000).is_none());
        assert!(store.version() > before, "an expiry is a change");
    }

    #[test]
    fn a_zero_or_missing_ttl_keeps_the_value_and_a_huge_one_is_cut() {
        let mut store = PushStore::default();
        store.set("keep", json!(1), None, T0).unwrap();
        store.set("zero", json!(1), Some(0), T0).unwrap();
        store
            .set("long", json!(1), Some(u64::MAX / 2000), T0)
            .unwrap();
        assert_eq!(store.get("keep", T0).unwrap().expires_at, None);
        assert_eq!(store.get("zero", T0).unwrap().expires_at, None);
        assert_eq!(
            store.get("long", T0).unwrap().expires_at,
            Some(T0 + MAX_TTL_SEC * 1000)
        );
    }

    #[test]
    fn the_limit_counts_new_keys_only_and_an_expired_value_makes_room() {
        let mut store = PushStore::default();
        for n in 0..MAX_ITEMS {
            store.set(&format!("k{n}"), json!(n), Some(5), T0).unwrap();
        }
        assert!(matches!(
            store.set("extra", json!(0), None, T0),
            Err(PushError::TooMany)
        ));
        store.set("k0", json!("again"), None, T0).unwrap();
        store.set("extra", json!(0), None, T0 + 6_000).unwrap();
    }

    #[test]
    fn a_bad_key_is_refused_and_remove_says_whether_it_found_one() {
        let mut store = PushStore::default();
        assert!(matches!(
            store.set("no way", json!(1), None, T0),
            Err(PushError::BadKey)
        ));
        store.set("a", json!(1), None, T0).unwrap();
        assert!(store.remove("a", T0));
        assert!(!store.remove("a", T0));
    }

    #[test]
    fn events_are_numbered_and_only_the_last_ones_are_kept() {
        let mut store = PushStore::default();
        assert_eq!(store.seq(), 0);
        for n in 0..(MAX_EVENTS + 5) {
            store.push_event("notify", json!({ "n": n }), T0);
        }
        let json = store.events_json();
        let events = json["events"].as_array().unwrap();
        assert_eq!(events.len(), MAX_EVENTS);
        assert_eq!(json["seq"], (MAX_EVENTS + 5) as u64);
        assert_eq!(events[0]["seq"], 6);
    }

    #[test]
    fn values_survive_a_restart_but_events_do_not() {
        let dir = std::env::temp_dir().join(format!("ssd-push-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("data.json");
        let mut store = PushStore::load(file.clone());
        store.set("temp", json!({ "c": 21.5 }), None, T0).unwrap();
        store.push_event("notify", json!({ "text": "x" }), T0);
        store.persist().unwrap();
        let mut again = PushStore::load(file.clone());
        assert_eq!(again.get("temp", T0).unwrap().data, json!({ "c": 21.5 }));
        assert_eq!(again.seq(), 0);
        fs::write(&file, "{ not json").unwrap();
        assert!(PushStore::load(file).to_json(T0)["values"]
            .as_object()
            .unwrap()
            .is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
