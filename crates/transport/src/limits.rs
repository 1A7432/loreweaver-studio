//! Client-side defensive ceilings for media blobs.
//!
//! Kept out of the link and the byte channel so either can change without
//! touching the published 128 MiB audio default, and so `src-tauri` can
//! import one symbol.

/// Client-side defensive ceiling for one fetched blob.
///
/// This is not a quota and not a second policy: the published protocol default
/// (`docs/protocol.md` §11.2) is 128 MiB per sound, the largest file a server
/// stores, and this constant MUST stay equal to that number. A 65–128 MiB blob
/// the engine already accepted has to be fetchable here; anything larger is
/// refused so a hostile or misconfigured peer cannot force an unbounded
/// allocation. `src-tauri` reads the same symbol (`loreweaver_transport::MAX_BLOB_BYTES`)
/// for the upload pre-check, so the two sides cannot drift.
pub const MAX_BLOB_BYTES: u64 = 128 * 1024 * 1024;

/// The largest room save this client fetches or sends: the server's default
/// limit for one save file (`MAX_SAVE_FILE_BYTES`, `docs/protocol.md` §12.4 —
/// "a save file (export or upload): 256 MiB"). A save is the one file larger
/// than [`MAX_BLOB_BYTES`]; it is fetched with this cap named explicitly
/// (`LinkHandle::fetch_within`), never by raising the ceiling for everything
/// else. A server configured lower still refuses with its own coded answer.
pub const MAX_SAVE_BYTES: u64 = 256 * 1024 * 1024;

/// Accept a GET header `size` if it is within [`MAX_BLOB_BYTES`].
///
/// The GET path calls [`accepted_size`] before allocating the body, so an
/// over-cap header is refused without reading the bytes. A size the former
/// 64 MiB ceiling would have rejected (65–128 MiB) returns `Ok`.
pub fn accepted_blob_size(size: u64) -> Result<usize, String> {
    accepted_size(size, MAX_BLOB_BYTES)
}

/// Accept a GET header `size` if it is within `cap` — the ceiling the caller
/// named for this one fetch ([`MAX_BLOB_BYTES`] unless it says otherwise).
pub fn accepted_size(size: u64, cap: u64) -> Result<usize, String> {
    if size > cap {
        return Err(format!("blob exceeds the {cap}-byte client cap"));
    }
    usize::try_from(size).map_err(|_| format!("blob size {size} does not fit this architecture"))
}

#[cfg(test)]
mod tests {
    use super::{accepted_blob_size, accepted_size, MAX_BLOB_BYTES, MAX_SAVE_BYTES};

    #[test]
    fn client_blob_cap_matches_the_published_audio_default() {
        // `docs/protocol.md` §11.2: "a sound at most 128 MiB".
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
    fn a_save_may_be_twice_a_blob_and_no_more() {
        // `docs/protocol.md` §12.4: a save file at most 256 MiB.
        assert_eq!(MAX_SAVE_BYTES, 256 * 1024 * 1024);
        assert!(accepted_size(MAX_SAVE_BYTES, MAX_SAVE_BYTES).is_ok());
        assert!(accepted_size(MAX_BLOB_BYTES + 1, MAX_SAVE_BYTES).is_ok());
        let over = accepted_size(MAX_SAVE_BYTES + 1, MAX_SAVE_BYTES).expect_err("over");
        assert!(over.contains(&MAX_SAVE_BYTES.to_string()), "{over}");
        // The ordinary ceiling is unchanged by the save's.
        assert!(accepted_blob_size(MAX_BLOB_BYTES + 1).is_err());
    }

    #[test]
    fn the_get_gates_header_size_through_accepted_size() {
        // Call-site pin: the GET path must use this helper (not an inline
        // `if size > MAX_BLOB_BYTES`) so the 64–128 MiB band and the 128 MiB
        // refuse cannot drift from the tests above. The matching-body
        // roundtrip in `tests/loopback.rs` still covers the byte pump.
        let src = include_str!("bytes.rs");
        assert!(
            src.contains("accepted_size(file.size, max)"),
            "the GET must gate its header through accepted_size"
        );
        assert!(
            !src.contains("if size > MAX_BLOB_BYTES"),
            "an inline ceiling in bytes.rs would drift from limits.rs"
        );
    }
}
