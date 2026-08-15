import { describe, expect, it } from "vitest"
import {
  importPackAudioCommand,
  normalizeVolume,
  LAYER_DEFAULT_LOOP,
  playCommand,
  transportCommand,
  volumeCommand,
} from "./audioCommands"

describe("audio commands", () => {
  it("builds the keeper lines the engine's own parser accepts", () => {
    expect(playCommand("bgm", "chao-yong")).toBe(".bgm chao-yong")
    expect(playCommand("ambience", "night fog", { loop: true, volume: 0.4, fadeMs: 1500 })).toBe(
      '.ambience "night fog" loop volume 0.4 fade 1500',
    )
    expect(transportCommand("sfx", "stop")).toBe(".sfx stop")
    expect(volumeCommand("bgm", 0.25)).toBe(".bgm volume 0.25")
    expect(importPackAudioCommand("  deep-pier ")).toBe(".audio import deep-pier")
  })

  it("quotes a title so the option scanner cannot eat part of it", () => {
    // `_split_audio_play` treats every unrecognized token as query text, so an
    // unquoted `loop` inside a title would silently become the loop option.
    expect(playCommand("bgm", "the loop closes")).toBe('.bgm "the loop closes"')
    expect(playCommand("bgm", "潮涌 volume rising")).toBe('.bgm "潮涌 volume rising"')
  })

  it("says loop or once explicitly rather than leaning on a layer default", () => {
    // `default_loop` differs per layer, so an omitted flag means different
    // things on bgm and sfx.
    expect(playCommand("sfx", "door", { loop: false })).toBe(".sfx door once")
    expect(playCommand("sfx", "door", { loop: true })).toBe(".sfx door loop")
  })

  it("mirrors each layer's own loop default", () => {
    // `gateway/commands.py`: `.bgm`/`.ambience` are `default_loop=True`,
    // `.sfx` is `default_loop=False`. The deck shows this per layer instead of
    // one shared flag — a keeper firing a door slam must not get it forever.
    expect(LAYER_DEFAULT_LOOP).toEqual({ bgm: true, ambience: true, sfx: false })
    // Untouched, the command carries no token at all and the server applies
    // that same default, so the box and the outcome cannot disagree.
    expect(playCommand("sfx", "door", { loop: undefined })).toBe(".sfx door")
  })

  it("normalizes volume the way `_parse_audio_volume` does", () => {
    expect(normalizeVolume(0.5)).toBe(0.5)
    // Above 1 reads as a percentage.
    expect(normalizeVolume(40)).toBe(0.4)
    expect(normalizeVolume(400)).toBe(1)
    expect(normalizeVolume(-2)).toBe(0)
    expect(normalizeVolume(Number.NaN)).toBe(0)
    // …and the line always carries the same number the UI showed.
    expect(volumeCommand("bgm", 60)).toBe(".bgm volume 0.6")
  })
})
