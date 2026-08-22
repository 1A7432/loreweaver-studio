//! Client-side defensive ceilings for media blobs.
//!
//! Kept out of the connection actor so `client.rs` can change (session
//! epochs, send verdicts) without touching the published 128 MiB audio
//! default, and so `src-tauri` can import one symbol.

/// Client-side defensive ceiling for one fetched blob.
///
/// This is not a quota and not a second policy: the published protocol default
/// (`docs/protocol.md`, engine `audio_max_file_bytes`) is 128 MiB per audio
/// file, and this constant MUST stay equal to that number. A 65–128 MiB blob
/// the engine already accepted has to be fetchable here; anything larger is
/// refused so a hostile or misconfigured peer cannot force an unbounded
/// allocation. `src-tauri` reads the same symbol (`loreweaver_transport::MAX_BLOB_BYTES`)
/// for the upload pre-check, so the two sides cannot drift.
pub const MAX_BLOB_BYTES: u64 = 128 * 1024 * 1024;

/// Accept a GET header `size` if it is within [`MAX_BLOB_BYTES`].
///
/// The GET path calls this before allocating the body, so an over-cap header
/// is refused without reading the bytes. A size the former 64 MiB ceiling
/// would have rejected (65–128 MiB) returns `Ok`.
pub fn accepted_blob_size(size: u64) -> Result<usize, String> {
    if size > MAX_BLOB_BYTES {
        return Err(format!("blob exceeds the {MAX_BLOB_BYTES}-byte client cap"));
    }
    usize::try_from(size).map_err(|_| format!("blob size {size} does not fit this architecture"))
}

#[cfg(test)]
mod tests {
    use super::{accepted_blob_size, MAX_BLOB_BYTES};

    #[test]
    fn client_blob_cap_matches_the_published_audio_default() {
        // Engine `infra/config.py` `audio_max_file_bytes` and `docs/protocol.md`.
        assert_eq!(MAX_BLOB_BYTES, 128 * 1024 * 1024);
    }

    #[test]
    fn client_blob_cap_accepts_the_former_64_mib_band_and_refuses_over_128() {
        let former = 64 * 1024 * 1024;
        assert_eq!(accepted_blob_size(former).expect("64 MiB"), former as usize);
        assert_eq!(
            accepted_blob_size(former + 1).expect("64 MiB + 1"),
            (former + 1) as usize
        );
        assert_eq!(
            accepted_blob_size(MAX_BLOB_BYTES).expect("exactly 128 MiB"),
            MAX_BLOB_BYTES as usize
        );
        let over = accepted_blob_size(MAX_BLOB_BYTES + 1).expect_err("129 MiB");
        assert!(over.contains("client cap"), "unexpected error: {over}");
        assert!(
            over.contains(&MAX_BLOB_BYTES.to_string()),
            "error must name the cap: {over}"
        );
    }

    #[test]
    fn fetch_blob_on_gates_header_size_through_accepted_blob_size() {
        // Call-site pin: the GET path must use this helper (not an inline
        // `if size > MAX_BLOB_BYTES`) so the 64–128 MiB band and the 128 MiB
        // refuse cannot drift from the tests above. The matching-body
        // roundtrip in `tests/loopback.rs` still covers the byte pump.
        let src = include_str!("client.rs");
        assert!(
            src.contains("accepted_blob_size(size)"),
            "fetch_blob_on must gate the GET header through accepted_blob_size"
        );
        assert!(
            !src.contains("if size > MAX_BLOB_BYTES"),
            "an inline ceiling in client.rs would drift from limits.rs"
        );
    }
}
