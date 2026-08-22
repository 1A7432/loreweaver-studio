//! Transport building blocks for the Loreweaver client protocol:
//! newline-delimited JSON frames over an iroh QUIC bidirectional stream
//! (ALPN `loreweaver/tui/1`), as specified by the main repo's `docs/protocol.md`.

pub mod backoff;
pub mod client;
pub mod codec;
pub mod frames;

/// Client-side defensive ceiling for one media blob. Re-exported so
/// `src-tauri` (`media.rs`) cannot drift from the transport GET path.
pub use client::MAX_BLOB_BYTES;
