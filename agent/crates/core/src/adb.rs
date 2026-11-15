//! What the agent knows about `adb` without running it (ADR 0012): how to read what `adb` prints, and which folders it may be run from. The
//! agent runs as administrator, so it only runs an `adb` that sits where a program without privilege cannot swap it.
use std::path::{Component, Path, PathBuf};

/// The app on the phone.
pub const APP_ID: &str = "dev.selfstreamdeck";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    pub serial: String,
    /// `device` (ready), `unauthorized` (the phone has not accepted this PC), `offline`...
    pub state: String,
}

impl Device {
    pub fn ready(&self) -> bool {
        self.state == "device"
    }
}

/// The phones in the output of `adb devices`.
pub fn parse_devices(output: &str) -> Vec<Device> {
    output
        .lines()
        .skip_while(|line| !line.starts_with("List of devices"))
        .skip(1)
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let (serial, state) = (parts.next()?, parts.next()?);
            // the daemon's own lines ("* daemon started successfully") have no state of this kind
            (!serial.starts_with('*')).then(|| Device {
                serial: serial.to_owned(),
                state: state.to_owned(),
            })
        })
        .collect()
}

/// The `versionName` in the output of `adb shell dumpsys package <app>`; `None` when the app is not installed.
pub fn parse_version_name(dumpsys: &str) -> Option<String> {
    dumpsys.lines().find_map(|line| {
        line.trim()
            .strip_prefix("versionName=")
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    })
}

/// Did `adb install` refuse because of the signature (a different key) or the version, which the agent never forces?
pub fn is_refusal(message: &str) -> bool {
    [
        "INSTALL_FAILED_UPDATE_INCOMPATIBLE",
        "INSTALL_FAILED_VERSION_DOWNGRADE",
        "INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES",
        "signatures do not match",
    ]
    .iter()
    .any(|marker| message.contains(marker))
}

/// The parts of a path as they compare: without regard to case on Windows, whose file system ignores it, and exactly elsewhere (`/USR` is not `/usr`).
fn lowered(path: &Path) -> Vec<String> {
    path.components()
        .map(|c| {
            let part = c.as_os_str().to_string_lossy();
            if cfg!(windows) {
                part.to_lowercase()
            } else {
                part.into_owned()
            }
        })
        .collect()
}

/// Is `candidate` inside one of the `roots` (the folders only an administrator can write: Program Files, Windows, beside the agent)?
/// Lexical and case-insensitive; a path with `..` or a relative one is never trusted.
pub fn trusted(candidate: &Path, roots: &[PathBuf]) -> bool {
    if !candidate.is_absolute() || candidate.components().any(|c| c == Component::ParentDir) {
        return false;
    }
    let path = lowered(candidate);
    roots.iter().filter(|root| root.is_absolute()).any(|root| {
        let root = lowered(root);
        root.len() >= 2 && path.len() > root.len() && path[..root.len()] == root[..]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devices_come_from_the_lines_after_the_header_and_the_daemon_noise_is_ignored() {
        let output = "* daemon not running; starting now at tcp:5037\n* daemon started successfully\nList of devices attached\nABC123\tdevice\nXYZ9\tunauthorized\nemulator-5554\toffline usb:1-1\n\n";
        let devices = parse_devices(output);
        assert_eq!(
            devices,
            [
                Device {
                    serial: "ABC123".into(),
                    state: "device".into()
                },
                Device {
                    serial: "XYZ9".into(),
                    state: "unauthorized".into()
                },
                Device {
                    serial: "emulator-5554".into(),
                    state: "offline".into()
                },
            ]
        );
        assert!(devices[0].ready() && !devices[1].ready());
        assert!(parse_devices("List of devices attached\n\n").is_empty());
        assert!(parse_devices("").is_empty());
    }

    #[test]
    fn the_version_comes_from_dumpsys_and_a_missing_app_has_none() {
        let dump = "Packages:\n  Package [dev.selfstreamdeck] (abc):\n    versionCode=8 minSdk=24 targetSdk=34\n    versionName=0.1.7\n    flags=[ HAS_CODE ]\n";
        assert_eq!(parse_version_name(dump), Some("0.1.7".into()));
        assert_eq!(
            parse_version_name("Unable to find package: dev.selfstreamdeck"),
            None
        );
        assert_eq!(parse_version_name("versionName=\n"), None);
    }

    #[test]
    fn a_signature_or_version_refusal_is_told_from_a_failure() {
        assert!(is_refusal("Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Package dev.selfstreamdeck signatures do not match]"));
        assert!(is_refusal("Failure [INSTALL_FAILED_VERSION_DOWNGRADE]"));
        assert!(!is_refusal("adb: failed to install: device offline"));
    }

    #[cfg(unix)]
    #[test]
    fn only_a_path_inside_an_admin_only_root_is_trusted_unix() {
        let roots = [PathBuf::from("/usr"), PathBuf::from("/opt/ssd")];
        for ok in ["/usr/bin/adb", "/opt/ssd/adb/adb"] {
            assert!(trusted(Path::new(ok), &roots), "{ok}");
        }
        for bad in [
            "/USR/lib/adb",
            "/home/ana/Android/platform-tools/adb",
            "/usr",
            "/usr/../home/ana/adb",
            "/usrx/adb",
            "adb",
            "platform-tools/adb",
        ] {
            assert!(!trusted(Path::new(bad), &roots), "{bad}");
        }
        assert!(!trusted(Path::new("/usr/bin/adb"), &[]));
    }

    #[cfg(windows)]
    #[test]
    fn only_a_path_inside_an_admin_only_root_is_trusted() {
        let roots = [
            PathBuf::from(r"C:\Program Files"),
            PathBuf::from(r"C:\Windows"),
        ];
        for ok in [
            r"C:\Program Files\Android\platform-tools\adb.exe",
            r"c:\program files\SelfStreamDeck\adb\ADB.EXE",
            r"C:\Windows\System32\adb.exe",
        ] {
            assert!(trusted(Path::new(ok), &roots), "{ok}");
        }
        for bad in [
            r"C:\Users\ana\AppData\Local\Android\Sdk\platform-tools\adb.exe",
            r"C:\platform-tools\adb.exe",
            r"C:\Program Files",
            r"C:\Program Files\..\Users\ana\adb.exe",
            r"C:\Program Files Evil\adb.exe",
            r"adb.exe",
            r"platform-tools\adb.exe",
        ] {
            assert!(!trusted(Path::new(bad), &roots), "{bad}");
        }
        assert!(!trusted(Path::new(r"C:\Program Files\x\adb.exe"), &[]));
    }
}
