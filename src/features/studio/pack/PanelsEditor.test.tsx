// The editor over a real panels file: it opens what an author wrote, edits it as
// fields, and writes back YAML the engine still accepts.

import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
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

/** The editor the way PackWizard mounts it: the parent STORES what the editor emits
 * and hands it straight back as `yamlText`. A test that stubs `onChange` never closes
 * that loop, and the loop is where an editor can eat its own cursor. */
function Wired({ initial = FILE }: { initial?: string }) {
  const [text, setText] = useState(initial)
  return (
    <>
      <PanelsEditor yamlText={text} onChange={setText} variables={VARIABLES} />
      <output data-testid="stored">{text}</output>
    </>
  )
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

  it("keeps the author's cursor: typing several characters lands them all, in one field", async () => {
    // Under the real parent every emitted text used to come straight back as
    // `yamlText`, be re-parsed into a model with fresh uids, and remount every card —
    // the focused input was destroyed after ONE keystroke and the next one was lost.
    render(<Wired />)
    const box = screen.getByLabelText("Panel id") as HTMLInputElement
    await userEvent.click(box)
    await userEvent.type(box, "-two")
    expect(screen.getByLabelText("Panel id")).toBe(box)
    expect(document.activeElement).toBe(box)
    expect(box.value).toBe("tide-board-two")
    expect(screen.getByTestId("stored").textContent).toContain("id: tide-board-two")
  })

  it("re-reads the file when the YAML tab changes it, without touching the field it did not", async () => {
    render(<Wired />)
    await userEvent.click(screen.getByRole("button", { name: "YAML" }))
    const yaml = screen.getByRole("textbox", { name: /panels\.yaml|YAML/i }) as HTMLTextAreaElement
    fireEvent.change(yaml, {
      target: { value: "panels:\n  - id: other\n    title: Other\n    slot: modal\n    blocks: []\n" },
    })
    await userEvent.click(screen.getByRole("button", { name: "Fields" }))
    expect((screen.getByLabelText("Panel id") as HTMLInputElement).value).toBe("other")
    expect((screen.getByLabelText("Where") as HTMLSelectElement).value).toBe("modal")
  })

  it("offers the ENGINE's slots — sidebar, tray, modal — and opens a tray panel as one", () => {
    open(FILE.replace("slot: sidebar", "slot: tray"))
    const where = screen.getByLabelText("Where") as HTMLSelectElement
    expect([...where.options].map((option) => option.value)).toEqual(["sidebar", "tray", "modal"])
    expect(where.value).toBe("tray")
  })

  it("shows a block it does not model as kept-as-written instead of dropping it", async () => {
    const onChange = open(`panels:
  - id: tide-board
    title: {en: Tide, zh: 潮汐}
    slot: sidebar
    blocks:
      - {kind: hologram, depth: 3}
      - {kind: stat, label: {en: Water, zh: 水位}, value: {$var: tide}}
`)
    expect(screen.getByText(/kept exactly as written — this editor does not model/i)).toBeInTheDocument()
    expect(screen.getByText(/1 block\(s\) are of a kind this editor does not model/i)).toBeInTheDocument()
    // An edit elsewhere writes the file back with the opaque block still in place.
    await userEvent.type(screen.getByLabelText("Panel id"), "x")
    const written = parseYaml(onChange.mock.calls.at(-1)![0]) as {
      panels: { blocks: Record<string, unknown>[] }[]
    }
    expect(written.panels[0].blocks[0]).toEqual({ kind: "hologram", depth: 3 })
  })

  it("edits a choices block as rows: id, what it sends, and a bilingual label", async () => {
    const onChange = open(`panels:
  - id: tide-board
    title: {en: Tide, zh: 潮汐}
    slot: sidebar
    blocks:
      - {kind: choices, options: [{id: look, label: {en: Look, zh: 看}, input: .ra 侦查}]}
`)
    expect((screen.getByLabelText("Option id 1") as HTMLInputElement).value).toBe("look")
    expect((screen.getByLabelText("Sends 1") as HTMLInputElement).value).toBe(".ra 侦查")
    await userEvent.click(screen.getByRole("button", { name: "Add an option" }))
    await userEvent.type(screen.getByLabelText("Option id 2"), "wait")
    await userEvent.type(screen.getByLabelText("Sends 2"), "wait a while")
    await userEvent.type(screen.getByLabelText("Label 2 en"), "Wait")
    const written = parseYaml(onChange.mock.calls.at(-1)![0]) as {
      panels: { blocks: { options: Record<string, unknown>[] }[] }[]
    }
    expect(written.panels[0].blocks[0].options[1]).toEqual({
      id: "wait",
      label: "Wait",
      input: "wait a while",
    })
  })

  it("offers a repeat item only inside a repeat, and no binding on a file path", () => {
    open(`panels:
  - id: tide-board
    title: {en: Tide, zh: 潮汐}
    slot: sidebar
    blocks:
      - {kind: image, src: assets/map.png}
      - repeat: {prefix: lantern., block: {kind: stat, label: {$leaf: label}, value: {$leaf: value}}}
`)
    // The path field has no source menu at all — the engine takes a plain string there.
    expect(screen.queryByLabelText("File source")).not.toBeInTheDocument()
    // The repeated block's fields offer the repeat item; a plain block's would not.
    const labelSource = screen.getByLabelText("Label source") as HTMLSelectElement
    expect(within(labelSource).getByRole("option", { name: "Repeat item" })).toBeInTheDocument()
    expect((screen.getByLabelText("Show the whole repeat when") as HTMLInputElement).value).toBe("")
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
