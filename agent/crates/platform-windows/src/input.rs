//! The keyboard for the `InputPort`: `keybd_event` like `legacy/server/native/DeckNative.cs` (`Combo`), the call that every shortcut tool on
//! Windows still uses because it works for every window, elevated ones excepted.
use std::thread::sleep;
use std::time::Duration;

use ssd_core::ports::{InputPort, PortResult};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    keybd_event, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP,
};

/// Keys that need the "extended" flag: page up/down, end, home, arrows, print screen, insert, delete, the Windows keys and the
/// browser, volume and media keys.
fn is_extended(vk: u8) -> bool {
    matches!(vk, 0x21..=0x28 | 0x2c | 0x2d | 0x2e | 0x5b | 0x5c | 0xa6..=0xb7)
}

fn send(vk: u8, up: bool) {
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if is_extended(vk) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    unsafe { keybd_event(vk, 0, flags, 0) };
}

#[derive(Default)]
pub struct WindowsInput;

impl InputPort for WindowsInput {
    fn press_keys(&self, vks: &[u8]) -> PortResult<()> {
        for (index, vk) in vks.iter().enumerate() {
            send(*vk, false);
            sleep(Duration::from_millis(8));
            if index + 1 == vks.len() {
                sleep(Duration::from_millis(20));
            }
        }
        // released in reverse, even for the keys already pressed when something goes wrong in the middle
        for vk in vks.iter().rev() {
            send(*vk, true);
            sleep(Duration::from_millis(8));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_extended_keys_are_the_ones_windows_expects() {
        for vk in [0x21, 0x28, 0x2c, 0x2d, 0x2e, 0x5b, 0xaf, 0xb3] {
            assert!(is_extended(vk), "{vk:#x}");
        }
        for vk in [0x11, 0x1b, b'A', 0x70, 0x20] {
            assert!(!is_extended(vk), "{vk:#x}");
        }
    }
}
