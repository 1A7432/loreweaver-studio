//! Tauri glue for the link actor: three commands in, one event stream out.
//!
//! The WebView never touches the network. It calls `transport_connect` /
//! `transport_send` / `transport_disconnect`, and consumes every
//! [`LinkEvent`] (status + frames) from the `loreweaver://transport` event
//! channel. Each link carries a **bridge** connection id — one per dial, a
//! redial included; stamped onto the envelope, never onto the protocol wire
//! frame — so the WebView can drop events from a link it has already left, and
//! a send meant for a link that is gone is refused instead of landing on its
//! successor (where it would arrive before that link's `hello`).
//!
//! The link is plain: the WebView's protocol session writes `hello`, answers
//! nothing on the link's behalf, and decides when to dial again.
//!
//! The slot knows whose actor it is holding. Commands cross the IPC boundary
//! as independent tasks, so they can be handled out of the order the WebView
//! issued them: a slow connect from a generation the operator has already left
//! must not tear down the live actor and seat itself in its place, because the
//! WebView drops everything that replacement emits while accepting the offline
//! the healthy actor emits on its way out. That is a working table taken apart
//! by a redial nobody is waiting for.

use loreweaver_transport::link::{self, LinkEvent, LinkHandle, LinkParams, NetworkProfile};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

pub const TRANSPORT_EVENT: &str = "loreweaver://transport";

/// What a dial that has been outrun is told. The WebView drops it unread —
/// only the generation that still owns the store may settle it — so this is
/// for whoever is reading a log.
const STALE_DIAL: &str = "a newer connection already owns the transport";

/// What a send for a link that is no longer seated is told.
const STALE_SEND: &str = "that link is not the one seated";

/// Who a seated actor belongs to: the bridge generation that dialed it, the
/// WebView page session that minted that generation, and its place in that
/// session's order.
///
/// The page session is what makes the ordering safe across a reload. A
/// reloaded WebView counts from the start again, and its dials must not be
/// fenced out by the epochs of a page that no longer exists.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SlotOwner {
    pub connection_id: String,
    pub session: String,
    pub seq: u64,
}

/// The slot's occupant: one actor and the generation that owns it.
struct Seat<H> {
    handle: H,
    owner: SlotOwner,
}

#[derive(Default)]
pub struct TransportState(Mutex<Option<Seat<LinkHandle>>>);

impl TransportState {
    /// A clone of the live link's handle, if any (for sibling modules — the
    /// asset cache pulls files over the same welcomed connection).
    pub async fn handle(&self) -> Option<LinkHandle> {
        self.0.lock().await.as_ref().map(|seat| seat.handle.clone())
    }
}

/// Whether a dial may take the slot from its current occupant.
///
/// Ordering is per page session: a later generation of the SAME session wins,
/// an earlier one is refused, and a dial from a different session — a reloaded
/// WebView, whose counter starts over — always wins, because the page that
/// seated the incumbent is gone and nothing there is listening for it.
fn may_seat(incumbent: &SlotOwner, caller: &SlotOwner) -> bool {
    incumbent.session != caller.session || caller.seq > incumbent.seq
}

/// Take the incumbent out of the slot so `caller` can be seated, or refuse.
///
/// A refusal leaves the slot untouched. Taking the live actor down for a dial
/// that is about to be refused is the whole failure: the WebView has already
/// moved on, so it drops everything the replacement emits while accepting the
/// offline the actor that just died emits under the id it still holds.
fn take_for_replace<H>(
    slot: &mut Option<Seat<H>>,
    caller: &SlotOwner,
) -> Result<Option<H>, String> {
    match slot.as_ref() {
        Some(seat) if !may_seat(&seat.owner, caller) => Err(STALE_DIAL.to_owned()),
        _ => Ok(slot.take().map(|seat| seat.handle)),
    }
}

/// The seated actor, but only for the generation that seated it: a send from a
/// link the WebView has already replaced must not reach the new one.
fn held_by<'a, H>(slot: &'a Option<Seat<H>>, connection_id: &str) -> Option<&'a H> {
    slot.as_ref()
        .filter(|seat| seat.owner.connection_id == connection_id)
        .map(|seat| &seat.handle)
}

/// Take the actor down only for the generation that seated it. A disconnect
/// from any other one is about a connection that is already gone, and the
/// actor it would close belongs to somebody still using it.
fn take_if_owner<H>(slot: &mut Option<Seat<H>>, connection_id: &str) -> Option<H> {
    match slot.as_ref() {
        Some(seat) if seat.owner.connection_id == connection_id => {
            slot.take().map(|seat| seat.handle)
        }
        _ => None,
    }
}

/// Stamp the bridge generation onto a transport event without touching the
/// protocol frame payload. Late events already sitting in the Tauri/JS queue
/// still carry the id they were minted with; the WebView is the one that
/// drops a stale generation — a check here cannot see those.
pub fn bridged_event(connection_id: &str, event: &LinkEvent) -> Value {
    let mut payload = serde_json::to_value(event).expect("transport events are JSON");
    payload
        .as_object_mut()
        .expect("event object")
        .insert("connectionId".to_owned(), json!(connection_id));
    payload
}

#[tauri::command]
pub async fn transport_connect(
    app: AppHandle,
    state: State<'_, TransportState>,
    ticket: String,
    network: Option<NetworkProfile>,
    generation: SlotOwner,
) -> Result<(), String> {
    if generation.connection_id.is_empty() || generation.session.is_empty() {
        return Err("connection id is required".to_owned());
    }
    let mut slot = state.0.lock().await;
    // Decide before anything is built: a refused dial neither takes the
    // incumbent down nor mints an actor of its own.
    if let Some(previous) = take_for_replace(&mut slot, &generation)? {
        previous.close();
    }
    let params = LinkParams {
        ticket,
        network: network.unwrap_or_default(),
    };
    let (handle, mut events) = link::connect(params);
    let connection_id = generation.connection_id.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            let _ = app.emit(TRANSPORT_EVENT, &bridged_event(&connection_id, &event));
        }
    });
    *slot = Some(Seat {
        handle,
        owner: generation,
    });
    Ok(())
}

/// Write one frame on the link `connection_id` names — and only that one.
#[tauri::command]
pub async fn transport_send(
    state: State<'_, TransportState>,
    connection_id: String,
    frame: Value,
) -> Result<(), String> {
    let handle = held_by(&*state.0.lock().await, &connection_id)
        .cloned()
        .ok_or_else(|| STALE_SEND.to_owned())?;
    handle.send_frame(frame).await
}

#[tauri::command]
pub async fn transport_disconnect(
    state: State<'_, TransportState>,
    connection_id: Option<String>,
) -> Result<(), String> {
    // No id means the WebView is holding no generation of its own — a page
    // that reloaded, say. It has nothing here to drop, and the actor it does
    // not know about is replaced by its next dial rather than by this one.
    let Some(connection_id) = connection_id else {
        return Ok(());
    };
    let taken = take_if_owner(&mut *state.0.lock().await, &connection_id);
    if let Some(handle) = taken {
        handle.close();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{bridged_event, held_by, take_for_replace, take_if_owner, Seat, SlotOwner};
    use loreweaver_transport::link::{CloseCode, LinkEvent, LinkStatus};
    use serde_json::json;

    fn owner(connection_id: &str, session: &str, seq: u64) -> SlotOwner {
        SlotOwner {
            connection_id: connection_id.to_owned(),
            session: session.to_owned(),
            seq,
        }
    }

    fn seated(connection_id: &str, session: &str, seq: u64, handle: &str) -> Option<Seat<String>> {
        Some(Seat {
            handle: handle.to_owned(),
            owner: owner(connection_id, session, seq),
        })
    }

    fn held(slot: &Option<Seat<String>>) -> Option<(&str, &str)> {
        slot.as_ref()
            .map(|seat| (seat.handle.as_str(), seat.owner.connection_id.as_str()))
    }

    #[test]
    fn a_stale_dial_is_refused_and_leaves_the_live_actor_exactly_where_it_was() {
        // The WebView is on gen-b; gen-a's invoke only reaches us now. Seating
        // it would close the actor the operator is actually talking to, and
        // every event its replacement emits would then be dropped on arrival
        // for carrying an id the WebView has left.
        let mut slot = seated("gen-b", "page-1", 2, "live");
        assert!(take_for_replace(&mut slot, &owner("gen-a", "page-1", 1)).is_err());
        assert_eq!(held(&slot), Some(("live", "gen-b")));
    }

    #[test]
    fn the_live_actor_keeps_stamping_events_with_the_id_the_webview_accepts() {
        let mut slot = seated("gen-b", "page-1", 2, "live");
        let _ = take_for_replace(&mut slot, &owner("gen-a", "page-1", 1));
        let seat = slot.as_ref().expect("the live actor is still seated");
        let event = LinkEvent::Status {
            status: LinkStatus::Up,
            reason: None,
            code: None,
        };
        let payload = bridged_event(&seat.owner.connection_id, &event);
        assert_eq!(payload["connectionId"], "gen-b");
    }

    #[test]
    fn a_send_reaches_only_the_link_it_was_meant_for() {
        // The WebView redialled (gen-b) while a frame for gen-a was still on
        // its way: delivering it to gen-b would put it on the wire before
        // gen-b's own hello.
        let slot = seated("gen-b", "page-1", 2, "live");
        assert_eq!(held_by(&slot, "gen-b").map(String::as_str), Some("live"));
        assert!(held_by(&slot, "gen-a").is_none());
        let empty: Option<Seat<String>> = None;
        assert!(held_by(&empty, "gen-b").is_none());
    }

    #[test]
    fn a_newer_dial_replaces_the_incumbent_and_hands_it_back_to_close() {
        let mut slot = seated("gen-a", "page-1", 1, "old");
        let taken = take_for_replace(&mut slot, &owner("gen-b", "page-1", 2)).expect("newer seats");
        assert_eq!(taken.as_deref(), Some("old"));
        assert!(slot.is_none());
    }

    #[test]
    fn an_empty_slot_seats_whoever_asks() {
        let mut slot: Option<Seat<String>> = None;
        assert!(take_for_replace(&mut slot, &owner("gen-a", "page-1", 1))
            .expect("an empty slot refuses nobody")
            .is_none());
    }

    #[test]
    fn a_reloaded_webview_is_never_fenced_out_by_the_page_it_replaced() {
        // A reload starts counting from 1 again while the slot still holds a
        // seat from the page that is gone. That page is not coming back for
        // its events, so the fresh one wins whatever the numbers say.
        let mut slot = seated("gen-old", "page-1", 7, "orphan");
        let taken =
            take_for_replace(&mut slot, &owner("gen-new", "page-2", 1)).expect("a new page seats");
        assert_eq!(taken.as_deref(), Some("orphan"));
    }

    #[test]
    fn seating_the_generation_that_is_already_seated_is_refused() {
        let mut slot = seated("gen-a", "page-1", 1, "live");
        assert!(take_for_replace(&mut slot, &owner("gen-a", "page-1", 1)).is_err());
        assert_eq!(held(&slot), Some(("live", "gen-a")));
    }

    #[test]
    fn disconnect_only_takes_down_the_generation_that_seated_it() {
        let mut slot = seated("gen-b", "page-1", 2, "live");
        assert!(take_if_owner(&mut slot, "gen-a").is_none());
        assert_eq!(held(&slot), Some(("live", "gen-b")));
        assert_eq!(take_if_owner(&mut slot, "gen-b").as_deref(), Some("live"));
        assert!(slot.is_none());
    }

    #[test]
    fn stamps_connection_id_on_the_envelope_not_the_wire_frame() {
        let frame = json!({
            "type": "event",
            "seq": 7,
            "kind": "narrative",
            "data": {"speaker": "kp", "text": "from the old room", "format": "markdown"},
        });
        let event = LinkEvent::Frame {
            frame: frame.clone(),
        };
        let payload = bridged_event("gen-1", &event);
        assert_eq!(payload["connectionId"], "gen-1");
        assert_eq!(payload["kind"], "frame");
        assert_eq!(payload["frame"], frame);
        assert!(payload["frame"].get("connectionId").is_none());
    }

    #[test]
    fn a_failure_code_rides_the_envelope_for_the_webview_to_word() {
        let event = LinkEvent::Status {
            status: LinkStatus::Closed,
            reason: Some("dial timeout: no connection within 15s".to_owned()),
            code: Some(CloseCode::DialTimeout),
        };
        let payload = bridged_event("gen-1", &event);
        assert_eq!(payload["code"], "dial_timeout");
        assert_eq!(payload["connectionId"], "gen-1");
        assert!(payload["reason"].as_str().is_some());
    }

    #[test]
    fn stamps_status_events_the_same_way() {
        let event = LinkEvent::Status {
            status: LinkStatus::Closed,
            reason: None,
            code: None,
        };
        let payload = bridged_event("gen-old", &event);
        assert_eq!(payload["connectionId"], "gen-old");
        assert_eq!(payload["kind"], "status");
        assert_eq!(payload["status"], "closed");
        assert!(payload.get("frame").is_none());
    }
}
