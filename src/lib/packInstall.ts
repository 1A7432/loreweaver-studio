// Verifying a built pack with the REAL installer, without touching anybody's server.
//
// The 3.0 engine installs into its data directory (`TRPG_DATA_DIR`) — on an operator's
// machine that is a live server's packs. So Studio never installs there: it makes a fresh
// scratch directory, runs `install <file> --yes` into it (the installer validates the whole
// pack again, exactly as a server would, and writes it), lists what landed with `packs`, and
// removes the directory. What an operator types on their own server is shown, not run.

import {
  parseInstallJson,
  parsePacksJson,
  type InstalledPack,
  type PackInstallOutcome,
} from "../features/studio/pack/buildResult"
import {
  formatCliCommand,
  makeScratchDir,
  removeScratchDir,
  runEngineCli,
  type EngineCandidate,
  type EngineRunResult,
} from "./native"

export interface PackVerification {
  /** The installer's answer; null when stdout was not its JSON object. */
  install: PackInstallOutcome | null
  installRun: EngineRunResult
  /** What `packs` listed afterwards; null when it was not run or did not answer. */
  listed: InstalledPack[] | null
  listRun: EngineRunResult | null
}

/** `install <pack> --yes` into a scratch data directory, then `packs`; the directory is
 * removed whatever happens. */
export async function verifyPackInstall(
  candidate: EngineCandidate,
  packPath: string,
): Promise<PackVerification> {
  const dataDir = await makeScratchDir()
  try {
    const env = { TRPG_DATA_DIR: dataDir }
    const installRun = await runEngineCli(candidate, ["install", packPath, "--yes"], env)
    const install = parseInstallJson(installRun.stdout, installRun.stderr)
    if (install === null || !install.ok) return { install, installRun, listed: null, listRun: null }
    const listRun = await runEngineCli(candidate, ["packs"], env)
    return { install, installRun, listed: parsePacksJson(listRun.stdout), listRun }
  } finally {
    await removeScratchDir(dataDir).catch(() => undefined)
  }
}

/** The install an operator runs on their own server, as a line to paste. */
export function formatInstallCommand(candidate: EngineCandidate | null, packPath: string): string {
  return formatCliCommand(candidate, ["install", packPath, "--yes"])
}
