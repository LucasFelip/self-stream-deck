//! The agent and `adb` (ADR 0012): the USB tunnel that makes itself when the phone is plugged in, and the update of the app on the phone.
//!
//! The agent runs as administrator, so it only runs an `adb` that sits where a program without privilege cannot swap it: beside `ssd.exe` in
//! an `adb` folder, or in the `Android\platform-tools` folder of Program Files. A path in `config.json` (`usb.adb`) counts only when it is
//! inside one of those roots too: `config.json` is a file any program of the user can write.
//!
//! - `"usb": { "auto": true }` keeps `adb reverse tcp:7878 tcp:<port>` in place for every phone that is ready (`ssd usb` does it once, by hand).
//! - `"update": { "apk": true }` (or `ssd update --apk`) installs a newer app with `adb install -r`, in place. Android refuses a different
//!   signing key and a lower version; the agent reports it and never uninstalls.
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use ssd_core::adb::{is_refusal, parse_devices, parse_version_name, trusted, Device, APP_ID};
use ssd_core::config::Config;
use ssd_core::ports::{AdbPort, PortError, PortResult};

use crate::update::{self, is_newer, Release, Settings, UpdateError};

/// The port the app on the phone calls (`Pairing.USB_PORT` in the Android app).
const PHONE_PORT: u16 = 7878;
const EVERY: Duration = Duration::from_secs(3);
/// The tunnel is asserted again this often even when nothing changed (a replug between two looks, an `adb kill-server`).
const REASSERT_EVERY: u64 = 10;
const APK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);

/// `adb` as a program.
pub struct AdbCli {
    exe: PathBuf,
    server: std::sync::Once,
}

impl AdbCli {
    pub fn new(exe: PathBuf) -> Self {
        Self {
            exe,
            server: std::sync::Once::new(),
        }
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.exe);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // no console window
        }
        command.stdin(Stdio::null());
        command
    }

    /// The `adb` server is started once with its output thrown away: a server that inherits the pipes of a command that reads them never lets it end.
    fn ensure_server(&self) {
        self.server.call_once(|| {
            let _ = self
                .command()
                .arg("start-server")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        });
    }

    /// What `adb` printed (both streams); an error when it could not run or said it failed.
    fn run(&self, args: &[&str]) -> PortResult<String> {
        self.ensure_server();
        let output = self
            .command()
            .args(args)
            .output()
            .map_err(|e| PortError::Failed(format!("could not run adb: {e}")))?;
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        if output.status.success() {
            Ok(text)
        } else {
            Err(PortError::Failed(text.trim().to_owned()))
        }
    }
}

impl AdbPort for AdbCli {
    fn devices(&self) -> PortResult<Vec<Device>> {
        Ok(parse_devices(&self.run(&["devices"])?))
    }

    fn reverse(&self, serial: &str, phone_port: u16, pc_port: u16) -> PortResult<()> {
        let (phone, pc) = (format!("tcp:{phone_port}"), format!("tcp:{pc_port}"));
        self.run(&["-s", serial, "reverse", &phone, &pc])
            .map(|_| ())
    }

    fn installed_version(&self, serial: &str, package: &str) -> PortResult<Option<String>> {
        let text = self.run(&["-s", serial, "shell", "dumpsys", "package", package])?;
        Ok(parse_version_name(&text))
    }

    fn install(&self, serial: &str, apk: &Path) -> PortResult<()> {
        let file = apk.to_string_lossy();
        let text = self.run(&["-s", serial, "install", "-r", &file])?;
        if text.contains("Success") {
            Ok(())
        } else {
            Err(PortError::Failed(text.trim().to_owned()))
        }
    }
}

/// The folders only an administrator can write, where an `adb` may sit.
fn roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = ["ProgramFiles", "ProgramFiles(x86)", "SystemRoot"]
        .iter()
        .filter_map(|name| std::env::var_os(name).map(PathBuf::from))
        .collect();
    if let Some(dir) = program_dir() {
        roots.push(dir);
    }
    roots
}

fn program_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()?
        .parent()
        .map(Path::to_path_buf)
}

/// The path with the `\\?\` that `canonicalize` puts on Windows taken off, so it compares with the plain roots.
fn plain(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned())
}

fn candidates(config: &Config) -> Vec<PathBuf> {
    let name = if cfg!(windows) { "adb.exe" } else { "adb" };
    let mut list = Vec::new();
    if let Some(path) = config
        .get("usb")
        .and_then(|u| u.get("adb"))
        .and_then(serde_json::Value::as_str)
    {
        list.push(PathBuf::from(path));
    }
    if let Some(dir) = program_dir() {
        list.push(dir.join("adb").join(name));
    }
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(base) = std::env::var_os(var).map(PathBuf::from) {
            list.push(base.join("Android").join("platform-tools").join(name));
            list.push(
                base.join("Android")
                    .join("android-sdk")
                    .join("platform-tools")
                    .join(name),
            );
        }
    }
    list
}

/// The `adb` this agent may run, if there is one.
pub fn locate(config: &Config) -> Option<PathBuf> {
    let roots = roots();
    candidates(config).into_iter().find_map(|candidate| {
        let real = plain(&std::fs::canonicalize(&candidate).ok()?);
        (real.is_file() && trusted(&real, &roots)).then_some(real)
    })
}

/// Where the agent looks, for the message of a PC that has no `adb` it may use.
pub fn where_to_put_it() -> String {
    program_dir().map_or_else(
        || "an adb folder beside ssd.exe".into(),
        |dir| format!("{}", dir.join("adb").display()),
    )
}

/// What one look at the phones found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Usb {
    Off,
    NoAdb,
    Failed(String),
    NoPhone,
    /// the phones that are plugged in but have not accepted this PC (the "Allow USB debugging" prompt)
    Unauthorized(Vec<String>),
    /// the phones whose tunnel is in place
    Tunnelled(Vec<String>),
}

impl Usb {
    pub fn describe(&self) -> String {
        match self {
            Usb::Off => "off (set \"usb\": { \"auto\": true } in config.json)".into(),
            Usb::NoAdb => format!(
                "no adb this agent may run: put the Android platform-tools in {}",
                where_to_put_it()
            ),
            Usb::Failed(why) => format!("adb failed: {why}"),
            Usb::NoPhone => {
                "no phone on the cable (USB debugging on? a cable that carries data?)".into()
            }
            Usb::Unauthorized(list) => format!(
                "{} plugged in but not authorized: accept \"Allow USB debugging\" on the phone",
                list.join(", ")
            ),
            Usb::Tunnelled(list) => format!("tunnel in place for {}", list.join(", ")),
        }
    }
}

/// One look: puts the tunnel in place for every ready phone that does not have it. `tunnelled` is what was done before.
pub fn step(port: &dyn AdbPort, tunnelled: &mut HashSet<String>, pc_port: u16) -> Usb {
    let devices = match port.devices() {
        Ok(devices) => devices,
        Err(problem) => return Usb::Failed(problem.to_string()),
    };
    tunnelled.retain(|serial| devices.iter().any(|d| d.serial == *serial && d.ready()));
    let mut failed = None;
    for device in devices.iter().filter(|d| d.ready()) {
        if tunnelled.contains(&device.serial) {
            continue;
        }
        match port.reverse(&device.serial, PHONE_PORT, pc_port) {
            Ok(()) => {
                tunnelled.insert(device.serial.clone());
            }
            Err(problem) => failed = Some(problem.to_string()),
        }
    }
    if let Some(why) = failed {
        return Usb::Failed(why);
    }
    if !tunnelled.is_empty() {
        let mut list: Vec<String> = tunnelled.iter().cloned().collect();
        list.sort();
        return Usb::Tunnelled(list);
    }
    let waiting: Vec<String> = devices
        .iter()
        .filter(|d| d.state == "unauthorized")
        .map(|d| d.serial.clone())
        .collect();
    if waiting.is_empty() {
        Usb::NoPhone
    } else {
        Usb::Unauthorized(waiting)
    }
}

/// What an update of the app did on one phone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApkResult {
    Updated {
        serial: String,
        from: String,
        to: String,
    },
    UpToDate {
        serial: String,
        version: String,
    },
    /// the app is not on that phone: the agent updates, it does not install for the first time
    NotInstalled {
        serial: String,
    },
    /// Android said no (another signing key, a lower version): reported, never forced
    Refused {
        serial: String,
        reason: String,
    },
    Failed {
        serial: String,
        reason: String,
    },
}

/// Updates the app on every ready phone that has an older one. `fetch` gives the downloaded and checked APK (asked once, and only if some phone needs it).
pub fn apk_cycle(
    port: &dyn AdbPort,
    release_version: &str,
    mut fetch: impl FnMut() -> Result<PathBuf, UpdateError>,
) -> Vec<ApkResult> {
    let mut results = Vec::new();
    let mut apk: Option<PathBuf> = None;
    let devices = match port.devices() {
        Ok(devices) => devices,
        Err(_) => return results,
    };
    for device in devices.iter().filter(|d| d.ready()) {
        let serial = device.serial.clone();
        let installed = match port.installed_version(&serial, APP_ID) {
            Ok(Some(version)) => version,
            Ok(None) => {
                results.push(ApkResult::NotInstalled { serial });
                continue;
            }
            Err(problem) => {
                results.push(ApkResult::Failed {
                    serial,
                    reason: problem.to_string(),
                });
                continue;
            }
        };
        if !is_newer(&installed, release_version) {
            results.push(ApkResult::UpToDate {
                serial,
                version: installed,
            });
            continue;
        }
        if apk.is_none() {
            match fetch() {
                Ok(path) => apk = Some(path),
                Err(problem) => {
                    results.push(ApkResult::Failed {
                        serial,
                        reason: problem.to_string(),
                    });
                    continue;
                }
            }
        }
        let Some(path) = &apk else { continue };
        results.push(match port.install(&serial, path) {
            Ok(()) => ApkResult::Updated {
                serial,
                from: installed,
                to: release_version.to_owned(),
            },
            Err(problem) => {
                let reason = problem.to_string();
                if is_refusal(&reason) {
                    ApkResult::Refused { serial, reason }
                } else {
                    ApkResult::Failed { serial, reason }
                }
            }
        });
    }
    results
}

impl ApkResult {
    pub fn describe(&self) -> String {
        match self {
            ApkResult::Updated { serial, from, to } => {
                format!("{serial}: the app went from {from} to {to}")
            }
            ApkResult::UpToDate { serial, version } => {
                format!("{serial}: the app is up to date ({version})")
            }
            ApkResult::NotInstalled { serial } => format!(
                "{serial}: the app is not installed (install it once by hand; updates come after)"
            ),
            ApkResult::Refused { serial, reason } => {
                format!("{serial}: Android refused the app ({reason}); nothing was uninstalled")
            }
            ApkResult::Failed { serial, reason } => {
                format!("{serial}: could not update the app ({reason})")
            }
        }
    }
}

/// `ssd usb`: finds `adb`, looks at the phones and puts the tunnel in place once; says what it found.
pub fn command(config: &Config) -> Result<(), String> {
    let Some(exe) = locate(config) else {
        return Err(Usb::NoAdb.describe());
    };
    println!("adb: {}", exe.display());
    let cli = AdbCli::new(exe);
    let usb = step(&cli, &mut HashSet::new(), config.port());
    println!("usb: {}", usb.describe());
    match usb {
        Usb::Tunnelled(_) => Ok(()),
        other => Err(other.describe()),
    }
}

/// A line for `ssd diagnose`: where `adb` is and what phones it sees (the tunnel is not touched).
pub fn probe(config: &Config) -> String {
    let Some(exe) = locate(config) else {
        return Usb::NoAdb.describe();
    };
    let cli = AdbCli::new(exe.clone());
    match cli.devices() {
        Ok(devices) if devices.is_empty() => format!("{}; no phone on the cable", exe.display()),
        Ok(devices) => format!(
            "{}; {}",
            exe.display(),
            devices
                .iter()
                .map(|d| format!("{} ({})", d.serial, d.state))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Err(problem) => format!("{}; {problem}", exe.display()),
    }
}

struct Loop {
    cli: Option<AdbCli>,
    tunnelled: HashSet<String>,
    tick: u64,
    last_apk: Option<Instant>,
}

fn cycle(config: &Config, state: &mut Loop, apk_wanted: &Settings) -> Usb {
    if state.cli.is_none() {
        state.cli = locate(config).map(AdbCli::new);
    }
    let Some(cli) = &state.cli else {
        return Usb::NoAdb;
    };
    state.tick += 1;
    if state.tick.is_multiple_of(REASSERT_EVERY) {
        state.tunnelled.clear();
    }
    let usb = step(cli, &mut state.tunnelled, config.port());
    let due = state.last_apk.is_none_or(|at| at.elapsed() >= APK_EVERY);
    if apk_wanted.apk && due && matches!(usb, Usb::Tunnelled(_)) {
        state.last_apk = Some(Instant::now());
        match update::fetch_release(apk_wanted, None) {
            Ok(release) if release.apk.is_some() => {
                for result in apk_cycle(cli, &release.version, || update::download_apk(&release)) {
                    tracing::info!("apk: {}", result.describe());
                }
            }
            Ok(_) => tracing::info!("apk: the manifest has no app for this channel"),
            Err(problem) => tracing::warn!("apk: {problem}"),
        }
    }
    usb
}

/// The loop of the agent: with `usb.auto` it looks at the phones every few seconds. Without it, nothing runs and no `adb` is started.
pub async fn run_forever(config: Config) {
    let auto = config
        .get("usb")
        .and_then(|u| u.get("auto"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if !auto {
        return;
    }
    let settings = Settings::from_config(&config);
    let mut state = Loop {
        cli: None,
        tunnelled: HashSet::new(),
        tick: 0,
        last_apk: None,
    };
    let mut last = Usb::Off;
    loop {
        let (config, settings) = (config.clone(), settings.clone());
        let result = tokio::task::spawn_blocking(move || {
            let usb = cycle(&config, &mut state, &settings);
            (usb, state)
        })
        .await;
        match result {
            Ok((usb, back)) => {
                state = back;
                if usb != last {
                    tracing::info!("usb: {}", usb.describe());
                    last = usb;
                }
            }
            Err(_) => return,
        }
        tokio::time::sleep(EVERY).await;
    }
}

/// The release a manual `ssd update --apk` goes by, checked for an app.
pub fn release_with_apk(release: &Release) -> Result<(), UpdateError> {
    release
        .apk
        .as_ref()
        .map(|_| ())
        .ok_or_else(|| UpdateError::Manifest("the manifest has no \"apk\" for this channel".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ssd_core::ports::FakeAdb;

    fn tmp_apk() -> Result<PathBuf, UpdateError> {
        Ok(PathBuf::from("app.apk"))
    }

    #[test]
    fn a_ready_phone_gets_its_tunnel_once_and_a_replugged_one_gets_it_again() {
        let adb = FakeAdb::with(&[("A1", "device"), ("B2", "unauthorized")]);
        let mut done = HashSet::new();
        assert_eq!(
            step(&adb, &mut done, 7878),
            Usb::Tunnelled(vec!["A1".into()])
        );
        assert_eq!(adb.log(), ["reverse A1 7878 7878"]);
        step(&adb, &mut done, 7878);
        assert_eq!(adb.log().len(), 1, "not again while it holds");
        // unplugged, then plugged in again
        adb.devices.lock().unwrap().clear();
        assert_eq!(step(&adb, &mut done, 7878), Usb::NoPhone);
        *adb.devices.lock().unwrap() = vec![Device {
            serial: "A1".into(),
            state: "device".into(),
        }];
        step(&adb, &mut done, 7000);
        assert_eq!(adb.log()[1], "reverse A1 7878 7000");
    }

    #[test]
    fn a_phone_that_has_not_accepted_the_pc_is_said_so() {
        let adb = FakeAdb::with(&[("B2", "unauthorized")]);
        assert_eq!(
            step(&adb, &mut HashSet::new(), 7878),
            Usb::Unauthorized(vec!["B2".into()])
        );
        assert!(Usb::Unauthorized(vec!["B2".into()])
            .describe()
            .contains("Allow USB debugging"));
        assert_eq!(
            step(&FakeAdb::default(), &mut HashSet::new(), 7878),
            Usb::NoPhone
        );
    }

    #[test]
    fn an_older_app_is_updated_a_current_one_is_left_and_a_missing_one_is_not_installed() {
        let adb = FakeAdb::with(&[
            ("OLD", "device"),
            ("NEW", "device"),
            ("NONE", "device"),
            ("WAIT", "unauthorized"),
        ]);
        adb.versions
            .lock()
            .unwrap()
            .insert("OLD".into(), "0.1.7".into());
        adb.versions
            .lock()
            .unwrap()
            .insert("NEW".into(), "0.2.0".into());
        let mut downloads = 0;
        let results = apk_cycle(&adb, "0.2.0", || {
            downloads += 1;
            tmp_apk()
        });
        assert_eq!(downloads, 1);
        assert_eq!(
            results,
            [
                ApkResult::Updated {
                    serial: "OLD".into(),
                    from: "0.1.7".into(),
                    to: "0.2.0".into()
                },
                ApkResult::UpToDate {
                    serial: "NEW".into(),
                    version: "0.2.0".into()
                },
                ApkResult::NotInstalled {
                    serial: "NONE".into()
                },
            ]
        );
        assert_eq!(adb.log(), ["install OLD app.apk"]);
    }

    #[test]
    fn nothing_is_downloaded_when_every_app_is_current() {
        let adb = FakeAdb::with(&[("A", "device")]);
        adb.versions
            .lock()
            .unwrap()
            .insert("A".into(), "0.2.0".into());
        let results = apk_cycle(&adb, "0.2.0", || panic!("no download needed"));
        assert!(matches!(results[0], ApkResult::UpToDate { .. }));
    }

    #[test]
    fn a_signature_refusal_is_reported_as_one_and_nothing_is_uninstalled() {
        let adb = FakeAdb::with(&[("A", "device")]);
        adb.versions
            .lock()
            .unwrap()
            .insert("A".into(), "0.1.0".into());
        *adb.install_error.lock().unwrap() =
            Some("Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match]".into());
        let results = apk_cycle(&adb, "0.2.0", tmp_apk);
        assert!(
            matches!(&results[0], ApkResult::Refused { reason, .. } if reason.contains("INCOMPATIBLE"))
        );
        assert!(results[0].describe().contains("nothing was uninstalled"));
        assert_eq!(
            adb.log(),
            ["install A app.apk"],
            "only the one attempt, no uninstall"
        );
        *adb.install_error.lock().unwrap() = Some("device offline".into());
        assert!(matches!(
            apk_cycle(&adb, "0.2.0", tmp_apk)[0],
            ApkResult::Failed { .. }
        ));
    }

    #[test]
    fn a_failed_download_is_a_failure_for_that_phone_only() {
        let adb = FakeAdb::with(&[("A", "device")]);
        adb.versions
            .lock()
            .unwrap()
            .insert("A".into(), "0.1.0".into());
        let results = apk_cycle(&adb, "0.2.0", || {
            Err(UpdateError::Download("no network".into()))
        });
        assert!(
            matches!(&results[0], ApkResult::Failed { reason, .. } if reason.contains("no network"))
        );
        assert!(adb.log().is_empty());
    }
}
