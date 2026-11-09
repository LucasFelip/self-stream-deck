//! Where the agent keeps its files, and how an older install's files come along. An installed agent keeps everything in
//! `%APPDATA%\SelfStreamDeck\` (the config with the pairing token, the certificates the phones pin, the icons, the log); the first run there
//! copies what an earlier install had, so a phone that was paired keeps working and the token never changes.
use std::path::{Path, PathBuf};

/// `%APPDATA%\SelfStreamDeck`, or `data` next to the working directory when there is no `APPDATA`.
pub fn default_dir() -> PathBuf {
    std::env::var_os("APPDATA").map_or_else(
        || PathBuf::from("data"),
        |appdata| PathBuf::from(appdata).join("SelfStreamDeck"),
    )
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Copies an earlier install's pairing token, config and certificates into `to` when `to` has no config yet. Returns what was copied.
/// The icons and the apps list are made again by the agent; the virtual camera is installed again from the app (its registration names
/// the folder it was installed from).
pub fn migrate(from: &Path, to: &Path) -> std::io::Result<Vec<&'static str>> {
    let mut copied = Vec::new();
    if to.join("config.json").exists() || !from.join("config.json").exists() {
        return Ok(copied);
    }
    std::fs::create_dir_all(to)?;
    std::fs::copy(from.join("config.json"), to.join("config.json"))?;
    copied.push("config.json");
    if from.join("tls").is_dir() {
        copy_dir(&from.join("tls"), &to.join("tls"))?;
        copied.push("tls");
    }
    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ssd-data-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn the_token_and_the_certificates_come_along_once() {
        let (old, new) = (temp("old"), temp("new"));
        std::fs::create_dir_all(old.join("tls").join("ios")).unwrap();
        std::fs::write(old.join("config.json"), r#"{"token":"abc"}"#).unwrap();
        std::fs::write(old.join("tls").join("server.cer"), "cer").unwrap();
        std::fs::write(old.join("tls").join("ios").join("ca.cer"), "ca").unwrap();
        std::fs::write(old.join("server.log"), "log").unwrap();
        assert_eq!(migrate(&old, &new).unwrap(), ["config.json", "tls"]);
        assert_eq!(
            std::fs::read_to_string(new.join("config.json")).unwrap(),
            r#"{"token":"abc"}"#
        );
        assert_eq!(
            std::fs::read_to_string(new.join("tls").join("ios").join("ca.cer")).unwrap(),
            "ca"
        );
        assert!(!new.join("server.log").exists());
        // a second run leaves what is there alone (the new token may already have been changed)
        std::fs::write(new.join("config.json"), r#"{"token":"new"}"#).unwrap();
        assert!(migrate(&old, &new).unwrap().is_empty());
        assert_eq!(
            std::fs::read_to_string(new.join("config.json")).unwrap(),
            r#"{"token":"new"}"#
        );
        for dir in [&old, &new] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn nothing_to_migrate_is_fine() {
        let (old, new) = (temp("none-old"), temp("none-new"));
        assert!(migrate(&old, &new).unwrap().is_empty());
        assert!(!new.exists(), "nothing is created for nothing");
    }
}
