# Implemented: a bounded, abortable dial

- **Problem:** a ticket whose direct addresses had gone stale (the host
  restarted and bound a new UDP port) left the form on "Connecting…" for over
  four minutes: `endpoint.connect` had no deadline, and the actor only listened
  for `Close` after it returned, so the close a replacement dial sends was
  never heard. The form also locked itself while connecting (inputs and button
  disabled), so there was no cancel and no way to paste the current ticket over
  the stuck one.
- **Verdict:** one attempt is two bounded stages — the dial (connect, open the
  control stream, write `join`; `DIAL_TIMEOUT` 15 s) and the wait for
  `welcome` (`JOIN_TIMEOUT` 15 s) — and the dial races the command queue, so a
  `Close` (or a handle dropped) ends it at once and other commands fail fast
  instead of queueing. A connection that was never welcomed does not redial:
  its first failed attempt ends `offline` with an English `error` and a stable
  `errorCode` (`connect_timeout` / `join_timeout` / `connect_failed`) the WebView
  words in the operator's language. Only a session that WAS good is redialed,
  under the same two bounds, with the existing 250 ms → 5 s backoff. The form
  stays editable while connecting, shows Cancel (the ordinary disconnect), and a
  connect issued over a dial in flight replaces it; a cancel that reaches the
  bridge before the dial was seated is finished by the dial's own continuation.
  The access key renders as a password field with a show/hide toggle.
- **Reason:** iroh's `connect` has no deadline of its own (its docs promise an
  error only when nothing is reachable or discoverable, and address lookup is
  consulted only for a ticket without a relay URL), so a stale-but-plausible
  ticket never errors by itself; the bound and the abort have to be ours. Redialing a connection that never came up only hides the failure behind
  a "reconnecting" screen with no room to show for it.
- **Rule home:** `crates/transport/src/client.rs` (`dial`, `Timeouts`,
  `AttemptFailure`, `ErrorCode`, the `ever_online` rule in `run`),
  `src/store/connection.ts` (`describeFailure`, the late-seat disconnect in
  `connect`), `src/features/play/PlayView.tsx` (Cancel, `SecretField`).
- **Date:** 2026-10-21.
