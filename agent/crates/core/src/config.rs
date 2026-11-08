//! `config.json`, the same file the Node agent writes. It is kept as a JSON object (not a closed struct) so a key this agent does not know
//! yet is never lost on save; typed accessors read what the agent needs. Rules carried over from `legacy/server/src/config.js`:
//! a BOM is accepted, the previous version is kept as `config.json.bak`, the new one is written beside the file and moved in, and a file
//! that cannot be read is never overwritten (that would silently rotate the pairing token).
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{path} is not valid JSON ({reason}). Fix or delete it.{backup}")]
    Unreadable {
        path: String,
        reason: String,
        backup: String,
    },
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone)]
pub struct Config {
    file: PathBuf,
    values: Map<String, Value>,
}

/// What a fresh install starts with (the keys the interface and the API rely on).
fn defaults() -> Map<String, Value> {
    let Value::Object(map) = json!({
        "port": 7878,
        "hidden": [],
        "lan": false,
        "httpsPort": 7879,
        "ios": false,
        "iosPort": 7880,
        "iosCaPort": 7881,
        "powerControls": true,
        "miniPlayer": true,
        "notifications": { "enabled": true, "apps": ["whatsapp"] },
        "editor": true,
        "macros": [],
        "tileOrder": { "apps": [], "shortcuts": [] },
        "shortcuts": []
    }) else {
        unreachable!()
    };
    map
}

fn new_token() -> String {
    // 128 random bits as hex, from the OS (the std hasher is randomly keyed per process; two of them give 128 bits without a new dependency)
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::with_capacity(32);
    for _ in 0..2 {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        );
        out.push_str(&format!("{:016x}", hasher.finish()));
    }
    out
}

impl Config {
    /// Reads `<dir>/config.json`, fills what is missing, creates the token on the first run and writes the file back when it changed.
    pub fn load(dir: &Path) -> Result<Self, ConfigError> {
        fs::create_dir_all(dir)?;
        let file = dir.join("config.json");
        let mut stored = Map::new();
        if file.exists() {
            let text = fs::read_to_string(&file)?;
            match serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) {
                Ok(Value::Object(map)) => stored = map,
                other => {
                    let reason = match other {
                        Err(e) => e.to_string(),
                        _ => "the top level is not an object".into(),
                    };
                    let bak = file.with_extension("json.bak");
                    let backup = if bak.exists() {
                        format!(" The last saved version is kept in {}.", bak.display())
                    } else {
                        String::new()
                    };
                    return Err(ConfigError::Unreadable {
                        path: file.display().to_string(),
                        reason,
                        backup,
                    });
                }
            }
        }
        let mut values = defaults();
        for (key, value) in &stored {
            values.insert(key.clone(), value.clone());
        }
        let has_token = values
            .get("token")
            .and_then(Value::as_str)
            .is_some_and(|t| !t.is_empty());
        if !has_token {
            values.insert("token".into(), Value::String(new_token()));
        }
        let config = Self { file, values };
        let text = config.to_text();
        if !config.file.exists() || fs::read_to_string(&config.file)? != text {
            config.save_text(&text)?;
        }
        Ok(config)
    }

    fn to_text(&self) -> String {
        serde_json::to_string_pretty(&self.values).expect("a JSON object always serializes")
    }

    fn save_text(&self, text: &str) -> Result<(), ConfigError> {
        if self.file.exists() {
            fs::copy(&self.file, self.file.with_extension("json.bak"))?;
        }
        let temporary = self.file.with_extension("json.tmp");
        fs::write(&temporary, text)?;
        fs::rename(&temporary, &self.file)?;
        Ok(())
    }

    pub fn dir(&self) -> &Path {
        self.file.parent().unwrap_or(Path::new("."))
    }
    pub fn token(&self) -> &str {
        self.values
            .get("token")
            .and_then(Value::as_str)
            .unwrap_or_default()
    }
    pub fn port(&self) -> u16 {
        self.values
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|p| u16::try_from(p).ok())
            .unwrap_or(7878)
    }
    pub fn flag(&self, key: &str) -> bool {
        self.values
            .get(key)
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.values.get(key)
    }

    /// What the in-app editor may change; the token and every other key stay as they are. Nothing is written when the change is refused.
    pub fn update(&mut self, patch: &Map<String, Value>) -> Result<(), ConfigError> {
        const EDITABLE: [&str; 4] = ["shortcuts", "macros", "hidden", "tileOrder"];
        let mut next = self.values.clone();
        for key in EDITABLE {
            if let Some(value) = patch.get(key) {
                match (key, value) {
                    ("shortcuts" | "macros" | "hidden", Value::Array(_))
                    | ("tileOrder", Value::Object(_)) => {
                        next.insert(key.into(), value.clone());
                    }
                    _ => return Err(ConfigError::Invalid(format!("{key} has the wrong type"))),
                }
            }
        }
        let text = serde_json::to_string_pretty(&next).expect("a JSON object always serializes");
        self.save_text(&text)?;
        self.values = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ssd-core-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_first_run_creates_the_file_with_a_32_hex_token() {
        let dir = temp("first");
        let config = Config::load(&dir).unwrap();
        assert_eq!(config.token().len(), 32);
        assert!(config.token().bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(
            Config::load(&dir).unwrap().token(),
            config.token(),
            "the token survives a restart"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn keys_this_agent_does_not_know_survive_and_a_bom_is_accepted() {
        let dir = temp("bom");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("config.json"),
            "\u{feff}{\"token\":\"t0k\",\"port\":7000,\"somethingNew\":{\"a\":1}}",
        )
        .unwrap();
        let config = Config::load(&dir).unwrap();
        assert_eq!((config.token(), config.port()), ("t0k", 7000));
        assert!(fs::read_to_string(dir.join("config.json"))
            .unwrap()
            .contains("somethingNew"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreadable_file_is_never_overwritten() {
        let dir = temp("broken");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("config.json"), "{ nope").unwrap();
        assert!(matches!(
            Config::load(&dir),
            Err(ConfigError::Unreadable { .. })
        ));
        assert_eq!(
            fs::read_to_string(dir.join("config.json")).unwrap(),
            "{ nope"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_update_keeps_a_backup_and_refuses_the_wrong_type() {
        let dir = temp("update");
        let mut config = Config::load(&dir).unwrap();
        let token = config.token().to_owned();
        let mut patch = Map::new();
        patch.insert("hidden".into(), json!(["a1"]));
        config.update(&patch).unwrap();
        assert!(dir.join("config.json.bak").exists());
        assert_eq!(config.get("hidden"), Some(&json!(["a1"])));
        let mut bad = Map::new();
        bad.insert("macros".into(), json!("nope"));
        assert!(config.update(&bad).is_err());
        assert_eq!(Config::load(&dir).unwrap().token(), token);
        let _ = fs::remove_dir_all(&dir);
    }
}
