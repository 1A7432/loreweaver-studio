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

import {
  BLOCK_FIELDS,
  MAX_CHOICE_OPTIONS,
  PANEL_AUDIENCES,
  PANEL_SLOTS,
  documentFromRaw,
  isOpaqueBlock,
  isOpaquePanel,
  problemsFor,
} from "./panelsModel"
import type { LintVariable } from "../lint/model"
import type { PanelSlot, PanelsDocument } from "./panelsModel"

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

/** What each panel slot means to a client — `core/panels.py` `PANEL_SLOTS`, in the
 * words `docs/authoring.md` uses. Generated from the same list the editor offers. */
function slotVocabulary(): string {
  // `Record<PanelSlot, …>`: a slot the engine grows must be described here to compile.
  const meaning: Record<PanelSlot, string> = {
    sidebar: "always in view beside the log — a glance, not a report",
    tray: "a collapsible drawer the player opens when they want it — reference material, things in hand",
    modal: "opened on demand and shown large — a map, a document to read closely",
  }
  return PANEL_SLOTS.map((slot) => `- ${slot}: ${meaning[slot]}`).join("\n")
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

Slots — where a panel lives:
${slotVocabulary()}

Block kinds and their fields (a "?" marks an optional field):
${blockVocabulary()}

Field types:
- localized: {"en": "…", "zh": "…"} — write BOTH languages.
- scalar: a number or string literal, OR a live binding {"$var": "<variable id>"}.
- path: a pack-relative file path, e.g. "assets/map.png". Only use one the author named. Never a binding.
- enum: exactly one of the listed words. Never a binding.
- options: a list of {"id": "<short-id>", "label": <localized>, "input": "<the text the client sends when this option is picked>"} — 1 to ${MAX_CHOICE_OPTIONS} entries.

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
  // A block outside the vocabulary is carried through verbatim for a HUMAN author;
  // from a model it is a wrong answer, and it goes back as one.
  const unknown: string[] = []
  for (const panel of document.panels) {
    if (isOpaquePanel(panel)) {
      unknown.push(
        `panel "${panel.id || "(unnamed)"}": draft a modeled panel, not one with its own HTML/entry`,
      )
      continue
    }
    for (const [index, block] of panel.blocks.entries()) {
      if (isOpaqueBlock(block))
        unknown.push(
          `panel "${panel.id || "(unnamed)"}" block ${index + 1}: "${block.kind}" is not a block kind — use only the kinds listed`,
        )
    }
  }
  if (unknown.length > 0) return { value: null, problems: unknown }
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
      case "leafOutsideRepeat":
        return `${params.at}: "${params.field}" uses {"$leaf"} but the block is not inside a repeat`
      case "bindingNotAllowed":
        return `${params.at}: "${params.field}" must be a plain value, not a binding`
      case "tooManyOptions":
        return `${params.at}: at most ${params.max} options`
      case "optionIncomplete":
        return `${params.at}: every option needs an id, a label and an input`
      case "unknownSlot":
        return `panel "${params.panel}": slot "${params.slot}" is not one of ${PANEL_SLOTS.join("|")}`
      case "unknownAudience":
        return `panel "${params.panel}": audience "${params.audience}" is not one of ${PANEL_AUDIENCES.join("|")}`
      case "unknownKeys":
        return `${params.at}: unknown keys ${params.keys} — the engine accepts no extra keys`
      default:
        return `${params.at ?? ""} ${problem.key}`.trim()
    }
  })
  return problems.length > 0 ? { value: null, problems } : { value: document, problems: [] }
}
