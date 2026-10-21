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
//
// One cluster is read as a whole, because four chips for one mechanic is noise:
// the percentile bonus/penalty-die keys (`TensReroll`). It is claimed only when
// every key is there and well formed — never half — so no key is ever dropped.

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

/** The percentile bonus/penalty-die cluster, read as one thing.
 *
 * The engine's generic dice engine rolls a d100 as tens + ones, rolls |net|
 * EXTRA tens dice, and keeps the best (bonus) or worst (penalty) tens. It
 * reports that as `base_roll` (the d100 before the extra dice), `extra_tens`
 * (the extra tens digits) and `final_tens` (the digit kept), beside the
 * `bonus`/`penalty` counts the caller asked for. Four raw chips for one
 * mechanic read as noise; together they are one sentence. */
export interface TensReroll {
  /** Dice asked for, 0 when the server did not say (a pack may name them otherwise). */
  bonus: number
  penalty: number
  base: number
  extra: number[]
  final: number
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
  "base_roll",
  "extra_tens",
  "final_tens",
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
 * reason exists to prevent. `final_tens` is the same kind of reading: a kept
 * tens digit of 0 is a roll of 01-09 (or 100), not a missing value. */
const MEANINGFUL_ZERO_KEYS = new Set(["remaining", "total", "loss", "loss_ceiling", "final_tens"])

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
  /** The bonus/penalty-die cluster, when ALL of its keys came and were well formed. */
  tens: TensReroll | null
  chips: DetailChip[]
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

/** The cluster is claimed only whole: `base_roll`, `extra_tens` and `final_tens`
 * all present and numeric. A partial or malformed one is left alone, so its keys
 * fall through to ordinary labelled chips — claiming it half-way would hide the
 * keys that did arrive. The `bonus`/`penalty` counts join it when they are
 * usable; otherwise they stay chips of their own. */
function readTens(detail: Record<string, unknown>): { tens: TensReroll; claimed: Set<string> } | null {
  const { base_roll: base, extra_tens: extra, final_tens: final } = detail
  if (typeof base !== "number" || !Number.isFinite(base)) return null
  if (typeof final !== "number" || !Number.isFinite(final)) return null
  if (!Array.isArray(extra) || !extra.every((digit) => typeof digit === "number" && Number.isFinite(digit))) {
    return null
  }
  const claimed = new Set(["base_roll", "extra_tens", "final_tens"])
  const tens: TensReroll = { bonus: 0, penalty: 0, base, extra: extra as number[], final }
  if (isCount(detail.bonus)) {
    tens.bonus = detail.bonus
    claimed.add("bonus")
  }
  if (isCount(detail.penalty)) {
    tens.penalty = detail.penalty
    claimed.add("penalty")
  }
  return { tens, claimed }
}

export function readDiceDetail(frame: DiceFrame): DiceDetailReading {
  const detail = isRecord(frame.detail) ? frame.detail : null
  if (detail === null) return { opposed: null, tens: null, chips: [] }

  // The protocol names this shape for `kind:"opposed"`, and only there.
  const opposed: OpposedDetail | null =
    frame.kind === "opposed" && (detail.left !== undefined || detail.right !== undefined)
      ? {
          left: readSide(detail.left, "left"),
          right: readSide(detail.right, "right"),
          winner: readWinner(detail.winner),
        }
      : null

  const cluster = readTens(detail)

  const chips: DetailChip[] = []
  for (const [key, value] of Object.entries(detail)) {
    if (opposed !== null && STRUCTURAL_KEYS.has(key)) continue
    if (cluster?.claimed.has(key)) continue
    if (!worthShowing(key, value)) continue
    chips.push({
      key,
      labelKey: KNOWN_KEYS.has(key) ? key : null,
      value: formatValue(value),
    })
  }
  return { opposed, tens: cluster?.tens ?? null, chips }
}
