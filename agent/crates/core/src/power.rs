//! The power actions (shutdown, restart, sleep...) and what the Energia page shows. No Windows here: the commands go through the `PowerPort`,
//! so the rules (what needs a confirmation, how a delay is validated, what is remembered about a scheduled shutdown) are tested with a fake.
//! Parity with `legacy/server/src/power.js`.
use serde_json::{json, Value};

use crate::ports::{PortError, PowerPort};
use crate::windows::WindowsSnapshot;

pub const MAX_DELAY_SEC: f64 = 24.0 * 60.0 * 60.0;
const COMMENT: &str = "Self Stream Deck";

/// Every action the API knows, in the order the Node agent listed them.
pub const ACTIONS: [&str; 9] = [
    "lock",
    "sleep",
    "hibernate",
    "logoff",
    "shutdown",
    "restart",
    "firmware",
    "advanced",
    "cancel",
];

/// What this agent scheduled, so the phone can show a countdown (the pending shutdown itself lives in Windows).
#[derive(Debug, Clone, PartialEq)]
pub struct Scheduled {
    pub action: String,
    /// when it will happen, in milliseconds since 1970
    pub at: i64,
    pub force: bool,
}

/// `{ action, at, force, inSec }` for the phone, or nothing: once its time passed (by 5 s) it has fired, or the PC would be off.
pub fn schedule_view(scheduled: &mut Option<Scheduled>, now_ms: i64) -> Option<Value> {
    if scheduled.as_ref().is_some_and(|s| s.at < now_ms - 5000) {
        *scheduled = None;
    }
    // the phone counts down from `inSec`, not from `at`: its clock may differ from this PC's
    scheduled.as_ref().map(|s| json!({ "action": s.action, "at": s.at, "force": s.force, "inSec": ((s.at - now_ms) as f64 / 1000.0).round() as i64 }))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Raw {
    pub uptime_sec: u64,
    pub hibernate: Option<u32>,
    pub hiberboot: Option<u32>,
    pub reboot_pending: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub struct CommandResult {
    pub code: i32,
    pub output: String,
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct PowerError {
    pub status: u16,
    pub message: String,
}

impl PowerError {
    fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl From<PortError> for PowerError {
    fn from(error: PortError) -> Self {
        Self::new(500, error.to_string())
    }
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

/// The windows that could hold unsaved work, by program (at most 16). `app_names` maps a process name to the label the deck already shows.
pub fn open_apps(snapshot: &WindowsSnapshot, app_names: &[(String, String)]) -> Vec<Value> {
    const IGNORED: [&str; 5] = [
        "explorer",
        "textinputhost",
        "searchhost",
        "startmenuexperiencehost",
        "shellexperiencehost",
    ];
    let mut open: Vec<(String, u64)> = Vec::new();
    for window in &snapshot.windows {
        if IGNORED.contains(&window.name.as_str()) {
            continue;
        }
        // UWP apps all run inside ApplicationFrameHost: show their title instead
        let label = if window.name == "applicationframehost" {
            window.title.clone()
        } else {
            app_names
                .iter()
                .find(|(process, _)| *process == window.name)
                .map_or_else(|| capitalize(&window.name), |(_, name)| name.clone())
        };
        match open.iter_mut().find(|(name, _)| *name == label) {
            Some((_, count)) => *count += 1,
            None => open.push((label, 1)),
        }
    }
    open.into_iter()
        .take(16)
        .map(|(name, count)| json!({ "name": name, "count": count }))
        .collect()
}

/// The body of `GET /api/power` (without `enabled`, which comes from the config).
pub fn info(
    raw: &Raw,
    snapshot: &WindowsSnapshot,
    app_names: &[(String, String)],
    scheduled: Option<Value>,
    now_ms: i64,
) -> serde_json::Map<String, Value> {
    let hibernate = raw.hibernate == Some(1);
    let last_boot = format_iso(now_ms - (raw.uptime_sec as i64) * 1000);
    let mut map = serde_json::Map::new();
    map.insert("uptimeSec".into(), json!(raw.uptime_sec));
    map.insert("lastBoot".into(), json!(last_boot));
    map.insert("hibernate".into(), json!(hibernate));
    map.insert(
        "fastStartup".into(),
        json!(raw.hiberboot == Some(1) && hibernate),
    );
    map.insert("rebootPending".into(), json!(raw.reboot_pending));
    map.insert(
        "openApps".into(),
        Value::Array(open_apps(snapshot, app_names)),
    );
    map.insert("scheduled".into(), scheduled.unwrap_or(Value::Null));
    map
}

/// "2026-11-08T21:30:00.000Z" from milliseconds since 1970.
pub fn format_iso(ms: i64) -> String {
    let (secs, millis) = (ms.div_euclid(1000), ms.rem_euclid(1000));
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

pub struct Request {
    pub action: String,
    /// as the phone sent it (a number, a numeric string or nothing)
    pub delay: Option<Value>,
    pub force: bool,
    pub hybrid: bool,
}

fn valid_delay(value: Option<&Value>) -> Result<u32, PowerError> {
    let number = match value {
        None | Some(Value::Null) => 0.0,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) if s.trim().is_empty() => 0.0,
        Some(Value::String(s)) => s.trim().parse::<f64>().unwrap_or(f64::NAN),
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        _ => f64::NAN,
    };
    if !number.is_finite() || number.fract() != 0.0 || !(0.0..=MAX_DELAY_SEC).contains(&number) {
        return Err(PowerError::new(400, "invalid delay"));
    }
    Ok(number as u32)
}

fn cancel(port: &dyn PowerPort, scheduled: &mut Option<Scheduled>) -> Result<Value, PowerError> {
    // Windows' own "shutdown /a" fails (1116) when nothing is pending; that is not an error for the user
    let result = port.shutdown(&["/a".into()])?;
    *scheduled = None;
    Ok(
        json!({ "cancelled": result.code == 0, "note": if result.code == 0 { Value::Null } else { json!(result.output) } }),
    )
}

/// Does what was asked. The result is the part of the answer after `{ ok: true }`.
pub fn perform(
    port: &dyn PowerPort,
    request: &Request,
    scheduled: &mut Option<Scheduled>,
    now_ms: i64,
) -> Result<Value, PowerError> {
    let action = request.action.as_str();
    if action == "cancel" {
        let mut result = cancel(port, scheduled)?;
        result["action"] = json!("cancel");
        // `action` first, like the Node agent's object
        return Ok(
            json!({ "action": "cancel", "cancelled": result["cancelled"], "note": result["note"] }),
        );
    }
    match action {
        "lock" => port.lock()?,
        "logoff" => {
            port.shutdown(&["/l".into()])?;
        }
        "hibernate" => {
            let result = port.shutdown(&["/h".into()])?;
            if result.code != 0 {
                return Err(PowerError::new(
                    409,
                    if result.output.is_empty() {
                        "hibernation is not available".to_owned()
                    } else {
                        result.output
                    },
                ));
            }
        }
        // sleeps when hibernation is off; never hibernates behind your back
        "sleep" => port.sleep()?,
        _ => {}
    }
    if ["lock", "logoff", "hibernate", "sleep"].contains(&action) {
        return Ok(json!({ "action": action, "at": Value::Null }));
    }

    let flags: &[&str] = match action {
        "shutdown" => &["/s"],
        "restart" => &["/r"],
        "firmware" => &["/r", "/fw"], // restart into the UEFI/BIOS setup
        "advanced" => &["/r", "/o"], // restart into the advanced boot menu (safe mode, recovery, startup settings)
        _ => return Err(PowerError::new(400, "unknown action")),
    };
    let delay = valid_delay(request.delay.as_ref())?;
    cancel(port, scheduled)?; // a second schedule is refused by Windows (error 1190) unless the first one is cancelled

    let mut args: Vec<String> = flags.iter().map(|f| (*f).to_owned()).collect();
    if request.hybrid && action == "shutdown" {
        args.push("/hybrid".into());
    }
    if request.force {
        args.push("/f".into());
    }
    args.extend(["/t".into(), delay.to_string(), "/c".into(), COMMENT.into()]);

    let result = port.shutdown(&args)?;
    if result.code != 0 {
        return Err(PowerError::new(
            500,
            if result.output.is_empty() {
                format!("shutdown exited with {}", result.code)
            } else {
                result.output
            },
        ));
    }
    *scheduled = (delay > 0).then(|| Scheduled {
        action: action.to_owned(),
        at: now_ms + i64::from(delay) * 1000,
        force: request.force,
    });
    Ok(json!({ "action": action, "at": scheduled.as_ref().map(|s| s.at) }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::FakePower;
    use crate::windows::WindowInfo;

    fn ask(action: &str) -> Request {
        Request {
            action: action.into(),
            delay: None,
            force: false,
            hybrid: false,
        }
    }

    #[test]
    fn a_shutdown_in_a_minute_cancels_the_old_one_and_is_remembered() {
        let power = FakePower::default();
        let mut scheduled = None;
        let result = perform(
            &power,
            &Request {
                delay: Some(json!("60")),
                force: true,
                ..ask("shutdown")
            },
            &mut scheduled,
            1_000_000,
        )
        .unwrap();
        assert_eq!(result, json!({ "action": "shutdown", "at": 1_060_000 }));
        assert_eq!(
            power.calls(),
            ["shutdown /a", "shutdown /s /f /t 60 /c Self Stream Deck"]
        );
        let view = schedule_view(&mut scheduled, 1_010_000).unwrap();
        assert_eq!(
            view,
            json!({ "action": "shutdown", "at": 1_060_000, "force": true, "inSec": 50 })
        );
        // after its time (plus 5 s) it is forgotten
        assert!(schedule_view(&mut scheduled, 1_066_000).is_none());
    }

    #[test]
    fn restart_flavours_and_hybrid() {
        let power = FakePower::default();
        let mut scheduled = None;
        perform(&power, &ask("firmware"), &mut scheduled, 0).unwrap();
        perform(
            &power,
            &Request {
                hybrid: true,
                ..ask("shutdown")
            },
            &mut scheduled,
            0,
        )
        .unwrap();
        perform(
            &power,
            &Request {
                hybrid: true,
                ..ask("restart")
            },
            &mut scheduled,
            0,
        )
        .unwrap();
        let calls = power.calls();
        assert!(calls.contains(&"shutdown /r /fw /t 0 /c Self Stream Deck".to_owned()));
        assert!(calls.contains(&"shutdown /s /hybrid /t 0 /c Self Stream Deck".to_owned()));
        assert!(
            calls.contains(&"shutdown /r /t 0 /c Self Stream Deck".to_owned()),
            "hybrid only means something for a shutdown"
        );
        assert!(scheduled.is_none(), "no delay, nothing to count down");
    }

    #[test]
    fn delays_are_whole_seconds_up_to_a_day() {
        let power = FakePower::default();
        for bad in [
            json!(-1),
            json!(1.5),
            json!(86_401),
            json!("abc"),
            json!([1]),
        ] {
            let error = perform(
                &power,
                &Request {
                    delay: Some(bad.clone()),
                    ..ask("restart")
                },
                &mut None,
                0,
            )
            .unwrap_err();
            assert_eq!(
                (error.status, error.message.as_str()),
                (400, "invalid delay"),
                "{bad}"
            );
        }
        assert!(power.calls().is_empty(), "nothing ran");
        assert!(perform(
            &power,
            &Request {
                delay: Some(json!(86_400)),
                ..ask("restart")
            },
            &mut None,
            0
        )
        .is_ok());
    }

    #[test]
    fn immediate_actions_and_cancel() {
        let power = FakePower::default();
        let mut scheduled = Some(Scheduled {
            action: "shutdown".into(),
            at: 5,
            force: false,
        });
        assert_eq!(
            perform(&power, &ask("lock"), &mut scheduled, 0).unwrap(),
            json!({ "action": "lock", "at": null })
        );
        perform(&power, &ask("sleep"), &mut scheduled, 0).unwrap();
        perform(&power, &ask("logoff"), &mut scheduled, 0).unwrap();
        assert_eq!(power.calls(), ["lock", "sleep", "shutdown /l"]);
        let cancelled = perform(&power, &ask("cancel"), &mut scheduled, 0).unwrap();
        assert_eq!(
            cancelled,
            json!({ "action": "cancel", "cancelled": true, "note": null })
        );
        assert!(scheduled.is_none());
    }

    #[test]
    fn hibernation_that_is_not_available_is_a_409() {
        let power = FakePower::failing_with("shutdown /h", 1, "Hibernation has not been enabled");
        let error = perform(&power, &ask("hibernate"), &mut None, 0).unwrap_err();
        assert_eq!(
            (error.status, error.message.as_str()),
            (409, "Hibernation has not been enabled")
        );
        // a cancel with nothing pending is reported, not raised
        let none = FakePower::failing_with("shutdown /a", 1116, "No shutdown was in progress");
        assert_eq!(
            perform(&none, &ask("cancel"), &mut None, 0).unwrap()["cancelled"],
            false
        );
    }

    #[test]
    fn open_apps_group_by_program_and_skip_the_shell() {
        let window = |name: &str, title: &str| WindowInfo {
            handle: 1,
            pid: 1,
            title: title.into(),
            state: 0,
            monitor: 0,
            x: 0,
            y: 0,
            w: 1,
            h: 1,
            name: name.into(),
        };
        let snapshot = WindowsSnapshot {
            running: vec![],
            windows: vec![
                window("brave", "a"),
                window("brave", "b"),
                window("explorer", "Downloads"),
                window("applicationframehost", "Calculadora"),
                window("notepad", "n"),
            ],
        };
        let names = vec![("brave".to_owned(), "Brave".to_owned())];
        assert_eq!(
            open_apps(&snapshot, &names),
            vec![
                json!({ "name": "Brave", "count": 2 }),
                json!({ "name": "Calculadora", "count": 1 }),
                json!({ "name": "Notepad", "count": 1 })
            ]
        );
    }

    #[test]
    fn the_clock_is_iso() {
        assert_eq!(format_iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(format_iso(1_794_074_323_973), "2026-11-07T17:58:43.973Z");
    }
}
