// The STUDIO half of the panel template-instantiation conformance table.
//
// `fixtures/panel_template_vectors.json` is vendored VERBATIM from the engine repo —
// refresh this copy whenever THAT file changes:
//   trpg_kp/tests/fixtures/panel_template_vectors.json
// The same rows run through the engine (`tests/core/test_panel_template_vectors.py`,
// the `.panel` text fallback's resolver) and the reference client
// (`clients/tui/src/panelTemplates.vectors.test.ts`, the ORACLE). A panel is
// instantiated per viewer in every client AND on the server; this file is what
// makes the studio's tier-1 resolver the same instantiation and not a third opinion.

import { describe, expect, it } from "vitest"
import type { ModuleVariable, PanelTemplateBlock, UiBlock } from "@loreweaver/protocol"
import { resolvePanelBlocks } from "./templates"
import vectors from "./fixtures/panel_template_vectors.json"

interface VectorCase {
  id: string
  why: string
  blocks: PanelTemplateBlock[]
  variables: ModuleVariable[]
  locale: string
  expect: UiBlock[]
}

const cases = (vectors as { cases: VectorCase[] }).cases

describe("panel template conformance vectors (studio resolver)", () => {
  it("loads the shared table", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30)
    expect(cases.some((row) => row.expect.length === 0)).toBe(true)
    expect(cases.some((row) => row.expect.length > 1)).toBe(true)
  })

  for (const row of cases) {
    it(`${row.id} — ${row.why}`, () => {
      expect(resolvePanelBlocks(row.blocks, row.variables, row.locale)).toEqual(row.expect)
    })
  }
})
