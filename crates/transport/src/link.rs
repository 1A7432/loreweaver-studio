//! The link actor: dial a ticket, open the control stream, carry lines and
//! bytes, report how it ended. One link is one connection; it is never
//! redialled from here.
//!
//! One spawned task owns the connection. The embedder talks to it through a
//! [`LinkHandle`] (send a frame, fetch, put, close) and consumes
//! [`LinkEvent`]s from the returned receiver: `connecting`, then `up` once the
//! control stream is open, then one `closed` — with a stable [`CloseCode`] and
//! an English reason when it was not the embedder's own close — after which the
//! receiver ends.
//!
//! What this link does NOT do, by design (protocol 3.0 puts all of it in the
//! client session): write `hello` or any other frame of its own, answer or send
//! pings, look at `welcome` or `error`, or dial again after a loss. The QUIC
//! stream is not visible to the server until the client writes on it, so the
//! embedder writes `hello` as soon as it hears `up`.
//!
//! The dial (connect + open the control stream) is bounded by
//! [`DIAL_TIMEOUT`] and abortable by a close — iroh alone keeps dialling a
//! ticket whose addresses went stale for minutes. [`LinkHandle::send_frame`] is
//! a delivery verdict, not an enqueue: `Ok` only once the control stream
//! accepted the write.

use std::sync::Arc;
use std::time::Duration;

use iroh::endpoint::{ConnectionError, ReadError};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, Semaphore};

use crate::bytes::{self, ByteError, ByteFile, FetchedFile, BYTE_STALL, MAX_BYTE_STREAMS};
use crate::codec::{encode_line, LineDecoder};
use crate::limits::MAX_BLOB_BYTES;

/// ALPN both ends negotiate. It carries the protocol MAJOR (`docs/protocol.md`
/// §2.1), so a 2.x server refuses the connection instead of misreading frames.
pub const ALPN: &[u8] = b"loreweaver/3";

/// How long one dial may take: connect to the endpoint and open the control
/// stream. A healthy path (direct or relayed) is up in a second or two; what
/// runs past this is a stale ticket (the host restarted on a new port) or a
/// host that is gone.
pub const DIAL_TIMEOUT: Duration = Duration::from_secs(15);

/// End-to-end bound for one byte operation, queueing for a stream included.
/// The stall bound catches a dead stream long before; this one only stops a
/// trickle from holding a stream forever (a 128 MiB sound over a relay is the
/// slowest legitimate case).
pub const BYTE_OP_TIMEOUT: Duration = Duration::from_secs(600);

const READ_CHUNK: usize = 64 * 1024;

/// The bounds a link runs under. Production always runs [`Timeouts::default`];
/// the type exists so the integration tests can watch a bound fire in
/// milliseconds instead of waiting out the real one.
#[doc(hidden)]
#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    pub dial: Duration,
    pub stall: Duration,
    pub byte_op: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            dial: DIAL_TIMEOUT,
            stall: BYTE_STALL,
            byte_op: BYTE_OP_TIMEOUT,
        }
    }
}

/// How the endpoint finds the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NetworkProfile {
    /// n0 address lookup and the public relays (the server's own default), so
    /// any real-world ticket is dialable.
    #[default]
    N0,
    /// No relays, no lookup: direct socket addresses only — a server on this
    /// machine started with `serve --local`, with no network at all, and the
    /// offline tests.
    Local,
}

#[derive(Debug, Clone)]
pub struct LinkParams {
    /// The iroh endpoint ticket the server printed (starts with `endpoint`).
    pub ticket: String,
    pub network: NetworkProfile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkStatus {
    /// Binding the endpoint and dialling.
    Connecting,
    /// The control stream is open: write `hello` now.
    Up,
    /// The link is over; nothing follows on this receiver.
    Closed,
}

/// Why a link closed when the embedder did not close it. The wire spelling is
/// the snake_case name; the WebView picks its wording by it, so renaming one is
/// a change on both sides of the bridge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CloseCode {
    /// The ticket does not parse.
    InvalidTicket,
    /// This machine could not bind an endpoint.
    BindFailed,
    /// No connection within [`DIAL_TIMEOUT`].
    DialTimeout,
    /// The dial failed outright (refused, no route, another ALPN…).
    DialFailed,
    /// The server broke the framing: a line over the cap.
    ProtocolViolation,
    /// The server closed the connection or finished the control stream.
    ClosedByPeer,
    /// The connection was lost (timed out, reset, a write failed).
    ConnectionLost,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LinkEvent {
    Status {
        status: LinkStatus,
        /// English detail for logs; absent for `connecting`, `up` and the
        /// embedder's own close.
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        /// Present on a `closed` the embedder did not ask for.
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<CloseCode>,
    },
    /// One line of the control stream, parsed: an object, passed through untouched.
    Frame { frame: Value },
}

impl LinkEvent {
    fn status(status: LinkStatus) -> Self {
        Self::Status {
            status,
            reason: None,
            code: None,
        }
    }

    fn closed(code: CloseCode, reason: impl Into<String>) -> Self {
        Self::Status {
            status: LinkStatus::Closed,
            reason: Some(reason.into()),
            code: Some(code),
        }
    }
}

#[derive(Debug)]
enum Command {
    Send {
        frame: Value,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Fetch {
        hash: String,
        /// The most bytes this fetch accepts (the header is refused above it).
        max: u64,
        reply: oneshot::Sender<Result<FetchedFile, ByteError>>,
    },
    Put {
        upload_id: String,
        bytes: Vec<u8>,
        reply: oneshot::Sender<Result<ByteFile, ByteError>>,
    },
    Close,
}

/// Cheap cloneable handle to the link actor.
#[derive(Debug, Clone)]
pub struct LinkHandle {
    cmd: mpsc::UnboundedSender<Command>,
}

const GONE: &str = "the link is closed";
const NOT_UP: &str = "the link is not up";

impl LinkHandle {
    /// Write one frame as one line on the control stream. `Ok` means the
    /// stream accepted the bytes — not that the server processed them. `Err`
    /// means they were not written: the link is not up yet, is closed, or the
    /// write failed (which also closes the link as `connection_lost`).
    pub async fn send_frame(&self, frame: Value) -> Result<(), String> {
        let (reply, rx) = oneshot::channel();
        self.cmd
            .send(Command::Send { frame, reply })
            .map_err(|_| GONE.to_owned())?;
        rx.await.map_err(|_| GONE.to_owned())?
    }

    /// GET one file by its content hash on a byte stream of its own. At most
    /// [`MAX_BYTE_STREAMS`] byte operations run at once; the rest wait in order.
    pub async fn fetch(&self, hash: String) -> Result<FetchedFile, ByteError> {
        self.fetch_within(hash, MAX_BLOB_BYTES).await
    }

    /// [`Self::fetch`] with the ceiling named by the caller: a room save may be
    /// larger than any other file ([`crate::MAX_SAVE_BYTES`]), and is the one
    /// fetch that asks for more than [`MAX_BLOB_BYTES`].
    pub async fn fetch_within(&self, hash: String, max: u64) -> Result<FetchedFile, ByteError> {
        let (reply, rx) = oneshot::channel();
        self.cmd
            .send(Command::Fetch { hash, max, reply })
            .map_err(|_| ByteError::NotConnected)?;
        rx.await.map_err(|_| ByteError::NotConnected)?
    }

    /// PUT the bytes of an offer the server accepted (`media.offer` answered
    /// `{upload_id}`); the answer is the server's receipt.
    pub async fn put(&self, upload_id: String, bytes: Vec<u8>) -> Result<ByteFile, ByteError> {
        let (reply, rx) = oneshot::channel();
        self.cmd
            .send(Command::Put {
                upload_id,
                bytes,
                reply,
            })
            .map_err(|_| ByteError::NotConnected)?;
        rx.await.map_err(|_| ByteError::NotConnected)?
    }

    /// Close the link. Idempotent; the receiver gets one `closed` without a code.
    pub fn close(&self) {
        let _ = self.cmd.send(Command::Close);
    }
}

/// Spawn a link actor on the current tokio runtime.
pub fn connect(params: LinkParams) -> (LinkHandle, mpsc::UnboundedReceiver<LinkEvent>) {
    connect_with(params, Timeouts::default())
}

/// Test-only: [`connect`] with the bounds replaced. Hidden from rustdoc.
#[doc(hidden)]
pub fn connect_with(
    params: LinkParams,
    timeouts: Timeouts,
) -> (LinkHandle, mpsc::UnboundedReceiver<LinkEvent>) {
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    let (event_tx, event_rx) = mpsc::unbounded_channel();
    tokio::spawn(run(params, timeouts, event_tx, cmd_rx));
    (LinkHandle { cmd: cmd_tx }, event_rx)
}

/// The answer to every command while there is no control stream (dialling, or
/// on the way out). `true` when the command was a close.
fn refuse(cmd: Command, why: &str) -> bool {
    match cmd {
        Command::Send { reply, .. } => {
            let _ = reply.send(Err(why.to_owned()));
            false
        }
        Command::Fetch { reply, .. } => {
            let _ = reply.send(Err(ByteError::NotConnected));
            false
        }
        Command::Put { reply, .. } => {
            let _ = reply.send(Err(ByteError::NotConnected));
            false
        }
        Command::Close => true,
    }
}

fn drain(cmds: &mut mpsc::UnboundedReceiver<Command>) {
    while let Ok(cmd) = cmds.try_recv() {
        refuse(cmd, GONE);
    }
}

async fn run(
    params: LinkParams,
    timeouts: Timeouts,
    events: mpsc::UnboundedSender<LinkEvent>,
    mut cmds: mpsc::UnboundedReceiver<Command>,
) {
    let ticket: iroh_tickets::endpoint::EndpointTicket = match params.ticket.trim().parse() {
        Ok(ticket) => ticket,
        Err(err) => {
            let _ = events.send(LinkEvent::closed(
                CloseCode::InvalidTicket,
                format!("invalid ticket: {err}"),
            ));
            drain(&mut cmds);
            return;
        }
    };
    let _ = events.send(LinkEvent::status(LinkStatus::Connecting));
    let endpoint = match bind_endpoint(params.network).await {
        Ok(endpoint) => endpoint,
        Err(err) => {
            let _ = events.send(LinkEvent::closed(CloseCode::BindFailed, err));
            drain(&mut cmds);
            return;
        }
    };
    let ended = match dial(
        &endpoint,
        ticket.endpoint_addr().clone(),
        &mut cmds,
        timeouts,
    )
    .await
    {
        Dialed::Ready(conn, send, recv) => {
            let _ = events.send(LinkEvent::status(LinkStatus::Up));
            carry(conn, send, recv, &events, &mut cmds, timeouts).await
        }
        Dialed::Failed(code, reason) => LinkEvent::closed(code, reason),
        Dialed::Closed => LinkEvent::status(LinkStatus::Closed),
    };
    let _ = events.send(ended);
    drain(&mut cmds);
    endpoint.close().await;
}

async fn bind_endpoint(profile: NetworkProfile) -> Result<iroh::Endpoint, String> {
    use iroh::endpoint::{presets, RelayMode};
    let bound = match profile {
        NetworkProfile::N0 => iroh::Endpoint::bind(presets::N0).await,
        NetworkProfile::Local => {
            iroh::Endpoint::builder(presets::Minimal)
                .relay_mode(RelayMode::Disabled)
                .bind()
                .await
        }
    };
    bound.map_err(|err| format!("endpoint bind failed: {err}"))
}

enum Dialed {
    Ready(
        iroh::endpoint::Connection,
        iroh::endpoint::SendStream,
        iroh::endpoint::RecvStream,
    ),
    Failed(CloseCode, String),
    /// A close arrived (or every handle was dropped) mid-dial.
    Closed,
}

/// Connect and open the control stream inside one bound, abortable by a
/// close. Dropping the in-flight future is what abandons the attempt; without
/// the race a close would wait behind an `endpoint.connect` that never returns.
async fn dial(
    endpoint: &iroh::Endpoint,
    addr: iroh::EndpointAddr,
    cmds: &mut mpsc::UnboundedReceiver<Command>,
    timeouts: Timeouts,
) -> Dialed {
    let handshake = async {
        let conn = endpoint
            .connect(addr, ALPN)
            .await
            .map_err(|err| format!("connect: {err}"))?;
        let (send, recv) = conn
            .open_bi()
            .await
            .map_err(|err| format!("control stream: {err}"))?;
        Ok::<_, String>((conn, send, recv))
    };
    tokio::pin!(handshake);
    let deadline = tokio::time::sleep(timeouts.dial);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            result = &mut handshake => {
                return match result {
                    Ok((conn, send, recv)) => Dialed::Ready(conn, send, recv),
                    Err(err) => Dialed::Failed(CloseCode::DialFailed, format!("dial failed: {err}")),
                };
            }
            _ = &mut deadline => {
                return Dialed::Failed(
                    CloseCode::DialTimeout,
                    format!("dial timeout: no connection within {}s", timeouts.dial.as_secs_f32()),
                );
            }
            cmd = cmds.recv() => match cmd {
                None => return Dialed::Closed,
                Some(cmd) => {
                    if refuse(cmd, NOT_UP) {
                        return Dialed::Closed;
                    }
                }
            },
        }
    }
}

/// How a read error on the control stream reads to the embedder.
fn read_failure(err: &ReadError) -> LinkEvent {
    let code = match err {
        ReadError::Reset(_) | ReadError::ClosedStream => CloseCode::ClosedByPeer,
        ReadError::ConnectionLost(
            ConnectionError::ApplicationClosed(_)
            | ConnectionError::ConnectionClosed(_)
            | ConnectionError::Reset,
        ) => CloseCode::ClosedByPeer,
        _ => CloseCode::ConnectionLost,
    };
    let detail = match err {
        ReadError::ConnectionLost(lost) => lost.to_string(),
        other => other.to_string(),
    };
    LinkEvent::closed(code, detail)
}

/// Carry lines both ways and run byte operations until the link ends; answers
/// the event that says how.
async fn carry(
    conn: iroh::endpoint::Connection,
    mut send: iroh::endpoint::SendStream,
    mut recv: iroh::endpoint::RecvStream,
    events: &mpsc::UnboundedSender<LinkEvent>,
    cmds: &mut mpsc::UnboundedReceiver<Command>,
    timeouts: Timeouts,
) -> LinkEvent {
    let mut decoder = LineDecoder::new();
    let mut buf = vec![0u8; READ_CHUNK];
    // The protocol's per-connection stream limit, kept on this side so the
    // server never has to refuse a fifth stream: a fifth operation waits here,
    // in order (tokio's semaphore is fair).
    let gate = Arc::new(Semaphore::new(MAX_BYTE_STREAMS));
    loop {
        tokio::select! {
            cmd = cmds.recv() => match cmd {
                None | Some(Command::Close) => {
                    conn.close(0u32.into(), b"client closed");
                    return LinkEvent::status(LinkStatus::Closed);
                }
                Some(Command::Send { frame, reply }) => {
                    match send.write_all(&encode_line(&frame)).await {
                        Ok(()) => {
                            let _ = reply.send(Ok(()));
                        }
                        Err(err) => {
                            let _ = reply.send(Err(format!("send failed: {err}")));
                            conn.close(1u32.into(), b"write failed");
                            return LinkEvent::closed(
                                CloseCode::ConnectionLost,
                                format!("send failed: {err}"),
                            );
                        }
                    }
                }
                Some(Command::Fetch { hash, max, reply }) => {
                    if !bytes::is_content_hash(&hash) {
                        let _ = reply.send(Err(ByteError::BadHash));
                        continue;
                    }
                    let (conn, gate) = (conn.clone(), gate.clone());
                    tokio::spawn(async move {
                        let operation = async {
                            let _slot = gate.acquire_owned().await.map_err(|_| ByteError::NotConnected)?;
                            let (mut send, mut recv) =
                                conn.open_bi().await.map_err(|_| ByteError::NotConnected)?;
                            bytes::get(&mut send, &mut recv, &hash, max, timeouts.stall).await
                        };
                        let result = tokio::time::timeout(timeouts.byte_op, operation)
                            .await
                            .unwrap_or(Err(ByteError::Timeout));
                        let _ = reply.send(result);
                    });
                }
                Some(Command::Put { upload_id, bytes: body, reply }) => {
                    if !bytes::is_upload_id(&upload_id) {
                        let _ = reply.send(Err(ByteError::BadUploadId));
                        continue;
                    }
                    let (conn, gate) = (conn.clone(), gate.clone());
                    tokio::spawn(async move {
                        let operation = async {
                            let _slot = gate.acquire_owned().await.map_err(|_| ByteError::NotConnected)?;
                            let (mut send, mut recv) =
                                conn.open_bi().await.map_err(|_| ByteError::NotConnected)?;
                            bytes::put(&mut send, &mut recv, &upload_id, &body, timeouts.stall).await
                        };
                        let result = tokio::time::timeout(timeouts.byte_op, operation)
                            .await
                            .unwrap_or(Err(ByteError::Timeout));
                        let _ = reply.send(result);
                    });
                }
            },
            read = recv.read(&mut buf) => {
                let n = match read {
                    Ok(Some(n)) => n,
                    Ok(None) => {
                        return LinkEvent::closed(
                            CloseCode::ClosedByPeer,
                            "the server finished the control stream",
                        );
                    }
                    Err(err) => return read_failure(&err),
                };
                match decoder.push(&buf[..n]) {
                    Ok(frames) => {
                        for frame in frames {
                            let _ = events.send(LinkEvent::Frame { frame });
                        }
                    }
                    Err(err) => {
                        conn.close(1u32.into(), b"line too long");
                        return LinkEvent::closed(
                            CloseCode::ProtocolViolation,
                            format!("protocol violation: {err}"),
                        );
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_alpn_carries_the_protocol_major() {
        assert_eq!(ALPN, b"loreweaver/3");
    }

    #[test]
    fn statuses_serialize_to_the_bridge_shape() {
        assert_eq!(
            serde_json::to_value(LinkEvent::status(LinkStatus::Up)).expect("json"),
            json!({"kind": "status", "status": "up"})
        );
        assert_eq!(
            serde_json::to_value(LinkEvent::status(LinkStatus::Closed)).expect("json"),
            json!({"kind": "status", "status": "closed"})
        );
        assert_eq!(
            serde_json::to_value(LinkEvent::closed(CloseCode::DialTimeout, "slow")).expect("json"),
            json!({"kind": "status", "status": "closed", "code": "dial_timeout", "reason": "slow"})
        );
    }

    #[test]
    fn every_close_code_has_its_wire_name() {
        for (code, name) in [
            (CloseCode::InvalidTicket, "invalid_ticket"),
            (CloseCode::BindFailed, "bind_failed"),
            (CloseCode::DialTimeout, "dial_timeout"),
            (CloseCode::DialFailed, "dial_failed"),
            (CloseCode::ProtocolViolation, "protocol_violation"),
            (CloseCode::ClosedByPeer, "closed_by_peer"),
            (CloseCode::ConnectionLost, "connection_lost"),
        ] {
            assert_eq!(serde_json::to_value(code).expect("json"), json!(name));
        }
    }

    #[test]
    fn frames_pass_through_untouched() {
        let frame = json!({"type": "welcome", "protocol": "3.0", "extra": [1, 2]});
        assert_eq!(
            serde_json::to_value(LinkEvent::Frame {
                frame: frame.clone()
            })
            .expect("json"),
            json!({"kind": "frame", "frame": frame})
        );
    }

    #[test]
    fn the_network_profile_reads_n0_or_local_and_defaults_to_n0() {
        assert_eq!(
            serde_json::from_value::<NetworkProfile>(json!("n0")).expect("n0"),
            NetworkProfile::N0
        );
        assert_eq!(
            serde_json::from_value::<NetworkProfile>(json!("local")).expect("local"),
            NetworkProfile::Local
        );
        assert!(serde_json::from_value::<NetworkProfile>(json!("lan")).is_err());
        assert_eq!(NetworkProfile::default(), NetworkProfile::N0);
    }

    #[test]
    fn without_a_control_stream_every_command_is_refused_not_queued() {
        let (reply, mut rx) = oneshot::channel();
        assert!(!refuse(
            Command::Send {
                frame: json!({"type": "ping", "t": 1}),
                reply
            },
            NOT_UP
        ));
        assert_eq!(rx.try_recv().expect("settled"), Err(NOT_UP.to_owned()));

        let (reply, mut rx) = oneshot::channel();
        assert!(!refuse(
            Command::Fetch {
                hash: "a".repeat(64),
                max: MAX_BLOB_BYTES,
                reply
            },
            NOT_UP
        ));
        assert_eq!(
            rx.try_recv().expect("settled").expect_err("refused"),
            ByteError::NotConnected
        );

        let (reply, mut rx) = oneshot::channel();
        assert!(!refuse(
            Command::Put {
                upload_id: "u".to_owned(),
                bytes: vec![1],
                reply
            },
            NOT_UP
        ));
        assert_eq!(
            rx.try_recv().expect("settled").expect_err("refused"),
            ByteError::NotConnected
        );

        assert!(refuse(Command::Close, NOT_UP), "a close ends the dial");
    }
}
