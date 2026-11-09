//! The domain of the agent: no sockets and no Windows here, so everything in this crate is tested on any machine.
//! - `guard`: who may talk to the agent (Host check, lockout, token, Origin); parity with `legacy/server/src/security.js`
//! - `config`: `config.json` (same file and keys as the Node agent, so the pairing token survives the migration)
//! - `keys`: shortcut specs as virtual-key codes
//! - `macros`: what the button editor may save (shortcuts and macros), validated against a whitelist
//! - `media`: what is shown of the media sessions (names, art type, art cache)
//! - `taskbar`: the pinned apps (names, duplicates, order, cache) and `sha1` for their ids
//! - `windows`: which windows the Janelas page shows
//! - `power`: the power actions and what the Energia page shows
//! - `notices`: which notifications the deck shows
//! - `ports`: what the PC offers (audio, media, input...) as traits that `platform-windows` implements and the tests fake

pub mod config;
pub mod guard;
pub mod keys;
pub mod macros;
pub mod media;
pub mod notices;
pub mod ports;
pub mod power;
pub mod sha1;
pub mod sha256;
pub mod taskbar;
pub mod windows;
