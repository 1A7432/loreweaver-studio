//! Offline loopback integration tests: a real iroh endpoint pair over
//! localhost UDP with relays and address lookup disabled — no external
//! network. The fake server speaks protocol 3.0's TRANSPORT: ALPN
//! `loreweaver/3`, newline-delimited JSON on the first bidirectional stream,
//! and the byte channel (§11) on every further one. It expects the client's
//! first line to come from the CALLER: the link writes nothing of its own.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use iroh::endpoint::{presets, Connection, RecvStream, RelayMode, SendStream};
use iroh::{Endpoint, EndpointAddr};
use iroh_tickets::endpoint::EndpointTicket;
use loreweaver_transport::bytes::{ByteError, ByteFile, MAX_BYTE_STREAMS};
use loreweaver_transport::codec::{encode_line, LineDecoder, MAX_LINE_BYTES};
use loreweaver_transport::link::{
    connect, connect_with, CloseCode, LinkEvent, LinkHandle, LinkParams, LinkStatus,
    NetworkProfile, Timeouts,
};
use loreweaver_transport::MAX_BLOB_BYTES;
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::sync::oneshot;

const ALPN: &[u8] = b"loreweaver/3";
const STEP: Duration = Duration::from_secs(20);
const HASH: &str = "3f9a0c7d2b1e4f5a6c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const OTHER: &str = "0000000000000000000000000000000000000000000000000000000000000001";

fn params(ticket: &str) -> LinkParams {
    LinkParams {
        ticket: ticket.to_owned(),
        network: NetworkProfile::Local,
    }
}

fn hello() -> Value {
    json!({
        "type": "hello",
        "protocol": "3.0",
        "key": "k-test",
        "locale": "en",
        "client": {"name": "loreweaver-studio-test", "version": "0.0.0"},
        "caps": [],
    })
}

fn welcome() -> Value {
    json!({
        "type": "welcome",
        "protocol": "3.0",
        "server": {"name": "loreweaver", "version": "3.0.0-test"},
        "room": {"id": "main", "locale": "en"},
        "you": {"id": "m:000000000001", "name": "Nyx", "role": "player"},
        "features": [],
        "epoch": 1,
        "head": 0,
        "first": 0,
    })
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

/// The server's side of one connection: the control stream, read line by line.
struct ServerConn {
    conn: Connection,
    send: SendStream,
    recv: RecvStream,
    pending: Vec<u8>,
}

impl ServerConn {
    /// Accept one connection and its control stream (which the server only
    /// sees once the client has written on it).
    async fn accept(endpoint: &Endpoint) -> Self {
        let incoming = endpoint.accept().await.expect("incoming connection");
        let conn = incoming.await.expect("connection establishes");
        let (send, recv) = conn.accept_bi().await.expect("control stream accepted");
        Self {
            conn,
            send,
            recv,
            pending: Vec::new(),
        }
    }

    /// The next line exactly as it crossed the wire, newline excluded.
    async fn read_raw_line(&mut self) -> Vec<u8> {
        loop {
            if let Some(at) = self.pending.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = self.pending.drain(..=at).collect();
                return line[..line.len() - 1].to_vec();
            }
            let mut buf = vec![0u8; 64 * 1024];
            let n = self
                .recv
                .read(&mut buf)
                .await
                .expect("server read")
                .expect("client kept the stream open");
            self.pending.extend_from_slice(&buf[..n]);
        }
    }

    async fn read_frame(&mut self) -> Value {
        serde_json::from_slice(&self.read_raw_line().await).expect("a JSON line")
    }

    async fn write_raw(&mut self, bytes: &[u8]) {
        self.send.write_all(bytes).await.expect("server write");
    }

    async fn write_frame(&mut self, frame: &Value) {
        self.write_raw(&encode_line(frame)).await;
    }
}

/// Accept a connection and read the caller's first line: the `hello`.
async fn accept_with_hello(endpoint: &Endpoint) -> ServerConn {
    let mut conn = ServerConn::accept(endpoint).await;
    assert_eq!(
        conn.read_frame().await,
        hello(),
        "the first line is the caller's"
    );
    conn
}

async fn next_event(rx: &mut UnboundedReceiver<LinkEvent>) -> LinkEvent {
    tokio::time::timeout(STEP, rx.recv())
        .await
        .expect("an event before the timeout")
        .expect("event channel open")
}

async fn expect_status(
    rx: &mut UnboundedReceiver<LinkEvent>,
    expected: LinkStatus,
) -> (Option<CloseCode>, Option<String>) {
    match next_event(rx).await {
        LinkEvent::Status {
            status,
            code,
            reason,
        } => {
            assert_eq!(status, expected, "unexpected status ({code:?}: {reason:?})");
            (code, reason)
        }
        LinkEvent::Frame { frame } => panic!("expected status {expected:?}, got frame {frame}"),
    }
}

async fn expect_frame(rx: &mut UnboundedReceiver<LinkEvent>) -> Value {
    match next_event(rx).await {
        LinkEvent::Frame { frame } => frame,
        LinkEvent::Status {
            status,
            code,
            reason,
        } => panic!("expected a frame, got {status:?} ({code:?}: {reason:?})"),
    }
}

/// The receiver ends: the actor is gone and dials nothing more.
async fn expect_end(rx: &mut UnboundedReceiver<LinkEvent>) {
    let next = tokio::time::timeout(STEP, rx.recv())
        .await
        .expect("the actor ends");
    assert!(next.is_none(), "nothing after closed, got {next:?}");
}

/// Dial `ticket`, wait for `up`, and send the caller's hello.
async fn up(ticket: &str) -> (LinkHandle, UnboundedReceiver<LinkEvent>) {
    up_with(ticket, Timeouts::default()).await
}

async fn up_with(ticket: &str, timeouts: Timeouts) -> (LinkHandle, UnboundedReceiver<LinkEvent>) {
    let (handle, mut rx) = connect_with(params(ticket), timeouts);
    expect_status(&mut rx, LinkStatus::Connecting).await;
    expect_status(&mut rx, LinkStatus::Up).await;
    handle.send_frame(hello()).await.expect("hello is written");
    (handle, rx)
}

async fn close(handle: &LinkHandle, rx: &mut UnboundedReceiver<LinkEvent>) {
    handle.close();
    let (code, reason) = expect_status(rx, LinkStatus::Closed).await;
    assert_eq!(
        (code, reason),
        (None, None),
        "a close asked for is not a failure"
    );
    expect_end(rx).await;
}

// --- the control stream ------------------------------------------------------------------

#[tokio::test]
async fn the_link_writes_nothing_of_its_own_and_carries_lines_both_ways() {
    let (endpoint, ticket) = bind_server().await;
    let (done_tx, done_rx) = oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        let mut conn = ServerConn::accept(&endpoint).await;
        // Byte for byte what the caller sent: no `join`, no frame of the link's own.
        assert_eq!(
            conn.read_raw_line().await,
            serde_json::to_vec(&hello()).expect("json")
        );
        conn.write_frame(&welcome()).await;
        // A 3.0 server never pings; a link that answered one would put a
        // `pong` on the wire before the caller's next line.
        conn.write_frame(&json!({"type": "ping", "t": 1})).await;
        conn.write_frame(
            &json!({"type": "error", "code": "bad_frame", "message": "m", "fatal": true}),
        )
        .await;
        let next = conn.read_frame().await;
        assert_eq!(next, json!({"type": "input", "rid": "r1", "text": "hi"}));
        conn.write_frame(&json!({"type": "result", "rid": "r1", "ok": true}))
            .await;
        done_rx.await.expect("the test finishes first");
        conn.conn.closed().await;
    });

    let (handle, mut rx) = up(&ticket).await;
    assert_eq!(
        expect_frame(&mut rx).await,
        welcome(),
        "welcome passes through untouched"
    );
    assert_eq!(expect_frame(&mut rx).await, json!({"type": "ping", "t": 1}));
    // Even a fatal error frame is the session's to judge: the link stays up.
    assert_eq!(expect_frame(&mut rx).await["code"], "bad_frame");
    handle
        .send_frame(json!({"type": "input", "rid": "r1", "text": "hi"}))
        .await
        .expect("still up after an error frame");
    assert_eq!(expect_frame(&mut rx).await["type"], "result");
    done_tx.send(()).expect("server waiting");
    close(&handle, &mut rx).await;
    server.await.expect("server task");
}

#[tokio::test]
async fn torn_lines_blank_lines_and_garbage_are_framed_like_the_protocol_says() {
    let (endpoint, ticket) = bind_server().await;
    let server = tokio::spawn(async move {
        let mut conn = accept_with_hello(&endpoint).await;
        conn.write_raw(b"{\"type\":\"a\",").await;
        conn.write_raw(b"\"n\":1}\n\n\r\nnot json\n[1,2]\n42\n{\"ty")
            .await;
        conn.write_raw(b"pe\":\"b\"}\r\n{\"type\":\"c\"}\n").await;
        conn.conn.closed().await;
    });

    let (handle, mut rx) = up(&ticket).await;
    assert_eq!(expect_frame(&mut rx).await, json!({"type": "a", "n": 1}));
    assert_eq!(expect_frame(&mut rx).await, json!({"type": "b"}));
    assert_eq!(expect_frame(&mut rx).await, json!({"type": "c"}));
    close(&handle, &mut rx).await;
    server.await.expect("server task");
}

#[tokio::test]
async fn a_line_far_over_the_old_1_mib_bound_still_arrives_whole() {
    let text = "x".repeat(3 * 1024 * 1024);
    let sent = json!({"type": "view", "name": "big", "rev": 1, "at": 0, "data": text});
    let expected = sent.clone();
    let (endpoint, ticket) = bind_server().await;
    let server = tokio::spawn(async move {
        let mut conn = accept_with_hello(&endpoint).await;
        conn.write_frame(&sent).await;
        conn.conn.closed().await;
    });

    let (handle, mut rx) = up(&ticket).await;
    assert_eq!(expect_frame(&mut rx).await, expected);
    close(&handle, &mut rx).await;
    server.await.expect("server task");
}

#[tokio::test]
async fn a_line_over_the_cap_tears_the_link_as_a_protocol_violation() {
    let (endpoint, ticket) = bind_server().await;
    let server = tokio::spawn(async move {
        let mut conn = accept_with_hello(&endpoint).await;
        conn.write_frame(&json!({"type": "before"})).await;
        // No newline in sight, and more than a line may hold.
        let flood = vec![b'x'; MAX_LINE_BYTES + 1];
        let _ = conn.send.write_all(&flood).await;
        conn.conn.closed().await;
    });

    let (_handle, mut rx) = up(&ticket).await;
    assert_eq!(expect_frame(&mut rx).await["type"], "before");
    let (code, reason) = expect_status(&mut rx, LinkStatus::Closed).await;
    assert_eq!(code, Some(CloseCode::ProtocolViolation));
    assert!(reason.unwrap_or_default().contains("exceeds"));
    expect_end(&mut rx).await;
    server.await.expect("server task");
}

#[tokio::test]
async fn the_server_closing_ends_the_link_and_nothing_is_redialled() {
    let (endpoint, ticket) = bind_server().await;
    let (redial_tx, redial_rx) = oneshot::channel::<bool>();
    let server = tokio::spawn(async move {
        let mut conn = accept_with_hello(&endpoint).await;
        conn.write_frame(
            &json!({"type": "error", "code": "bad_key", "message": "unknown key", "fatal": true}),
        )
        .await;
        // A QUIC close discards what is still unsent: hang up once the client
        // has shown it read the line.
        assert_eq!(conn.read_frame().await["type"], "read-it");
        conn.conn.close(0u32.into(), b"bad key");
        // A link that redialled on its own would knock again.
        let again = tokio::time::timeout(Duration::from_millis(1500), endpoint.accept()).await;
        let _ = redial_tx.send(again.is_ok());
    });

    let (handle, mut rx) = up(&ticket).await;
    assert_eq!(expect_frame(&mut rx).await["code"], "bad_key");
    handle
        .send_frame(json!({"type": "read-it"}))
        .await
        .expect("still up");
    let (code, _) = expect_status(&mut rx, LinkStatus::Closed).await;
    assert_eq!(code, Some(CloseCode::ClosedByPeer));
    expect_end(&mut rx).await;
    assert!(
        !redial_rx.await.expect("server reports"),
        "the link dialled again by itself"
    );
    server.await.expect("server task");
}

#[tokio::test]
async fn a_finished_control_stream_is_closed_by_peer_too() {
    let (endpoint, ticket) = bind_server().await;
    let server = tokio::spawn(async move {
        let mut conn = accept_with_hello(&endpoint).await;
        conn.send.finish().expect("finish");
        conn.conn.closed().await;
    });

    let (_handle, mut rx) = up(&ticket).await;
    let (code, _) = expect_status(&mut rx, LinkStatus::Closed).await;
    assert_eq!(code, Some(CloseCode::ClosedByPeer));
    expect_end(&mut rx).await;
    server.await.expect("server task");
}

#[tokio::test]
async fn send_is_a_delivery_verdict_and_fails_once_the_link_is_gone() {
    let (endpoint, ticket) = bind_server().await;
    let (read_tx, read_rx) = oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        let mut conn = accept_with_hello(&endpoint).await;
        assert_eq!(conn.read_frame().await, json!({"type": "ping", "t": 7}));
        read_tx.send(()).expect("test waits for the read");
        conn.conn.closed().await;
    });

    let (handle, mut rx) = up(&ticket).await;
    handle
        .send_frame(json!({"type": "ping", "t": 7}))
        .await
        .expect("Ok once the stream accepted it");
    // Accepted is not yet delivered: close only once the host has read it.
    tokio::time::timeout(STEP, read_rx)
        .await
        .expect("the host reads it")
        .expect("server alive");
    close(&handle, &mut rx).await;
    assert!(handle
        .send_frame(json!({"type": "ping", "t": 8}))
        .await
        .is_err());
    assert_eq!(
        handle.fetch(HASH.to_owned()).await.expect_err("gone"),
        ByteError::NotConnected
    );
    server.await.expect("server task");
}

// --- dialling ------------------------------------------------------------------------------

/// Bounds short enough for a test to watch the dial bound fire. Only for an
/// attempt MEANT to time out.
const FAST_DIAL: Timeouts = Timeouts {
    dial: Duration::from_millis(300),
    stall: Duration::from_secs(30),
    byte_op: Duration::from_secs(600),
};

#[tokio::test]
async fn an_unparseable_ticket_closes_at_once_with_its_code() {
    let (_handle, mut rx) = connect(params("not a ticket"));
    let (code, reason) = expect_status(&mut rx, LinkStatus::Closed).await;
    assert_eq!(code, Some(CloseCode::InvalidTicket));
    assert!(reason.unwrap_or_default().contains("invalid ticket"));
    expect_end(&mut rx).await;
}

#[tokio::test]
async fn a_dial_that_gets_no_answer_times_out_with_its_code() {
    // Bound but never accepting: what a stale ticket looks like to the dialler.
    let (_silent, ticket) = bind_server().await;
    let (_handle, mut rx) = connect_with(params(&ticket), FAST_DIAL);
    expect_status(&mut rx, LinkStatus::Connecting).await;
    let (code, reason) = expect_status(&mut rx, LinkStatus::Closed).await;
    assert_eq!(code, Some(CloseCode::DialTimeout));
    assert!(reason.unwrap_or_default().contains("dial timeout"));
    expect_end(&mut rx).await;
}

#[tokio::test]
async fn a_server_of_another_alpn_fails_the_dial() {
    let endpoint = Endpoint::builder(presets::Minimal)
        .relay_mode(RelayMode::Disabled)
        .alpns(vec![b"loreweaver/tui/1".to_vec()])
        .bind()
        .await
        .expect("a 2.x-style server binds");
    let mut addr = EndpointAddr::new(endpoint.id());
    for sock in endpoint.bound_sockets() {
        addr = addr.with_ip_addr(SocketAddr::new(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            sock.port(),
        ));
    }
    let ticket = EndpointTicket::from(addr).to_string();
    let accepting = tokio::spawn(async move {
        if let Some(incoming) = endpoint.accept().await {
            let _ = incoming.await;
        }
        endpoint
    });

    let (_handle, mut rx) = connect(params(&ticket));
    expect_status(&mut rx, LinkStatus::Connecting).await;
    let (code, _) = expect_status(&mut rx, LinkStatus::Closed).await;
    assert_eq!(code, Some(CloseCode::DialFailed));
    expect_end(&mut rx).await;
    accepting.abort();
}

#[tokio::test]
async fn close_abandons_a_dial_in_flight_and_other_commands_fail_fast() {
    let (_silent, ticket) = bind_server().await;
    let (handle, mut rx) = connect(params(&ticket));
    expect_status(&mut rx, LinkStatus::Connecting).await;

    let verdict = tokio::time::timeout(Duration::from_secs(5), handle.send_frame(hello()))
        .await
        .expect("a send during a dial settles instead of waiting for it");
    assert!(verdict.is_err(), "no stream to write on yet: {verdict:?}");
    let fetched = tokio::time::timeout(Duration::from_secs(5), handle.fetch(HASH.to_owned()))
        .await
        .expect("a fetch during a dial settles too");
    assert_eq!(fetched.expect_err("not up"), ByteError::NotConnected);

    let started = std::time::Instant::now();
    close(&handle, &mut rx).await;
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "close took {:?}: it waited out the dial",
        started.elapsed()
    );
}

#[tokio::test]
async fn a_new_link_while_one_is_stuck_comes_up_and_the_stuck_one_ends() {
    let (_silent, stale_ticket) = bind_server().await;
    let (endpoint, live_ticket) = bind_server().await;
    let server = tokio::spawn(async move {
        let conn = accept_with_hello(&endpoint).await;
        conn.conn.closed().await;
    });

    let (stuck, mut stuck_rx) = connect(params(&stale_ticket));
    expect_status(&mut stuck_rx, LinkStatus::Connecting).await;
    // What `transport_connect` does: close the occupant, seat a new link.
    stuck.close();
    let (fresh, mut fresh_rx) = up(&live_ticket).await;
    let (code, _) = expect_status(&mut stuck_rx, LinkStatus::Closed).await;
    assert_eq!(code, None);
    expect_end(&mut stuck_rx).await;
    close(&fresh, &mut fresh_rx).await;
    server.await.expect("server task");
}

// --- the byte channel ----------------------------------------------------------------------

/// Accept one byte stream and read its request line.
async fn accept_request(conn: &Connection) -> (SendStream, RecvStream, Value) {
    let (send, mut recv) = conn.accept_bi().await.expect("a byte stream");
    let mut decoder = LineDecoder::new();
    loop {
        let mut buf = vec![0u8; 4096];
        let n = recv
            .read(&mut buf)
            .await
            .expect("byte stream read")
            .expect("a request before the end");
        if let Some(request) = decoder.push(&buf[..n]).expect("decode").pop() {
            return (send, recv, request);
        }
    }
}

fn get_ok(hash: &str, size: u64) -> Value {
    json!({"op": "get", "ok": true, "hash": hash, "size": size, "mime": "image/png", "name": "map.png"})
}

fn refusal(code: &str) -> Value {
    json!({"ok": false, "code": code, "message": "said in the member's language"})
}

#[tokio::test]
async fn a_fetch_names_its_own_ceiling_and_the_default_stays_the_blob_cap() {
    // A room save is the one file larger than `MAX_BLOB_BYTES`: its fetch names a ceiling of
    // its own (`fetch_within`). Over the named ceiling is refused from the header alone; the
    // default ceiling of `fetch` is still `MAX_BLOB_BYTES`.
    let (endpoint, ticket) = bind_server().await;
    let server = tokio::spawn(async move {
        let conn = accept_with_hello(&endpoint).await;
        let conn = conn.conn;
        // 1. Four bytes to a fetch that takes three: refused before the body.
        let (mut send, _recv, _) = accept_request(&conn).await;
        send.write_all(&encode_line(&get_ok(HASH, 4)))
            .await
            .unwrap();
        let _ = send.finish();
        // 2. The same four bytes to a fetch that takes four.
        let (mut send, _recv, _) = accept_request(&conn).await;
        send.write_all(&encode_line(&get_ok(HASH, 4)))
            .await
            .unwrap();
        send.write_all(b"room").await.unwrap();
        send.finish().unwrap();
        // 3. Over the blob cap, to a plain fetch.
        let (mut send, _recv, _) = accept_request(&conn).await;
        send.write_all(&encode_line(&get_ok(HASH, MAX_BLOB_BYTES + 1)))
            .await
            .unwrap();
        let _ = send.finish();
        conn.closed().await;
    });

    let (handle, mut rx) = up(&ticket).await;
    let err = handle
        .fetch_within(HASH.to_owned(), 3)
        .await
        .expect_err("over the named ceiling");
    assert_eq!(err.code(), "too_large", "{err}");
    let fetched = handle
        .fetch_within(HASH.to_owned(), 4)
        .await
        .expect("within the named ceiling");
    assert_eq!(fetched.bytes, b"room");
    let err = handle
        .fetch(HASH.to_owned())
        .await
        .expect_err("over the blob cap");
    assert_eq!(err.code(), "too_large", "{err}");
    close(&handle, &mut rx).await;
    server.await.expect("server task");
}

#[tokio::test]
async fn get_succeeds_and_each_bad_answer_has_its_own_failure() {
    let body: &[u8] = b"panel entry bytes";
    let (endpoint, ticket) = bind_server().await;
    let server = tokio::spawn(async move {
        let conn = accept_with_hello(&endpoint).await;
        let conn = conn.conn;

        // 1. The header, then the body split across writes.
        let (mut send, _recv, request) = accept_request(&conn).await;
        assert_eq!(request, json!({"op": "get", "hash": HASH}));
        send.write_all(&encode_line(&get_ok(HASH, body.len() as u64)))
            .await
            .unwrap();
        send.write_all(&body[..5]).await.unwrap();
        send.write_all(&body[5..]).await.unwrap();
        send.finish().unwrap();

        // 2. The server's refusal, word for word.
        let (mut send, _recv, _) = accept_request(&conn).await;
        send.write_all(&encode_line(&refusal("media_not_found")))
            .await
            .unwrap();
        send.finish().unwrap();

        // 3. A reply naming another file.
        let (mut send, _recv, _) = accept_request(&conn).await;
        send.write_all(&encode_line(&get_ok(OTHER, 1)))
            .await
            .unwrap();
        send.write_all(b"x").await.unwrap();
        send.finish().unwrap();

        // 4. More than this client accepts.
        let (mut send, _recv, _) = accept_request(&conn).await;
        send.write_all(&encode_line(&get_ok(HASH, MAX_BLOB_BYTES + 1)))
            .await
            .unwrap();
        let _ = send.finish();

        // 5. One byte more than promised.
        let (mut send, _recv, _) = accept_request(&conn).await;
        send.write_all(&encode_line(&get_ok(HASH, 3)))
            .await
            .unwrap();
        send.write_all(b"abcd").await.unwrap();
        send.finish().unwrap();

        // 6. Fewer bytes than promised, then the end.
        let (mut send, _recv, _) = accept_request(&conn).await;
        send.write_all(&encode_line(&get_ok(HASH, 10)))
            .await
            .unwrap();
        send.write_all(b"abc").await.unwrap();
        send.finish().unwrap();

        // 7. A header that never ends.
        let (mut send, _recv, _) = accept_request(&conn).await;
        let _ = send.write_all(&[b' '; 3000]).await;
        let _ = send.finish();

        // 8. The 2.x error shape is not a reply any more.
        let (mut send, _recv, _) = accept_request(&conn).await;
        send.write_all(&encode_line(
            &json!({"type": "error", "code": "media_not_found", "message": "m"}),
        ))
        .await
        .unwrap();
        send.finish().unwrap();

        conn.closed().await;
    });

    let (handle, mut rx) = up(&ticket).await;
    let fetched = handle.fetch(HASH.to_owned()).await.expect("GET succeeds");
    assert_eq!(fetched.bytes, body);
    assert_eq!(
        fetched.file,
        ByteFile {
            hash: HASH.to_owned(),
            size: body.len() as u64,
            mime: "image/png".to_owned(),
            name: "map.png".to_owned(),
        }
    );
    let refused = handle.fetch(HASH.to_owned()).await.expect_err("refused");
    assert_eq!(refused.code(), "media_not_found");
    assert_eq!(
        refused.to_string(),
        "media_not_found: said in the member's language"
    );
    for expected in [
        "bad_reply",
        "too_large",
        "too_much",
        "stream_ended",
        "bad_reply",
        "bad_reply",
    ] {
        let err = handle.fetch(HASH.to_owned()).await.expect_err(expected);
        assert_eq!(err.code(), expected, "{err}");
    }
    // A hash that is not one is refused before any stream opens.
    assert_eq!(
        handle
            .fetch("cafe".to_owned())
            .await
            .expect_err("not a hash"),
        ByteError::BadHash
    );
    close(&handle, &mut rx).await;
    server.await.expect("server task");
}

#[tokio::test]
async fn a_byte_stream_with_nothing_arriving_stalls() {
    let (endpoint, ticket) = bind_server().await;
    let (done_tx, done_rx) = oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        let conn = accept_with_hello(&endpoint).await;
        // Read the request, answer nothing, hold the stream open.
        let (_send, _recv, _) = accept_request(&conn.conn).await;
        done_rx.await.expect("the test finishes first");
    });

    let stall = Timeouts {
        dial: Duration::from_secs(15),
        stall: Duration::from_millis(300),
        byte_op: Duration::from_secs(600),
    };
    let (handle, mut rx) = up_with(&ticket, stall).await;
    let err = handle.fetch(HASH.to_owned()).await.expect_err("stalled");
    assert_eq!(err, ByteError::Stalled);
    done_tx.send(()).expect("server waiting");
    close(&handle, &mut rx).await;
    server.await.expect("server task");
}

#[tokio::test]
async fn put_sends_every_byte_then_finishes_and_reads_the_receipt() {
    // Big enough to cross the 64 KiB chunk boundary.
    let body: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    let expected = body.clone();
    let (endpoint, ticket) = bind_server().await;
    let server = tokio::spawn(async move {
        let conn = accept_with_hello(&endpoint).await;
        let conn = conn.conn;

        // 1. Header line, then the body until the client finishes its side.
        let (mut send, mut recv) = conn.accept_bi().await.expect("put stream");
        let mut received: Vec<u8> = Vec::new();
        let mut buf = vec![0u8; 64 * 1024];
        while let Some(n) = recv.read(&mut buf).await.expect("read") {
            received.extend_from_slice(&buf[..n]);
        }
        let at = received.iter().position(|&b| b == b'\n').expect("a header");
        let header: Value = serde_json::from_slice(&received[..at]).expect("json header");
        assert_eq!(header, json!({"op": "put", "upload_id": "u-1"}));
        assert_eq!(
            &received[at + 1..],
            &expected[..],
            "the body, whole and in order"
        );
        send.write_all(&encode_line(&json!({
            "op": "put", "ok": true, "hash": HASH, "size": expected.len(), "mime": "audio/ogg", "name": "tide.ogg",
        })))
        .await
        .unwrap();
        send.finish().unwrap();

        // 2. Refused part-way: the error line, without reading the body.
        let (mut send, _recv, request) = accept_request(&conn).await;
        assert_eq!(request["upload_id"], "u-2");
        send.write_all(&encode_line(&refusal("media_unknown_upload")))
            .await
            .unwrap();
        send.finish().unwrap();

        // 3. A GET-shaped answer to a PUT.
        let (mut send, mut recv, _) = accept_request(&conn).await;
        while let Ok(Some(_)) = recv.read(&mut buf).await {}
        send.write_all(&encode_line(&get_ok(HASH, 3)))
            .await
            .unwrap();
        send.finish().unwrap();

        conn.closed().await;
    });

    let (handle, mut rx) = up(&ticket).await;
    let receipt = handle
        .put("u-1".to_owned(), body.clone())
        .await
        .expect("PUT succeeds");
    assert_eq!(
        receipt,
        ByteFile {
            hash: HASH.to_owned(),
            size: body.len() as u64,
            mime: "audio/ogg".to_owned(),
            name: "tide.ogg".to_owned(),
        }
    );
    let refused = handle
        .put("u-2".to_owned(), vec![1, 2, 3])
        .await
        .expect_err("refused");
    assert_eq!(refused.code(), "media_unknown_upload");
    let wrong = handle
        .put("u-3".to_owned(), vec![1, 2, 3])
        .await
        .expect_err("a GET reply");
    assert_eq!(wrong.code(), "bad_reply");
    assert_eq!(
        handle.put(String::new(), vec![1]).await.expect_err("no id"),
        ByteError::BadUploadId
    );
    assert_eq!(
        handle
            .put("x".repeat(65), vec![1])
            .await
            .expect_err("too long"),
        ByteError::BadUploadId
    );
    close(&handle, &mut rx).await;
    server.await.expect("server task");
}

#[tokio::test]
async fn at_most_four_byte_streams_are_open_and_the_fifth_waits_its_turn() {
    let (endpoint, ticket) = bind_server().await;
    let server = tokio::spawn(async move {
        let conn = accept_with_hello(&endpoint).await;
        let conn = conn.conn;
        let mut open = Vec::new();
        for _ in 0..MAX_BYTE_STREAMS {
            open.push(accept_request(&conn).await);
        }
        // Four are open and unanswered: a fifth must not have been opened.
        let early = tokio::time::timeout(Duration::from_millis(500), conn.accept_bi()).await;
        assert!(
            early.is_err(),
            "a fifth byte stream opened while four were busy"
        );
        // Answer one: its slot goes to the fifth.
        let (mut send, _recv, _) = open.remove(0);
        send.write_all(&encode_line(&refusal("media_not_found")))
            .await
            .unwrap();
        send.finish().unwrap();
        open.push(accept_request(&conn).await);
        for (mut send, _recv, _) in open {
            send.write_all(&encode_line(&refusal("media_not_found")))
                .await
                .unwrap();
            send.finish().unwrap();
        }
        conn.closed().await;
    });

    let (handle, mut rx) = up(&ticket).await;
    let fetches: Vec<_> = (0..MAX_BYTE_STREAMS + 1)
        .map(|_| {
            let handle = handle.clone();
            tokio::spawn(async move { handle.fetch(HASH.to_owned()).await })
        })
        .collect();
    for fetch in fetches {
        let result = tokio::time::timeout(STEP, fetch)
            .await
            .expect("every fetch is answered")
            .expect("fetch task");
        assert_eq!(result.expect_err("refused").code(), "media_not_found");
    }
    close(&handle, &mut rx).await;
    server.await.expect("server task");
}
