//! `ssd diagnose`: one report to read (or send) when something does not work: the version, where the files are, what the config says (the pairing
//! token hidden), whether the ports answer, the certificates, the scheduled task, the firewall rules, what each part of the PC answers and the
//! end of the log. Nothing secret leaves in it.
use std::fmt::Write;
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::time::Duration;

use ssd_core::config::Config;
use ssd_core::ports::{AudioPort, MediaPort, MonitorPort, VcamPort, WindowsPort};
use ssd_core::sha256::sha256_hex;

fn command(program: &str, args: &[&str]) -> String {
    use std::os::windows::process::CommandExt;
    std::process::Command::new(program)
        .args(args)
        .creation_flags(0x0800_0000)
        .output()
        .map(|o| {
            format!(
                "{}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            )
        })
        .unwrap_or_else(|e| format!("({e})"))
}

fn listening(port: u64) -> &'static str {
    let address = SocketAddr::from(([127, 0, 0, 1], port as u16));
    if TcpStream::connect_timeout(&address, Duration::from_millis(500)).is_ok() {
        "answers"
    } else {
        "does not answer"
    }
}

fn fingerprint(file: &Path) -> String {
    std::fs::read(file).map_or_else(
        |_| "missing".into(),
        |bytes| sha256_hex(&bytes)[..16].to_owned() + "…",
    )
}

fn probe<T>(
    label: &str,
    report: &mut String,
    work: impl FnOnce() -> Result<T, String>,
    describe: impl FnOnce(T) -> String,
) {
    let line = match work() {
        Ok(value) => describe(value),
        Err(error) => format!("FAILED: {error}"),
    };
    let _ = writeln!(report, "  {label:<14} {line}");
}

pub fn report(data: &Path, web_embedded: bool) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "Self Stream Deck {} (agent in Rust)",
        env!("CARGO_PKG_VERSION")
    );
    let _ = writeln!(
        out,
        "exe:   {}",
        std::env::current_exe()
            .map(|p| p.display().to_string())
            .unwrap_or_default()
    );
    let _ = writeln!(out, "data:  {}", data.display());
    let _ = writeln!(
        out,
        "web:   {}",
        if web_embedded {
            "inside the executable"
        } else {
            "a folder on disk"
        }
    );
    let _ = writeln!(
        out,
        "user:  {}\\{}",
        std::env::var("USERDOMAIN").unwrap_or_default(),
        std::env::var("USERNAME").unwrap_or_default()
    );

    let config = Config::load(data);
    let token = config
        .as_ref()
        .map(|c| c.token().to_owned())
        .unwrap_or_default();
    let _ = writeln!(out, "\nconfig:");
    match &config {
        Ok(c) => {
            let _ = writeln!(
                out,
                "  token          {}… ({} characters, the same one the phone already uses)",
                token.chars().take(4).collect::<String>(),
                token.len()
            );
            for key in [
                "port",
                "lan",
                "httpsPort",
                "ios",
                "iosPort",
                "iosCaPort",
                "powerControls",
                "editor",
                "miniPlayer",
            ] {
                let _ = writeln!(
                    out,
                    "  {key:<14} {}",
                    c.get(key)
                        .map_or("(not set)".to_owned(), ToString::to_string)
                );
            }
            let _ = writeln!(
                out,
                "  shortcuts      {}",
                c.get("shortcuts")
                    .and_then(|v| v.as_array())
                    .map_or(0, Vec::len)
            );
            let _ = writeln!(
                out,
                "  macros         {}",
                c.get("macros")
                    .and_then(|v| v.as_array())
                    .map_or(0, Vec::len)
            );
            let _ = writeln!(out, "\nports (on this PC):");
            for key in ["port", "httpsPort", "iosPort", "iosCaPort"] {
                if let Some(port) = c.get(key).and_then(|v| v.as_u64()) {
                    let _ = writeln!(out, "  {key:<14} {port}: {}", listening(port));
                }
            }
        }
        Err(error) => {
            let _ = writeln!(out, "  could not be read: {error}");
        }
    }

    let _ = writeln!(out, "\ncertificates:");
    let _ = writeln!(
        out,
        "  Wi-Fi (Android)  {}",
        fingerprint(&data.join("tls").join("server.cer"))
    );
    let _ = writeln!(
        out,
        "  iPhone authority {}",
        fingerprint(&data.join("tls").join("ios").join("ca.cer"))
    );

    let _ = writeln!(out, "\nscheduled task:");
    for line in command(
        "schtasks.exe",
        &["/query", "/tn", "Self Stream Deck", "/fo", "LIST", "/v"],
    )
    .lines()
    .filter(|l| {
        [
            "Status",
            "Last Run Time",
            "Last Result",
            "Task To Run",
            "Run As User",
            "Estado",
            "Última",
            "Tarefa a",
            "Executar",
        ]
        .iter()
        .any(|k| l.contains(k))
    }) {
        let _ = writeln!(out, "  {}", line.trim());
    }
    let _ = writeln!(out, "\nfirewall rules:");
    for rule in ["Self Stream Deck (rede local)", "Self Stream Deck (iPhone)"] {
        let shown = command(
            "netsh.exe",
            &[
                "advfirewall",
                "firewall",
                "show",
                "rule",
                &format!("name={rule}"),
            ],
        );
        let enabled = shown
            .lines()
            .find(|l| l.contains("Enabled") || l.contains("Habilitado"))
            .map_or("not found".to_owned(), |l| l.trim().to_owned());
        let ports = shown
            .lines()
            .find(|l| l.contains("LocalPort") || l.contains("Porta local"))
            .map(|l| l.trim().to_owned())
            .unwrap_or_default();
        let _ = writeln!(out, "  {rule}: {enabled} {ports}");
    }

    let _ = writeln!(out, "\nthe PC, read now:");
    probe(
        "audio",
        &mut out,
        || {
            ssd_platform_windows::WindowsAudio
                .devices()
                .map_err(|e| e.to_string())
        },
        |d| format!("{} outputs, {} inputs", d.playback.len(), d.capture.len()),
    );
    probe(
        "media",
        &mut out,
        || {
            ssd_platform_windows::WindowsMedia
                .state()
                .map_err(|e| e.to_string())
        },
        |m| format!("{} players", m.sessions.len()),
    );
    let windows = ssd_platform_windows::WindowsWindows;
    probe(
        "windows",
        &mut out,
        || windows.snapshot().map_err(|e| e.to_string()),
        |s| {
            format!(
                "{} windows, {} programs running",
                s.windows.len(),
                s.running.len()
            )
        },
    );
    probe(
        "screens",
        &mut out,
        || windows.monitors(false).map_err(|e| e.to_string()),
        |m| format!("{} screens", m.len()),
    );
    probe(
        "monitor",
        &mut out,
        || {
            ssd_platform_windows::WindowsMonitor
                .sample()
                .map_err(|e| e.to_string())
        },
        |s| {
            format!(
                "cpu {}%, memory {}%",
                s["cpu"]["usage"], s["memory"]["usedPct"]
            )
        },
    );
    probe(
        "camera",
        &mut out,
        || {
            ssd_platform_windows::WindowsVcam::new(data.join("vcam"))
                .status()
                .map_err(|e| e.to_string())
        },
        |s| format!("direct camera installed: {}", s["installed"]),
    );

    let _ = writeln!(out, "\nend of the log:");
    match std::fs::read_to_string(data.join("server.log")) {
        Ok(text) => {
            let lines: Vec<&str> = text.lines().collect();
            for line in &lines[lines.len().saturating_sub(40)..] {
                let hidden = if token.is_empty() {
                    (*line).to_owned()
                } else {
                    line.replace(&token, "***")
                };
                let _ = writeln!(out, "  {hidden}");
            }
        }
        Err(_) => {
            let _ = writeln!(out, "  (no server.log in the data folder)");
        }
    }
    let _ = (config.is_ok(), Path::new(""));
    out
}
