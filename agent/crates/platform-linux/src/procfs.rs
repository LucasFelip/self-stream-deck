//! What `/proc` says, as numbers: text in, values out, no file is read here.

/// The time one CPU (or all of them) has spent, in the kernel's ticks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CpuTimes {
    pub busy: u64,
    pub total: u64,
}

/// `(all CPUs, each core)` from the contents of `/proc/stat`. Busy is everything but idle and waiting for the disk.
pub fn parse_cpu(stat: &str) -> Option<(CpuTimes, Vec<CpuTimes>)> {
    let times = |line: &str| -> Option<CpuTimes> {
        let ticks: Vec<u64> = line
            .split_whitespace()
            .skip(1)
            .map(|t| t.parse().ok())
            .collect::<Option<_>>()?;
        // user nice system idle iowait irq softirq steal …
        let idle = ticks.get(3)? + ticks.get(4).copied().unwrap_or(0);
        let total: u64 = ticks.iter().take(8).sum();
        Some(CpuTimes {
            busy: total.saturating_sub(idle),
            total,
        })
    };
    let mut all = None;
    let mut cores = Vec::new();
    for line in stat.lines() {
        let name = line.split_whitespace().next().unwrap_or("");
        if name == "cpu" {
            all = times(line);
        } else if name.starts_with("cpu") && name[3..].bytes().all(|b| b.is_ascii_digit()) {
            cores.push(times(line)?);
        }
    }
    all.map(|all| (all, cores))
}

/// The share of the time that was busy between two readings, 0 to 100 (0 when no time went by).
pub fn usage(before: CpuTimes, now: CpuTimes) -> f64 {
    let total = now.total.saturating_sub(before.total);
    if total == 0 {
        return 0.0;
    }
    let busy = now.busy.saturating_sub(before.busy);
    (busy as f64 / total as f64 * 100.0).clamp(0.0, 100.0)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Memory {
    pub total_mb: u64,
    pub used_mb: u64,
    pub used_pct: f64,
}

/// Memory in use from `/proc/meminfo`: what is not available (free, plus what the kernel can give back).
pub fn parse_meminfo(text: &str) -> Option<Memory> {
    let kb = |key: &str| -> Option<u64> {
        text.lines()
            .find_map(|line| line.strip_prefix(key)?.strip_prefix(':'))?
            .split_whitespace()
            .next()?
            .parse()
            .ok()
    };
    let total = kb("MemTotal")?;
    let available = kb("MemAvailable").or_else(|| kb("MemFree"))?;
    let used = total.saturating_sub(available);
    Some(Memory {
        total_mb: total / 1024,
        used_mb: used / 1024,
        used_pct: if total == 0 {
            0.0
        } else {
            (used as f64 / total as f64 * 1000.0).round() / 10.0
        },
    })
}

/// Seconds since boot from `/proc/uptime`.
pub fn parse_uptime(text: &str) -> Option<u64> {
    let seconds: f64 = text.split_whitespace().next()?.parse().ok()?;
    Some(seconds as u64)
}

/// The processor's name from `/proc/cpuinfo`.
pub fn parse_cpu_name(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        (key.trim() == "model name").then(|| value.trim().to_owned())
    })
}

/// `PRETTY_NAME` from `/etc/os-release` ("Ubuntu 24.04 LTS").
pub fn parse_os_name(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        line.strip_prefix("PRETTY_NAME=")
            .map(|value| value.trim().trim_matches('"').to_owned())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const STAT: &str = "cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 60 0 20 400 20 0 0 0 0 0\ncpu1 40 0 30 400 30 0 0 0 0 0\nintr 12345\nctxt 999\n";

    #[test]
    fn the_cpu_line_and_each_core_are_read_and_busy_leaves_out_idle_and_io_wait() {
        let (all, cores) = parse_cpu(STAT).unwrap();
        assert_eq!(
            all,
            CpuTimes {
                busy: 150,
                total: 1000
            }
        );
        assert_eq!(cores.len(), 2);
        assert_eq!(
            cores[0],
            CpuTimes {
                busy: 80,
                total: 500
            }
        );
        assert!(parse_cpu("intr 1\n").is_none());
        assert!(parse_cpu("cpu a b c d\n").is_none());
    }

    #[test]
    fn usage_is_the_busy_share_of_what_went_by() {
        let a = CpuTimes {
            busy: 100,
            total: 1000,
        };
        assert_eq!(
            usage(
                a,
                CpuTimes {
                    busy: 150,
                    total: 1100
                }
            ),
            50.0
        );
        assert_eq!(usage(a, a), 0.0);
        assert_eq!(
            usage(
                CpuTimes { busy: 9, total: 9 },
                CpuTimes { busy: 0, total: 0 }
            ),
            0.0,
            "a counter that went back is 0, not a panic"
        );
        assert_eq!(
            usage(
                a,
                CpuTimes {
                    busy: 1100,
                    total: 1100
                }
            ),
            100.0
        );
    }

    #[test]
    fn memory_in_use_is_total_minus_available() {
        let text = "MemTotal:       16384000 kB\nMemFree:         1000000 kB\nMemAvailable:    8192000 kB\nBuffers: 1 kB\n";
        let memory = parse_meminfo(text).unwrap();
        assert_eq!(memory.total_mb, 16000);
        assert_eq!(memory.used_mb, 8000);
        assert_eq!(memory.used_pct, 50.0);
        // an old kernel has no MemAvailable
        assert_eq!(
            parse_meminfo("MemTotal: 2048 kB\nMemFree: 1024 kB\n")
                .unwrap()
                .used_pct,
            50.0
        );
        assert!(parse_meminfo("nothing").is_none());
    }

    #[test]
    fn uptime_the_processor_and_the_system_name() {
        assert_eq!(parse_uptime("12345.67 54321.00\n"), Some(12345));
        assert_eq!(parse_uptime("x"), None);
        assert_eq!(
            parse_cpu_name("processor : 0\nmodel name\t: AMD Ryzen 7 5800X\n"),
            Some("AMD Ryzen 7 5800X".into())
        );
        assert_eq!(
            parse_os_name("NAME=Ubuntu\nPRETTY_NAME=\"Ubuntu 24.04 LTS\"\n"),
            Some("Ubuntu 24.04 LTS".into())
        );
        assert_eq!(parse_os_name("NAME=x\n"), None);
    }
}
