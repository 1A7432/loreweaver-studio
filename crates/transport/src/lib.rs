//! The carrier for the Loreweaver client protocol 3.0 (the engine's
//! `docs/protocol.md`): an iroh QUIC connection dialled by ticket under ALPN
//! `loreweaver/3`, whose first bidirectional stream carries newline-delimited
//! JSON frames both ways, and whose further streams are the byte channel.
//!
//! This crate is a plain LINK. It writes no frame of its own, answers nothing,
//! interprets nothing and never redials: the protocol session in the WebView
//! (`loreweaver-protocol/v3`'s `Session`) says `hello` and resumes, and the
//! WebView's connection owner decides when to dial again.

pub mod bytes;
pub mod codec;
pub mod limits;
pub mod link;

/// Client-side defensive ceiling for one media blob. Re-exported so
/// `src-tauri` (`media.rs`) cannot drift from the transport GET path.
pub use limits::{MAX_BLOB_BYTES, MAX_SAVE_BYTES};
