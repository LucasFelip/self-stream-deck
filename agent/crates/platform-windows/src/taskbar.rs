//! The pinned taskbar shortcuts for the `TaskbarPort`: the `.lnk` files of the TaskBar folder are read through `IShellLinkW` (target,
//! arguments, icon location) and one 128 px PNG icon per shortcut is written to the icon folder. Same result as `scripts/taskbar.ps1`,
//! in-process and in a few milliseconds instead of 2.5 s of PowerShell. Differences, on purpose: the PNG bytes are the `png` crate's, so an
//! icon's version string differs from the one the Node agent made, and `wt.exe` (an alias with no icon) gets the icon of its shortcut file.
use std::ffi::c_void;
use std::path::{Path, PathBuf};

use ssd_core::ports::{PortError, PortResult, TaskbarPort};
use ssd_core::sha1::sha1_hex;
use ssd_core::taskbar::{id_of, TaskbarItem};
use windows::core::{Interface, PCWSTR, PWSTR};
use windows::Win32::Foundation::HINSTANCE;
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
};
use windows::Win32::Storage::FileSystem::WIN32_FIND_DATAW;
use windows::Win32::System::Com::{CoCreateInstance, IPersistFile, CLSCTX_ALL, STGM_READ};
use windows::Win32::System::Environment::ExpandEnvironmentStringsW;
use windows::Win32::UI::Shell::{ExtractAssociatedIconW, IShellLinkW, ShellLink};
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, GetIconInfo, PrivateExtractIconsW, HICON, ICONINFO,
};

use crate::audio::com;

const ICON_SIZE: i32 = 128;

pub fn taskbar_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|appdata| {
        PathBuf::from(appdata).join(r"Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar")
    })
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

fn text_of(buffer: &[u16]) -> String {
    let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
}

struct Shortcut {
    target: String,
    args: String,
    icon_location: String,
}

fn read_shortcut(path: &Path) -> Option<Shortcut> {
    com();
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_ALL).ok()?;
        let file: IPersistFile = link.cast().ok()?;
        file.Load(PCWSTR(wide(&path.to_string_lossy()).as_ptr()), STGM_READ)
            .ok()?;
        let mut target = [0u16; 1024];
        let mut args = [0u16; 2048];
        let mut icon = [0u16; 1024];
        let mut index = 0i32;
        // an item without a file target (File Explorer, a shell: folder) just gives an empty path
        let _ = link.GetPath(&mut target, std::ptr::null_mut::<WIN32_FIND_DATAW>(), 0);
        let _ = link.GetArguments(&mut args);
        let _ = link.GetIconLocation(&mut icon, &mut index);
        Some(Shortcut {
            target: text_of(&target),
            args: text_of(&args),
            icon_location: text_of(&icon),
        })
    }
}

fn expand(text: &str) -> String {
    let source = wide(text);
    unsafe {
        let needed = ExpandEnvironmentStringsW(PCWSTR(source.as_ptr()), None) as usize;
        if needed == 0 {
            return text.to_owned();
        }
        let mut out = vec![0u16; needed];
        ExpandEnvironmentStringsW(PCWSTR(source.as_ptr()), Some(&mut out));
        text_of(&out)
    }
}

/// The picture of an icon handle as RGBA bytes.
unsafe fn pixels(icon: HICON) -> Option<(u32, u32, Vec<u8>)> {
    let mut info = ICONINFO::default();
    GetIconInfo(icon, &mut info).ok()?;
    let release = |info: &ICONINFO| {
        if !info.hbmColor.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(info.hbmColor.0));
        }
        if !info.hbmMask.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(info.hbmMask.0));
        }
    };
    let mut bitmap = BITMAP::default();
    if info.hbmColor.is_invalid()
        || GetObjectW(
            HGDIOBJ(info.hbmColor.0),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bitmap as *mut BITMAP as *mut c_void),
        ) == 0
    {
        release(&info);
        return None;
    }
    let (width, height) = (bitmap.bmWidth, bitmap.bmHeight);
    let dc = CreateCompatibleDC(None);
    let mut header = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut color = vec![0u8; (width * height * 4) as usize];
    let got = GetDIBits(
        dc,
        info.hbmColor,
        0,
        height as u32,
        Some(color.as_mut_ptr() as *mut c_void),
        &mut header,
        DIB_RGB_COLORS,
    );
    // an icon without an alpha channel carries its shape in the mask (a bit per pixel: 1 is transparent)
    let has_alpha = color.chunks(4).any(|p| p[3] != 0);
    let mut mask = vec![0u8; (width * height * 4) as usize];
    let mask_ok = !has_alpha
        && !info.hbmMask.is_invalid()
        && GetDIBits(
            dc,
            info.hbmMask,
            0,
            height as u32,
            Some(mask.as_mut_ptr() as *mut c_void),
            &mut header,
            DIB_RGB_COLORS,
        ) != 0;
    let _ = DeleteDC(dc);
    release(&info);
    if got == 0 {
        return None;
    }
    for (index, pixel) in color.chunks_mut(4).enumerate() {
        pixel.swap(0, 2); // BGRA to RGBA
        if !has_alpha {
            pixel[3] = if mask_ok && mask[index * 4] != 0 {
                0
            } else {
                255
            };
        }
    }
    Some((width as u32, height as u32, color))
}

fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header().ok()?.write_image_data(rgba).ok()?;
    }
    Some(out)
}

/// A 128 px icon of a file (an exe, a dll, a document...), as PNG bytes.
fn icon_png(source: &str) -> Option<Vec<u8>> {
    if source.is_empty() || !Path::new(source).exists() {
        return None;
    }
    unsafe {
        let mut path = [0u16; 260];
        let units: Vec<u16> = source.encode_utf16().take(259).collect();
        path[..units.len()].copy_from_slice(&units);
        let mut handles = [HICON::default(); 1];
        let mut ids = [0u32; 1];
        let found = PrivateExtractIconsW(
            &path,
            0,
            ICON_SIZE,
            ICON_SIZE,
            Some(&mut handles),
            Some(ids.as_mut_ptr()),
            0,
        );
        let icon = if found >= 1 && !handles[0].is_invalid() {
            handles[0]
        } else {
            // the shell's own idea of "the icon of this file" (what the Node agent's second attempt used)
            let mut short = [0u16; 128];
            let units: Vec<u16> = source.encode_utf16().take(127).collect();
            short[..units.len()].copy_from_slice(&units);
            let mut index = 0u16;
            let icon = ExtractAssociatedIconW(HINSTANCE::default(), &mut short, &mut index);
            if icon.is_invalid() {
                return None;
            }
            icon
        };
        let result = pixels(icon).and_then(|(w, h, rgba)| encode_png(w, h, &rgba));
        let _ = DestroyIcon(icon);
        result
    }
}

#[derive(Default)]
pub struct WindowsTaskbar;

impl TaskbarPort for WindowsTaskbar {
    fn launch(&self, lnk: &str) -> PortResult<()> {
        // explorer.exe makes the shortcut behave exactly like a click on the taskbar (arguments, "start in", elevation, shell: targets)
        std::process::Command::new("explorer.exe")
            .arg(lnk)
            .spawn()
            .map(|_| ())
            .map_err(|e| PortError::Failed(e.to_string()))
    }

    fn folder(&self) -> Option<PathBuf> {
        taskbar_dir()
    }

    fn read(&self, icon_dir: &Path) -> PortResult<Vec<TaskbarItem>> {
        let Some(dir) = taskbar_dir() else {
            return Ok(Vec::new());
        };
        std::fs::create_dir_all(icon_dir).map_err(|e| PortError::Failed(e.to_string()))?;
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Ok(Vec::new());
        };
        let explorer =
            PathBuf::from(std::env::var_os("WINDIR").unwrap_or_default()).join("explorer.exe");
        let mut items = Vec::new();
        for entry in entries.filter_map(Result::ok) {
            let file = entry.file_name().to_string_lossy().into_owned();
            if !file.to_lowercase().ends_with(".lnk") || !entry.path().is_file() {
                continue;
            }
            let lnk = entry.path();
            let shortcut = read_shortcut(&lnk).unwrap_or(Shortcut {
                target: String::new(),
                args: String::new(),
                icon_location: String::new(),
            });
            let id = id_of(&file);

            // the icon: the one the shortcut names, else the target's, else Explorer's
            let named = expand(
                shortcut
                    .icon_location
                    .rsplit_once(',')
                    .map_or(shortcut.icon_location.as_str(), |(path, _)| path),
            );
            let source = if !named.is_empty() && Path::new(&named).exists() {
                named
            } else if !shortcut.target.is_empty() {
                shortcut.target.clone()
            } else {
                explorer.to_string_lossy().into_owned()
            };
            let png = icon_png(&source).or_else(|| icon_png(&lnk.to_string_lossy()));
            let icon_hash = png.as_ref().map(|bytes| sha1_hex(bytes));
            let has_icon = match &png {
                Some(bytes) => std::fs::write(icon_dir.join(format!("{id}.png")), bytes).is_ok(),
                None => false,
            };
            items.push(TaskbarItem {
                id,
                file,
                lnk: lnk.to_string_lossy().into_owned(),
                target: shortcut.target,
                args: shortcut.args,
                has_icon,
                icon_hash: if has_icon { icon_hash } else { None },
            });
        }
        Ok(items)
    }
}

/// A silent `PWSTR` use so the import stays honest when the shell API changes.
#[allow(dead_code)]
fn _unused(_: PWSTR) {}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reads this PC's real taskbar into a temp folder (a PC with nothing pinned is a fine answer).
    #[test]
    fn the_real_taskbar_reads_with_icons() {
        let icons = std::env::temp_dir().join(format!("ssd-icons-{}", std::process::id()));
        let items = WindowsTaskbar.read(&icons).expect("the taskbar reads");
        for item in &items {
            assert_eq!(item.id.len(), 10, "{}", item.file);
            assert_eq!(
                item.has_icon,
                icons.join(format!("{}.png", item.id)).exists()
            );
            if item.has_icon {
                let bytes = std::fs::read(icons.join(format!("{}.png", item.id))).unwrap();
                assert!(bytes.starts_with(&[0x89, b'P', b'N', b'G']));
            }
        }
        let _ = std::fs::remove_dir_all(&icons);
    }
}
