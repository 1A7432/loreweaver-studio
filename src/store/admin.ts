// Keeper administration state — the studio face of the TUI's keeper screens
// (keys / model / module / rules / skills). Requests are plain admin_* client
// frames over the live transport; replies land here via `ingest`, which the
// connection store calls before session ingest. The server (net/admin.py) is
// the real permission gate — hiding menu rows client-side is only a courtesy.

import { create } from "zustand"
import type {
  AdminConfigFrame,
  AdminGeneratedFrame,
  AdminKeyInfo,
  AdminKeyPurpose,
  AdminRuleInfo,
  AdminSkillInfo,
  MintedKey,
  PlayerRole,
  ServerFrame,
} from "@loreweaver/protocol"
import { transportSend } from "../lib/transport"
import type { ClientFrame } from "@loreweaver/protocol"

interface AdminState {
  config: AdminConfigFrame | null
  /** Model catalog for the provider last asked about ("" until one arrives). */
  modelsProvider: string
  models: string[]
  keys: AdminKeyInfo[]
  /** The freshly minted key — cleartext arrives exactly once; show + let copy. */
  minted: MintedKey | null
  skills: AdminSkillInfo[]
  rules: AdminRuleInfo[]
  generated: AdminGeneratedFrame | null
  /** Last admin_error, cleared by the next successful reply or request. */
  lastError: string | null
  busy: boolean

  ingest: (frame: ServerFrame) => boolean
  refreshConfig: () => void
  setModel: (provider: string, chatModel?: string, apiKey?: string, baseUrl?: string) => void
  listModels: (provider?: string, apiKey?: string, baseUrl?: string) => void
  listKeys: () => void
  mintKey: (room: string, name: string, role: PlayerRole, purpose?: AdminKeyPurpose) => void
  updateKey: (id: string, patch: { room?: string; name?: string; role?: PlayerRole }) => void
  deleteKey: (id: string) => void
  listSkills: (locale?: string) => void
  enableSkill: (id: string, on: boolean, locale?: string) => void
  listRules: () => void
  generateModule: (description: string) => void
  clearMinted: () => void
  reset: () => void
}

function send(frame: ClientFrame, set: (patch: Partial<AdminState>) => void): void {
  set({ busy: true, lastError: null })
  transportSend(frame).catch((cause) => {
    set({ busy: false, lastError: cause instanceof Error ? cause.message : String(cause) })
  })
}

const EMPTY = {
  config: null,
  modelsProvider: "",
  models: [],
  keys: [],
  minted: null,
  skills: [],
  rules: [],
  generated: null,
  lastError: null,
  busy: false,
} satisfies Partial<AdminState>

export const useAdminStore = create<AdminState>((set) => ({
  ...EMPTY,

  ingest: (frame) => {
    switch (frame.type) {
      case "admin_config":
        set({ config: frame, busy: false, lastError: null })
        return true
      case "admin_models":
        set({ modelsProvider: frame.provider, models: frame.models, busy: false })
        return true
      case "admin_keys":
        set({ keys: frame.keys, minted: frame.minted ?? null, busy: false, lastError: null })
        return true
      case "admin_skills":
        set({ skills: frame.skills, busy: false, lastError: null })
        return true
      case "admin_rules":
        set({ rules: frame.systems, busy: false, lastError: null })
        return true
      case "admin_generated":
        set({ generated: frame, busy: false })
        return true
      case "admin_room_op":
        set({ busy: false })
        return true
      case "admin_update":
        set({ busy: false })
        return true
      case "admin_error":
        set({ lastError: frame.message ?? frame.code, busy: false })
        return true
      default:
        return false
    }
  },

  refreshConfig: () => send({ type: "admin_get_config" }, set),
  setModel: (provider, chatModel, apiKey, baseUrl) =>
    send(
      {
        type: "admin_set_model",
        provider,
        ...(chatModel ? { chat_model: chatModel } : {}),
        ...(apiKey ? { api_key: apiKey } : {}),
        ...(baseUrl !== undefined ? { base_url: baseUrl } : {}),
      },
      set,
    ),
  listModels: (provider, apiKey, baseUrl) =>
    send(
      {
        type: "admin_list_models",
        ...(provider ? { provider } : {}),
        ...(apiKey ? { api_key: apiKey } : {}),
        ...(baseUrl ? { base_url: baseUrl } : {}),
      },
      set,
    ),
  listKeys: () => send({ type: "admin_list_keys" }, set),
  mintKey: (room, name, role, purpose) =>
    send({ type: "admin_mint_key", room, name, role, ...(purpose ? { purpose } : {}) }, set),
  updateKey: (id, patch) => send({ type: "admin_update_key", id, ...patch }, set),
  deleteKey: (id) => send({ type: "admin_delete_key", id }, set),
  listSkills: (locale) => send({ type: "admin_list_skills", ...(locale ? { locale } : {}) }, set),
  enableSkill: (id, on, locale) =>
    send({ type: "admin_enable_skill", id, on, ...(locale ? { locale } : {}) }, set),
  listRules: () => send({ type: "admin_list_rules" }, set),
  generateModule: (description) => send({ type: "admin_generate", kind: "module", description }, set),
  clearMinted: () => set({ minted: null }),
  reset: () => set({ ...EMPTY }),
}))
