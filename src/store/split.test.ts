import { beforeEach, describe, expect, it } from "vitest"
import { bytesToBase64 } from "../lib/native"
import { isTextCard, sessionBytes, sha256Hex, useSplitStore, type SplitSession } from "./split"

const encoder = new TextEncoder()

function session(name: string, body: string): SplitSession {
  const bytes = encoder.encode(body)
  return {
    file: { name, path: `/tmp/${name}`, size: bytes.length, sha256: "abc123" },
    base64: bytesToBase64(bytes),
    needsReattach: false,
    original: { name: "X" } as SplitSession["original"],
    character: { name: "X" } as SplitSession["character"],
    split: { hooks: [] } as unknown as SplitSession["split"],
    leaves: [],
    truncated: false,
    initvarProblems: [],
    drafts: [],
  }
}

/** What zustand's `persist` would write, without going through localStorage. */
function persisted(): unknown {
  const options = useSplitStore.persist.getOptions()
  return options.partialize?.(useSplitStore.getState())
}

describe("split session persistence", () => {
  beforeEach(() => useSplitStore.getState().clear())

  it("keeps a JSON card's bytes — they are its own text", () => {
    useSplitStore.getState().setSession(session("heavy.json", '{"name":"X"}'))
    const written = persisted() as { session: SplitSession }
    expect(written.session.base64).not.toBeNull()
    expect(written.session.needsReattach).toBe(false)
    expect(sessionBytes(written.session)).not.toBeNull()
  })

  it("drops a PNG card's bytes and flags the re-attach", () => {
    // Megabytes of localStorage for bytes we can ask for again in one click —
    // and every EDIT still survives, which is the whole point.
    useSplitStore.getState().setSession(session("keeper.png", "\x89PNG…"))
    const written = persisted() as { session: SplitSession }
    expect(written.session.base64).toBeNull()
    expect(written.session.needsReattach).toBe(true)
    // The file is still identifiable after the round trip.
    expect(written.session.file).toEqual({
      name: "keeper.png",
      path: "/tmp/keeper.png",
      size: encoder.encode("\x89PNG…").length,
      sha256: "abc123",
    })
    expect(sessionBytes(written.session)).toBeNull()
  })

  it("re-attaching restores the bytes and clears the flag", () => {
    useSplitStore.getState().setSession({ ...session("keeper.png", ""), base64: null, needsReattach: true })
    useSplitStore
      .getState()
      .reattach({ name: "keeper.png", path: "/new/keeper.png", bytes: encoder.encode("bytes") })
    const restored = useSplitStore.getState().session!
    expect(restored.needsReattach).toBe(false)
    expect(restored.file.path).toBe("/new/keeper.png")
    expect(Array.from(sessionBytes(restored)!)).toEqual(Array.from(encoder.encode("bytes")))
  })

  it("edits reach the session without replacing it wholesale", () => {
    useSplitStore.getState().setSession({
      ...session("heavy.json", "{}"),
      drafts: [{ uid: "d1", include: false } as never, { uid: "d2", include: false } as never],
    })
    useSplitStore.getState().patchCharacter({ name: "renamed" })
    useSplitStore.getState().patchDraft("d2", { include: true } as never)
    const state = useSplitStore.getState().session!
    expect(state.character.name).toBe("renamed")
    expect(state.drafts.map((draft) => draft.include)).toEqual([false, true])
  })
})

describe("isTextCard", () => {
  it("is the losslessness question, not the parser's", () => {
    expect(isTextCard("card.json")).toBe(true)
    expect(isTextCard("CARD.JSON")).toBe(true)
    expect(isTextCard("card.png")).toBe(false)
  })
})

describe("sha256Hex", () => {
  it("hashes, or returns empty where WebCrypto is absent", async () => {
    const hash = await sha256Hex(encoder.encode("abc"))
    // Either the real digest, or "" on a platform without crypto.subtle.
    expect(hash === "" || hash === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad").toBe(
      true,
    )
  })
})
