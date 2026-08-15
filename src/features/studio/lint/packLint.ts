// The advisory pack lint: rules over a pack's authored content.
//
// Why it exists: the engine CLI already refuses packs that cannot BUILD. What
// nothing catches is the pack that builds perfectly and then does nothing —
// a lore entry with no trigger, a variable nobody reads, and above all a panel
// bound to a keeper-only variable, which renders blank for every player while
// looking right to the author (who is the keeper). That last one is the trap
// the exposure model creates, and it is the reason this file exists.
//
// Every finding is advisory. Nothing here blocks a build; the engine stays the
// authority, and the author outranks the lint.

import type { LintCodeBlock, PackLintFinding, PackLintSource } from "./model"
import { conditionVarPaths, readPanels, type LintPanel } from "./panels"

/** Hook bodies that are placeholders, shipped as-is.
 *
 * The first is what the wizard emits today when the variables stage produced no
 * usable rule (`wizard/updateRules.ts::NO_RULES_MARKER`); the second is the
 * `// TODO` body every wizard run emitted before that stage learned to compile
 * real `setvar`/`incvar` calls, and packs authored then still carry it. Either
 * way the meaning is the same: this hook does nothing. */
export const STUB_MARKERS = [
  "// No update rules were entered, so there is nothing to apply yet.",
  "// TODO: apply the rules above with setvar/incvar",
]

/** @deprecated Use {@link STUB_MARKERS}; kept so a single-marker import still
 * resolves to the current one. */
export const STUB_MARKER = STUB_MARKERS[0]

/** Variable reads/writes in hook code. Mirrors the bridge `docs/plugins.md`
 * documents: `getvar()` / `setvar()` / `incvar()` plus the `variables.<path>`
 * and `stat_data.<path>` objects. */
const CODE_VAR_CALL_RE = /\b(?:get|set|inc)var\s*\(\s*(['"`])([^'"`]+)\1/g
const CODE_VAR_PATH_RE = /\b(?:variables|stat_data)\.([\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*)/gu

/** ST + native worldbook macros (`core/ejs_lite.py`: `_MACRO_GETVAR_RE`,
 * `_MACRO_VAR_RE`). */
const TEXT_MACRO_RE = /\{\{\s*(?:getvar::|var:)\s*([^{}]+?)\s*\}\}/g

function codeVarPaths(source: string): string[] {
  const paths: string[] = []
  const push = (path: string) => {
    const trimmed = path.trim()
    if (trimmed && !paths.includes(trimmed)) paths.push(trimmed)
  }
  for (const match of source.matchAll(CODE_VAR_CALL_RE)) push(match[2])
  for (const match of source.matchAll(CODE_VAR_PATH_RE)) push(match[1])
  return paths
}

function textVarNames(text: string): string[] {
  return [...text.matchAll(TEXT_MACRO_RE)].map((match) => match[1].trim())
}

/** Does `haystack` mention `id` as a whole identifier?
 *
 * The unused-variable rule is deliberately the loosest check in the file: a
 * variable id spelled anywhere in lore, panels or code counts as a reference,
 * because the ways to name one are open-ended (macros, EJS, conditions, code,
 * prose that a hook parses). Under-reporting is the right failure mode — a
 * false "this is dead" teaches authors to ignore the lint. */
function mentionsIdentifier(haystack: string, id: string): boolean {
  if (!id) return false
  let from = 0
  for (;;) {
    const at = haystack.indexOf(id, from)
    if (at < 0) return false
    const before = haystack[at - 1] ?? " "
    const after = haystack[at + id.length] ?? " "
    if (!isIdentChar(before) && !isIdentChar(after)) return true
    from = at + 1
  }
}

const IDENT_CHAR_RE = /[\p{L}\p{N}_]/u

function isIdentChar(char: string): boolean {
  return IDENT_CHAR_RE.test(char)
}

/** A dotted path resolves against a declared variable when the whole path is
 * an id, or when its ROOT segment is (the nested-tree case: `mvu.内部.真凶`
 * lives under the declared `mvu`). */
function pathIsDeclared(path: string, declared: Set<string>): boolean {
  if (declared.has(path)) return true
  const root = path.split(".")[0]
  return declared.has(root)
}

function finding(
  ruleId: PackLintFinding["ruleId"],
  severity: PackLintFinding["severity"],
  key: string,
  params: PackLintFinding["params"],
  target: PackLintFinding["target"],
): PackLintFinding {
  return { ruleId, severity, key, params, target }
}

function lintVariablesUnused(source: PackLintSource, panels: LintPanel[], findings: PackLintFinding[]): void {
  // One haystack of everything a variable could be named in.
  const parts: string[] = [source.panelsYaml ?? ""]
  for (const entry of source.lore) parts.push(entry.title, entry.content, entry.keys, entry.condition)
  for (const block of source.code) parts.push(block.source)
  const haystack = parts.join("\n")
  const repeatPrefixes = panels.flatMap((panel) => panel.repeatPrefixes).filter(Boolean)

  for (const variable of source.variables) {
    if (!variable.id) continue
    if (mentionsIdentifier(haystack, variable.id)) continue
    // A `repeat` block renders one instance per variable under its prefix, so
    // those variables are used without ever being spelled out.
    if (repeatPrefixes.some((prefix) => variable.id.startsWith(prefix))) continue
    findings.push(
      finding(
        "variableUnused",
        "info",
        "variableUnused",
        { id: variable.id },
        {
          kind: "variable",
          id: variable.id,
        },
      ),
    )
  }
}

function lintLore(source: PackLintSource, findings: PackLintFinding[]): void {
  for (const entry of source.lore) {
    if (!entry.enabled) continue
    const hasKeys = entry.keys.split(/[\n,]/).some((key) => key.trim().length > 0)
    if (hasKeys || entry.constant || entry.condition.trim()) continue
    findings.push(
      finding(
        "loreNeverActivates",
        "warn",
        "loreNeverActivates",
        { title: entry.title || entry.id },
        {
          kind: "lore",
          id: entry.id,
        },
      ),
    )
  }
}

function lintBilingual(source: PackLintSource, panels: LintPanel[], findings: PackLintFinding[]): void {
  for (const variable of source.variables) {
    const en = variable.labelEn.trim()
    const zh = variable.labelZh.trim()
    if ((en && zh) || (!en && !zh)) continue
    findings.push(
      finding(
        "bilingualGap",
        "info",
        "bilingualGapVariable",
        { id: variable.id, missing: en ? "zh" : "en" },
        { kind: "variable", id: variable.id },
      ),
    )
  }
  for (const panel of panels) {
    for (const label of panel.labels) {
      const en = label.en.trim()
      const zh = label.zh.trim()
      if ((en && zh) || (!en && !zh)) continue
      findings.push(
        finding(
          "bilingualGap",
          "info",
          "bilingualGapPanel",
          { panel: panel.id, field: label.field, missing: en ? "zh" : "en" },
          { kind: "panel", id: panel.id },
        ),
      )
    }
  }
  const meta = source.meta
  if (meta !== null) {
    for (const [field, en, zh] of [
      ["name", meta.nameEn, meta.nameZh],
      ["description", meta.descriptionEn, meta.descriptionZh],
    ] as const) {
      if ((en.trim() && zh.trim()) || (!en.trim() && !zh.trim())) continue
      findings.push(
        finding(
          "bilingualGap",
          "info",
          "bilingualGapPack",
          { field, missing: en.trim() ? "zh" : "en" },
          { kind: "pack", id: meta.id },
        ),
      )
    }
  }
}

function lintPanelBindings(source: PackLintSource, panels: LintPanel[], findings: PackLintFinding[]): void {
  if (source.variables.length === 0) return
  const declared = new Set(source.variables.map((variable) => variable.id))
  const keeperOnly = new Set(
    source.variables.filter((variable) => variable.visibility === "keeper").map((v) => v.id),
  )
  for (const panel of panels) {
    // A keeper panel never reaches a player, so a keeper-only variable in it
    // is exactly right — the rule is about panels players actually see.
    const playerFacing = panel.audience !== "keeper"
    const seen = new Set<string>()
    for (const ref of panel.vars) {
      const key = `${ref.site}:${ref.path}`
      if (seen.has(key)) continue
      seen.add(key)
      if (!pathIsDeclared(ref.path, declared)) {
        findings.push(
          finding(
            "panelBindsUnknownVariable",
            "warn",
            "panelBindsUnknownVariable",
            { panel: panel.id, id: ref.path },
            { kind: "panel", id: panel.id },
          ),
        )
        continue
      }
      const root = declared.has(ref.path) ? ref.path : ref.path.split(".")[0]
      if (!playerFacing || !keeperOnly.has(root)) continue
      // Hidden variables are dropped before the client ever sees them, so a
      // binding renders nothing and a condition never decides true — either
      // way the block silently vanishes for every player. And a condition
      // leaks the variable's NAME on top: the string ships with the pack.
      findings.push(
        finding(
          "panelBindsHiddenVariable",
          "warn",
          ref.site === "binding" ? "panelBindsHiddenVariable" : "panelConditionHiddenVariable",
          { panel: panel.id, id: ref.path },
          { kind: "panel", id: panel.id },
        ),
      )
    }
  }
}

/** What each hook event's payload actually carries.
 *
 * `core/hooks.py:9-13` declares them and the `fire()` calls in `agent/loop.py`
 * pass exactly these dicts — both were read, not inferred. An event NOT listed
 * here is never checked, so an engine that grows one cannot produce a false
 * finding here; it just gets no coverage until this table catches up. */
const EVENT_PAYLOAD_KEYS: Record<string, readonly string[]> = {
  turn_start: ["user_message", "actor"],
  reply_ready: ["reply"],
  dice_rolled: ["rolls"],
  variables_changed: ["writes"],
  clock_advanced: ["from", "to", "delta"],
}

/** `on('<event>', <handler>)` with the handler's own parameter name. Covers the
 * three shapes hooks are written in: `(e) => …`, `e => …`, `function (e) {…}`.
 * A handler that takes no parameter reads nothing off the event and is skipped. */
const ON_HANDLER_RE =
  /\bon\s*\(\s*(['"`])([a-z_]+)\1\s*,\s*(?:function\s*)?\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*(?:=>|\{)/g

/** Reads of `<param>.<key>` — the only way a handler can touch its payload. */
function eventFieldReads(segment: string, param: string): string[] {
  const re = new RegExp(`\\b${param}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, "g")
  return [...segment.matchAll(re)].map((match) => match[1])
}

/** Hook handlers reading a field their event does not deliver.
 *
 * The failure this catches is silence, not an error: JavaScript answers
 * `undefined`, the guard is false forever, and the handler does nothing while
 * looking correct. Nothing else in the toolchain says a word about it — the
 * pack builds, the hook loads, the sandbox runs it, and no variable moves. */
function lintHookEventFields(source: PackLintSource, findings: PackLintFinding[]): void {
  for (const block of source.code) {
    for (const match of [...block.source.matchAll(ON_HANDLER_RE)]) {
      const known = EVENT_PAYLOAD_KEYS[match[2]]
      if (known === undefined) continue
      const param = match[3]
      // Scope to this handler: everything up to the next `on(` registration, or
      // the end. Coarse, but a hook file is small and a later handler's reads
      // would only be attributed to the wrong (still-real) finding.
      const start = match.index + match[0].length
      const nextOn = block.source.slice(start).search(/\bon\s*\(\s*['"`]/)
      const segment = nextOn < 0 ? block.source.slice(start) : block.source.slice(start, start + nextOn)

      const seen = new Set<string>()
      for (const field of eventFieldReads(segment, param)) {
        if (known.includes(field) || seen.has(field)) continue
        seen.add(field)
        findings.push(
          finding(
            "hookUnknownEventField",
            "warn",
            "hookUnknownEventField",
            { origin: block.origin, event: match[2], field, known: known.join(", ") },
            { kind: "code", id: block.origin },
          ),
        )
      }
    }
  }
}

function lintCode(source: PackLintSource, findings: PackLintFinding[]): void {
  const declared = new Set(source.variables.map((variable) => variable.id))
  for (const block of source.code) {
    if (STUB_MARKERS.some((marker) => block.source.includes(marker))) {
      findings.push(
        finding(
          "stubMarker",
          "warn",
          "stubMarker",
          { origin: block.origin },
          {
            kind: "code",
            id: block.origin,
          },
        ),
      )
    }
    if (declared.size === 0) continue
    const seen = new Set<string>()
    for (const path of codeVarPaths(block.source)) {
      if (seen.has(path) || pathIsDeclared(path, declared)) continue
      seen.add(path)
      findings.push(
        finding(
          "codeUnknownVariable",
          "warn",
          "codeUnknownVariable",
          { origin: block.origin, id: path },
          { kind: "code", id: block.origin },
        ),
      )
    }
  }
}

function lintLoreMacros(source: PackLintSource, findings: PackLintFinding[]): void {
  const declared = new Set(source.variables.map((variable) => variable.id))
  if (declared.size === 0) return
  for (const entry of source.lore) {
    const seen = new Set<string>()
    const paths = [...textVarNames(entry.content), ...conditionVarPaths(entry.condition)]
    for (const path of paths) {
      if (seen.has(path) || pathIsDeclared(path, declared)) continue
      seen.add(path)
      findings.push(
        finding(
          "codeUnknownVariable",
          "warn",
          "loreUnknownVariable",
          { title: entry.title || entry.id, id: path },
          { kind: "lore", id: entry.id },
        ),
      )
    }
  }
}

function lintPackMetadata(source: PackLintSource, findings: PackLintFinding[]): void {
  const meta = source.meta
  if (meta === null) return
  if (!meta.descriptionEn.trim() && !meta.descriptionZh.trim()) {
    findings.push(
      finding("packMetadataThin", "warn", "packDescriptionMissing", {}, { kind: "pack", id: meta.id }),
    )
  }
  if (!meta.license.trim()) {
    findings.push(
      finding("packMetadataThin", "warn", "packLicenseMissing", {}, { kind: "pack", id: meta.id }),
    )
  }
}

function lintAssets(source: PackLintSource, panels: LintPanel[], findings: PackLintFinding[]): void {
  // Nothing shipped at all means the session has no file list to check
  // against (the forge, an adopted source tree) — not that every ref is dead.
  if (source.shippedFiles.length === 0) return
  const shipped = new Set(source.shippedFiles)
  const report = (path: string, from: string) => {
    if (shipped.has(path)) return
    findings.push(
      finding("assetMissing", "warn", "assetMissing", { path, from }, { kind: "asset", id: path }),
    )
  }
  for (const panel of panels) {
    for (const src of panel.images) report(src, panel.id)
  }
  for (const ref of source.assetRefs) report(ref.path, ref.from)
}

/** The three serialization rules (Batch 5).
 *
 * They exist because the model deliberately has NO gating machinery: what makes
 * a release spoiler-safe is that the file simply does not contain future
 * content. That is only true if the tags are right, so the tags are what gets
 * checked.
 *
 * Quiet for a pack with no episodes — an ordinary one-shot must not grow
 * findings about a feature it does not use. */
function lintEpisodes(source: PackLintSource, findings: PackLintFinding[]): void {
  const episodes = source.episodes
  if (episodes.length === 0) return
  const byId = new Map(episodes.map((episode) => [episode.id, episode]))
  const upTo = source.buildUpTo > 0 ? source.buildUpTo : Math.max(...episodes.map((e) => e.ordinal))

  // 1. A tag nothing declares. The BUILD includes such content rather than
  //    dropping it (a typo must not silently cut an author's work), so this is
  //    the only thing that will tell them.
  for (const entry of source.lore) {
    const tag = (entry.episode ?? "").trim()
    if (!tag || byId.has(tag)) continue
    findings.push(
      finding(
        "episodeUnknown",
        "warn",
        "episodeUnknown",
        { title: entry.title || entry.id, tag },
        { kind: "lore", id: entry.id },
      ),
    )
  }
  // …and the same rule over whole FILES. An asset carries no entries for a
  // typo to surface through, so without this its tag was checked by nobody:
  // the build would include it (unknown tag = included, deliberately) and
  // nothing would ever say the episode it named does not exist.
  for (const file of source.taggedFiles) {
    const tag = file.episode.trim()
    if (!tag || byId.has(tag)) continue
    findings.push(
      finding(
        "episodeUnknown",
        "warn",
        "episodeUnknown",
        { title: file.path, tag },
        {
          kind: "asset",
          id: file.path,
        },
      ),
    )
  }

  // 2. An episode that ships with nothing to say about itself. The changelog is
  //    what a subscriber reads to find out the new chapter arrived.
  for (const episode of episodes) {
    if (episode.ordinal > upTo) continue
    if (episode.releaseNotes.trim()) continue
    findings.push(
      finding(
        "episodeNoNotes",
        "warn",
        "episodeNoNotes",
        { ordinal: episode.ordinal, title: episode.title || episode.id },
        { kind: "episode", id: episode.id },
      ),
    )
  }

  // 3. An earlier episode's content naming a later one's. In a cumulative pack
  //    the reference is not broken — episode 4's release contains episode 2 —
  //    but at the release that ships episode 2, it dangles, and that release is
  //    the one someone is reading right now.
  const laterTitles = episodes
    .filter((episode) => episode.ordinal > 1)
    .map((episode) => ({ episode, title: episode.title.trim() }))
    .filter((row) => row.title.length >= 2)
  if (laterTitles.length > 0) {
    for (const entry of source.lore) {
      const ordinal = byId.get((entry.episode ?? "").trim())?.ordinal ?? 1
      const haystack = `${entry.title}\n${entry.content}`
      for (const row of laterTitles) {
        if (row.episode.ordinal <= ordinal) continue
        if (!haystack.includes(row.title)) continue
        findings.push(
          finding(
            "episodeForwardReference",
            "info",
            "episodeForwardReference",
            { title: entry.title || entry.id, ordinal, ahead: row.episode.ordinal, name: row.title },
            { kind: "lore", id: entry.id },
          ),
        )
      }
    }
  }
}

/** Run every rule. Findings come back grouped by rule, in rule order, so the
 * panel reads as a checklist rather than a stream. */
export function lintPack(source: PackLintSource): PackLintFinding[] {
  const panels = source.panelsYaml === null ? [] : readPanels(source.panelsYaml)
  const findings: PackLintFinding[] = []
  lintVariablesUnused(source, panels, findings)
  lintLore(source, findings)
  lintBilingual(source, panels, findings)
  lintPanelBindings(source, panels, findings)
  lintCode(source, findings)
  lintHookEventFields(source, findings)
  lintLoreMacros(source, findings)
  lintPackMetadata(source, findings)
  lintAssets(source, panels, findings)
  lintEpisodes(source, findings)
  return findings
}

/** Counts for the toolbar badge. */
export function lintSummary(findings: PackLintFinding[]): { warn: number; info: number } {
  let warn = 0
  let info = 0
  for (const item of findings) {
    if (item.severity === "warn") warn += 1
    else info += 1
  }
  return { warn, info }
}

export type { LintCodeBlock }
