//! The numbers behind the Desempenho, Processos and Sistema pages, for the `MonitorPort`: Windows performance counters (PDH, one query for
//! everything, collected every second on a thread that rests when nobody asks), `nvidia-smi`, MSI Afterburner / RivaTuner shared memory, the
//! memory status and the process list. Same answers as `legacy/server/native/MonitorOps.cs`; the static "About this PC" part is in `sysinfo.rs`.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use ssd_core::ports::{MonitorPort, PortError, PortResult};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, FILETIME};
use windows::Win32::Storage::FileSystem::{
    GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Memory::{MapViewOfFile, OpenFileMappingW, FILE_MAP_READ};
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
    PdhGetFormattedCounterValue, PdhOpenQueryW, PDH_FMT_COUNTERVALUE, PDH_FMT_COUNTERVALUE_ITEM_W,
    PDH_FMT_DOUBLE, PDH_MORE_DATA,
};
use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows::Win32::System::SystemInformation::{
    GetTickCount64, GlobalMemoryStatusEx, MEMORYSTATUSEX,
};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

const MB: f64 = 1_048_576.0;
const GB: f64 = 1_073_741_824.0;

/// Rounds half away from zero, like `Math.Round(x, digits, MidpointRounding.AwayFromZero)`.
fn round(value: f64, digits: i32) -> Value {
    let factor = 10f64.powi(digits);
    let rounded = (value * factor).round() / factor;
    if digits == 0 {
        json!(rounded as i64)
    } else {
        json!(rounded)
    }
}

fn round_opt(value: Option<f64>, digits: i32) -> Value {
    value.map_or(Value::Null, |v| round(v, digits))
}

fn min100(value: Option<f64>) -> Option<f64> {
    value.map(|v| v.min(100.0))
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

fn ascii_z(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

// ---- performance counters (PDH) ----------------------------------------------------------------------------------------------------

#[derive(Default)]
struct Data {
    arrays: HashMap<&'static str, Vec<(String, f64)>>,
    singles: HashMap<&'static str, f64>,
    collections: u32,
    /// the "Processor Information" utility counter exists (else the old "Processor" object is used)
    utility: bool,
}

struct Shared {
    data: Mutex<Data>,
    last_used: AtomicU64,
    alive: AtomicBool,
}

static PDH: Mutex<Option<Arc<Shared>>> = Mutex::new(None);
/// The collector rests (and its query is closed) when nobody has asked for this long; the next sample starts it again.
const IDLE_STOP: Duration = Duration::from_secs(60);

fn now_ms() -> u64 {
    unsafe { GetTickCount64() }
}

unsafe fn format_array(counter: isize) -> Option<Vec<(String, f64)>> {
    unsafe {
        let (mut size, mut count) = (0u32, 0u32);
        if PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, None)
            != PDH_MORE_DATA
            || size == 0
        {
            return None;
        }
        let mut buffer = vec![0u64; size as usize / 8 + 1];
        let items = buffer.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
        if PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, Some(items))
            != 0
        {
            return None;
        }
        let mut out = Vec::with_capacity(count as usize);
        for item in std::slice::from_raw_parts(items, count as usize) {
            if item.FmtValue.CStatus != 0 && item.FmtValue.CStatus != 1 {
                continue;
            }
            if let Ok(name) = item.szName.to_string() {
                out.push((name, item.FmtValue.Anonymous.doubleValue));
            }
        }
        Some(out)
    }
}

fn collector(shared: Arc<Shared>) {
    unsafe {
        let mut query = 0isize;
        if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != 0 {
            shared.alive.store(false, Ordering::SeqCst);
            return;
        }
        let mut counters: Vec<(&'static str, isize)> = Vec::new();
        let mut add = |key: &'static str, path: &str| -> bool {
            let path = wide(path);
            let mut counter = 0isize;
            let ok = PdhAddEnglishCounterW(query, PCWSTR(path.as_ptr()), 0, &mut counter) == 0;
            if ok {
                counters.push((key, counter));
            }
            ok
        };
        let utility = add("cores", r"\Processor Information(*)\% Processor Utility");
        if !utility {
            add("cores", r"\Processor(*)\% Processor Time");
        }
        add(
            "freq",
            r"\Processor Information(_Total)\Processor Frequency",
        );
        add("processes", r"\System\Processes");
        add("threads", r"\System\Threads");
        add("uptime", r"\System\System Up Time");
        add("diskActive", r"\PhysicalDisk(*)\% Disk Time");
        add("diskRead", r"\PhysicalDisk(*)\Disk Read Bytes/sec");
        add("diskWrite", r"\PhysicalDisk(*)\Disk Write Bytes/sec");
        add("netDown", r"\Network Interface(*)\Bytes Received/sec");
        add("netUp", r"\Network Interface(*)\Bytes Sent/sec");

        PdhCollectQueryData(query); // the baseline for the rates
        {
            let mut data = shared.data.lock().unwrap();
            data.utility = utility;
            data.collections = 1;
        }
        loop {
            std::thread::sleep(Duration::from_secs(1));
            if now_ms().saturating_sub(shared.last_used.load(Ordering::SeqCst))
                > IDLE_STOP.as_millis() as u64
            {
                break;
            }
            if PdhCollectQueryData(query) != 0 {
                continue;
            }
            let mut arrays = HashMap::new();
            let mut singles = HashMap::new();
            for (key, counter) in &counters {
                if let Some(values) = format_array(*counter) {
                    arrays.insert(*key, values);
                }
                let mut value = PDH_FMT_COUNTERVALUE::default();
                if PdhGetFormattedCounterValue(*counter, PDH_FMT_DOUBLE, None, &mut value) == 0
                    && (value.CStatus == 0 || value.CStatus == 1)
                {
                    singles.insert(*key, value.Anonymous.doubleValue);
                }
            }
            let mut data = shared.data.lock().unwrap();
            data.arrays.extend(arrays);
            data.singles.extend(singles);
            data.collections += 1;
        }
        shared.alive.store(false, Ordering::SeqCst);
    }
}

/// The counters, started on the first use and waited for until rates exist (they need two collections, a second apart).
fn counters() -> PortResult<Arc<Shared>> {
    let shared = {
        let mut slot = PDH.lock().unwrap();
        match slot.as_ref().filter(|s| s.alive.load(Ordering::SeqCst)) {
            Some(shared) => shared.clone(),
            None => {
                let shared = Arc::new(Shared {
                    data: Mutex::new(Data::default()),
                    last_used: AtomicU64::new(now_ms()),
                    alive: AtomicBool::new(true),
                });
                let worker = shared.clone();
                std::thread::Builder::new()
                    .name("pdh".into())
                    .spawn(move || collector(worker))
                    .map_err(|e| PortError::Failed(e.to_string()))?;
                *slot = Some(shared.clone());
                shared
            }
        }
    };
    shared.last_used.store(now_ms(), Ordering::SeqCst);
    let until = Instant::now() + Duration::from_millis(2500);
    while Instant::now() < until && shared.data.lock().unwrap().collections < 2 {
        if !shared.alive.load(Ordering::SeqCst) {
            return Err(PortError::Failed("PDH is not available".into()));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(shared)
}

impl Data {
    fn instances(&self, key: &str) -> &[(String, f64)] {
        self.arrays.get(key).map_or(&[], Vec::as_slice)
    }

    fn pick(&self, key: &str, instance: &str) -> Option<f64> {
        self.instances(key)
            .iter()
            .find(|(name, _)| name == instance)
            .map(|(_, v)| *v)
    }

    /// Per-core usage: "0,3" (group,core) instances of Processor Information, or "3" of the old Processor object.
    fn core_usage(&self) -> Vec<f64> {
        let mut cores: Vec<(u32, f64)> = self
            .instances("cores")
            .iter()
            .filter_map(|(name, value)| {
                let order = match name.split_once(',') {
                    Some((group, core)) if self.utility => {
                        group.parse::<u32>().ok()? * 1000 + core.parse::<u32>().ok()?
                    }
                    None if !self.utility => name.parse::<u32>().ok()?,
                    _ => return None,
                };
                Some((order, *value))
            })
            .collect();
        cores.sort_by_key(|(order, _)| *order);
        cores.into_iter().map(|(_, v)| v).collect()
    }
}

// ---- Afterburner and RivaTuner shared memory -----------------------------------------------------------------------------------------

struct Mapping(usize);

// the view is read-only memory owned by another program; reading it from any thread is fine
unsafe impl Send for Mapping {}
unsafe impl Sync for Mapping {}

impl Mapping {
    fn open(name: &str) -> Option<Self> {
        let name = wide(name);
        unsafe {
            let handle = OpenFileMappingW(FILE_MAP_READ.0, false, PCWSTR(name.as_ptr())).ok()?;
            let view = MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0);
            let _ = CloseHandle(handle); // the view keeps the mapping alive
            (!view.Value.is_null()).then_some(Self(view.Value as usize))
        }
    }

    fn u32_at(&self, offset: usize) -> u32 {
        unsafe { ((self.0 + offset) as *const u32).read_unaligned() }
    }

    fn f32_at(&self, offset: usize) -> f32 {
        unsafe { ((self.0 + offset) as *const f32).read_unaligned() }
    }

    fn bytes_at(&self, offset: usize, len: usize) -> Vec<u8> {
        unsafe { std::slice::from_raw_parts((self.0 + offset) as *const u8, len).to_vec() }
    }
}

static MAHM: Mutex<Option<Mapping>> = Mutex::new(None);
static RTSS: Mutex<Option<Mapping>> = Mutex::new(None);

fn mapped(slot: &Mutex<Option<Mapping>>, name: &str) -> bool {
    let mut guard = slot.lock().unwrap();
    if guard.is_none() {
        *guard = Mapping::open(name);
    }
    guard.is_some()
}

/// The sensors MSI Afterburner publishes (name to value).
fn afterburner() -> Option<HashMap<String, f64>> {
    if !mapped(&MAHM, "MAHMSharedMemory") {
        return None;
    }
    let guard = MAHM.lock().unwrap();
    let map = guard.as_ref()?;
    if map.u32_at(0) != 0x4D41_484D {
        drop(guard);
        *MAHM.lock().unwrap() = None;
        return None;
    }
    let (header, count, size) = (
        map.u32_at(8) as usize,
        map.u32_at(12) as usize,
        map.u32_at(16) as usize,
    );
    let mut values = HashMap::new();
    for i in 0..count.min(4096) {
        let offset = header + i * size;
        let name = ascii_z(&map.bytes_at(offset, 260));
        let data = f64::from(map.f32_at(offset + 1300));
        if data.is_nan() || data.abs() > 1e9 {
            continue;
        }
        values.insert(name, data);
    }
    Some(values)
}

/// The frame rate of the game RivaTuner is watching: the entry that drew most recently (within 2 s).
fn rtss_fps() -> Option<Value> {
    if !mapped(&RTSS, "RTSSSharedMemoryV2") {
        return None;
    }
    let guard = RTSS.lock().unwrap();
    let map = guard.as_ref()?;
    if map.u32_at(0) != 0x5254_5353 {
        drop(guard);
        *RTSS.lock().unwrap() = None;
        return None;
    }
    let (entry_size, array_offset, count) = (
        map.u32_at(8) as usize,
        map.u32_at(12) as usize,
        map.u32_at(16).min(256) as usize,
    );
    if entry_size < 284 {
        return None;
    }
    let now = (now_ms() & 0xffff_ffff) as i64;
    let mut best: Option<(i64, Value)> = None;
    for i in 0..count {
        let offset = array_offset + i * entry_size;
        if map.u32_at(offset) == 0 {
            continue;
        }
        let (time0, time1) = (
            i64::from(map.u32_at(offset + 268)),
            i64::from(map.u32_at(offset + 272)),
        );
        let (frames, frame_time_us) = (map.u32_at(offset + 276), map.u32_at(offset + 280));
        let age = (now - time1 + 4_294_967_296) % 4_294_967_296;
        let span = (time1 - time0 + 4_294_967_296) % 4_294_967_296;
        if age > 2000 {
            continue;
        }
        let fps = if span > 0 && frames > 0 {
            1000.0 * f64::from(frames) / span as f64
        } else if frame_time_us > 0 {
            1e6 / f64::from(frame_time_us)
        } else {
            0.0
        };
        if fps <= 0.0 || best.as_ref().is_some_and(|(best_age, _)| *best_age <= age) {
            continue;
        }
        let path = ascii_z(&map.bytes_at(offset + 4, 260));
        let app = std::path::Path::new(&path.replace('\\', "/"))
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let frame_ms = if frame_time_us > 0 {
            f64::from(frame_time_us) / 1000.0
        } else {
            1000.0 / fps
        };
        best = Some((
            age,
            json!({ "source": "RTSS", "app": app, "fps": round(fps, 0), "frameMs": round(frame_ms, 1) }),
        ));
    }
    best.map(|(_, entry)| entry)
}

/// The game's frame rate: RivaTuner first, else Afterburner's own counter.
fn read_fps(sensors: Option<&HashMap<String, f64>>) -> Value {
    if let Some(entry) = rtss_fps() {
        return entry;
    }
    match sensors
        .and_then(|s| s.get("Framerate"))
        .copied()
        .filter(|f| *f > 0.0)
    {
        Some(framerate) => {
            json!({ "source": "MSI Afterburner", "app": Value::Null, "fps": round(framerate, 0), "frameMs": round(1000.0 / framerate, 1) })
        }
        None => Value::Null,
    }
}

// ---- GPU (nvidia-smi) -----------------------------------------------------------------------------------------------------------------

static SMI_PATH: Mutex<Option<Option<std::path::PathBuf>>> = Mutex::new(None);
static GPU_CACHE: Mutex<Option<(Instant, Value)>> = Mutex::new(None);

fn find_smi() -> Option<std::path::PathBuf> {
    let mut slot = SMI_PATH.lock().unwrap();
    slot.get_or_insert_with(|| {
        std::env::var_os("PATH").and_then(|path| {
            std::env::split_paths(&path)
                .map(|dir| dir.join("nvidia-smi.exe"))
                .find(|candidate| candidate.is_file())
        })
    })
    .clone()
}

fn number(text: &str) -> Value {
    text.trim().parse::<f64>().map_or(Value::Null, |n| json!(n))
}

fn read_gpu() -> Value {
    use std::os::windows::process::CommandExt;
    let Some(smi) = find_smi() else {
        return Value::Null;
    };
    if let Some((at, value)) = GPU_CACHE.lock().unwrap().as_ref() {
        if at.elapsed() < Duration::from_millis(1200) {
            return value.clone();
        }
    }
    const FIELDS: &str = "name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,power.limit,fan.speed,clocks.gr,clocks.max.gr,clocks.mem,pstate,driver_version";
    let value = std::process::Command::new(smi)
        .arg(format!("--query-gpu={FIELDS}"))
        .arg("--format=csv,noheader,nounits")
        .creation_flags(0x0800_0000)
        .output()
        .ok()
        .and_then(|output| {
            let text = String::from_utf8_lossy(&output.stdout).into_owned();
            let row: Vec<String> = text.lines().next()?.split(',').map(|part| part.trim().to_owned()).collect();
            (row.len() >= 13).then(|| {
                json!({
                    "source": "nvidia-smi", "name": row[0], "temp": number(&row[1]), "usage": number(&row[2]), "memUsedMB": number(&row[3]), "memTotalMB": number(&row[4]),
                    "power": number(&row[5]), "powerLimit": number(&row[6]), "fan": number(&row[7]), "clock": number(&row[8]), "clockMax": number(&row[9]),
                    "memClock": number(&row[10]), "pstate": row[11], "driver": row[12],
                })
            })
        })
        .unwrap_or(Value::Null);
    *GPU_CACHE.lock().unwrap() = Some((Instant::now(), value.clone()));
    value
}

// ---- drives ---------------------------------------------------------------------------------------------------------------------------

/// The fixed drives, ready: `(name "C:", label, file system, total bytes, free bytes)`.
pub(crate) fn fixed_drives() -> Vec<(String, String, String, f64, f64)> {
    let mut out = Vec::new();
    unsafe {
        let mask = GetLogicalDrives();
        for letter in 0..26u32 {
            if mask & (1 << letter) == 0 {
                continue;
            }
            let root = wide(&format!("{}:\\", (b'A' + letter as u8) as char));
            if GetDriveTypeW(PCWSTR(root.as_ptr())) != 3 {
                continue; // DRIVE_FIXED
            }
            let (mut label, mut fs) = ([0u16; 261], [0u16; 261]);
            if GetVolumeInformationW(
                PCWSTR(root.as_ptr()),
                Some(&mut label),
                None,
                None,
                None,
                Some(&mut fs),
            )
            .is_err()
            {
                continue; // not ready
            }
            let (mut free, mut total) = (0u64, 0u64);
            if GetDiskFreeSpaceExW(
                PCWSTR(root.as_ptr()),
                Some(&mut free),
                Some(&mut total),
                None,
            )
            .is_err()
            {
                continue;
            }
            let text = |buffer: &[u16]| {
                String::from_utf16_lossy(
                    &buffer[..buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len())],
                )
            };
            out.push((
                format!("{}:", (b'A' + letter as u8) as char),
                text(&label),
                text(&fs),
                total as f64,
                free as f64,
            ));
        }
    }
    out
}

// ---- processes ------------------------------------------------------------------------------------------------------------------------

struct ProcessClock {
    cpu_seconds: HashMap<u32, f64>,
    at: Instant,
}

static PROCESS_CLOCK: Mutex<Option<ProcessClock>> = Mutex::new(None);

fn filetime_seconds(time: FILETIME) -> f64 {
    ((u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)) as f64 / 1e7
}

#[derive(Default)]
struct Group {
    cpu: f64,
    mem: f64,
    count: u32,
}

/// The six programs using most CPU and the six using most memory, grouped by program name.
fn read_top_processes() -> Value {
    let cores = std::thread::available_parallelism().map_or(1, |n| n.get()) as f64;
    let mut clock = PROCESS_CLOCK.lock().unwrap();
    let previous = clock.take().unwrap_or(ProcessClock {
        cpu_seconds: HashMap::new(),
        at: Instant::now(),
    });
    let elapsed = previous.at.elapsed().as_secs_f64().max(0.2);
    let mut cpu_now: HashMap<u32, f64> = HashMap::new();
    let mut groups: Vec<(String, Group)> = Vec::new();
    unsafe {
        if let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
            while more {
                let pid = entry.th32ProcessID;
                let file = String::from_utf16_lossy(
                    &entry.szExeFile[..entry
                        .szExeFile
                        .iter()
                        .position(|&c| c == 0)
                        .unwrap_or(entry.szExeFile.len())],
                );
                let name = file
                    .strip_suffix(".exe")
                    .or_else(|| file.strip_suffix(".EXE"))
                    .unwrap_or(&file)
                    .to_owned();
                if pid != 0 {
                    let (mut cpu, mut memory) = (0.0, 0.0);
                    if let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
                    {
                        let (mut created, mut exited, mut kernel, mut user) = (
                            FILETIME::default(),
                            FILETIME::default(),
                            FILETIME::default(),
                            FILETIME::default(),
                        );
                        if GetProcessTimes(
                            process,
                            &mut created,
                            &mut exited,
                            &mut kernel,
                            &mut user,
                        )
                        .is_ok()
                        {
                            cpu = filetime_seconds(kernel) + filetime_seconds(user);
                        }
                        let mut counters = PROCESS_MEMORY_COUNTERS {
                            cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
                            ..Default::default()
                        };
                        if GetProcessMemoryInfo(process, &mut counters, counters.cb).is_ok() {
                            memory = counters.WorkingSetSize as f64 / MB;
                        }
                        let _ = CloseHandle(process);
                    }
                    let delta = previous
                        .cpu_seconds
                        .get(&pid)
                        .map_or(0.0, |before| (cpu - before).max(0.0));
                    cpu_now.insert(pid, cpu);
                    let group = match groups.iter_mut().find(|(n, _)| *n == name) {
                        Some((_, g)) => g,
                        None => {
                            groups.push((name, Group::default()));
                            &mut groups.last_mut().unwrap().1
                        }
                    };
                    group.cpu += delta / elapsed / cores * 100.0;
                    group.mem += memory;
                    group.count += 1;
                }
                more = Process32NextW(snapshot, &mut entry).is_ok();
            }
            let _ = CloseHandle(snapshot);
        }
    }
    *clock = Some(ProcessClock {
        cpu_seconds: cpu_now,
        at: Instant::now(),
    });
    let row = |(name, g): &(String, Group)| json!({ "name": name, "cpu": round(g.cpu, 1), "memMB": round(g.mem, 0), "count": g.count });
    let mut by_cpu: Vec<&(String, Group)> = groups.iter().collect();
    by_cpu.sort_by(|a, b| b.1.cpu.total_cmp(&a.1.cpu));
    let mut by_mem: Vec<&(String, Group)> = groups.iter().collect();
    by_mem.sort_by(|a, b| b.1.mem.total_cmp(&a.1.mem));
    json!({ "cpu": by_cpu.into_iter().take(6).map(row).collect::<Vec<_>>(), "mem": by_mem.into_iter().take(6).map(row).collect::<Vec<_>>() })
}

// ---- the port -------------------------------------------------------------------------------------------------------------------------

#[derive(Default)]
pub struct WindowsMonitor;

impl MonitorPort for WindowsMonitor {
    fn sample(&self) -> PortResult<Value> {
        let shared = counters()?;
        let _ = read_top_processes_prime();
        let data = shared.data.lock().unwrap();
        let sensors = afterburner();
        let sensor = |key: &str| sensors.as_ref().and_then(|s| s.get(key)).copied();

        let mut status = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        unsafe {
            let _ = GlobalMemoryStatusEx(&mut status);
        }
        let mut result = Map::new();

        let cores = data.core_usage();
        result.insert(
            "cpu".into(),
            json!({
                "usage": round_opt(min100(data.pick("cores", "_Total")), 1),
                "cores": cores.iter().map(|c| round(c.min(100.0), 0)).collect::<Vec<_>>(),
                // the Windows counter reports the nominal clock; Afterburner has the live boost clock
                "freqMHz": if let Some(clock) = sensor("CPU clock") { round(clock, 0) } else { round_opt(data.pick("freq", "_Total"), 0) },
                "temp": if sensors.is_some() { round_opt(sensor("CPU temperature"), 1) } else { Value::Null },
                "power": if sensors.is_some() { round_opt(sensor("CPU power"), 1) } else { Value::Null },
                "tempSource": if sensor("CPU temperature").is_some() { json!("MSI Afterburner") } else { Value::Null },
                "processes": data.singles.get("processes").copied().unwrap_or(0.0) as i64,
                "threads": data.singles.get("threads").copied().unwrap_or(0.0) as i64,
            }),
        );
        result.insert(
            "memory".into(),
            json!({
                "totalMB": round(status.ullTotalPhys as f64 / MB, 0),
                "usedMB": round((status.ullTotalPhys - status.ullAvailPhys) as f64 / MB, 0),
                "usedPct": status.dwMemoryLoad,
                "commitUsedMB": round((status.ullTotalPageFile - status.ullAvailPageFile) as f64 / MB, 0),
                "commitLimitMB": round(status.ullTotalPageFile as f64 / MB, 0),
            }),
        );
        result.insert("gpu".into(), read_gpu());
        result.insert("fps".into(), read_fps(sensors.as_ref()));

        let disk_row = |name: &str| json!({ "active": round_opt(min100(data.pick("diskActive", name)), 0), "readBps": round_opt(data.pick("diskRead", name), 0), "writeBps": round_opt(data.pick("diskWrite", name), 0) });
        let disks: Vec<Value> = data
            .instances("diskActive")
            .iter()
            .filter(|(name, _)| name != "_Total")
            .map(|(name, _)| {
                let mut row = Map::new();
                row.insert("name".into(), json!(name));
                if let Value::Object(rest) = disk_row(name) {
                    row.extend(rest);
                }
                Value::Object(row)
            })
            .collect();
        let has_total = data
            .instances("diskActive")
            .iter()
            .any(|(name, _)| name == "_Total");
        let drives: Vec<Value> = fixed_drives().into_iter().map(|(name, label, _, total, free)| json!({ "name": name, "label": label, "totalGB": round(total / GB, 0), "freeGB": round(free / GB, 1) })).collect();
        result.insert("disk".into(), json!({ "disks": disks, "total": if has_total { disk_row("_Total") } else { Value::Null }, "drives": drives }));

        let instances = data.instances("netDown");
        let network: Vec<Value> = crate::sysinfo::adapters()
            .iter()
            .filter_map(|adapter| {
                let wanted = crate::sysinfo::counter_instance(&adapter.description);
                let instance = instances.iter().map(|(name, _)| name).find(|name| **name == wanted)?;
                Some(json!({ "name": adapter.name, "speed": adapter.speed, "downBps": round_opt(data.pick("netDown", instance), 0), "upBps": round_opt(data.pick("netUp", instance), 0) }))
            })
            .collect();
        result.insert("network".into(), Value::Array(network));
        result.insert(
            "uptime".into(),
            round_opt(data.singles.get("uptime").copied(), 0),
        );
        Ok(Value::Object(result))
    }

    fn fps(&self) -> PortResult<Value> {
        Ok(read_fps(afterburner().as_ref()))
    }

    fn processes(&self) -> PortResult<Value> {
        // the first call only sets the CPU baseline (a delta needs two readings)
        Ok(read_top_processes())
    }

    fn info(&self) -> PortResult<Value> {
        crate::sysinfo::system_info(&crate::windows_mgmt::WindowsWindows)
    }
}

/// A sample also primes the process baseline, as the Node helper's `Init` did, so the first Processos page has deltas.
fn read_top_processes_prime() -> bool {
    PROCESS_CLOCK.lock().unwrap().is_none() && {
        let _ = read_top_processes();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding_goes_away_from_zero_like_dotnet() {
        assert_eq!(round(2.5, 0), json!(3));
        assert_eq!(round(-2.5, 0), json!(-3));
        assert_eq!(round(1.25, 1), json!(1.3));
        assert_eq!(round_opt(None, 1), Value::Null);
    }

    #[test]
    fn the_real_counters_give_a_full_sample() {
        let sample = WindowsMonitor.sample().expect("a sample");
        let usage = sample["cpu"]["usage"].as_f64().expect("cpu usage");
        assert!((0.0..=100.0).contains(&usage), "{usage}");
        assert!(!sample["cpu"]["cores"].as_array().unwrap().is_empty());
        assert!(sample["memory"]["totalMB"].as_i64().unwrap() > 1000);
        assert!(sample["disk"]["drives"]
            .as_array()
            .unwrap()
            .iter()
            .all(|d| d["totalGB"].as_i64().unwrap() > 0));
        assert!(sample["uptime"].as_i64().unwrap() > 0);
        let keys: Vec<&str> = sample
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            ["cpu", "memory", "gpu", "fps", "disk", "network", "uptime"]
        );
    }

    #[test]
    fn the_process_list_has_six_and_six() {
        let _ = WindowsMonitor.processes().unwrap();
        std::thread::sleep(Duration::from_millis(400));
        let top = WindowsMonitor.processes().unwrap();
        assert_eq!(top["cpu"].as_array().unwrap().len(), 6);
        assert_eq!(top["mem"].as_array().unwrap().len(), 6);
        assert!(top["mem"][0]["memMB"].as_i64().unwrap() > 0);
    }

    #[test]
    fn frame_rate_is_null_or_a_reading() {
        let fps = WindowsMonitor.fps().unwrap();
        assert!(fps.is_null() || fps["fps"].as_i64().unwrap() > 0);
    }
}
