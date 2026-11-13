//! "About this PC" and the network adapters: the static description of the machine (Windows, processor, memory modules, graphics, board,
//! disks, drives, network, screens), read from WMI, the registry and the IP helper. Same answers as `SystemInfo()` of the Node helper.
use ssd_core::sync::Locked;
use std::sync::Mutex;
use std::time::Instant;

use serde::Deserialize;
use serde_json::{json, Value};
use ssd_core::ports::{PortError, PortResult, WindowsPort};
use wmi::WMIConnection;

const GB: f64 = 1_073_741_824.0;

fn round(value: f64, digits: i32) -> Value {
    let factor = 10f64.powi(digits);
    let rounded = (value * factor).round() / factor;
    if digits == 0 {
        json!(rounded as i64)
    } else {
        json!(rounded)
    }
}

fn failed(error: impl std::fmt::Display) -> PortError {
    PortError::Failed(error.to_string())
}

fn connect(namespace: Option<&str>) -> Option<WMIConnection> {
    match namespace {
        Some(path) => WMIConnection::with_namespace_path(path).ok(),
        None => WMIConnection::new().ok(),
    }
}

/// Rows of a WMI query (an empty list when the class or the namespace is not there).
fn query<T: serde::de::DeserializeOwned>(namespace: Option<&str>, text: &str) -> Vec<T> {
    connect(namespace)
        .and_then(|wmi| wmi.raw_query(text).ok())
        .unwrap_or_default()
}

// ---- network adapters ----------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Adapter {
    pub name: String,
    pub description: String,
    pub speed: String,
    pub mac: String,
    pub index: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct NetAdapterRow {
    name: Option<String>,
    interface_description: Option<String>,
    interface_index: Option<u32>,
    interface_operational_status: Option<u32>,
    speed: Option<u64>,
    permanent_address: Option<String>,
}

fn trim_number(value: f64) -> String {
    let text = format!("{value:.2}");
    text.trim_end_matches('0').trim_end_matches('.').to_owned()
}

fn link_speed(bits: u64) -> String {
    match bits {
        0 => "0 bps".into(),
        b if b >= 1_000_000_000 => format!("{} Gbps", trim_number(b as f64 / 1e9)),
        b if b >= 1_000_000 => format!("{} Mbps", trim_number(b as f64 / 1e6)),
        b if b >= 1_000 => format!("{} Kbps", trim_number(b as f64 / 1e3)),
        b => format!("{b} bps"),
    }
}

static ADAPTERS: Mutex<Option<(Instant, Vec<Adapter>)>> = Mutex::new(None);

/// The physical network adapters that are up (asked again at most every 30 s: WMI is slow).
pub fn adapters() -> Vec<Adapter> {
    let mut cache = ADAPTERS.locked();
    if let Some((at, list)) = cache.as_ref() {
        if at.elapsed().as_secs() < 30 {
            return list.clone();
        }
    }
    let rows: Vec<NetAdapterRow> = query(
        Some("ROOT\\StandardCimv2"),
        "SELECT Name, InterfaceDescription, InterfaceIndex, InterfaceOperationalStatus, Speed, HardwareInterface, PermanentAddress FROM MSFT_NetAdapter WHERE HardwareInterface = TRUE",
    );
    let list: Vec<Adapter> = rows
        .into_iter()
        .filter(|row| row.interface_operational_status == Some(1)) // 1 is up
        .map(|row| {
            let mut mac = row.permanent_address.unwrap_or_default();
            if mac.len() == 12 {
                mac = (0..6)
                    .map(|i| mac[i * 2..i * 2 + 2].to_owned())
                    .collect::<Vec<_>>()
                    .join("-");
            }
            Adapter {
                name: row.name.unwrap_or_default(),
                description: row.interface_description.unwrap_or_default(),
                speed: link_speed(row.speed.unwrap_or(0)),
                mac,
                index: row.interface_index.unwrap_or(0),
            }
        })
        .collect();
    *cache = Some((Instant::now(), list.clone()));
    list
}

/// The name a performance-counter instance gives an adapter: its description with a few characters replaced.
pub fn counter_instance(description: &str) -> String {
    description
        .chars()
        .map(|c| match c {
            '(' => '[',
            ')' => ']',
            '#' | '\\' | '/' => '_',
            other => other,
        })
        .collect()
}

// ---- the IPv4 address of an adapter ----------------------------------------------------------------------------------------------------

fn ipv4_of(index: u32) -> Option<String> {
    use windows::Win32::Foundation::ERROR_BUFFER_OVERFLOW;
    use windows::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
        GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows::Win32::Networking::WinSock::{AF_INET, SOCKADDR_IN};
    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    let mut size = 16 * 1024u32;
    for _ in 0..3 {
        let mut buffer = vec![0u64; size as usize / 8 + 1];
        let first = buffer.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH;
        let result = unsafe {
            GetAdaptersAddresses(u32::from(AF_INET.0), flags, None, Some(first), &mut size)
        };
        if result == ERROR_BUFFER_OVERFLOW.0 {
            continue;
        }
        if result != 0 {
            return None;
        }
        let mut adapter = first;
        unsafe {
            while !adapter.is_null() {
                if (*adapter).Anonymous1.Anonymous.IfIndex == index {
                    let mut unicast = (*adapter).FirstUnicastAddress;
                    while !unicast.is_null() {
                        let socket = (*unicast).Address.lpSockaddr;
                        if !socket.is_null() && (*socket).sa_family == AF_INET {
                            let v4 = &*(socket as *const SOCKADDR_IN);
                            let octets = v4.sin_addr.S_un.S_un_b;
                            return Some(format!(
                                "{}.{}.{}.{}",
                                octets.s_b1, octets.s_b2, octets.s_b3, octets.s_b4
                            ));
                        }
                        unicast = (*unicast).Next;
                    }
                }
                adapter = (*adapter).Next;
            }
        }
        return None;
    }
    None
}

// ---- Windows' description of the machine ----------------------------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct OsRow {
    caption: Option<String>,
    version: Option<String>,
    build_number: Option<String>,
    #[serde(rename = "OSArchitecture")]
    os_architecture: Option<String>,
    install_date: Option<String>,
    last_boot_up_time: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct CpuRow {
    name: Option<String>,
    number_of_cores: Option<u32>,
    number_of_logical_processors: Option<u32>,
    max_clock_speed: Option<u32>,
    #[serde(rename = "L2CacheSize")]
    l2_cache_size: Option<u32>,
    #[serde(rename = "L3CacheSize")]
    l3_cache_size: Option<u32>,
    socket_designation: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct BoardRow {
    manufacturer: Option<String>,
    product: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct BiosRow {
    #[serde(rename = "SMBIOSBIOSVersion")]
    smbios_bios_version: Option<String>,
    release_date: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct MemoryRow {
    device_locator: Option<String>,
    capacity: Option<u64>,
    configured_clock_speed: Option<u32>,
    #[serde(rename = "SMBIOSMemoryType")]
    smbios_memory_type: Option<u32>,
    manufacturer: Option<String>,
    part_number: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct VideoRow {
    name: Option<String>,
    driver_version: Option<String>,
    #[serde(rename = "AdapterRAM")]
    adapter_ram: Option<u64>,
    current_refresh_rate: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct DiskRow {
    friendly_name: Option<String>,
    size: Option<u64>,
    media_type: Option<u32>,
    bus_type: Option<u32>,
    health_status: Option<u32>,
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468
}

/// "20260101123045.000000-180" (a CIM date: local time of the moment plus its offset in minutes) as the ISO-8601 *local time of this PC* with
/// its offset ("2026-01-01T12:30:45.0000000-03:00"), what `ManagementDateTimeConverter.ToDateTime(...).ToString("o")` printed.
fn iso_of_cim(text: Option<String>) -> Value {
    use windows::Win32::Foundation::SYSTEMTIME;
    use windows::Win32::System::Time::SystemTimeToTzSpecificLocalTime;
    let Some(text) = text.filter(|t| t.len() >= 25) else {
        return Value::Null;
    };
    let number = |range: std::ops::Range<usize>| text[range].parse::<i64>().ok();
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second), Some(offset)) = (
        number(0..4),
        number(4..6),
        number(6..8),
        number(8..10),
        number(10..12),
        number(12..14),
        number(21..25),
    ) else {
        return Value::Null;
    };
    // the instant, in seconds since 1970 (UTC)
    let utc = days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second
        - offset * 60;
    let (days, rest) = (utc.div_euclid(86_400), utc.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let (d, m) = (
        doy - (153 * mp + 2) / 5 + 1,
        if mp < 10 { mp + 3 } else { mp - 9 },
    );
    let y = yoe + era * 400 + i64::from(m <= 2);
    let utc_time = SYSTEMTIME {
        wYear: y as u16,
        wMonth: m as u16,
        wDay: d as u16,
        wHour: (rest / 3600) as u16,
        wMinute: (rest % 3600 / 60) as u16,
        wSecond: (rest % 60) as u16,
        ..Default::default()
    };
    let mut local = SYSTEMTIME::default();
    if unsafe { SystemTimeToTzSpecificLocalTime(None, &utc_time, &mut local) }.is_err() {
        return Value::Null;
    }
    let local_secs = days_from_civil(
        i64::from(local.wYear),
        i64::from(local.wMonth),
        i64::from(local.wDay),
    ) * 86_400
        + i64::from(local.wHour) * 3600
        + i64::from(local.wMinute) * 60
        + i64::from(local.wSecond);
    let offset_minutes = (local_secs - utc) / 60;
    let (sign, minutes) = if offset_minutes < 0 {
        ('-', -offset_minutes)
    } else {
        ('+', offset_minutes)
    };
    let micro = &text[15..21];
    json!(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{micro}0{sign}{:02}:{:02}",
        local.wYear,
        local.wMonth,
        local.wDay,
        local.wHour,
        local.wMinute,
        local.wSecond,
        minutes / 60,
        minutes % 60
    ))
}

fn lookup(map: &[(u32, &str)], value: Option<u32>) -> String {
    match value {
        None => String::new(),
        Some(key) => map
            .iter()
            .find(|(k, _)| *k == key)
            .map_or_else(|| key.to_string(), |(_, name)| (*name).to_owned()),
    }
}

const MEMORY_TYPES: [(u32, &str); 5] = [
    (20, "DDR"),
    (21, "DDR2"),
    (24, "DDR3"),
    (26, "DDR4"),
    (34, "DDR5"),
];
const MEDIA_TYPES: [(u32, &str); 4] = [(0, "Unspecified"), (3, "HDD"), (4, "SSD"), (5, "SCM")];
const BUS_TYPES: [(u32, &str); 18] = [
    (0, "Unknown"),
    (1, "SCSI"),
    (2, "ATAPI"),
    (3, "ATA"),
    (4, "1394"),
    (5, "SSA"),
    (6, "Fibre Channel"),
    (7, "USB"),
    (8, "RAID"),
    (9, "iSCSI"),
    (10, "SAS"),
    (11, "SATA"),
    (12, "SD"),
    (13, "MMC"),
    (14, "MAX"),
    (15, "File Backed Virtual"),
    (16, "Storage Spaces"),
    (17, "NVMe"),
];
const HEALTH: [(u32, &str); 4] = [
    (0, "Healthy"),
    (1, "Warning"),
    (2, "Unhealthy"),
    (5, "Unknown"),
];

/// The real graphics memory per adapter, from the registry (`Win32_VideoController.AdapterRAM` is a 32-bit number that stops at 4 GB).
fn registry_gpus() -> Vec<(String, f64)> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE,
        KEY_READ, RRF_RT_REG_QWORD, RRF_RT_REG_SZ,
    };
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let class =
        wide(r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}");
    let mut found = Vec::new();
    unsafe {
        let mut root = HKEY::default();
        if RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(class.as_ptr()),
            0,
            KEY_READ,
            &mut root,
        )
        .0 != 0
        {
            return found;
        }
        for index in 0.. {
            let mut name = [0u16; 256];
            let mut length = name.len() as u32;
            if RegEnumKeyExW(
                root,
                index,
                windows::core::PWSTR(name.as_mut_ptr()),
                &mut length,
                None,
                windows::core::PWSTR::null(),
                None,
                None,
            )
            .0 != 0
            {
                break;
            }
            let mut sub = HKEY::default();
            if RegOpenKeyExW(root, PCWSTR(name.as_ptr()), 0, KEY_READ, &mut sub).0 != 0 {
                continue;
            }
            let mut description = [0u16; 512];
            let mut bytes = (description.len() * 2) as u32;
            let key = wide("DriverDesc");
            let ok = RegGetValueW(
                sub,
                PCWSTR::null(),
                PCWSTR(key.as_ptr()),
                RRF_RT_REG_SZ,
                None,
                Some(description.as_mut_ptr() as *mut _),
                Some(&mut bytes),
            )
            .0 == 0;
            if ok {
                let text = String::from_utf16_lossy(
                    &description[..description.iter().position(|&c| c == 0).unwrap_or(0)],
                );
                let (mut size, mut size_len) = (0u64, 8u32);
                let value = wide("HardwareInformation.qwMemorySize");
                let has = RegGetValueW(
                    sub,
                    PCWSTR::null(),
                    PCWSTR(value.as_ptr()),
                    RRF_RT_REG_QWORD,
                    None,
                    Some(&mut size as *mut u64 as *mut _),
                    Some(&mut size_len),
                )
                .0 == 0;
                found.push((text, if has { size as f64 } else { 0.0 }));
            }
            let _ = RegCloseKey(sub);
        }
        let _ = RegCloseKey(root);
    }
    found
}

pub fn system_info(windows: &dyn WindowsPort) -> PortResult<Value> {
    let os: Option<OsRow> = query(None, "SELECT Caption, Version, BuildNumber, OSArchitecture, InstallDate, LastBootUpTime FROM Win32_OperatingSystem").into_iter().next();
    let cpu: Option<CpuRow> = query(None, "SELECT Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed, L2CacheSize, L3CacheSize, SocketDesignation FROM Win32_Processor").into_iter().next();
    let board: Option<BoardRow> = query(None, "SELECT Manufacturer, Product FROM Win32_BaseBoard")
        .into_iter()
        .next();
    let bios: Option<BiosRow> = query(
        None,
        "SELECT SMBIOSBIOSVersion, ReleaseDate FROM Win32_BIOS",
    )
    .into_iter()
    .next();
    let modules: Vec<MemoryRow> = query(None, "SELECT DeviceLocator, Capacity, ConfiguredClockSpeed, SMBIOSMemoryType, Manufacturer, PartNumber FROM Win32_PhysicalMemory");
    let video: Vec<VideoRow> = query(
        None,
        "SELECT Name, DriverVersion, AdapterRAM, CurrentRefreshRate FROM Win32_VideoController",
    );
    let disks: Vec<DiskRow> = query(
        Some("ROOT\\Microsoft\\Windows\\Storage"),
        "SELECT FriendlyName, Size, MediaType, BusType, HealthStatus FROM MSFT_PhysicalDisk",
    );

    let registry = registry_gpus();
    let gpus: Vec<Value> = video
        .into_iter()
        .map(|v| {
            let vram = registry.iter().find(|(name, size)| Some(name) == v.name.as_ref() && *size > 0.0).map_or(v.adapter_ram.unwrap_or(0) as f64, |(_, size)| *size);
            json!({ "name": v.name, "driver": v.driver_version, "vramGB": round(vram / GB, 1), "refreshHz": v.current_refresh_rate })
        })
        .collect();
    let storage: Vec<Value> = disks
        .into_iter()
        .map(|d| json!({ "model": d.friendly_name, "sizeGB": round(d.size.unwrap_or(0) as f64 / GB, 0), "type": lookup(&MEDIA_TYPES, d.media_type), "bus": lookup(&BUS_TYPES, d.bus_type), "health": lookup(&HEALTH, d.health_status) }))
        .collect();
    let drives: Vec<Value> = crate::monitor::fixed_drives()
        .into_iter()
        .map(|(name, label, fs, total, free)| json!({ "name": name, "label": label, "fs": fs, "totalGB": round(total / GB, 0), "freeGB": round(free / GB, 0) }))
        .collect();
    let network: Vec<Value> = adapters()
        .into_iter()
        .map(|a| json!({ "name": a.name, "description": a.description, "speed": a.speed, "mac": a.mac, "ip": ipv4_of(a.index) }))
        .collect();
    let monitors: Vec<Value> = windows
        .monitors(false)
        .map_err(failed)?
        .into_iter()
        .map(|m| json!({ "name": m.device.trim_start_matches("\\\\.\\"), "width": m.width, "height": m.height, "primary": m.primary }))
        .collect();
    let total_bytes: f64 = modules.iter().map(|m| m.capacity.unwrap_or(0) as f64).sum();
    let memory_modules: Vec<Value> = modules
        .into_iter()
        .map(|m| json!({ "slot": m.device_locator, "sizeGB": round(m.capacity.unwrap_or(0) as f64 / GB, 0), "speed": m.configured_clock_speed, "type": lookup(&MEMORY_TYPES, m.smbios_memory_type), "maker": m.manufacturer, "part": m.part_number.unwrap_or_default().trim() }))
        .collect();

    let squeeze = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
    Ok(json!({
        "host": std::env::var("COMPUTERNAME").unwrap_or_default().to_uppercase(),
        "user": std::env::var("USERNAME").unwrap_or_default(),
        "os": {
            "name": os.as_ref().and_then(|o| o.caption.clone()), "version": os.as_ref().and_then(|o| o.version.clone()), "build": os.as_ref().and_then(|o| o.build_number.clone()),
            "arch": os.as_ref().and_then(|o| o.os_architecture.clone()), "installed": iso_of_cim(os.as_ref().and_then(|o| o.install_date.clone())), "lastBoot": iso_of_cim(os.as_ref().and_then(|o| o.last_boot_up_time.clone())),
        },
        "cpu": {
            "name": squeeze(cpu.as_ref().and_then(|c| c.name.as_deref()).unwrap_or("")), "cores": cpu.as_ref().and_then(|c| c.number_of_cores), "threads": cpu.as_ref().and_then(|c| c.number_of_logical_processors),
            "maxMHz": cpu.as_ref().and_then(|c| c.max_clock_speed), "l2KB": cpu.as_ref().and_then(|c| c.l2_cache_size), "l3KB": cpu.as_ref().and_then(|c| c.l3_cache_size), "socket": cpu.as_ref().and_then(|c| c.socket_designation.clone()),
        },
        "memory": { "totalGB": round(total_bytes / GB, 0), "modules": memory_modules },
        "gpus": gpus,
        "board": { "maker": board.as_ref().and_then(|b| b.manufacturer.clone()), "model": board.as_ref().and_then(|b| b.product.clone()), "bios": bios.as_ref().and_then(|b| b.smbios_bios_version.clone()), "biosDate": iso_of_cim(bios.as_ref().and_then(|b| b.release_date.clone())) },
        "storage": storage,
        "drives": drives,
        "network": network,
        "monitors": monitors,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_speeds_read_like_the_control_panel() {
        assert_eq!(link_speed(0), "0 bps");
        assert_eq!(link_speed(585_000_000), "585 Mbps");
        assert_eq!(link_speed(1_000_000_000), "1 Gbps");
        assert_eq!(link_speed(2_500_000_000), "2.5 Gbps");
        assert_eq!(link_speed(56_000), "56 Kbps");
    }

    #[test]
    fn counter_instances_replace_the_characters_windows_does() {
        assert_eq!(
            counter_instance("Intel(R) Wi-Fi 6 AX201 160MHz"),
            "Intel[R] Wi-Fi 6 AX201 160MHz"
        );
        assert_eq!(
            counter_instance("Realtek PCIe GbE #2/x"),
            "Realtek PCIe GbE _2_x"
        );
    }

    #[test]
    fn cim_dates_keep_the_instant_whatever_the_zone_of_this_pc() {
        let text = |v: Value| v.as_str().unwrap().to_owned();
        // the same moment written in two zones prints the same local time
        let a = text(iso_of_cim(Some("20260601120000.000000-180".into())));
        let b = text(iso_of_cim(Some("20260601150000.000000+000".into())));
        assert_eq!(a, b);
        assert!(
            a.len() == 33
                && a.contains('T')
                && (a.ends_with(":00") || a.ends_with(":30") || a.ends_with(":45")),
            "{a}"
        );
        assert_eq!(iso_of_cim(None), Value::Null);
    }
}
