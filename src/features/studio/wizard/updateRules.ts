// The wizard's plain-language variable update rules → real hook code.
//
// The variables stage asks for rules "one per line, for when and how each
// variable moves", and the shapes authors actually write are regular:
//
//   好感度: 玩家帮忙 +5
//   见过雾: 进入雾区置 true
//   信任: 实质帮助 +1;撒谎被识破 -2
//
// The variable and the OPERATION in those lines are mechanical — `+5` is
// `incvar(id, 5)`, `置 true` is `setvar(id, true)`. Only the TRIGGER is prose,
// and prose is the author's job. So this emits code that runs: each clause
// becomes a guarded call whose guard matches the trigger phrase against the
// reply text, with the phrase in a comment above it. That is a draft the author
// sharpens, not a `// TODO` they have to start from.
//
// The hook API is the one `docs/plugins.md` §C.1 documents: `on(event, fn)`,
// `getvar`/`setvar`/`incvar`. Nothing here invents an engine contract.
//
// The event PAYLOAD is a contract too, and a quieter one: `core/hooks.py:10`
// and `docs/hooks.md` both spell `reply_ready` as `event.reply`, and
// `agent/loop.py` fires it with exactly `{"reply": ...}`. A guard that read any
// other key would be undefined at run time and silent about it — every
// generated `setvar`/`incvar` would simply never fire on a live table.

import { flattenLeaves, parseInitvar } from "../split/mvu"

/** One `<trigger> <operation>` clause of a rule line. */
export interface RuleClause {
  /** The prose that says WHEN, verbatim. May be empty. */
  trigger: string
  op: { kind: "inc"; by: number } | { kind: "set"; value: string | number | boolean }
}

export interface ParsedRule {
  /** The variable as the author named it. */
  name: string
  /** Dotted path into the InitVar tree when the name resolves to exactly one
   * leaf; otherwise the bare name. */
  path: string
  clauses: RuleClause[]
  /** The original line, for the comment and for un-parseable leftovers. */
  source: string
}

// Full-width variants everywhere: these rules are written in Chinese as often
// as not, and an author who typed a full-width colon meant a colon.
const NAME_SPLIT = /[:：]/
const CLAUSE_SPLIT = /[;；]/
const INC_RE = /([+＋]|[-−–—])\s*(\d+(?:\.\d+)?)\s*$/
const SET_RE = /(?:置为|设为|设置为|置|=|＝|->|→)\s*(\S+)\s*$/

function toValue(raw: string): string | number | boolean {
  const text = raw.trim().replace(/^["'“”]|["'“”]$/g, "")
  if (/^(true|真|是|开)$/i.test(text)) return true
  if (/^(false|假|否|关)$/i.test(text)) return false
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text)
  return text
}

function parseClause(raw: string): RuleClause | null {
  const text = raw.trim()
  if (!text) return null
  const inc = INC_RE.exec(text)
  if (inc !== null) {
    const sign = inc[1] === "+" || inc[1] === "＋" ? 1 : -1
    return { trigger: text.slice(0, inc.index).trim(), op: { kind: "inc", by: sign * Number(inc[2]) } }
  }
  const set = SET_RE.exec(text)
  if (set !== null) {
    return { trigger: text.slice(0, set.index).trim(), op: { kind: "set", value: toValue(set[1]) } }
  }
  return null
}

/** Resolve an authored variable name to its full dotted path in the InitVar
 * tree. A name that matches exactly one leaf wins; anything ambiguous or absent
 * stays as written, because guessing between two `好感度` leaves would silently
 * write to the wrong one. */
function pathResolver(initvarYaml: string): (name: string) => string {
  const tree = parseInitvar(initvarYaml)
  if (tree === null) return (name) => name
  const { leaves } = flattenLeaves(tree)
  return (name) => {
    const matches = leaves.filter((leaf) => leaf.path === name || leaf.path.endsWith(`.${name}`))
    return matches.length === 1 ? matches[0].path : name
  }
}

/** Parse the rules textarea. Lines that do not carry a `<name>:` prefix, or
 * whose clauses carry no recognizable operation, come back with no clauses —
 * the emitter keeps them as comments rather than dropping the author's words. */
export function parseUpdateRules(rules: string, initvarYaml = ""): ParsedRule[] {
  const resolve = pathResolver(initvarYaml)
  const parsed: ParsedRule[] = []
  for (const line of rules.split("\n")) {
    const source = line.trim()
    if (!source || source.startsWith("#") || source.startsWith("//")) continue
    const at = source.search(NAME_SPLIT)
    if (at <= 0) {
      parsed.push({ name: "", path: "", clauses: [], source })
      continue
    }
    const name = source.slice(0, at).trim()
    const clauses = source
      .slice(at + 1)
      .split(CLAUSE_SPLIT)
      .map(parseClause)
      .filter((clause): clause is RuleClause => clause !== null)
    parsed.push({ name, path: resolve(name), clauses, source })
  }
  return parsed
}

/** JS literal for an emitted value. */
function literal(value: string | number | boolean): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value)
}

const HEADER = `// Variable update rules — generated from the wizard's rules, and a DRAFT.
// Each guard below matches the author's trigger phrase against the reply text;
// sharpen them into real conditions (dice outcomes, variable states, scene
// flags) as the module firms up. The setvar/incvar calls are already right.
// API: docs/plugins.md §C.1 — on(event, fn) · getvar/setvar/incvar.`

const STUB = `${HEADER}
on('reply_ready', () => {
  // No update rules were entered, so there is nothing to apply yet.
})
`

/** The stub the wizard used to always emit. Kept as a named export because the
 * advisory lint looks for it (`lint/packLint.ts::STUB_MARKER`). */
export const NO_RULES_MARKER = "// No update rules were entered, so there is nothing to apply yet."

/** Compile the rules textarea into a `reply_ready` handler.
 *
 * With no parseable rule at all the output is the stub — legal JS that says so
 * — rather than a handler pretending to do work. */
export function hooksFromUpdateRules(rules: string, initvarYaml = ""): string {
  const parsed = parseUpdateRules(rules, initvarYaml)
  const withClauses = parsed.filter((rule) => rule.clauses.length > 0)
  if (withClauses.length === 0) {
    if (parsed.length === 0) return STUB
    // Nothing parsed, but the author DID write rules: keep every word as a
    // comment so the intent survives into the file they will edit.
    const kept = parsed.map((rule) => `  // ${rule.source}`).join("\n")
    // i18n-exempt: emitted JavaScript, not UI — the reader is the author's
    // editor. The `置` is the rule syntax being quoted back, not a translation.
    return `${HEADER}
on('reply_ready', () => {
  // These rules did not fit the '<variable>: <trigger> <+N | 置 value>' shape,
  // so they are carried through verbatim for you to implement.
${kept}
})
`
  }

  const body: string[] = []
  for (const rule of parsed) {
    if (rule.clauses.length === 0) {
      body.push(`  // ${rule.source}`)
      continue
    }
    body.push(`  // ${rule.source}`)
    for (const clause of rule.clauses) {
      const call =
        clause.op.kind === "inc"
          ? `incvar(${JSON.stringify(rule.path)}, ${clause.op.by})`
          : `setvar(${JSON.stringify(rule.path)}, ${literal(clause.op.value)})`
      body.push(clause.trigger ? `  if (said(${JSON.stringify(clause.trigger)})) ${call}` : `  ${call}`)
    }
  }

  return `${HEADER}
on('reply_ready', (event) => {
  // Placeholder trigger: does the Keeper's reply mention the phrase the rule
  // named? Replace with the real condition wherever you have one.
  const said = (phrase) => String(event && event.reply ? event.reply : '').includes(phrase)

${body.join("\n")}
})
`
}
