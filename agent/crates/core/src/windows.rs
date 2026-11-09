//! What the Janelas page shows: the windows of the PC joined with the taskbar apps (name, icon, app id). The listing itself is the
//! `WindowsPort`; this is the part that decides what is worth showing. Parity with `ctx.build.windows` of `legacy/server/src/routes/windows.js`.
use serde::{Deserialize, Serialize};

use crate::taskbar::App;

/// A window as the platform sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowInfo {
    pub handle: i64,
    pub pid: u32,
    pub title: String,
    /// 0 normal, 1 minimized, 2 maximized
    pub state: u8,
    /// index into the monitor list (sorted by device name), or -1
    pub monitor: i32,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    /// the process name, lower case ("brave")
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct WindowsSnapshot {
    /// every process name that is running (lower case)
    pub running: Vec<String>,
    pub windows: Vec<WindowInfo>,
}

/// Parts of the shell that have a window but are not something to show.
const SHELL_WINDOWS: [&str; 5] = [
    "textinputhost",
    "searchhost",
    "startmenuexperiencehost",
    "shellexperiencehost",
    "lockapp",
];

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

/// The windows of `GET /api/windows`.
pub fn visible_windows(snapshot: &WindowsSnapshot, apps: &[App]) -> Vec<serde_json::Value> {
    snapshot
        .windows
        .iter()
        .filter(|w| !SHELL_WINDOWS.contains(&w.name.as_str()) && w.title != "Program Manager")
        .map(|window| {
            let app = apps
                .iter()
                .find(|a| a.proc.as_deref() == Some(window.name.as_str()));
            // UWP apps all run inside ApplicationFrameHost: their title is the useful part
            let label = if window.name == "applicationframehost" {
                String::new()
            } else if window.name == "explorer" {
                "Explorador de Arquivos".to_owned()
            } else if let Some(app) = app {
                app.name.clone()
            } else {
                capitalize(&window.name)
            };
            serde_json::json!({
                "handle": window.handle, "title": window.title, "app": label,
                "appId": app.map(|a| a.id.as_str()),
                "iconVersion": app.map(|a| a.icon_version.as_str()).unwrap_or(""),
                "state": window.state, "monitor": window.monitor,
                "x": window.x, "y": window.y, "w": window.w, "h": window.h,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(handle: i64, name: &str, title: &str) -> WindowInfo {
        WindowInfo {
            handle,
            pid: 1,
            title: title.into(),
            state: 0,
            monitor: 0,
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            name: name.into(),
        }
    }

    fn app(proc: &str, name: &str) -> App {
        App {
            id: "abc".into(),
            name: name.into(),
            lnk: String::new(),
            proc: Some(proc.into()),
            has_icon: true,
            icon_version: "12345678".into(),
        }
    }

    #[test]
    fn shell_windows_and_the_desktop_are_left_out() {
        let snapshot = WindowsSnapshot {
            running: vec![],
            windows: vec![
                window(1, "searchhost", "Pesquisar"),
                window(2, "explorer", "Program Manager"),
                window(3, "explorer", "Downloads"),
                window(4, "lockapp", "x"),
            ],
        };
        let shown = visible_windows(&snapshot, &[]);
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0]["app"], "Explorador de Arquivos");
    }

    #[test]
    fn a_window_takes_the_name_and_icon_of_its_taskbar_app() {
        let snapshot = WindowsSnapshot {
            running: vec![],
            windows: vec![
                window(1, "brave", "Nova guia"),
                window(2, "notepad", "a.txt"),
                window(3, "applicationframehost", "Calculadora"),
            ],
        };
        let shown = visible_windows(&snapshot, &[app("brave", "Brave")]);
        assert_eq!(
            (
                shown[0]["app"].as_str(),
                shown[0]["appId"].as_str(),
                shown[0]["iconVersion"].as_str()
            ),
            (Some("Brave"), Some("abc"), Some("12345678"))
        );
        assert_eq!(
            (
                shown[1]["app"].as_str(),
                shown[1]["appId"].is_null(),
                shown[1]["iconVersion"].as_str()
            ),
            (Some("Notepad"), true, Some(""))
        );
        assert_eq!(shown[2]["app"], "", "UWP windows show their title instead");
    }
}
