// The engine's `--pack <dir> [--out <file>] --json` machine interface
// (UPSTREAM_TODO item 1, landed): stdout carries exactly ONE JSON object —
// `{"ok": true, "path", "id", "version", "sha256", "trust"}` on success,
// `{"ok": false, "error"}` on failure — while every human line (including the
// localized trust card) stays on stderr. This module parses that object so the
// wizard can render the trust card natively instead of scraping human output.
// Field names mirror `app.py::_run_pack` and `core/pack.py::PackTrust`
// verbatim (snake_case, i18n-exempt data).

/** The auto-generated composition summary, as serialized by the engine's
 * `asdict(built.manifest.trust)`. Disclosure, not marketing — a hand-written
 * trust block is rejected at build time. */
export interface PackTrust {
  skills: number
  rulepacks: number
  cards: number
  lorebooks: number
  assets: number
  asset_bytes: number
  has_hooks: boolean
  has_ejs: boolean
  has_rules_script: boolean
  /** Cards whose DETECTED kind is `world` (keeper-imported). */
  world_cards: number
  panels: number
  /** Picturable subjects the presentation kit declares (0 = no kit). */
  presentation: number
  /** Whether the presentation kit licenses image GENERATION. */
  imagegen: boolean
  /** ST completion presets the pack installs into the shared preset store. */
  presets: number
  /** M20 F prep-phase plan scripts. CODE — disclosed for the same reason
   * hooks are, even though a prep script never runs automatically. */
  prep_scripts: number
}

export interface PackBuildSuccess {
  /** The built `.lwpack` path the ENGINE reports (more truthful than the
   * requested `--out`). */
  path: string
  id: string
  version: string
  sha256: string
  trust: PackTrust | null
}

export type PackBuildOutcome = { ok: true; result: PackBuildSuccess } | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

function parseTrust(raw: unknown): PackTrust | null {
  if (!isRecord(raw)) return null
  return {
    skills: count(raw.skills),
    rulepacks: count(raw.rulepacks),
    cards: count(raw.cards),
    lorebooks: count(raw.lorebooks),
    assets: count(raw.assets),
    asset_bytes: count(raw.asset_bytes),
    has_hooks: raw.has_hooks === true,
    has_ejs: raw.has_ejs === true,
    has_rules_script: raw.has_rules_script === true,
    world_cards: count(raw.world_cards),
    panels: count(raw.panels),
    presentation: count(raw.presentation),
    imagegen: raw.imagegen === true,
    presets: count(raw.presets),
    prep_scripts: count(raw.prep_scripts),
  }
}

/** Parse the one stdout object `--pack --json` prints. Returns `null` when
 * stdout is not the machine shape (an older engine without `--json`, argparse
 * noise) — callers then fall back to exit-code + raw terminal output. */
export function parsePackBuildJson(stdout: string): PackBuildOutcome | null {
  const line = stdout.trim()
  if (!line.startsWith("{")) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (parsed.ok === false) {
    return typeof parsed.error === "string" ? { ok: false, error: parsed.error } : null
  }
  if (
    parsed.ok === true &&
    typeof parsed.path === "string" &&
    typeof parsed.id === "string" &&
    typeof parsed.version === "string" &&
    typeof parsed.sha256 === "string"
  ) {
    return {
      ok: true,
      result: {
        path: parsed.path,
        id: parsed.id,
        version: parsed.version,
        sha256: parsed.sha256,
        trust: parseTrust(parsed.trust),
      },
    }
  }
  return null
}
