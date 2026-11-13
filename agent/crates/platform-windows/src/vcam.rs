//! The direct virtual camera ("Stream Deck Camera"), for the `VcamPort`: the open-source UnityCapture DirectShow filter (zlib-style license,
//! github.com/schellingb/UnityCapture), installed on demand: the DLL is downloaded from a pinned commit, checked against a pinned SHA-256 and
//! registered with regsvr32 (that needs administrator rights, which the autostart task has). Frames reach it through the filter's shared memory,
//! like `legacy/server/native/VCam.cs`, but in a thread of this process instead of a helper process.
use ssd_core::sync::Locked;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use ssd_core::ports::{PortError, PortResult, VcamPort};
use ssd_core::sha256::sha256_hex;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Memory::{MapViewOfFile, OpenFileMappingW, FILE_MAP_WRITE};
use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
use windows::Win32::System::Threading::{
    CreateEventW, OpenEventW, OpenMutexW, ReleaseMutex, SetEvent, WaitForSingleObject,
    EVENT_MODIFY_STATE, SYNCHRONIZATION_SYNCHRONIZE,
};

const NAME: &str = "Stream Deck Camera";
const DLL_URL: &str = "https://raw.githubusercontent.com/schellingb/UnityCapture/3ed54c325e0ad71afcf4f246c07e5e17b3d7f2d2/Install/UnityCaptureFilter64.dll";
const DLL_SHA256: &str = "72812f5363d8ecb45632253f8c8c888844b1b62e27616f3c8cc21064ccde25e5";
const DLL_SIZE: usize = 157_696;
const CLSID: &str = "{5C2CD55C-92AD-4999-8666-912BD3E70010}";
const IDLE_STOP: Duration = Duration::from_secs(5);
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

fn failed(message: impl Into<String>) -> PortError {
    PortError::Failed(message.into())
}

// ---- the frames: JPEG in, the filter's shared memory out -----------------------------------------------------------------------------

struct Filter {
    mutex: HANDLE,
    want: HANDLE,
    sent: HANDLE,
    view: *mut u8,
}

// handles and a mapped view of the filter's memory, used only by the thread that owns this value
unsafe impl Send for Filter {}

impl Filter {
    /// Mirrors the order of the filter's own `Open()`: each step may have to wait for the filter's side to appear.
    fn open() -> Option<Self> {
        unsafe {
            let mutex = OpenMutexW(
                SYNCHRONIZATION_SYNCHRONIZE,
                false,
                PCWSTR(wide("UnityCapture_Mutx").as_ptr()),
            )
            .ok()?;
            if WaitForSingleObject(mutex, 200).0 != 0 {
                let _ = CloseHandle(mutex);
                return None;
            }
            let opened = (|| {
                let want = CreateEventW(
                    None,
                    false,
                    false,
                    PCWSTR(wide("UnityCapture_Want").as_ptr()),
                )
                .ok()?;
                let sent = OpenEventW(
                    EVENT_MODIFY_STATE,
                    false,
                    PCWSTR(wide("UnityCapture_Sent").as_ptr()),
                )
                .ok()?;
                let file = OpenFileMappingW(
                    FILE_MAP_WRITE.0,
                    false,
                    PCWSTR(wide("UnityCapture_Data").as_ptr()),
                )
                .ok()?;
                let view = MapViewOfFile(file, FILE_MAP_WRITE, 0, 0, 0);
                (!view.Value.is_null()).then_some(Self {
                    mutex,
                    want,
                    sent,
                    view: view.Value as *mut u8,
                })
            })();
            let _ = ReleaseMutex(mutex);
            opened
        }
    }

    unsafe fn write_i32(&self, offset: usize, value: i32) {
        unsafe {
            (self.view.add(offset) as *mut i32).write_unaligned(value);
        }
    }

    /// Decodes a JPEG and publishes it. False when nobody is receiving (or the frame does not fit).
    fn send(&self, jpeg: &[u8]) -> bool {
        let Some((width, height, rgba)) = decode_bottom_up_rgba(jpeg) else {
            return false;
        };
        let bytes = rgba.len();
        unsafe {
            if bytes as i64 > i64::from((self.view as *const i32).read_unaligned()) {
                return false;
            }
        }
        unsafe {
            if WaitForSingleObject(self.mutex, 500).0 != 0 {
                return false;
            }
            self.write_i32(4, width as i32);
            self.write_i32(8, height as i32);
            self.write_i32(12, width as i32); // stride, in pixels
            self.write_i32(16, 0); // FORMAT_UINT8
            self.write_i32(20, 1); // resize to whatever size the app asks for
            self.write_i32(24, 0); // no mirroring: the page already sends the unmirrored picture
            self.write_i32(28, 1000); // ms before the filter calls the source stopped
            std::ptr::copy_nonoverlapping(rgba.as_ptr(), self.view.add(32), bytes);
            let _ = ReleaseMutex(self.mutex);
            let _ = SetEvent(self.sent);
        }
        let _ = self.want;
        true
    }
}

/// A JPEG as RGBA with the rows bottom-up: the filter takes Unity's orientation (origin at the bottom), so a top-down picture would reach the
/// apps upside down. `(width, height, bytes)`.
fn decode_bottom_up_rgba(jpeg: &[u8]) -> Option<(usize, usize, Vec<u8>)> {
    let mut decoder = jpeg_decoder::Decoder::new(jpeg);
    let pixels = decoder.decode().ok()?;
    let info = decoder.info()?;
    let (width, height) = (usize::from(info.width), usize::from(info.height));
    let mut rgba = vec![255u8; width * height * 4];
    let components = match info.pixel_format {
        jpeg_decoder::PixelFormat::L8 => 1,
        jpeg_decoder::PixelFormat::RGB24 => 3,
        _ => return None,
    };
    for y in 0..height {
        for x in 0..width {
            let source = (y * width + x) * components;
            let target = ((height - 1 - y) * width + x) * 4;
            if components == 3 {
                rgba[target..target + 3].copy_from_slice(&pixels[source..source + 3]);
            } else {
                rgba[target..target + 3].fill(pixels[source]);
            }
        }
    }
    Some((width, height, rgba))
}

struct Feeder {
    sender: SyncSender<Vec<u8>>,
    ready: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct WindowsVcam {
    dir: PathBuf,
    feeder: Mutex<Option<Feeder>>,
    last_feed: AtomicU64,
    installed: Mutex<Option<(Instant, bool)>>,
    busy: AtomicBool,
}

impl WindowsVcam {
    /// `dir` is where the filter's DLL is kept (`<data>/vcam`).
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            ..Self::default()
        }
    }

    fn dll(&self) -> PathBuf {
        self.dir.join("UnityCaptureFilter64.dll")
    }

    /// Where Windows says the filter's DLL is (the registration of its class), if it is registered at all.
    fn registered_dll(&self) -> Option<PathBuf> {
        let key = wide(&format!(
            "SOFTWARE\\Classes\\CLSID\\{CLSID}\\InprocServer32"
        ));
        let mut buffer = [0u16; 1024];
        let mut bytes = (buffer.len() * 2) as u32;
        let found = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                PCWSTR(key.as_ptr()),
                PCWSTR::null(),
                RRF_RT_REG_SZ,
                None,
                Some(buffer.as_mut_ptr() as *mut _),
                Some(&mut bytes),
            )
            .0 == 0
        };
        found.then(|| {
            PathBuf::from(String::from_utf16_lossy(
                &buffer[..buffer.iter().position(|&c| c == 0).unwrap_or(0)],
            ))
        })
    }

    /// Is the filter registered, and is its DLL there? Wherever it is: the filter and the agent talk through shared memory by name, so a
    /// filter registered from an earlier install's folder (the data folder moved to %APPDATA%) works as well as one from ours, and the frames
    /// must not be dropped because of the folder. Reinstalling from the app registers it from our folder.
    fn is_installed(&self, force: bool) -> bool {
        let mut cache = self.installed.locked();
        if let (false, Some((at, value))) = (force, cache.as_ref()) {
            if at.elapsed() < Duration::from_secs(5) {
                return *value;
            }
        }
        let value = self
            .registered_dll()
            .is_some_and(|path| is_filter_dll(&path) && path.exists());
        *cache = Some((Instant::now(), value));
        value
    }

    fn start_feeder(&self) -> SyncSender<Vec<u8>> {
        let mut slot = self.feeder.locked();
        if let Some(feeder) = slot.as_ref() {
            return feeder.sender.clone();
        }
        let (sender, receiver) = sync_channel::<Vec<u8>>(2);
        let ready = Arc::new(AtomicBool::new(false));
        let flag = ready.clone();
        std::thread::Builder::new()
            .name("vcam".into())
            .spawn(move || {
                let mut filter: Option<Filter> = None;
                // frames come until nobody sends for a while (or the sender is gone)
                while let Ok(frame) = receiver.recv_timeout(IDLE_STOP) {
                    if filter.is_none() {
                        filter = Filter::open();
                    }
                    flag.store(
                        filter.as_ref().is_some_and(|f| f.send(&frame)),
                        Ordering::SeqCst,
                    );
                }
                flag.store(false, Ordering::SeqCst);
            })
            .ok();
        *slot = Some(Feeder {
            sender: sender.clone(),
            ready,
        });
        sender
    }
}

impl VcamPort for WindowsVcam {
    fn status(&self) -> PortResult<Value> {
        Ok(
            json!({ "name": NAME, "installed": self.is_installed(false), "inUse": self.in_use(), "busy": self.busy.load(Ordering::SeqCst) }),
        )
    }

    fn in_use(&self) -> bool {
        self.feeder
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|f| f.ready.load(Ordering::SeqCst))
    }

    /// Hands a JPEG to the device, if it is installed. Cheap when it is not; drops the frame when the feeder is busy.
    fn feed(&self, jpeg: &[u8]) {
        if !self.is_installed(false) {
            return;
        }
        self.last_feed.store(
            Instant::now().elapsed().as_millis() as u64,
            Ordering::SeqCst,
        );
        let sender = self.start_feeder();
        if sender.try_send(jpeg.to_vec()).is_err() {
            // the feeder is busy or has stopped: drop the frame; a stopped one is started again by the next frame
            let mut slot = self.feeder.locked();
            if slot.as_ref().is_some_and(|f| {
                f.sender.try_send(Vec::new()).is_err() && !f.ready.load(Ordering::SeqCst)
            }) {
                *slot = None;
            }
        }
    }

    fn install(&self) -> PortResult<()> {
        if self.busy.swap(true, Ordering::SeqCst) {
            return Err(failed("another install is running"));
        }
        let result = (|| {
            std::fs::create_dir_all(&self.dir).map_err(|e| failed(e.to_string()))?;
            let temporary = self.dir.join("download.tmp");
            // curl.exe ships with Windows 10 and later: it checks the certificate of the site for us
            let status = std::process::Command::new("curl.exe")
                .args([
                    "--fail",
                    "--silent",
                    "--show-error",
                    "--location",
                    "--max-time",
                    "30",
                    "--max-filesize",
                    "1048576",
                    "--output",
                ])
                .arg(&temporary)
                .arg(DLL_URL)
                .creation_flags(CREATE_NO_WINDOW)
                .status()
                .map_err(|e| failed(format!("download failed: {e}")))?;
            if !status.success() {
                return Err(failed(format!(
                    "download failed (curl exited with {})",
                    status.code().unwrap_or(-1)
                )));
            }
            let bytes = std::fs::read(&temporary).map_err(|e| failed(e.to_string()))?;
            let _ = std::fs::remove_file(&temporary);
            if bytes.len() != DLL_SIZE || sha256_hex(&bytes) != DLL_SHA256 {
                return Err(failed(
                    "the downloaded file is not the expected one: not installed",
                ));
            }
            std::fs::write(self.dll(), &bytes).map_err(|e| failed(e.to_string()))?;
            // regsvr32 loads the file with this process's rights (administrator), and the folder is one any program of the user can
            // write. Open it so that nobody can write, replace or rename it (others may only read), check that what is on disk is still
            // what was verified, and keep it open until the registration is over.
            let held = {
                use std::io::Read;
                use std::os::windows::fs::OpenOptionsExt;
                const SHARE_READ_ONLY: u32 = 1;
                let mut file = std::fs::OpenOptions::new()
                    .read(true)
                    .share_mode(SHARE_READ_ONLY)
                    .open(self.dll())
                    .map_err(|e| failed(e.to_string()))?;
                let mut on_disk = Vec::with_capacity(bytes.len());
                file.read_to_end(&mut on_disk)
                    .map_err(|e| failed(e.to_string()))?;
                if on_disk != bytes {
                    return Err(failed(
                        "the file changed while it was being installed: not installed",
                    ));
                }
                file
            };
            let output = regsvr32(&[
                &format!("/i:UnityCaptureName={NAME}"),
                &self.dll().to_string_lossy(),
            ])?;
            drop(held);
            *self.installed.locked() = None;
            if !output.0 || !self.is_installed(true) {
                return Err(failed(format!("registration failed (code {}): the server needs administrator rights to register a camera. {}", output.1, output.2).trim().to_owned()));
            }
            Ok(())
        })();
        self.busy.store(false, Ordering::SeqCst);
        result
    }

    /// Puts text on the PC's clipboard (through clip.exe).
    fn copy_to_clipboard(&self, text: &str) -> PortResult<()> {
        use std::io::Write;
        let mut child = std::process::Command::new("clip.exe")
            .stdin(std::process::Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| failed(e.to_string()))?;
        child
            .stdin
            .take()
            .ok_or_else(|| failed("no stdin"))?
            .write_all(text.as_bytes())
            .map_err(|e| failed(e.to_string()))?;
        child.wait().map(|_| ()).map_err(|e| failed(e.to_string()))
    }

    fn uninstall(&self) -> PortResult<()> {
        *self.feeder.locked() = None;
        // unregister from where it is registered (it may be an earlier install's folder), and from ours
        if let Some(path) = self
            .registered_dll()
            .filter(|p| is_filter_dll(p) && p.exists())
        {
            regsvr32(&["/u", &path.to_string_lossy()])?;
        }
        if self.dll().exists() {
            regsvr32(&["/u", &self.dll().to_string_lossy()])?;
        }
        *self.installed.locked() = None;
        if self.is_installed(true) {
            return Err(failed(
                "could not unregister the camera (administrator rights needed)",
            ));
        }
        // a process may still hold the file: harmless, it is unregistered
        let _ = std::fs::remove_dir_all(&self.dir);
        Ok(())
    }
}

/// Is this the filter's DLL (by name: the registration holds a path, nothing else tells it apart from another COM server)?
fn is_filter_dll(path: &std::path::Path) -> bool {
    path.file_name().is_some_and(|name| {
        name.to_string_lossy()
            .eq_ignore_ascii_case("UnityCaptureFilter64.dll")
    })
}

/// `regsvr32 /s ...`: (success, exit code, output).
fn regsvr32(args: &[&str]) -> PortResult<(bool, i32, String)> {
    let output = std::process::Command::new("regsvr32.exe")
        .arg("/s")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| failed(e.to_string()))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    Ok((
        output.status.success(),
        output.status.code().unwrap_or(-1),
        text.trim().to_owned(),
    ))
}

#[allow(dead_code)]
fn _path(_: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    /// Read-only: whether the camera is installed on this PC, whichever the answer. "Installed" is where Windows registered the filter, not
    /// where this instance keeps its own copy (the data folder moved once, and the filter stayed registered in the old one).
    #[test]
    fn the_status_reads_without_installing_anything() {
        let vcam =
            WindowsVcam::new(std::env::temp_dir().join(format!("ssd-vcam-{}", std::process::id())));
        let status = vcam.status().unwrap();
        assert_eq!(status["name"], NAME);
        let registered = vcam
            .registered_dll()
            .is_some_and(|path| is_filter_dll(&path) && path.exists());
        assert_eq!(status["installed"], registered);
        assert_eq!(status["inUse"], false);
        if !registered {
            vcam.feed(&[0xff, 0xd8, 0xff]); // not installed: costs nothing and starts nothing
            assert!(vcam.feeder.locked().is_none());
        }
    }

    /// Not a check, a measurement: `SSD_BENCH_JPEG=frame.jpg cargo test --release -p ssd-platform-windows -- --ignored --nocapture frame_cost`.
    #[test]
    #[ignore]
    fn frame_cost() {
        let path = std::env::var("SSD_BENCH_JPEG").expect("SSD_BENCH_JPEG names a JPEG");
        let jpeg = std::fs::read(path).unwrap();
        let _ = decode_bottom_up_rgba(&jpeg); // warm up
        let started = Instant::now();
        let rounds = 60;
        let mut size = (0, 0);
        for _ in 0..rounds {
            let (w, h, _) = decode_bottom_up_rgba(&jpeg).unwrap();
            size = (w, h);
        }
        let each = started.elapsed().as_secs_f64() * 1000.0 / f64::from(rounds);
        println!("{}x{}: {each:.1} ms per frame (decode and convert), at most {:.0} frames/s on one thread", size.0, size.1, 1000.0 / each);
    }

    #[test]
    fn only_the_filters_dll_counts_wherever_it_lives() {
        assert!(is_filter_dll(Path::new(
            "E:/old/data/vcam/UnityCaptureFilter64.dll"
        )));
        assert!(is_filter_dll(Path::new(
            "C:/Roaming/SelfStreamDeck/vcam/unitycapturefilter64.DLL"
        )));
        assert!(!is_filter_dll(Path::new("C:/Windows/System32/quartz.dll")));
        assert!(!is_filter_dll(Path::new("")));
    }
}
