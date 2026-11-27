// The editor over a real panels file: it opens what an author wrote, edits it as fields, writes
// back YAML the engine's checks accept, and previews it with the shared evaluation.

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { parse as parseYaml } from "yaml"
import "../../../i18n"
import PanelsEditor from "./PanelsEditor"

const FILE = `panels:
  - id: tide-board
    title: {en: Tide, zh: 潮汐}
    slot: sidebar
    views: {me: me}
    blocks:
      - {kind: stat, label: {en: Name, zh: 名字}, value: {$view: me.character.name}}
      - {kind: meter, label: Water, value: 3, min: 0, max: 10}
`

function open(yamlText = FILE) {
  const onChange = vi.fn()
  render(
    <PanelsEditor yamlText={yamlText} onChange={onChange} variables={[]} moduleIds={["harbor"]} files={[]} />,
  )
  return onChange
}

function Wired({ initial = FILE }: { initial?: string }) {
  const [text, setText] = useState(initial)
  return (
    <>
      <PanelsEditor yamlText={text} onChange={setText} variables={[]} moduleIds={[]} files={[]} />
      <output data-testid="stored">{text}</output>
    </>
  )
}

describe("PanelsEditor", () => {
  it("opens a hand-written file as fields, views and bindings included", () => {
    open()
    expect((screen.getByLabelText("Panel id") as HTMLInputElement).value).toBe("tide-board")
    expect((screen.getByLabelText("Handle 1") as HTMLInputElement).value).toBe("me")
    expect((screen.getByLabelText("View 1") as HTMLInputElement).value).toBe("me")
    expect(screen.getAllByDisplayValue("me.character.name")).toHaveLength(1)
  })

  it("previews the panel with the engine's sample view values", () => {
    open()
    // The engine's sample `me` view names the character Ada Lovelace.
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument()
    expect(screen.getByText("Water")).toBeInTheDocument()
  })

  it("writes the file back as YAML, bindings intact", async () => {
    const onChange = open()
    await userEvent.clear(screen.getByLabelText("Max"))
    await userEvent.type(screen.getByLabelText("Max"), "12")
    const written = parseYaml(onChange.mock.calls.at(-1)![0]) as {
      panels: { blocks: Record<string, unknown>[] }[]
    }
    expect(written.panels[0].blocks[1].max).toBe(12)
    expect(written.panels[0].blocks[0].value).toEqual({ $view: "me.character.name" })
  })

  it("keeps the author's cursor across the parent's round trip", async () => {
    render(<Wired />)
    const box = screen.getByLabelText("Panel id") as HTMLInputElement
    await userEvent.type(box, "-x")
    expect((screen.getByLabelText("Panel id") as HTMLInputElement).value).toBe("tide-board-x")
    expect(screen.getByTestId("stored").textContent).toContain("id: tide-board-x")
  })

  it("shows the engine's problem for a path to an undeclared handle", () => {
    open(FILE.replace("me.character.name", "you.name"))
    expect(screen.getByText(/“you” is no view handle this panel declares/)).toBeInTheDocument()
  })

  it("says a page without a fallback shows one line elsewhere", () => {
    open("panels:\n  - {id: c, title: C, slot: modal, entry: ui/c.html, fallback: null}\n")
    expect(screen.getAllByText(/needs a rich client/).length).toBeGreaterThan(0)
  })
})
