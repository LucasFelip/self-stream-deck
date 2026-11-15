//! `ssd diagnose` where the agent is not on Windows (ADR 0013): the part of the report that does not depend on the Windows tools: the version, where the
//! files are, the USB cable and the end of the log. The Windows report also checks the certificates, the scheduled task and the firewall, which do not exist here.
use std::fmt::Write;
use std::path::Path;

use ssd_core::config::Config;

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
    let config = Config::load(data);
    let token = config
        .as_ref()
        .map(|c| c.token().to_owned())
        .unwrap_or_default();
    let _ = writeln!(
        out,
        "\nconfig: {}",
        if config.is_ok() {
            "readable (the token is not shown)"
        } else {
            "NOT readable"
        }
    );
    if let Ok(config) = &config {
        let _ = writeln!(out, "\nusb:\n  {}", crate::adb::probe(config));
    }
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
    out
}
