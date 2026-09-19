//! Alimiel — the Almadel supervisor.
//!
//! A small agent daemon that registers with an Almadel server, long-polls for
//! work, and runs tasks through `opencode`.

pub mod agent;
pub mod client;
pub mod config;
pub mod poll;
