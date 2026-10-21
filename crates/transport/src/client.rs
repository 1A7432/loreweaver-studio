//! The connection actor: dial a ticket, join, pump frames, redial on loss.
//!
//! One spawned task owns the whole connection lifecycle. The embedder talks to
//! it through a [`ClientHandle`] (send frame / close) and consumes
//! [`TransportEvent`]s from the returned receiver. Lifecycle mirrors the
//! reference TUI client: `connecting → online → reconnecting → offline`, where
//! `offline` is only reached by an explicit close, a fatal join error, or the
//! first attempt failing.
//!
//! Every wait on the network is bounded and abortable. The dial (connect,
//! open the control stream, write `join`) has [`DIAL_TIMEOUT`], the wait for
//! `welcome` has [`JOIN_TIMEOUT`], and a [`ClientHandle::close`] is answered
//! even in the middle of a dial — iroh itself keeps dialing a ticket whose
//! addresses went stale for minutes, so neither the bound nor the abort can be
//! left to it. A connection that has never been welcomed has nothing to
//! rejoin: its first failed attempt ends it with a reason and a stable
//! [`ErrorCode`] instead of a redial loop. Only a session that was once good is
//! redialed (with backoff, under the same bounds).
//!
//! [`ClientHandle::send_frame`] is a delivery verdict, not an enqueue: it
//! resolves `Ok` only after the control stream accepted the write, and `Err`
//! when the actor is backing off, offline, closed, or the write itself fails
//! (a failed write also trips a redial). Pending waiters are settled if the
//! actor exits or the handle is dropped.

use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::backoff::Backoff;
use crate::codec::{encode_line, LineDecoder, MAX_LINE_BYTES};
use crate::frames::{self, ALPN};
use crate::limits::accepted_blob_size;

/// How long one dial may take: connect to the endpoint, open the control
/// stream and write `join`. A healthy path (direct or via relay) is up in a
/// second or two; what runs past this is a ticket whose direct addresses went
/// stale (the host restarted on a new port) or a host that is gone, which iroh
/// alone would keep trying for minutes.
pub const DIAL_TIMEOUT: Duration = Duration::from_secs(15);

/// How long we wait for `welcome` (or `error`) after sending `join`. The
/// server's own handshake timeout defaults to 10s; ours is slightly larger so
/// the server-side verdict usually arrives first. With [`DIAL_TIMEOUT`] this
/// caps one attempt at 30 s.
pub const JOIN_TIMEOUT: Duration = Duration::from_secs(15);

/// The two per-attempt bounds. Production always runs [`Timeouts::default`];
/// the type exists so the integration tests can watch a deadline fire in
/// milliseconds instead of waiting out the real ones.
#[doc(hidden)]
#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    pub dial: Duration,
    pub join: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            dial: DIAL_TIMEOUT,
            join: JOIN_TIMEOUT,
        }
    }
}

/// End-to-end deadline for one blob fetch, header and body included.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(60);

/// End-to-end deadline for one blob upload. Longer than a fetch: the protocol
/// allows 128 MiB of audio per file, and the sender is usually the slow side.
pub const PUT_TIMEOUT: Duration = Duration::from_secs(600);

const READ_CHUNK: usize = 64 * 1024;

/// Upload chunk size. `docs/protocol.md` fixes this at "up to 64 KiB".
const PUT_CHUNK: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub struct ConnectParams {
    /// The iroh endpoint ticket printed by the server (starts with `endpoint`).
    pub ticket: String,
    /// Keystore access key; the server authenticates on this alone.
    pub key: String,
    /// Advisory display name (the server's keystore name wins).
    pub name: Option<String>,
    pub client_name: String,
    pub client_version: String,
    pub network: NetworkProfile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkProfile {
    /// Production: n0 address lookup + default relays (matches the server's
    /// `preset_n0` endpoint), so any real-world ticket is dialable.
    N0,
    /// Hermetic: no relays, no lookup — direct socket addresses only. Used by
    /// the offline loopback tests.
    LocalOnly,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TransportEvent {
    Status {
        status: ConnStatus,
        attempt: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        /// A stable machine-readable twin of `error` for the failures the UI
        /// words itself (the `error` text is English detail for logs). Absent
        /// for every other reason, which the UI shows as `error` verbatim.
        #[serde(rename = "errorCode", skip_serializing_if = "Option::is_none")]
        error_code: Option<ErrorCode>,
    },
    Frame {
        frame: Value,
    },
}

/// Why a connection that never came online gave up. The wire spelling is the
/// snake_case name and the UI picks its wording by it (`connect.error.*` in
/// the locale files), so renaming one is a change on both sides of the bridge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// No connection to the host within [`DIAL_TIMEOUT`]: a stale ticket
    /// (the host restarted on a new port) or a host that is gone.
    ConnectTimeout,
    /// Connected, but no `welcome` within [`JOIN_TIMEOUT`].
    JoinTimeout,
    /// The dial failed outright, or the host closed before welcoming us.
    ConnectFailed,
}

/// Mirrors `ConnectionStatus` in `@loreweaver/protocol`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnStatus {
    Connecting,
    Online,
    Reconnecting,
    Offline,
}

/// One content-addressed blob pulled over the media byte channel
/// (`{op:"get", hash}` on a fresh bidirectional stream — protocol v1.2+, and
/// the v1.8 panel-asset path). The caller must verify the sha256 itself before
/// trusting the bytes; the transport only moves them.
#[derive(Debug, Clone)]
pub struct FetchedBlob {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub name: String,
}

#[derive(Debug)]
enum Command {
    Send {
        frame: Value,
        reply: oneshot::Sender<Result<(), String>>,
    },
    FetchBlob {
        hash: String,
        reply: oneshot::Sender<Result<FetchedBlob, String>>,
    },
    PutBlob {
        upload_id: String,
        bytes: Vec<u8>,
        reply: oneshot::Sender<Result<String, String>>,
    },
    Close,
}

/// Cheap cloneable handle to the connection actor.
#[derive(Debug, Clone)]
pub struct ClientHandle {
    cmd: mpsc::UnboundedSender<Command>,
}

impl ClientHandle {
    /// Write one client frame on the live control stream.
    ///
    /// `Ok(())` means the bytes were accepted by the stream — not that the
    /// server has processed them. `Err` means they were not written: the
    /// actor is backing off / offline / closed, or the write failed (and a
    /// redial has been started). The future settles even if the actor drops.
    pub async fn send_frame(&self, frame: Value) -> Result<(), String> {
        let (reply, rx) = oneshot::channel();
        self.cmd
            .send(Command::Send { frame, reply })
            .map_err(|_| "transport is closed".to_owned())?;
        rx.await.map_err(|_| "transport is closed".to_owned())?
    }

    /// Pull one blob by sha256 over a fresh media stream on the live
    /// connection. Fails fast while the transport is offline or closed.
    pub async fn fetch_blob(&self, hash: String) -> Result<FetchedBlob, String> {
        let (reply, rx) = oneshot::channel();
        self.cmd
            .send(Command::FetchBlob { hash, reply })
            .map_err(|_| "transport is closed".to_owned())?;
        rx.await.map_err(|_| "transport is closed".to_owned())?
    }

    /// Push one blob up the media byte channel for an accepted upload.
    /// `upload_id` is the one the server handed back in `media_accept`; the
    /// answer is the sha256 the server stored it under. Fails fast while the
    /// transport is offline or closed.
    pub async fn put_blob(&self, upload_id: String, bytes: Vec<u8>) -> Result<String, String> {
        let (reply, rx) = oneshot::channel();
        self.cmd
            .send(Command::PutBlob {
                upload_id,
                bytes,
                reply,
            })
            .map_err(|_| "transport is closed".to_owned())?;
        rx.await.map_err(|_| "transport is closed".to_owned())?
    }

    /// Ask the actor to close and stop redialing. Idempotent.
    pub fn close(&self) {
        let _ = self.cmd.send(Command::Close);
    }
}

/// Spawn the connection actor on the current tokio runtime.
pub fn connect(params: ConnectParams) -> (ClientHandle, mpsc::UnboundedReceiver<TransportEvent>) {
    spawn_actor(params, Timeouts::default(), None)
}

/// Test-only: same as [`connect`] with the per-attempt bounds replaced, and
/// the same backoff pulse as [`connect_with_backoff_pulse`]. Hidden from
/// rustdoc for the same reason.
#[doc(hidden)]
pub fn connect_with_timeouts(
    params: ConnectParams,
    timeouts: Timeouts,
) -> (
    ClientHandle,
    mpsc::UnboundedReceiver<TransportEvent>,
    mpsc::UnboundedReceiver<()>,
) {
    let (pulse_tx, pulse_rx) = mpsc::unbounded_channel();
    let (handle, events) = spawn_actor(params, timeouts, Some(pulse_tx));
    (handle, events, pulse_rx)
}

/// Test-only: same as [`connect`], plus a pulse each time the actor begins a
/// reconnect backoff wait (after a loss is observed, before that sleep ends).
/// Integration tests wait on the pulse instead of guessing close latency.
/// Not part of the crate's published surface — integration tests cannot see
/// `pub(crate)`, so this stays `pub` but hidden from rustdoc.
#[doc(hidden)]
pub fn connect_with_backoff_pulse(
    params: ConnectParams,
) -> (
    ClientHandle,
    mpsc::UnboundedReceiver<TransportEvent>,
    mpsc::UnboundedReceiver<()>,
) {
    let (pulse_tx, pulse_rx) = mpsc::unbounded_channel();
    let (handle, events) = spawn_actor(params, Timeouts::default(), Some(pulse_tx));
    (handle, events, pulse_rx)
}

fn spawn_actor(
    params: ConnectParams,
    timeouts: Timeouts,
    backoff_pulse: Option<mpsc::UnboundedSender<()>>,
) -> (ClientHandle, mpsc::UnboundedReceiver<TransportEvent>) {
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    let (event_tx, event_rx) = mpsc::unbounded_channel();
    tokio::spawn(run(params, timeouts, event_tx, cmd_rx, backoff_pulse));
    (ClientHandle { cmd: cmd_tx }, event_rx)
}

fn status(status: ConnStatus, attempt: u32, error: Option<String>) -> TransportEvent {
    TransportEvent::Status {
        status,
        attempt,
        error,
        error_code: None,
    }
}

/// How one attempt failed before it was welcomed.
#[derive(Debug, Clone, PartialEq, Eq)]
enum AttemptFailure {
    DialTimeout,
    JoinTimeout,
    /// connect / open stream / write join failed outright.
    Dial(String),
    /// The host closed the connection before it sent `welcome`.
    ClosedBeforeWelcome,
}

impl AttemptFailure {
    fn code(&self) -> ErrorCode {
        match self {
            Self::DialTimeout => ErrorCode::ConnectTimeout,
            Self::JoinTimeout => ErrorCode::JoinTimeout,
            Self::Dial(_) | Self::ClosedBeforeWelcome => ErrorCode::ConnectFailed,
        }
    }

    /// English detail for logs and the UI's fallback; the UI words the
    /// [`ErrorCode`] itself.
    fn detail(&self, timeouts: &Timeouts) -> String {
        match self {
            Self::DialTimeout => format!(
                "connect timeout: no connection to the host within {}s",
                timeouts.dial.as_secs_f32()
            ),
            Self::JoinTimeout => format!(
                "join timeout: connected, but no welcome within {}s",
                timeouts.join.as_secs_f32()
            ),
            Self::Dial(err) => format!("connect failed: {err}"),
            Self::ClosedBeforeWelcome => {
                "connect failed: the host closed the connection before it welcomed us".to_owned()
            }
        }
    }

    /// The `offline` event that ends a connection which never came online.
    fn into_offline(self, timeouts: &Timeouts) -> TransportEvent {
        TransportEvent::Status {
            status: ConnStatus::Offline,
            attempt: 0,
            error: Some(self.detail(timeouts)),
            error_code: Some(self.code()),
        }
    }
}

fn reject_command(cmd: Command, err: &str) {
    match cmd {
        Command::Send { reply, .. } => {
            let _ = reply.send(Err(err.to_owned()));
        }
        Command::FetchBlob { reply, .. } => {
            let _ = reply.send(Err(err.to_owned()));
        }
        Command::PutBlob { reply, .. } => {
            let _ = reply.send(Err(err.to_owned()));
        }
        Command::Close => {}
    }
}

fn drain_commands(cmds: &mut mpsc::UnboundedReceiver<Command>) {
    while let Ok(cmd) = cmds.try_recv() {
        reject_command(cmd, "transport is closed");
    }
}

enum OfflineAction {
    Continue,
    Stop,
}

/// Fail-fast answers while the actor has no live control stream (reconnect
/// backoff, or the handle is being closed from that wait). Extracted so the
/// verdict is unit-tested without guessing iroh close latency.
fn reject_offline_command(cmd: Command) -> OfflineAction {
    match cmd {
        Command::Close => OfflineAction::Stop,
        Command::Send { reply, .. } => {
            let _ = reply.send(Err("transport offline".to_owned()));
            OfflineAction::Continue
        }
        Command::FetchBlob { reply, .. } => {
            let _ = reply.send(Err("transport offline".to_owned()));
            OfflineAction::Continue
        }
        Command::PutBlob { reply, .. } => {
            let _ = reply.send(Err("transport offline".to_owned()));
            OfflineAction::Continue
        }
    }
}

enum SessionOutcome {
    /// The connection dropped; `settled` is true when a welcome had arrived.
    /// `why` says how an attempt that never settled ended (ignored when it did).
    Lost {
        settled: bool,
        why: AttemptFailure,
    },
    /// Give up for good and surface the reason.
    Fatal(String),
    ClosedByUser,
}

async fn run(
    params: ConnectParams,
    timeouts: Timeouts,
    events: mpsc::UnboundedSender<TransportEvent>,
    mut cmds: mpsc::UnboundedReceiver<Command>,
    backoff_pulse: Option<mpsc::UnboundedSender<()>>,
) {
    let ticket: iroh_tickets::endpoint::EndpointTicket = match params.ticket.trim().parse() {
        Ok(ticket) => ticket,
        Err(err) => {
            let _ = events.send(status(
                ConnStatus::Offline,
                0,
                Some(format!("invalid ticket: {err}")),
            ));
            drain_commands(&mut cmds);
            return;
        }
    };
    let addr = ticket.endpoint_addr().clone();

    let endpoint = match bind_endpoint(params.network).await {
        Ok(endpoint) => endpoint,
        Err(err) => {
            let _ = events.send(status(ConnStatus::Offline, 0, Some(err)));
            drain_commands(&mut cmds);
            return;
        }
    };

    let mut backoff = Backoff::default();
    let mut attempt: u32 = 0;
    // Whether any attempt was ever welcomed. Redial exists to restore a session
    // that was good; before the first welcome there is nothing to restore, so a
    // failed first attempt is reported to the operator instead of retried in
    // the dark (a form that says "connecting" for as long as the host is gone).
    let mut ever_online = false;
    loop {
        let phase = if attempt == 0 {
            ConnStatus::Connecting
        } else {
            ConnStatus::Reconnecting
        };
        let _ = events.send(status(phase, attempt, None));

        match session(
            &endpoint,
            addr.clone(),
            &params,
            &events,
            &mut cmds,
            &mut backoff,
            &timeouts,
        )
        .await
        {
            SessionOutcome::ClosedByUser => {
                let _ = events.send(status(ConnStatus::Offline, 0, None));
                break;
            }
            SessionOutcome::Fatal(reason) => {
                let _ = events.send(status(ConnStatus::Offline, 0, Some(reason)));
                break;
            }
            SessionOutcome::Lost { settled, why } => {
                ever_online |= settled;
                if !ever_online {
                    tracing::debug!(?why, "first attempt failed; not redialing");
                    let _ = events.send(why.into_offline(&timeouts));
                    break;
                }
                if !settled {
                    tracing::debug!(?why, attempt, "redial attempt failed");
                }
                if settled {
                    attempt = 0;
                }
                attempt = attempt.saturating_add(1);
                let deadline = Instant::now() + backoff.next_delay();
                // Production `connect` passes None — no channel, no send.
                if let Some(pulse) = &backoff_pulse {
                    let _ = pulse.send(());
                }
                // Sleep out the backoff window, but keep answering the handle:
                // a Close aborts the redial loop; Send/fetch/put fail fast so
                // the caller sees a delivery error instead of a silent drop.
                loop {
                    tokio::select! {
                        _ = tokio::time::sleep_until(deadline) => break,
                        cmd = cmds.recv() => match cmd {
                            None => {
                                let _ = events.send(status(ConnStatus::Offline, 0, None));
                                drain_commands(&mut cmds);
                                endpoint.close().await;
                                return;
                            }
                            Some(cmd) => match reject_offline_command(cmd) {
                                OfflineAction::Continue => {}
                                OfflineAction::Stop => {
                                    let _ = events.send(status(ConnStatus::Offline, 0, None));
                                    drain_commands(&mut cmds);
                                    endpoint.close().await;
                                    return;
                                }
                            },
                        },
                    }
                }
            }
        }
    }
    drain_commands(&mut cmds);
    endpoint.close().await;
}

async fn bind_endpoint(profile: NetworkProfile) -> Result<iroh::Endpoint, String> {
    use iroh::endpoint::{presets, RelayMode};
    let bound = match profile {
        NetworkProfile::N0 => iroh::Endpoint::bind(presets::N0).await,
        NetworkProfile::LocalOnly => {
            iroh::Endpoint::builder(presets::Minimal)
                .relay_mode(RelayMode::Disabled)
                .bind()
                .await
        }
    };
    bound.map_err(|err| format!("endpoint bind failed: {err}"))
}

/// The control stream ended under us. Before the welcome that is a failed
/// attempt ([`AttemptFailure::ClosedBeforeWelcome`]); after it, an ordinary
/// loss the redial loop restores (and `why` is not read).
fn dropped(settled: bool) -> SessionOutcome {
    SessionOutcome::Lost {
        settled,
        why: AttemptFailure::ClosedBeforeWelcome,
    }
}

/// The pieces of a live control stream, once the dial has gone through.
struct Dialed {
    conn: iroh::endpoint::Connection,
    send: iroh::endpoint::SendStream,
    recv: iroh::endpoint::RecvStream,
}

enum DialOutcome {
    Ready(Dialed),
    Failed(AttemptFailure),
    /// A close arrived (or every handle was dropped) mid-dial.
    Closed,
}

/// Connect, open the control stream and write `join` — all inside one
/// `limit`, and all abortable by a close. Dropping the in-flight future is what
/// actually abandons the attempt; without the race below a `Close` would sit
/// in the command queue behind an `endpoint.connect` that never returns, and
/// the replacement dial would never be able to cancel it.
///
/// Other commands get the same fail-fast verdict they get during a redial
/// backoff: there is no live stream to send on, fetch from or upload to.
async fn dial(
    endpoint: &iroh::Endpoint,
    addr: iroh::EndpointAddr,
    params: &ConnectParams,
    cmds: &mut mpsc::UnboundedReceiver<Command>,
    limit: Duration,
) -> DialOutcome {
    let handshake = async {
        let conn = endpoint
            .connect(addr, ALPN)
            .await
            .map_err(|err| format!("connect: {err}"))?;
        let (mut send, recv) = conn
            .open_bi()
            .await
            .map_err(|err| format!("control stream: {err}"))?;
        let join = frames::join_frame(
            &params.key,
            params.name.as_deref(),
            &params.client_name,
            &params.client_version,
        );
        send.write_all(&encode_line(&join))
            .await
            .map_err(|err| format!("join write: {err}"))?;
        Ok::<_, String>(Dialed { conn, send, recv })
    };
    tokio::pin!(handshake);
    let deadline = tokio::time::sleep(limit);
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            result = &mut handshake => {
                return match result {
                    Ok(dialed) => DialOutcome::Ready(dialed),
                    Err(err) => DialOutcome::Failed(AttemptFailure::Dial(err)),
                };
            }
            _ = &mut deadline => return DialOutcome::Failed(AttemptFailure::DialTimeout),
            cmd = cmds.recv() => match cmd {
                None => return DialOutcome::Closed,
                Some(cmd) => match reject_offline_command(cmd) {
                    OfflineAction::Continue => {}
                    OfflineAction::Stop => return DialOutcome::Closed,
                },
            },
        }
    }
}

async fn session(
    endpoint: &iroh::Endpoint,
    addr: iroh::EndpointAddr,
    params: &ConnectParams,
    events: &mpsc::UnboundedSender<TransportEvent>,
    cmds: &mut mpsc::UnboundedReceiver<Command>,
    backoff: &mut Backoff,
    timeouts: &Timeouts,
) -> SessionOutcome {
    let Dialed {
        conn,
        mut send,
        mut recv,
    } = match dial(endpoint, addr, params, cmds, timeouts.dial).await {
        DialOutcome::Ready(dialed) => dialed,
        DialOutcome::Failed(why) => {
            tracing::debug!(?why, "dial failed");
            return SessionOutcome::Lost {
                settled: false,
                why,
            };
        }
        DialOutcome::Closed => return SessionOutcome::ClosedByUser,
    };

    let mut decoder = LineDecoder::new();
    let mut settled = false;
    let join_deadline = Instant::now() + timeouts.join;
    let mut buf = vec![0u8; READ_CHUNK];

    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(join_deadline), if !settled => {
                conn.close(1u32.into(), b"join timeout");
                return SessionOutcome::Lost {
                    settled: false,
                    why: AttemptFailure::JoinTimeout,
                };
            }
            cmd = cmds.recv() => match cmd {
                None | Some(Command::Close) => {
                    conn.close(0u32.into(), b"client closed");
                    return SessionOutcome::ClosedByUser;
                }
                Some(Command::Send { frame, reply }) => {
                    match send.write_all(&encode_line(&frame)).await {
                        Ok(()) => {
                            let _ = reply.send(Ok(()));
                        }
                        Err(err) => {
                            let _ = reply.send(Err(format!("send failed: {err}")));
                            return dropped(settled);
                        }
                    }
                }
                Some(Command::FetchBlob { hash, reply }) => {
                    // Each fetch rides its own bidirectional stream so the
                    // control loop never blocks on bulk bytes. A connection
                    // loss simply errors the in-flight fetches.
                    let conn = conn.clone();
                    tokio::spawn(async move {
                        let result = match tokio::time::timeout(
                            FETCH_TIMEOUT,
                            fetch_blob_on(&conn, &hash),
                        )
                        .await
                        {
                            Ok(result) => result,
                            Err(_) => Err("blob fetch timed out".to_owned()),
                        };
                        let _ = reply.send(result);
                    });
                }
                Some(Command::PutBlob { upload_id, bytes, reply }) => {
                    // Same shape as a fetch: its own stream, its own deadline,
                    // and the control loop never waits on the bytes.
                    let conn = conn.clone();
                    tokio::spawn(async move {
                        let result = match tokio::time::timeout(
                            PUT_TIMEOUT,
                            put_blob_on(&conn, &upload_id, &bytes),
                        )
                        .await
                        {
                            Ok(result) => result,
                            Err(_) => Err("blob upload timed out".to_owned()),
                        };
                        let _ = reply.send(result);
                    });
                }
            },
            read = recv.read(&mut buf) => {
                let n = match read {
                    Ok(Some(n)) => n,
                    Ok(None) | Err(_) => return dropped(settled),
                };
                let batch = match decoder.push(&buf[..n]) {
                    Ok(batch) => batch,
                    Err(err) => {
                        conn.close(1u32.into(), b"oversized frame");
                        return SessionOutcome::Fatal(format!("protocol violation: {err}"));
                    }
                };
                for frame in batch {
                    if let Some(pong) = frames::ping_reply(&frame) {
                        if send.write_all(&encode_line(&pong)).await.is_err() {
                            return dropped(settled);
                        }
                        continue;
                    }
                    match frames::frame_type(&frame) {
                        // Transport, not policy: the wire version is forwarded
                        // verbatim and judged in one place only — the frontend's
                        // `store/connection.ts`, which compares against the
                        // installed `@loreweaver/protocol` major. A version gate
                        // here could only ever be a second, staler copy of that
                        // rule, and a stale copy refuses connections the app
                        // would accept.
                        Some("welcome") if !settled => {
                            settled = true;
                            backoff.reset();
                            let _ = events.send(TransportEvent::Frame { frame });
                            let _ = events.send(status(ConnStatus::Online, 0, None));
                        }
                        Some("error") => {
                            let code = frame
                                .get("code")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_owned();
                            let message = frame
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_owned();
                            let _ = events.send(TransportEvent::Frame { frame });
                            // Any error during the handshake is terminal (the
                            // server closes on it); afterwards only the listed
                            // codes are.
                            if !settled || frames::is_fatal_error_code(&code) {
                                conn.close(0u32.into(), b"fatal error");
                                return SessionOutcome::Fatal(format!("{code}: {message}"));
                            }
                        }
                        _ => {
                            let _ = events.send(TransportEvent::Frame { frame });
                        }
                    }
                }
            }
        }
    }
}

/// One media-channel GET: write the `{op:"get", hash}` header line on a fresh
/// bidirectional stream, read one newline-terminated JSON reply header —
/// `{op:"get", hash, size, mime, name}` on success, `{type:"error", code,
/// message}` with no body on rejection — then exactly `size` raw bytes.
async fn fetch_blob_on(
    conn: &iroh::endpoint::Connection,
    hash: &str,
) -> Result<FetchedBlob, String> {
    let (mut send, mut recv) = conn
        .open_bi()
        .await
        .map_err(|err| format!("media stream open failed: {err}"))?;
    let request = json!({ "op": "get", "hash": hash });
    send.write_all(&encode_line(&request))
        .await
        .map_err(|err| format!("media request write failed: {err}"))?;
    // The GET request is the header line alone; close our side so the server
    // never waits for more.
    let _ = send.finish();

    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; READ_CHUNK];
    let header = loop {
        if let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = &line[..line.len() - 1];
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            break serde_json::from_slice::<Value>(line)
                .map_err(|err| format!("bad media reply header: {err}"))?;
        }
        if buf.len() > MAX_LINE_BYTES {
            return Err("media reply header exceeds the line cap".to_owned());
        }
        match recv.read(&mut chunk).await {
            Ok(Some(n)) => buf.extend_from_slice(&chunk[..n]),
            Ok(None) => return Err("media stream closed before a reply header".to_owned()),
            Err(err) => return Err(format!("media stream read failed: {err}")),
        }
    };

    if header.get("type").and_then(Value::as_str) == Some("error") {
        let code = header
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("error");
        let message = header.get("message").and_then(Value::as_str).unwrap_or("");
        return Err(format!("{code}: {message}"));
    }
    if header.get("op").and_then(Value::as_str) != Some("get") {
        return Err("unexpected media reply header".to_owned());
    }
    let size = header
        .get("size")
        .and_then(Value::as_u64)
        .ok_or_else(|| "media reply header missing size".to_owned())?;
    let size = accepted_blob_size(size)?;
    let mime = header
        .get("mime")
        .and_then(Value::as_str)
        .unwrap_or("application/octet-stream")
        .to_owned();
    let name = header
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();

    // `buf` already holds whatever body bytes rode in with the header chunk.
    let mut body = buf;
    while body.len() < size {
        match recv.read(&mut chunk).await {
            Ok(Some(n)) => body.extend_from_slice(&chunk[..n]),
            Ok(None) => break,
            Err(err) => return Err(format!("media body read failed: {err}")),
        }
    }
    if body.len() != size {
        return Err(format!(
            "media body size mismatch: expected {size}, got {}",
            body.len()
        ));
    }
    Ok(FetchedBlob {
        bytes: body,
        mime,
        name,
    })
}

/// One media-channel PUT, per `docs/protocol.md` ("Upload flow", step 3–4):
/// write the `{op:"put", upload_id}` header line on a fresh bidirectional
/// stream, then the raw body in chunks of up to 64 KiB, then read one
/// newline-terminated reply — `{op:"put_ok", hash}` once the server has
/// verified the exact size and sha256 and stored the blob, or
/// `{type:"error", code, message}` on rejection.
///
/// The returned hash is the SERVER's, not ours: it is the one it stored the
/// blob under and the one every later `media`/`audio_library_item` broadcast
/// will name, so it is what the caller has to keep.
async fn put_blob_on(
    conn: &iroh::endpoint::Connection,
    upload_id: &str,
    bytes: &[u8],
) -> Result<String, String> {
    let (mut send, mut recv) = conn
        .open_bi()
        .await
        .map_err(|err| format!("media stream open failed: {err}"))?;
    let header = json!({ "op": "put", "upload_id": upload_id });
    send.write_all(&encode_line(&header))
        .await
        .map_err(|err| format!("media header write failed: {err}"))?;
    for chunk in bytes.chunks(PUT_CHUNK) {
        send.write_all(chunk)
            .await
            .map_err(|err| format!("media body write failed: {err}"))?;
    }
    // The body is the whole request; close our side so the server stops waiting.
    let _ = send.finish();

    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; READ_CHUNK];
    loop {
        if let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = &line[..line.len() - 1];
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            let reply: Value = serde_json::from_slice(line)
                .map_err(|err| format!("bad media put reply: {err}"))?;
            if reply.get("type").and_then(Value::as_str) == Some("error") {
                let code = reply.get("code").and_then(Value::as_str).unwrap_or("error");
                let message = reply.get("message").and_then(Value::as_str).unwrap_or("");
                return Err(format!("{code}: {message}"));
            }
            if reply.get("op").and_then(Value::as_str) != Some("put_ok") {
                return Err(format!("unexpected media put reply: {reply}"));
            }
            return reply
                .get("hash")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| "media put reply carries no hash".to_owned());
        }
        if buf.len() > MAX_LINE_BYTES {
            return Err("media put reply exceeds the line cap".to_owned());
        }
        match recv.read(&mut chunk).await {
            Ok(Some(n)) => buf.extend_from_slice(&chunk[..n]),
            Ok(None) => return Err("media stream closed before a put reply".to_owned()),
            Err(err) => return Err(format!("media put reply read failed: {err}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn send_during_offline_wait_is_err_not_ok() {
        let (reply, mut rx) = oneshot::channel();
        assert!(matches!(
            reject_offline_command(Command::Send {
                frame: json!({"type": "input", "text": "lost if this is Ok"}),
                reply,
            }),
            OfflineAction::Continue
        ));
        assert_eq!(
            rx.try_recv().expect("waiter settled"),
            Err("transport offline".to_owned())
        );
    }

    #[test]
    fn fetch_and_put_during_offline_wait_fail_the_same_way() {
        let (fetch_reply, mut fetch_rx) = oneshot::channel();
        assert!(matches!(
            reject_offline_command(Command::FetchBlob {
                hash: "cafe".to_owned(),
                reply: fetch_reply,
            }),
            OfflineAction::Continue
        ));
        assert_eq!(
            fetch_rx
                .try_recv()
                .expect("fetch waiter settled")
                .expect_err("fetch fails offline"),
            "transport offline"
        );

        let (put_reply, mut put_rx) = oneshot::channel();
        assert!(matches!(
            reject_offline_command(Command::PutBlob {
                upload_id: "u-1".to_owned(),
                bytes: vec![1, 2, 3],
                reply: put_reply,
            }),
            OfflineAction::Continue
        ));
        assert_eq!(
            put_rx.try_recv().expect("put waiter settled"),
            Err("transport offline".to_owned())
        );
    }

    #[test]
    fn each_failure_has_its_own_code_and_an_english_detail() {
        let timeouts = Timeouts::default();
        let cases = [
            (
                AttemptFailure::DialTimeout,
                ErrorCode::ConnectTimeout,
                "connect timeout: no connection to the host within 15s",
            ),
            (
                AttemptFailure::JoinTimeout,
                ErrorCode::JoinTimeout,
                "join timeout: connected, but no welcome within 15s",
            ),
            (
                AttemptFailure::Dial("connect: boom".to_owned()),
                ErrorCode::ConnectFailed,
                "connect failed: connect: boom",
            ),
            (
                AttemptFailure::ClosedBeforeWelcome,
                ErrorCode::ConnectFailed,
                "connect failed: the host closed the connection before it welcomed us",
            ),
        ];
        for (failure, code, detail) in cases {
            assert_eq!(failure.code(), code);
            assert_eq!(failure.detail(&timeouts), detail);
        }
    }

    #[test]
    fn a_failed_first_attempt_ends_offline_with_reason_and_code() {
        let event = AttemptFailure::DialTimeout.into_offline(&Timeouts::default());
        assert_eq!(
            serde_json::to_value(&event).expect("serializes"),
            json!({
                "kind": "status",
                "status": "offline",
                "attempt": 0,
                "error": "connect timeout: no connection to the host within 15s",
                "errorCode": "connect_timeout",
            })
        );
    }

    #[test]
    fn a_status_without_a_code_keeps_the_old_wire_shape() {
        let event = status(ConnStatus::Online, 0, None);
        assert_eq!(
            serde_json::to_value(&event).expect("serializes"),
            json!({"kind": "status", "status": "online", "attempt": 0})
        );
    }

    #[test]
    fn one_attempt_is_bounded_to_thirty_seconds() {
        let timeouts = Timeouts::default();
        assert!(timeouts.dial + timeouts.join <= Duration::from_secs(30));
    }

    #[test]
    fn close_during_offline_wait_stops_the_redial() {
        assert!(matches!(
            reject_offline_command(Command::Close),
            OfflineAction::Stop
        ));
    }
}
