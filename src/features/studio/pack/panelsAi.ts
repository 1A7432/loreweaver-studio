// Drafting panels from a description.
//
// Same shape as every other AI lane here: natural language → model → DETERMINISTIC
// validation → the ordinary editor. A draft that fails validation never lands; its problems
// go back to the model, which gets a few tries to fix them (`draftWithRetries`), and whatever
// survives is an ordinary panel the author can then edit by hand. Nothing here writes a file.
//
// The prompt's block vocabulary is GENERATED from `BLOCK_FIELDS` and the view list from the
// protocol package, so the model is never told about a field or a view the editor does not
// have. The gate is `panelsCheck.ts` — the same checks the engine makes.

import {
  BLOCK_FIELDS,
  MAX_CHOICE_OPTIONS,
  PANEL_AUDIENCES,
  PANEL_SLOTS,
  documentFromRaw,
  isOpaqueBlock,
} from "./panelsModel"
import { checkPanelsValue } from "./panelsCheck"
import { BUILT_IN_PANEL_VIEWS, bindablePaths, commandIds } from "./panelsPreview"
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

function slotVocabulary(): string {
  const meaning: Record<PanelSlot, string> = {
    sidebar: "always in view beside the log — a glance, not a report",
    tray: "a collapsible drawer the player opens when they want it — reference material, things in hand",
    modal: "opened on demand and shown large — a map, a document to read closely",
  }
  return PANEL_SLOTS.map((slot) => `- ${slot}: ${meaning[slot]}`).join("\n")
}

/** A few of each built-in view's paths, so the model binds to real ones. */
function viewVocabulary(): string {
  return BUILT_IN_PANEL_VIEWS.filter((view) => !view.startsWith("admin/"))
    .map((view) => {
      const paths = bindablePaths([{ handle: view, view }])
        .map((entry) => entry.path)
        .slice(0, 12)
      return `- ${view}: ${paths.join(", ")}`
    })
    .join("\n")
}

function variableList(variables: LintVariable[]): string {
  if (variables.length === 0) return "This pack declares no variables of its own."
  return variables
    .map((variable) => {
      const label = variable.labelEn || variable.labelZh || variable.id
      return `- ${variable.id} — ${label} (${variable.visibility === "keeper" ? "hidden from players" : "players see it"})`
    })
    .join("\n")
}

/** The system prompt. */
export function panelsSystemPrompt(variables: LintVariable[], moduleIds: string[] = []): string {
  const modules = moduleIds.filter(Boolean)
  return `You design UI panels for a tabletop RPG engine (panels 3.0). A panel is DATA, never markup: a list of blocks the client renders from the views it reads.

Output ONE JSON object and nothing else:
{"panels": [{"id": "<lowercase-slug>", "title": {"en": "…", "zh": "…"}, "slot": "${PANEL_SLOTS.join('" | "')}", "audience": "${PANEL_AUDIENCES.join('" | "')}", "views": {"<handle>": "<view name>"}, "blocks": [ … ]}]}

Slots — where a panel lives:
${slotVocabulary()}

Views — a panel declares the views it reads under short handles ([a-z][a-z0-9_]*), e.g. "views": {"me": "me"}. Every declared view MUST be read by some block. Built-in views and some of their paths (a list's element is picked by index, "resources.0", or by its id/key, "resources.hp"):
${viewVocabulary()}
${modules.length > 0 ? `The pack's modules also publish views named "<module>/<name>" (modules: ${modules.join(", ")}).` : ""}

Block kinds and their fields (a "?" marks an optional field):
${blockVocabulary()}

Field types:
- localized: {"en": "…", "zh": "…"} — write BOTH languages; OR a binding {"$view": "<handle>.<path>"}.
- scalar: a number or string literal, OR a binding {"$view": "<handle>.<path>"}.
- path: a pack file path such as "ui/map.png". Only one the author named. Never a binding.
- enum: exactly one of the listed words.
- options: 1 to ${MAX_CHOICE_OPTIONS} entries {"id": "<short-id>", "label": <localized>, "command": "<command id>", "args": {…}?}. Command ids: ${commandIds(modules).join(", ")}.

A block may carry "visible_when": "<condition>" over the same paths (e.g. "me.character.resources.hp.value > 0"): comparisons, && || !, literals — no arithmetic, no calls.
A block may be wrapped as {"repeat": {"each": "<handle>.<path to a list>", "as": "item", "block": {…}}} to show it once per element; inside it the element is the handle "item" (or the "as" you name). Repeats do not nest.

The pack's own variables are in the "variables" view: "<handle>.module.<id>.value" (and ".label"):
${variableList(variables)}

Rules:
- "audience": "admin" for a panel showing what players have not learned yet. Players' views never hold hidden values anyway.
- A meter needs min and max, and max must be greater than min.
- Prefer few, legible panels over one crowded one. A sidebar panel is a glance, not a report.
- Titles and labels are what the table reads all session. Write them as a game would, not as a form would.`
}

export interface PanelsDraftGate {
  value: PanelsDocument | null
  problems: string[]
}

/** Validate one drafted object with the engine's checks. The problems are the model's next
 * prompt, so they say what is wrong in words a model can act on. */
export function gatePanelsDraft(parsed: unknown): PanelsDraftGate {
  const { document, error } = documentFromRaw(parsed)
  if (error !== null) return { value: null, problems: [error] }
  if (document.panels.length === 0)
    return { value: null, problems: ["the `panels` list is empty — draft at least one panel"] }
  const unknown: string[] = []
  for (const panel of document.panels) {
    if (panel.kind === "page")
      unknown.push(`panel "${panel.id || "(unnamed)"}": draft a template panel (blocks), not a page`)
    for (const [index, block] of panel.blocks.entries()) {
      if (isOpaqueBlock(block)) {
        unknown.push(
          `panel "${panel.id || "(unnamed)"}" block ${index + 1}: not a block this editor knows — use only the kinds and fields listed`,
        )
      }
    }
  }
  if (unknown.length > 0) return { value: null, problems: unknown }
  const checked = checkPanelsValue(parsed)
  const problems = checked.problems.map(
    (problem) =>
      `${problem.path || "panels"}: ${problem.code}${problem.detail ? ` (${problem.detail})` : ""}`,
  )
  return problems.length > 0 ? { value: null, problems } : { value: document, problems: [] }
}
