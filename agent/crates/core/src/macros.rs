//! What the phone's button editor may create: keyboard shortcuts and macros (a list of steps). Everything is checked against a fixed whitelist
//! before it is stored: a macro step names an app by an id from the taskbar list, a device by an id from the live list, or one of a few fixed
//! actions; there is no way to put a command line, a path or text to type in a macro: a shortcut or a "keys" step must hold Ctrl, Alt or Win (or be a
//! key that does not type, like F5 or an arrow) unless the owner set `"typingKeys": true` in `config.json` on the PC. Parity with `legacy/server/src/macros.js`.
use std::collections::HashSet;

use serde_json::{json, Map, Value};

use crate::keys;

pub const MAX_LABEL: usize = 40;
const MAX_SHORTCUTS: usize = 60;
const MAX_MACROS: usize = 40;
const MAX_STEPS: usize = 40;
const MAX_WAIT_MS: f64 = 10_000.0;
const MAX_TOTAL_WAIT_MS: f64 = 60_000.0;
const MAX_DEVICE_ID: usize = 300;

/// A refusal with the reason the person should read (the answer is a 400).
#[derive(Debug, PartialEq, Eq)]
pub struct Invalid(pub String);

fn bad<T>(message: impl Into<String>) -> Result<T, Invalid> {
    Err(Invalid(message.into()))
}

fn text(value: Option<&Value>, name: &str, max: usize) -> Result<String, Invalid> {
    let Some(Value::String(raw)) = value else {
        return bad(format!("{name} must be text"));
    };
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return bad(format!("{name} is empty"));
    }
    if collapsed.encode_utf16().count() > max {
        return bad(format!("{name} is too long"));
    }
    Ok(collapsed)
}

fn toggle(value: Option<&Value>, name: &str) -> Result<Value, Invalid> {
    match value {
        Some(v @ Value::Bool(_)) => Ok(v.clone()),
        Some(Value::String(s)) if s == "toggle" => Ok(json!("toggle")),
        _ => bad(format!("{name} must be true, false or \"toggle\"")),
    }
}

/// JavaScript's `Number(value)`.
fn number(value: Option<&Value>) -> Option<f64> {
    let n = match value? {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) if s.trim().is_empty() => 0.0,
        Value::String(s) => s.trim().parse::<f64>().ok()?,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Null => 0.0,
        _ => return None,
    };
    n.is_finite().then_some(n)
}

fn integer(value: Option<&Value>, name: &str, low: f64, high: f64) -> Result<i64, Invalid> {
    match number(value) {
        Some(n) if n.fract() == 0.0 && (low..=high).contains(&n) => Ok(n as i64),
        _ => bad(format!(
            "{name} must be a whole number from {low} to {high}"
        )),
    }
}

fn random_hex4() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos()),
    );
    format!("{:04x}", hasher.finish() & 0xffff)
}

/// "Gerenciador de tarefas" gives "gerenciador-de-tarefas" (accents dropped, at most 24 characters).
fn slug(label: &str) -> String {
    let plain: String = label
        .to_lowercase()
        .chars()
        .map(|c| match c {
            'á' | 'à' | 'â' | 'ã' | 'ä' | 'å' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ò' | 'ô' | 'õ' | 'ö' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            'ñ' => 'n',
            other => other,
        })
        .collect();
    let mut out = String::new();
    for c in plain.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').chars().take(24).collect()
}

fn new_id(prefix: &str, label: &str, taken: &HashSet<String>) -> String {
    let base = match slug(label) {
        s if s.is_empty() => prefix.to_owned(),
        s => s,
    };
    loop {
        let id = format!("{base}-{}", random_hex4());
        if !taken.contains(&id) {
            return id;
        }
    }
}

fn is_valid_id(id: &str) -> bool {
    (1..=40).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// The id the editor sent when it is usable and free, else a new one.
fn pick_id(item: &Value, taken: &HashSet<String>, prefix: &str, label: &str) -> String {
    match item.get("id").and_then(Value::as_str) {
        Some(id) if is_valid_id(id) && !taken.contains(id) => id.to_owned(),
        _ => new_id(prefix, label, taken),
    }
}

fn keys_spec(value: Option<&Value>, typing: bool) -> Result<String, Invalid> {
    let spec: String = text(value, "keys", 60)?
        .to_lowercase()
        .split_whitespace()
        .collect();
    // the person typed it: a refusal with the reason, not a server error
    keys::parse(&spec).map_err(Invalid)?;
    if !typing && keys::types_text(&spec) {
        return bad(format!(
            "\"{spec}\" types text: a letter, a digit, Enter or Space needs Ctrl, Alt or Win with it"
        ));
    }
    Ok(spec)
}

/// A list of `{ id?, label, keys }` from the editor becomes the stored list (ids kept, new ones created, order as given).
/// `typing` is the owner's `"typingKeys": true` in `config.json`: without it a key that types by itself is refused (see `keys::types_text`).
pub fn normalize_shortcuts(items: Option<&Value>, typing: bool) -> Result<Vec<Value>, Invalid> {
    let Some(Value::Array(items)) =
        items.filter(|i| i.as_array().is_some_and(|a| a.len() <= MAX_SHORTCUTS))
    else {
        return bad("invalid shortcuts list");
    };
    let mut taken = HashSet::new();
    items
        .iter()
        .map(|item| {
            let label = text(item.get("label"), "label", MAX_LABEL)?;
            let spec = keys_spec(item.get("keys"), typing)?;
            let id = pick_id(item, &taken, "atalho", &label);
            taken.insert(id.clone());
            Ok(json!({ "id": id, "label": label, "keys": spec }))
        })
        .collect()
}

fn normalize_step(step: &Value, app_ids: &HashSet<String>, typing: bool) -> Result<Value, Invalid> {
    let Value::Object(step) = step else {
        return bad("invalid step");
    };
    let app = || {
        step.get("app")
            .and_then(Value::as_str)
            .filter(|id| app_ids.contains(*id))
            .map(str::to_owned)
    };
    match step.get("type").and_then(Value::as_str) {
        Some("launch") => match app() {
            Some(app) => Ok(json!({ "type": "launch", "app": app })),
            None => bad("unknown app in a step"),
        },
        Some("keys") => Ok(json!({ "type": "keys", "keys": keys_spec(step.get("keys"), typing)? })),
        Some("media") => match step.get("key").and_then(Value::as_str) {
            Some(key @ ("prev" | "playpause" | "next")) => {
                Ok(json!({ "type": "media", "key": key }))
            }
            _ => bad("invalid media key"),
        },
        Some("volume") => Ok(
            json!({ "type": "volume", "level": integer(step.get("level"), "level", 0.0, 100.0)? }),
        ),
        Some("mute") => Ok(json!({ "type": "mute", "muted": toggle(step.get("muted"), "muted")? })),
        Some("mic") => Ok(json!({ "type": "mic", "muted": toggle(step.get("muted"), "muted")? })),
        Some("output") => {
            let device = text(step.get("device"), "device", MAX_DEVICE_ID)?;
            let name: String = step
                .get("name")
                .and_then(Value::as_str)
                .map(|n| n.trim().chars().take(80).collect())
                .unwrap_or_default();
            Ok(json!({ "type": "output", "device": device, "name": name }))
        }
        Some("place") => {
            let Some(app) = app() else {
                return bad("unknown app in a step");
            };
            let zone = match step.get("zone").and_then(Value::as_str) {
                Some(zone @ ("left" | "right" | "full")) => zone,
                _ => return bad("invalid zone"),
            };
            Ok(
                json!({ "type": "place", "app": app, "monitor": integer(step.get("monitor"), "screen", 0.0, 15.0)?, "zone": zone }),
            )
        }
        Some("wait") => Ok(
            json!({ "type": "wait", "ms": integer(step.get("ms"), "wait", 100.0, MAX_WAIT_MS)? }),
        ),
        Some("camera") => match step.get("on") {
            Some(Value::Bool(on)) => Ok(json!({ "type": "camera", "on": on })),
            _ => bad("camera must be on or off"),
        },
        _ => bad("unknown step type"),
    }
}

/// The macros from the editor, validated (apps by an id from the taskbar list).
pub fn normalize_macros(
    items: Option<&Value>,
    app_ids: &HashSet<String>,
    typing: bool,
) -> Result<Vec<Value>, Invalid> {
    let Some(Value::Array(items)) =
        items.filter(|i| i.as_array().is_some_and(|a| a.len() <= MAX_MACROS))
    else {
        return bad("invalid macros list");
    };
    let mut taken = HashSet::new();
    items
        .iter()
        .map(|item| {
            let label = text(item.get("label"), "label", MAX_LABEL)?;
            let Some(Value::Array(raw_steps)) = item.get("steps").filter(|s| {
                s.as_array()
                    .is_some_and(|a| !a.is_empty() && a.len() <= MAX_STEPS)
            }) else {
                return bad(format!("a macro needs 1 to {MAX_STEPS} steps"));
            };
            let steps = raw_steps
                .iter()
                .map(|step| normalize_step(step, app_ids, typing))
                .collect::<Result<Vec<_>, _>>()?;
            let waited: f64 = steps
                .iter()
                .filter(|s| s["type"] == "wait")
                .filter_map(|s| s["ms"].as_f64())
                .sum();
            if waited > MAX_TOTAL_WAIT_MS {
                return bad("the waits add up to more than a minute");
            }
            let id = pick_id(item, &taken, "macro", &label);
            taken.insert(id.clone());
            let page = item
                .get("page")
                .and_then(Value::as_str)
                .filter(|p| ["shortcuts", "apps"].contains(p))
                .unwrap_or("shortcuts");
            Ok(json!({ "id": id, "label": label, "page": page, "steps": steps }))
        })
        .collect()
}

/// The macros stored in the config that are usable (an id and a list of steps).
pub fn macro_list(config_macros: Option<&Value>) -> Vec<Map<String, Value>> {
    match config_macros {
        Some(Value::Array(list)) => list
            .iter()
            .filter_map(|m| m.as_object())
            .filter(|m| {
                m.get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| !id.is_empty())
                    && m.get("steps").is_some_and(Value::is_array)
            })
            .cloned()
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apps() -> HashSet<String> {
        ["a1".to_owned(), "b2".to_owned()].into()
    }

    #[test]
    fn shortcuts_keep_valid_ids_and_get_new_ones() {
        let items = json!([
            { "id": "copy", "label": "  Copiar   texto ", "keys": "Ctrl + C" },
            { "label": "Gerenciador de tarefas", "keys": "ctrl+shift+esc" },
            { "id": "copy", "label": "Outro", "keys": "alt+f4" }
        ]);
        let list = normalize_shortcuts(Some(&items), false).unwrap();
        assert_eq!(
            (
                list[0]["id"].as_str(),
                list[0]["label"].as_str(),
                list[0]["keys"].as_str()
            ),
            (Some("copy"), Some("Copiar texto"), Some("ctrl+c"))
        );
        assert!(
            list[1]["id"]
                .as_str()
                .unwrap()
                .starts_with("gerenciador-de-taref"),
            "{}",
            list[1]["id"]
        );
        assert_ne!(list[2]["id"], "copy", "a repeated id is replaced");
        assert!(is_valid_id(list[2]["id"].as_str().unwrap()));
    }

    #[test]
    fn shortcuts_are_refused_with_the_reason() {
        for (items, reason) in [
            (json!("x"), "invalid shortcuts list"),
            (json!([{ "label": "", "keys": "ctrl+c" }]), "label is empty"),
            (
                json!([{ "label": 5, "keys": "ctrl+c" }]),
                "label must be text",
            ),
            (
                json!([{ "label": "x", "keys": "ctrl+nope" }]),
                "unknown key \"nope\"",
            ),
            (
                json!([{ "label": "x".repeat(41), "keys": "ctrl+c" }]),
                "label is too long",
            ),
            (
                Value::Array(vec![json!({ "label": "x", "keys": "a" }); 61]),
                "invalid shortcuts list",
            ),
        ] {
            assert_eq!(
                normalize_shortcuts(Some(&items), false).unwrap_err(),
                Invalid(reason.into()),
                "{items}"
            );
        }
    }

    #[test]
    fn a_macro_is_a_list_of_whitelisted_steps() {
        let items = json!([{ "label": "Jogar", "page": "apps", "steps": [
            { "type": "launch", "app": "a1" }, { "type": "volume", "level": "30" }, { "type": "mute", "muted": "toggle" },
            { "type": "output", "device": "{0.0.0}.{x}", "name": " Fones " }, { "type": "place", "app": "b2", "monitor": 1, "zone": "left" },
            { "type": "wait", "ms": 500 }, { "type": "camera", "on": true }, { "type": "media", "key": "next" }, { "type": "keys", "keys": "WIN + D" }
        ] }]);
        let macros = normalize_macros(Some(&items), &apps(), false).unwrap();
        assert_eq!(macros[0]["page"], "apps");
        assert_eq!(
            macros[0]["steps"][1],
            json!({ "type": "volume", "level": 30 })
        );
        assert_eq!(
            macros[0]["steps"][3],
            json!({ "type": "output", "device": "{0.0.0}.{x}", "name": "Fones" })
        );
        assert_eq!(
            macros[0]["steps"][8],
            json!({ "type": "keys", "keys": "win+d" })
        );
    }

    #[test]
    fn a_macro_cannot_run_anything_else() {
        let one = |step: Value| {
            normalize_macros(
                Some(&json!([{ "label": "m", "steps": [step] }])),
                &apps(),
                false,
            )
            .unwrap_err()
            .0
        };
        assert_eq!(
            one(json!({ "type": "launch", "app": "../evil.exe" })),
            "unknown app in a step"
        );
        assert_eq!(
            one(json!({ "type": "run", "command": "calc" })),
            "unknown step type"
        );
        assert_eq!(
            one(json!({ "type": "media", "key": "explode" })),
            "invalid media key"
        );
        assert_eq!(
            one(json!({ "type": "volume", "level": 101 })),
            "level must be a whole number from 0 to 100"
        );
        assert_eq!(
            one(json!({ "type": "place", "app": "a1", "monitor": 1, "zone": "top" })),
            "invalid zone"
        );
        assert_eq!(
            one(json!({ "type": "wait", "ms": 99 })),
            "wait must be a whole number from 100 to 10000"
        );
        assert_eq!(
            one(json!({ "type": "camera", "on": "yes" })),
            "camera must be on or off"
        );
        assert_eq!(one(json!("nope")), "invalid step");
        let empty = normalize_macros(
            Some(&json!([{ "label": "m", "steps": [] }])),
            &apps(),
            false,
        )
        .unwrap_err()
        .0;
        assert_eq!(empty, "a macro needs 1 to 40 steps");
        let long_wait =
            json!([{ "label": "m", "steps": vec![json!({ "type": "wait", "ms": 10000 }); 7] }]);
        assert_eq!(
            normalize_macros(Some(&long_wait), &apps(), false)
                .unwrap_err()
                .0,
            "the waits add up to more than a minute"
        );
    }

    #[test]
    fn slugs_drop_accents_and_symbols() {
        assert_eq!(slug("Área de trabalho"), "area-de-trabalho");
        assert_eq!(slug("  !! "), "");
        assert_eq!(
            slug("A very long label that goes past the limit"),
            "a-very-long-label-that-g"
        );
    }

    #[test]
    fn the_stored_macro_list_skips_broken_entries() {
        let stored = json!([{ "id": "ok", "label": "x", "steps": [] }, { "label": "no id", "steps": [] }, { "id": "no-steps" }, 5]);
        assert_eq!(macro_list(Some(&stored)).len(), 1);
    }

    #[test]
    fn a_key_that_types_is_refused_unless_the_owner_allowed_it() {
        // win+r, then c, m, d, enter would be a command line typed from the phone
        for keys in ["c", "enter", "shift+a", "space"] {
            let shortcut = json!([{ "label": "x", "keys": keys }]);
            assert!(
                normalize_shortcuts(Some(&shortcut), false)
                    .unwrap_err()
                    .0
                    .contains("types text"),
                "{keys}"
            );
            assert!(normalize_shortcuts(Some(&shortcut), true).is_ok(), "{keys}");
            let step = json!([{ "label": "m", "steps": [{ "type": "keys", "keys": keys }] }]);
            assert!(
                normalize_macros(Some(&step), &apps(), false).is_err(),
                "{keys}"
            );
            assert!(
                normalize_macros(Some(&step), &apps(), true).is_ok(),
                "{keys}"
            );
        }
        let fine = json!([{ "label": "x", "keys": "win+r" }, { "label": "y", "keys": "f5" }, { "label": "z", "keys": "left" }]);
        assert!(normalize_shortcuts(Some(&fine), false).is_ok());
    }
}
