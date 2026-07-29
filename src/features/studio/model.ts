// The forge's authoring model + validation, mirroring the engine's rules in
// `core/modvars.py` and `core/worldbook.py` so a bundle that validates here
// also validates on import. Numbers/limits are copied from the engine source.

export const MAX_VARS = 64
export const MAX_TEXT_LEN = 200
export const MAX_LABEL_LEN = 50
export const MAX_OPTIONS = 20
export const MAX_OPTION_LEN = 50
export const MAX_CONDITION_LEN = 500
export const VAR_ID_RE = /^[a-z0-9_]{1,64}$/

export type VarKind = "number" | "bool" | "text" | "enum"
export type VarVisibility = "player" | "keeper"
export type SelectiveLogic = "and_any" | "and_all" | "not_any" | "not_all"
export type LorePosition = "" | "before" | "after"

/** Raw form state for one typed module variable; validation coerces it. */
export interface ForgeVariable {
  uid: string
  id: string
  kind: VarKind
  visibility: VarVisibility
  labelEn: string
  labelZh: string
  /** Raw numeric strings; empty = unset. Only meaningful for kind "number". */
  minimum: string
  maximum: string
  /** Raw default; empty = the engine default for the kind. */
  defaultValue: string
  /** Enum options, one per line (or comma-separated). */
  options: string
}

export interface ForgeLoreEntry {
  uid: string
  title: string
  content: string
  /** Comma/newline separated trigger keywords. */
  keys: string
  secondaryKeys: string
  selectiveLogic: SelectiveLogic
  condition: string
  constant: boolean
  secret: boolean
  enabled: boolean
  priority: number
  probability: number
  caseSensitive: boolean
  matchWholeWords: boolean
  scanDepth: number
  position: LorePosition
  sticky: number
  cooldown: number
  delay: number
}

export interface ForgeProject {
  uid: string
  name: string
  description: string
  personality: string
  scenario: string
  firstMes: string
  mesExample: string
  creatorNotes: string
  tags: string
  variables: ForgeVariable[]
  lorebook: ForgeLoreEntry[]
  hooks: string
  updatedAt: number
}

/** A validation problem as an i18n key + params (rendered by the UI). */
export interface Issue {
  key: string
  params?: Record<string, unknown>
}

/** The engine-shaped spec dict (`core.modvars.build_spec` output). */
export interface ModvarSpec {
  id: string
  kind: VarKind
  visibility: VarVisibility
  labels: Record<string, string>
  default: number | boolean | string
  minimum?: number
  maximum?: number
  options?: string[]
}

export function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)
}

/** Engine id normalization: spaces/hyphens → underscores, lowercased. */
export function normalizeVarId(raw: string): string {
  return raw
    .trim()
    .replace(/[\s-]+/g, "_")
    .toLowerCase()
}

export function splitKeys(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
}

const INT_RE = /^-?\d+$/

function parseIntStrict(raw: string): number | null {
  const trimmed = raw.trim()
  if (!INT_RE.test(trimmed)) return null
  return Number.parseInt(trimmed, 10)
}

/** Engine `coerce_bool`: bool words, on/off, yes/no, 0/1. */
function coerceBool(raw: string): boolean | null {
  const v = raw.trim().toLowerCase()
  if (["true", "1", "yes", "on"].includes(v)) return true
  if (["false", "0", "no", "off"].includes(v)) return false
  return null
}

function cleanOptions(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const piece of splitKeys(raw)) {
    const text = piece.slice(0, MAX_OPTION_LEN)
    const fold = text.toLowerCase()
    if (seen.has(fold)) continue
    seen.add(fold)
    out.push(text)
  }
  return out.slice(0, MAX_OPTIONS)
}

/** Validate one variable and, when clean, produce its engine-shaped spec. */
export function buildSpec(v: ForgeVariable): { spec: ModvarSpec | null; errors: Issue[] } {
  const errors: Issue[] = []
  const id = normalizeVarId(v.id)
  if (!VAR_ID_RE.test(id)) errors.push({ key: "idInvalid" })

  const labels: Record<string, string> = {}
  if (v.labelEn.trim()) labels.en = v.labelEn.trim().slice(0, MAX_LABEL_LEN)
  if (v.labelZh.trim()) labels.zh = v.labelZh.trim().slice(0, MAX_LABEL_LEN)

  let minimum: number | undefined
  let maximum: number | undefined
  if (v.kind === "number") {
    if (v.minimum.trim()) {
      const parsed = parseIntStrict(v.minimum)
      if (parsed === null) errors.push({ key: "boundNotInt" })
      else minimum = parsed
    }
    if (v.maximum.trim()) {
      const parsed = parseIntStrict(v.maximum)
      if (parsed === null) errors.push({ key: "boundNotInt" })
      else maximum = parsed
    }
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      errors.push({ key: "boundsOrder" })
    }
  }

  let options: string[] | undefined
  if (v.kind === "enum") {
    options = cleanOptions(v.options)
    if (options.length === 0) errors.push({ key: "optionsRequired" })
  }

  const fallback = (): number | boolean | string => {
    switch (v.kind) {
      case "number":
        return minimum ?? 0
      case "bool":
        return false
      case "text":
        return ""
      case "enum":
        return options?.[0] ?? ""
    }
  }

  let value: number | boolean | string = fallback()
  const raw = v.defaultValue.trim()
  if (raw) {
    switch (v.kind) {
      case "number": {
        const parsed = parseIntStrict(raw)
        if (parsed === null) errors.push({ key: "defaultInvalid" })
        else {
          value = parsed
          if (minimum !== undefined && value < minimum) value = minimum
          if (maximum !== undefined && value > maximum) value = maximum
        }
        break
      }
      case "bool": {
        const parsed = coerceBool(raw)
        if (parsed === null) errors.push({ key: "defaultInvalid" })
        else value = parsed
        break
      }
      case "text":
        value = raw.slice(0, MAX_TEXT_LEN)
        break
      case "enum": {
        const match = options?.find((o) => o.toLowerCase() === raw.toLowerCase())
        if (match === undefined) errors.push({ key: "defaultInvalid" })
        else value = match
        break
      }
    }
  }

  if (errors.length > 0) return { spec: null, errors }
  const spec: ModvarSpec = { id, kind: v.kind, visibility: v.visibility, labels, default: value }
  if (v.kind === "number") {
    if (minimum !== undefined) spec.minimum = minimum
    if (maximum !== undefined) spec.maximum = maximum
  }
  if (v.kind === "enum" && options) spec.options = options
  return { spec, errors }
}

export interface ProjectValidation {
  /** Per-variable issues keyed by uid. */
  variables: Map<string, Issue[]>
  /** Per-entry issues keyed by uid. */
  lorebook: Map<string, Issue[]>
  project: Issue[]
  /** Specs for every clean variable, in declaration order. */
  specs: ModvarSpec[]
  issueCount: number
}

export function validateProject(project: ForgeProject): ProjectValidation {
  const variables = new Map<string, Issue[]>()
  const lorebook = new Map<string, Issue[]>()
  const projectIssues: Issue[] = []
  const specs: ModvarSpec[] = []

  if (!project.name.trim()) projectIssues.push({ key: "nameRequired" })
  if (project.variables.length > MAX_VARS) {
    projectIssues.push({ key: "tooManyVariables", params: { max: MAX_VARS } })
  }

  const seenIds = new Set<string>()
  for (const variable of project.variables) {
    const { spec, errors } = buildSpec(variable)
    const issues = [...errors]
    if (spec) {
      if (seenIds.has(spec.id)) issues.push({ key: "idDuplicate", params: { id: spec.id } })
      else {
        seenIds.add(spec.id)
        specs.push(spec)
      }
    }
    if (issues.length > 0) variables.set(variable.uid, issues)
  }

  for (const entry of project.lorebook) {
    const issues: Issue[] = []
    if (!entry.content.trim() && !entry.title.trim()) issues.push({ key: "entryEmpty" })
    if (entry.condition.length > MAX_CONDITION_LEN) {
      issues.push({ key: "conditionTooLong", params: { max: MAX_CONDITION_LEN } })
    }
    if (issues.length > 0) lorebook.set(entry.uid, issues)
  }

  let issueCount = projectIssues.length
  for (const list of variables.values()) issueCount += list.length
  for (const list of lorebook.values()) issueCount += list.length
  return { variables, lorebook, project: projectIssues, specs, issueCount }
}

export const DEFAULT_HOOKS = `// Loreweaver room hooks — sandboxed, event-driven (see docs/plugins.md).
// Events: turn_start, reply_ready, dice_rolled, variables_changed
// APIs:   on(event, fn) · inject(text) · narrate(text) · rewriteReply(text)
//         emitUI(blocks, opts) · log(text) · getvar/setvar/incvar · variables · _
on('turn_start', (event) => {
  // narrate('The wind rises.')
})
`

export function newVariable(): ForgeVariable {
  return {
    uid: uid(),
    id: "",
    kind: "number",
    visibility: "player",
    labelEn: "",
    labelZh: "",
    minimum: "",
    maximum: "",
    defaultValue: "",
    options: "",
  }
}

export function newLoreEntry(): ForgeLoreEntry {
  return {
    uid: uid(),
    title: "",
    content: "",
    keys: "",
    secondaryKeys: "",
    selectiveLogic: "and_any",
    condition: "",
    constant: false,
    secret: false,
    enabled: true,
    priority: 0,
    probability: 100,
    caseSensitive: false,
    matchWholeWords: false,
    scanDepth: 0,
    position: "",
    sticky: 0,
    cooldown: 0,
    delay: 0,
  }
}

export function newProject(name: string): ForgeProject {
  return {
    uid: uid(),
    name,
    description: "",
    personality: "",
    scenario: "",
    firstMes: "",
    mesExample: "",
    creatorNotes: "",
    tags: "",
    variables: [],
    lorebook: [],
    hooks: DEFAULT_HOOKS,
    updatedAt: 0,
  }
}
