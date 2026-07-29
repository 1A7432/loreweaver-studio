//! Transport building blocks for the Loreweaver client protocol:
//! newline-delimited JSON frames over an iroh QUIC bidirectional stream
//! (ALPN `loreweaver/tui/1`), as specified by the main repo's `docs/protocol.md`.

pub mod backoff;
pub mod client;
pub mod codec;
pub mod frames;
