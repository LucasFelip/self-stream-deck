//! The Wi-Fi side: an HTTPS server on the local network with the self-signed certificate the phone app pins, the iPhone's HTTPS server with its
//! own certificate authority, the plain-HTTP port that hands out that authority's public certificate, and the firewall rules. Same behavior as
//! `index.js` (`startLan`, `startIos`), `tls.js`, `tls-ios.js` and `ios.js` of the Node agent; the certificates are the ones in `data/tls/`
//! (so a phone paired before keeps working), made with the same PowerShell scripts when they are missing.
use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::ConnectInfo;
use axum::http::{header, HeaderValue, Method, Request, Response, StatusCode};
use axum::Router;
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use ssd_api::Secure;
use ssd_core::config::Config;
use ssd_core::sha256::sha256_hex;
use tokio::net::TcpListener;
use tower::ServiceExt;

pub struct Material {
    pub pfx: Vec<u8>,
    pub passphrase: String,
    /// SHA-256 of the certificate (what the Android app pins), or of the authority's for the iPhone
    pub fingerprint: String,
    pub ca_der: Vec<u8>,
}

const TLS_CERT: &str = include_str!("../scripts/tls-cert.ps1");
const TLS_IOS: &str = include_str!("../scripts/tls-ios.ps1");

/// `'it''s'`: a PowerShell literal string.
fn quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Runs one of the certificate scripts packed in the executable. The script is handed to PowerShell as text, never as a file: the agent runs
/// as administrator, and a script file in a folder any program can write (a temporary one) would be a way to run something else with those
/// rights. The password travels in the environment of that one process, not on its command line (which every program on the PC can read).
fn run_script(script: &str, args: &[(&str, &str)], password: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let mut command = format!("& {{\n{script}\n}} -Password $env:SSD_SECRET");
    for (name, value) in args {
        command.push_str(&format!(" -{name} {}", quoted(value)));
    }
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &command])
        .env("SSD_SECRET", password)
        // Windows PowerShell started from PowerShell 7 (a CI runner, a developer's terminal) inherits PowerShell 7's module path and then
        // cannot load its own Security module: the `Cert:` drive is gone. Without the variable it uses its own default.
        .env_remove("PSModulePath")
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{}{}",
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        )
        .trim()
        .to_owned())
    }
}

/// The password of a certificate file: 144 bits from the operating system's generator.
fn random_secret() -> String {
    ssd_core::random::hex(18)
}

/// The certificate the Android app pins: made once, kept in `data/tls/`, nothing about the network in it.
pub fn main_material(data: &Path) -> Result<Material, String> {
    let dir = data.join("tls");
    let (pfx, cer, secret) = (
        dir.join("server.pfx"),
        dir.join("server.cer"),
        dir.join("secret.txt"),
    );
    if ![&pfx, &cer, &secret].iter().all(|f| f.exists()) {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let password = random_secret();
        std::fs::write(&secret, &password).map_err(|e| e.to_string())?;
        run_script(
            TLS_CERT,
            &[
                ("PfxPath", &pfx.display().to_string()),
                ("CerPath", &cer.display().to_string()),
            ],
            &password,
        )?;
        println!("[tls] new certificate");
    }
    let der = std::fs::read(&cer).map_err(|e| e.to_string())?;
    Ok(Material {
        pfx: std::fs::read(&pfx).map_err(|e| e.to_string())?,
        passphrase: std::fs::read_to_string(&secret)
            .map_err(|e| e.to_string())?
            .trim()
            .to_owned(),
        fingerprint: sha256_hex(&der),
        ca_der: Vec::new(),
    })
}

/// The iPhone's material: an authority installed once on the phone and a server certificate that names this PC and its addresses.
pub fn ios_material(data: &Path, names: &[String], ips: &[String]) -> Result<Material, String> {
    let dir = data.join("tls").join("ios");
    let files: Vec<PathBuf> = ["ca.pfx", "ca.cer", "leaf.pfx", "leaf.cer", "secret.txt"]
        .iter()
        .map(|f| dir.join(f))
        .collect();
    if !files.iter().all(|f| f.exists()) {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let secret = dir.join("secret.txt");
        if !secret.exists() {
            std::fs::write(&secret, random_secret()).map_err(|e| e.to_string())?;
        }
        let password = std::fs::read_to_string(&secret)
            .map_err(|e| e.to_string())?
            .trim()
            .to_owned();
        run_script(
            TLS_IOS,
            &[
                ("Dir", &dir.display().to_string()),
                ("Names", &names.join(",")),
                ("Ips", &ips.join(",")),
            ],
            &password,
        )?;
        println!(
            "[tls-ios] new certificate authority and server certificate for {}",
            names
                .iter()
                .chain(ips)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    let ca = std::fs::read(dir.join("ca.cer")).map_err(|e| e.to_string())?;
    Ok(Material {
        pfx: std::fs::read(dir.join("leaf.pfx")).map_err(|e| e.to_string())?,
        passphrase: std::fs::read_to_string(dir.join("secret.txt"))
            .map_err(|e| e.to_string())?
            .trim()
            .to_owned(),
        fingerprint: sha256_hex(&ca),
        ca_der: ca,
    })
}

/// Serves the agent over TLS (Windows' own Schannel) on `address`. A phone that does not trust the certificate yet just drops the connection.
pub async fn serve_tls(
    address: SocketAddr,
    material: &Material,
    app: Router,
) -> Result<(), String> {
    let identity = native_tls::Identity::from_pkcs12(&material.pfx, &material.passphrase)
        .map_err(|e| format!("the certificate could not be read: {e}"))?;
    let acceptor = tokio_native_tls::TlsAcceptor::from(
        native_tls::TlsAcceptor::builder(identity)
            .min_protocol_version(Some(native_tls::Protocol::Tlsv12))
            .build()
            .map_err(|e| e.to_string())?,
    );
    let listener = TcpListener::bind(address)
        .await
        .map_err(|e| format!("port {} is not available: {e}", address.port()))?;
    tokio::spawn(async move {
        loop {
            let Ok((stream, peer)) = listener.accept().await else {
                continue;
            };
            let (acceptor, app) = (acceptor.clone(), app.clone());
            tokio::spawn(async move {
                let Ok(secure) = acceptor.accept(stream).await else {
                    return;
                };
                let service = service_fn(move |mut request: Request<Incoming>| {
                    request.extensions_mut().insert(ConnectInfo(peer));
                    request.extensions_mut().insert(Secure);
                    let app = app.clone();
                    async move {
                        Ok::<_, Infallible>(
                            app.oneshot(request.map(Body::new))
                                .await
                                .unwrap_or_else(|e| match e {}),
                        )
                    }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(secure), service)
                    .await;
            });
        }
    });
    Ok(())
}

const CA_PAGE: &str = r##"<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Self Stream Deck · certificado</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;background:#0b0c10;color:#e8e8ee;margin:0;padding:24px}a.b{display:block;margin:20px 0;padding:14px;border-radius:12px;background:#3b82f6;color:#fff;text-align:center;text-decoration:none;font-weight:600}code{display:block;word-break:break-all;background:#1a1c24;padding:10px;border-radius:8px;font-size:12px}</style>
</head><body>
<h1>Self Stream Deck</h1>
<p>Certificado para o iPhone confiar no painel.</p>
<a class="b" href="/ca.cer">Baixar certificado</a>
<p>Impressão digital (SHA-256). Confira com a que o PC mostra em <b>ssd pair</b>:</p>
<code>FINGERPRINT</code>
<p>Depois: Ajustes → Perfil Baixado → Instalar; e Ajustes → Geral → Sobre → Ajustes de Confiança do Certificado → ativar.</p>
</body></html>"##;

/// The plain-HTTP side of the iPhone setup: only the authority's PUBLIC certificate (no token needed, nothing here is private and nothing can
/// drive the deck): `GET /` a short page with its fingerprint and `GET /ca.cer` the certificate itself.
pub async fn serve_ca(address: SocketAddr, material: Arc<Material>) -> Result<(), String> {
    let listener = TcpListener::bind(address)
        .await
        .map_err(|e| format!("port {} is not available: {e}", address.port()))?;
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };
            let material = material.clone();
            tokio::spawn(async move {
                let service = service_fn(move |request: Request<Incoming>| {
                    let material = material.clone();
                    async move { Ok::<_, Infallible>(ca_answer(&request, &material)) }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
        }
    });
    Ok(())
}

fn ca_answer(request: &Request<Incoming>, material: &Material) -> Response<Body> {
    let reply = |status: StatusCode,
                 kind: &'static str,
                 body: Bytes,
                 extra: Option<(&'static str, &'static str)>| {
        let mut response = Response::new(Body::from(body));
        *response.status_mut() = status;
        response
            .headers_mut()
            .insert(header::CONTENT_TYPE, HeaderValue::from_static(kind));
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        if let Some((name, value)) = extra {
            response
                .headers_mut()
                .insert(name, HeaderValue::from_static(value));
        }
        response
    };
    let json = |status: StatusCode, message: &str| {
        reply(
            status,
            "application/json; charset=utf-8",
            Bytes::from(format!("{{\"error\":\"{message}\"}}")),
            None,
        )
    };
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return json(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
    }
    match request.uri().path() {
        "/ca.cer" => reply(
            StatusCode::OK,
            "application/x-x509-ca-cert",
            Bytes::from(material.ca_der.clone()),
            Some((
                "content-disposition",
                "inline; filename=\"self-stream-deck-ca.cer\"",
            )),
        ),
        "/" => reply(
            StatusCode::OK,
            "text/html; charset=utf-8",
            Bytes::from(CA_PAGE.replace("FINGERPRINT", &material.fingerprint)),
            None,
        ),
        _ => json(StatusCode::NOT_FOUND, "not found"),
    }
}

/// The Windows Firewall rule for these ports (not touched when `SSD_NO_FIREWALL` is set: the tests run on other ports).
fn firewall(ports: &[u16], rule: &str) {
    if std::env::var_os("SSD_NO_FIREWALL").is_none() {
        ssd_platform_windows::lan::ensure_firewall(ports, rule);
    }
}

fn port_of(config: &Config, key: &str, default: u16) -> u16 {
    config
        .get(key)
        .and_then(|v| v.as_u64())
        .and_then(|p| u16::try_from(p).ok())
        .unwrap_or(default)
}

fn fingerprint_of(file: &Path) -> Option<String> {
    std::fs::read(file).ok().map(|der| sha256_hex(&der))
}

/// `ssd pair`: the links that pair a phone, with the token in them. They are printed only when asked for, on the screen of who asked: the
/// agent's own output goes to `server.log`, and a secret does not belong in a log.
pub fn print_pairing(config: &Config, port: u16, data: &Path) {
    let token = config.token();
    println!("Pairing code: {token}\n\nOn this PC (and a phone on the USB cable):\n  http://127.0.0.1:{port}/?token={token}");
    let addresses = ssd_platform_windows::lan::home_addresses();
    if config.flag("lan") {
        let port = port_of(config, "httpsPort", 7879);
        println!("\nAndroid app over Wi-Fi:");
        match fingerprint_of(&data.join("tls").join("server.cer")) {
            Some(fingerprint) => {
                for ip in &addresses {
                    println!("  https://{ip}:{port}/?token={token}&fp={fingerprint}");
                }
                if addresses.is_empty() {
                    println!("  (no home-network address found: is this PC connected?)");
                }
            }
            None => println!("  (the certificate is made the first time the agent starts)"),
        }
    } else {
        println!("\nWi-Fi access is off (\"lan\": true in config.json turns it on).");
    }
    if config.flag("ios") {
        let (port, ca_port) = (
            port_of(config, "iosPort", 7880),
            port_of(config, "iosCaPort", 7881),
        );
        let host = std::env::var("COMPUTERNAME")
            .unwrap_or_default()
            .to_lowercase();
        let hosts: Vec<String> = addresses
            .iter()
            .cloned()
            .chain([format!("{host}.local")])
            .collect();
        println!("\niPhone (Safari):");
        match fingerprint_of(&data.join("tls").join("ios").join("ca.cer")) {
            Some(fingerprint) => {
                println!("  1. install the certificate once (fingerprint {fingerprint}):")
            }
            None => println!(
                "  1. install the certificate once (it is made the first time the agent starts):"
            ),
        }
        for host in &hosts {
            println!("       http://{host}:{ca_port}/");
        }
        println!("  2. open the deck:");
        for host in &hosts {
            println!("       https://{host}:{port}/?token={token}");
        }
    }
}

/// Starts what `config` asks for beyond the loopback port and says where it listens. The pairing links (they carry the token) are not
/// printed here: this output is the log. `ssd pair` and the icon by the clock show them.
pub async fn start(config: &Config, data: &Path, app: Router) {
    if !config.flag("lan") {
        println!("\nWi-Fi access is off (\"lan\": true in config.json turns it on).");
    } else {
        let port = port_of(config, "httpsPort", 7879);
        let data = data.to_owned();
        match tokio::task::spawn_blocking(move || main_material(&data)).await {
            Ok(Ok(material)) => match serve_tls(
                SocketAddr::from(([0, 0, 0, 0], port)),
                &material,
                app.clone(),
            )
            .await
            {
                Ok(()) => {
                    tokio::task::spawn_blocking(move || {
                        firewall(&[port], ssd_platform_windows::lan::RULE)
                    });
                    println!(
                        "\nOver the home network (Wi-Fi, HTTPS on port {port}, certificate {}); the pairing link: ssd pair",
                        material.fingerprint
                    );
                    let addresses = ssd_platform_windows::lan::home_addresses();
                    for ip in &addresses {
                        println!("  https://{ip}:{port}/");
                    }
                    if addresses.is_empty() {
                        println!("  (no home-network address found: is this PC connected?)");
                    }
                }
                Err(message) => eprintln!("[lan] could not start the Wi-Fi server: {message}"),
            },
            Ok(Err(message)) => eprintln!("[lan] could not start the Wi-Fi server: {message}"),
            Err(error) => eprintln!("[lan] could not start the Wi-Fi server: {error}"),
        }
    }
    if config.flag("ios") {
        let (port, ca_port) = (
            port_of(config, "iosPort", 7880),
            port_of(config, "iosCaPort", 7881),
        );
        let host = std::env::var("COMPUTERNAME")
            .unwrap_or_default()
            .to_lowercase();
        let names = vec![
            host.clone(),
            format!("{host}.local"),
            "localhost".to_owned(),
        ];
        let ips = ssd_platform_windows::lan::home_addresses();
        let (d, n, i) = (data.to_owned(), names.clone(), ips.clone());
        match tokio::task::spawn_blocking(move || ios_material(&d, &n, &i)).await {
            Ok(Ok(material)) => {
                let material = Arc::new(material);
                let started = serve_tls(SocketAddr::from(([0, 0, 0, 0], port)), &material, app)
                    .await
                    .and(
                        serve_ca(SocketAddr::from(([0, 0, 0, 0], ca_port)), material.clone()).await,
                    );
                match started {
                    Ok(()) => {
                        tokio::task::spawn_blocking(move || {
                            firewall(&[port, ca_port], ssd_platform_windows::lan::RULE_IOS)
                        });
                        println!("\nFor an iPhone (Safari):\n  1. install the certificate once (fingerprint {}):", material.fingerprint);
                        for host in ips.iter().cloned().chain([format!("{host}.local")]) {
                            println!("       http://{host}:{ca_port}/");
                        }
                        println!("  2. open the deck with the link of: ssd pair");
                        for host in ips.iter().cloned().chain([format!("{host}.local")]) {
                            println!("       https://{host}:{port}/");
                        }
                    }
                    Err(message) => eprintln!("[ios] could not start the iPhone server: {message}"),
                }
            }
            Ok(Err(message)) => eprintln!("[ios] could not start the iPhone server: {message}"),
            Err(error) => eprintln!("[ios] could not start the iPhone server: {error}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_value_with_a_quote_stays_one_powershell_string() {
        assert_eq!(quoted(r"C:\Users\o'brien\tls"), r"'C:\Users\o''brien\tls'");
    }

    /// The real thing: PowerShell gets the packed script as text and the password in its environment, and the files it writes open with it.
    #[test]
    fn the_packed_script_makes_a_certificate_that_opens_with_its_password() {
        let data = std::env::temp_dir().join(format!("ssd-lan-o'test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        let material = main_material(&data).unwrap();
        assert_eq!(material.fingerprint.len(), 64);
        assert_eq!(material.passphrase.len(), 36);
        native_tls::Identity::from_pkcs12(&material.pfx, &material.passphrase).unwrap();
        let again = main_material(&data).unwrap();
        assert_eq!(
            again.fingerprint, material.fingerprint,
            "made once, then kept"
        );
        let _ = std::fs::remove_dir_all(&data);
    }
}
