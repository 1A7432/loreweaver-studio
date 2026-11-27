# UI panels

The panels format is the engine's: **panels 3.0**, specified in
[docs/lwf/formats/panels.md](https://github.com/1A7432/loreweaver/blob/v3/docs/lwf/formats/panels.md)
on the engine's `v3` branch, and the wire shape of the `panels` view in its `docs/protocol.md`.
This repository keeps no copy of it.

In this repository:

- **Play mode** renders a template panel, and a page panel's fallback, with the protocol
  package's `panelBlocks` (`src/features/play/panels/Tier1Blocks.tsx`), and runs a page in a
  sandboxed frame (`Tier2Frame.tsx`, `bridge.ts`, `src-tauri/src/panel_serve.rs`) through the
  page bridge, specified in [PAGE-BRIDGE.md](PAGE-BRIDGE.md).
- **The studio** edits panels 3.0 and previews them with the same `panelBlocks`
  (`src/features/studio/pack/PanelsEditor.tsx`); see [FORMATS.md](FORMATS.md).
