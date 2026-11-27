// How the room screen reads the server and acts on it (protocol 3.0).
//
// One source of server data: the protocol `Session`'s snapshot, read through
// `useSessionSnapshot()`. Nothing here keeps a copy of a view or of the log — the hooks
// below only pick out of the snapshot, and the one piece of state they hold is the
// caller's own: the answer to the command it just ran.
//
// Commands are discovered, not assumed: an action is offered when the `commands` view
// lists its command as available to this viewer and its parameter schema names the
// arguments the action passes (§6.5). The ids and argument names themselves are the
// protocol's (§6.8).

import { useCallback, useEffect, useState } from "react"
import {
  builtInView,
  panelViewNames,
  type BuiltInViewName,
  type BuiltInViews,
  type PanelEntry,
  type Result,
  type Role,
  type SessionSnapshot,
  type ViewCommand,
} from "loreweaver-protocol/v3"
import { ROOM_VIEWS, useConnection, useSessionSnapshot } from "../../store/connection"

/** A built-in view's latest value, or null until it arrives (or when it was refused). */
export function viewData<K extends BuiltInViewName>(
  snapshot: SessionSnapshot | null,
  name: K,
): BuiltInViews[K] | null {
  return snapshot === null ? null : (builtInView(snapshot, name)?.data ?? null)
}

/** A built-in view's latest value, read from the current session. */
export function useView<K extends BuiltInViewName>(name: K): BuiltInViews[K] | null {
  return viewData(useSessionSnapshot(), name)
}

/** Whether the session is welcomed now: what every action needs. */
export function useOnline(): boolean {
  return useSessionSnapshot()?.status === "online"
}

/** This connection's role, from its welcome; null before one. */
export function useRole(): Role | null {
  return useSessionSnapshot()?.welcome?.you.role ?? null
}

/** The argument names a command's parameter schema declares. */
export function commandArgs(entry: ViewCommand): ReadonlySet<string> {
  const params = entry.params
  if (typeof params !== "object" || params === null) return new Set()
  const properties = (params as { properties?: unknown }).properties
  if (typeof properties !== "object" || properties === null) return new Set()
  return new Set(Object.keys(properties))
}

/**
 * The command `id` as this viewer may use it now: listed, available, and taking every one
 * of `args`. Null otherwise — the action that needs it is not offered.
 */
export function usableCommand(
  snapshot: SessionSnapshot | null,
  id: string,
  args: readonly string[] = [],
): ViewCommand | null {
  const entry = viewData(snapshot, "commands")?.commands.find((candidate) => candidate.id === id)
  if (entry === undefined || !entry.available) return null
  const declared = commandArgs(entry)
  return args.every((name) => declared.has(name)) ? entry : null
}

/** `usableCommand` on the current session. */
export function useCommand(id: string, args: readonly string[] = []): ViewCommand | null {
  return usableCommand(useSessionSnapshot(), id, args)
}

/**
 * What came back from the last command a control ran: its answer for this person (`text`,
 * in their language), a refusal (`message`, in their language — shown as written, never
 * re-translated from the code), or `failed` when no result came at all (the link dropped).
 */
export type Feedback =
  | { readonly kind: "answer"; readonly text: string }
  | { readonly kind: "refusal"; readonly code: string; readonly text: string }
  | { readonly kind: "failed"; readonly code: string }

/** Turn a request's outcome into what a person is shown; null when there is nothing to say. */
export function feedbackOf(outcome: Result | { readonly failed: string }): Feedback | null {
  if ("failed" in outcome) return { kind: "failed", code: outcome.failed }
  if (!outcome.ok) {
    return { kind: "refusal", code: outcome.error.code, text: outcome.error.message || outcome.error.code }
  }
  return outcome.text ? { kind: "answer", text: outcome.text } : null
}

/**
 * Run commands from a control, and keep what came back for that control alone: the
 * answer, the refusal, or the failure. `pending` is true while a command waits for its
 * result (a command may queue behind a Keeper turn).
 */
export function useCommandRunner() {
  const connection = useConnection()
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [pending, setPending] = useState(0)
  const run = useCallback(
    async (id: string, args: Record<string, unknown> = {}): Promise<Result | null> => {
      if (connection === null) return null
      setFeedback(null)
      setPending((n) => n + 1)
      try {
        const result = await connection.session.runCommand(id, args)
        setFeedback(feedbackOf(result))
        return result
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error ? String(error.code) : "failed"
        setFeedback(feedbackOf({ failed: code }))
        return null
      } finally {
        setPending((n) => n - 1)
      }
    },
    [connection],
  )
  const dismiss = useCallback(() => setFeedback(null), [])
  return { run, feedback, pending: pending > 0, dismiss }
}

/** The views the listed panels read beyond those the connection always wants, sorted. */
export function panelViews(panels: readonly PanelEntry[]): string[] {
  const always = new Set<string>(ROOM_VIEWS)
  return [...new Set(panels.flatMap((panel) => panelViewNames(panel)))]
    .filter((name) => !always.has(name))
    .sort()
}

/**
 * Hold `names` subscribed while the caller is mounted (and while it asks for the same names).
 * Only the names are held, through the connection's counted `want`; the values live in the
 * snapshot, and the session re-subscribes every wanted name on each welcome, so a reconnect
 * needs nothing from here.
 */
export function useViews(names: readonly string[]): void {
  const connection = useConnection()
  const key = [...new Set(names)].sort().join("\n")
  useEffect(() => {
    if (connection === null || key === "") return
    return connection.want(key.split("\n"))
  }, [connection, key])
}

/** Keep the session subscribed to the views the listed panels read while the caller is mounted. */
export function usePanelViews(panels: readonly PanelEntry[]): void {
  useViews(panelViews(panels))
}
