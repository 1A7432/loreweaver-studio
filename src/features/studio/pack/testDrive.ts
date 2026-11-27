// What comes after a verified build: the commands that put the pack in front of a table on a
// 3.0 server. Studio does not host one in this version, so it says them instead of running
// them. They are read from the TRUST CARD the engine computed — its card kinds and paths,
// skill and rule-system ids — never from what Studio believes about its own draft.
//
// The engine's text forms (`server/locales/en/commands.json`):
//   .pack enable <id>                         room admin: the pack's modules, panels, kit
//   .rule system <id>                         room admin: play under a rule system it adds
//   .skill enable <id>                        room admin: one of its skills (enabling a pack enables none)
//   .import world <pack> <card path>          room admin: a world card
//   .import character <pack> <card path>      a player: a character card, as their character

import type { PackTrust } from "./buildResult"

export interface NextSteps {
  /** For the room admin, in the order to type them. */
  admin: string[]
  /** For players: one line per character card (each player imports their own). */
  players: string[]
}

export function nextSteps(trust: PackTrust): NextSteps {
  const admin = [`.pack enable ${trust.id}`]
  for (const system of trust.ruleSystems) admin.push(`.rule system ${system.id}`)
  for (const skill of trust.skills) admin.push(`.skill enable ${skill.id}`)
  for (const card of trust.cards)
    if (card.kind === "world") admin.push(`.import world ${trust.id} ${card.path}`)
  const players = trust.cards
    .filter((card) => card.kind === "character")
    .map((card) => `.import character ${trust.id} ${card.path}`)
  return { admin, players }
}
