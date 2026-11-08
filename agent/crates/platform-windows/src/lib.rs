//! The Windows side of the ports in `ssd-core`. Everything here is `cfg(windows)`: on another system the crate is empty, so the workspace
//! still builds and tests anywhere.
#[cfg(windows)]
mod audio;
#[cfg(windows)]
mod input;
#[cfg(windows)]
mod media;

#[cfg(windows)]
pub use audio::WindowsAudio;
#[cfg(windows)]
pub use input::WindowsInput;
#[cfg(windows)]
pub use media::WindowsMedia;
