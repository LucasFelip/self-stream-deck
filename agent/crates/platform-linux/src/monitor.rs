//! The PC's monitor on Linux, from `/proc` (`MonitorPort`). The sample's CPU and memory are real; the GPU, the disks and the network are empty for now
//! (the spike's limit: ADR 0013), shaped as the contract wants them.
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use ssd_core::ports::{MonitorPort, PortError, PortResult};

use crate::procfs::{self, CpuTimes};

#[derive(Default)]
pub struct LinuxMonitor {
    /// the last reading of the CPUs: the usage is the difference to the next one
    last: Mutex<Option<(CpuTimes, Vec<CpuTimes>)>>,
}

fn cpu() -> PortResult<(CpuTimes, Vec<CpuTimes>)> {
    procfs::parse_cpu(&read("/proc/stat")?)
        .ok_or_else(|| PortError::Failed("/proc/stat has no cpu line".into()))
}

fn read(path: &str) -> PortResult<String> {
    std::fs::read_to_string(path).map_err(|e| PortError::Failed(format!("{path}: {e}")))
}

impl MonitorPort for LinuxMonitor {
    fn sample(&self) -> PortResult<Value> {
        let current = cpu()?;
        let previous = self
            .last
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .replace(current.clone());
        let (before, now) = match previous {
            Some(before) => (before, current),
            // the first reading has nothing to compare with: wait a moment for a second one
            None => {
                std::thread::sleep(Duration::from_millis(250));
                let later = cpu()?;
                *self.last.lock().unwrap_or_else(|e| e.into_inner()) = Some(later.clone());
                (current, later)
            }
        };
        Ok(self.shape(&before, &now))
    }

    fn fps(&self) -> PortResult<Value> {
        Ok(Value::Null)
    }

    fn processes(&self) -> PortResult<Value> {
        Ok(json!({ "cpu": [], "mem": [] }))
    }

    fn info(&self) -> PortResult<Value> {
        let memory = procfs::parse_meminfo(&read("/proc/meminfo")?);
        let cpu_name = read("/proc/cpuinfo")
            .ok()
            .and_then(|t| procfs::parse_cpu_name(&t));
        let os = read("/etc/os-release")
            .ok()
            .and_then(|t| procfs::parse_os_name(&t));
        let threads = procfs::parse_cpu(&read("/proc/stat")?).map_or(0, |(_, cores)| cores.len());
        let host = read("/etc/hostname")
            .map(|h| h.trim().to_owned())
            .unwrap_or_default();
        Ok(json!({
            "host": host,
            "user": std::env::var("USER").unwrap_or_default(),
            "os": { "name": os.unwrap_or_else(|| "Linux".into()), "version": "", "build": "", "arch": std::env::consts::ARCH, "installed": "", "lastBoot": "" },
            "cpu": { "name": cpu_name.unwrap_or_default(), "cores": threads, "threads": threads, "maxMHz": 0, "l2KB": 0, "l3KB": 0, "socket": "" },
            "memory": { "totalGB": memory.map_or(0, |m| m.total_mb / 1024), "modules": [] },
            "gpus": [], "board": { "maker": "", "model": "", "bios": "", "biosDate": "" },
            "storage": [], "drives": [], "network": [], "monitors": []
        }))
    }
}

impl LinuxMonitor {
    fn shape(&self, before: &(CpuTimes, Vec<CpuTimes>), now: &(CpuTimes, Vec<CpuTimes>)) -> Value {
        let cores: Vec<f64> = now
            .1
            .iter()
            .zip(&before.1)
            .map(|(now, before)| (procfs::usage(*before, *now) * 10.0).round() / 10.0)
            .collect();
        let memory = read("/proc/meminfo")
            .ok()
            .and_then(|t| procfs::parse_meminfo(&t));
        let uptime = read("/proc/uptime")
            .ok()
            .and_then(|t| procfs::parse_uptime(&t))
            .unwrap_or(0);
        json!({
            "cpu": { "usage": (procfs::usage(before.0, now.0) * 10.0).round() / 10.0, "cores": cores, "temp": null, "power": null, "processes": 0, "threads": 0 },
            "memory": {
                "totalMB": memory.map_or(0, |m| m.total_mb),
                "usedMB": memory.map_or(0, |m| m.used_mb),
                "usedPct": memory.map_or(0.0, |m| m.used_pct),
            },
            "gpu": null, "fps": null,
            "disk": { "disks": [], "total": { "active": 0, "readBps": 0, "writeBps": 0 }, "drives": [] },
            "network": [], "uptime": uptime
        })
    }
}
