use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const COOKIE: &str = "ssd_token";
const MAX_FAILURES: u32 = 10;
const FAILURE_WINDOW: Duration = Duration::from_secs(60);
const MAX_TRACKED: usize = 100;

/// Constant-time comparison (the length is not secret: the token has a fixed size).
pub fn safe_equal(a: &str, b: &str) -> bool {
    let (x, y) = (a.as_bytes(), b.as_bytes());
    x.len() == y.len() && x.iter().zip(y).fold(0u8, |acc, (p, q)| acc | (p ^ q)) == 0
}

/// `a=1; ssd_token=abc` gives the value of one cookie (percent-decoded; a malformed one is just "no token", not an error).
pub fn cookie_value(header: &str, name: &str) -> Option<String> {
    header
        .split(';')
        .filter_map(|part| {
            let (key, value) = part.trim().split_once('=')?;
            (key == name).then(|| percent_decode(value).unwrap_or_default())
        })
        .next()
}

pub fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

pub struct Guard {
    token: String,
    machine: String,
    failures: Mutex<HashMap<IpAddr, (u32, Instant)>>,
}

impl Guard {
    pub fn new(token: impl Into<String>, machine_name: impl AsRef<str>) -> Self {
        Self {
            token: token.into(),
            machine: machine_name.as_ref().to_lowercase(),
            failures: Mutex::new(HashMap::new()),
        }
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn is_locked_out(&self, ip: IpAddr) -> bool {
        let mut failures = self.failures.lock().unwrap();
        match failures.get(&ip) {
            None => false,
            Some((_, since)) if since.elapsed() > FAILURE_WINDOW => {
                failures.remove(&ip);
                false
            }
            Some((count, _)) => *count >= MAX_FAILURES,
        }
    }

    pub fn record_failure(&self, ip: IpAddr) {
        let mut failures = self.failures.lock().unwrap();
        if failures.len() > MAX_TRACKED {
            // the table never grows without bound, whatever the network throws at it
            failures.retain(|_, (_, since)| since.elapsed() <= FAILURE_WINDOW);
            if failures.len() > MAX_TRACKED {
                failures.clear();
            }
        }
        match failures.get_mut(&ip) {
            Some((count, since)) if since.elapsed() <= FAILURE_WINDOW => *count += 1,
            _ => {
                failures.insert(ip, (1, Instant::now()));
            }
        }
    }

    /// DNS rebinding makes a hostile page reach us under its own name. Real clients use an IP or this machine's name.
    pub fn is_allowed_host(&self, host_header: &str) -> bool {
        let host = host_header.to_lowercase();
        let host = match host.rsplit_once(':') {
            Some((name, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => {
                name
            }
            _ => host.as_str(),
        };
        let parts: Vec<&str> = host.split('.').collect();
        let is_ipv4 = parts.len() == 4
            && parts
                .iter()
                .all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()));
        is_ipv4
            || host == "localhost"
            || host == "[::1]"
            || host == self.machine
            || host == format!("{}.local", self.machine)
    }

    /// Browsers attach `Origin` to cross-site requests; a page on another site must not drive the deck.
    pub fn is_same_origin(&self, origin: Option<&str>, host_header: &str) -> bool {
        let Some(origin) = origin else { return true }; // not a browser cross-site request (curl, the Android WebView navigation)
        let Some((_, rest)) = origin.split_once("://") else {
            return false;
        };
        let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
        !authority.is_empty() && authority.eq_ignore_ascii_case(host_header)
    }

    pub fn is_authenticated(
        &self,
        query_token: Option<&str>,
        header_token: Option<&str>,
        cookie_header: Option<&str>,
    ) -> bool {
        let cookie = cookie_header.and_then(|h| cookie_value(h, COOKIE));
        [
            query_token.map(str::to_owned),
            header_token.map(str::to_owned),
            cookie,
        ]
        .into_iter()
        .flatten()
        .any(|candidate| !candidate.is_empty() && safe_equal(&candidate, &self.token))
    }

    pub fn pairing_cookie(&self, secure: bool) -> String {
        format!(
            "{COOKIE}={}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax{}",
            self.token,
            if secure { "; Secure" } else { "" }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guard() -> Guard {
        Guard::new("abc123", "DESKTOP-X")
    }
    fn ip(last: u8) -> IpAddr {
        IpAddr::from([192, 168, 0, last])
    }

    #[test]
    fn hosts_are_ips_localhost_or_this_machine_only() {
        let g = guard();
        for ok in [
            "127.0.0.1:7878",
            "192.168.4.93",
            "localhost:7878",
            "[::1]:7878",
            "desktop-x",
            "DESKTOP-X.local:7879",
        ] {
            assert!(g.is_allowed_host(ok), "{ok}");
        }
        for bad in [
            "evil.example.com",
            "evil.example.com:7878",
            "desktop-x.evil.com",
            "1.2.3",
            "1.2.3.4.5",
            "a.b.c.d",
            "",
        ] {
            assert!(!g.is_allowed_host(bad), "{bad}");
        }
    }

    #[test]
    fn ten_failures_lock_an_address_out_and_only_that_one() {
        let g = guard();
        for _ in 0..9 {
            g.record_failure(ip(1));
        }
        assert!(!g.is_locked_out(ip(1)));
        g.record_failure(ip(1));
        assert!(g.is_locked_out(ip(1)));
        assert!(!g.is_locked_out(ip(2)));
    }

    #[test]
    fn the_failure_table_stays_bounded() {
        let g = guard();
        for n in 0..=255u8 {
            for m in 0..3u8 {
                g.record_failure(IpAddr::from([10, 0, m, n]));
            }
        }
        assert!(g.failures.lock().unwrap().len() <= MAX_TRACKED + 1);
    }

    #[test]
    fn the_token_comes_from_the_query_a_header_or_the_cookie() {
        let g = guard();
        assert!(g.is_authenticated(Some("abc123"), None, None));
        assert!(g.is_authenticated(None, Some("abc123"), None));
        assert!(g.is_authenticated(None, None, Some("theme=dark; ssd_token=abc123")));
        assert!(!g.is_authenticated(Some("abc124"), Some(""), Some("ssd_token=%E0%A4%A")));
        assert!(!g.is_authenticated(None, None, None));
    }

    #[test]
    fn origin_must_match_the_host_header() {
        let g = guard();
        assert!(g.is_same_origin(None, "127.0.0.1:7878"));
        assert!(g.is_same_origin(Some("http://127.0.0.1:7878"), "127.0.0.1:7878"));
        assert!(!g.is_same_origin(Some("https://evil.example.com"), "127.0.0.1:7878"));
        assert!(!g.is_same_origin(Some("null"), "127.0.0.1:7878"));
    }

    #[test]
    fn the_pairing_cookie_is_httponly_lax_and_secure_over_tls() {
        let g = guard();
        assert_eq!(
            g.pairing_cookie(false),
            "ssd_token=abc123; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax"
        );
        assert!(g.pairing_cookie(true).ends_with("; Secure"));
        assert!(safe_equal("a", "a") && !safe_equal("a", "b") && !safe_equal("a", "ab"));
    }
}
