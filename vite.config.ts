/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const host = process.env.TAURI_DEV_HOST

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  // Tauri expects a fixed dev port and handles its own terminal output.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] },
  },
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
