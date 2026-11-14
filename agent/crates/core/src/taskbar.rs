//! The taskbar apps: what the pinned shortcuts become on the deck. No Windows here (reading the shortcuts and extracting icons is the
//! `TaskbarPort`); this is the part that decides names, duplicates, order and which running process an app is. Parity with
//! `legacy/server/src/taskbar.js`.
use std::cmp::Ordering;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::sha1::sha1_hex;

/// One pinned shortcut as it was read from the TaskBar folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskbarItem {
    /// the first 10 hex characters of the SHA-1 of the lower-cased file name: the same ids the Node agent made
    pub id: String,
    pub file: String,
    pub lnk: String,
    pub target: String,
    pub args: String,
    pub has_icon: bool,
    pub icon_hash: Option<String>,
}

/// An app of the Apps page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct App {
    pub id: String,
    pub name: String,
    pub lnk: String,
    /// the running process this shortcut starts ("brave.exe" gives "brave"), to tell whether the app is open
    pub proc: Option<String>,
    pub has_icon: bool,
    /// part of the icon URL, so clients fetch again when the icon changes
    pub icon_version: String,
}

pub fn id_of(file_name: &str) -> String {
    sha1_hex(file_name.to_lowercase().as_bytes())[..10].to_owned()
}

/// "03 Discord.lnk" is "Discord".
pub fn display_name(file: &str) -> String {
    let without_ext = match file.len().checked_sub(4) {
        Some(cut) if file.is_char_boundary(cut) && file[cut..].eq_ignore_ascii_case(".lnk") => {
            &file[..cut]
        }
        _ => file,
    };
    strip_number(without_ext).to_owned()
}

/// "02 Brave" is "Brave" (digits, then whitespace, then the rest).
fn strip_number(text: &str) -> &str {
    let rest = text.trim_start_matches(|c: char| c.is_ascii_digit());
    if rest.len() < text.len() && rest.starts_with(char::is_whitespace) {
        rest.trim_start()
    } else {
        text
    }
}

fn is_numbered(file: &str) -> bool {
    strip_number(file).len() < file.len()
}

/// Shortcuts without a file target (File Explorer, shell: items) cannot be compared by path, so the same-looking icon stands in for
/// "same app".
fn dedupe_key(item: &TaskbarItem) -> String {
    if !item.target.is_empty() {
        format!("{}|{}", item.target, item.args).to_lowercase()
    } else if let Some(hash) = &item.icon_hash {
        format!("icon:{hash}")
    } else {
        format!("name:{}", display_name(&item.file).to_lowercase())
    }
}

/// Numbers inside names count as numbers ("2 a" before "10 a"), the rest by letters without regard to case.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    fn chunks(text: &str) -> Vec<(bool, String)> {
        let mut out: Vec<(bool, String)> = Vec::new();
        for c in text.chars() {
            let digit = c.is_ascii_digit();
            match out.last_mut() {
                Some((is_digit, chunk)) if *is_digit == digit => chunk.push(c),
                _ => out.push((digit, c.to_string())),
            }
        }
        out
    }
    let (x, y) = (chunks(a), chunks(b));
    for (p, q) in x.iter().zip(&y) {
        let order = if p.0 && q.0 {
            let (n, m) = (p.1.trim_start_matches('0'), q.1.trim_start_matches('0'));
            n.len().cmp(&m.len()).then_with(|| n.cmp(m))
        } else {
            p.1.to_lowercase().cmp(&q.1.to_lowercase())
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    x.len().cmp(&y.len()).then_with(|| a.cmp(b))
}

/// A shortcut to a Store-style (packaged) app does not name the program: it runs `explorer.exe shell:AppsFolder\<family>!<app>`. This gives
/// the package family and the app id of such a shortcut ("Claude_pzs8sxrjxfjjc" and "Claude"), so the program can be looked up.
pub fn packaged_app(target: &str, args: &str) -> Option<(String, String)> {
    const PREFIX: &str = "shell:appsfolder\\";
    let program = target.rsplit(['\\', '/']).next().unwrap_or(target);
    if !program.eq_ignore_ascii_case("explorer.exe") {
        return None;
    }
    let args = args.trim().trim_matches('"');
    if !args.get(..PREFIX.len())?.eq_ignore_ascii_case(PREFIX) {
        return None;
    }
    let (family, app) = args[PREFIX.len()..].split_once('!')?;
    let plain = |text: &str| {
        !text.is_empty()
            && text
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    };
    (plain(family) && plain(app)).then(|| (family.to_owned(), app.to_owned()))
}

/// The `Executable` of one `<Application Id="…">` of a package's `AppxManifest.xml` ("app\Claude.exe"), relative to the package folder.
pub fn manifest_executable(manifest: &str, app_id: &str) -> Option<String> {
    fn attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
        let mut rest = tag;
        loop {
            let at = rest.find(name)?;
            let (before, after) = (&rest[..at], &rest[at + name.len()..]);
            let quoted = after.trim_start().strip_prefix('=').map(str::trim_start);
            match quoted.and_then(|q| q.strip_prefix('"')) {
                // a whole attribute name, not the end of another one ("EntryId=")
                Some(value) if before.ends_with(char::is_whitespace) => {
                    return value.split_once('"').map(|(value, _)| value)
                }
                _ => rest = after,
            }
        }
    }
    manifest
        .split("<Application")
        .skip(1)
        .filter(|rest| rest.starts_with(char::is_whitespace))
        .filter_map(|rest| rest.split_once('>').map(|(tag, _)| tag))
        .find(|tag| attribute(tag, "Id") == Some(app_id))
        .and_then(|tag| attribute(tag, "Executable"))
        .filter(|path| !path.is_empty() && !path.contains(".."))
        .map(str::to_owned)
}

/// The TaskBar folder can hold both numbered ("02 Brave.lnk") and plain ("Brave.lnk") shortcuts to the same app. One per target is kept,
/// the numbered one preferred so the order follows the numbering.
pub fn dedupe(items: &[TaskbarItem]) -> Vec<TaskbarItem> {
    let mut kept: Vec<(String, TaskbarItem)> = Vec::new();
    for item in items {
        let key = dedupe_key(item);
        match kept.iter_mut().find(|(k, _)| *k == key) {
            Some((_, current)) => {
                if is_numbered(&item.file) && !is_numbered(&current.file) {
                    *current = item.clone();
                }
            }
            None => kept.push((key, item.clone())),
        }
    }
    let mut out: Vec<TaskbarItem> = kept.into_iter().map(|(_, item)| item).collect();
    out.sort_by(|a, b| natural_cmp(&a.file, &b.file));
    out
}

/// The Windows Terminal shortcut points at an alias that runs as WindowsTerminal.
fn process_name(item: &TaskbarItem) -> Option<String> {
    if item.target.is_empty() {
        return None;
    }
    let base = item
        .target
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(&item.target);
    let lower = base.to_lowercase();
    let name = lower.strip_suffix(".exe").unwrap_or(&lower).to_owned();
    Some(if name == "wt" {
        "windowsterminal".into()
    } else {
        name
    })
}

pub fn to_apps(items: &[TaskbarItem], hidden: &[String]) -> Vec<App> {
    dedupe(items)
        .into_iter()
        .filter(|item| !hidden.contains(&item.id))
        .map(|item| App {
            name: display_name(&item.file),
            proc: process_name(&item),
            icon_version: item
                .icon_hash
                .as_deref()
                .map(|h| h.chars().take(8).collect())
                .unwrap_or_default(),
            id: item.id,
            lnk: item.lnk,
            has_icon: item.has_icon,
        })
        .collect()
}

/// The list kept on disk together with a signature of the pinned folder, so a restart starts with the last list at once and reads
/// the shortcuts again only when the folder changed (or when asked to).
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct Cache {
    pub signature: String,
    pub items: Vec<TaskbarItem>,
}

pub fn read_cache(file: &Path) -> Option<Cache> {
    serde_json::from_slice(&std::fs::read(file).ok()?).ok()
}

pub fn write_cache(file: &Path, cache: &Cache) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(
        file,
        serde_json::to_vec(cache).expect("a cache always serializes"),
    )
}

/// Names, sizes and times of the `.lnk` files of a folder, as one string: when it changes, the taskbar changed.
pub fn folder_signature(dir: &Path) -> String {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return "none".into();
    };
    let mut parts: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .to_lowercase()
                .ends_with(".lnk")
        })
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            let modified = meta
                .modified()
                .ok()?
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_millis();
            Some(format!(
                "{}|{}|{}",
                e.file_name().to_string_lossy(),
                meta.len(),
                modified
            ))
        })
        .collect();
    parts.sort();
    // what is read from a shortcut changed (a packaged app now gives its real program): a list cached before that is read again once
    parts.push("items: 2".into());
    sha1_hex(parts.join("\n").as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(file: &str, target: &str) -> TaskbarItem {
        TaskbarItem {
            id: id_of(file),
            file: file.into(),
            lnk: format!("C:\\TaskBar\\{file}"),
            target: target.into(),
            args: String::new(),
            has_icon: true,
            icon_hash: Some("abcdef0123456789".into()),
        }
    }

    #[test]
    fn ids_are_the_ones_the_node_agent_made() {
        // sha1("brave.lnk") first 10 hex characters
        assert_eq!(id_of("Brave.lnk"), id_of("brave.LNK"));
        assert_eq!(id_of("Brave.lnk").len(), 10);
        assert_eq!(
            &sha1_hex(b"abc")[..],
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
    }

    #[test]
    fn names_lose_the_extension_and_the_number() {
        assert_eq!(display_name("03 Discord.lnk"), "Discord");
        assert_eq!(display_name("Brave.LNK"), "Brave");
        assert_eq!(
            display_name("7zip.lnk"),
            "7zip",
            "a digit that is part of the name stays"
        );
        assert_eq!(
            display_name("12   Visual Studio Code.lnk"),
            "Visual Studio Code"
        );
    }

    #[test]
    fn a_numbered_shortcut_wins_over_a_plain_one_to_the_same_app() {
        let apps = to_apps(
            &[
                item("Brave.lnk", "C:\\b\\brave.exe"),
                item("02 Brave.lnk", "C:\\B\\Brave.exe"),
                item("01 Code.lnk", "C:\\c\\code.exe"),
            ],
            &[],
        );
        assert_eq!(
            apps.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(),
            ["Code", "Brave"]
        );
        assert_eq!(apps[1].proc.as_deref(), Some("brave"));
    }

    #[test]
    fn order_follows_the_numbers_not_the_letters() {
        assert_eq!(natural_cmp("2 a.lnk", "10 a.lnk"), Ordering::Less);
        assert_eq!(natural_cmp("b.lnk", "A.lnk"), Ordering::Greater);
        assert!(
            natural_cmp("02 x", "2 x").is_ne(),
            "ties are broken, never lost"
        );
    }

    #[test]
    fn hidden_apps_and_the_terminal_alias() {
        let items = [
            item("01 A.lnk", "C:\\a.exe"),
            item("02 Terminal.lnk", "C:\\Users\\x\\wt.exe"),
        ];
        let apps = to_apps(&items, &[items[0].id.clone()]);
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0].proc.as_deref(), Some("windowsterminal"));
        assert_eq!(apps[0].icon_version, "abcdef01");
    }

    #[test]
    fn shortcuts_without_a_target_are_compared_by_icon() {
        let a = item("Explorador de Arquivos.lnk", "");
        let b = item("02 File Explorer.lnk", "");
        assert_eq!(dedupe(&[a, b]).len(), 1);
    }

    #[test]
    fn a_packaged_app_is_recognised_by_its_shell_address() {
        assert_eq!(
            packaged_app(
                r"C:\WINDOWS\explorer.exe",
                r"shell:AppsFolder\Claude_pzs8sxrjxfjjc!Claude"
            ),
            Some(("Claude_pzs8sxrjxfjjc".into(), "Claude".into()))
        );
        assert_eq!(
            packaged_app(
                "explorer.exe",
                r#" "SHELL:appsfolder\Microsoft.WindowsTerminal_8wekyb3d8bbwe!App" "#
            ),
            Some((
                "Microsoft.WindowsTerminal_8wekyb3d8bbwe".into(),
                "App".into()
            ))
        );
        for (target, args) in [
            (r"C:\Apps\brave.exe", r"shell:AppsFolder\A_b!C"),
            (r"C:\WINDOWS\explorer.exe", ""),
            (r"C:\WINDOWS\explorer.exe", r"C:\Users"),
            (r"C:\WINDOWS\explorer.exe", r"shell:AppsFolder\NoBang"),
            (r"C:\WINDOWS\explorer.exe", r"shell:AppsFolder\..\x!y"),
            (r"C:\WINDOWS\explorer.exe", r"shell:AppsFolder\A_b!"),
        ] {
            assert_eq!(packaged_app(target, args), None, "{target} {args}");
        }
    }

    #[test]
    fn the_manifest_names_the_program_of_each_app() {
        let manifest = r#"<Package><Applications>
            <Application Id="Claude" Executable="app\Claude.exe" EntryPoint="Windows.FullTrustApplication">
              <Extensions><uap:Extension EntryId="x" Executable="app\other.exe"/></Extensions>
            </Application>
            <Application
                EntryPoint="Windows.FullTrustApplication"
                Executable = "app\resources\askpass.exe"
                Id = "SshAskpass"></Application>
            <Application Id="Up" Executable="..\evil.exe"/>
            <ApplicationExtra Id="Nope" Executable="no.exe"/>
        </Applications></Package>"#;
        assert_eq!(
            manifest_executable(manifest, "Claude").as_deref(),
            Some(r"app\Claude.exe")
        );
        assert_eq!(
            manifest_executable(manifest, "SshAskpass").as_deref(),
            Some(r"app\resources\askpass.exe")
        );
        for missing in ["Up", "Nope", "x", "claude", ""] {
            assert_eq!(manifest_executable(manifest, missing), None, "{missing}");
        }
    }
}
