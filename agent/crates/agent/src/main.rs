//! `ssd`: the Self Stream Deck agent.
//!
//!   ssd [--data-dir DIR] [--web-dir DIR] [--port N] [--node PATH/index.js] [--node-port N]
//!
//! Transition mode (plan 3.1): with `--node`, the Node agent runs as a child on `--node-port` (default 7870) and every route this agent does
//! not answer yet is handed to it. The phone and the interface only ever see this agent's port.
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use ssd_api::{router, AppState, Platform};
use ssd_core::config::Config;

struct Args {
    data_dir: PathBuf,
    web_dir: PathBuf,
    port: Option<u16>,
    node: Option<PathBuf>,
    node_port: u16,
    fake_platform: bool,
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args {
        data_dir: std::env::var_os("SSD_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("data")),
        web_dir: std::env::var_os("SSD_WEB_DIST")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("web/dist")),
        port: std::env::var("SSD_PORT").ok().and_then(|p| p.parse().ok()),
        node: None,
        node_port: 7870,
        fake_platform: false,
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut value = |name: &str| it.next().ok_or_else(|| format!("{name} needs a value"));
        match flag.as_str() {
            "--data-dir" => args.data_dir = value("--data-dir")?.into(),
            "--web-dir" => args.web_dir = value("--web-dir")?.into(),
            "--port" => args.port = Some(value("--port")?.parse().map_err(|_| "--port is not a number".to_string())?),
            "--node" => args.node = Some(value("--node")?.into()),
            "--node-port" => args.node_port = value("--node-port")?.parse().map_err(|_| "--node-port is not a number".to_string())?,
            "--fake-platform" => args.fake_platform = true,
            "-h" | "--help" => return Err("usage: ssd [--data-dir DIR] [--web-dir DIR] [--port N] [--node PATH/index.js] [--node-port N] [--fake-platform]".into()),
            other => return Err(format!("unknown option {other}")),
        }
    }
    Ok(args)
}

/// Puts this process in a job that ends with it: whatever it started (the Node agent behind it) dies when this process does, however it ends
/// (a crash, a kill from the Task Manager), so no orphan keeps the port. The handle is never closed on purpose.
#[cfg(windows)]
fn children_end_with_me() {
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::GetCurrentProcess;
    unsafe {
        let Ok(job) = CreateJobObjectW(None, None) else {
            return;
        };
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
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
fn platform(fake: bool) -> Platform {
    if fake {
        return Platform {
            audio: Some(Arc::new(ssd_core::ports::FakeAudio::default())),
            media: Some(Arc::new(ssd_core::ports::FakeMedia::default())),
            input: Some(Arc::new(ssd_core::ports::FakeInput::default())),
            taskbar: Some(Arc::new(ssd_core::ports::FakeTaskbar::default())),
            windows: Some(Arc::new(ssd_core::ports::FakeWindows::default())),
            power: Some(Arc::new(ssd_core::ports::FakePower::default())),
            monitor: Some(Arc::new(ssd_core::ports::FakeMonitor)),
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
            eprintln!("ssd: {message}");
            std::process::ExitCode::from(2)
        }
    }
}

async fn run() -> Result<(), String> {
    let args = parse_args()?;
    let config = Config::load(&args.data_dir).map_err(|e| e.to_string())?;
    let port = args.port.unwrap_or_else(|| config.port());
    let machine = std::env::var("COMPUTERNAME").unwrap_or_default();

    // the Node agent behind this one (kept alive for as long as this process lives)
    let mut child = None;
    let upstream = match &args.node {
        Some(script) => {
            let process = tokio::process::Command::new("node")
                .arg(script)
                .env("SSD_PORT", args.node_port.to_string())
                .env("SSD_DATA_DIR", &args.data_dir)
                .stdin(Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .map_err(|e| format!("could not start node: {e}"))?;
            child = Some(process);
            Some(SocketAddr::from(([127, 0, 0, 1], args.node_port)))
        }
        None => None,
    };

    let state = AppState::new(
        config.clone(),
        &machine,
        args.web_dir.clone(),
        upstream,
        platform(args.fake_platform),
    );
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|e| format!("port {port} is not available: {e}"))?;
    tracing::info!(
        "listening on http://{address}/?token={} (web: {}, node behind: {})",
        config.token(),
        args.web_dir.display(),
        upstream.map_or("no".to_string(), |u| u.to_string())
    );

    // the apps list of the last run is already loaded; the taskbar is read again in the background when it changed
    tokio::spawn({
        let state = state.clone();
        async move { state.refresh_apps().await }
    });

    let serve = axum::serve(
        listener,
        router(state).into_make_service_with_connect_info::<SocketAddr>(),
    );
    tokio::select! {
        result = serve => result.map_err(|e| e.to_string()),
        _ = tokio::signal::ctrl_c() => Ok(()),
        _ = async { match child.as_mut() { Some(c) => { let _ = c.wait().await; } None => std::future::pending::<()>().await } } => {
            tokio::time::sleep(Duration::from_millis(50)).await;
            Err("the Node agent behind this one stopped".into())
        }
    }
}
