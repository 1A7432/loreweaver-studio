// The keeper's audio surface, as commands.
//
// `audio_control` is a SERVER→client frame — a keeper does not send one. What
// they send is a command, and the server turns it into the broadcast. So this
// module builds those command lines, mirroring `gateway/commands.py`:
//
//   `.bgm <query> [loop|once] [volume <v>] [fade <ms>]`
//   `.bgm stop | pause | resume | volume <v>`   (same for `.ambience`, `.sfx`)
//   `.audio import <packId>`                    (a pack's soundtrack → the room)
//
// The query is matched server-side against the room's audio library
// (`resolve_audio_item`), which is why the picker offers library entries by
// their own title/name rather than by hash: a hash is not a query the resolver
// accepts, and inventing one here would be a contract this repo does not own.
//
// `_split_audio_play` treats every unrecognized token as part of the query, so
// a title containing a word like `loop` would be eaten as an option. The
// builder quotes the query for exactly that reason (`_shell_words` splits the
// argument string shell-style).

import type { AudioLayer } from "@loreweaver/protocol"

/** Each layer's own loop default, from `gateway/commands.py`: `.bgm` and
 * `.ambience` are declared `default_loop=True`, `.sfx` `default_loop=False` — a
 * one-shot is what a sound effect IS. The UI shows this rather than one shared
 * flag, so a keeper firing an sfx does not get an endless loop from a checkbox
 * that was ticked for the music. */
export const LAYER_DEFAULT_LOOP: Record<AudioLayer, boolean> = {
  bgm: true,
  ambience: true,
  sfx: false,
}

/** Mirror of `_parse_audio_volume`: a value above 1 is read as a percentage,
 * and the result is clamped to 0..1. Doing it here means the command line
 * always carries the same number the UI showed. */
export function normalizeVolume(value: number): number {
  const scaled = value > 1 ? value / 100 : value
  if (!Number.isFinite(scaled)) return 0
  return Math.max(0, Math.min(1, scaled))
}

function quote(query: string): string {
  const text = query.trim()
  // `_shell_words` is shell-style, so a title with spaces has to arrive as one
  // token or the resolver sees a different query than the one clicked.
  return /^[^\s"']+$/.test(text) ? text : JSON.stringify(text)
}

export interface PlayOptions {
  loop?: boolean
  /** 0..1 (or a percentage; normalized before it reaches the line). */
  volume?: number
  fadeMs?: number
}

/** `.bgm <query> …` — start one library entry on a layer. */
export function playCommand(layer: AudioLayer, query: string, options: PlayOptions = {}): string {
  const parts = [`.${layer}`, quote(query)]
  // The layer's own default differs (`default_loop`), so say it explicitly
  // rather than relying on which layer this is.
  if (options.loop !== undefined) parts.push(options.loop ? "loop" : "once")
  if (options.volume !== undefined) parts.push("volume", String(normalizeVolume(options.volume)))
  if (options.fadeMs !== undefined) parts.push("fade", String(Math.max(0, Math.trunc(options.fadeMs))))
  return parts.join(" ")
}

export type TransportAction = "stop" | "pause" | "resume"

export function transportCommand(layer: AudioLayer, action: TransportAction): string {
  return `.${layer} ${action}`
}

export function volumeCommand(layer: AudioLayer, volume: number): string {
  return `.${layer} volume ${normalizeVolume(volume)}`
}

/** `.audio import <packId>` — register an installed pack's audio assets into
 * THIS room's library. A pack install is host-wide; a room's soundscape is the
 * keeper's call, which is why this is a deliberate lever and not automatic. */
export function importPackAudioCommand(packId: string): string {
  return `.audio import ${packId.trim()}`
}
