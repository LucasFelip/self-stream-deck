//! The Linux side of the ports in `ssd-core` (a spike, ADR 0013): for now only the monitor, read from `/proc`. What is read is parsed by
//! functions in `procfs`, which are plain text in, numbers out, so they are tested on any system; only `LinuxMonitor` touches `/proc`, and only
//! on Linux. Everything else a Windows agent answers (audio, media, windows, power...) is not here: a module without its port answers 404.
pub mod procfs;

#[cfg(target_os = "linux")]
mod monitor;

#[cfg(target_os = "linux")]
pub use monitor::LinuxMonitor;
