#!/usr/bin/env bun
/**
 * Lint TS/TSX string literals for hardcoded user-facing text.
 *
 * The studio-side sibling of the engine's `scripts/i18n_lint.py`, enforcing the
 * same red line from AGENTS.md: every user-facing string goes through i18n
 * (`t("key")` + `src/i18n/locales/{en,zh}.json`), never a literal in a
 * component. Key PARITY between the two locales is already pinned by
 * `src/i18n/i18n.test.ts`; this catches the other half — text that never
 * reached a locale file at all.
 *
 * Two rules, both AST-based (comments and regex literals are structurally out
 * of scope, so 拆卡/定妆图 prose in a comment and CJK detection patterns in
 * `wizard/lint.ts` are never findings):
 *
 *   A. CJK — any literal carrying a CJK character is hardcoded zh UI text.
 *      The studio is English-first; a Chinese string in a component is the
 *      exact failure this lint exists for.
 *   B. English — natural-language text in a USER-FACING position only (JSX
 *      text nodes and the text-bearing JSX attributes below). English source
 *      is full of legitimate ASCII strings (ids, paths, mimes, keys), so the
 *      English rule is deliberately narrower than the CJK one.
 *
 * Escape hatches, in order of preference:
 *   - `// i18n-exempt` on the same line (one literal, reason next to it);
 *   - a `*En` / `*Zh` property — authored bilingual pack CONTENT, not UI chrome;
 *   - `scripts/i18n_allowlist.txt` — whole files whose strings are not UI
 *     (model-facing prompts, generators).
 *
 * Usage:  bun scripts/i18n_lint.ts        (no args — it scans `src/`)
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SCAN_ROOT = join(REPO_ROOT, "src")
const ALLOWLIST_PATH = join(REPO_ROOT, "scripts", "i18n_allowlist.txt")

const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/
/** JSX attributes that render as text a human reads. */
const TEXT_ATTRIBUTES = new Set([
  "placeholder",
  "title",
  "alt",
  "label",
  "summary",
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
])
/** Translation helpers: their arguments are keys or already-translated text. */
const I18N_CALLEES = new Set(["t", "tt"])
/** Suffixes that mark authored bilingual CONTENT (pack manifests, cards). */
const LOCALE_FIELD_RE = /(?:^|[a-z0-9])(?:En|Zh)$/
const SLUGGY_RE = /^[a-z0-9]+(?:[-_./:][a-z0-9]+)*$/
const URLISH_RE = /^(?:https?:|data:|blob:|\/|\.{1,2}\/)/
const LOWER_WORD_RE = /\b[a-z]{3,}\b/

export interface Finding {
  path: string
  line: number
  rule: "cjk" | "english"
  snippet: string
}

function loadAllowlist(): Set<string> {
  let text: string
  try {
    text = readFileSync(ALLOWLIST_PATH, "utf-8")
  } catch {
    return new Set()
  }
  const files = new Set<string>()
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    files.add(line)
  }
  return files
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      yield* walk(full)
      continue
    }
    if (!/\.tsx?$/.test(entry)) continue
    if (/\.(?:test|spec)\.tsx?$/.test(entry)) continue
    yield full
  }
}

/** Does the literal read as natural language a translator would own? */
function looksLikeEnglishUiText(value: string): boolean {
  const text = value.trim()
  if (text.length < 4) return false
  if (URLISH_RE.test(text) || SLUGGY_RE.test(text)) return false
  const words = text.split(/\s+/).filter((word) => /[A-Za-z]/.test(word))
  if (words.length < 2) return false
  return LOWER_WORD_RE.test(text)
}

/** The nearest enclosing JSX attribute name, if the literal is one's value. */
function enclosingAttributeName(node: ts.Node): string | null {
  const parent = node.parent
  if (parent && ts.isJsxAttribute(parent)) return parent.name.getText()
  const grandparent = parent?.parent
  if (parent && ts.isJsxExpression(parent) && grandparent && ts.isJsxAttribute(grandparent)) {
    return grandparent.name.getText()
  }
  return null
}

/** Is the literal an argument to `t(...)` / `tt(...)`, or built from one? */
function insideI18nCall(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (!ts.isCallExpression(current)) continue
    const callee = current.expression
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : null
    if (name && I18N_CALLEES.has(name)) return true
  }
  return false
}

/** Is the literal the value of a `*En` / `*Zh` property (authored content)? */
function insideLocaleContentField(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isPropertyAssignment(current) || ts.isPropertySignature(current)) {
      const name = current.name
      if ((ts.isIdentifier(name) || ts.isStringLiteral(name)) && LOCALE_FIELD_RE.test(name.text)) return true
    }
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      if (LOCALE_FIELD_RE.test(current.name.text)) return true
    }
  }
  return false
}

/** Types, imports and property KEYS are structure, never rendered text. */
function isStructuralPosition(node: ts.Node): boolean {
  const parent = node.parent
  if (!parent) return false
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true
  if (ts.isLiteralTypeNode(parent)) return true
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true
  return false
}

const COMMENT_LINE_RE = /^\s*(?:\/\/|\/\*|\*|\{\/\*)/
const MARKER_RE = /i18n-exempt|noqa-i18n/

/**
 * The marker may sit on the literal's own line or anywhere in the comment
 * block directly above it. JSX attributes and multi-line template literals
 * leave no room for a trailing comment, and a reason worth writing usually
 * needs a full line — so a two-line explanation above still counts.
 */
function lineHasExemption(source: ts.SourceFile, position: number): boolean {
  const { line } = source.getLineAndCharacterOfPosition(position)
  const starts = source.getLineStarts()
  const lineText = (index: number): string => {
    if (index < 0 || index >= starts.length) return ""
    const to = index + 1 < starts.length ? starts[index + 1] : source.text.length
    return source.text.slice(starts[index], to)
  }
  if (MARKER_RE.test(lineText(line))) return true
  for (let above = line - 1; above >= 0; above -= 1) {
    const text = lineText(above)
    if (!COMMENT_LINE_RE.test(text)) return false
    if (MARKER_RE.test(text)) return true
  }
  return false
}

function snippet(value: string): string {
  const text = value.split(/\s+/).join(" ").trim()
  return text.length <= 88 ? text : `${text.slice(0, 85)}...`
}

/** Scan one file's SOURCE — the whole rule set, exported so it is testable. */
export function scanSource(relPath: string, text: string): Finding[] {
  const findings: Finding[] = []
  const source = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

  const record = (node: ts.Node, value: string, rule: Finding["rule"]): void => {
    if (lineHasExemption(source, node.getStart(source))) return
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
    findings.push({ path: relPath, line: line + 1, rule, snippet: snippet(value) })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      const value = node.text.trim()
      if (value) {
        if (CJK_RE.test(value)) record(node, value, "cjk")
        else if (looksLikeEnglishUiText(value)) record(node, value, "english")
      }
    } else if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateLiteral(node)
    ) {
      const value = ts.isTemplateExpression(node)
        ? [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ")
        : node.text
      const exempt = isStructuralPosition(node) || insideI18nCall(node) || insideLocaleContentField(node)
      if (!exempt) {
        if (CJK_RE.test(value)) {
          record(node, value, "cjk")
        } else {
          const attribute = enclosingAttributeName(node)
          if (attribute && TEXT_ATTRIBUTES.has(attribute) && looksLikeEnglishUiText(value)) {
            record(node, value, "english")
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return findings
}

export function main(argv: string[]): number {
  if (argv.length > 0) {
    console.error("i18n_lint: takes no arguments — it always scans src/")
    return 2
  }
  const allowlist = loadAllowlist()
  const findings: Finding[] = []
  for (const path of walk(SCAN_ROOT)) {
    const relPath = relative(REPO_ROOT, path)
    if (allowlist.has(relPath)) continue
    findings.push(...scanSource(relPath, readFileSync(path, "utf-8")))
  }
  findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  if (findings.length === 0) {
    console.log("i18n lint: no hardcoded user-facing strings")
    return 0
  }
  for (const finding of findings) {
    console.log(`${finding.path}:${finding.line}: [${finding.rule}] ${finding.snippet}`)
  }
  console.log(
    `\ni18n lint: ${findings.length} hardcoded string(s). Move them into ` +
      `src/i18n/locales/{en,zh}.json and read them with t("key"), or mark the ` +
      `line \`// i18n-exempt\` when the text is data rather than UI.`,
  )
  return 1
}

// Run only as a CLI — `scripts/i18n_lint.test.ts` imports the rules instead.
if ((import.meta as { main?: boolean }).main) {
  process.exit(main(process.argv.slice(2)))
}
