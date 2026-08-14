// Installing a built pack — one target, everywhere.
//
// The engine installs under `settings.data_dir` (`TRPG_DATA_DIR`), and the
// one-click local server runs with its OWN (`~/.loreweaver/data` by default,
// `host_local.rs`). Left alone, `--install` from the pack bench lands wherever
// the studio's environment points — usually the engine checkout — and the
// server the author is about to play on never sees it.
//
// So every install path in the studio goes through here and targets the local
// server's data dir. That is the directory the studio can actually promise
// something about: it is the one the app itself will serve from. The alternative
// — each button installing somewhere different — is how an author ends up with
// two copies of a pack and a room that resolves neither.
//
// The command line the bench displays carries the same overlay, so a
// copy-pasted command does what the button did.

import { hostLocalStatus } from "./hostLocal"
import { formatCliCommand, runEngineCli, type EngineCandidate, type EngineRunResult } from "./native"

export interface PackInstall {
  result: EngineRunResult
  /** Where it landed — worth showing, since it is not the cwd. */
  dataDir: string
}

/** The local server's data dir, resolved through the same override the host
 * store holds (an author who picked a server folder meant that folder). */
export async function installDataDir(homeOverride = ""): Promise<string> {
  const status = await hostLocalStatus(homeOverride.trim() || undefined)
  return status.dataDir
}

/** Run `--install <pack> --yes` against the local server's data dir. */
export async function installPack(
  candidate: EngineCandidate,
  packPath: string,
  homeOverride = "",
): Promise<PackInstall> {
  const dataDir = await installDataDir(homeOverride)
  const result = await runEngineCli(candidate, ["--install", packPath, "--yes"], {
    TRPG_DATA_DIR: dataDir,
  })
  return { result, dataDir }
}

/** The same install, as a line an author can paste into a terminal. */
export function formatInstallCommand(
  candidate: EngineCandidate | null,
  packPath: string,
  dataDir: string,
): string {
  const command = formatCliCommand(candidate, ["--install", packPath, "--yes"])
  return dataDir ? `TRPG_DATA_DIR=${dataDir} ${command}` : command
}
