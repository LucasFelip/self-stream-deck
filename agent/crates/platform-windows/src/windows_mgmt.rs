//! Windows and screens for the `WindowsPort`: which windows a person would see in Alt+Tab, where they are, and what can be done to them
//! (focus, minimize, maximize, restore, close, move to another screen, place, snap to a half) plus the monitors (geometry, DDC/CI
//! brightness, off, projection mode). The same rules as `legacy/server/native/DeckNative.cs`; the handles an action may touch are only
//! the ones in the live list.
use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::sync::{Mutex, Once};

use ssd_core::ports::{
    ChangeCallback, Monitor, Percent, PortError, PortResult, Projection, WindowAction, WindowsPort,
    Zone,
};
use ssd_core::windows::{WindowInfo, WindowsSnapshot};
use windows::Win32::Devices::Display::{
    DestroyPhysicalMonitor, GetMonitorBrightness, GetNumberOfPhysicalMonitorsFromHMONITOR,
    GetPhysicalMonitorsFromHMONITOR, SetMonitorBrightness, PHYSICAL_MONITOR,
};
use windows::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, RECT, TRUE, WPARAM};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, MonitorFromWindow, HDC, HMONITOR, MONITORINFO,
    MONITORINFOEXW, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::Input::KeyboardAndMouse::{keybd_event, KEYEVENTF_KEYUP};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, EnumWindows, GetMessageW, GetWindow, GetWindowLongW, GetWindowRect,
    GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
    IsZoomed, PeekMessageW, PostMessageW, PostThreadMessageW, SetForegroundWindow,
    SetProcessDPIAware, SetWindowPos, ShowWindow, TranslateMessage, EVENT_OBJECT_CREATE,
    EVENT_OBJECT_NAMECHANGE, EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_MINIMIZEEND,
    EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MOVESIZEEND, GWL_EXSTYLE, GW_OWNER, MSG, PM_NOREMOVE,
    SWP_NOACTIVATE, SWP_NOZORDER, SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE, WINEVENT_OUTOFCONTEXT,
    WINEVENT_SKIPOWNPROCESS, WM_QUIT, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
};

fn hwnd(handle: i64) -> HWND {
    HWND(handle as isize as *mut c_void)
}

fn dpi_aware() {
    static ONCE: Once = Once::new();
    // so every rectangle is in real pixels on every screen
    ONCE.call_once(|| unsafe {
        let _ = SetProcessDPIAware();
    });
}

fn text_of(buffer: &[u16]) -> String {
    let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
}

// ---- processes -----------------------------------------------------------------------------------------------------------------------

/// pid to process name ("brave"), lower case, without ".exe" (what .NET's `ProcessName` gives).
fn process_names() -> HashMap<u32, String> {
    let mut names = HashMap::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return names;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
        while more {
            let file = text_of(&entry.szExeFile).to_lowercase();
            names.insert(
                entry.th32ProcessID,
                file.strip_suffix(".exe").map(str::to_owned).unwrap_or(file),
            );
            more = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
    }
    names
}

// ---- monitors ------------------------------------------------------------------------------------------------------------------------

struct Screen {
    handle: HMONITOR,
    device: String,
    full: RECT,
    work: RECT,
    primary: bool,
}

unsafe extern "system" fn collect_monitor(
    monitor: HMONITOR,
    _: HDC,
    _: *mut RECT,
    data: LPARAM,
) -> BOOL {
    let found = &mut *(data.0 as *mut Vec<Screen>);
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    if GetMonitorInfoW(
        monitor,
        &mut info as *mut MONITORINFOEXW as *mut MONITORINFO,
    )
    .as_bool()
    {
        found.push(Screen {
            handle: monitor,
            device: text_of(&info.szDevice),
            full: info.monitorInfo.rcMonitor,
            work: info.monitorInfo.rcWork,
            primary: info.monitorInfo.dwFlags & 1 != 0,
        });
    }
    TRUE
}

/// Always sorted by device name (`\\.\DISPLAY1`, `\\.\DISPLAY2`...), so an index means the same thing everywhere.
fn screens() -> Vec<Screen> {
    dpi_aware();
    let mut found: Vec<Screen> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(
            HDC::default(),
            None,
            Some(collect_monitor),
            LPARAM(&mut found as *mut Vec<Screen> as isize),
        );
    }
    found.sort_by(|a, b| a.device.cmp(&b.device));
    found
}

fn device_of(monitor: HMONITOR) -> String {
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    unsafe {
        if GetMonitorInfoW(
            monitor,
            &mut info as *mut MONITORINFOEXW as *mut MONITORINFO,
        )
        .as_bool()
        {
            return text_of(&info.szDevice);
        }
    }
    String::new()
}

/// The physical monitors behind a screen (DDC/CI talks to those), released by the caller.
unsafe fn physical(monitor: HMONITOR) -> Vec<PHYSICAL_MONITOR> {
    let mut count = 0u32;
    if GetNumberOfPhysicalMonitorsFromHMONITOR(monitor, &mut count).is_err() || count == 0 {
        return Vec::new();
    }
    let mut list = vec![PHYSICAL_MONITOR::default(); count as usize];
    if GetPhysicalMonitorsFromHMONITOR(monitor, &mut list).is_err() {
        return Vec::new();
    }
    list
}

unsafe fn release(list: &[PHYSICAL_MONITOR]) {
    for monitor in list {
        let _ = DestroyPhysicalMonitor(monitor.hPhysicalMonitor);
    }
}

// ---- windows -------------------------------------------------------------------------------------------------------------------------

unsafe extern "system" fn collect_window(window: HWND, data: LPARAM) -> BOOL {
    (*(data.0 as *mut Vec<HWND>)).push(window);
    TRUE
}

/// The rectangle the user sees. `GetWindowRect` also includes the invisible resize borders Windows 10/11 adds.
fn visible_frame(window: HWND) -> Option<RECT> {
    let mut frame = RECT::default();
    unsafe {
        if DwmGetWindowAttribute(
            window,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut frame as *mut RECT as *mut c_void,
            std::mem::size_of::<RECT>() as u32,
        )
        .is_ok()
        {
            return Some(frame);
        }
        GetWindowRect(window, &mut frame).ok().map(|_| frame)
    }
}

/// Top-level windows a user would see in Alt+Tab: visible, titled, not tool windows, not cloaked.
fn list_windows() -> Vec<WindowInfo> {
    dpi_aware();
    let devices: Vec<String> = screens().into_iter().map(|s| s.device).collect();
    let names = process_names();
    let mut all: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(
            Some(collect_window),
            LPARAM(&mut all as *mut Vec<HWND> as isize),
        );
    }
    let mut out = Vec::new();
    for window in all {
        unsafe {
            if !IsWindowVisible(window).as_bool() || GetWindowTextLengthW(window) == 0 {
                continue;
            }
            let ex_style = GetWindowLongW(window, GWL_EXSTYLE) as u32;
            let tool_window =
                ex_style & WS_EX_TOOLWINDOW.0 != 0 && ex_style & WS_EX_APPWINDOW.0 == 0;
            let owned = GetWindow(window, GW_OWNER).is_ok_and(|owner| !owner.0.is_null());
            if tool_window || owned {
                continue;
            }
            let mut cloaked = 0i32;
            if DwmGetWindowAttribute(
                window,
                DWMWA_CLOAKED,
                &mut cloaked as *mut i32 as *mut c_void,
                4,
            )
            .is_ok()
                && cloaked != 0
            {
                continue;
            }
            let mut title = [0u16; 256];
            GetWindowTextW(window, &mut title);
            let mut pid = 0u32;
            GetWindowThreadProcessId(window, Some(&mut pid));
            let state = if IsIconic(window).as_bool() {
                1
            } else if IsZoomed(window).as_bool() {
                2
            } else {
                0
            };
            let frame = if state != 1 {
                visible_frame(window)
            } else {
                None
            }
            .unwrap_or_default();
            let device = device_of(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST));
            out.push(WindowInfo {
                handle: window.0 as isize as i64,
                pid,
                title: text_of(&title),
                state,
                monitor: devices
                    .iter()
                    .position(|d| *d == device)
                    .map_or(-1, |i| i as i32),
                x: frame.left,
                y: frame.top,
                w: frame.right - frame.left,
                h: frame.bottom - frame.top,
                name: names.get(&pid).cloned().unwrap_or_default(),
            });
        }
    }
    out
}

/// Only a handle that is in the list of windows right now.
fn known(handle: i64) -> PortResult<HWND> {
    if list_windows().iter().any(|w| w.handle == handle) {
        Ok(hwnd(handle))
    } else {
        Err(PortError::NotFound("window not found".into()))
    }
}

fn focus(window: HWND) {
    unsafe {
        if IsIconic(window).as_bool() {
            let _ = ShowWindow(window, SW_RESTORE);
        }
        // a tap on Alt lets this background process take the foreground (Windows blocks it otherwise)
        keybd_event(0x12, 0, Default::default(), 0);
        keybd_event(0x12, 0, KEYEVENTF_KEYUP, 0);
        let _ = SetForegroundWindow(window);
    }
}

/// Positions a window so that its *visible* rectangle is exactly x, y, w, h.
fn set_visible_rect(window: HWND, x: i32, y: i32, w: i32, h: i32) {
    unsafe {
        let mut outer = RECT::default();
        if GetWindowRect(window, &mut outer).is_err() {
            return;
        }
        let frame = visible_frame(window).unwrap_or(outer);
        let (left, top, right, bottom) = (
            frame.left - outer.left,
            frame.top - outer.top,
            outer.right - frame.right,
            outer.bottom - frame.bottom,
        );
        let _ = SetWindowPos(
            window,
            HWND::default(),
            x - left,
            y - top,
            w + left + right,
            h + top + bottom,
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

fn move_window(window: HWND, target: usize) -> PortResult<()> {
    let screens = screens();
    let Some(to) = screens.get(target) else {
        return Err(PortError::Failed("unknown monitor index".into()));
    };
    unsafe {
        let from_device = device_of(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST));
        let Some(from) = screens.iter().find(|s| s.device == from_device) else {
            return Ok(());
        };
        if from.device == to.device {
            return Ok(());
        }
        let maximized = IsZoomed(window).as_bool();
        if maximized || IsIconic(window).as_bool() {
            let _ = ShowWindow(window, SW_RESTORE); // so its normal rectangle is the one that moves
        }
        let mut r = RECT::default();
        let _ = GetWindowRect(window, &mut r);
        let (from_w, from_h) = (
            (from.work.right - from.work.left).max(1),
            (from.work.bottom - from.work.top).max(1),
        );
        let (to_w, to_h) = (to.work.right - to.work.left, to.work.bottom - to.work.top);
        let width = (r.right - r.left).min(to_w);
        let height = (r.bottom - r.top).min(to_h);
        let x = to.work.left
            + (f64::from(r.left - from.work.left) / f64::from(from_w) * f64::from(to_w)) as i32;
        let y = to.work.top
            + (f64::from(r.top - from.work.top) / f64::from(from_h) * f64::from(to_h)) as i32;
        let x = x.min(to.work.right - width).max(to.work.left);
        let y = y.min(to.work.bottom - height).max(to.work.top);
        let _ = SetWindowPos(
            window,
            HWND::default(),
            x,
            y,
            width,
            height,
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
        if maximized {
            let _ = ShowWindow(window, SW_MAXIMIZE);
        }
    }
    Ok(())
}

// ---- change events -------------------------------------------------------------------------------------------------------------------

/// The one callback the hook procedure calls (a hook procedure has no closure): there is one watcher at a time.
static ON_CHANGE: Mutex<Option<ChangeCallback>> = Mutex::new(None);

unsafe extern "system" fn on_event(
    _: HWINEVENTHOOK,
    event: u32,
    window: HWND,
    id_object: i32,
    id_child: i32,
    _thread: u32,
    _time: u32,
) {
    // the window itself (OBJID_WINDOW), not its scroll bars, carets or menus
    if id_object != 0 || id_child != 0 || window.0.is_null() {
        return;
    }
    if let Some(callback) = ON_CHANGE.lock().unwrap().as_ref() {
        callback(event == EVENT_OBJECT_NAMECHANGE);
    }
}

/// Ends the watch: the message loop quits and the hooks go away.
pub struct WatchGuard {
    thread: u32,
    join: Option<std::thread::JoinHandle<()>>,
}

impl Drop for WatchGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = PostThreadMessageW(self.thread, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
        *ON_CHANGE.lock().unwrap() = None;
    }
}

/// `SetWinEventHook` out of context, on a thread of its own with a message loop (the callbacks arrive as messages to it): focus changes, windows
/// created, destroyed, shown, hidden, moved, resized, minimized and renamed.
fn start_watch(callback: ChangeCallback) -> Option<WatchGuard> {
    *ON_CHANGE.lock().unwrap() = Some(callback);
    let (sender, receiver) = std::sync::mpsc::channel::<u32>();
    let join = std::thread::Builder::new()
        .name("window-events".into())
        .spawn(move || unsafe {
            // the thread must have a message queue before anyone posts to it
            let mut message = MSG::default();
            let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
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
                    EVENT_SYSTEM_MOVESIZEEND,
                    EVENT_SYSTEM_MOVESIZEEND,
                    None,
                    Some(on_event),
                    0,
                    0,
                    flags,
                ),
                SetWinEventHook(
                    EVENT_SYSTEM_MINIMIZESTART,
                    EVENT_SYSTEM_MINIMIZEEND,
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
            let _ = sender.send(GetCurrentThreadId());
            while GetMessageW(&mut message, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            for hook in hooks {
                let _ = UnhookWinEvent(hook);
            }
        })
        .ok()?;
    let thread = receiver
        .recv_timeout(std::time::Duration::from_secs(2))
        .ok()?;
    Some(WatchGuard {
        thread,
        join: Some(join),
    })
}

#[derive(Default)]
pub struct WindowsWindows;

impl WindowsPort for WindowsWindows {
    fn watch(&self, on_change: ChangeCallback) -> Option<Box<dyn Send>> {
        start_watch(on_change).map(|guard| Box::new(guard) as Box<dyn Send>)
    }

    fn snapshot(&self) -> PortResult<WindowsSnapshot> {
        let names = process_names();
        let mut running: Vec<String> = names
            .values()
            .cloned()
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        running.sort();
        Ok(WindowsSnapshot {
            running,
            windows: list_windows(),
        })
    }

    fn action(&self, handle: i64, action: WindowAction) -> PortResult<()> {
        let window = known(handle)?;
        unsafe {
            match action {
                WindowAction::Focus => focus(window),
                WindowAction::Minimize => {
                    let _ = ShowWindow(window, SW_MINIMIZE);
                }
                WindowAction::Maximize => {
                    let _ = ShowWindow(window, SW_MAXIMIZE);
                }
                WindowAction::Restore => {
                    let _ = ShowWindow(window, SW_RESTORE);
                }
                // WM_CLOSE: the app may ask to save
                WindowAction::Close => {
                    let _ = PostMessageW(window, 0x0010, WPARAM(0), LPARAM(0));
                }
            }
        }
        Ok(())
    }

    fn move_to_monitor(&self, handle: i64, monitor: usize) -> PortResult<()> {
        move_window(known(handle)?, monitor)
    }

    /// Moves a normal window so its top-left corner is at x, y (virtual-desktop pixels), clamped so a grabbable part always stays on a screen.
    fn place(&self, handle: i64, x: i32, y: i32) -> PortResult<()> {
        let window = known(handle)?;
        unsafe {
            if IsZoomed(window).as_bool() || IsIconic(window).as_bool() {
                return Ok(());
            }
        }
        let Some(frame) = visible_frame(window) else {
            return Ok(());
        };
        let (w, h) = (frame.right - frame.left, frame.bottom - frame.top);
        let screens = screens();
        let min_x = screens.iter().map(|s| s.work.left).min().unwrap_or(0);
        let min_y = screens.iter().map(|s| s.work.top).min().unwrap_or(0);
        let max_x = screens.iter().map(|s| s.work.right).max().unwrap_or(0);
        let max_y = screens.iter().map(|s| s.work.bottom).max().unwrap_or(0);
        let x = x.min(max_x - 120).max(min_x - w + 120);
        let y = y.min(max_y - 60).max(min_y);
        set_visible_rect(window, x, y, w, h);
        Ok(())
    }

    /// "left" or "right" half of the monitor's work area, or "full" (maximized on that monitor).
    fn snap(&self, handle: i64, monitor: usize, zone: Zone) -> PortResult<()> {
        let window = known(handle)?;
        let screens = screens();
        let Some(screen) = screens.get(monitor) else {
            return Err(PortError::Failed("unknown monitor index".into()));
        };
        if zone == Zone::Full {
            move_window(window, monitor)?;
            unsafe {
                let _ = ShowWindow(window, SW_MAXIMIZE);
            }
            return Ok(());
        }
        unsafe {
            if IsZoomed(window).as_bool() || IsIconic(window).as_bool() {
                let _ = ShowWindow(window, SW_RESTORE);
            }
        }
        let work = screen.work;
        let (width, height) = (work.right - work.left, work.bottom - work.top);
        let half = width / 2;
        if zone == Zone::Left {
            set_visible_rect(window, work.left, work.top, half, height);
        } else {
            set_visible_rect(window, work.left + half, work.top, width - half, height);
        }
        Ok(())
    }

    fn focus_process(&self, name: &str) -> PortResult<bool> {
        let target = name.to_lowercase();
        let pids: HashSet<u32> = process_names()
            .into_iter()
            .filter(|(_, n)| *n == target)
            .map(|(pid, _)| pid)
            .collect();
        match list_windows().into_iter().find(|w| pids.contains(&w.pid)) {
            Some(window) => {
                focus(hwnd(window.handle));
                Ok(true)
            }
            None => Ok(false),
        }
    }

    fn monitors(&self, brightness: bool) -> PortResult<Vec<Monitor>> {
        Ok(screens()
            .into_iter()
            .map(|screen| {
                let mut level = None;
                if brightness {
                    // DDC/CI is slow (tens of ms per monitor): only asked for when needed
                    unsafe {
                        let list = physical(screen.handle);
                        if let Some(first) = list.first() {
                            let (mut min, mut current, mut max) = (0u32, 0u32, 0u32);
                            if GetMonitorBrightness(
                                first.hPhysicalMonitor,
                                &mut min,
                                &mut current,
                                &mut max,
                            ) != 0
                                && max > min
                            {
                                level = Some(
                                    ((f64::from(current - min) * 100.0) / f64::from(max - min))
                                        .round() as Percent,
                                );
                            }
                        }
                        release(&list);
                    }
                }
                Monitor {
                    device: screen.device,
                    left: screen.full.left,
                    top: screen.full.top,
                    width: screen.full.right - screen.full.left,
                    height: screen.full.bottom - screen.full.top,
                    primary: screen.primary,
                    brightness: level,
                }
            })
            .collect())
    }

    fn set_brightness(&self, device: &str, level: Percent) -> PortResult<()> {
        let screens = screens();
        let Some(screen) = screens.iter().find(|s| s.device == device) else {
            return Err(PortError::NotFound("unknown screen".into()));
        };
        let unsupported =
            || PortError::Failed("monitor does not support brightness control".into());
        unsafe {
            let list = physical(screen.handle);
            let result = (|| {
                let first = list.first().ok_or_else(unsupported)?;
                let (mut min, mut current, mut max) = (0u32, 0u32, 0u32);
                if GetMonitorBrightness(first.hPhysicalMonitor, &mut min, &mut current, &mut max)
                    == 0
                    || max <= min
                {
                    return Err(unsupported());
                }
                let target =
                    min + (f64::from(max - min) * f64::from(level.min(100)) / 100.0).round() as u32;
                if SetMonitorBrightness(first.hPhysicalMonitor, target) == 0 {
                    return Err(PortError::Failed(
                        "monitor refused the brightness change".into(),
                    ));
                }
                Ok(())
            })();
            release(&list);
            result
        }
    }

    /// SC_MONITORPOWER 2 is off; moving the mouse wakes the screens again.
    fn screens_off(&self) -> PortResult<()> {
        unsafe {
            PostMessageW(
                HWND(0xFFFF as *mut c_void),
                0x0112,
                WPARAM(0xF170),
                LPARAM(2),
            )
            .map_err(|e| PortError::Failed(e.message()))
        }
    }

    fn project(&self, mode: Projection) -> PortResult<()> {
        let flag = match mode {
            Projection::Extend => "/extend",
            Projection::Clone => "/clone",
            Projection::FirstOnly => "/internal",
            Projection::SecondOnly => "/external",
        };
        let windir = std::env::var_os("WINDIR").unwrap_or_else(|| "C:\\Windows".into());
        std::process::Command::new(
            std::path::Path::new(&windir)
                .join("System32")
                .join("DisplaySwitch.exe"),
        )
        .arg(flag)
        .spawn()
        .map(|_| ())
        .map_err(|e| PortError::Failed(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Read-only against this PC's real windows and screens.
    #[test]
    fn the_real_windows_and_screens_are_consistent() {
        let screens = WindowsWindows.monitors(false).expect("monitors");
        assert!(!screens.is_empty(), "a session with a desktop has a screen");
        assert!(
            screens
                .windows(2)
                .all(|pair| pair[0].device <= pair[1].device),
            "sorted by device name"
        );
        let snapshot = WindowsWindows.snapshot().expect("windows");
        assert!(!snapshot.running.is_empty());
        for window in &snapshot.windows {
            assert!(window.handle != 0 && !window.title.is_empty());
            assert!(
                window.monitor >= -1 && (window.monitor as usize) < screens.len().max(1)
                    || window.monitor == -1
            );
        }
    }

    #[test]
    fn an_action_on_a_handle_that_is_not_listed_is_refused() {
        assert!(matches!(
            WindowsWindows.action(0x7fff_ffff, WindowAction::Minimize),
            Err(PortError::NotFound(_))
        ));
    }
}
