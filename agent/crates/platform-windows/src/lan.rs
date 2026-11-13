//! The network side of the PC: which addresses a phone on the home network can reach, and the Windows Firewall rules that let it in. Same rules
//! as `legacy/server/src/addresses.js` and `firewall.js`.
use std::os::windows::process::CommandExt;

use windows::Win32::Foundation::ERROR_BUFFER_OVERFLOW;
use windows::Win32::NetworkManagement::IpHelper::{
    GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST,
    IP_ADAPTER_ADDRESSES_LH,
};
use windows::Win32::Networking::WinSock::{AF_INET, SOCKADDR_IN};

/// Adapters that exist only inside this PC (virtual switches, containers, VPNs): a phone on the home network never reaches them.
const VIRTUAL: [&str; 15] = [
    "vethernet",
    "wsl",
    "docker",
    "hyper-v",
    "vmware",
    "virtualbox",
    "vbox",
    "loopback",
    "bluetooth",
    "tailscale",
    "zerotier",
    "tap-",
    "npcap",
    "host-only",
    "",
];

fn is_home_range(ip: [u8; 4]) -> bool {
    matches!(ip, [10, ..] | [192, 168, ..]) || (ip[0] == 172 && (16..=31).contains(&ip[1]))
}

/// This PC's IPv4 addresses on the home network (private ranges, real adapters only), without duplicates.
pub fn home_addresses() -> Vec<String> {
    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    let mut size = 16 * 1024u32;
    let mut found: Vec<String> = Vec::new();
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
            return found;
        }
        unsafe {
            let mut adapter = first;
            while !adapter.is_null() {
                let name = (*adapter)
                    .FriendlyName
                    .to_string()
                    .unwrap_or_default()
                    .to_lowercase();
                let description = (*adapter)
                    .Description
                    .to_string()
                    .unwrap_or_default()
                    .to_lowercase();
                let virtual_adapter = VIRTUAL
                    .iter()
                    .filter(|word| !word.is_empty())
                    .any(|word| name.contains(word) || description.contains(word));
                if !virtual_adapter {
                    let mut unicast = (*adapter).FirstUnicastAddress;
                    while !unicast.is_null() {
                        let socket = (*unicast).Address.lpSockaddr;
                        if !socket.is_null() && (*socket).sa_family == AF_INET {
                            let octets = (*(socket as *const SOCKADDR_IN)).sin_addr.S_un.S_un_b;
                            let ip = [octets.s_b1, octets.s_b2, octets.s_b3, octets.s_b4];
                            let text = format!("{}.{}.{}.{}", ip[0], ip[1], ip[2], ip[3]);
                            if is_home_range(ip) && !found.contains(&text) {
                                found.push(text);
                            }
                        }
                        unicast = (*unicast).Next;
                    }
                }
                adapter = (*adapter).Next;
            }
        }
        return found;
    }
    found
}

pub const RULE: &str = "Self Stream Deck (rede local)";
pub const RULE_IOS: &str = "Self Stream Deck (iPhone)";

fn powershell(command: &str) -> (bool, String, String) {
    match std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            command,
        ])
        .creation_flags(0x0800_0000)
        .output()
    {
        Ok(output) => (
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).trim().to_owned(),
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ),
        Err(error) => (false, String::new(), error.to_string()),
    }
}

/// Makes sure the rule exists for `ports` (it replaces one made for other ports): TCP only, only from the local subnet, on every network
/// profile (home networks are often marked "Public"). Needs administrator rights, which the autostart task has. Returns "present", "created"
/// or "failed".
pub fn ensure_firewall(ports: &[u16], rule: &str) -> String {
    let mut sorted = ports.to_vec();
    sorted.sort_unstable();
    let list = sorted
        .iter()
        .map(u16::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let (ok, out, err) = powershell(&format!(
        "$ErrorActionPreference = 'Stop'\n$rule = Get-NetFirewallRule -DisplayName '{rule}' -ErrorAction SilentlyContinue\nif ($rule) {{\n  $current = (@(($rule | Get-NetFirewallPortFilter).LocalPort) | Sort-Object {{ [int]$_ }}) -join ','\n  if ($current -eq '{list}' -and $rule.Enabled -eq 'True') {{ 'present'; return }}\n  $rule | Remove-NetFirewallRule\n}}\nNew-NetFirewallRule -DisplayName '{rule}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort {list} -Profile Any -RemoteAddress LocalSubnet | Out-Null\n'created'"
    ));
    if !ok {
        // the caller says so in the log (this crate does not log); the first line of the error is all there is to tell
        let _ = err;
        return "failed".into();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_private_ranges_count_as_home() {
        for ip in [
            [10, 0, 0, 5],
            [192, 168, 4, 93],
            [172, 16, 0, 1],
            [172, 31, 255, 1],
        ] {
            assert!(is_home_range(ip), "{ip:?}");
        }
        for ip in [
            [8, 8, 8, 8],
            [172, 15, 0, 1],
            [172, 32, 0, 1],
            [169, 254, 1, 1],
            [100, 64, 0, 1],
        ] {
            assert!(!is_home_range(ip), "{ip:?}");
        }
    }

    #[test]
    fn this_pc_reports_its_home_addresses_without_duplicates() {
        let found = home_addresses();
        let mut unique = found.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(found.len(), unique.len());
        assert!(found.iter().all(|ip| ip.split('.').count() == 4));
    }
}
