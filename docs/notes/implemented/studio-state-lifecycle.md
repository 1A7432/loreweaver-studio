# Implemented: Studio play-session lifecycle

- **Problem:** play stores mixed session furniture with host-global inventory;
  an explicit new dial left keeper-admin leftovers, a campaign wipe left hook
  `ui` sidebar regions, a media PUT could land after `media.reset`, persistence
  failures were a non-reactive bool nobody rendered, Esc closed a modal or a
  sheet draft and also dumped the operator back to the main menu, and the
  rich-block `data:` URL map grew without a cap.
- **Verdict:** `session.clear()` is the explicit new-session cleanup
  (connect, current or future generation, already calls it) and resets
  session furniture including keeper-admin leftovers; auto-reconnect status
  events do not call it. `state{reset:true}` clears chronicle entries and
  hook `uiPanels` only — the module `ui_manifest`, `packCards` (server
  installed-pack inventory, not campaign state), and admin leftovers stay
  (a wipe is not a room change). Media writes after `await` no-op when the
  store epoch has moved. Persistence is a latched external store with an
  App-root en/zh banner (first failure notifies; later writes do not). Esc
  is consumed by the owner (modal: capture + `stopImmediatePropagation`;
  sheet draft: `stopPropagation`); InputBox Esc still returns to the menu.
  Picture URLs use a small LRU and drop on session clear; in-flight dedupe
  is untouched.
- **Reason:** each leftover was a real cross-session leak or a same-target
  keydown race; clearing host inventory or the module manifest on a story
  reset would hide still-valid furniture the engine keeps.
- **Rule home:** `src/store/session.ts` (`clear` / `state.reset`),
  `src/store/media.ts` (epoch), `src/lib/persistStorage.ts`,
  `src/features/play/PlayView.tsx` + `PanelModalHost.tsx` +
  `CharacterScreen.tsx` (Esc), `src/lib/dataUrlCache.ts`.
- **Date:** 2026-08-22
