//! Offline loopback integration tests: a real iroh endpoint pair over
//! localhost UDP with relays and address lookup disabled — no external
//! network, deterministic sequencing via explicit acks.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use iroh::endpoint::{presets, Connection, RecvStream, RelayMode, SendStream};
use iroh::{Endpoint, EndpointAddr};
use iroh_tickets::endpoint::EndpointTicket;
use loreweaver_transport::client::{
    connect, ConnStatus, ConnectParams, NetworkProfile, TransportEvent,
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
