//! The icon by the clock: what the agent is, how to open the panel, the pairing code, the log, and a way to quit. A thread of its own with a
//! hidden window and a message loop (the tray talks to that window); it ends with the process.
use std::ffi::c_void;
use std::path::PathBuf;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::UI::Shell::{
    ShellExecuteW, Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE,
    NOTIFYICONDATAW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreateIconFromResourceEx, CreatePopupMenu, CreateWindowExW, DefWindowProcW,
    DestroyMenu, DispatchMessageW, GetCursorPos, GetMessageW, MessageBoxW, PostMessageW,
    RegisterClassW, SetForegroundWindow, TrackPopupMenu, TranslateMessage, HICON, LR_DEFAULTCOLOR,
    MB_ICONINFORMATION, MB_OK, MF_SEPARATOR, MF_STRING, MSG, SW_SHOWNORMAL, TPM_RETURNCMD,
    TPM_RIGHTBUTTON, WINDOW_EX_STYLE, WINDOW_STYLE, WM_APP, WM_LBUTTONDBLCLK, WM_NULL,
    WM_RBUTTONUP, WNDCLASSW,
};

const ICON_PNG: &[u8] = include_bytes!("../../../../web/public/icons/icon-192.png");
const CALLBACK: u32 = WM_APP + 1;
const OPEN: usize = 1;
const CODE: usize = 2;
const LOG: usize = 3;
const QUIT: usize = 4;

/// What the menu needs to know.
#[derive(Clone)]
pub struct Info {
    pub port: u16,
    pub token: String,
    pub log: PathBuf,
}

static INFO: std::sync::OnceLock<Info> = std::sync::OnceLock::new();

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

fn open(target: &str) {
    let target = wide(target);
    unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(target.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
    }
}

fn show_code(info: &Info, owner: HWND) {
    let text = wide(&format!(
        "Código de pareamento (o mesmo que o celular já usa):\n\n{}\n\nEndereço neste PC:\nhttp://127.0.0.1:{}/?token={}\n\nNo celular: \"Endereço do PC…\" no menu do app, ou, pelo Wi-Fi, o link https que o comando \"ssd.exe pair\" mostra.",
        info.token, info.port, info.token
    ));
    unsafe {
        MessageBoxW(
            owner,
            PCWSTR(text.as_ptr()),
            w!("Self Stream Deck"),
            MB_OK | MB_ICONINFORMATION,
        );
    }
}

unsafe extern "system" fn procedure(
    window: HWND,
    message: u32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    if message == CALLBACK {
        let event = (l_param.0 & 0xffff) as u32;
        let Some(info) = INFO.get() else {
            return LRESULT(0);
        };
        if event == WM_LBUTTONDBLCLK {
            open(&format!(
                "http://127.0.0.1:{}/?token={}",
                info.port, info.token
            ));
        } else if event == WM_RBUTTONUP {
            let menu = CreatePopupMenu().unwrap_or_default();
            let _ = AppendMenuW(menu, MF_STRING, OPEN, w!("Abrir painel"));
            let _ = AppendMenuW(menu, MF_STRING, CODE, w!("Mostrar código de pareamento"));
            let _ = AppendMenuW(menu, MF_STRING, LOG, w!("Abrir registro (log)"));
            let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
            let _ = AppendMenuW(menu, MF_STRING, QUIT, w!("Sair"));
            let mut at = POINT::default();
            let _ = GetCursorPos(&mut at);
            // the menu closes when the user clicks elsewhere only if its window has the foreground first
            let _ = SetForegroundWindow(window);
            let choice = TrackPopupMenu(
                menu,
                TPM_RETURNCMD | TPM_RIGHTBUTTON,
                at.x,
                at.y,
                0,
                window,
                None,
            )
            .0 as usize;
            let _ = PostMessageW(window, WM_NULL, WPARAM(0), LPARAM(0));
            let _ = DestroyMenu(menu);
            match choice {
                OPEN => open(&format!(
                    "http://127.0.0.1:{}/?token={}",
                    info.port, info.token
                )),
                CODE => show_code(info, window),
                LOG => open(&info.log.to_string_lossy()),
                QUIT => std::process::exit(0), // the job object takes whatever the agent started with it
                _ => {}
            }
        }
        return LRESULT(0);
    }
    DefWindowProcW(window, message, w_param, l_param)
}

/// Starts the tray icon on a thread of its own.
pub fn start(info: Info) {
    let _ = INFO.set(info);
    std::thread::Builder::new()
        .name("tray".into())
        .spawn(|| unsafe {
            let class = w!("SelfStreamDeckTray");
            let window_class = WNDCLASSW {
                lpfnWndProc: Some(procedure),
                lpszClassName: class,
                ..Default::default()
            };
            if RegisterClassW(&window_class) == 0 {
                tracing::warn!("tray: could not register the window class");
            }
            // a window that is never shown: the tray sends its messages to it
            let window = match CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class,
                w!("Self Stream Deck"),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                None,
                None,
                None,
                None,
            ) {
                Ok(window) => window,
                Err(error) => {
                    tracing::warn!("tray: could not create the window: {error}");
                    return;
                }
            };
            let icon: HICON =
                CreateIconFromResourceEx(ICON_PNG, true, 0x0003_0000, 32, 32, LR_DEFAULTCOLOR)
                    .unwrap_or_default();
            let mut data = NOTIFYICONDATAW {
                cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
                hWnd: window,
                uID: 1,
                uFlags: NIF_ICON | NIF_MESSAGE | NIF_TIP,
                uCallbackMessage: CALLBACK,
                hIcon: icon,
                ..Default::default()
            };
            let tip: Vec<u16> = "Self Stream Deck".encode_utf16().collect();
            data.szTip[..tip.len()].copy_from_slice(&tip);
            if !Shell_NotifyIconW(NIM_ADD, &data).as_bool() {
                tracing::warn!("tray: Windows did not add the icon");
            }
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            let _ = Shell_NotifyIconW(NIM_DELETE, &data);
        })
        .ok();
}

#[allow(dead_code)]
fn _unused(_: *const c_void) {}
