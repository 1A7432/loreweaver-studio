// The anti-pattern lint — the wizard's "absolute zero" list as a first-class
// deterministic gate. Two families of rules run over prose:
//   antipattern — AI-slop tells (vague hedges, cheap metaphors, micro-expression
//     boilerplate, 不是…而是…, inner-monologue markers): hits get highlighted and
//     can be sent back through the draft loop as retry problems;
//   generic — the differentiation principle: template descriptors ("精致的脸蛋")
//     that restate the model's default assumptions and carry zero information.
// Hits never block by themselves; the author always outranks the lint.

export type LintKind = "antipattern" | "generic"

export type LintRuleId =
  | "vagueWord"
  | "cheapMetaphor"
  | "microExpression"
  | "notButPattern"
  | "innerMonologue"
  | "enFiller"
  | "genericLooks"

interface LintRule {
  id: LintRuleId
  kind: LintKind
  pattern: RegExp
}

// Every pattern is exercised by lint.test.ts: canned slop must hit, plain
// concrete prose must pass. Keep patterns narrow — a false positive teaches
// authors to ignore the lint.
const RULES: LintRule[] = [
  { id: "vagueWord", kind: "antipattern", pattern: /似乎|仿佛|宛如|若有若无/g },
  {
    id: "cheapMetaphor",
    kind: "antipattern",
    pattern:
      /像(?:一?只|一?个)?受惊的?小兽|小兽(?:一样|一般|般)|心湖|漾起(?:.{0,4})?涟漪|涟漪(?:般|一样)|(?:触电|过电)(?:般|一样)/g,
  },
  {
    id: "microExpression",
    kind: "antipattern",
    pattern:
      /嘴角(?:微微|不自觉地?)?(?:上扬|上翘|勾起|扬起)|眼(?:中|里|底)(?:闪|掠)过(?:一丝|一抹)?|指[尖节](?:微微)?泛白|瞳孔(?:骤然|微微)?(?:一缩|紧缩|骤缩|地震)|喉结(?:上下)?滚动|睫毛(?:轻轻|微微)?颤动/g,
  },
  { id: "notButPattern", kind: "antipattern", pattern: /不是[^。！？!?\n]{1,24}[，,]?\s*而是/g },
  {
    id: "innerMonologue",
    kind: "antipattern",
    pattern: /心想|暗想|暗忖|腹诽|心中(?:暗)?(?:想|道|忖)|内心(?:独白|活动|OS|os)/g,
  },
  {
    id: "enFiller",
    kind: "antipattern",
    pattern:
      /a hint of|barely above a whisper|shivers? (?:ran|run|running) down|a mix of \w+ and \w+|eyes widen(?:ed|ing)?|breath (?:hitch(?:ed|es)?|caught)/gi,
  },
  {
    id: "genericLooks",
    kind: "generic",
    pattern:
      /精致的?(?:脸蛋|五官|面容)|白皙的?(?:皮肤|肌肤)|皮肤白皙|肤白貌美|乌黑的?(?:长发|秀发)|水汪汪的?大?眼睛|完美的?(?:身材|曲线)|高挑的?身材|瓜子脸|柳叶眉|樱桃小?嘴/g,
  },
]

export interface LintHit {
  rule: LintRuleId
  kind: LintKind
  /** The exact matched span. */
  match: string
  /** Offset of the match in the linted text. */
  index: number
  /** ±15 chars of context around the match, for the report UI. */
  excerpt: string
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 15)
  const end = Math.min(text.length, index + length + 15)
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`
}

/** Run every rule over `text`; hits come back in document order. */
export function lintProse(text: string): LintHit[] {
  const hits: LintHit[] = []
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0
    for (const match of text.matchAll(rule.pattern)) {
      hits.push({
        rule: rule.id,
        kind: rule.kind,
        match: match[0],
        index: match.index,
        excerpt: excerptAround(text, match.index, match[0].length),
      })
    }
  }
  return hits.sort((a, b) => a.index - b.index)
}

/** Lint several named prose fields at once (field → hits, empty fields skipped). */
export function lintFields(fields: Record<string, string>): Map<string, LintHit[]> {
  const out = new Map<string, LintHit[]>()
  for (const [name, text] of Object.entries(fields)) {
    if (!text.trim()) continue
    const hits = lintProse(text)
    if (hits.length > 0) out.set(name, hits)
  }
  return out
}

/** English retry problems for `draftWithRetries` — NOT localized on purpose
 * (mirror of schemas.ts issueText): the rewrite loop feeds these straight
 * back to the model as a user turn. */
export function lintProblems(hits: LintHit[], field = ""): string[] {
  const scope = field ? `${field}: ` : ""
  return hits.map((hit) =>
    hit.kind === "antipattern"
      ? `${scope}banned cliché (${hit.rule}): "${hit.match}" — delete it or replace with one concrete, observable action or line of dialogue`
      : `${scope}generic template descriptor (${hit.rule}): "${hit.match}" — this is the model's default assumption; delete it, or replace it with a trait that deviates from the default`,
  )
}
