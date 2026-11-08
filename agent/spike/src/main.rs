//! Spike 3.0 (docs/plano-reestruturacao.md): can Rust reach the three risky Windows APIs the Node agent gets through C# helpers?
//! Read-only on purpose: it never changes the volume, the default device or the player.
//!   (a) Core Audio: default output volume / mute, the per-app sessions (the mixer) and the creation of the policy-config object that
//!       switches the default device (an undocumented interface: only created here, never called).
//!   (b) SMTC (what the volume flyout shows): the sessions and the title of what is playing.
//!   (c) SetWinEventHook: foreground / create / destroy / name-change events pushed to a callback on a message loop.
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use windows::core::{Interface, GUID, PWSTR};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
    MMDeviceEnumerator,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, MsgWaitForMultipleObjectsEx, PeekMessageW, TranslateMessage,
    EVENT_OBJECT_CREATE, EVENT_OBJECT_DESTROY, EVENT_OBJECT_NAMECHANGE, EVENT_SYSTEM_FOREGROUND,
    MSG, MWMO_INPUTAVAILABLE, PM_REMOVE, QS_ALLINPUT, WINEVENT_OUTOFCONTEXT,
    WINEVENT_SKIPOWNPROCESS,
};

static FOREGROUND: AtomicU32 = AtomicU32::new(0);
static CREATED: AtomicU32 = AtomicU32::new(0);
static DESTROYED: AtomicU32 = AtomicU32::new(0);
static RENAMED: AtomicU32 = AtomicU32::new(0);

unsafe extern "system" fn on_event(
    _: HWINEVENTHOOK,
    event: u32,
    _hwnd: windows::Win32::Foundation::HWND,
    id_object: i32,
    _child: i32,
    _thread: u32,
    _time: u32,
) {
    if id_object != 0 {
        return; // OBJID_WINDOW only: the window itself, not its parts
    }
    match event {
        EVENT_SYSTEM_FOREGROUND => FOREGROUND.fetch_add(1, Ordering::Relaxed),
        EVENT_OBJECT_CREATE => CREATED.fetch_add(1, Ordering::Relaxed),
        EVENT_OBJECT_DESTROY => DESTROYED.fetch_add(1, Ordering::Relaxed),
        EVENT_OBJECT_NAMECHANGE => RENAMED.fetch_add(1, Ordering::Relaxed),
        _ => 0,
    };
}

fn audio() -> windows::core::Result<()> {
    unsafe {
        let started = Instant::now();
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let volume: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None)?;
        println!(
            "[audio] default output: volume {:.0} %, muted {}",
            volume.GetMasterVolumeLevelScalar()? * 100.0,
            volume.GetMute()?.as_bool()
        );

        let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
        let sessions = manager.GetSessionEnumerator()?;
        let count = sessions.GetCount()?;
        println!("[audio] {count} audio sessions (the mixer):");
        for index in 0..count {
            let control = sessions.GetSession(index)?;
            let control2: IAudioSessionControl2 = control.cast()?;
            let pid = control2.GetProcessId()?;
            let system = control2.IsSystemSoundsSession().is_ok();
            let name = control
                .GetDisplayName()
                .ok()
                .filter(|p: &PWSTR| !p.is_null())
                .and_then(|p| p.to_string().ok())
                .unwrap_or_default();
            println!("          pid {pid:>6}  system-sounds {system}  display '{name}'");
        }
        // the interface that switches the default device is undocumented (IPolicyConfig): prove it can be created, never call it
        let policy_config = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);
        let created: windows::core::Result<windows::core::IUnknown> =
            CoCreateInstance(&policy_config, None, CLSCTX_ALL);
        println!(
            "[audio] PolicyConfigClient (switches the default device): {}",
            if created.is_ok() {
                "created, usable through a hand-written vtable"
            } else {
                "NOT available"
            }
        );
        println!("[audio] done in {} ms", started.elapsed().as_millis());
    }
    Ok(())
}

fn media() -> windows::core::Result<()> {
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager as Manager;
    let started = Instant::now();
    let manager = Manager::RequestAsync()?.get()?;
    let sessions = manager.GetSessions()?;
    println!("[media] {} SMTC sessions", sessions.Size()?);
    for session in sessions {
        let id = session.SourceAppUserModelId()?;
        let props = session.TryGetMediaPropertiesAsync()?.get()?;
        let playback = session.GetPlaybackInfo()?;
        println!(
            "          {id}: '{}' - '{}' ({:?}), can pause: {}",
            props.Artist()?,
            props.Title()?,
            playback.PlaybackStatus()?,
            playback.Controls()?.IsPauseEnabled()?
        );
    }
    println!("[media] done in {} ms", started.elapsed().as_millis());
    Ok(())
}

fn window_events(seconds: u64) {
    unsafe {
        let flags = WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS;
        let hooks = [
            SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                None,
                Some(on_event),
                0,
                0,
                flags,
            ),
            SetWinEventHook(
                EVENT_OBJECT_CREATE,
                EVENT_OBJECT_NAMECHANGE,
                None,
                Some(on_event),
                0,
                0,
                flags,
            ),
        ];
        println!("[windows] hooks installed: {}; listening {seconds} s (switch windows, open or close something)...", hooks.iter().all(|h| !h.is_invalid()));
        let until = Instant::now() + Duration::from_secs(seconds);
        let mut message = MSG::default();
        while Instant::now() < until {
            MsgWaitForMultipleObjectsEx(None, 200, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
            while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        for hook in hooks {
            let _ = UnhookWinEvent(hook);
        }
        println!(
            "[windows] events in {seconds} s: foreground {}, created {}, destroyed {}, renamed {}",
            FOREGROUND.load(Ordering::Relaxed),
            CREATED.load(Ordering::Relaxed),
            DESTROYED.load(Ordering::Relaxed),
            RENAMED.load(Ordering::Relaxed)
        );
    }
}

fn main() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    if let Err(error) = audio() {
        println!("[audio] FAILED: {error}");
    }
    if let Err(error) = media() {
        println!("[media] FAILED: {error}");
    }
    window_events(8);
}
