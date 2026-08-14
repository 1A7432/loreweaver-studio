import { beforeEach, describe, expect, it, vi } from "vitest"
import { newLoreEntry, newPregen, newProject, newVariable } from "../features/studio/model"
import { usePackStore } from "./pack"
import { useStudioStore } from "./studio"
import { currentUndo, UNDO_WINDOW_MS, useUndoStore } from "./undo"

const encoder = new TextEncoder()

function file(name: string, contents: string) {
  return { name, bytes: encoder.encode(contents), path: null }
}

describe("undo stack", () => {
  beforeEach(() => {
    useUndoStore.getState().clear()
    useStudioStore.setState({ projects: [], activeUid: null, selectedEntryUid: null })
    usePackStore.getState().reset()
  })

  it("undoes the newest offer and pops it", () => {
    const restoreA = vi.fn()
    const restoreB = vi.fn()
    useUndoStore.getState().push("variable", "a", restoreA)
    useUndoStore.getState().push("variable", "b", restoreB)

    useUndoStore.getState().undo()
    expect(restoreB).toHaveBeenCalledTimes(1)
    expect(restoreA).not.toHaveBeenCalled()
    expect(useUndoStore.getState().entries).toHaveLength(1)

    useUndoStore.getState().undo()
    expect(restoreA).toHaveBeenCalledTimes(1)
    expect(useUndoStore.getState().entries).toHaveLength(0)
    // Nothing left to undo is a no-op, never a crash.
    expect(() => useUndoStore.getState().undo()).not.toThrow()
  })

  it("stops offering an entry once its window has passed", () => {
    const id = useUndoStore.getState().push("variable", "a", () => {})
    const entries = useUndoStore.getState().entries
    const at = entries[0].at
    expect(currentUndo(entries, at + 1)?.id).toBe(id)
    expect(currentUndo(entries, at + UNDO_WINDOW_MS + 1)).toBeNull()
    // Expiring is a display decision — the entry is still on the stack, so a
    // keyboard undo (if one is ever bound) would still find it.
    expect(useUndoStore.getState().entries).toHaveLength(1)
  })

  it("dismiss drops an offer without performing it", () => {
    const restore = vi.fn()
    const id = useUndoStore.getState().push("variable", "a", restore)
    useUndoStore.getState().dismiss(id)
    expect(restore).not.toHaveBeenCalled()
    expect(useUndoStore.getState().entries).toHaveLength(0)
  })
})

describe("forge deletes are undoable", () => {
  beforeEach(() => {
    useUndoStore.getState().clear()
    useStudioStore.setState({ projects: [], activeUid: null, selectedEntryUid: null })
  })

  it("restores a project at its original index, and re-selects it", () => {
    const [a, b, c] = ["A", "B", "C"].map((name) => newProject(name))
    useStudioStore.setState({ projects: [a, b, c], activeUid: b.uid })
    useStudioStore.getState().deleteProject(b.uid)
    expect(useStudioStore.getState().projects.map((p) => p.name)).toEqual(["A", "C"])

    useUndoStore.getState().undo()
    expect(useStudioStore.getState().projects.map((p) => p.name)).toEqual(["A", "B", "C"])
    expect(useStudioStore.getState().activeUid).toBe(b.uid)
  })

  it("restores a variable, a lore entry and a pregen in place", () => {
    const project = newProject("P")
    const [v1, v2] = [newVariable(), newVariable()]
    v1.id = "fear"
    v2.id = "truth"
    project.variables = [v1, v2]
    project.lorebook = [{ ...newLoreEntry(), title: "Rain" }]
    project.pregens = [{ ...newPregen(), name: "Hana" }]
    useStudioStore.setState({ projects: [project], activeUid: project.uid })

    useStudioStore.getState().removeVariable(v1.uid)
    useStudioStore.getState().removeLoreEntry(project.lorebook[0].uid)
    useStudioStore.getState().removePregen(project.pregens[0].uid)
    const stripped = useStudioStore.getState().projects[0]
    expect(stripped.variables.map((v) => v.id)).toEqual(["truth"])
    expect(stripped.lorebook).toHaveLength(0)
    expect(stripped.pregens).toHaveLength(0)

    useUndoStore.getState().undo()
    useUndoStore.getState().undo()
    useUndoStore.getState().undo()
    const restored = useStudioStore.getState().projects[0]
    // Original ORDER, not appended at the end.
    expect(restored.variables.map((v) => v.id)).toEqual(["fear", "truth"])
    expect(restored.lorebook[0].title).toBe("Rain")
    expect(restored.pregens[0].name).toBe("Hana")
  })

  it("writes the undo back into the project it came from, not the active one", () => {
    // An author who deletes a variable, switches project, then hits undo must
    // not have it land in the card they are now looking at.
    const first = newProject("First")
    const variable = { ...newVariable(), id: "fear" }
    first.variables = [variable]
    const second = newProject("Second")
    useStudioStore.setState({ projects: [first, second], activeUid: first.uid })

    useStudioStore.getState().removeVariable(variable.uid)
    useStudioStore.getState().selectProject(second.uid)
    useUndoStore.getState().undo()

    const state = useStudioStore.getState()
    expect(state.projects[0].variables.map((v) => v.id)).toEqual(["fear"])
    expect(state.projects[1].variables).toHaveLength(0)
  })
})

describe("pack deletes are undoable", () => {
  beforeEach(() => {
    useUndoStore.getState().clear()
    usePackStore.getState().reset()
  })

  it("restores a removed pack item at its original index", async () => {
    await usePackStore.getState().addFiles([file("a.txt", "a"), file("b.txt", "b"), file("c.txt", "c")])
    const middle = usePackStore.getState().items[1]
    usePackStore.getState().removeItem(middle.uid)
    expect(usePackStore.getState().items.map((i) => i.sourceName)).toEqual(["a.txt", "c.txt"])

    useUndoStore.getState().undo()
    expect(usePackStore.getState().items.map((i) => i.sourceName)).toEqual(["a.txt", "b.txt", "c.txt"])
  })

  it("restores a kit subject and an audio cue", () => {
    usePackStore.getState().addPresentation()
    usePackStore.getState().addPresentationSubject()
    usePackStore.getState().addPresentationCue()
    const subject = usePackStore.getState().presentation!.subjects[0]
    const cue = usePackStore.getState().presentation!.audio[0]
    usePackStore.getState().updatePresentationSubject(subject.uid, { id: "wen" })
    usePackStore.getState().updatePresentationCue(cue.uid, { id: "rain" })

    usePackStore.getState().removePresentationSubject(subject.uid)
    usePackStore.getState().removePresentationCue(cue.uid)
    expect(usePackStore.getState().presentation!.subjects).toHaveLength(0)
    expect(usePackStore.getState().presentation!.audio).toHaveLength(0)

    useUndoStore.getState().undo()
    useUndoStore.getState().undo()
    expect(usePackStore.getState().presentation!.subjects[0].id).toBe("wen")
    expect(usePackStore.getState().presentation!.audio[0].id).toBe("rain")
  })

  it("restores a removed panel file", () => {
    usePackStore.getState().setPanelsYaml("panels: []")
    usePackStore.getState().addPanelFiles([file("view.html", "<p>a</p>"), file("aux.css", "b{}")], "board")
    usePackStore.getState().removePanelFile("ui/board/view.html")
    expect(usePackStore.getState().panels!.files.map((f) => f.path)).toEqual(["ui/board/aux.css"])

    useUndoStore.getState().undo()
    expect(usePackStore.getState().panels!.files.map((f) => f.path)).toEqual([
      "ui/board/view.html",
      "ui/board/aux.css",
    ])
  })
})
