//! Core Audio for the `AudioPort`: the default output and input, every active device, and the per-application mixer. The same behavior as
//! `legacy/server/native/DeckNative.cs` + `InputOps.cs` (ADR 0008): devices are named by the registry's `DeviceDesc`, sessions are grouped
//! by process and labelled with the program's file description, "default" is the console role, and setting the default also sets the
//! multimedia role (the communications role is left alone).
#![allow(non_snake_case)] // the COM interface below keeps Windows' own method names
use std::ffi::c_void;

use ssd_core::ports::{
    AudioDevice, AudioPort, AudioSession, Devices, Mic, Mute, Percent, PortError, PortResult,
    Volume,
};
use windows::core::{interface, IUnknown, Interface, GUID, HRESULT, PCWSTR, PWSTR};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eRender, EDataFlow, IAudioSessionControl2, IAudioSessionManager2,
    IMMDevice, IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
};
use windows::Win32::System::Com::StructuredStorage::PropVariantToStringAlloc;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY;
#[allow(unused_imports)]
use windows_core::IUnknown_Vtbl;

/// Undocumented but stable since Windows 7: the interface the Sound control panel uses to change the default device.
/// Only `SetDefaultEndpoint` is called; the others are there to keep the vtable in order.
#[interface("f8679f50-850a-41cf-9c72-430f290290c8")]
unsafe trait IPolicyConfig: IUnknown {
    fn GetMixFormat(&self, name: PCWSTR, format: *mut c_void) -> HRESULT;
    fn GetDeviceFormat(&self, name: PCWSTR, default: i32, format: *mut c_void) -> HRESULT;
    fn ResetDeviceFormat(&self, name: PCWSTR) -> HRESULT;
    fn SetDeviceFormat(&self, name: PCWSTR, endpoint: *mut c_void, mix: *mut c_void) -> HRESULT;
    fn GetProcessingPeriod(&self, name: PCWSTR, default: i32, a: *mut i64, b: *mut i64) -> HRESULT;
    fn SetProcessingPeriod(&self, name: PCWSTR, period: *mut i64) -> HRESULT;
    fn GetShareMode(&self, name: PCWSTR, mode: *mut c_void) -> HRESULT;
    fn SetShareMode(&self, name: PCWSTR, mode: *mut c_void) -> HRESULT;
    fn GetPropertyValue(
        &self,
        name: PCWSTR,
        fx: i32,
        key: *const c_void,
        value: *mut c_void,
    ) -> HRESULT;
    fn SetPropertyValue(
        &self,
        name: PCWSTR,
        fx: i32,
        key: *const c_void,
        value: *const c_void,
    ) -> HRESULT;
    fn SetDefaultEndpoint(&self, name: PCWSTR, role: i32) -> HRESULT;
    fn SetEndpointVisibility(&self, name: PCWSTR, visible: i32) -> HRESULT;
}

const POLICY_CONFIG_CLIENT: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);
const DEVICE_DESC: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
    pid: 2,
};
const INTERFACE_NAME: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0xb3f8fa53_0004_438e_9003_51a46e139bfc),
    pid: 6,
};

fn failed(error: windows::core::Error) -> PortError {
    PortError::Failed(error.message())
}

/// COM must be initialised once on every thread that calls it; the API calls this crate from a pool of blocking threads.
pub(crate) fn com() {
    thread_local! { static INIT: () = unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }; }
    // The pool's threads come and go (Tokio lets idle ones end), and the multithreaded apartment lives only while some thread keeps it:
    // when the last one was gone, what WinRT had cached (a class factory) was torn down under it, and the next call crashed the agent
    // (access violation in `UserNotificationListener::Current`, seen once). This keeps the apartment for as long as the process lives.
    static KEEP_APARTMENT: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    KEEP_APARTMENT.get_or_init(|| unsafe {
        let _ = windows::Win32::System::Com::CoIncrementMTAUsage();
    });
    INIT.with(|_| {});
}

fn text(pointer: PWSTR) -> String {
    unsafe {
        let value = pointer.to_string().unwrap_or_default();
        CoTaskMemFree(Some(pointer.0 as *const c_void));
        value
    }
}

fn enumerator() -> PortResult<IMMDeviceEnumerator> {
    com();
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(failed) }
}

fn default_device(flow: EDataFlow) -> PortResult<IMMDevice> {
    unsafe {
        enumerator()?
            .GetDefaultAudioEndpoint(flow, eConsole)
            .map_err(failed)
    }
}

fn device_by_id(id: &str) -> PortResult<IMMDevice> {
    let wide: Vec<u16> = id.encode_utf16().chain(Some(0)).collect();
    unsafe {
        enumerator()?
            .GetDevice(PCWSTR(wide.as_ptr()))
            .map_err(|_| PortError::NotFound("unknown device".into()))
    }
}

fn id_of(device: &IMMDevice) -> PortResult<String> {
    unsafe { Ok(text(device.GetId().map_err(failed)?)) }
}

fn endpoint_volume(device: &IMMDevice) -> PortResult<IAudioEndpointVolume> {
    unsafe {
        device
            .Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
            .map_err(failed)
    }
}

fn percent_of(scalar: f32) -> Percent {
    (scalar * 100.0).round().clamp(0.0, 100.0) as Percent
}

fn read_level(device: &IMMDevice) -> PortResult<Volume> {
    let volume = endpoint_volume(device)?;
    unsafe {
        Ok(Volume {
            level: percent_of(volume.GetMasterVolumeLevelScalar().map_err(failed)?),
            muted: volume.GetMute().map_err(failed)?.as_bool(),
        })
    }
}

fn write_level(device: &IMMDevice, level: Percent) -> PortResult<()> {
    let volume = endpoint_volume(device)?;
    unsafe {
        volume
            .SetMasterVolumeLevelScalar(f32::from(level.min(100)) / 100.0, &GUID::zeroed())
            .map_err(failed)?;
        // like the Windows slider: raising the volume leaves mute
        if level > 0 && volume.GetMute().map_err(failed)?.as_bool() {
            volume.SetMute(false, &GUID::zeroed()).map_err(failed)?;
        }
    }
    Ok(())
}

fn write_mute(device: &IMMDevice, mute: Mute) -> PortResult<bool> {
    let volume = endpoint_volume(device)?;
    unsafe {
        let next = match mute {
            Mute::Set(value) => value,
            Mute::Toggle => !volume.GetMute().map_err(failed)?.as_bool(),
        };
        volume.SetMute(next, &GUID::zeroed()).map_err(failed)?;
        Ok(next)
    }
}

fn property(device: &IMMDevice, key: &PROPERTYKEY) -> Option<String> {
    unsafe {
        let store = device.OpenPropertyStore(STGM_READ).ok()?;
        let value = store.GetValue(key).ok()?;
        let pointer = PropVariantToStringAlloc(&value).ok()?;
        let text = text(pointer);
        (!text.is_empty()).then_some(text)
    }
}

fn describe(device: &IMMDevice, default_id: &str) -> PortResult<AudioDevice> {
    let id = id_of(device)?;
    // a device whose volume cannot be read (a disconnected jack) is still listed, at zero, like the Node agent did
    let level = read_level(device).unwrap_or(Volume {
        level: 0,
        muted: false,
    });
    Ok(AudioDevice {
        name: property(device, &DEVICE_DESC).unwrap_or_else(|| id.clone()),
        adapter: property(device, &INTERFACE_NAME),
        default: id == default_id,
        id,
        level: level.level,
        muted: level.muted,
    })
}

fn list(flow: EDataFlow) -> PortResult<Vec<AudioDevice>> {
    let default_id = default_device(flow)
        .and_then(|d| id_of(&d))
        .unwrap_or_default();
    unsafe {
        let collection = enumerator()?
            .EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE)
            .map_err(failed)?;
        let count = collection.GetCount().map_err(failed)?;
        (0..count)
            .map(|i| describe(&collection.Item(i).map_err(failed)?, &default_id))
            .collect()
    }
}

/// The program's name as a person reads it: the file description of the executable, else the file name without `.exe`.
fn process_label(pid: u32) -> String {
    let fallback = || format!("PID {pid}");
    unsafe {
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return fallback();
        };
        let mut buffer = [0u16; 1024];
        let mut length = buffer.len() as u32;
        let path = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
        .ok()
        .map(|_| String::from_utf16_lossy(&buffer[..length as usize]));
        let _ = CloseHandle(process);
        let Some(path) = path else { return fallback() };
        let stem = std::path::Path::new(&path)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(fallback);
        file_description(&path).unwrap_or(stem)
    }
}

fn file_description(path: &str) -> Option<String> {
    let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    unsafe {
        let size = GetFileVersionInfoSizeW(PCWSTR(wide.as_ptr()), None);
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(
            PCWSTR(wide.as_ptr()),
            0,
            size,
            data.as_mut_ptr() as *mut c_void,
        )
        .ok()?;
        let query = |sub_block: &str| -> Option<(*const c_void, u32)> {
            let sub: Vec<u16> = sub_block.encode_utf16().chain(Some(0)).collect();
            let (mut pointer, mut length) = (std::ptr::null_mut::<c_void>(), 0u32);
            VerQueryValueW(
                data.as_ptr() as *const c_void,
                PCWSTR(sub.as_ptr()),
                &mut pointer,
                &mut length,
            )
            .as_bool()
            .then_some((pointer as *const c_void, length))
        };
        // the languages the file declares, in the order it declares them (the first is the one .NET's FileVersionInfo reads)
        let (translation, length) = query("\\VarFileInfo\\Translation")?;
        let count = (length / 4) as usize;
        if count == 0 {
            return None;
        }
        let pairs = std::slice::from_raw_parts(translation as *const u16, count * 2);
        let order: Vec<(u16, u16)> = pairs.chunks(2).map(|p| (p[0], p[1])).collect();
        order.into_iter().find_map(|(language, code_page)| {
            let (value, length) = query(&format!(
                "\\StringFileInfo\\{language:04x}{code_page:04x}\\FileDescription"
            ))?;
            // the value is a NUL-terminated string inside a longer block: stop at the first NUL
            let raw = std::slice::from_raw_parts(value as *const u16, length as usize);
            let end = raw.iter().position(|&c| c == 0).unwrap_or(raw.len());
            let description = String::from_utf16_lossy(&raw[..end]).trim().to_owned();
            (!description.is_empty()).then_some(description)
        })
    }
}

struct RawSession {
    control: IAudioSessionControl2,
    volume: ISimpleAudioVolume,
    pid: u32,
    system: bool,
    state: i32,
}

fn raw_sessions() -> PortResult<Vec<RawSession>> {
    unsafe {
        let manager = default_device(eRender)?
            .Activate::<IAudioSessionManager2>(CLSCTX_ALL, None)
            .map_err(failed)?;
        let sessions = manager.GetSessionEnumerator().map_err(failed)?;
        let count = sessions.GetCount().map_err(failed)?;
        let mut out = Vec::new();
        for index in 0..count {
            let control = sessions.GetSession(index).map_err(failed)?;
            let control2: IAudioSessionControl2 = control.cast().map_err(failed)?;
            out.push(RawSession {
                pid: control2.GetProcessId().unwrap_or(0),
                // S_OK means "this is the system sounds session"; S_FALSE (also a success code for windows-rs) means it is not
                system: control2.IsSystemSoundsSession() == HRESULT(0),
                state: control2.GetState().map_err(failed)?.0,
                volume: control.cast().map_err(failed)?,
                control: control2,
            });
        }
        Ok(out)
    }
}

fn each_session(
    pid: u32,
    system: bool,
    mut action: impl FnMut(&ISimpleAudioVolume) -> windows::core::Result<()>,
) -> PortResult<()> {
    for session in raw_sessions()? {
        let wanted = if system {
            session.system
        } else {
            !session.system && session.pid == pid
        };
        if wanted {
            action(&session.volume).map_err(failed)?;
        }
    }
    Ok(())
}

/// Windows' own Core Audio, one COM call at a time (cheap: the spike measured 11 ms for a full read).
#[derive(Default)]
pub struct WindowsAudio;

impl AudioPort for WindowsAudio {
    fn volume(&self) -> PortResult<Volume> {
        read_level(&default_device(eRender)?)
    }

    fn set_volume(&self, level: Percent) -> PortResult<Volume> {
        let device = default_device(eRender)?;
        write_level(&device, level)?;
        read_level(&device)
    }

    fn set_mute(&self, mute: Mute) -> PortResult<Volume> {
        let device = default_device(eRender)?;
        write_mute(&device, mute)?;
        read_level(&device)
    }

    fn mic(&self) -> PortResult<Mic> {
        Ok(
            match default_device(eCapture).and_then(|d| read_level(&d)) {
                Ok(volume) => Mic {
                    available: true,
                    muted: volume.muted,
                },
                Err(_) => Mic {
                    available: false,
                    muted: false,
                },
            },
        )
    }

    fn set_mic(&self, mute: Mute) -> PortResult<Mic> {
        let muted = write_mute(&default_device(eCapture)?, mute)?;
        Ok(Mic {
            available: true,
            muted,
        })
    }

    fn devices(&self) -> PortResult<Devices> {
        Ok(Devices {
            playback: list(eRender)?,
            capture: list(eCapture).unwrap_or_default(),
        })
    }

    fn sessions(&self) -> PortResult<Vec<AudioSession>> {
        // one entry per process: browsers and games open several audio sessions
        let mut entries: Vec<AudioSession> = Vec::new();
        for raw in raw_sessions()? {
            if raw.state == 2 {
                continue; // expired
            }
            let (level, muted) = unsafe {
                (
                    percent_of(raw.volume.GetMasterVolume().map_err(failed)?),
                    raw.volume.GetMute().map_err(failed)?.as_bool(),
                )
            };
            let active = raw.state == 1;
            match entries.iter_mut().find(|e| {
                if raw.system {
                    e.system
                } else {
                    !e.system && e.pid == raw.pid
                }
            }) {
                Some(entry) => entry.active |= active,
                None => {
                    let label = if raw.system {
                        "Sons do sistema".to_owned()
                    } else {
                        process_label(raw.pid)
                    };
                    entries.push(AudioSession {
                        pid: if raw.system { 0 } else { raw.pid },
                        system: raw.system,
                        label,
                        active,
                        level,
                        muted,
                    });
                }
            }
            let _ = &raw.control;
        }
        entries.sort_by(|a, b| {
            b.active
                .cmp(&a.active)
                .then_with(|| a.label.to_lowercase().cmp(&b.label.to_lowercase()))
        });
        Ok(entries)
    }

    fn set_default_device(&self, id: &str) -> PortResult<()> {
        device_by_id(id)?;
        com();
        let wide: Vec<u16> = id.encode_utf16().chain(Some(0)).collect();
        unsafe {
            let policy: IPolicyConfig =
                CoCreateInstance(&POLICY_CONFIG_CLIENT, None, CLSCTX_ALL).map_err(failed)?;
            // console + multimedia, exactly what "Set as Default Device" does in the Sound control panel
            for role in 0..2 {
                let result = policy.SetDefaultEndpoint(PCWSTR(wide.as_ptr()), role);
                if result.is_err() {
                    return Err(PortError::Failed(
                        windows::core::Error::from(result).message(),
                    ));
                }
            }
        }
        Ok(())
    }

    fn set_device_volume(&self, id: &str, level: Percent) -> PortResult<()> {
        write_level(&device_by_id(id)?, level)
    }

    fn set_device_mute(&self, id: &str, muted: bool) -> PortResult<()> {
        write_mute(&device_by_id(id)?, Mute::Set(muted)).map(|_| ())
    }

    fn set_session_volume(&self, pid: u32, system: bool, level: Percent) -> PortResult<()> {
        let scalar = f32::from(level.min(100)) / 100.0;
        each_session(pid, system, |volume| unsafe {
            volume.SetMasterVolume(scalar, &GUID::zeroed())
        })
    }

    fn set_session_mute(&self, pid: u32, system: bool, muted: bool) -> PortResult<()> {
        each_session(pid, system, |volume| unsafe {
            volume.SetMute(muted, &GUID::zeroed())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Read-only against this PC's real audio (a CI machine without an audio device just has nothing to list).
    #[test]
    fn reading_the_real_audio_state_works_and_is_consistent() {
        let audio = WindowsAudio;
        if let Ok(volume) = audio.volume() {
            assert!(volume.level <= 100);
            let devices = audio.devices().expect("the device list");
            assert!(devices.playback.iter().filter(|d| d.default).count() <= 1);
            assert!(devices
                .playback
                .iter()
                .all(|d| !d.id.is_empty() && !d.name.is_empty() && d.level <= 100));
            for session in audio.sessions().expect("the sessions") {
                assert!(session.level <= 100 && !session.label.is_empty());
            }
        }
    }

    #[test]
    fn an_unknown_device_is_not_found() {
        assert!(matches!(
            WindowsAudio.set_device_mute("{0.0.0.00000000}.{nope}", true),
            Err(PortError::NotFound(_)) | Err(PortError::Failed(_))
        ));
    }
}
