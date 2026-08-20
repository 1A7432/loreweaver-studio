// Reading a `dice` frame's `detail` object.
//
// `docs/protocol.md`: "`detail` is otherwise system-declared roll data (bonus/
// penalty dice, loss/remaining, advantage candidates, …) a client may surface
// verbatim but never needs to understand." The studio dropped it entirely, so
// an opposed check showed no opposing roll and no winner, and a sanity check
// showed no SAN loss — the numbers that ARE the roll.
//
// The contract this module keeps: never require a key, never hide one. The two
// shapes the protocol names explicitly (`kind:"opposed"`'s left/right/winner,
// and the subsystem label) get real layout; everything else is surfaced
// verbatim as a labelled chip, with a translated label where the studio knows
// the key and the key itself where it does not. A rule system that invents a
// field tomorrow shows up tomorrow, unlabelled but present — which is the whole
// point of a contract that says "may surface verbatim".

import type { DiceFrame, DiceOutcome } from "@loreweaver/protocol"

export interface OpposedSide {
  name: string
  total: number | null
  target: number | null
  outcomeLabel: string
}

export interface OpposedDetail {
  left: OpposedSide
  right: OpposedSide
  /** "" when the server did not say (never inferred from the totals: the rule
   * system decides ties and margins, and guessing would be a lie). */
  winner: "left" | "right" | "tie" | ""
}

export interface DetailChip {
  /** The raw key, always — it is the fallback label and the React key. */
  key: string
  /** i18n suffix under `play.dice.detail.` when this key is one we know. */
  labelKey: string | null
  value: string
}

/** Keys the studio can label. Everything else still shows, under its own key. */
const KNOWN_KEYS = new Set([
  "bonus",
  "penalty",
  "modifier",
  "proficient",
  "advantage",
  "disadvantage",
  "loss",
  "loss_expr",
  "loss_ceiling",
  "remaining",
  "resource_max",
  "points",
  "raw_roll",
  "critical_success",
  "critical_failure",
  "mark",
  "stat_delta",
])

/** Structural keys the layout renders itself — never repeated as a chip. */
const STRUCTURAL_KEYS = new Set(["left", "right", "winner"])

function readWinner(raw: unknown): OpposedDetail["winner"] {
  return raw === "left" || raw === "right" || raw === "tie" ? raw : ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function readSide(raw: unknown, fallbackName: string): OpposedSide {
  const side = isRecord(raw) ? raw : {}
  const outcome = isRecord(side.outcome) ? (side.outcome as unknown as DiceOutcome) : null
  return {
    name: typeof side.name === "string" && side.name.trim() ? side.name : fallbackName,
    total: numberOrNull(side.total),
    target: numberOrNull(side.target),
    outcomeLabel: typeof outcome?.label === "string" ? outcome.label : "",
  }
}

/** Format one detail value for display. Objects and arrays ride as compact
 * JSON — unreadable is better than absent for data a client is not meant to
 * understand, and the alternative is deciding on the author's behalf. */
function formatValue(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number") return String(value)
  if (typeof value === "boolean") return value ? "✓" : "—"
  if (value === null || value === undefined) return ""
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Numeric keys whose ZERO is a reading, not an absence.
 *
 * `remaining`/`total` are the roll's own numbers. `loss`/`loss_ceiling` are the
 * case that taught us the rest of the list is not enough: a pack may CAP a
 * resource loss (《安土》 caps plant-horror sanity loss to 0 once a character is
 * far enough gone — the module's whole thesis is that comfort is the damage),
 * and the engine says so in the roll it publishes. Dropping those two zeroes
 * left the player watching a failed check roll 1d4 and lose nothing, with no
 * reason on screen — which is precisely what the engine's own comment says the
 * reason exists to prevent. */
const MEANINGFUL_ZERO_KEYS = new Set(["remaining", "total", "loss", "loss_ceiling"])

/** Should this entry appear at all?
 *
 * A `false` boolean and a zero modifier are the ABSENCE of a thing — a chip
 * reading "critical failure —" on every ordinary roll is noise that trains the
 * eye to skip the row where it matters. Anything non-numeric, non-boolean shows
 * whatever it is. */
function worthShowing(key: string, value: unknown): boolean {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0 || MEANINGFUL_ZERO_KEYS.has(key)
  if (typeof value === "string") return value.trim() !== ""
  if (Array.isArray(value)) return value.length > 0
  if (isRecord(value)) return Object.keys(value).length > 0
  return value !== null && value !== undefined
}

export interface DiceDetailReading {
  opposed: OpposedDetail | null
  chips: DetailChip[]
}

export function readDiceDetail(frame: DiceFrame): DiceDetailReading {
  const detail = isRecord(frame.detail) ? frame.detail : null
  if (detail === null) return { opposed: null, chips: [] }

  // The protocol names this shape for `kind:"opposed"`, and only there.
  const opposed: OpposedDetail | null =
    frame.kind === "opposed" && (detail.left !== undefined || detail.right !== undefined)
      ? {
          left: readSide(detail.left, "left"),
          right: readSide(detail.right, "right"),
          winner: readWinner(detail.winner),
        }
      : null

  const chips: DetailChip[] = []
  for (const [key, value] of Object.entries(detail)) {
    if (opposed !== null && STRUCTURAL_KEYS.has(key)) continue
    if (!worthShowing(key, value)) continue
    chips.push({
      key,
      labelKey: KNOWN_KEYS.has(key) ? key : null,
      value: formatValue(value),
    })
  }
  return { opposed, chips }
}
