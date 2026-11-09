//! What the PC offers, as traits. `platform-windows` implements them with the Windows APIs proved in the spike (ADR 0008); the tests, and the
//! agent's `--fake-platform` mode, implement them with in-memory fakes (see [`FakeAudio`]). The ports are added with their module (plan 3.2).
use std::sync::Mutex;

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
}

/// A taskbar of mentira: three shortcuts, the last one the Windows Terminal alias.
#[derive(Default)]
pub struct FakeTaskbar;

impl TaskbarPort for FakeTaskbar {
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
