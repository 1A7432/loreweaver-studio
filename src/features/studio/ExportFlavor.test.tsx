import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import "../../i18n"
import ExportFlavorPicker from "./ExportFlavor"
import { includeSecretFor } from "./exporters"

describe("includeSecretFor", () => {
  it("is the only place a flavor becomes an exporter option", () => {
    expect(includeSecretFor("safe")).toBe(false)
    expect(includeSecretFor("release")).toBe(true)
  })
})

describe("ExportFlavorPicker", () => {
  it("says what each flavor does to the keeper-only entries", () => {
    const { rerender } = render(<ExportFlavorPicker flavor="safe" onChange={() => {}} secretCount={3} />)
    expect(screen.getByText(/3 keeper-only entr\(ies\) will be STRIPPED/)).toBeInTheDocument()

    rerender(<ExportFlavorPicker flavor="release" onChange={() => {}} secretCount={3} />)
    expect(screen.getByText(/3 keeper-only entr\(ies\) will be KEPT/)).toBeInTheDocument()
  })

  it("says the choice is moot when there is nothing secret to decide about", () => {
    render(<ExportFlavorPicker flavor="safe" onChange={() => {}} secretCount={0} />)
    expect(screen.getByText(/both flavors produce the same file/)).toBeInTheDocument()
  })

  it("reports a switch", async () => {
    const onChange = vi.fn()
    render(<ExportFlavorPicker flavor="safe" onChange={onChange} secretCount={1} />)
    await userEvent.selectOptions(screen.getByLabelText("ST card flavor"), "release")
    expect(onChange).toHaveBeenCalledWith("release")
  })
})
