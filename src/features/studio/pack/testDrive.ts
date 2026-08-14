// "Test this pack now": the last hop of the author loop. A build+install used
// to dead-end — playing the thing you just built meant switching to Play,
// starting a server by hand, and retyping import commands with server-side
// paths. This module owns the ONE decision the loop needs: which commands take
// a freshly installed pack into a live room.
//
// Mirror of the engine's keeper surface (do not reinvent — read, then copy):
//   - `gateway/commands.py::cmd_import` — `.import <file> [system] [pc|companion|world]`;
//     `world` is keeper-only and is the entrance for module machinery.
//   - `gateway/commands.py::cmd_lore` — `.lore import <file>`.
//   - `core/pack.py::resolve_installed_path` — BOTH commands first try the ref
//     as `<packId>/<path relative to the installed pack dir>` against the newest
//     `data_dir/packs/<id>@<version>/`, falling back to a literal server path.
//     That is why the studio never has to know the install directory: it names
//     the pack and the in-pack path, exactly as `core/pack.py::install_pack`
//     laid them out (the manifest's own `cards/…` / `lorebooks/…` names).
//   - `core/pack.py::_parse_card_entry` — a BUILT manifest's `contents.cards`
//     entries carry `kind` (`character` | `world`), stamped from the real
//     payload at build time. That stamp, not anything the studio believes, is
//     what decides which cards get a world import.

import { parse as parseYaml } from "yaml"

/** How a pack gets in front of a live Keeper.
 *
 * `install-then-import` is the shipped mode. The engine lane is building a
 * dev-room hot reload (mount a pack SOURCE dir into a sandbox room, save →
 * live reload); when it lands it becomes a second mode here, and only
 * {@link planTestDrive} and its caller in the store change. */
export type TestDriveMode = "install-then-import"

export interface TestDriveCard {
  /** Path inside the pack, as the manifest lists it (`cards/keeper.json`). */
  path: string
  /** DETECTED kind — only a world card carries module machinery. */
  kind: "character" | "world"
}

export interface TestDriveSource {
  packId: string
  cards: TestDriveCard[]
  /** Paths inside the pack (`lorebooks/rain.json`). */
  lorebooks: string[]
}

export interface TestDrivePlan {
  mode: TestDriveMode
  /** Keeper commands, in the order they must be issued. */
  commands: string[]
  /** Why the plan is empty, when it is. */
  emptyReason: "no-pack-id" | "nothing-importable" | null
}

/** Mirror of `core/pack.py::_SLUG_RE` — the rule `resolve_installed_path`
 * gates on. A ref it would reject can only fall through to a literal server
 * path, which is never what the author meant, so plan nothing instead. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Read the BUILT manifest an install left at
 * `data_dir/packs/<id>@<version>/pack.yaml`.
 *
 * The installed manifest — not the studio's in-memory session — is the source
 * of truth here: it carries the engine's own detected card kinds, and it is
 * the only thing that exists when the author adopted a source tree from disk
 * instead of dropping files. Returns null when the text is not a manifest. */
export function readInstalledManifest(yamlText: string): TestDriveSource | null {
  let parsed: unknown
  try {
    parsed = parseYaml(yamlText)
  } catch {
    return null
  }
  if (!isRecord(parsed) || typeof parsed.id !== "string") return null
  const contents = isRecord(parsed.contents) ? parsed.contents : {}
  const cards: TestDriveCard[] = []
  if (Array.isArray(contents.cards)) {
    for (const entry of contents.cards) {
      // A source manifest lists a bare path; a BUILT one lists {path, kind}.
      // A bare path can only be read as `character` — the conservative side,
      // since a spurious world import runs module machinery.
      if (typeof entry === "string") {
        cards.push({ path: entry, kind: "character" })
      } else if (isRecord(entry) && typeof entry.path === "string") {
        cards.push({ path: entry.path, kind: entry.kind === "world" ? "world" : "character" })
      }
    }
  }
  const lorebooks = Array.isArray(contents.lorebooks)
    ? contents.lorebooks.filter((entry): entry is string => typeof entry === "string")
    : []
  return { packId: parsed.id, cards, lorebooks }
}

/** Plan the commands that put `source` in front of a live Keeper.
 *
 * World cards come first: they install room hooks and seed the variable tree,
 * and a lorebook entry that references a variable reads better once it exists.
 * Character cards are deliberately NOT imported — a character enters play by a
 * player claiming one (`.pc claim`), and importing the whole cast as the
 * keeper's own PCs would be a different, wrong thing. */
export function planTestDrive(
  source: TestDriveSource,
  mode: TestDriveMode = "install-then-import",
): TestDrivePlan {
  const packId = source.packId.trim()
  if (!SLUG.test(packId)) {
    return { mode, commands: [], emptyReason: "no-pack-id" }
  }
  const commands: string[] = []
  for (const card of source.cards) {
    if (card.kind !== "world") continue
    const path = card.path.trim()
    if (path) commands.push(`.import ${packId}/${path} world`)
  }
  for (const lorebook of source.lorebooks) {
    const path = lorebook.trim()
    if (path) commands.push(`.lore import ${packId}/${path}`)
  }
  return {
    mode,
    commands,
    emptyReason: commands.length === 0 ? "nothing-importable" : null,
  }
}
