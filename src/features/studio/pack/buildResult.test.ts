// The `--pack --json` machine interface: exactly one JSON object on stdout
// (`app.py::_run_pack`). The wizard renders the trust card from the success
// object and surfaces the failure object's error prominently.

import { describe, expect, it } from "vitest"
import { parsePackBuildJson } from "./buildResult"

const TRUST = {
  skills: 1,
  rulepacks: 2,
  cards: 2,
  lorebooks: 1,
  assets: 3,
  asset_bytes: 1024 * 1024 * 2,
  has_hooks: true,
  has_ejs: false,
  has_rules_script: true,
  world_cards: 1,
  panels: 2,
  presentation: 4,
  imagegen: false,
  presets: 1,
  prep_scripts: 2,
}

describe("parsePackBuildJson", () => {
  it("parses the success object with the full trust block", () => {
    const outcome = parsePackBuildJson(
      JSON.stringify({
        ok: true,
        path: "/tmp/deep-pier-0.1.0.lwpack",
        id: "deep-pier",
        version: "0.1.0",
        sha256: "ab".repeat(32),
        trust: TRUST,
      }),
    )
    expect(outcome).toEqual({
      ok: true,
      result: {
        path: "/tmp/deep-pier-0.1.0.lwpack",
        id: "deep-pier",
        version: "0.1.0",
        sha256: "ab".repeat(32),
        trust: TRUST,
      },
    })
  })

  it("parses the failure object", () => {
    const outcome = parsePackBuildJson(JSON.stringify({ ok: false, error: "card x.png: exceeds the cap" }))
    expect(outcome).toEqual({ ok: false, error: "card x.png: exceeds the cap" })
  })

  it("tolerates a missing trust block and surrounding whitespace", () => {
    const outcome = parsePackBuildJson(
      `  ${JSON.stringify({ ok: true, path: "/p", id: "i", version: "1.0.0", sha256: "ff" })}\n`,
    )
    expect(outcome).toEqual({
      ok: true,
      result: { path: "/p", id: "i", version: "1.0.0", sha256: "ff", trust: null },
    })
  })

  it("coerces a degraded trust block rather than throwing", () => {
    const outcome = parsePackBuildJson(
      JSON.stringify({
        ok: true,
        path: "/p",
        id: "i",
        version: "1.0.0",
        sha256: "ff",
        trust: { world_cards: 3, has_hooks: 1 },
      }),
    )
    expect(outcome?.ok).toBe(true)
    if (outcome?.ok === true) {
      expect(outcome.result.trust?.world_cards).toBe(3)
      // Non-boolean flags do not leak as truthy — disclosure stays honest.
      expect(outcome.result.trust?.has_hooks).toBe(false)
      expect(outcome.result.trust?.skills).toBe(0)
    }
  })

  it("returns null for human output, argparse noise, and wrong shapes", () => {
    expect(parsePackBuildJson("")).toBeNull()
    expect(parsePackBuildJson("pack built: /tmp/x.lwpack")).toBeNull()
    expect(parsePackBuildJson("usage: app.py [-h] …\nerror: unrecognized arguments: --json")).toBeNull()
    expect(parsePackBuildJson("{not json")).toBeNull()
    expect(parsePackBuildJson(JSON.stringify({ ok: false }))).toBeNull()
    expect(parsePackBuildJson(JSON.stringify({ ok: true, id: "i" }))).toBeNull()
    expect(parsePackBuildJson(JSON.stringify([1, 2]))).toBeNull()
  })
})
