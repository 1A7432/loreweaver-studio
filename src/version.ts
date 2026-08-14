// The studio's own version, injected at build time from package.json
// (`vite.config.ts`), so nothing has to import the manifest at runtime.
//
// It sits next to the server's `welcome.version` in the status readout: the
// protocol says that field "exists precisely for client/server drift
// detection", and until now nothing displayed either half.

declare const __STUDIO_VERSION__: string

export const STUDIO_VERSION: string =
  typeof __STUDIO_VERSION__ === "string" ? __STUDIO_VERSION__ : "0.0.0-dev"
