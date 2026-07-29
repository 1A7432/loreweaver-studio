//! The connection actor: dial a ticket, join, pump frames, redial on loss.
//!
//! One spawned task owns the whole connection lifecycle. The embedder talks to
//! it through a [`ClientHandle`] (send frame / close) and consumes
//! [`TransportEvent`]s from the returned receiver. Lifecycle mirrors the
//! reference TUI client: `connecting → online → reconnecting → offline`, where
//! `offline` is only reached by an explicit close or a fatal join error.

use std::time::Duration;

use serde_json::Value;
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::backoff::Backoff;
use crate::codec::{encode_line, LineDecoder};
use crate::frames::{self, ALPN};

/// How long we wait for `welcome` (or `error`) after sending `join`. The
/// server's own handshake timeout defaults to 10s; ours is slightly larger so
/// the server-side verdict usually arrives first.
pub const JOIN_TIMEOUT: Duration = Duration::from_secs(15);

const READ_CHUNK: usize = 64 * 1024;

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
    },
    Frame {
        frame: Value,
    },
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

#[derive(Debug)]
enum Command {
    Send(Value),
    Close,
}

#[derive(Debug, thiserror::Error)]
#[error("transport is closed")]
pub struct TransportClosed;

/// Cheap cloneable handle to the connection actor.
#[derive(Debug, Clone)]
pub struct ClientHandle {
    cmd: mpsc::UnboundedSender<Command>,
}

impl ClientHandle {
    pub fn send_frame(&self, frame: Value) -> Result<(), TransportClosed> {
        self.cmd
            .send(Command::Send(frame))
            .map_err(|_| TransportClosed)
    }

    /// Ask the actor to close and stop redialing. Idempotent.
    pub fn close(&self) {
        let _ = self.cmd.send(Command::Close);
    }
}

/// Spawn the connection actor on the current tokio runtime.
pub fn connect(params: ConnectParams) -> (ClientHandle, mpsc::UnboundedReceiver<TransportEvent>) {
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    let (event_tx, event_rx) = mpsc::unbounded_channel();
    tokio::spawn(run(params, event_tx, cmd_rx));
    (ClientHandle { cmd: cmd_tx }, event_rx)
}

fn status(status: ConnStatus, attempt: u32, error: Option<String>) -> TransportEvent {
    TransportEvent::Status {
        status,
        attempt,
        error,
    }
}

enum SessionOutcome {
    /// The connection dropped; `settled` is true when a welcome had arrived.
    Lost {
        settled: bool,
    },
    /// Give up for good and surface the reason.
    Fatal(String),
    ClosedByUser,
}

async fn run(
    params: ConnectParams,
    events: mpsc::UnboundedSender<TransportEvent>,
    mut cmds: mpsc::UnboundedReceiver<Command>,
) {
    let ticket: iroh_tickets::endpoint::EndpointTicket = match params.ticket.trim().parse() {
        Ok(ticket) => ticket,
        Err(err) => {
            let _ = events.send(status(
                ConnStatus::Offline,
                0,
                Some(format!("invalid ticket: {err}")),
            ));
            return;
        }
    };
    let addr = ticket.endpoint_addr().clone();

    let endpoint = match bind_endpoint(params.network).await {
        Ok(endpoint) => endpoint,
        Err(err) => {
            let _ = events.send(status(ConnStatus::Offline, 0, Some(err)));
            return;
        }
    };

    let mut backoff = Backoff::default();
    let mut attempt: u32 = 0;
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
            SessionOutcome::Lost { settled } => {
                if settled {
                    attempt = 0;
                }
                attempt = attempt.saturating_add(1);
                let deadline = Instant::now() + backoff.next_delay();
                // Sleep out the backoff window, but keep answering the handle:
                // a Close aborts the redial loop, sends are dropped while down.
                loop {
                    tokio::select! {
                        _ = tokio::time::sleep_until(deadline) => break,
                        cmd = cmds.recv() => match cmd {
                            None | Some(Command::Close) => {
                                let _ = events.send(status(ConnStatus::Offline, 0, None));
                                endpoint.close().await;
                                return;
                            }
                            Some(Command::Send(_)) => continue,
                        },
                    }
                }
            }
        }
    }
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

async fn session(
    endpoint: &iroh::Endpoint,
    addr: iroh::EndpointAddr,
    params: &ConnectParams,
    events: &mpsc::UnboundedSender<TransportEvent>,
    cmds: &mut mpsc::UnboundedReceiver<Command>,
    backoff: &mut Backoff,
) -> SessionOutcome {
    let conn = match endpoint.connect(addr, ALPN).await {
        Ok(conn) => conn,
        Err(err) => {
            tracing::debug!(error = %err, "connect failed");
            return SessionOutcome::Lost { settled: false };
        }
    };
    let (mut send, mut recv) = match conn.open_bi().await {
        Ok(pair) => pair,
        Err(err) => {
            tracing::debug!(error = %err, "control stream failed");
            return SessionOutcome::Lost { settled: false };
        }
    };

    let join = frames::join_frame(
        &params.key,
        params.name.as_deref(),
        &params.client_name,
        &params.client_version,
    );
    if let Err(err) = send.write_all(&encode_line(&join)).await {
        tracing::debug!(error = %err, "join write failed");
        return SessionOutcome::Lost { settled: false };
    }

    let mut decoder = LineDecoder::new();
    let mut settled = false;
    let join_deadline = Instant::now() + JOIN_TIMEOUT;
    let mut buf = vec![0u8; READ_CHUNK];

    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(join_deadline), if !settled => {
                conn.close(1u32.into(), b"join timeout");
                return SessionOutcome::Lost { settled: false };
            }
            cmd = cmds.recv() => match cmd {
                None | Some(Command::Close) => {
                    conn.close(0u32.into(), b"client closed");
                    return SessionOutcome::ClosedByUser;
                }
                Some(Command::Send(frame)) => {
                    if send.write_all(&encode_line(&frame)).await.is_err() {
                        return SessionOutcome::Lost { settled };
                    }
                }
            },
            read = recv.read(&mut buf) => {
                let n = match read {
                    Ok(Some(n)) => n,
                    Ok(None) | Err(_) => return SessionOutcome::Lost { settled },
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
                            return SessionOutcome::Lost { settled };
                        }
                        continue;
                    }
                    match frames::frame_type(&frame) {
                        Some("welcome") if !settled => {
                            let protocol = frame
                                .get("protocol")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_owned();
                            if !frames::protocol_supported(&protocol) {
                                conn.close(1u32.into(), b"unsupported protocol");
                                return SessionOutcome::Fatal(format!(
                                    "unsupported protocol version {protocol:?}"
                                ));
                            }
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
