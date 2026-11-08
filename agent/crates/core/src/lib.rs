//! The domain of the agent: no sockets and no Windows here, so everything in this crate is tested on any machine.
//! - `guard`: who may talk to the agent (Host check, lockout, token, Origin); parity with `legacy/server/src/security.js`
//! - `config`: `config.json` (same file and keys as the Node agent, so the pairing token survives the migration)
//! - `ports`: what the PC offers (audio, media, input...) as traits that `platform-windows` implements and the tests fake

pub mod config;
pub mod guard;
pub mod ports;
