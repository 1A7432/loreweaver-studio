// The model settings: lanes and image generation from `admin/model`, changes by `model` /
// `imagegen`, and the sentinel the terminal client has — an API key typed here appears in
// exactly one outgoing frame (the `command.run` that sets it) and in no store, no log, no
// console output, and not in the form once sent. Views and results are the engine's own.

import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import "../../../i18n"
import { useAppStore } from "../../../store/app"
import { useAudioMixStore } from "../../../store/audio"
import { usePanelsStore } from "../../../store/panels"
import { ACTION_FIXTURE, TestRoom, resultBody } from "../room.testkit"
import ModelScreen from "./ModelScreen"

const SECRET = "sk-test-secret-0123456789abcdef"

let room: TestRoom | null = null
afterEach(() => {
  room?.close()
  room = null
  vi.restoreAllMocks()
})

async function open() {
  room = await TestRoom.open("admin")
  await room.actionViews("admin")
  render(<ModelScreen onBack={() => {}} />)
  await room.view("admin/model", structuredClone(ACTION_FIXTURE.adminModel))
  return room
}

function lane(name: string): HTMLElement {
  return screen.getByText(name, { selector: "td" }).closest("tr") as HTMLElement
}

describe("ModelScreen", () => {
  it("shows each lane and image generation, keys masked", async () => {
    await open()
    expect(lane("Keeper")).toHaveTextContent("openai")
    expect(lane("Keeper")).toHaveTextContent("gpt-5.5")
    expect(lane("Keeper")).toHaveTextContent("sk-e...6789")
    expect(lane("NPCs")).toHaveTextContent("as the Keeper")
    expect(lane("Pictures")).toHaveTextContent("off")
  })

  it("sends a typed key in exactly one frame, then holds it nowhere", async () => {
    const r = await open()
    const logged = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "debug"),
    ]
    const user = userEvent.setup()
    await user.click(within(lane("Keeper")).getByRole("button", { name: "Change" }))
    await user.selectOptions(screen.getByLabelText("Provider"), "deepseek")
    await user.type(screen.getByLabelText("Model"), "deepseek-chat")
    const field = screen.getByLabelText("API key") as HTMLInputElement
    expect(field.type).toBe("password")
    await user.type(field, SECRET)
    await user.click(screen.getByRole("button", { name: "Apply" }))
    await r.feed()

    expect(r.commands().at(-1)).toEqual({
      id: "model",
      args: { op: "set", lane: "keeper", provider: "deepseek", model: "deepseek-chat", key: SECRET },
    })
    const carrying = r.driver.sent.filter((entry) => JSON.stringify(entry.frame).includes(SECRET))
    expect(carrying).toHaveLength(1)
    expect(carrying[0].frame).toMatchObject({ type: "call", method: "command.run" })
    expect(field.value).toBe("")

    await r.answer(resultBody("modelSet"))
    await r.view("admin/model", structuredClone(ACTION_FIXTURE.adminModelAfterSet))
    expect(screen.getByRole("status")).toHaveTextContent("keeper now uses deepseek / deepseek-chat.")
    expect(lane("Keeper")).toHaveTextContent("sk-t...cdef")

    expect(document.body.innerHTML).not.toContain(SECRET)
    expect(JSON.stringify(r.connection.session.getSnapshot().events)).not.toContain(SECRET)
    expect(JSON.stringify([...r.connection.session.getSnapshot().views.values()])).not.toContain(SECRET)
    for (const store of [useAppStore, useAudioMixStore, usePanelsStore]) {
      expect(JSON.stringify(store.getState())).not.toContain(SECRET)
    }
    expect(JSON.stringify({ ...localStorage })).not.toContain(SECRET)
    for (const spy of logged) expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET)
  })

  it("drops a typed key when the form is left without sending it", async () => {
    const r = await open()
    const user = userEvent.setup()
    await user.click(within(lane("Keeper")).getByRole("button", { name: "Change" }))
    await user.type(screen.getByLabelText("API key"), SECRET)
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(document.body.innerHTML).not.toContain(SECRET)
    expect(r.driver.sent.some((entry) => JSON.stringify(entry.frame).includes(SECRET))).toBe(false)
    await user.click(within(lane("Keeper")).getByRole("button", { name: "Change" }))
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("")
  })

  it("shows a refusal in the server's words and keeps the form open", async () => {
    const r = await open()
    const user = userEvent.setup()
    await user.click(within(lane("Keeper")).getByRole("button", { name: "Change" }))
    await user.selectOptions(screen.getByLabelText("Provider"), "Another provider (by address)")
    await user.type(screen.getByLabelText("Name for it"), "nope-not-a-preset")
    await user.type(screen.getByLabelText("Address (base URL)"), "https://llm.example/v1")
    await user.click(screen.getByRole("button", { name: "Apply" }))
    expect(r.commands().at(-1)).toEqual({
      id: "model",
      args: { op: "set", lane: "keeper", provider: "nope-not-a-preset", baseUrl: "https://llm.example/v1" },
    })
    await r.answer(resultBody("modelBadKey"))
    expect(screen.getByRole("alert")).toHaveTextContent("No provider nope-not-a-preset is known here")
    expect(screen.getByRole("button", { name: "Apply" })).toBeInTheDocument()
  })

  it("lists a provider's models to pick from", async () => {
    const r = await open()
    const user = userEvent.setup()
    await user.click(within(lane("Keeper")).getByRole("button", { name: "Change" }))
    await user.click(screen.getByRole("button", { name: "List its models" }))
    expect(r.commands().at(-1)).toEqual({
      id: "model",
      args: { op: "list", provider: "openai", lane: "keeper" },
    })
    await r.answer({
      ok: true,
      data: {
        providers: [],
        provider: "openai",
        models: ["gpt-5.5", "gpt-5.5-mini"],
        total: 2,
        truncated: false,
        skipped: 0,
      },
    })
    await user.selectOptions(screen.getByLabelText("2 models from openai"), "gpt-5.5-mini")
    expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("gpt-5.5-mini")
  })
})
