// The editor over a real panels file: it opens what an author wrote, edits it as
// fields, and writes back YAML the engine still accepts.

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { parse as parseYaml } from "yaml"
import "../../../i18n"
import type { LintVariable } from "../lint/model"
import PanelsEditor from "./PanelsEditor"

const VARIABLES: LintVariable[] = [{ id: "tide", labelEn: "Tide", labelZh: "潮汐", visibility: "player" }]

const FILE = `panels:
  - id: tide-board
    title: {en: Tide, zh: 潮汐}
    slot: sidebar
    blocks:
      - {kind: meter, label: {en: Water, zh: 水位}, value: {$var: tide}, min: 0, max: 10}
`

function open(yamlText = FILE) {
  const onChange = vi.fn()
  render(<PanelsEditor yamlText={yamlText} onChange={onChange} variables={VARIABLES} />)
  return onChange
}

describe("PanelsEditor", () => {
  it("opens a hand-written file as fields, bindings included", () => {
    open()

    expect((screen.getByLabelText("Panel id") as HTMLInputElement).value).toBe("tide-board")
    expect((screen.getByLabelText("Title en") as HTMLInputElement).value).toBe("Tide")
    expect((screen.getByLabelText("Title zh") as HTMLInputElement).value).toBe("潮汐")
    // The bound field shows the variable it is bound to, chosen from the pack's own list.
    expect((screen.getByLabelText("Value") as HTMLSelectElement).value).toBe("tide")
  })

  it("writes the file back as YAML the schema accepts", async () => {
    const onChange = open()
    await userEvent.clear(screen.getByLabelText("Max"))
    await userEvent.type(screen.getByLabelText("Max"), "12")

    const written = parseYaml(onChange.mock.calls.at(-1)![0]) as {
      panels: { id: string; blocks: Record<string, unknown>[] }[]
    }
    expect(written.panels[0].id).toBe("tide-board")
    expect(written.panels[0].blocks[0].max).toBe(12)
    // The binding survived an edit to a neighbouring field.
    expect(written.panels[0].blocks[0].value).toEqual({ $var: "tide" })
  })

  it("adds a panel, and says what is still missing rather than writing it silently", async () => {
    const onChange = open()
    await userEvent.click(screen.getByRole("button", { name: "Add a panel" }))

    expect(screen.getByText(/id must be a lowercase slug/)).toBeInTheDocument()
    expect(screen.getByText(/has no blocks/)).toBeInTheDocument()
    expect(onChange).toHaveBeenCalled()
  })

  it("flags a binding the pack does not declare — the block would vanish at the table", async () => {
    open(`panels:
  - id: tide-board
    title: {en: Tide, zh: 潮汐}
    slot: sidebar
    blocks:
      - {kind: stat, label: {en: Water, zh: 水位}, value: {$var: tidal}}
`)
    expect(screen.getByText(/is not a variable this pack declares/)).toBeInTheDocument()
  })

  it("keeps the YAML tab for the author who wants it", async () => {
    open()
    await userEvent.click(screen.getByRole("button", { name: "YAML" }))
    expect(
      (screen.getByRole("textbox", { name: /panels\.yaml|YAML/i }) as HTMLTextAreaElement).value,
    ).toContain("tide-board")
  })

  it("refuses to guess at an unparseable file instead of emptying it", () => {
    open("panels: [")
    expect(screen.getByText(/cannot be parsed/)).toBeInTheDocument()
    expect(screen.queryByLabelText("Panel id")).not.toBeInTheDocument()
  })
})
