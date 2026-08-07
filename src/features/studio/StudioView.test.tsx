import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it } from "vitest"
import "../../i18n"
import { useStudioStore } from "../../store/studio"
import StudioView from "./StudioView"

function reset() {
  useStudioStore.setState({ projects: [], activeUid: null, tab: "card", selectedEntryUid: null })
}

describe("StudioView", () => {
  beforeEach(reset)

  it("starts empty and creates a project", async () => {
    const user = userEvent.setup()
    render(<StudioView />)
    expect(screen.getByText(/start forging/i)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "New card" }))
    expect(useStudioStore.getState().projects).toHaveLength(1)
    expect(screen.getByLabelText("Name")).toBeInTheDocument()
  })

  it("edits card fields and flags a missing name", async () => {
    const user = userEvent.setup()
    render(<StudioView />)
    await user.click(screen.getByRole("button", { name: "New card" }))
    const name = screen.getByLabelText("Name")
    await user.clear(name)
    expect(screen.getByText(/issue/)).toBeInTheDocument()
    await user.type(name, "Deep Pier")
    expect(useStudioStore.getState().projects[0].name).toBe("Deep Pier")
    expect(screen.getByText("✓ valid")).toBeInTheDocument()
  })

  it("adds a variable with inline validation", async () => {
    const user = userEvent.setup()
    render(<StudioView />)
    await user.click(screen.getByRole("button", { name: "New card" }))
    await user.click(screen.getByRole("button", { name: "Variables" }))
    await user.click(screen.getByRole("button", { name: "Add variable" }))
    // A fresh variable has an empty (invalid) id.
    expect(screen.getByText(/Id must be/)).toBeInTheDocument()
    await user.type(screen.getByLabelText("Id"), "suspicion")
    expect(screen.queryByText(/Id must be/)).not.toBeInTheDocument()
  })

  it("adds and edits a worldbook entry", async () => {
    const user = userEvent.setup()
    render(<StudioView />)
    await user.click(screen.getByRole("button", { name: "New card" }))
    await user.click(screen.getByRole("button", { name: "Worldbook" }))
    await user.click(screen.getByRole("button", { name: "Add entry" }))
    await user.type(screen.getByLabelText("Title"), "The Well")
    expect(screen.getByRole("button", { name: "The Well" })).toBeInTheDocument()
    const project = useStudioStore.getState().projects[0]
    expect(project.lorebook[0].title).toBe("The Well")
  })

  it("adds a pregen with inline validation", async () => {
    const user = userEvent.setup()
    render(<StudioView />)
    await user.click(screen.getByRole("button", { name: "New card" }))
    await user.click(screen.getByRole("button", { name: "Pregens" }))
    await user.click(screen.getByRole("button", { name: "Add pregen" }))
    // A fresh pregen has an empty (required) name.
    expect(screen.getByText(/Pregen needs a name/)).toBeInTheDocument()
    await user.type(screen.getByLabelText("Name"), "林晚")
    expect(screen.queryByText(/Pregen needs a name/)).not.toBeInTheDocument()
    await user.type(screen.getByLabelText(/Skill overrides/), "侦查 60")
    const project = useStudioStore.getState().projects[0]
    expect(project.pregens[0]).toMatchObject({ name: "林晚", skillsText: "侦查 60" })
  })
})
