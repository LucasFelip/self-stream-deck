//! The Windows side of the ports in `ssd-core`. Everything here is `cfg(windows)`: on another system the crate is empty, so the workspace
//! still builds and tests anywhere.
#[cfg(windows)]
mod audio;

#[cfg(windows)]
pub use audio::WindowsAudio;
