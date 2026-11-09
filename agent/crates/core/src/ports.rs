//! What the PC offers, as traits. `platform-windows` implements them with the Windows APIs proved in the spike (ADR 0008); the tests, and the
//! agent's `--fake-platform` mode, implement them with in-memory fakes (see [`FakeAudio`]). The ports are added with their module (plan 3.2).
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

pub type PortResult<T> = Result<T, PortError>;

#[derive(Debug, thiserror::Error)]
pub enum PortError {
    #[error("{0}")]
    Failed(String),
    #[error("{0}")]
    NotFound(String),
}

/// 0 to 100
pub type Percent = u8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Volume {
    pub level: Percent,
    pub muted: bool,
}

/// The default recording device, for the header's mic button.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mic {
    pub available: bool,
    pub muted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter: Option<String>,
    pub default: bool,
    pub level: Percent,
    pub muted: bool,
}

/// One entry per process (browsers and games open several audio sessions).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioSession {
    pub pid: u32,
    pub system: bool,
    pub label: String,
    pub active: bool,
    pub level: Percent,
    pub muted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Devices {
    pub playback: Vec<AudioDevice>,
    pub capture: Vec<AudioDevice>,
}

/// How a request changes the mute of the output or the mic.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mute {
    Set(bool),
    Toggle,
}

/// Core Audio: the default output, the default input, every device and the per-app mixer. Methods are blocking (COM): the API calls them
/// from a blocking thread.
pub trait AudioPort: Send + Sync {
    fn volume(&self) -> PortResult<Volume>;
    /// Like the Windows slider: raising the volume leaves mute.
    fn set_volume(&self, level: Percent) -> PortResult<Volume>;
    fn set_mute(&self, mute: Mute) -> PortResult<Volume>;
    fn mic(&self) -> PortResult<Mic>;
    fn set_mic(&self, mute: Mute) -> PortResult<Mic>;
    fn devices(&self) -> PortResult<Devices>;
    fn sessions(&self) -> PortResult<Vec<AudioSession>>;
    fn set_default_device(&self, id: &str) -> PortResult<()>;
    fn set_device_volume(&self, id: &str, level: Percent) -> PortResult<()>;
    fn set_device_mute(&self, id: &str, muted: bool) -> PortResult<()>;
    fn set_session_volume(&self, pid: u32, system: bool, level: Percent) -> PortResult<()>;
    fn set_session_mute(&self, pid: u32, system: bool, muted: bool) -> PortResult<()>;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSession {
    pub id: String,
    pub app: String,
    pub status: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// seconds; null while the player does not say
    pub duration: Option<f64>,
    pub position: Option<f64>,
    pub can_play: bool,
    pub can_pause: bool,
    pub can_prev: bool,
    pub can_next: bool,
    pub can_seek: bool,
    pub has_art: bool,
    pub art_key: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct MediaState {
    pub current: Option<String>,
    pub sessions: Vec<MediaSession>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MediaAction {
    Toggle,
    Play,
    Pause,
    Next,
    Previous,
    /// seconds from the start of the track
    Seek(f64),
}

/// The image of a track: the bytes and, when Windows says so, their type (often empty: the API looks at the signature).
pub struct Art {
    pub mime: Option<String>,
    pub data: Vec<u8>,
}

/// SMTC: what the volume flyout shows (Spotify, a YouTube tab, VLC...).
pub trait MediaPort: Send + Sync {
    fn state(&self) -> PortResult<MediaState>;
    /// Whether the player accepted the command.
    fn control(&self, session: &str, action: MediaAction) -> PortResult<bool>;
    fn art(&self, session: &str) -> PortResult<Option<Art>>;
}

/// A player of mentira with one track, like `contracts/fixtures/fake-pc.json`.
pub struct FakeMedia {
    session: Mutex<MediaSession>,
}

impl Default for FakeMedia {
    fn default() -> Self {
        Self {
            session: Mutex::new(MediaSession {
                id: "s1".into(),
                app: "Spotify".into(),
                status: "playing".into(),
                title: "Uma faixa".into(),
                artist: "Banda".into(),
                album: "Disco".into(),
                duration: Some(215.0),
                position: Some(42.0),
                can_play: true,
                can_pause: true,
                can_prev: true,
                can_next: true,
                can_seek: true,
                has_art: true,
                art_key: "0123456789ab".into(),
            }),
        }
    }
}

impl MediaPort for FakeMedia {
    fn state(&self) -> PortResult<MediaState> {
        let session = self.session.lock().unwrap().clone();
        Ok(MediaState {
            current: Some(session.id.clone()),
            sessions: vec![session],
        })
    }

    fn control(&self, session: &str, action: MediaAction) -> PortResult<bool> {
        let mut current = self.session.lock().unwrap();
        if current.id != session {
            return Err(PortError::Failed("media session not found".into()));
        }
        match action {
            MediaAction::Toggle => {
                current.status = if current.status == "playing" {
                    "paused"
                } else {
                    "playing"
                }
                .into()
            }
            MediaAction::Play => current.status = "playing".into(),
            MediaAction::Pause => current.status = "paused".into(),
            MediaAction::Seek(seconds) => current.position = Some(seconds),
            MediaAction::Next | MediaAction::Previous => current.position = Some(0.0),
        }
        Ok(true)
    }

    fn art(&self, session: &str) -> PortResult<Option<Art>> {
        if self.session.lock().unwrap().id != session {
            return Err(PortError::Failed("media session not found".into()));
        }
        // a 1x1 PNG, no content type: the API has to sniff it
        const PNG: [u8; 12] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
        Ok(Some(Art {
            mime: None,
            data: PNG.to_vec(),
        }))
    }
}

/// The keyboard: presses a combination (every key in order, then released in reverse, like a person's hand does).
pub trait InputPort: Send + Sync {
    fn press_keys(&self, vks: &[u8]) -> PortResult<()>;
}

/// A keyboard that only remembers what was pressed.
#[derive(Default)]
pub struct FakeInput {
    pressed: Mutex<Vec<Vec<u8>>>,
}

impl FakeInput {
    pub fn pressed(&self) -> Vec<Vec<u8>> {
        self.pressed.lock().unwrap().clone()
    }
}

impl InputPort for FakeInput {
    fn press_keys(&self, vks: &[u8]) -> PortResult<()> {
        self.pressed.lock().unwrap().push(vks.to_vec());
        Ok(())
    }
}

/// The pinned taskbar shortcuts: reads them and writes one PNG icon per shortcut (`<id>.png`) to the icon folder.
pub trait TaskbarPort: Send + Sync {
    /// The folder whose changes mean the taskbar changed (`None`: nothing to watch).
    fn folder(&self) -> Option<std::path::PathBuf>;
    fn read(&self, icon_dir: &std::path::Path) -> PortResult<Vec<crate::taskbar::TaskbarItem>>;
    /// Starts the shortcut exactly like a click on the taskbar (arguments, "start in", elevation and shell: targets included).
    fn launch(&self, lnk: &str) -> PortResult<()>;
}

/// A taskbar of mentira: three shortcuts, the last one the Windows Terminal alias.
#[derive(Default)]
pub struct FakeTaskbar {
    launched: Mutex<Vec<String>>,
}

impl FakeTaskbar {
    pub fn launched(&self) -> Vec<String> {
        self.launched.lock().unwrap().clone()
    }
}

impl TaskbarPort for FakeTaskbar {
    fn launch(&self, lnk: &str) -> PortResult<()> {
        self.launched.lock().unwrap().push(lnk.to_owned());
        Ok(())
    }

    fn folder(&self) -> Option<std::path::PathBuf> {
        None
    }

    fn read(&self, icon_dir: &std::path::Path) -> PortResult<Vec<crate::taskbar::TaskbarItem>> {
        std::fs::create_dir_all(icon_dir).map_err(|e| PortError::Failed(e.to_string()))?;
        let item = |file: &str, target: &str| {
            let id = crate::taskbar::id_of(file);
            let png = [
                &[0x89u8, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a][..],
                file.as_bytes(),
            ]
            .concat();
            let _ = std::fs::write(icon_dir.join(format!("{id}.png")), &png);
            crate::taskbar::TaskbarItem {
                lnk: format!("C:\\TaskBar\\{file}"),
                file: file.into(),
                target: target.into(),
                args: String::new(),
                has_icon: true,
                icon_hash: Some(crate::sha1::sha1_hex(&png)),
                id,
            }
        };
        Ok(vec![
            item("01 Brave.lnk", "C:\\Brave\\brave.exe"),
            item("02 Code.lnk", "C:\\Code\\Code.exe"),
            item("03 Terminal.lnk", "C:\\Users\\x\\wt.exe"),
        ])
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Monitor {
    /// `\\.\DISPLAY1`; monitors are always sorted by it, so an index means the same thing everywhere
    pub device: String,
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
    pub primary: bool,
    /// 0 to 100 from DDC/CI, or null when it was not asked for or the screen cannot tell
    pub brightness: Option<Percent>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowAction {
    Focus,
    Minimize,
    Maximize,
    Restore,
    Close,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Zone {
    Left,
    Right,
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Projection {
    Extend,
    Clone,
    FirstOnly,
    SecondOnly,
}

/// The windows and the screens. Every action names a window by handle, and the platform only acts on a handle that is in the live list
/// (otherwise `NotFound("window not found")`): the phone cannot make this process touch an arbitrary window.
/// Called (from any thread, quickly) when something about the windows changed. The argument is true when only a title changed (a terminal's
/// spinner can do that many times a second): the caller may take its time over those.
pub type ChangeCallback = Arc<dyn Fn(bool) + Send + Sync>;

pub trait WindowsPort: Send + Sync {
    /// Pushes changes (focus, windows opening, closing, moving, renaming) instead of making the caller ask. The watch ends when the returned
    /// guard is dropped. `None`: this platform cannot, so the caller asks on a timer.
    fn watch(&self, _on_change: ChangeCallback) -> Option<Box<dyn Send>> {
        None
    }

    fn snapshot(&self) -> PortResult<crate::windows::WindowsSnapshot>;
    fn action(&self, handle: i64, action: WindowAction) -> PortResult<()>;
    fn move_to_monitor(&self, handle: i64, monitor: usize) -> PortResult<()>;
    fn place(&self, handle: i64, x: i32, y: i32) -> PortResult<()>;
    fn snap(&self, handle: i64, monitor: usize, zone: Zone) -> PortResult<()>;
    /// Brings the first window of a running program to the front; false when it has none.
    fn focus_process(&self, name: &str) -> PortResult<bool>;
    fn monitors(&self, brightness: bool) -> PortResult<Vec<Monitor>>;
    fn set_brightness(&self, device: &str, level: Percent) -> PortResult<()>;
    fn screens_off(&self) -> PortResult<()>;
    /// Windows' own projection switcher.
    fn project(&self, mode: Projection) -> PortResult<()>;
}

/// Two windows on two screens; remembers what it was asked to do.
pub struct FakeWindows {
    log: Mutex<Vec<String>>,
}

impl Default for FakeWindows {
    fn default() -> Self {
        Self {
            log: Mutex::new(Vec::new()),
        }
    }
}

impl FakeWindows {
    pub fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }

    fn known(&self, handle: i64) -> PortResult<()> {
        if self.snapshot()?.windows.iter().any(|w| w.handle == handle) {
            Ok(())
        } else {
            Err(PortError::NotFound("window not found".into()))
        }
    }

    fn note(&self, line: String) {
        self.log.lock().unwrap().push(line);
    }
}

impl WindowsPort for FakeWindows {
    fn snapshot(&self) -> PortResult<crate::windows::WindowsSnapshot> {
        use crate::windows::WindowInfo;
        let window = |handle: i64, name: &str, title: &str, monitor: i32| WindowInfo {
            handle,
            pid: handle as u32,
            title: title.into(),
            state: 0,
            monitor,
            x: 100,
            y: 100,
            w: 800,
            h: 600,
            name: name.into(),
        };
        Ok(crate::windows::WindowsSnapshot {
            running: vec!["brave".into(), "notepad".into(), "explorer".into()],
            windows: vec![
                window(101, "brave", "Nova guia - Brave", 0),
                window(102, "notepad", "a.txt - Bloco de Notas", 1),
            ],
        })
    }

    fn action(&self, handle: i64, action: WindowAction) -> PortResult<()> {
        self.known(handle)?;
        self.note(format!("{action:?} {handle}"));
        Ok(())
    }

    fn move_to_monitor(&self, handle: i64, monitor: usize) -> PortResult<()> {
        self.known(handle)?;
        if monitor >= 2 {
            return Err(PortError::Failed("unknown monitor index".into()));
        }
        self.note(format!("move {handle} {monitor}"));
        Ok(())
    }

    fn place(&self, handle: i64, x: i32, y: i32) -> PortResult<()> {
        self.known(handle)?;
        self.note(format!("place {handle} {x},{y}"));
        Ok(())
    }

    fn snap(&self, handle: i64, monitor: usize, zone: Zone) -> PortResult<()> {
        self.known(handle)?;
        self.note(format!("snap {handle} {monitor} {zone:?}"));
        Ok(())
    }

    fn focus_process(&self, name: &str) -> PortResult<bool> {
        let found = self.snapshot()?.windows.iter().any(|w| w.name == name);
        if found {
            self.note(format!("focus-process {name}"));
        }
        Ok(found)
    }

    fn monitors(&self, brightness: bool) -> PortResult<Vec<Monitor>> {
        let monitor = |device: &str, left: i32, primary: bool| Monitor {
            device: device.into(),
            left,
            top: 0,
            width: 1920,
            height: 1080,
            primary,
            brightness: brightness.then_some(60),
        };
        Ok(vec![
            monitor("\\\\.\\DISPLAY1", 0, true),
            monitor("\\\\.\\DISPLAY2", 1920, false),
        ])
    }

    fn set_brightness(&self, device: &str, level: Percent) -> PortResult<()> {
        self.note(format!("brightness {device} {level}"));
        Ok(())
    }

    fn screens_off(&self) -> PortResult<()> {
        self.note("screens-off".into());
        Ok(())
    }

    fn project(&self, mode: Projection) -> PortResult<()> {
        self.note(format!("project {mode:?}"));
        Ok(())
    }
}

/// Shutdown, restart, sleep... The rules (confirmation, delays, what is remembered) are in `power.rs`; this is only what Windows does.
pub trait PowerPort: Send + Sync {
    /// Uptime, the hibernation and fast-startup settings and whether a restart is pending.
    fn raw(&self) -> PortResult<crate::power::Raw>;
    /// `shutdown.exe` with these arguments.
    fn shutdown(&self, args: &[String]) -> PortResult<crate::power::CommandResult>;
    fn lock(&self) -> PortResult<()>;
    fn sleep(&self) -> PortResult<()>;
}

/// A PC that never turns off: it only remembers what it was asked (and can fail one call on purpose).
#[derive(Default)]
pub struct FakePower {
    calls: Mutex<Vec<String>>,
    failure: Option<(String, i32, String)>,
}

impl FakePower {
    /// The call `call` (as in `calls()`) gets this exit code and output.
    pub fn failing_with(call: &str, code: i32, output: &str) -> Self {
        Self {
            failure: Some((call.into(), code, output.into())),
            ..Self::default()
        }
    }

    pub fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

impl PowerPort for FakePower {
    fn raw(&self) -> PortResult<crate::power::Raw> {
        Ok(crate::power::Raw {
            uptime_sec: 3600,
            hibernate: Some(1),
            hiberboot: Some(1),
            reboot_pending: false,
        })
    }

    fn shutdown(&self, args: &[String]) -> PortResult<crate::power::CommandResult> {
        let call = format!("shutdown {}", args.join(" "));
        self.calls.lock().unwrap().push(call.clone());
        Ok(match &self.failure {
            Some((failing, code, output)) if *failing == call => crate::power::CommandResult {
                code: *code,
                output: output.clone(),
            },
            _ => crate::power::CommandResult {
                code: 0,
                output: String::new(),
            },
        })
    }

    fn lock(&self) -> PortResult<()> {
        self.calls.lock().unwrap().push("lock".into());
        Ok(())
    }

    fn sleep(&self) -> PortResult<()> {
        self.calls.lock().unwrap().push("sleep".into());
        Ok(())
    }
}

/// The numbers behind Desempenho, Processos and Sistema. Each answer is the JSON the page reads (the shapes are in `contracts/openapi.yaml`).
pub trait MonitorPort: Send + Sync {
    /// CPU, memory, GPU, frame rate, disks, network and uptime in one reading.
    fn sample(&self) -> PortResult<serde_json::Value>;
    /// The frame rate of the game being played, or null.
    fn fps(&self) -> PortResult<serde_json::Value>;
    /// The programs using most CPU and memory.
    fn processes(&self) -> PortResult<serde_json::Value>;
    /// The static description of the PC (slow to collect, it does not change while the agent runs).
    fn info(&self) -> PortResult<serde_json::Value>;
}

/// A PC whose numbers are the ones of `contracts/fixtures/fake-pc.json`.
#[derive(Default)]
pub struct FakeMonitor;

impl MonitorPort for FakeMonitor {
    fn sample(&self) -> PortResult<serde_json::Value> {
        Ok(serde_json::json!({
            "cpu": { "usage": 12.5, "cores": [10, 15], "freqMHz": 3600, "temp": null, "power": null, "tempSource": null, "processes": 200, "threads": 2500 },
            "memory": { "totalMB": 16384, "usedMB": 8192, "usedPct": 50, "commitUsedMB": 9000, "commitLimitMB": 20000 },
            "gpu": null, "fps": null,
            "disk": { "disks": [], "total": null, "drives": [{ "name": "C:", "label": "", "totalGB": 500, "freeGB": 250.5 }] },
            "network": [], "uptime": 3600
        }))
    }

    fn fps(&self) -> PortResult<serde_json::Value> {
        Ok(serde_json::Value::Null)
    }

    fn processes(&self) -> PortResult<serde_json::Value> {
        Ok(serde_json::json!({
            "cpu": [{ "name": "game", "cpu": 40.5, "memMB": 4096, "count": 1 }],
            "mem": [{ "name": "brave", "cpu": 3.0, "memMB": 2048, "count": 12 }]
        }))
    }

    fn info(&self) -> PortResult<serde_json::Value> {
        Ok(
            serde_json::json!({ "host": "FAKE-PC", "user": "fake", "os": { "name": "Windows", "version": "10", "build": "1", "arch": "64-bit", "installed": null, "lastBoot": null },
            "cpu": { "name": "Fake CPU", "cores": 2, "threads": 4, "maxMHz": 3600, "l2KB": 512, "l3KB": 4096, "socket": "AM5" },
            "memory": { "totalGB": 16, "modules": [] }, "gpus": [], "board": { "maker": "Fake", "model": "Board", "bios": "1", "biosDate": null },
            "storage": [], "drives": [], "network": [], "monitors": [] }),
        )
    }
}

/// An in-memory PC for the tests and `--fake-platform`: the same shape as `contracts/fixtures/fake-pc.json`.
pub struct FakeAudio {
    state: Mutex<FakeState>,
}

struct FakeState {
    volume: Volume,
    mic: Mic,
    devices: Devices,
    sessions: Vec<AudioSession>,
}

impl Default for FakeAudio {
    fn default() -> Self {
        let device = |id: &str, name: &str, default: bool, level: Percent| AudioDevice {
            id: id.into(),
            name: name.into(),
            adapter: Some("Fake".into()),
            default,
            level,
            muted: false,
        };
        let session = |pid: u32, system: bool, label: &str, active: bool| AudioSession {
            pid,
            system,
            label: label.into(),
            active,
            level: 100,
            muted: false,
        };
        Self {
            state: Mutex::new(FakeState {
                volume: Volume {
                    level: 30,
                    muted: false,
                },
                mic: Mic {
                    available: true,
                    muted: false,
                },
                devices: Devices {
                    playback: vec![
                        device("out1", "Alto-falantes", true, 40),
                        device("out2", "Fone Bluetooth", false, 70),
                    ],
                    capture: vec![device("in1", "Microfone", true, 80)],
                },
                sessions: vec![
                    session(0, true, "Sons do sistema", false),
                    session(11, false, "Spotify", true),
                ],
            }),
        }
    }
}

impl FakeAudio {
    fn with_device<T>(
        &self,
        id: &str,
        change: impl FnOnce(&mut AudioDevice) -> T,
    ) -> PortResult<T> {
        let mut guard = self.state.lock().unwrap();
        let state = &mut *guard;
        let devices = state
            .devices
            .playback
            .iter_mut()
            .chain(state.devices.capture.iter_mut());
        devices
            .into_iter()
            .find(|d| d.id == id)
            .map(change)
            .ok_or_else(|| PortError::NotFound("unknown device".into()))
    }
}

impl AudioPort for FakeAudio {
    fn volume(&self) -> PortResult<Volume> {
        Ok(self.state.lock().unwrap().volume)
    }
    fn set_volume(&self, level: Percent) -> PortResult<Volume> {
        let mut state = self.state.lock().unwrap();
        state.volume.level = level.min(100);
        if level > 0 {
            state.volume.muted = false;
        }
        Ok(state.volume)
    }
    fn set_mute(&self, mute: Mute) -> PortResult<Volume> {
        let mut state = self.state.lock().unwrap();
        state.volume.muted = match mute {
            Mute::Set(value) => value,
            Mute::Toggle => !state.volume.muted,
        };
        Ok(state.volume)
    }
    fn mic(&self) -> PortResult<Mic> {
        Ok(self.state.lock().unwrap().mic)
    }
    fn set_mic(&self, mute: Mute) -> PortResult<Mic> {
        let mut state = self.state.lock().unwrap();
        state.mic.muted = match mute {
            Mute::Set(value) => value,
            Mute::Toggle => !state.mic.muted,
        };
        Ok(state.mic)
    }
    fn devices(&self) -> PortResult<Devices> {
        Ok(self.state.lock().unwrap().devices.clone())
    }
    fn sessions(&self) -> PortResult<Vec<AudioSession>> {
        Ok(self.state.lock().unwrap().sessions.clone())
    }
    fn set_default_device(&self, id: &str) -> PortResult<()> {
        let mut state = self.state.lock().unwrap();
        let list = if state.devices.playback.iter().any(|d| d.id == id) {
            &mut state.devices.playback
        } else {
            &mut state.devices.capture
        };
        if !list.iter().any(|d| d.id == id) {
            return Err(PortError::NotFound("unknown device".into()));
        }
        for device in list.iter_mut() {
            device.default = device.id == id;
        }
        Ok(())
    }
    fn set_device_volume(&self, id: &str, level: Percent) -> PortResult<()> {
        self.with_device(id, |d| {
            d.level = level.min(100);
            if level > 0 {
                d.muted = false;
            }
        })
    }
    fn set_device_mute(&self, id: &str, muted: bool) -> PortResult<()> {
        self.with_device(id, |d| d.muted = muted)
    }
    fn set_session_volume(&self, pid: u32, system: bool, level: Percent) -> PortResult<()> {
        let mut state = self.state.lock().unwrap();
        for s in state.sessions.iter_mut().filter(|s| {
            if system {
                s.system
            } else {
                !s.system && s.pid == pid
            }
        }) {
            s.level = level.min(100);
        }
        Ok(())
    }
    fn set_session_mute(&self, pid: u32, system: bool, muted: bool) -> PortResult<()> {
        let mut state = self.state.lock().unwrap();
        for s in state.sessions.iter_mut().filter(|s| {
            if system {
                s.system
            } else {
                !s.system && s.pid == pid
            }
        }) {
            s.muted = muted;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raising_the_volume_leaves_mute_and_zero_keeps_it() {
        let audio = FakeAudio::default();
        audio.set_mute(Mute::Set(true)).unwrap();
        assert!(audio.set_volume(0).unwrap().muted);
        assert_eq!(
            audio.set_volume(55).unwrap(),
            Volume {
                level: 55,
                muted: false
            }
        );
    }

    #[test]
    fn toggling_twice_comes_back() {
        let audio = FakeAudio::default();
        assert!(audio.set_mic(Mute::Toggle).unwrap().muted);
        assert!(!audio.set_mic(Mute::Toggle).unwrap().muted);
    }

    #[test]
    fn an_unknown_device_is_not_found_and_the_default_moves() {
        let audio = FakeAudio::default();
        assert!(matches!(
            audio.set_default_device("nope"),
            Err(PortError::NotFound(_))
        ));
        audio.set_default_device("out2").unwrap();
        let playback = audio.devices().unwrap().playback;
        assert!(!playback[0].default && playback[1].default);
    }
}
