//! What Windows does for the `PowerPort`: `shutdown.exe` for turning off, restarting and hibernating, `LockWorkStation`, `SetSuspendState`
//! for sleep (never hibernating behind your back), and the registry for the hibernation, fast-startup and pending-restart settings.
use std::os::windows::process::CommandExt;

use ssd_core::ports::{PortError, PortResult, PowerPort};
use ssd_core::power::{CommandResult, Raw};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{BOOLEAN, ERROR_SUCCESS};
use windows::Win32::System::Power::SetSuspendState;
use windows::Win32::System::Registry::{
    RegCloseKey, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ, RRF_RT_REG_DWORD,
};
use windows::Win32::System::Shutdown::LockWorkStation;
use windows::Win32::System::SystemInformation::GetTickCount64;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

fn dword(key: &str, name: &str) -> Option<u32> {
    let (key, name) = (wide(key), wide(name));
    let mut data = 0u32;
    let mut size = 4u32;
    unsafe {
        let result = RegGetValueW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(key.as_ptr()),
            PCWSTR(name.as_ptr()),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut data as *mut u32 as *mut _),
            Some(&mut size),
        );
        (result == ERROR_SUCCESS).then_some(data)
    }
}

fn key_exists(key: &str) -> bool {
    let key = wide(key);
    let mut handle = HKEY::default();
    unsafe {
        let found = RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(key.as_ptr()),
            0,
            KEY_READ,
            &mut handle,
        ) == ERROR_SUCCESS;
        if found {
            let _ = RegCloseKey(handle);
        }
        found
    }
}

#[derive(Default)]
pub struct WindowsPower;

impl PowerPort for WindowsPower {
    fn raw(&self) -> PortResult<Raw> {
        Ok(Raw {
            uptime_sec: unsafe { GetTickCount64() } / 1000,
            hibernate: dword(
                r"SYSTEM\CurrentControlSet\Control\Power",
                "HibernateEnabled",
            ),
            hiberboot: dword(
                r"SYSTEM\CurrentControlSet\Control\Session Manager\Power",
                "HiberbootEnabled",
            ),
            reboot_pending: key_exists(
                r"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired",
            ) || key_exists(
                r"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending",
            ),
        })
    }

    fn shutdown(&self, args: &[String]) -> PortResult<CommandResult> {
        let output = std::process::Command::new("shutdown.exe")
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| PortError::Failed(e.to_string()))?;
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(CommandResult {
            code: output.status.code().unwrap_or(-1),
            output: text.trim().to_owned(),
        })
    }

    fn lock(&self) -> PortResult<()> {
        unsafe { LockWorkStation().map_err(|e| PortError::Failed(e.message())) }
    }

    fn sleep(&self) -> PortResult<()> {
        // the call comes back only after the PC wakes up: it must not hold the request that asked for it
        std::thread::Builder::new()
            .name("suspend".into())
            .spawn(|| unsafe {
                let _ = SetSuspendState(BOOLEAN(0), BOOLEAN(0), BOOLEAN(0));
            })
            .map(|_| ())
            .map_err(|e| PortError::Failed(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Read-only: it never turns anything off, only reads the settings.
    #[test]
    fn the_real_power_settings_read() {
        let raw = WindowsPower.raw().expect("settings");
        assert!(raw.uptime_sec > 0);
        assert!(raw.hibernate.is_none_or(|v| v <= 1));
    }

    /// `shutdown /a` with nothing pending is the harmless way to prove the command runs: it fails with 1116 and says so.
    #[test]
    fn shutdown_exe_runs_and_reports_instead_of_failing() {
        let result = WindowsPower
            .shutdown(&["/a".into()])
            .expect("shutdown.exe starts");
        assert!(result.code == 0 || result.code == 1116, "{result:?}");
    }
}
