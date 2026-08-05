import { beforeEach, describe, expect, it } from "vitest"
import { useAdminStore } from "./admin"

function reset() {
  useAdminStore.getState().reset()
}

describe("admin store ingest", () => {
  beforeEach(reset)

  it("routes admin replies into state and claims them", () => {
    const ingest = useAdminStore.getState().ingest
    expect(
      ingest({
        type: "admin_config",
        provider: "deepseek",
        chat_model: "deepseek-v4-flash",
        base_url: "",
        api_key_masked: "sk-…9x",
        providers: ["deepseek", "openai"],
        saved_providers: ["deepseek"],
        override_active: false,
      }),
    ).toBe(true)
    expect(useAdminStore.getState().config?.provider).toBe("deepseek")

    expect(
      ingest({
        type: "admin_keys",
        keys: [
          {
            id: "k1",
            key_masked: "UHEY…8P",
            room: "r1",
            name: "阿理",
            role: "player",
            purpose: "join",
            expires_at: null,
          },
        ],
        minted: {
          key: "CLEARTEXT",
          room: "r1",
          name: "阿理",
          role: "player",
          purpose: "join",
          expires_at: null,
        },
      }),
    ).toBe(true)
    const state = useAdminStore.getState()
    expect(state.keys).toHaveLength(1)
    expect(state.minted?.key).toBe("CLEARTEXT")
  })

  it("records admin_error and leaves narrative frames unclaimed", () => {
    const ingest = useAdminStore.getState().ingest
    expect(ingest({ type: "admin_error", code: "forbidden" })).toBe(true)
    expect(useAdminStore.getState().lastError).toBe("forbidden")
    expect(ingest({ type: "narrative", id: "n1", speaker: "kp", text: "…", format: "markdown" })).toBe(false)
  })

  it("stores skills and rules lists", () => {
    const ingest = useAdminStore.getState().ingest
    ingest({
      type: "admin_skills",
      skills: [{ id: "s1", name: "Foreshadow", description: "…", content_rating: "", enabled: true }],
    })
    ingest({ type: "admin_rules", systems: [{ id: "coc7e", built_in: true }] })
    expect(useAdminStore.getState().skills[0].enabled).toBe(true)
    expect(useAdminStore.getState().rules[0].id).toBe("coc7e")
  })
})
