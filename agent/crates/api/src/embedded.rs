//! The interface inside the executable: the build of `web/` (`web/dist`) is packed into `ssd.exe` when it is compiled, so an installed agent
//! needs no other folder. A debug build reads the folder from disk instead (change the interface, reload, no rebuild of the agent).
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../../../web/dist"]
#[allow_missing = true]
struct Assets;

/// One packed file: its bytes, and when it was built (milliseconds, for the ETag and for `ui` in the state).
pub struct Packed {
    pub data: Vec<u8>,
    pub modified_ms: u64,
}

pub fn get(path: &str) -> Option<Packed> {
    let file = Assets::get(path)?;
    Some(Packed {
        data: file.data.into_owned(),
        modified_ms: file.metadata.last_modified().unwrap_or(0) * 1000,
    })
}

/// Is there an interface in the executable?
pub fn available() -> bool {
    Assets::get("index.html").is_some()
}

/// The newest build time of any packed file.
pub fn newest_ms() -> u64 {
    Assets::iter()
        .filter_map(|name| Assets::get(&name))
        .filter_map(|f| f.metadata.last_modified())
        .max()
        .unwrap_or(0)
        * 1000
}
