// Tier-1 panel templates → concrete UI blocks (spec M15/M19, protocol 2.1).
//
// The resolver substitutes `{$var}` / `{$leaf}` bindings from the viewer's OWN
// `state.variables`, localizes `{en,zh}` text, and applies each block's
// `visible_when` gate BEFORE resolving it. It is deliberately fail-closed: a
// variable that is absent or hidden for this viewer, a binding that resolves
// to a type the block cannot hold, or a condition that errors or cannot be
// evaluated omits the WHOLE block. A panel template can therefore never widen
// visibility beyond what the state wire filter already granted — and a gate
// the client cannot decide never draws (the one NORMATIVE versioning rule).

import {
  isVisible,
  MAX_PANEL_REPEAT_INSTANCES,
  type ModuleVariable,
  type PanelTemplateBlock,
  type PanelText,
  type Resolver,
  type UiBadgeTone,
  type UiBlock,
  type UiChoiceOption,
} from "@loreweaver/protocol"

/** Mirror of the server-side cap: ≤ 32 template blocks per panel. */
export const MAX_PANEL_BLOCKS = 32

/** Omission sentinel: any binding that fails closes over its whole block. */
const OMIT = Symbol("omit")
type Resolved<T> = T | typeof OMIT

/**
 * The variables this viewer may bind against. A keeper connection receives
 * unexposed variables flagged `hidden:true` (rendered under 🔒 in the state
 * panel); panels bind only against EXPOSED variables so a template renders
 * identically for every role a variable is visible to.
 */
export function visibleVariables(variables: readonly ModuleVariable[]): ModuleVariable[] {
  return variables.filter((variable) => (variable as { hidden?: boolean }).hidden !== true)
}

export function isZhLocale(locale: string | undefined): boolean {
  return (locale ?? "").toLowerCase().startsWith("zh")
}

/** Localized template text: `{en,zh}` maps, plain strings pass through. */
export function pickText(
  text: PanelText | string | undefined,
  locale: string | undefined,
): string | undefined {
  if (text === undefined) return undefined
  if (typeof text === "string") return text
  if (typeof text !== "object" || text === null) return undefined
  const map = text as PanelText
  return isZhLocale(locale) ? (map.zh ?? map.en) : (map.en ?? map.zh)
}

function isVarBinding(value: unknown): value is { $var: string } {
  return typeof value === "object" && value !== null && typeof (value as { $var?: unknown }).$var === "string"
}

function isLeafBinding(value: unknown): value is { $leaf: string } {
  return (
    typeof value === "object" && value !== null && typeof (value as { $leaf?: unknown }).$leaf === "string"
  )
}

type Scalar = string | number | boolean

/**
 * One binding step: `{$var}` → the visible variable's value, `{$leaf}` → the
 * repeat-context variable's field, `{en,zh}` → localized string, primitives →
 * themselves. Everything else fails closed.
 */
function resolveScalar(
  value: unknown,
  vars: ReadonlyMap<string, ModuleVariable>,
  locale: string | undefined,
  leaf: ModuleVariable | null,
): Resolved<Scalar | undefined> {
  if (value === undefined || value === null) return undefined
  if (isVarBinding(value)) {
    const variable = vars.get(value.$var)
    if (!variable) return OMIT
    return variable.value as Scalar
  }
  if (isLeafBinding(value)) {
    if (!leaf) return OMIT
    switch (value.$leaf) {
      case "id":
        return leaf.id
      case "label":
        return leaf.label
      case "value":
        return leaf.value as Scalar
      default:
        return OMIT
    }
  }
  if (typeof value === "object") {
    const text = pickText(value as PanelText, locale)
    return text === undefined ? OMIT : text
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value
  }
  return OMIT
}

function asText(resolved: Resolved<Scalar | undefined>): Resolved<string | undefined> {
  if (resolved === OMIT || resolved === undefined) return resolved
  return String(resolved)
}

function asNumber(resolved: Resolved<Scalar | undefined>): Resolved<number> {
  if (resolved === OMIT) return OMIT
  if (typeof resolved !== "number" || !Number.isFinite(resolved)) return OMIT
  return resolved
}

const BADGE_TONES: readonly UiBadgeTone[] = ["info", "warn", "danger"]

/**
 * The `visible_when` variable scope (protocol 2.1): the viewer's own VISIBLE
 * variables by id — hidden ones were dropped before the map was built, so a
 * condition can never surface what the wire filter withheld. An absent id
 * resolves to `null`, exactly like the reference evaluator's resolver.
 */
function conditionResolver(vars: ReadonlyMap<string, ModuleVariable>): Resolver {
  return (path) => {
    const variable = vars.get(path)
    return variable === undefined ? null : variable.value
  }
}

/** The wire triple every hash-addressed block carries once the pack build has
 * rewritten the author's pack-relative `src`. A hand-built fixture may still
 * carry only `src` — tolerated, but unaddressable, so it fails closed. */
function wireAsset(block: object): { hash: string; mime?: string; size?: number } | null {
  const raw = block as { hash?: unknown; mime?: unknown; size?: unknown }
  if (typeof raw.hash !== "string" || !raw.hash) return null
  const mime = typeof raw.mime === "string" && raw.mime ? raw.mime : undefined
  const size = typeof raw.size === "number" && Number.isFinite(raw.size) ? raw.size : undefined
  return { hash: raw.hash, ...(mime !== undefined ? { mime } : {}), ...(size !== undefined ? { size } : {}) }
}

/** A localized/bindable text field the block REQUIRES to resolve. */
function requiredText(resolved: Resolved<Scalar | undefined>): Resolved<string> {
  if (resolved === OMIT || resolved === undefined) return OMIT
  return String(resolved)
}

/** Resolve one template block; OMIT is the fail-closed outcome. */
function resolveBlock(
  block: PanelTemplateBlock,
  vars: ReadonlyMap<string, ModuleVariable>,
  locale: string | undefined,
  leaf: ModuleVariable | null,
): Resolved<UiBlock> {
  if (typeof block !== "object" || block === null) return OMIT
  if ("repeat" in block) return OMIT // repeat does not nest; top level expands it
  // `visible_when` (2.1) gates BEFORE anything resolves. Every failure fails
  // CLOSED — `isVisible` swallows CondExprError, malformed (non-string)
  // conditions and resolver blow-ups into "hidden": a gate this client cannot
  // decide must never draw the block it guards.
  if (!isVisible(block.visible_when, conditionResolver(vars))) return OMIT
  const scalar = (value: unknown) => resolveScalar(value, vars, locale, leaf)
  switch (block.kind) {
    case "meter": {
      const label = asText(scalar(block.label))
      const value = asNumber(scalar(block.value))
      const min = asNumber(scalar(block.min))
      const max = asNumber(scalar(block.max))
      if (label === OMIT || value === OMIT || min === OMIT || max === OMIT) return OMIT
      return { kind: "meter", label: label ?? "", value, min, max }
    }
    case "stat": {
      const label = asText(scalar(block.label))
      const value = scalar(block.value)
      if (label === OMIT || value === OMIT || value === undefined) return OMIT
      return { kind: "stat", label: label ?? "", value }
    }
    case "badge": {
      const label = asText(scalar(block.label))
      const tone = scalar(block.tone)
      if (label === OMIT || label === undefined || tone === OMIT) return OMIT
      if (tone !== undefined && !BADGE_TONES.includes(tone as UiBadgeTone)) return OMIT
      return { kind: "badge", label, ...(tone !== undefined ? { tone: tone as UiBadgeTone } : {}) }
    }
    case "text": {
      const text = asText(scalar(block.text))
      if (text === OMIT || text === undefined) return OMIT
      const style = block.style === "quote" || block.style === "warning" ? block.style : undefined
      return { kind: "text", text, ...(style ? { style } : {}) }
    }
    case "divider":
      return { kind: "divider" }
    case "choices": {
      if (!Array.isArray(block.options)) return OMIT
      const prompt = asText(scalar(block.prompt))
      if (prompt === OMIT) return OMIT
      const options: UiChoiceOption[] = []
      for (const option of block.options) {
        if (typeof option !== "object" || option === null) return OMIT
        const label = asText(scalar(option.label))
        if (label === OMIT || label === undefined) return OMIT
        if (typeof option.id !== "string" || typeof option.input !== "string") return OMIT
        options.push({ id: option.id, label, input: option.input })
      }
      return { kind: "choices", ...(prompt !== undefined ? { prompt } : {}), options }
    }
    // ---- M19 (protocol 2.1): image + the four performance templates ----
    case "image": {
      const asset = wireAsset(block)
      if (!asset) return OMIT
      const caption = asText(scalar(block.caption))
      const alt = asText(scalar(block.alt))
      if (caption === OMIT || alt === OMIT) return OMIT
      return {
        kind: "image",
        ...asset,
        ...(caption !== undefined ? { caption } : {}),
        ...(alt !== undefined ? { alt } : {}),
      }
    }
    case "letter": {
      const body = requiredText(scalar(block.body))
      const from = asText(scalar(block.from))
      const to = asText(scalar(block.to))
      const date = asText(scalar(block.date))
      if (body === OMIT || from === OMIT || to === OMIT || date === OMIT) return OMIT
      return {
        kind: "letter",
        body,
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
        ...(date !== undefined ? { date } : {}),
      }
    }
    case "clipping": {
      const headline = requiredText(scalar(block.headline))
      const body = requiredText(scalar(block.body))
      const source = asText(scalar(block.source))
      const date = asText(scalar(block.date))
      if (headline === OMIT || body === OMIT || source === OMIT || date === OMIT) return OMIT
      return {
        kind: "clipping",
        headline,
        body,
        ...(source !== undefined ? { source } : {}),
        ...(date !== undefined ? { date } : {}),
      }
    }
    case "map_pin": {
      const asset = wireAsset(block)
      if (!asset) return OMIT
      const label = requiredText(scalar(block.label))
      const note = asText(scalar(block.note))
      const x = asNumber(scalar(block.x))
      const y = asNumber(scalar(block.y))
      if (label === OMIT || note === OMIT || x === OMIT || y === OMIT) return OMIT
      return {
        kind: "map_pin",
        ...asset,
        label,
        // Fractions of the map's own box — clamped like the wire sanitizer.
        x: Math.min(1, Math.max(0, x)),
        y: Math.min(1, Math.max(0, y)),
        ...(note !== undefined ? { note } : {}),
      }
    }
    case "title_card": {
      const title = requiredText(scalar(block.title))
      const subtitle = asText(scalar(block.subtitle))
      const act = asText(scalar(block.act))
      if (title === OMIT || subtitle === OMIT || act === OMIT) return OMIT
      return {
        kind: "title_card",
        title,
        ...(subtitle !== undefined ? { subtitle } : {}),
        ...(act !== undefined ? { act } : {}),
      }
    }
    default:
      // Additive protocol: template kinds we don't know yet are skipped.
      return OMIT
  }
}

/**
 * Render a tier-1 template against the viewer's variables. Absent/hidden
 * bindings drop their block; a `visible_when` gate that says hide — or that
 * fails to evaluate — drops it too (fail-closed, protocol 2.1); `repeat`
 * expands to at most {@link MAX_PANEL_REPEAT_INSTANCES} instances over the
 * visible variables whose id starts with the prefix.
 */
export function resolvePanelBlocks(
  blocks: readonly PanelTemplateBlock[] | undefined,
  variables: readonly ModuleVariable[] | undefined,
  locale: string | undefined,
): UiBlock[] {
  if (!Array.isArray(blocks)) return []
  const visible = visibleVariables(variables ?? [])
  const vars = new Map(visible.map((variable) => [variable.id, variable]))
  const out: UiBlock[] = []
  for (const block of blocks.slice(0, MAX_PANEL_BLOCKS)) {
    if (typeof block === "object" && block !== null && "repeat" in block) {
      // A gate on the repeat itself suppresses the WHOLE expansion; a gate on
      // its inner template suppresses each instance (checked in resolveBlock).
      if (!isVisible(block.visible_when, conditionResolver(vars))) continue
      const repeat = block.repeat
      if (typeof repeat !== "object" || repeat === null) continue
      if (typeof repeat.prefix !== "string" || typeof repeat.block !== "object") continue
      const matches = visible
        .filter((variable) => variable.id.startsWith(repeat.prefix))
        .slice(0, MAX_PANEL_REPEAT_INSTANCES)
      for (const leaf of matches) {
        const resolved = resolveBlock(repeat.block, vars, locale, leaf)
        if (resolved !== OMIT) out.push(resolved)
      }
      continue
    }
    const resolved = resolveBlock(block, vars, locale, null)
    if (resolved !== OMIT) out.push(resolved)
  }
  return out
}
