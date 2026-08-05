// The Loreweaver theme system — a 1:1 port of the TUI client's palettes
// (clients/tui/src/themes.ts in the main repo). `lamplight` IS the Loreweaver
// identity (warm near-black + parchment + brass, shared with the site, the TUI
// and the app icon) and leads as the default; the other four stay available as
// alternates, same order as the TUI's F1–F5 cycle.
//
// Only the RAW tokens live here. They are injected as `--lw-*` custom
// properties on <html>; styles.css derives every working variable (bg-raised,
// ink-faint, …) from them with color-mix, so a theme switch is one setProperty
// pass — no per-theme stylesheet.

export type ThemeName = "lamplight" | "amber" | "df16" | "phosphor" | "paperwhite"

export interface Palette {
  bg: string
  fg: string
  dim: string
  kp: string
  player: string
  npc: string
  system: string
  crit: string
  extreme: string
  hard: string
  success: string
  fail: string
  fumble: string
  hpFull: string
  hpLow: string
  sanFull: string
  sanLow: string
  border: string
  accent: string
}

export const themes: Record<ThemeName, Palette> = {
  lamplight: {
    bg: "#17130E",
    fg: "#E7D8B5",
    dim: "#8A7B5E",
    kp: "#F2E4BC",
    player: "#7FA8B8",
    npc: "#C79B74",
    system: "#9C8A66",
    crit: "#F0C46A",
    extreme: "#7FB8A3",
    hard: "#5B9A86",
    success: "#5B9A86",
    fail: "#B8894A",
    fumble: "#A2432E",
    hpFull: "#5B9A86",
    hpLow: "#A2432E",
    sanFull: "#6FA5B0",
    sanLow: "#9B6A8C",
    border: "#4A3F30",
    accent: "#D19A3E",
  },
  amber: {
    bg: "#120c05",
    fg: "#ffd58a",
    dim: "#9c7740",
    kp: "#fff0c4",
    player: "#8bd3ff",
    npc: "#d69cff",
    system: "#c09d6b",
    crit: "#fff36d",
    extreme: "#73d2de",
    hard: "#58c4dd",
    success: "#98e06f",
    fail: "#ffd166",
    fumble: "#ff686b",
    hpFull: "#9ae66e",
    hpLow: "#ff6b4a",
    sanFull: "#79d9ff",
    sanLow: "#d69cff",
    border: "#8b6532",
    accent: "#ff9f1c",
  },
  df16: {
    bg: "#000000",
    fg: "#c0c0c0",
    dim: "#808080",
    kp: "#ffffff",
    player: "#55ffff",
    npc: "#ff55ff",
    system: "#aaaaaa",
    crit: "#ffff55",
    extreme: "#55ffff",
    hard: "#55ffff",
    success: "#55ff55",
    fail: "#ffff55",
    fumble: "#ff5555",
    hpFull: "#55ff55",
    hpLow: "#ff5555",
    sanFull: "#55ffff",
    sanLow: "#ff55ff",
    border: "#808080",
    accent: "#ffaa00",
  },
  phosphor: {
    bg: "#07120d",
    fg: "#9cffb1",
    dim: "#4f8f62",
    kp: "#d7ffd9",
    player: "#7de0ff",
    npc: "#ff9bd5",
    system: "#8ba99a",
    crit: "#f8ff7a",
    extreme: "#6ee7f2",
    hard: "#67d8ff",
    success: "#8dff8d",
    fail: "#e6d96b",
    fumble: "#ff6b6b",
    hpFull: "#88ff8a",
    hpLow: "#ff5f5f",
    sanFull: "#6ee7f2",
    sanLow: "#c58cff",
    border: "#2c5c3f",
    accent: "#f4d35e",
  },
  paperwhite: {
    bg: "#f5f0e6",
    fg: "#27231d",
    dim: "#7b7469",
    kp: "#111111",
    player: "#005f87",
    npc: "#8f2d56",
    system: "#5f5a50",
    crit: "#8a5a00",
    extreme: "#006d77",
    hard: "#0077a3",
    success: "#2f7d32",
    fail: "#9a6a00",
    fumble: "#b3261e",
    hpFull: "#2f7d32",
    hpLow: "#b3261e",
    sanFull: "#0077a3",
    sanLow: "#7b3fa1",
    border: "#b8ad9f",
    accent: "#8a5a00",
  },
}

/** Same order the TUI binds to F1–F5; lamplight leads and is the default. */
export const themeOrder: ThemeName[] = ["lamplight", "amber", "df16", "phosphor", "paperwhite"]

export const DEFAULT_THEME: ThemeName = "lamplight"

const TOKEN_KEYS: (keyof Palette)[] = [
  "bg",
  "fg",
  "dim",
  "kp",
  "player",
  "npc",
  "system",
  "crit",
  "extreme",
  "hard",
  "success",
  "fail",
  "fumble",
  "hpFull",
  "hpLow",
  "sanFull",
  "sanLow",
  "border",
  "accent",
]

/** kebab-case custom-property name for one palette token, e.g. hpFull → --lw-hp-full. */
export function tokenVar(key: keyof Palette): string {
  return `--lw-${key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}`
}

/** Push a theme's raw tokens onto <html>; styles.css derives the rest. */
export function applyTheme(name: ThemeName): void {
  if (typeof document === "undefined") return
  const palette = themes[name]
  const root = document.documentElement
  for (const key of TOKEN_KEYS) root.style.setProperty(tokenVar(key), palette[key])
  root.dataset.lwTheme = name
  // Paperwhite is the one light palette: flip the UA hint so form controls follow.
  root.style.colorScheme = name === "paperwhite" ? "light" : "dark"
}
