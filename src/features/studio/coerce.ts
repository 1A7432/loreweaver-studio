// Tolerant coercion for untrusted card-shaped data — shared by the split
// parser (whose engine-mirror semantics defined these), the AI draft gates,
// and the PNG-card writer. Lives here so `split/` stays mirror-only;
// `split/charcard.ts` re-exports asText/isRecord for back-compat.

export function asText(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  // The engine `str()`s exotic values; for the one shape seen in the wild
  // (`creator_notes_multilingual` maps) pick a readable locale instead.
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    for (const locale of ["en", "zh"]) {
      if (typeof record[locale] === "string") return record[locale]
    }
    const first = Object.values(record).find((v) => typeof v === "string")
    if (typeof first === "string") return first
  }
  return ""
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A string list from either an array or one delimited string (newline, ASCII
 * or CJK comma/enumeration mark). Blank items drop out. */
export function listOfStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asText).filter((item) => item.length > 0)
  const text = asText(value)
  return text
    ? text
        .split(/[\n,，、]/)
        .map((item) => item.trim())
        .filter(Boolean)
    : []
}
