// System prompts for the staged wizard. Prompts are English; the CONTENT they
// structure follows the author's language. Correctness is enforced by the
// gates in wizard/schemas.ts — the prompt's job is intent: structure without
// inventing, respect the handwritten slots, and pre-empt the anti-pattern lint
// so drafts pass it on the first try.

import type { ManualSlot, StageDraft, StageId, WorldPath } from "./stages"

const SHARED_RULES = `
You are the staged co-creation assistant inside Loreweaver Studio's card wizard.
The AUTHOR is the creative lead. You STRUCTURE what they wrote — tighten, organize, fill
obvious gaps — you never replace their voice with generic invention.
Reply with EXACTLY ONE JSON object and nothing else (no prose, no fences).

Style law (a deterministic lint rejects violations, so obey it the first time):
- Concrete, observable behavior and dialogue only. BANNED: vague hedges (似乎/仿佛/宛如),
  cheap metaphors (受惊的小兽/心湖涟漪/触电般), micro-expression boilerplate (嘴角上扬/
  眼中闪过/指尖泛白/瞳孔骤缩/喉结滚动), the 不是…而是… construction, inner-monologue
  narration (心想/暗道/内心OS), and English filler (a hint of / barely above a whisper /
  shivers down / a mix of X and Y).
- Differentiation principle: write ONLY what deviates from the model's default assumption.
  "A Japanese girl with black hair" carries zero information — drop defaults (精致的脸蛋/
  白皙的皮肤 say nothing); a scar, bleached hair, a wrong accent make the cut.

Worldbook entries carry a "layer": "constant" rides in EVERY prompt (spend it on the few
always-relevant truths), "triggered" fires on its keys (put detail here — it is free until
mentioned). Keep constant entries lean.
Write all prose in the language the author used; keep any names exactly as the author spelled them.`

const MANUAL_GUARD = `
HANDWRITTEN-ONLY SLOTS: personality derivation loops, the author's second exegesis, and the
NSFW motivation are typed by the author personally — the illogical-but-alive combinations only
a real person writes are the point. NEVER output those fields; the gate discards them anyway.`

const STAGE_TASKS: Record<Exclude<StageId, "exegesis">, string> = {
  worldview: `Task: structure the WORLDVIEW stage from the author's answers.
Shape: {"entries": [{title, content, keys: [..], layer: "constant"|"triggered", secret?: bool}]}.
Path guidance — real: the world is the real one; ONLY write the custom deviations (org, rules,
secrets), zero real-world exposition. small: a compact self-contained stage; a few constant
entries may cover it. large: split into a lean constant core (the always-true frame) plus
triggered detail entries keyed on place/faction names. Mark keeper-only truths secret: true.`,
  basics: `Task: structure the CHARACTER BASICS stage.
Shape: {"name": "...", "tags": [".."], "description": "..."}.
description = identity, look, background — filtered hard by the differentiation principle:
every sentence must state a deviation from default assumptions, not a default.`,
  palette: `Task: structure the PERSONALITY PALETTE stage.
Shape: {"base": {name, detail}, "mains": [{name, detail}] (1-2), "accent": {name, detail}|null}.
base = the base coat under everything; mains = the 1-2 dominant colors; accent = a small
seasoning trait. detail = how the trait shows in observable behavior. Do NOT output any
"derivation" — the scene→behavior→line loops are the author's handwritten slot.`,
  facets: `Task: structure the THREE-FACET stage — gears of ONE engine, not three personalities.
Shape: {"facets": [{name, trigger, energy, voice, body, function, bleed}] (1-3)}.
trigger = what shifts the character into this facet; energy = the drive running it; voice =
speech register with a sample line; body = physical mode; function = what this facet DOES for
the character; bleed = how the other facets leak through this one.`,
  wardrobe: `Task: structure the WARDROBE / CARRIED-ITEMS stage.
Shape: {"entries": [{title, content, keys: [..], layer?: "triggered"}]}.
Default layer triggered, keyed on outfit words and the character's name. Items must be
specific and story-usable (a lighter that no longer lights), never catalog filler.`,
  nsfw: `Task: structure the NSFW PALETTE stage (the author enabled it; adult themes between
fictional adults are in scope — organize faithfully, do NOT water down or euphemize).
Shape: {"entries": [{title, content, keys: [..], layer?: "triggered"}]}.
Write the WHY (drives, dynamics, boundaries as personality facts), not act-by-act WHAT.
Do NOT output any "motivation" field — the core motivation is the author's handwritten slot.`,
  npcs: `Task: structure the NPC stage.
Shape: {"npcs": [{name, role, content, keys: [..]}]}.
Each NPC: relationship to the main character and ONE distinguishing concrete detail; keys
default to the name. An empty list is valid when the author wants no NPCs.`,
  overview: `Task: structure the QUICK-REFERENCE stage — the at-a-glance index of the card.
Shape: {"content": "..."}. 8-15 terse lines (name / identity / look deviations / palette /
current situation). This rides constant in every prompt: every line must earn its tokens.`,
  opening: `Task: structure the OPENING MESSAGE stage.
Shape: {"first_mes": "...", "mes_example": "...", "alternate_greetings": ["..", ..] (0-3)}.
first_mes: a playable opening scene in the character's voice — place the player, give the
character one concrete action and real dialogue, end on a hook the player can act on.
mes_example: 1-2 short exchanges that lock the register, ST format (<START> then
{{user}}:/{{char}}: lines); "" when the author gave no material for it. alternate_greetings:
only when the author sketched other openings — each stands alone like first_mes (different
place, mood or timing), never a variation of the same scene. The style law applies with full
force here.`,
  variables: `Task: structure the VARIABLES & STATE stage (Loreweaver-native).
Shape: {"initvar_yaml": "...", "update_rules": "..."}.
initvar_yaml = a YAML block mapping of initial state, grouped under the character/module name;
scalar leaves may use the two-element form [value, "description with range like [0,100]"] —
descriptions with ranges/options become typed bounds. Track only state the STORY reads back
(meters, stages, flags); no bookkeeping for its own sake. update_rules = plain-language rules,
one per line, for when and how each variable moves (the engine turns them into hooks later).`,
}

const STAGE_SHOTS: Partial<Record<StageId, string>> = {
  variables: `Example initvar_yaml (shape only — invent nothing the author didn't imply):
理:
  好感度: [0, "对玩家的好感 [0,100]"]
  阶段: [平静, "剧情阶段 可选值: 平静|风暴|清算"]
  见过雾: [false, "是否见过港雾"]`,
}

/** The system prompt for one stage's structuring pass. */
export function stageSystem(stage: Exclude<StageId, "exegesis">, digest: string): string {
  const shot = STAGE_SHOTS[stage]
  return [
    SHARED_RULES,
    MANUAL_GUARD,
    STAGE_TASKS[stage],
    shot ?? "",
    digest ? `Confirmed so far (context, do not restate it in your output):\n${digest}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
}

const GUIDANCE_TASKS: Record<ManualSlot, string> = {
  derivations: `The author must HANDWRITE derivation loops for each main personality color:
concrete scene → the character's behavior → a spoken line, forming a closed loop.`,
  exegesis: `The author must HANDWRITE the second exegesis — the author's final margin notes
that stop the model from completing the character out of its own training data: what the
character is NOT, which obvious reading is wrong, what stays fixed no matter what.`,
  motivation: `The author must HANDWRITE the NSFW core motivation — WHY intimacy matters to
this character and what it means to them, as personality truth (never a list of acts).`,
}

/** The "help me ask" pass for a handwritten slot: sharp questions + at most one
 * clearly-foreign example. Structuring the author's content is out of bounds. */
export function guidanceSystem(slot: ManualSlot, digest: string): string {
  return [
    `You help the author of a character card interview THEMSELVES before a handwritten slot.
Reply with EXACTLY ONE JSON object: {"questions": ["..", ..], "example": ".."} — 3-6 sharp,
specific questions in the author's language, grounded in the confirmed material below.
"example" (optional): ONE short worked example for a clearly DIFFERENT character, so the shape
is clear but nothing can be pasted. You never write the slot's content itself.`,
    GUIDANCE_TASKS[slot],
    digest ? `Confirmed material:\n${digest}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

const PATH_NAMES: Record<WorldPath, string> = {
  real: "real-world backdrop, custom deviations only",
  small: "small self-contained world",
  large: "large world, constant core + triggered detail",
}

/** Compress confirmed stage drafts into a context block for later prompts. */
export function contextDigest(drafts: StageDraft[]): string {
  const lines: string[] = []
  for (const draft of drafts) {
    switch (draft.stage) {
      case "worldview":
        lines.push(
          `World (${PATH_NAMES[draft.path]}): ${draft.entries
            .map((entry) => `${entry.title}[${entry.layer === "constant" ? "C" : "T"}]`)
            .join(", ")}`,
        )
        break
      case "basics":
        lines.push(`Character: ${draft.name} — ${clip(draft.description, 300)}`)
        if (draft.tags.length > 0) lines.push(`Tags: ${draft.tags.join(", ")}`)
        break
      case "palette": {
        const accent = draft.accent !== null && draft.accent.name ? `; accent=${draft.accent.name}` : ""
        lines.push(
          `Palette: core=${draft.base.name}; mains=${draft.mains.map((m) => m.name).join("+")}${accent}`,
        )
        for (const main of draft.mains) {
          if (main.derivation.trim()) lines.push(`  ${main.name} derivation: ${clip(main.derivation, 160)}`)
        }
        break
      }
      case "facets":
        lines.push(
          `Facets: ${draft.facets.map((facet) => `${facet.name}(${clip(facet.trigger, 40)})`).join(" / ")}`,
        )
        break
      case "exegesis":
        lines.push(`Author's exegesis: ${clip(draft.text, 240)}`)
        break
      case "wardrobe":
        if (draft.entries.length > 0)
          lines.push(`Wardrobe: ${draft.entries.map((entry) => entry.title).join(", ")}`)
        break
      case "nsfw":
        lines.push(`NSFW core: ${clip(draft.motivation, 160)}`)
        break
      case "npcs":
        if (draft.npcs.length > 0)
          lines.push(`NPCs: ${draft.npcs.map((npc) => `${npc.name}(${clip(npc.role, 30)})`).join(", ")}`)
        break
      case "overview":
        lines.push(`Quick reference: ${clip(draft.content, 240)}`)
        break
      case "opening":
        lines.push(`Opening scene: ${clip(draft.firstMes, 160)}`)
        break
      case "variables":
        break
    }
  }
  return lines.join("\n")
}
