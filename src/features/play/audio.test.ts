// The sound controller against a real protocol `Session` fed real 3.0 frames: the `audio` view
// and signals the engine's own `bgm` command produced (`fixtures/actions.json`). The audio
// element is a fake injected through the factory, so no test plays a sound.

import { afterEach, describe, expect, it, vi } from "vitest"
import { flush } from "../../lib/connection.testkit"
import { AudioController, FADE_STEP_MS, PLAY_GRACE_MS, type AudioElement, type AudioMix } from "./audio"
import { ACTION_FIXTURE, TestRoom, actionResult } from "./room.testkit"

type Answer = "ok" | "refuse" | "hang" | "throw"

class FakeElement implements AudioElement {
  src = ""
  loop = false
  volume = 1
  paused = true
  ended = false
  error: unknown = null
  plays = 0
  answer: Answer = "ok"
  readonly #listeners = new Map<string, (() => void)[]>()

  play(): Promise<void> | void {
    this.plays += 1
    if (this.answer === "throw") throw new Error("not allowed")
    if (this.answer === "refuse") {
      return Promise.reject(Object.assign(new Error("not allowed"), { name: "NotAllowedError" }))
    }
    if (this.answer === "hang") return new Promise<void>(() => undefined)
    this.paused = false
    return Promise.resolve()
  }

  pause(): void {
    this.paused = true
  }

  load(): void {}

  removeAttribute(name: string): void {
    if (name === "src") this.src = ""
  }

  addEventListener(type: "ended" | "error", listener: () => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener])
  }

  emit(type: "ended" | "error"): void {
    for (const listener of this.#listeners.get(type) ?? []) listener()
  }
}

const RAIN = ACTION_FIXTURE.audioPlaying.player.playing.bgm
const TAVERN = ACTION_FIXTURE.audioPlaying.player.library[1]

function playView() {
  return structuredClone(ACTION_FIXTURE.audioPlaying.player)
}

function idleView() {
  return { library: structuredClone(ACTION_FIXTURE.audioPlaying.player.library), playing: {} }
}

/** The data of the `audio` signal the engine sent for one of its fixture results. */
function signalOf(name: "bgmPlay" | "bgmPause" | "bgmStop") {
  return (actionResult(name) as { signals: Record<string, unknown>[] }).signals[0]
}

function audioSignal(data: Record<string, unknown>) {
  return { type: "signal", kind: "audio", data }
}

interface Rig {
  room: TestRoom
  controller: AudioController
  elements: FakeElement[]
  load: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
  want: ReturnType<typeof vi.fn>
  answer: { next: Answer }
}

let rig: Rig | null = null
afterEach(() => {
  rig?.controller.dispose()
  rig?.room.close()
  rig = null
})

async function open(options: { mix?: AudioMix; fail?: boolean } = {}): Promise<Rig> {
  const room = await TestRoom.open("player")
  const elements: FakeElement[] = []
  const answer = { next: "ok" as Answer }
  const load = vi.fn(async (hash: string) => {
    if (options.fail) throw new Error("media_not_found")
    return `blob:${hash.slice(0, 8)}`
  })
  const release = vi.fn()
  // The real counted hold: the session keeps only the views it was asked for.
  const want = vi.fn((names: readonly string[]) => room.connection.want(names))
  const controller = new AudioController({
    session: room.connection.session,
    load,
    release,
    createElement: () => {
      const element = new FakeElement()
      element.answer = answer.next
      elements.push(element)
      return element
    },
    timers: room.timers,
    now: room.timers.clock,
    want,
    ...(options.mix ? { mix: options.mix } : {}),
  })
  rig = { room, controller, elements, load, release, want, answer }
  return rig
}

async function settle(room: TestRoom): Promise<void> {
  await room.feed()
  await flush(10)
}

describe("AudioController — the view is the state", () => {
  it("holds the audio view and starts what it says plays, at its volume, looping", async () => {
    const r = await open()
    expect(r.want).toHaveBeenCalledWith(["audio"])
    await r.room.view("audio", playView())
    await settle(r.room)
    expect(r.load).toHaveBeenCalledWith(RAIN.hash, "audio/ogg")
    expect(r.elements).toHaveLength(1)
    const [element] = r.elements
    expect(element.src).toBe(`blob:${RAIN.hash.slice(0, 8)}`)
    expect(element.loop).toBe(true)
    expect(element.volume).toBeCloseTo(0.6)
    expect(element.plays).toBe(1)
  })

  it("does not restart what plays when a reconnect brings the same view again", async () => {
    const r = await open()
    await r.room.view("audio", playView())
    await settle(r.room)
    await r.room.drop()
    await r.room.redial("player")
    await r.room.view("audio", playView())
    await settle(r.room)
    expect(r.elements).toHaveLength(1)
    expect(r.elements[0].plays).toBe(1)
    expect(r.elements[0].paused).toBe(false)
  })

  it("stops a layer the view no longer names, and lets go of its URL", async () => {
    const r = await open()
    await r.room.view("audio", playView())
    await settle(r.room)
    await r.room.view("audio", idleView())
    await settle(r.room)
    expect(r.elements[0].paused).toBe(true)
    expect(r.elements[0].src).toBe("")
    expect(r.release).toHaveBeenCalledWith(`blob:${RAIN.hash.slice(0, 8)}`)
    expect(r.controller.active).toBe(0)
  })

  it("a reset of everything stops every layer; a story reset leaves the music playing", async () => {
    const r = await open()
    await r.room.view("audio", playView())
    await settle(r.room)
    await r.room.feed({
      type: "event",
      seq: 1,
      id: "r-1",
      ts: 1,
      kind: "reset",
      data: { scope: "story", epoch: 2 },
    })
    await settle(r.room)
    expect(r.elements[0].paused).toBe(false)
    await r.room.feed({
      type: "event",
      seq: 2,
      id: "r-2",
      ts: 2,
      kind: "reset",
      data: { scope: "all", epoch: 3 },
    })
    await settle(r.room)
    expect(r.elements[0].paused).toBe(true)
    expect(r.controller.active).toBe(0)
  })

  it("stops everything when the session ends (leaving the table)", async () => {
    const r = await open()
    await r.room.view("audio", playView())
    await settle(r.room)
    r.room.close()
    expect(r.elements[0].paused).toBe(true)
    expect(r.controller.active).toBe(0)
  })
})

describe("AudioController — the signals are the transitions", () => {
  it("fades a new sound in over fadeMs, to the volume the signal names", async () => {
    const r = await open()
    await r.room.feed(audioSignal(signalOf("bgmPlay")))
    await settle(r.room)
    const [element] = r.elements
    expect(element.plays).toBe(1)
    expect(element.volume).toBe(0)
    r.room.timers.advance(600)
    expect(element.volume).toBeGreaterThan(0.2)
    expect(element.volume).toBeLessThan(0.4)
    r.room.timers.advance(600 + FADE_STEP_MS)
    expect(element.volume).toBeCloseTo(0.6)
  })

  it("pauses, resumes and stops the layer as the engine's signals say", async () => {
    const r = await open()
    await r.room.view("audio", playView())
    await settle(r.room)
    const [element] = r.elements
    await r.room.feed(audioSignal(signalOf("bgmPause")))
    expect(element.paused).toBe(true)
    await r.room.feed(audioSignal({ ...signalOf("bgmPause"), action: "resume" }))
    expect(element.paused).toBe(false)
    expect(element.plays).toBe(2)
    await r.room.feed(audioSignal(signalOf("bgmStop")))
    expect(element.paused).toBe(true)
    expect(element.src).toBe("")
  })

  it("fades a stop out before it lets go", async () => {
    const r = await open()
    await r.room.view("audio", playView())
    await settle(r.room)
    const [element] = r.elements
    await r.room.feed(audioSignal({ ...signalOf("bgmStop"), fadeMs: 1000 }))
    expect(element.paused).toBe(false)
    r.room.timers.advance(500)
    expect(element.volume).toBeLessThan(0.6)
    expect(element.volume).toBeGreaterThan(0)
    r.room.timers.advance(500 + FADE_STEP_MS)
    expect(element.paused).toBe(true)
    expect(element.src).toBe("")
  })

  it("changes the volume as the signal says", async () => {
    const r = await open()
    await r.room.view("audio", playView())
    await settle(r.room)
    await r.room.feed(
      audioSignal({ id: "v-1", action: "volume", layer: "bgm", sound: RAIN.id, volume: 0.25 }),
    )
    expect(r.elements[0].volume).toBeCloseTo(0.25)
  })

  it("plays an effect once, beside the music, and lets it go when it ends", async () => {
    const r = await open()
    await r.room.feed(
      audioSignal({
        id: "s-1",
        action: "play",
        layer: "sfx",
        sound: TAVERN.hash,
        hash: TAVERN.hash,
        mime: TAVERN.mime,
        size: TAVERN.size,
        loop: false,
        volume: 1,
      }),
    )
    await settle(r.room)
    const [effect] = r.elements
    expect(effect.loop).toBe(false)
    expect(effect.plays).toBe(1)
    effect.emit("ended")
    expect(r.controller.active).toBe(0)
    expect(r.release).toHaveBeenCalled()
  })
})

describe("AudioController — the listener's own side", () => {
  it("applies the local mix on top of the room's volume, and a mute", async () => {
    const r = await open({ mix: { muted: false, gain: { bgm: 0.5, ambience: 1, sfx: 1 } } })
    await r.room.view("audio", playView())
    await settle(r.room)
    expect(r.elements[0].volume).toBeCloseTo(0.3)
    r.controller.setMix({ muted: true, gain: { bgm: 0.5, ambience: 1, sfx: 1 } })
    expect(r.elements[0].volume).toBe(0)
    r.controller.setMix({ muted: false, gain: { bgm: 1, ambience: 1, sfx: 1 } })
    expect(r.elements[0].volume).toBeCloseTo(0.6)
  })

  it("says so when the WebView refuses, and plays again from inside a gesture", async () => {
    const r = await open()
    r.answer.next = "refuse"
    await r.room.view("audio", playView())
    await settle(r.room)
    expect(r.controller.getState().blocked).toBe(true)
    r.elements[0].answer = "ok"
    r.controller.unlock()
    expect(r.elements[0].plays).toBe(2)
    expect(r.controller.getState().blocked).toBe(false)
  })

  it("counts a play that never settles with the element still paused as refused (WebKit)", async () => {
    const r = await open()
    r.answer.next = "hang"
    await r.room.view("audio", playView())
    await settle(r.room)
    expect(r.controller.getState().blocked).toBe(false)
    r.room.timers.advance(PLAY_GRACE_MS)
    expect(r.controller.getState().blocked).toBe(true)
  })

  it("marks a layer whose sound could not be fetched, and tries again on retry", async () => {
    const r = await open({ fail: true })
    await r.room.view("audio", playView())
    await settle(r.room)
    expect(r.controller.getState().failed).toEqual(["bgm"])
    expect(r.elements).toHaveLength(0)
    r.controller.retry("bgm")
    await settle(r.room)
    expect(r.load).toHaveBeenCalledTimes(2)
  })
})
