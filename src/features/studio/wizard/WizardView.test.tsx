import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it } from "vitest"
import "../../../i18n"
import { useStudioStore } from "../../../store/studio"
import { STAGE_ORDER } from "./stages"
import { useWizardStore } from "./store"
import WizardView from "./WizardView"

function reset() {
  useStudioStore.setState({
    projects: [],
    activeUid: null,
    tab: "card",
    view: "wizard",
    selectedEntryUid: null,
  })
  useWizardStore.setState({ sessions: {} })
}

function beginSession(): string {
  useStudioStore.getState().createProject("测试卡")
  const uid = useStudioStore.getState().activeUid
  if (uid === null) throw new Error("no active project")
  useWizardStore.getState().begin(uid, true)
  return uid
}

describe("WizardView", () => {
  beforeEach(reset)

  it("shows the start page and begins a session on a new card", async () => {
    const user = userEvent.setup()
    render(<WizardView />)
    expect(screen.getByText("Staged co-creation wizard")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Start on a new card" }))
    expect(useStudioStore.getState().projects).toHaveLength(1)
    const uid = useStudioStore.getState().activeUid
    expect(uid).not.toBeNull()
    expect(useWizardStore.getState().sessions[uid ?? ""]).toBeDefined()
    // Starting must NOT kick the user out of the wizard view (createProject
    // used to force view:"forge").
    expect(useStudioStore.getState().view).toBe("wizard")
    // The first stage renders with its guided questions.
    expect(screen.getByRole("heading", { name: "1 · Worldview" })).toBeInTheDocument()
    expect(screen.getByText("Guided questions")).toBeInTheDocument()
  })

  it("walks basics by hand: blank draft → fill → confirm (no AI configured)", async () => {
    const user = userEvent.setup()
    const uid = beginSession()
    useWizardStore.getState().gotoStage(uid, "basics")
    render(<WizardView />)

    await user.click(screen.getByRole("button", { name: "Start from a blank draft" }))
    expect(screen.getByRole("button", { name: "Confirm & land in card" })).toBeDisabled()
    await user.type(screen.getByLabelText("Name"), "阿理")
    await user.type(screen.getByLabelText("Description"), "疤从左眉切到颧骨。")
    await user.click(screen.getByRole("button", { name: "Confirm & land in card" }))

    const project = useStudioStore.getState().projects.find((p) => p.uid === uid)
    expect(project?.name).toBe("阿理")
    expect(project?.description).toBe("疤从左眉切到颧骨。")
  })

  it("walks worldview from a blank draft to a confirmed worldbook entry", async () => {
    const user = userEvent.setup()
    const uid = beginSession()
    render(<WizardView />)

    await user.click(screen.getByRole("button", { name: "Start from a blank draft" }))
    await user.click(screen.getByRole("button", { name: "Add entry" }))
    await user.type(screen.getByLabelText("Title"), "雾港")
    await user.type(screen.getByLabelText("Content"), "港雾三十年不散。")

    await user.click(screen.getByRole("button", { name: "Confirm & land in card" }))
    const project = useStudioStore.getState().projects.find((p) => p.uid === uid)
    expect(project?.lorebook).toHaveLength(1)
    expect(project?.lorebook[0].title).toBe("雾港")
    const session = useWizardStore.getState().sessions[uid]
    expect(session.contract.confirmedAt.worldview).toBeDefined()
    expect(session.contract.slots[0]).toMatchObject({ stage: "worldview", kind: "lore" })
    // The wizard advanced to stage 2.
    expect(screen.getByRole("heading", { name: "2 · Character basics" })).toBeInTheDocument()
  })

  it("blocks the palette confirm until the derivation is handwritten", async () => {
    const user = userEvent.setup()
    const uid = beginSession()
    useWizardStore.getState().gotoStage(uid, "palette")
    useWizardStore.getState().setDraft(uid, "palette", {
      stage: "palette",
      base: { name: "自卑", detail: "从不先开口。", derivation: "" },
      mains: [{ name: "好胜", detail: "输了加练。", derivation: "" }],
      accent: null,
    })
    render(<WizardView />)

    expect(screen.getByText("HANDWRITTEN ONLY")).toBeInTheDocument()
    const confirm = screen.getByRole("button", { name: "Confirm & land in card" })
    expect(confirm).toBeDisabled()
    expect(screen.getByText("Every main color needs its handwritten derivation loops.")).toBeInTheDocument()

    await user.type(
      screen.getByPlaceholderText("Only you write here. The AI will not fill this in."),
      "码头输了,当晚加练。",
    )
    expect(screen.getByRole("button", { name: "Confirm & land in card" })).toBeEnabled()
  })

  it("renders exegesis as handwriting-only (no AI structuring button)", () => {
    const uid = beginSession()
    useWizardStore.getState().gotoStage(uid, "exegesis")
    render(<WizardView />)
    expect(screen.getByRole("heading", { name: "5 · Second exegesis" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "AI: structure my answers" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "AI: interview me" })).toBeInTheDocument()
  })

  it("flags anti-pattern slop in a draft and offers the one-click rewrite", () => {
    const uid = beginSession()
    useWizardStore.getState().gotoStage(uid, "opening")
    useWizardStore.getState().setDraft(uid, "opening", {
      stage: "opening",
      firstMes: "她嘴角微微上扬,眼中闪过一丝笑意。",
      mesExample: "",
      alternateGreetings: [],
    })
    render(<WizardView />)
    expect(screen.getByText(/Anti-pattern lint/)).toBeInTheDocument()
    expect(screen.getByText("嘴角微微上扬")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "AI: rewrite the flagged spans" })).toBeInTheDocument()
  })

  it("shows the finish panel with dual export once every stage is confirmed", async () => {
    const user = userEvent.setup()
    const uid = beginSession()
    useWizardStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        [uid]: {
          ...s.sessions[uid],
          contract: {
            ...s.sessions[uid].contract,
            // Ascending stamps: everything confirmed, nothing stale.
            confirmedAt: Object.fromEntries(STAGE_ORDER.map((id, i) => [id, i + 1])),
          },
        },
      },
    }))
    render(<WizardView />)
    expect(screen.getByText("All stages confirmed — export")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Export SillyTavern card (release)" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Export Loreweaver bundle" })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Open the pack wizard" }))
    expect(useStudioStore.getState().view).toBe("pack")
  })

  it("skips an optional stage and marks it in the nav", async () => {
    const user = userEvent.setup()
    const uid = beginSession()
    useWizardStore.getState().gotoStage(uid, "facets")
    render(<WizardView />)
    await user.click(screen.getByRole("button", { name: "Skip this stage" }))
    expect(useWizardStore.getState().sessions[uid].skipped.facets).toBe(true)
    expect(screen.getByText("skipped")).toBeInTheDocument()
    // Advanced to the next stage.
    expect(screen.getByRole("heading", { name: "5 · Second exegesis" })).toBeInTheDocument()
  })
})
