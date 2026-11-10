//! Updates: `ssd update` looks for a newer version, `ssd update --apply` downloads it and installs it, and with `"update": { "auto": true }`
//! the agent does that by itself (a check a minute after it starts, then once a day).
//!
//! Nothing is contacted until `update.url` is set in `config.json`: there is no default server. The address is a small JSON file:
//!
//! ```json
//! { "channels": { "stable": { "version": "0.2.0", "url": "https://example.com/SelfStreamDeck-0.2.0.msi", "sha256": "<64 hex digits>" },
//!                 "test":   { "version": "0.3.0-rc1", "url": "...", "sha256": "..." } } }
//! ```
//!
//! What is checked before anything is installed, in this order: the manifest and the package come over HTTPS (plain HTTP only to this PC,
//! for tests); the version is newer; the package has the size and SHA-256 the manifest says; and the package is **signed by the same
//! certificate as the agent that is running** (or by the thumbprint in `update.signer`). A manifest on a hacked server can therefore not
//! make the agent install anything its owner did not sign; an agent that is not signed and has no `update.signer` refuses to update.
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;
use ssd_core::config::Config;
use ssd_core::sha256::sha256_hex;

const MANIFEST_LIMIT: u64 = 64 * 1024;
const PACKAGE_LIMIT: u64 = 200 * 1024 * 1024;

/// What `config.json` says under `"update"`.
#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub url: Option<String>,
    pub channel: String,
    pub auto: bool,
    pub signer: Option<String>,
}

impl Settings {
    pub fn from_config(config: &Config) -> Self {
        let section = config.get("update").and_then(Value::as_object);
        let text = |key: &str| {
            section
                .and_then(|o| o.get(key))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        };
        Settings {
            url: text("url"),
            channel: text("channel").unwrap_or_else(|| "stable".into()),
            auto: section
                .and_then(|o| o.get("auto"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
            signer: text("signer").map(|s| s.replace(' ', "").to_uppercase()),
        }
    }
}

/// A version of the program that can be installed.
#[derive(Debug, Clone, PartialEq)]
pub struct Release {
    pub version: String,
    pub url: String,
    pub sha256: String,
}

/// `1.2.3` or `1.2.3-rc1` → the three numbers (a suffix makes it older than the plain version, see `is_newer`).
fn parse_version(text: &str) -> Option<([u64; 3], bool)> {
    let (numbers, suffix) = match text.split_once('-') {
        Some((n, _)) => (n, true),
        None => (text, false),
    };
    let mut parts = numbers.split('.');
    let mut out = [0u64; 3];
    for slot in &mut out {
        *slot = parts.next()?.parse().ok()?;
    }
    if parts.next().is_some() {
        return None;
    }
    Some((out, suffix))
}

/// Is `candidate` a newer version than `current`? A pre-release (`0.2.0-rc1`) is older than `0.2.0` and newer than `0.1.9`.
pub fn is_newer(current: &str, candidate: &str) -> bool {
    match (parse_version(current), parse_version(candidate)) {
        (Some((a, a_pre)), Some((b, b_pre))) => (b, !b_pre) > (a, !a_pre),
        _ => false,
    }
}

fn is_loopback_http(url: &str) -> bool {
    ["http://127.0.0.1", "http://localhost", "http://[::1]"]
        .iter()
        .any(|prefix| {
            url.strip_prefix(prefix).is_some_and(|rest| {
                rest.is_empty() || rest.starts_with(':') || rest.starts_with('/')
            })
        })
}

fn check_url(url: &str, what: &str) -> Result<(), String> {
    if url.starts_with("https://") || is_loopback_http(url) {
        if url.contains(char::is_whitespace) || url.contains('"') {
            return Err(format!(
                "{what}: the address has characters that do not belong in one"
            ));
        }
        Ok(())
    } else {
        Err(format!(
            "{what}: only https:// addresses are accepted (plain http only to this PC)"
        ))
    }
}

/// The release of `channel` in a manifest, validated.
pub fn pick_release(manifest: &Value, channel: &str) -> Result<Release, String> {
    let entry = manifest
        .get("channels")
        .and_then(|c| c.get(channel))
        .ok_or_else(|| format!("the manifest has no channel \"{channel}\""))?;
    let field = |key: &str| {
        entry
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| format!("channel \"{channel}\": \"{key}\" is missing"))
    };
    let version = field("version")?;
    if parse_version(&version).is_none() {
        return Err(format!(
            "channel \"{channel}\": \"{version}\" is not a version (1.2.3 or 1.2.3-rc1)"
        ));
    }
    let url = field("url")?;
    check_url(&url, &format!("channel \"{channel}\""))?;
    let sha256 = field("sha256")?.to_lowercase();
    if sha256.len() != 64 || !sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!(
            "channel \"{channel}\": sha256 must be 64 hex digits"
        ));
    }
    Ok(Release {
        version,
        url,
        sha256,
    })
}

/// Which signer an update must carry: the configured one, else the one of the running agent.
pub fn expected_signer(configured: Option<&str>, own: Option<&str>) -> Result<String, String> {
    configured
        .or(own)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "this agent is not signed and no \"update.signer\" (a certificate thumbprint) is set, so there is nothing to check an update against".to_owned())
}

#[cfg(windows)]
fn no_window(command: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000)
}
#[cfg(not(windows))]
fn no_window(command: &mut Command) -> &mut Command {
    command
}

/// Downloads `url` into `dest` with curl.exe (it ships with Windows 10 and later and checks the site's certificate).
fn fetch(url: &str, dest: &Path, limit: u64) -> Result<(), String> {
    check_url(url, "download")?;
    let protocol = if url.starts_with("https://") {
        "=https"
    } else {
        "=http"
    };
    let mut command = Command::new("curl.exe");
    no_window(&mut command)
        .args([
            "--fail",
            "--silent",
            "--show-error",
            "--location",
            "--max-redirs",
            "3",
        ])
        .args(["--proto", protocol, "--proto-redir", "=https"])
        .args([
            "--max-filesize",
            &limit.to_string(),
            "--max-time",
            "600",
            "--output",
        ])
        .arg(dest)
        .arg(url);
    let output = command
        .output()
        .map_err(|e| format!("could not run curl.exe: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "download failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

/// `(status, thumbprint)` of the Authenticode signature of a file ("NotSigned" and "" when it has none).
fn signature(file: &Path) -> Result<(String, String), String> {
    let path = file.to_string_lossy();
    if path.contains('\'') {
        return Err("the path of the file has a quote in it".into());
    }
    let script = format!(
        "$s = Get-AuthenticodeSignature -LiteralPath '{path}'; \"$($s.Status)|$($s.SignerCertificate.Thumbprint)\""
    );
    let mut command = Command::new("powershell.exe");
    no_window(&mut command).args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    let output = command
        .output()
        .map_err(|e| format!("could not run powershell.exe: {e}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.trim();
    let (status, thumbprint) = line.split_once('|').unwrap_or((line, ""));
    Ok((status.to_owned(), thumbprint.trim().to_uppercase()))
}

/// A signature counts when the file was not altered after signing ("Valid", or "UnknownError" when the root is a self-signed certificate
/// that Windows does not trust, which is the case of a build signed with `sign.ps1` without a certificate authority) and the signer is the expected one.
pub fn signature_ok(status: &str, thumbprint: &str, expected: &str) -> Result<(), String> {
    if !matches!(status, "Valid" | "UnknownError") {
        return Err(format!(
            "the signature of the package is not good ({status})"
        ));
    }
    if thumbprint != expected {
        return Err(format!(
            "the package is signed by {thumbprint}, not by {expected}"
        ));
    }
    Ok(())
}

fn work_dir() -> PathBuf {
    std::env::temp_dir().join("ssd-update")
}

/// Asks the manifest for the release of the channel. `None` when this version is the newest.
pub fn check(
    settings: &Settings,
    current: &str,
    url_override: Option<&str>,
) -> Result<Option<Release>, String> {
    let url = url_override
        .map(str::to_owned)
        .or_else(|| settings.url.clone())
        .ok_or("no update address: set \"update\": { \"url\": \"https://…/manifest.json\" } in config.json")?;
    check_url(&url, "update.url")?;
    let dir = work_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("manifest.json");
    let _ = std::fs::remove_file(&file);
    fetch(&url, &file, MANIFEST_LIMIT)?;
    let text = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let manifest: Value =
        serde_json::from_str(&text).map_err(|e| format!("the manifest is not JSON: {e}"))?;
    let release = pick_release(&manifest, &settings.channel)?;
    Ok(is_newer(current, &release.version).then_some(release))
}

/// Downloads the package and runs every check. Returns the file that is safe to install.
pub fn download_and_verify(settings: &Settings, release: &Release) -> Result<PathBuf, String> {
    let dir = work_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("SelfStreamDeck-{}.msi", release.version));
    let _ = std::fs::remove_file(&file);
    fetch(&release.url, &file, PACKAGE_LIMIT)?;

    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    let hash = sha256_hex(&bytes);
    if hash != release.sha256 {
        let _ = std::fs::remove_file(&file);
        return Err(format!(
            "the package does not match the manifest (SHA-256 {hash}, expected {})",
            release.sha256
        ));
    }

    let own = std::env::current_exe()
        .ok()
        .and_then(|exe| signature(&exe).ok())
        .map(|(_, thumbprint)| thumbprint);
    let expected = expected_signer(settings.signer.as_deref(), own.as_deref())?;
    let (status, thumbprint) = signature(&file)?;
    if let Err(reason) = signature_ok(&status, &thumbprint, &expected) {
        let _ = std::fs::remove_file(&file);
        return Err(reason);
    }
    Ok(file)
}

/// Starts the installer on its own, so it outlives this process (the package stops the agent and starts the new one).
#[cfg(windows)]
pub fn install(package: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const DETACHED: u32 = 0x0000_0008;
    const NO_WINDOW: u32 = 0x0800_0000;
    const BREAKAWAY: u32 = 0x0100_0000;
    let log = work_dir().join("install.log");
    let spawn = |flags: u32| {
        Command::new("msiexec.exe")
            .arg("/i")
            .arg(package)
            .args(["/qn", "/norestart", "/l*v"])
            .arg(&log)
            .creation_flags(flags)
            .spawn()
    };
    // the agent's job object ends what it started when it ends; the installer has to leave it (allowed by the job, see main.rs)
    spawn(DETACHED | NO_WINDOW | BREAKAWAY)
        .or_else(|_| spawn(DETACHED | NO_WINDOW))
        .map(|_| ())
        .map_err(|e| format!("could not start msiexec: {e}"))
}
#[cfg(not(windows))]
pub fn install(_package: &Path) -> Result<(), String> {
    Err("installing updates is only supported on Windows".into())
}

/// `ssd update [--apply] [--no-install] [--channel NAME] [--url ADDRESS]`
pub fn command(config: &Config, args: &[String]) -> Result<(), String> {
    let mut settings = Settings::from_config(config);
    let (mut apply, mut install_it, mut url) = (false, true, None);
    let mut it = args.iter();
    while let Some(flag) = it.next() {
        match flag.as_str() {
            "--apply" => apply = true,
            "--no-install" => install_it = false,
            "--channel" => settings.channel = it.next().ok_or("--channel needs a name")?.clone(),
            "--url" => url = Some(it.next().ok_or("--url needs an address")?.clone()),
            other => return Err(format!("unknown option {other}\nusage: ssd update [--apply] [--no-install] [--channel NAME] [--url ADDRESS]")),
        }
    }
    let current = env!("CARGO_PKG_VERSION");
    println!(
        "this is Self Stream Deck {current}; looking at channel \"{}\"…",
        settings.channel
    );
    let Some(release) = check(&settings, current, url.as_deref())? else {
        println!("it is the newest version.");
        return Ok(());
    };
    println!("{} is available ({}).", release.version, release.url);
    if !apply {
        println!("run `ssd update --apply` to install it.");
        return Ok(());
    }
    let package = download_and_verify(&settings, &release)?;
    println!(
        "downloaded and checked (size, SHA-256 and signature): {}",
        package.display()
    );
    if install_it {
        install(&package)?;
        println!(
            "the installer is running; the agent restarts by itself in a few seconds (log: {}).",
            work_dir().join("install.log").display()
        );
    } else {
        println!("not installing (--no-install).");
    }
    Ok(())
}

/// The automatic part: one check a minute after the start, then one a day; a newer version is installed right away.
pub async fn run_forever(config: Config) {
    let settings = Settings::from_config(&config);
    if !settings.auto || settings.url.is_none() {
        return;
    }
    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
    loop {
        let settings = settings.clone();
        let outcome = tokio::task::spawn_blocking(move || -> Result<Option<String>, String> {
            let Some(release) = check(&settings, env!("CARGO_PKG_VERSION"), None)? else {
                return Ok(None);
            };
            let package = download_and_verify(&settings, &release)?;
            install(&package)?;
            Ok(Some(release.version))
        })
        .await;
        match outcome {
            Ok(Ok(Some(version))) => tracing::info!("update: installing {version}"),
            Ok(Ok(None)) => tracing::info!("update: this is the newest version"),
            Ok(Err(reason)) => tracing::warn!("update: {reason}"),
            Err(error) => tracing::warn!("update: {error}"),
        }
        tokio::time::sleep(std::time::Duration::from_secs(24 * 60 * 60)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const HASH: &str = "a5f5e8877dbf454c986a4a7677dd01a0fa814a5e14c86d157dc42b79e7eefc9e";

    #[test]
    fn versions_compare_by_number_and_a_pre_release_is_older_than_its_release() {
        assert!(is_newer("0.1.0", "0.1.1"));
        assert!(is_newer("0.1.9", "0.2.0"));
        assert!(is_newer("0.9.0", "1.0.0"));
        assert!(!is_newer("0.2.0", "0.2.0"));
        assert!(!is_newer("0.2.0", "0.1.9"));
        assert!(is_newer("0.2.0-rc1", "0.2.0"));
        assert!(!is_newer("0.2.0", "0.2.0-rc1"));
        assert!(is_newer("0.1.9", "0.2.0-rc1"));
        assert!(!is_newer("0.1.0", "not-a-version"));
        assert!(!is_newer("0.1", "0.2.0"));
    }

    fn manifest(url: &str, sha: &str, version: &str) -> Value {
        json!({ "channels": { "stable": { "version": version, "url": url, "sha256": sha } } })
    }

    #[test]
    fn a_good_manifest_gives_a_release_and_a_bad_one_says_what_is_wrong() {
        let good = pick_release(
            &manifest("https://example.com/a.msi", &HASH.to_uppercase(), "0.2.0"),
            "stable",
        )
        .unwrap();
        assert_eq!(
            good,
            Release {
                version: "0.2.0".into(),
                url: "https://example.com/a.msi".into(),
                sha256: HASH.into()
            }
        );
        for (url, sha, version, why) in [
            ("http://example.com/a.msi", HASH, "0.2.0", "https"),
            ("ftp://example.com/a.msi", HASH, "0.2.0", "https"),
            ("https://example.com/a b.msi", HASH, "0.2.0", "characters"),
            ("https://example.com/a.msi", "abc", "0.2.0", "64 hex"),
            (
                "https://example.com/a.msi",
                &"z".repeat(64),
                "0.2.0",
                "64 hex",
            ),
            ("https://example.com/a.msi", HASH, "latest", "not a version"),
        ] {
            let error = pick_release(&manifest(url, sha, version), "stable").unwrap_err();
            assert!(error.contains(why), "{url} {sha} {version}: {error}");
        }
        assert!(
            pick_release(&manifest("https://x/a.msi", HASH, "0.2.0"), "test")
                .unwrap_err()
                .contains("no channel")
        );
        assert!(pick_release(&json!({}), "stable").is_err());
    }

    #[test]
    fn plain_http_is_for_this_pc_only() {
        assert!(pick_release(
            &manifest("http://127.0.0.1:8000/a.msi", HASH, "0.2.0"),
            "stable"
        )
        .is_ok());
        assert!(pick_release(&manifest("http://localhost/a.msi", HASH, "0.2.0"), "stable").is_ok());
        assert!(pick_release(
            &manifest("http://127.0.0.1.evil.com/a.msi", HASH, "0.2.0"),
            "stable"
        )
        .is_err());
        assert!(pick_release(
            &manifest("http://localhost.evil.com/a.msi", HASH, "0.2.0"),
            "stable"
        )
        .is_err());
    }

    #[test]
    fn the_signer_is_the_configured_one_or_the_agents_own_or_nothing() {
        assert_eq!(expected_signer(Some("AA"), Some("BB")).unwrap(), "AA");
        assert_eq!(expected_signer(None, Some("BB")).unwrap(), "BB");
        assert!(expected_signer(None, Some("")).is_err());
        assert!(expected_signer(None, None).is_err());
    }

    #[test]
    fn only_an_untouched_package_from_the_expected_signer_passes() {
        assert!(signature_ok("Valid", "AA", "AA").is_ok());
        assert!(
            signature_ok("UnknownError", "AA", "AA").is_ok(),
            "a self-signed certificate is the normal case here"
        );
        assert!(signature_ok("HashMismatch", "AA", "AA").is_err());
        assert!(signature_ok("NotSigned", "", "AA").is_err());
        assert!(signature_ok("Valid", "BB", "AA")
            .unwrap_err()
            .contains("not by"));
    }

    #[test]
    fn settings_default_to_nothing_stable_and_manual() {
        let dir = std::env::temp_dir().join(format!("ssd-update-settings-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.json"), r#"{"token":"t"}"#).unwrap();
        let plain = Settings::from_config(&Config::load(&dir).unwrap());
        assert_eq!(
            plain,
            Settings {
                url: None,
                channel: "stable".into(),
                auto: false,
                signer: None
            }
        );
        std::fs::write(
            dir.join("config.json"),
            r#"{"token":"t","update":{"url":" https://x/m.json ","channel":"test","auto":true,"signer":"ab cd"}}"#,
        )
        .unwrap();
        let set = Settings::from_config(&Config::load(&dir).unwrap());
        assert_eq!(
            set,
            Settings {
                url: Some("https://x/m.json".into()),
                channel: "test".into(),
                auto: true,
                signer: Some("ABCD".into())
            }
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
