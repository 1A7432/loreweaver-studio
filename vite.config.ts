/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import pkg from "./package.json" with { type: "json" }

// Protocol 3.0's client library, `loreweaver-protocol/v3`, resolved to its TypeScript SOURCE.
// TEMPORARY: until loreweaver-protocol 3.0.0 is on npm, the package is the engine checkout's
// `clients/protocol`, installed from the path `../trpg_kp/clients/protocol` (package.json; CI
// clones the engine's `v3` branch there). Its `./v3` export points at a `dist/` nobody builds
// unless asked, and only Bun's own `bun` condition points at the source — so the one entry is
// aliased here (vite, vitest) and in tsconfig.json `paths` (tsc). The 2.x package stays the
// root `@loreweaver/protocol` import until the rest of the UI moves.
const PROTOCOL_V3 = fileURLToPath(
  new URL("./node_modules/loreweaver-protocol/src/v3/index.ts", import.meta.url),
)
// The package ROOT (the same 3.0 surface plus the `visible_when` condition language the
// authoring studio checks panels with), likewise from source.
const PROTOCOL_ROOT = fileURLToPath(
  new URL("./node_modules/loreweaver-protocol/src/index.ts", import.meta.url),
)

const host = process.env.TAURI_DEV_HOST

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^loreweaver-protocol\/v3$/, replacement: PROTOCOL_V3 },
      { find: /^loreweaver-protocol$/, replacement: PROTOCOL_ROOT },
    ],
  },

  // Tauri expects a fixed dev port and handles its own terminal output.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] },
  },
  // The studio's own version, for the client/server drift readout next to the
  // server's `welcome.version`. A define rather than an import so package.json
  // never lands in the bundle.
  define: { __STUDIO_VERSION__: JSON.stringify(pkg.version) },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    // Windows uses WebView2 (Chromium); macOS/Linux/iOS use WebKit.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },

  test: {
    environment: "jsdom",
    // Globals let @testing-library/react register its automatic DOM cleanup.
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    css: false,
  },
})
