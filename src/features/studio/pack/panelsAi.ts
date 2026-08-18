// Drafting a module's panels from a description.
//
// Same shape as every other AI lane here (`ai/AiPanel.tsx`): natural language →
// model → DETERMINISTIC validation → the ordinary editor. A draft that fails
// validation never lands; its problems go back to the model, which gets a few tries
// to fix them (`draftWithRetries`), and whatever survives is an ordinary panel the
// author can then edit by hand. Nothing here writes a file.
//
// The prompt's block vocabulary is GENERATED from `BLOCK_FIELDS`, not typed out, so
// the model is never told about a field the editor does not have (or the other way
// round) — the two cannot drift.

import { BLOCK_FIELDS, PANEL_AUDIENCES, PANEL_SLOTS, documentFromRaw, problemsFor } from "./panelsModel"
import type { LintVariable } from "../lint/model"
import type { PanelsDocument } from "./panelsModel"

function blockVocabulary(): string {
  return Object.entries(BLOCK_FIELDS)
    .map(([kind, fields]) => {
      if (fields.length === 0) return `- ${kind}: no fields`
      const parts = fields.map((spec) => {
        const options = spec.options ? ` (${spec.options.join("|")})` : ""
        return `${spec.name}${spec.required ? "" : "?"}:${spec.type}${options}`
      })
      return `- ${kind}: ${parts.join(", ")}`
    })
    .join("\n")
}

function variableList(variables: LintVariable[]): string {
  if (variables.length === 0) {
    return 'This pack declares no variables. Do not use any {"$var": …} binding.'
  }
  return variables
    .map((variable) => {
      const label = variable.labelEn || variable.labelZh || variable.id
      return `- ${variable.id} — ${label} (${variable.visibility})`
    })
    .join("\n")
}

/** The system prompt. `variables` is the pack's OWN declared list: a binding to
 * anything else resolves to nothing at the table and silently drops the block, so
 * the model is given the closed set rather than trusted to invent ids. */
export function panelsSystemPrompt(variables: LintVariable[]): string {
  return `You design module UI panels for a tabletop RPG engine. A panel is DATA, never markup: a list of blocks the client renders.

Output ONE JSON object and nothing else:
{"panels": [{"id": "<lowercase-slug>", "title": {"en": "…", "zh": "…"}, "slot": "${PANEL_SLOTS.join('" | "')}", "audience": "${PANEL_AUDIENCES.join('" | "')}", "blocks": [ … ]}]}

Block kinds and their fields (a "?" marks an optional field):
${blockVocabulary()}

Field types:
- localized: {"en": "…", "zh": "…"} — write BOTH languages.
- scalar: a number or string literal, OR a live binding {"$var": "<variable id>"}.
- path: a pack-relative file path, e.g. "assets/map.png". Only use one the author named.
- enum: exactly one of the listed words.

A block may also carry "visible_when": "<condition>" — a small expression over the
same variables (e.g. "day >= 3", "alarm == true") deciding when it is shown.

The variables this pack declares — bindings may use ONLY these:
${variableList(variables)}

Rules:
- "audience" decides who sees the panel. A panel showing anything the players have not
  learned yet must be "keeper". When in doubt, "keeper".
- A meter needs min and max, and max must be greater than min.
- Prefer few, legible panels over one crowded one. A sidebar panel is a glance, not a report.
- Titles and labels are what the table reads all session. Write them as a game would, not as a form would.`
}

export interface PanelsDraftGate {
  value: PanelsDocument | null
  problems: string[]
}

/** Validate one drafted object. The problems are the model's next prompt, so they say
 * what is wrong in words a model can act on, not i18n keys. */
export function gatePanelsDraft(parsed: unknown, variables: LintVariable[]): PanelsDraftGate {
  const { document, error } = documentFromRaw(parsed)
  if (error !== null) return { value: null, problems: [error] }
  if (document.panels.length === 0) {
    return { value: null, problems: ["the `panels` list is empty — draft at least one panel"] }
  }
  const declared = new Set(variables.map((variable) => variable.id))
  const problems = problemsFor(document, declared).map((problem) => {
    const params = problem.params ?? {}
    switch (problem.key) {
      case "badId":
        return `panel "${params.panel}": id must be a lowercase slug like "tide-board"`
      case "duplicateId":
        return `two panels share the id "${params.panel}"`
      case "noTitle":
        return `panel "${params.panel}" has no title`
      case "noBlocks":
        return `panel "${params.panel}" has no blocks`
      case "missingField":
        return `${params.at}: the required field "${params.field}" is missing`
      case "unknownVar":
        return `${params.at}: "${params.path}" is not a variable this pack declares`
      case "meterRange":
        return `${params.at}: a meter's max must be greater than its min`
      default:
        return `${params.at ?? ""} ${problem.key}`.trim()
    }
  })
  return problems.length > 0 ? { value: null, problems } : { value: document, problems: [] }
}
