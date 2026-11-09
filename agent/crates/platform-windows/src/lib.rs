//! The Windows side of the ports in `ssd-core`. Everything here is `cfg(windows)`: on another system the crate is empty, so the workspace
//! still builds and tests anywhere.
#[cfg(windows)]
mod audio;
#[cfg(windows)]
mod input;
#[cfg(windows)]
pub mod lan;
#[cfg(windows)]
mod media;
#[cfg(windows)]
mod monitor;
#[cfg(windows)]
mod notifications;
#[cfg(windows)]
mod power;
#[cfg(windows)]
mod sysinfo;
#[cfg(windows)]
mod taskbar;
#[cfg(windows)]
mod vcam;
#[cfg(windows)]
mod windows_mgmt;

#[cfg(windows)]
pub use audio::WindowsAudio;
#[cfg(windows)]
pub use input::WindowsInput;
#[cfg(windows)]
pub use media::WindowsMedia;
#[cfg(windows)]
pub use monitor::WindowsMonitor;
#[cfg(windows)]
pub use notifications::WindowsNotifications;
#[cfg(windows)]
pub use power::WindowsPower;
#[cfg(windows)]
pub use taskbar::WindowsTaskbar;
#[cfg(windows)]
pub use vcam::WindowsVcam;
#[cfg(windows)]
pub use windows_mgmt::WindowsWindows;
