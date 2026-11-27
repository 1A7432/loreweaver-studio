// The 3.0 engine's command line answers with ONE JSON object per command (`loreweaver pack`,
// `install`, `packs` — `server/src/cli/main.ts` in the engine repository). This module reads
// the ones Studio runs, so the wizard renders the trust card natively instead of scraping
// text:
//
//   pack <dir> --out <file>   {ok: true, out, sha256, bytes, trust, ignored}
//                             {ok: false, code, path?, detail?, problems?}
//   install <file> [--yes]    {ok: true, installed, id, version, sha256, trust, shadowed, replaced}
//                             {ok: false, code, path?, detail?, problems?}
//   packs                     {ok: true, packs: [{id, version, name, sha256, installedAt}]}
//
// The object goes to STDOUT when the command succeeds and to STDERR when it refuses
// (`main.ts`: `(code === 0 ? console.log : console.error)(out)`), so both streams are read.
// The trust card (`server/src/core/packs/trust.ts`) is shown as the engine reports it; its
// field names are the engine's (camelCase, i18n-exempt data).

/** `TrustCard`: what installing the pack means, computed by the engine from the pack. */
export interface PackTrust {
  id: string
  version: string
  name: { en?: string; zh?: string }
  description: { en?: string; zh?: string }
  authors: string[]
  license: string
  engine: { protocol: string | null; server: string | null }
  /** The pack ships at least one module: installing it lets it run code on the server. */
  runsCode: boolean
  modules: { id: string; entry: string; bytes: number; sha256: string }[]
  ruleSystems: { id: string; extends: string | null }[]
  skills: { id: string; name: string; tools: string[]; mature: boolean }[]
  cards: {
    path: string
    kind: "world" | "character"
    name: string
    machinery: {
      variableDeclarations: number
      templates: number
      secretEntries: number
      moduleVariables: number
      hooks: number
    }
  }[]
  panels: {
    id: string
    kind: "template" | "page"
    audience: "all" | "player" | "admin"
    views: string[]
    page: { path: string; bytes: number; sha256: string } | null
  }[]
  presentation: { subjects: number; cues: number; generation: "allow" | "pack_only" } | null
  assets: { count: number; bytes: number }
  files: { count: number; bytes: number }
  ignored: { path: string; reason: string }[]
}

/** One problem a refusal lists. */
export interface PackProblem {
  code: string
  path: string
  detail?: string
}

/** A refusal: a stable code, the path it concerns, and every problem when there are several. */
export interface EngineRefusal {
  code: string
  path?: string
  detail?: string
  problems: PackProblem[]
}

export interface PackBuildSuccess {
  /** The `.lwpack` the engine wrote. */
  out: string
  sha256: string
  bytes: number
  trust: PackTrust
  /** Files the builder left out (a skill's `hooks.js`). */
  ignored: string[]
}

export type PackBuildOutcome = { ok: true; result: PackBuildSuccess } | { ok: false; refusal: EngineRefusal }

export interface PackInstallSuccess {
  /** False when only the trust card was shown (no `--yes`). */
  installed: boolean
  id: string
  version: string
  sha256: string
  trust: PackTrust
  /** Rule systems and skills whose ids an earlier claimant keeps. */
  shadowed: { ruleSystems: string[]; skills: string[] }
  replaced: string | null
}

export type PackInstallOutcome =
  { ok: true; result: PackInstallSuccess } | { ok: false; refusal: EngineRefusal }

export interface InstalledPack {
  id: string
  version: string
  name: { en?: string; zh?: string }
  sha256: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function localText(value: unknown): { en?: string; zh?: string } {
  if (!isRecord(value)) return {}
  const out: { en?: string; zh?: string } = {}
  if (typeof value.en === "string") out.en = value.en
  if (typeof value.zh === "string") out.zh = value.zh
  return out
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

/** The trust card as the engine reports it; null when the object is not one. */
export function parseTrust(raw: unknown): PackTrust | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.runsCode !== "boolean") return null
  const engine = isRecord(raw.engine) ? raw.engine : {}
  const presentation = isRecord(raw.presentation) ? raw.presentation : null
  const assets = isRecord(raw.assets) ? raw.assets : {}
  const files = isRecord(raw.files) ? raw.files : {}
  return {
    id: raw.id,
    version: text(raw.version),
    name: localText(raw.name),
    description: localText(raw.description),
    authors: strings(raw.authors),
    license: text(raw.license),
    engine: {
      protocol: typeof engine.protocol === "string" ? engine.protocol : null,
      server: typeof engine.server === "string" ? engine.server : null,
    },
    runsCode: raw.runsCode,
    modules: records(raw.modules).map((module) => ({
      id: text(module.id),
      entry: text(module.entry),
      bytes: count(module.bytes),
      sha256: text(module.sha256),
    })),
    ruleSystems: records(raw.ruleSystems).map((system) => ({
      id: text(system.id),
      extends: typeof system.extends === "string" ? system.extends : null,
    })),
    skills: records(raw.skills).map((skill) => ({
      id: text(skill.id),
      name: text(skill.name),
      tools: strings(skill.tools),
      mature: skill.mature === true,
    })),
    cards: records(raw.cards).map((card) => {
      const machinery = isRecord(card.machinery) ? card.machinery : {}
      return {
        path: text(card.path),
        kind: card.kind === "world" ? ("world" as const) : ("character" as const),
        name: text(card.name),
        machinery: {
          variableDeclarations: count(machinery.variableDeclarations),
          templates: count(machinery.templates),
          secretEntries: count(machinery.secretEntries),
          moduleVariables: count(machinery.moduleVariables),
          hooks: count(machinery.hooks),
        },
      }
    }),
    panels: records(raw.panels).map((panel) => {
      const page = isRecord(panel.page) ? panel.page : null
      return {
        id: text(panel.id),
        kind: panel.kind === "page" ? ("page" as const) : ("template" as const),
        audience:
          panel.audience === "player" || panel.audience === "admin" ? panel.audience : ("all" as const),
        views: strings(panel.views),
        page:
          page === null
            ? null
            : { path: text(page.path), bytes: count(page.bytes), sha256: text(page.sha256) },
      }
    }),
    presentation:
      presentation === null
        ? null
        : {
            subjects: count(presentation.subjects),
            cues: count(presentation.cues),
            generation: presentation.generation === "pack_only" ? "pack_only" : "allow",
          },
    assets: { count: count(assets.count), bytes: count(assets.bytes) },
    files: { count: count(files.count), bytes: count(files.bytes) },
    ignored: records(raw.ignored).map((entry) => ({ path: text(entry.path), reason: text(entry.reason) })),
  }
}

function refusal(raw: Record<string, unknown>): EngineRefusal | null {
  if (raw.ok !== false || typeof raw.code !== "string") return null
  return {
    code: raw.code,
    ...(typeof raw.path === "string" ? { path: raw.path } : {}),
    ...(typeof raw.detail === "string" ? { detail: raw.detail } : {}),
    problems: records(raw.problems)
      .filter((problem) => typeof problem.code === "string")
      .map((problem) => ({
        code: problem.code as string,
        path: text(problem.path),
        ...(typeof problem.detail === "string" ? { detail: problem.detail } : {}),
      })),
  }
}

function parseObject(text: string): Record<string, unknown> | null {
  if (!text.startsWith("{")) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** The one JSON object a command printed: its stdout (success), else the last line of its
 * stderr that is one (a refusal). Null when neither holds one. */
export function readCommandJson(stdout: string, stderr = ""): Record<string, unknown> | null {
  const fromStdout = parseObject(stdout.trim())
  if (fromStdout !== null) return fromStdout
  const lines = stderr.split("\n").map((line) => line.trim())
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = parseObject(lines[index])
    if (parsed !== null) return parsed
  }
  return null
}

/** `pack <dir> --out <file>`. Null when neither stream holds the engine's object. */
export function parsePackBuildJson(stdout: string, stderr = ""): PackBuildOutcome | null {
  const parsed = readCommandJson(stdout, stderr)
  if (parsed === null) return null
  const refused = refusal(parsed)
  if (refused !== null) return { ok: false, refusal: refused }
  if (parsed.ok !== true || typeof parsed.out !== "string" || typeof parsed.sha256 !== "string") return null
  const trust = parseTrust(parsed.trust)
  if (trust === null) return null
  return {
    ok: true,
    result: {
      out: parsed.out,
      sha256: parsed.sha256,
      bytes: count(parsed.bytes),
      trust,
      ignored: strings(parsed.ignored),
    },
  }
}

/** `install <file> [--yes]`. Null when neither stream holds the engine's object. */
export function parseInstallJson(stdout: string, stderr = ""): PackInstallOutcome | null {
  const parsed = readCommandJson(stdout, stderr)
  if (parsed === null) return null
  const refused = refusal(parsed)
  if (refused !== null) return { ok: false, refusal: refused }
  if (parsed.ok !== true || typeof parsed.id !== "string") return null
  const trust = parseTrust(parsed.trust)
  if (trust === null) return null
  const shadowed = isRecord(parsed.shadowed) ? parsed.shadowed : {}
  return {
    ok: true,
    result: {
      installed: parsed.installed === true,
      id: parsed.id,
      version: text(parsed.version),
      sha256: text(parsed.sha256),
      trust,
      shadowed: { ruleSystems: strings(shadowed.ruleSystems), skills: strings(shadowed.skills) },
      replaced: typeof parsed.replaced === "string" ? parsed.replaced : null,
    },
  }
}

/** `packs`. Null when stdout is not the engine's listing. */
export function parsePacksJson(stdout: string): InstalledPack[] | null {
  const parsed = readCommandJson(stdout)
  if (parsed === null || parsed.ok !== true || !Array.isArray(parsed.packs)) return null
  return records(parsed.packs).map((entry) => ({
    id: text(entry.id),
    version: text(entry.version),
    name: localText(entry.name),
    sha256: text(entry.sha256),
  }))
}
