import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "../../../i18n"
import { packValidationIssues, usePackStore } from "../../../store/pack"
import PresentationStage from "./PresentationStage"

const encoder = new TextEncoder()

/** The next file the picker hands back; tests swap it per upload. */
let nextFile = { name: "gu-wantang.png", bytes: encoder.encode("png"), path: null }

vi.mock("../../../lib/native", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../lib/native")>()
  return {
    ...original,
    pickAnyFiles: vi.fn(async () => [nextFile]),
  }
})

/** The stage receives kit-only issues as a prop; recompute them on every
 * store change exactly like the wizard does. */
function Harness() {
  const state = usePackStore()
  const issues = packValidationIssues(
    state.items,
    state.metadata,
    state.panels,
    state.manualSkills,
    state.presentation,
  ).filter((issue) => issue.key.startsWith("packPresentation") || issue.params?.from === "presentation")
  return <PresentationStage issues={issues} />
}

async function addKit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Add a presentation kit" }))
}

describe("PresentationStage", () => {
  beforeEach(() => {
    usePackStore.getState().reset()
    nextFile = { name: "gu-wantang.png", bytes: encoder.encode("png"), path: null }
  })

  it("starts as an explicit opt-in that teaches the kit doctrine", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    // Kit-gating + ref-mandatory + 宁缺毋滥 + 慢菜先备， up front.
    expect(screen.getByText(/no kit, no generated staging/)).toBeInTheDocument()
    expect(screen.getByText(/no ref, no portrait/)).toBeInTheDocument()
    expect(screen.getByText(/veto generation outright/)).toBeInTheDocument()
    expect(screen.getByText(/warm its art during idle turns/)).toBeInTheDocument()

    await addKit(user)
    expect(screen.getByText("Allow the Director to paint")).toBeInTheDocument()
    expect(screen.getByText(/pack art only, never generate/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add a subject" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add an audio cue" })).toBeInTheDocument()
    expect(screen.getByText(/0 subject\(s\)/)).toBeInTheDocument()
  })

  it("edits a subject: ref-mandatory warning, inline field errors, upload + thumbnail", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await addKit(user)
    await user.click(screen.getByRole("button", { name: "Add a subject" }))

    // The doctrine warning shows until a 定妆 ref rides the pack.
    expect(screen.getByText(/will never paint this subject/)).toBeInTheDocument()

    // A bad id surfaces the engine's own rule, inline under the field.
    const idInput = screen.getByLabelText("Subject id (slug)")
    await user.type(idInput, "Bad ID")
    expect(await screen.findByText(/id must be a lowercase slug/)).toBeInTheDocument()
    await user.clear(idInput)
    await user.type(idInput, "gu-wantang")
    expect(screen.queryByText(/id must be a lowercase slug/)).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /Upload the 定妆 reference image/ }))
    expect(screen.getByDisplayValue("gu-wantang.png")).toBeInTheDocument()
    expect(screen.queryByText(/will never paint this subject/)).not.toBeInTheDocument()
    expect(screen.getByText(/1 with 定妆 refs/)).toBeInTheDocument()
  })

  it("flips the 宁缺毋滥 veto and the summary/trust note follows", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await addKit(user)
    await user.click(screen.getByRole("button", { name: "Add a subject" }))
    await user.click(screen.getByRole("button", { name: /Upload the 定妆 reference image/ }))
    expect(screen.getByText(/the trust card will disclose image generation/)).toBeInTheDocument()

    await user.click(screen.getByRole("radio", { name: /pack art only, never generate/ }))
    expect(usePackStore.getState().presentation?.generation).toBe("pack_only")
    expect(screen.getByText(/pack art only \(宁缺毋滥\)/)).toBeInTheDocument()
    expect(screen.getByText(/will not flag image generation/)).toBeInTheDocument()
  })

  it("requires the cue's audio file (the engine's required key), then accepts an upload", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await addKit(user)
    await user.click(screen.getByRole("button", { name: "Add an audio cue" }))

    // `asset` is a required key in core/presentation.py — the stage says so early.
    expect(await screen.findByText(/needs its audio file/)).toBeInTheDocument()
    // …and the empty id is not a slug.
    expect(screen.getByText(/id must be a lowercase slug/)).toBeInTheDocument()

    const idInput = screen.getByLabelText("Cue id (slug)")
    await user.type(idInput, "chao-yong")
    nextFile = { name: "chao-yong.mp3", bytes: encoder.encode("mp3"), path: null }
    await user.click(screen.getByRole("button", { name: /Upload the audio file/ }))
    expect(screen.queryByText(/needs its audio file/)).not.toBeInTheDocument()
    expect(screen.getByDisplayValue("chao-yong.mp3")).toBeInTheDocument()
    expect(screen.getByText(/1 audio cue\(s\)/)).toBeInTheDocument()
  })
})
