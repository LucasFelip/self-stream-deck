//! Does this process have administrator rights? The scheduled task starts the agent that way, and what an elevated process trusts (a folder
//! it runs things from, a file that says whose signature to accept) must not be writable by a program that has no such rights.
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

/// True when the process is elevated. A failure to find out counts as elevated: the careful side.
pub fn is_elevated() -> bool {
    let mut token = HANDLE::default();
    // SAFETY: the pseudo-handle of the current process is always valid; `token` is a live out-pointer, and the handle it receives is
    // closed below on every path that got one. `elevation` is a plain struct of the size passed with it.
    unsafe {
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return true;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned = 0u32;
        let read = GetTokenInformation(
            token,
            TokenElevation,
            Some(std::ptr::from_mut(&mut elevation).cast()),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        );
        let _ = CloseHandle(token);
        read.is_err() || elevation.TokenIsElevated != 0
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_question_has_an_answer() {
        // which one depends on how the tests were started; it must not crash, and two calls agree
        assert_eq!(super::is_elevated(), super::is_elevated());
    }
}
