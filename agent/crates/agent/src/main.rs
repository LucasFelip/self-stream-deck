//! `ssd`: the Self Stream Deck agent.
//!
//!   ssd [--data-dir DIR] [--web-dir DIR] [--port N] [--no-tray] [--migrate-from DIR] [--fake-platform]
//!   ssd diagnose [--out FILE]      one report to read (or send) when something does not work
//!   ssd update [--apply] [--no-install] [--channel NAME] [--url ADDRESS]    look for (and install) a newer version
//!   ssd --version
//!
//! An installed agent needs nothing else: the interface is packed inside the executable and the files live in `%APPDATA%\SelfStreamDeck`.
//! `--web-dir` serves the interface from a folder instead (while it is being worked on).
mod data;
mod diagnose;
mod lan;
mod tray;
mod update;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use ssd_api::{router, AppState, Platform};
use ssd_core::config::Config;

struct Args {
    data_dir: PathBuf,
    web_dir: Option<PathBuf>,
    port: Option<u16>,
    fake_platform: bool,
    no_tray: bool,
    migrate_from: Option<PathBuf>,
    diagnose: bool,
    out: Option<PathBuf>,
    /// `ssd update …`: what follows the word
    update: Option<Vec<String>>,
}

const USAGE: &str = "usage: ssd [--data-dir DIR] [--web-dir DIR] [--port N] [--no-tray] [--migrate-from DIR] [--fake-platform]\n       ssd diagnose [--out FILE]\n       ssd update [--apply] [--no-install] [--channel NAME] [--url ADDRESS]\n       ssd --version";

fn parse_args() -> Result<Args, String> {
    let mut args = Args {
        data_dir: std::env::var_os("SSD_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(data::default_dir),
        web_dir: std::env::var_os("SSD_WEB_DIST").map(PathBuf::from),
        port: std::env::var("SSD_PORT").ok().and_then(|p| p.parse().ok()),
        fake_platform: false,
        no_tray: false,
        migrate_from: None,
        diagnose: false,
        out: None,
        update: None,
    };
    let mut it = std::env::args().skip(1).peekable();
    if it.peek().is_some_and(|first| first == "diagnose") {
        args.diagnose = true;
        it.next();
    }
    if it.peek().is_some_and(|first| first == "update") {
        it.next();
        // `--data-dir` belongs to this program; everything else goes to the update command
        let mut rest = Vec::new();
        while let Some(word) = it.next() {
            if word == "--data-dir" {
                args.data_dir = it.next().ok_or("--data-dir needs a value")?.into();
            } else {
                rest.push(word);
            }
        }
        args.update = Some(rest);
        return Ok(args);
    }
    while let Some(flag) = it.next() {
        let mut value = |name: &str| it.next().ok_or_else(|| format!("{name} needs a value"));
        match flag.as_str() {
            "--data-dir" => args.data_dir = value("--data-dir")?.into(),
            "--web-dir" => args.web_dir = Some(value("--web-dir")?.into()),
            "--port" => {
                args.port = Some(
                    value("--port")?
                        .parse()
                        .map_err(|_| "--port is not a number".to_string())?,
                )
            }
            "--migrate-from" => args.migrate_from = Some(value("--migrate-from")?.into()),
            "--out" => args.out = Some(value("--out")?.into()),
            "--no-tray" => args.no_tray = true,
            "--fake-platform" => args.fake_platform = true,
            "--version" | "-V" => {
                return Err(format!("Self Stream Deck {}", env!("CARGO_PKG_VERSION")))
            }
            "-h" | "--help" => return Err(USAGE.into()),
            other => return Err(format!("unknown option {other}\n{USAGE}")),
        }
    }
    Ok(args)
}

/// Puts this process in a job that ends with it: whatever it started (PowerShell for the firewall, the notification helpers) dies when this process does, however it ends
/// (a crash, a kill from the Task Manager), so no orphan keeps the port. The handle is never closed on purpose.
#[cfg(windows)]
fn children_end_with_me() {
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::GetCurrentProcess;
    unsafe {
        let Ok(job) = CreateJobObjectW(None, None) else {
            return;
        };
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        // the installer of an update must be able to leave the job (update.rs), or it would end with the agent it replaces
        info.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        let _ = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        let _ = AssignProcessToJobObject(job, GetCurrentProcess());
    }
}
#[cfg(not(windows))]
fn children_end_with_me() {}

/// The PC: Windows' own APIs, or an in-memory PC with `--fake-platform` (and everywhere that is not Windows, for now nothing).
fn platform(fake: bool, data_dir: &std::path::Path) -> Platform {
    if fake {
        return Platform {
            audio: Some(Arc::new(ssd_core::ports::FakeAudio::default())),
            media: Some(Arc::new(ssd_core::ports::FakeMedia::default())),
            input: Some(Arc::new(ssd_core::ports::FakeInput::default())),
            taskbar: Some(Arc::new(ssd_core::ports::FakeTaskbar::default())),
            windows: Some(Arc::new(ssd_core::ports::FakeWindows::default())),
            power: Some(Arc::new(ssd_core::ports::FakePower::default())),
            monitor: Some(Arc::new(ssd_core::ports::FakeMonitor)),
            notifications: Some(Arc::new(ssd_core::ports::FakeNotifications)),
            vcam: Some(Arc::new(ssd_core::ports::FakeVcam::default())),
        };
    }
    #[cfg(windows)]
    return Platform {
        audio: Some(Arc::new(ssd_platform_windows::WindowsAudio)),
        media: Some(Arc::new(ssd_platform_windows::WindowsMedia)),
        input: Some(Arc::new(ssd_platform_windows::WindowsInput)),
        taskbar: Some(Arc::new(ssd_platform_windows::WindowsTaskbar)),
        windows: Some(Arc::new(ssd_platform_windows::WindowsWindows)),
        power: Some(Arc::new(ssd_platform_windows::WindowsPower)),
        monitor: Some(Arc::new(ssd_platform_windows::WindowsMonitor)),
        notifications: Some(Arc::new(ssd_platform_windows::WindowsNotifications)),
        vcam: Some(Arc::new(ssd_platform_windows::WindowsVcam::new(
            data_dir.join("vcam"),
        ))),
    };
    #[cfg(not(windows))]
    Platform::default()
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("SSD_LOG")
                .unwrap_or_else(|_| "info".into()),
        )
        .init();
    children_end_with_me();
    match run().await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(message) => {
            // `--version` and `--help` come out of the parser as a message: they are not failures
            let is_failure =
                !(message.starts_with("Self Stream Deck ") || message.starts_with("usage:"));
            if is_failure {
                eprintln!("ssd: {message}");
            } else {
                println!("{message}");
            }
            std::process::ExitCode::from(if is_failure { 2 } else { 0 })
        }
    }
}

async fn run() -> Result<(), String> {
    let args = parse_args()?;
    // an interface in the executable, unless a folder was asked for (or the build has none: a source checkout uses web/dist)
    let embedded = args.web_dir.is_none() && ssd_api::embedded::available();
    let web_dir = match (&args.web_dir, embedded) {
        (Some(dir), _) => dir.clone(),
        (None, true) => PathBuf::new(),
        (None, false) => PathBuf::from("web/dist"),
    };

    if args.diagnose {
        let report = diagnose::report(&args.data_dir, embedded);
        match &args.out {
            Some(file) => {
                std::fs::write(file, &report).map_err(|e| e.to_string())?;
                println!("report written to {}", file.display());
            }
            None => print!("{report}"),
        }
        return Ok(());
    }

    if let Some(from) = &args.migrate_from {
        match data::migrate(from, &args.data_dir) {
            Ok(copied) if !copied.is_empty() => println!(
                "[data] copied {} from {} to {}",
                copied.join(" and "),
                from.display(),
                args.data_dir.display()
            ),
            Ok(_) => {}
            Err(error) => {
                return Err(format!(
                    "could not bring the files of {} along: {error}",
                    from.display()
                ))
            }
        }
    }

    let config = Config::load(&args.data_dir).map_err(|e| e.to_string())?;
    if let Some(rest) = &args.update {
        return update::command(&config, rest);
    }
    let port = args.port.unwrap_or_else(|| config.port());
    let machine = std::env::var("COMPUTERNAME").unwrap_or_default();

    let state = AppState::new(
        config.clone(),
        &machine,
        web_dir.clone(),
        platform(args.fake_platform, &args.data_dir),
    );
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|e| format!("port {port} is not available: {e}"))?;
    tracing::info!(
        "listening on http://{address}/?token={} (web: {})",
        config.token(),
        if embedded {
            "inside the executable".to_owned()
        } else {
            web_dir.display().to_string()
        }
    );

    #[cfg(windows)]
    if !args.no_tray {
        tray::start(tray::Info {
            port,
            token: config.token().to_owned(),
            log: args.data_dir.join("server.log"),
        });
    }

    // the apps list of the last run is already loaded; the taskbar is read again in the background when it changed
    tokio::spawn({
        let state = state.clone();
        async move { state.refresh_apps().await }
    });

    // the home network: HTTPS with the certificate the phone pins, the iPhone side and the firewall rules
    let scripts = lan::extract_scripts()?;
    let app = router(state);
    lan::start(&config, &args.data_dir, &scripts, app.clone()).await;
    // with "update": { "auto": true } in config.json: look for a newer version a minute from now, then once a day
    tokio::spawn(update::run_forever(config.clone()));

    let serve = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    );
    tokio::select! {
        result = serve => result.map_err(|e| e.to_string()),
        _ = tokio::signal::ctrl_c() => Ok(()),
    }
}
