// Advisory reading of a rulepack YAML — the author-side mirror of the engine's
// `core/rulepacks.py::parse_rulepack_text`.
//
// ADVISORY, like the pack lint: the engine parses this file again at build time
// and its verdict is the only one that counts. What this buys is the difference
// between "the build failed" ten seconds later in a terminal and "line 12's
// derived spec names no operation" while the cursor is still there.
//
// Mirrored from `core/rulepacks.py` (read it, do not re-derive):
//   - `_build_rulepack` reads exactly the top-level sections listed below, and
//     IGNORES anything else — so an unknown key is a typo the author wants to
//     hear about, never an error;
//   - `_compile_derived_spec` dispatches a `derived:` entry on the FIRST key it
//     recognizes, from a fixed vocabulary, and never evaluates anything;
//   - `_NAMED_COMPUTERS` / `_COMPUTER_GROUPS` ship EMPTY, so `computer:` /
//     `computer_group:` only resolve where the operator registered code at
//     startup — a pack that ships one will not load on a stock engine;
//   - `resolve_extends` follows `extends:` through the discovery dirs, which
//     the studio cannot see, so a patch's base is never resolved here.

import { parseDocument, visit } from "yaml"
import type { Issue } from "../model"

/** `core/rulepacks.py::_build_rulepack` — every section it reads. */
export const RULEPACK_SECTIONS = [
  "extends",
  "names",
  "defaults",
  "alias",
  "st_show",
  "set_keys",
  "creation_constraints",
  "derived",
  "display",
  "labels",
  "resolution",
  "subsystems",
  "expertise",
  "commands",
  "sheet",
  "initiative",
  "turn_checks",
] as const

/** `core/rulepacks.py::_compile_derived_spec`, in dispatch order. */
const DERIVED_OPS = ["computer", "computer_group", "copy_of", "half_of", "floor_div", "expr", "sum_ranges"]

/** `core/rulepacks.py::_TURN_CHECK_KEYS`. */
const TURN_CHECK_KEYS = new Set(["id", "when", "condition", "instruction", "max_rounds", "enabled"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export interface RulepackReading {
  /** Advisory findings, worst first. */
  issues: Issue[]
  /** What the pack declares, for the editor's summary line. */
  summary: {
    extends: string
    stats: number
    derived: number
    subsystems: number
    commands: number
    hasResolution: boolean
    hasSheet: boolean
    /** Rules-script file names this YAML declares — `core/pack.py`'s
     * `_rulepack_script_files`, same two places, same bare-name rule. Each one
     * must ship beside the YAML or the pack does not build. */
    scripts: string[]
  }
}

const EMPTY_SUMMARY: RulepackReading["summary"] = {
  extends: "",
  stats: 0,
  derived: 0,
  subsystems: 0,
  commands: 0,
  hasResolution: false,
  hasSheet: false,
  scripts: [],
}

/** `core/pack.py::_rulepack_script_files` — the two places a rulepack may name
 * a rules script, and the bare-name rule both are held to. */
function declaredScripts(data: Record<string, unknown>): { names: string[]; bad: string[] } {
  const raw: string[] = []
  if (isRecord(data.resolution) && typeof data.resolution.script === "string") {
    raw.push(data.resolution.script.trim())
  }
  if (isRecord(data.subsystems)) {
    for (const spec of Object.values(data.subsystems)) {
      if (isRecord(spec) && typeof spec.script === "string") raw.push(spec.script.trim())
    }
  }
  const names: string[] = []
  const bad: string[] = []
  for (const name of raw) {
    if (!name || name.includes("/") || name.includes("\\")) bad.push(name)
    else names.push(name)
  }
  return { names: [...new Set(names)].sort(), bad }
}

function countKeys(value: unknown): number {
  return isRecord(value) ? Object.keys(value).length : 0
}

/** Read + advisory-validate one rulepack YAML. Never throws. */
export function readRulepack(yamlText: string): RulepackReading {
  const issues: Issue[] = []
  if (!yamlText.trim()) return { issues, summary: EMPTY_SUMMARY }

  let doc
  try {
    doc = parseDocument(yamlText, { schema: "yaml-1.1", uniqueKeys: false })
  } catch (cause) {
    return {
      issues: [
        { key: "rulepackYaml", params: { detail: cause instanceof Error ? cause.message : String(cause) } },
      ],
      summary: EMPTY_SUMMARY,
    }
  }
  const error = doc.errors[0]
  if (error !== undefined) {
    return {
      issues: [
        {
          key: "rulepackYamlAt",
          params: { line: error.linePos?.[0]?.line ?? 0, detail: error.message },
        },
      ],
      summary: EMPTY_SUMMARY,
    }
  }
  // The engine's loader rejects anchors/aliases outright rather than expanding
  // them (`core/yaml_safety.safe_load_no_aliases`), so a pack that uses one
  // will not load at all — that is worth saying before the build says it.
  let hasAlias = false
  visit(doc, {
    Alias: () => {
      hasAlias = true
      return visit.BREAK
    },
  })
  if (hasAlias) return { issues: [{ key: "rulepackAlias" }], summary: EMPTY_SUMMARY }

  const data: unknown = doc.toJS()
  if (!isRecord(data)) return { issues: [{ key: "rulepackNotMapping" }], summary: EMPTY_SUMMARY }

  const known = new Set<string>(RULEPACK_SECTIONS)
  for (const key of Object.keys(data)) {
    if (!known.has(key)) issues.push({ key: "rulepackUnknownSection", params: { section: key } })
  }

  const extendsValue = data.extends
  if (extendsValue !== undefined && typeof extendsValue !== "string") {
    issues.push({ key: "rulepackExtendsType" })
  }

  for (const section of ["defaults", "alias", "st_show", "derived", "creation_constraints"]) {
    if (data[section] !== undefined && !isRecord(data[section])) {
      issues.push({ key: "rulepackSectionMapping", params: { section } })
    }
  }
  for (const section of ["names", "set_keys", "turn_checks"]) {
    if (data[section] !== undefined && !Array.isArray(data[section])) {
      issues.push({ key: "rulepackSectionList", params: { section } })
    }
  }

  if (isRecord(data.defaults)) {
    for (const [stat, value] of Object.entries(data.defaults)) {
      if (typeof value !== "number" && typeof value !== "string" && typeof value !== "boolean") {
        issues.push({ key: "rulepackDefaultScalar", params: { stat } })
      }
    }
  }

  if (isRecord(data.alias)) {
    for (const [stat, value] of Object.entries(data.alias)) {
      if (!Array.isArray(value)) issues.push({ key: "rulepackAliasList", params: { stat } })
    }
  }

  const defaults = isRecord(data.defaults) ? data.defaults : {}
  if (isRecord(data.derived)) {
    for (const [stat, spec] of Object.entries(data.derived)) {
      issues.push(...readDerived(stat, spec, defaults))
    }
  }

  if (Array.isArray(data.turn_checks)) {
    data.turn_checks.forEach((row, index) => {
      if (!isRecord(row)) {
        issues.push({ key: "rulepackTurnCheckMapping", params: { index: index + 1 } })
        return
      }
      for (const key of Object.keys(row)) {
        if (!TURN_CHECK_KEYS.has(key)) {
          issues.push({ key: "rulepackTurnCheckKey", params: { index: index + 1, field: key } })
        }
      }
      if (!String(row.when ?? row.condition ?? "").trim()) {
        issues.push({ key: "rulepackTurnCheckWhen", params: { index: index + 1 } })
      }
    })
  }

  // `_parse_initiative_section`: a MAPPING carrying a non-empty string `roll`,
  // and nothing else will do — a bare `initiative: 1d20+DEX` raises. The shape
  // reads like a scalar and is not one, which is exactly why it is worth saying
  // here rather than letting the build say it.
  if (data.initiative !== undefined) {
    const roll = isRecord(data.initiative) ? data.initiative.roll : undefined
    if (typeof roll !== "string" || !roll.trim()) {
      issues.push({ key: "rulepackInitiativeRoll" })
    }
  }

  const scripts = declaredScripts(data)
  for (const name of scripts.bad) {
    issues.push({ key: "rulepackScriptBareName", params: { file: name } })
  }

  // A pack that is neither a patch nor a system says nothing to the engine.
  if (extendsValue === undefined && Object.keys(data).length > 0) {
    const substantive = ["defaults", "derived", "resolution", "subsystems", "sheet", "commands"]
    if (!substantive.some((section) => data[section] !== undefined)) {
      issues.push({ key: "rulepackThin" })
    }
  }

  return {
    issues,
    summary: {
      extends: typeof extendsValue === "string" ? extendsValue : "",
      stats: countKeys(data.defaults),
      derived: countKeys(data.derived),
      subsystems: countKeys(data.subsystems),
      commands: countKeys(data.commands),
      hasResolution: data.resolution !== undefined,
      hasSheet: data.sheet !== undefined,
      scripts: scripts.names,
    },
  }
}

function readDerived(stat: string, spec: unknown, defaults: Record<string, unknown>): Issue[] {
  if (!isRecord(spec)) return [{ key: "rulepackDerivedMapping", params: { stat } }]
  const op = DERIVED_OPS.find((candidate) => candidate in spec)
  if (op === undefined) {
    return [{ key: "rulepackDerivedOp", params: { stat, ops: DERIVED_OPS.join(", ") } }]
  }
  const issues: Issue[] = []
  if (op === "computer" || op === "computer_group") {
    // The engine ships both registries EMPTY; only an operator who registered
    // real Python at startup can resolve one. Saying so here is the whole
    // difference between "my pack does not load" and "of course it doesn't".
    issues.push({ key: "rulepackDerivedComputer", params: { stat, op } })
  }
  if (op === "floor_div") {
    const params = spec.floor_div
    if (!isRecord(params) || params.of === undefined || params.by === undefined) {
      issues.push({ key: "rulepackDerivedFloorDiv", params: { stat } })
    }
  }
  if (op === "sum_ranges") {
    const params = spec.sum_ranges
    if (!isRecord(params) || params.of === undefined || params.ranges === undefined) {
      issues.push({ key: "rulepackDerivedSumRanges", params: { stat } })
    }
  }
  if (op === "expr") {
    const unknown = Object.keys(spec).filter((key) => key !== "expr" && key !== "format")
    if (unknown.length > 0) {
      issues.push({ key: "rulepackDerivedExprKeys", params: { stat, keys: unknown.join(", ") } })
    }
    if (typeof spec.expr !== "string" || !spec.expr.trim()) {
      issues.push({ key: "rulepackDerivedExprText", params: { stat } })
    }
  }
  // A primitive that names a stat nothing declares is not fatal (the engine
  // falls back to 0), but it is almost always a typo.
  const named =
    op === "copy_of" || op === "half_of"
      ? [spec[op]]
      : op === "floor_div" && isRecord(spec.floor_div)
        ? [spec.floor_div.of]
        : op === "sum_ranges" && isRecord(spec.sum_ranges) && Array.isArray(spec.sum_ranges.of)
          ? spec.sum_ranges.of
          : []
  for (const name of named) {
    if (typeof name === "string" && name && !(name in defaults)) {
      issues.push({ key: "rulepackDerivedUnknownStat", params: { stat, of: name } })
    }
  }
  return issues
}
