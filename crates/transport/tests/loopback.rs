//! Offline loopback integration tests: a real iroh endpoint pair over
//! localhost UDP with relays and address lookup disabled — no external
//! network, deterministic sequencing via explicit acks.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use iroh::endpoint::{presets, Connection, RecvStream, RelayMode, SendStream};
use iroh::{Endpoint, EndpointAddr};
use iroh_tickets::endpoint::EndpointTicket;
use loreweaver_transport::client::{
    connect, connect_with_backoff_pulse, connect_with_timeouts, ConnStatus, ConnectParams,
    ErrorCode, NetworkProfile, Timeouts, TransportEvent,
};
use loreweaver_transport::codec::{encode_line, LineDecoder};
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedReceiver;

const ALPN: &[u8] = b"loreweaver/tui/1";
const STEP: Duration = Duration::from_secs(20);

fn params(ticket: &str) -> ConnectParams {
    ConnectParams {
        ticket: ticket.to_owned(),
        key: "k-test".to_owned(),
        name: Some("Nyx".to_owned()),
        client_name: "loreweaver-studio-test".to_owned(),
        client_version: "0.0.0".to_owned(),
        network: NetworkProfile::LocalOnly,
    }
}

async fn bind_server() -> (Endpoint, String) {
    let endpoint = Endpoint::builder(presets::Minimal)
        .relay_mode(RelayMode::Disabled)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .expect("server endpoint binds");
    let mut addr = EndpointAddr::new(endpoint.id());
    for sock in endpoint.bound_sockets() {
        let ip = match sock.ip() {
            IpAddr::V4(v4) if v4.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V6(v6) if v6.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
            other => other,
        };
        addr = addr.with_ip_addr(SocketAddr::new(ip, sock.port()));
    }
    let ticket = EndpointTicket::from(addr).to_string();
    (endpoint, ticket)
}

struct ServerConn {
    conn: Connection,
    send: SendStream,
    recv: RecvStream,
    decoder: LineDecoder,
    queue: Vec<Value>,
}

impl ServerConn {
    async fn accept(endpoint: &Endpoint) -> Self {
        let incoming = endpoint.accept().await.expect("incoming connection");
        let conn = incoming.await.expect("connection establishes");
        let (send, recv) = conn.accept_bi().await.expect("control stream accepted");
        Self {
            conn,
            send,
            recv,
            decoder: LineDecoder::new(),
            queue: Vec::new(),
        }
    }

    async fn read_frame(&mut self) -> Value {
        loop {
            if !self.queue.is_empty() {
                return self.queue.remove(0);
            }
            let mut buf = vec![0u8; 64 * 1024];
            let n = self
                .recv
                .read(&mut buf)
                .await
                .expect("server read")
                .expect("client kept the stream open");
            self.queue
                .extend(self.decoder.push(&buf[..n]).expect("decode"));
        }
    }

    async fn write_frame(&mut self, frame: &Value) {
        self.send
            .write_all(&encode_line(frame))
            .await
            .expect("server write");
    }
}

fn welcome_frame(protocol: &str) -> Value {
    json!({
        "type": "welcome",
        "protocol": protocol,
        "room": "r1",
        "you": { "id": "u1", "name": "Nyx", "role": "player" },
        "locale": "en",
        "server": "loreweaver/1",
    })
}

async fn next_event(rx: &mut UnboundedReceiver<TransportEvent>) -> TransportEvent {
    tokio::time::timeout(STEP, rx.recv())
        .await
        .expect("an event before the timeout")
        .expect("event channel open")
}

async fn expect_status(
    rx: &mut UnboundedReceiver<TransportEvent>,
    expected: ConnStatus,
) -> (u32, Option<String>) {
    match next_event(rx).await {
        TransportEvent::Status {
            status,
            attempt,
            error,
            ..
        } => {
            assert_eq!(status, expected, "unexpected status (error: {error:?})");
            (attempt, error)
        }
        TransportEvent::Frame { frame } => {
            panic!("expected status {expected:?}, got frame {frame}")
        }
    }
}

async fn expect_frame(rx: &mut UnboundedReceiver<TransportEvent>) -> Value {
    match next_event(rx).await {
        TransportEvent::Frame { frame } => frame,
        TransportEvent::Status { status, error, .. } => {
            panic!("expected a frame, got status {status:?} (error: {error:?})")
        }
    }
}

#[tokio::test]
async fn happy_path_join_autopong_and_echo() {
    let (endpoint, ticket) = bind_server().await;
    let server = tokio::spawn(async move {
        let mut conn = ServerConn::accept(&endpoint).await;
        let join = conn.read_frame().await;
        assert_eq!(join["type"], "join");
        assert_eq!(join["key"], "k-test");
        assert_eq!(join["name"], "Nyx");
        assert_eq!(join["client"]["name"], "loreweaver-studio-test");
        conn.write_frame(&welcome_frame("1.6")).await;
        // Server-initiated keepalive: the transport must answer by itself.
        conn.write_frame(&json!({"type": "ping", "t": 42})).await;
        let pong = conn.read_frame().await;
        assert_eq!(pong, json!({"type": "pong", "t": 42}));
        // Echo one player input back as narrative.
        let input = conn.read_frame().await;
        assert_eq!(input["type"], "input");
        conn.write_frame(&json!({
            "type": "narrative",
            "id": "n1",
            "speaker": "kp",
            "text": input["text"].clone(),
            "format": "markdown",
        }))
        .await;
        conn.conn.closed().await;
    });

    let (handle, mut rx) = connect(params(&ticket));
    expect_status(&mut rx, ConnStatus::Connecting).await;
    let welcome = expect_frame(&mut rx).await;
    assert_eq!(welcome["type"], "welcome");
    assert_eq!(welcome["room"], "r1");
    expect_status(&mut rx, ConnStatus::Online).await;

    handle
        .send_frame(json!({"type": "input", "text": "hello"}))
        .await
        .expect("send while online");
    let narrative = expect_frame(&mut rx).await;
    assert_eq!(narrative["type"], "narrative");
    assert_eq!(narrative["text"], "hello");

    handle.close();
    expect_status(&mut rx, ConnStatus::Offline).await;
    assert!(rx.recv().await.is_none(), "actor ends after close");
    server.await.expect("server task");
}

#[tokio::test]
async fn fatal_bad_key_surfaces_and_stops_retrying() {
    let (endpoint, ticket) = bind_server().await;
    let server = tokio::spawn(async move {
        let mut conn = ServerConn::accept(&endpoint).await;
        let join = conn.read_frame().await;
        assert_eq!(join["type"], "join");
        conn.write_frame(&json!({
            "type": "error",
            "code": "bad_key",
            "message": "unknown key",
        }))
        .await;
        // Real server closes; waiting for the client's own close keeps the
        // error line flush deterministic.
        conn.conn.closed().await;
    });

    let (_handle, mut rx) = connect(params(&ticket));
    expect_status(&mut rx, ConnStatus::Connecting).await;
    let error = expect_frame(&mut rx).await;
    assert_eq!(error["type"], "error");
    assert_eq!(error["code"], "bad_key");
    let (_, reason) = expect_status(&mut rx, ConnStatus::Offline).await;
    assert!(reason.unwrap_or_default().contains("bad_key"));
    assert!(rx.recv().await.is_none(), "no redial after a fatal error");
    server.await.expect("server task");
}

/// The transport does not judge the wire version — it forwards the banner and
/// lets `store/connection.ts` decide. This test is the regression guard for the
/// bug where a hardcoded `1.x` check in Rust refused every real engine (which
/// announces 2.1) before the frontend ever saw the frame.
#[tokio::test]
async fn welcome_of_any_protocol_version_is_forwarded_verbatim() {
    for announced in ["1.6", "2.1", "3.0", "99.99", ""] {
        let (endpoint, ticket) = bind_server().await;
        let expected = welcome_frame(announced);
        let sent = expected.clone();
        let server = tokio::spawn(async move {
            let mut conn = ServerConn::accept(&endpoint).await;
            let _join = conn.read_frame().await;
            conn.write_frame(&sent).await;
            // Proves the connection is still usable after the welcome: a
            // refusing transport would have closed it here. The echo keeps the
            // close deterministic — the client waits for it before hanging up.
            let input = conn.read_frame().await;
            assert_eq!(input["text"], "still open");
            conn.write_frame(&json!({"type": "ack"})).await;
            conn.conn.closed().await;
        });

        let (handle, mut rx) = connect(params(&ticket));
        expect_status(&mut rx, ConnStatus::Connecting).await;
        let welcome = expect_frame(&mut rx).await;
        assert_eq!(
            welcome, expected,
            "welcome {announced:?} must arrive verbatim"
        );
        expect_status(&mut rx, ConnStatus::Online).await;

        handle
            .send_frame(json!({"type": "input", "text": "still open"}))
            .await
            .expect("send while online");
        assert_eq!(expect_frame(&mut rx).await["type"], "ack");

        handle.close();
        expect_status(&mut rx, ConnStatus::Offline).await;
        server.await.expect("server task");
    }
}

#[tokio::test]
async fn reconnects_with_rejoin_after_connection_loss() {
    let (endpoint, ticket) = bind_server().await;
    let server = tokio::spawn(async move {
        // First session: welcome, read one input (proves the client settled),
        // then drop the connection to simulate a server restart.
        let mut first = ServerConn::accept(&endpoint).await;
        let join = first.read_frame().await;
        assert_eq!(join["type"], "join");
        first.write_frame(&welcome_frame("1.6")).await;
        let input = first.read_frame().await;
        assert_eq!(input["text"], "before drop");
        first.conn.close(0u32.into(), b"server restart");

        // Second session: the client must re-send a full join.
        let mut second = ServerConn::accept(&endpoint).await;
        let rejoin = second.read_frame().await;
        assert_eq!(rejoin["type"], "join");
        assert_eq!(rejoin["key"], "k-test");
        second.write_frame(&welcome_frame("1.6")).await;
        second.conn.closed().await;
    });

    let (handle, mut rx) = connect(params(&ticket));
    expect_status(&mut rx, ConnStatus::Connecting).await;
    let first_welcome = expect_frame(&mut rx).await;
    assert_eq!(first_welcome["type"], "welcome");
    expect_status(&mut rx, ConnStatus::Online).await;
    handle
        .send_frame(json!({"type": "input", "text": "before drop"}))
        .await
        .expect("send while online");

    let (attempt, _) = expect_status(&mut rx, ConnStatus::Reconnecting).await;
    assert_eq!(attempt, 1, "first redial after a settled session");
    let second_welcome = expect_frame(&mut rx).await;
    assert_eq!(second_welcome["type"], "welcome");
    expect_status(&mut rx, ConnStatus::Online).await;

    handle.close();
    expect_status(&mut rx, ConnStatus::Offline).await;
    assert!(rx.recv().await.is_none());
    server.await.expect("server task");
}

/// One media-channel GET helper for the fake server: read the request header
/// line off a fresh bidirectional stream, hand back the parsed frame.
async fn read_blob_request(recv: &mut RecvStream) -> Value {
    let mut decoder = LineDecoder::new();
    loop {
        let mut buf = vec![0u8; 64 * 1024];
        let n = recv
            .read(&mut buf)
            .await
            .expect("blob stream read")
            .expect("request header before EOF");
        let mut frames = decoder.push(&buf[..n]).expect("decode blob request");
        if let Some(frame) = frames.pop() {
            return frame;
        }
    }
}

#[tokio::test]
async fn fetch_blob_roundtrip_and_error_reply() {
    let (endpoint, ticket) = bind_server().await;
    let body: &[u8] = b"panel entry bytes";
    let server = tokio::spawn(async move {
        let mut conn = ServerConn::accept(&endpoint).await;
        let join = conn.read_frame().await;
        assert_eq!(join["type"], "join");
        conn.write_frame(&welcome_frame("1.8")).await;

        // First GET: header + body split across two writes.
        let (mut bsend, mut brecv) = conn.conn.accept_bi().await.expect("blob stream");
        let request = read_blob_request(&mut brecv).await;
        assert_eq!(request["op"], "get");
        assert_eq!(request["hash"], "cafe01");
        bsend
            .write_all(&encode_line(&json!({
                "op": "get",
                "hash": "cafe01",
                "size": body.len(),
                "mime": "text/html",
                "name": "index.html",
            })))
            .await
            .expect("blob header write");
        bsend
            .write_all(&body[..7])
            .await
            .expect("blob body write 1");
        bsend
            .write_all(&body[7..])
            .await
            .expect("blob body write 2");
        let _ = bsend.finish();

        // Second GET: an error line with no body.
        let (mut esend, mut erecv) = conn.conn.accept_bi().await.expect("blob stream 2");
        let request = read_blob_request(&mut erecv).await;
        assert_eq!(request["hash"], "unknown");
        esend
            .write_all(&encode_line(&json!({
                "type": "error",
                "code": "media_not_found",
                "message": "no such blob",
            })))
            .await
            .expect("error header write");
        let _ = esend.finish();

        conn.conn.closed().await;
    });

    let (handle, mut rx) = connect(params(&ticket));
    expect_status(&mut rx, ConnStatus::Connecting).await;
    assert_eq!(expect_frame(&mut rx).await["type"], "welcome");
    expect_status(&mut rx, ConnStatus::Online).await;

    let blob = tokio::time::timeout(STEP, handle.fetch_blob("cafe01".to_owned()))
        .await
        .expect("fetch inside the deadline")
        .expect("blob fetch succeeds");
    assert_eq!(blob.bytes, body);
    assert_eq!(blob.mime, "text/html");
    assert_eq!(blob.name, "index.html");

    let err = tokio::time::timeout(STEP, handle.fetch_blob("unknown".to_owned()))
        .await
        .expect("fetch inside the deadline")
        .expect_err("a server error line fails the fetch");
    assert!(err.contains("media_not_found"), "unexpected error: {err}");

    handle.close();
    expect_status(&mut rx, ConnStatus::Offline).await;
    server.await.expect("server task");
}

#[tokio::test]
async fn put_blob_roundtrip_and_error_reply() {
    let (endpoint, ticket) = bind_server().await;
    // Big enough to cross the 64 KiB chunk boundary the protocol fixes, so a
    // single-write implementation would not pass.
    let body: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    let expected = body.clone();
    let server = tokio::spawn(async move {
        let mut conn = ServerConn::accept(&endpoint).await;
        let join = conn.read_frame().await;
        assert_eq!(join["type"], "join");
        conn.write_frame(&welcome_frame("2.1")).await;

        // First PUT: header line, then the body until the client finishes.
        let (mut psend, mut precv) = conn.conn.accept_bi().await.expect("put stream");
        let mut decoder = LineDecoder::new();
        let mut header = None;
        let mut received: Vec<u8> = Vec::new();
        let mut buf = vec![0u8; 64 * 1024];
        while let Ok(Some(n)) = precv.read(&mut buf).await {
            if header.is_none() {
                received.extend_from_slice(&buf[..n]);
                if let Some(at) = received.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = received.drain(..=at).collect();
                    header = Some(
                        decoder
                            .push(&line)
                            .expect("decode put header")
                            .pop()
                            .expect("one header"),
                    );
                }
                continue;
            }
            received.extend_from_slice(&buf[..n]);
        }
        let header = header.expect("a put header arrived");
        assert_eq!(header["op"], "put");
        assert_eq!(header["upload_id"], "u-1");
        assert_eq!(received.len(), expected.len(), "the whole body arrived");
        assert_eq!(received, expected, "the body arrived unmangled");
        psend
            .write_all(&encode_line(&json!({"op": "put_ok", "hash": "cafe01"})))
            .await
            .expect("put_ok write");
        let _ = psend.finish();

        // Second PUT: a rejection line.
        let (mut esend, mut erecv) = conn.conn.accept_bi().await.expect("put stream 2");
        let mut sink = vec![0u8; 64 * 1024];
        while let Ok(Some(_)) = erecv.read(&mut sink).await {}
        esend
            .write_all(&encode_line(&json!({
                "type": "error",
                "code": "media_too_large",
                "message": "over the per-file cap",
            })))
            .await
            .expect("error write");
        let _ = esend.finish();

        conn.conn.closed().await;
    });

    let (handle, mut rx) = connect(params(&ticket));
    expect_status(&mut rx, ConnStatus::Connecting).await;
    assert_eq!(expect_frame(&mut rx).await["type"], "welcome");
    expect_status(&mut rx, ConnStatus::Online).await;

    let hash = tokio::time::timeout(STEP, handle.put_blob("u-1".to_owned(), body))
        .await
        .expect("upload inside the deadline")
        .expect("upload succeeds");
    // The SERVER's hash is the answer — it is what every later broadcast names.
    assert_eq!(hash, "cafe01");

    let err = tokio::time::timeout(STEP, handle.put_blob("u-2".to_owned(), vec![1, 2, 3]))
        .await
        .expect("upload inside the deadline")
        .expect_err("a server error line fails the upload");
    assert!(err.contains("media_too_large"), "unexpected error: {err}");

    handle.close();
    expect_status(&mut rx, ConnStatus::Offline).await;
    server.await.expect("server task");
}

/// A write that the control stream accepted is `Ok`. Enqueue-and-return-Ok
/// was the old bug: the handle resolved before the actor touched the stream.
#[tokio::test]
async fn send_while_online_returns_ok_after_write() {
    let (endpoint, ticket) = bind_server().await;
    let server = tokio::spawn(async move {
        let mut conn = ServerConn::accept(&endpoint).await;
        let _join = conn.read_frame().await;
        conn.write_frame(&welcome_frame("1.6")).await;
        let input = conn.read_frame().await;
        assert_eq!(input, json!({"type": "input", "text": "delivered"}));
        conn.conn.closed().await;
    });

    let (handle, mut rx) = connect(params(&ticket));
    expect_status(&mut rx, ConnStatus::Connecting).await;
    assert_eq!(expect_frame(&mut rx).await["type"], "welcome");
    expect_status(&mut rx, ConnStatus::Online).await;

    handle
        .send_frame(json!({"type": "input", "text": "delivered"}))
        .await
        .expect("online write is Ok only after the stream accepts it");

    handle.close();
    expect_status(&mut rx, ConnStatus::Offline).await;
    server.await.expect("server task");
}

/// After a settled session drops, the actor sleeps the backoff window
/// (`Reconnecting` is emitted only when that sleep ends) and used to
/// `continue` on `Command::Send` — the handle had already returned `Ok`,
/// so the typed line vanished. The verdict must be `Err` here.
#[tokio::test]
async fn send_during_reconnect_backoff_returns_err() {
    let (endpoint, ticket) = bind_server().await;
    let (drop_tx, drop_rx) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        let mut first = ServerConn::accept(&endpoint).await;
        let _join = first.read_frame().await;
        first.write_frame(&welcome_frame("1.6")).await;
        drop_rx.await.expect("client asks the server to drop");
        first.conn.close(0u32.into(), b"drop");
        // Hold the endpoint; do not accept a redial (that would end backoff).
        tokio::time::sleep(STEP).await;
        drop(endpoint);
    });

    let (handle, mut rx, mut backoff) = connect_with_backoff_pulse(params(&ticket));
    expect_status(&mut rx, ConnStatus::Connecting).await;
    assert_eq!(expect_frame(&mut rx).await["type"], "welcome");
    expect_status(&mut rx, ConnStatus::Online).await;

    drop_tx.send(()).expect("signal the drop");
    tokio::time::timeout(STEP, backoff.recv())
        .await
        .expect("actor observed the loss")
        .expect("backoff pulse channel open");
    let err = handle
        .send_frame(json!({"type": "input", "text": "lost if this is Ok"}))
        .await
        .expect_err("backoff must not report a successful send");
    assert!(
        err.contains("offline") || err.contains("closed") || err.contains("send failed"),
        "unexpected send error: {err}"
    );

    handle.close();
    expect_status(&mut rx, ConnStatus::Offline).await;
    server.abort();
}

/// Close (and actor drop) must settle a waiter rather than leave the
/// `transport_send` Promise pending forever.
#[tokio::test]
async fn close_settles_a_pending_send() {
    let (endpoint, ticket) = bind_server().await;
    let (drop_tx, drop_rx) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        let mut first = ServerConn::accept(&endpoint).await;
        let _join = first.read_frame().await;
        first.write_frame(&welcome_frame("1.6")).await;
        drop_rx.await.expect("client asks the server to drop");
        first.conn.close(0u32.into(), b"drop");
        tokio::time::sleep(STEP).await;
        drop(endpoint);
    });

    let (handle, mut rx, mut backoff) = connect_with_backoff_pulse(params(&ticket));
    expect_status(&mut rx, ConnStatus::Connecting).await;
    assert_eq!(expect_frame(&mut rx).await["type"], "welcome");
    expect_status(&mut rx, ConnStatus::Online).await;
    drop_tx.send(()).expect("signal the drop");
    tokio::time::timeout(STEP, backoff.recv())
        .await
        .expect("actor observed the loss")
        .expect("backoff pulse channel open");

    let pending = {
        let handle = handle.clone();
        tokio::spawn(async move {
            handle
                .send_frame(json!({"type": "input", "text": "late"}))
                .await
        })
    };
    handle.close();
    let result = tokio::time::timeout(STEP, pending)
        .await
        .expect("close settles the waiter")
        .expect("send task");
    assert!(
        result.is_err(),
        "close must fail the pending send, got {result:?}"
    );
    expect_status(&mut rx, ConnStatus::Offline).await;
    server.abort();
}

/// Per-attempt bounds short enough for a test to watch them fire.
const FAST: Timeouts = Timeouts {
    dial: Duration::from_millis(300),
    join: Duration::from_millis(300),
};

/// The `offline` that ends a connection, with the code the UI words itself by.
async fn expect_offline_with_code(
    rx: &mut UnboundedReceiver<TransportEvent>,
) -> (Option<String>, Option<ErrorCode>) {
    match next_event(rx).await {
        TransportEvent::Status {
            status: ConnStatus::Offline,
            error,
            error_code,
            ..
        } => (error, error_code),
        other => panic!("expected offline, got {other:?}"),
    }
}

/// A host that is reachable on the wire but never answers the handshake: the
/// endpoint is bound (so the address in the ticket is live) and never
/// accepts. This is what a stale ticket looks like to the dialer — packets go
/// out, nothing comes back, and iroh alone keeps trying.
async fn bind_silent_host() -> (Endpoint, String) {
    bind_server().await
}

#[tokio::test]
async fn a_dial_that_gets_no_answer_times_out_with_a_code_and_does_not_redial() {
    let (_silent, ticket) = bind_silent_host().await;

    let (_handle, mut rx, _pulse) = connect_with_timeouts(params(&ticket), FAST);
    expect_status(&mut rx, ConnStatus::Connecting).await;
    let (error, code) = expect_offline_with_code(&mut rx).await;
    assert_eq!(code, Some(ErrorCode::ConnectTimeout));
    assert!(
        error
            .as_deref()
            .unwrap_or_default()
            .contains("connect timeout"),
        "unexpected detail: {error:?}"
    );
    assert!(
        rx.recv().await.is_none(),
        "a connection that was never welcomed must not enter the redial loop"
    );
}

#[tokio::test]
async fn a_host_that_never_welcomes_times_out_the_join_with_its_own_code() {
    let (endpoint, ticket) = bind_server().await;
    let server = tokio::spawn(async move {
        let mut conn = ServerConn::accept(&endpoint).await;
        let join = conn.read_frame().await;
        assert_eq!(join["type"], "join");
        // Connected and joined, then silence.
        conn.conn.closed().await;
    });

    let (_handle, mut rx, _pulse) = connect_with_timeouts(params(&ticket), FAST);
    expect_status(&mut rx, ConnStatus::Connecting).await;
    let (error, code) = expect_offline_with_code(&mut rx).await;
    assert_eq!(code, Some(ErrorCode::JoinTimeout));
    assert!(error.unwrap_or_default().contains("join timeout"));
    assert!(
        rx.recv().await.is_none(),
        "no redial after a first-attempt failure"
    );
    server.await.expect("server task");
}

#[tokio::test]
async fn a_host_that_hangs_up_before_welcoming_ends_the_first_attempt() {
    let (endpoint, ticket) = bind_server().await;
    let server = tokio::spawn(async move {
        let mut conn = ServerConn::accept(&endpoint).await;
        let _join = conn.read_frame().await;
        conn.conn.close(0u32.into(), b"go away");
        // Closing the endpoint is what flushes the CLOSE out; dropping it
        // straight away can swallow the frame and leave the client waiting.
        endpoint.close().await;
    });

    let (_handle, mut rx) = connect(params(&ticket));
    expect_status(&mut rx, ConnStatus::Connecting).await;
    let (_, code) = expect_offline_with_code(&mut rx).await;
    assert_eq!(code, Some(ErrorCode::ConnectFailed));
    assert!(rx.recv().await.is_none());
    server.await.expect("server task");
}

/// The hang this guards: a close that arrives while `endpoint.connect` is
/// still pending used to sit in the command queue until the dial returned —
/// which, for a stale ticket, is minutes. The replacement dial closes the
/// incumbent exactly this way, so a close the actor cannot hear is a connect
/// button that does nothing.
#[tokio::test]
async fn close_abandons_a_dial_in_flight_and_other_commands_fail_fast() {
    let (_silent, ticket) = bind_silent_host().await;
    // The real bounds: only the close can end this within the test.
    let (handle, mut rx, _pulse) = connect_with_timeouts(params(&ticket), Timeouts::default());
    expect_status(&mut rx, ConnStatus::Connecting).await;

    // Mid-dial there is no stream to send on: refuse, do not queue.
    let verdict = tokio::time::timeout(
        Duration::from_secs(5),
        handle.send_frame(json!({"type": "input", "text": "too early"})),
    )
    .await
    .expect("a send during a dial settles instead of waiting for it");
    assert!(
        verdict.is_err(),
        "send during a dial must be Err, got {verdict:?}"
    );
    let fetched =
        tokio::time::timeout(Duration::from_secs(5), handle.fetch_blob("cafe".to_owned()))
            .await
            .expect("a fetch during a dial settles too");
    assert!(fetched.is_err());

    let started = std::time::Instant::now();
    handle.close();
    let (error, code) = expect_offline_with_code(&mut rx).await;
    assert_eq!((error, code), (None, None), "a close is not a failure");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "close took {:?}: it waited out the dial",
        started.elapsed()
    );
    assert!(rx.recv().await.is_none(), "the actor ends after a close");
}

/// A replacement dial (the bridge closes the incumbent and starts a new
/// actor) must not be held up by the one it replaces, and the replaced one
/// must really end.
#[tokio::test]
async fn a_new_dial_while_one_is_stuck_connects_and_the_stuck_one_ends() {
    let (_silent, stale_ticket) = bind_silent_host().await;
    let (endpoint, live_ticket) = bind_server().await;
    let server = tokio::spawn(async move {
        let mut conn = ServerConn::accept(&endpoint).await;
        let _join = conn.read_frame().await;
        conn.write_frame(&welcome_frame("1.6")).await;
        conn.conn.closed().await;
    });

    let (stuck, mut stuck_rx, _pulse) =
        connect_with_timeouts(params(&stale_ticket), Timeouts::default());
    expect_status(&mut stuck_rx, ConnStatus::Connecting).await;

    // What `transport_connect` does: close the occupant, seat a new actor.
    stuck.close();
    let (fresh, mut fresh_rx) = connect(params(&live_ticket));
    expect_status(&mut fresh_rx, ConnStatus::Connecting).await;
    assert_eq!(expect_frame(&mut fresh_rx).await["type"], "welcome");
    expect_status(&mut fresh_rx, ConnStatus::Online).await;

    expect_offline_with_code(&mut stuck_rx).await;
    assert!(
        stuck_rx.recv().await.is_none(),
        "the replaced actor is gone"
    );

    fresh.close();
    expect_status(&mut fresh_rx, ConnStatus::Offline).await;
    server.await.expect("server task");
}

/// After a session that WAS good, a dial that gets no answer is not fatal: the
/// redial loop keeps going under the same dial bound, with the attempt count
/// rising, and a close still ends it.
#[tokio::test]
async fn redial_after_a_good_session_is_bounded_and_keeps_going() {
    let (endpoint, ticket) = bind_server().await;
    let (drop_tx, drop_rx) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        let mut first = ServerConn::accept(&endpoint).await;
        let _join = first.read_frame().await;
        first.write_frame(&welcome_frame("1.6")).await;
        drop_rx.await.expect("client asks the server to drop");
        first.conn.close(0u32.into(), b"restart");
        // Hold the endpoint and never accept: every redial dials a host that
        // does not answer.
        tokio::time::sleep(STEP).await;
        drop(endpoint);
    });

    let (handle, mut rx, mut pulse) = connect_with_timeouts(params(&ticket), FAST);
    expect_status(&mut rx, ConnStatus::Connecting).await;
    assert_eq!(expect_frame(&mut rx).await["type"], "welcome");
    expect_status(&mut rx, ConnStatus::Online).await;

    drop_tx.send(()).expect("signal the drop");
    tokio::time::timeout(STEP, pulse.recv())
        .await
        .expect("actor observed the loss")
        .expect("pulse open");

    let (first_attempt, _) = expect_status(&mut rx, ConnStatus::Reconnecting).await;
    assert_eq!(first_attempt, 1);
    // The first redial must give up on its own (dial bound), back off, and
    // try again as attempt 2 — not hang on attempt 1 and not go offline.
    let (second_attempt, _) = expect_status(&mut rx, ConnStatus::Reconnecting).await;
    assert_eq!(second_attempt, 2);

    handle.close();
    expect_status(&mut rx, ConnStatus::Offline).await;
    server.abort();
}
