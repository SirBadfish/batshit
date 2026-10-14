/**
 * BL-287 (2026-09-27): how long a Subagent's registered run counts as running once it was
 * stopped or finished, so its delete never removes the profile folder under a CLI that can
 * still write into it, and never waits forever for one that does not exit.
 *
 * `subagentRunRegistry.ts` keeps a run registered until its call ended AND the work it tracks
 * has settled. The runner hands it `settleSubagentRunWork`: the lane's work (a stopped lane
 * unwinds after the call has already answered) and then the exit of every CLI process the lane
 * started. A lane's work ends when its CLI's stream ends, which on Codex's app-server lane is
 * the moment Batshit SENDS the process its SIGTERM, not the moment it exits; the exit is what
 * the delete has to wait for.
 *
 * From the stop (or the lane's own end, if that comes first), non-Codex CLI children keep their
 * 15 s SIGKILL grace. Codex uses its run process controller to verify the wrapper and owned
 * command groups. At 25 s an unproven exit rejects rather than silently ending registration;
 * delete retains the Subagent's record/profile and a later delete retries cleanup. Both bounds
 * fit within the delete's 30 s wait.
 */

import type { ChildProcess } from 'node:child_process'
import { getCodexRunProcesses } from './codexRunProcesses'

/** From the stop: a CLI process still running then is killed (SIGKILL). */
export const SUBAGENT_CLI_KILL_GRACE_MS = 15_000
/** From the stop: reject if the run or its command cleanup is still unverified. */
export const SUBAGENT_RUN_SETTLE_BOUND_MS = 25_000
/** How often an exit is checked for when the process's own listeners were taken away. */
const PROCESS_EXIT_POLL_MS = 200

function hasExited(child: ChildProcess): boolean {
  // A spawn that failed (ENOENT, EACCES) gets its negative error number as `exitCode`.
  return child.exitCode !== null || child.signalCode !== null
}

/**
 * Settles once the process has exited. The bridges' cleanups call `child.removeAllListeners()`,
 * which takes an `exit` listener away with the rest, so the exit is also read from the process
 * itself (Node sets `exitCode` / `signalCode` whatever listens).
 */
export function waitForProcessExit(child: ChildProcess, signal?: AbortSignal): Promise<void> {
  if (hasExited(child)) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise<void>((resolve, reject) => {
    let poll: ReturnType<typeof setInterval> | undefined
    const cleanup = () => {
      if (poll) clearInterval(poll)
      child.removeListener('exit', done)
      signal?.removeEventListener('abort', abort)
    }
    const done = () => {
      cleanup()
      resolve()
    }
    const abort = () => {
      cleanup()
      reject(signal?.reason ?? new Error('Process exit wait was stopped.'))
    }
    child.once('exit', done)
    signal?.addEventListener('abort', abort, { once: true })
    poll = setInterval(() => {
      if (hasExited(child)) done()
    }, PROCESS_EXIT_POLL_MS)
    poll.unref?.()
  })
}

/** SIGKILL a process that is still running. Answers whether it sent the signal. */
function forceKill(child: ChildProcess): boolean {
  if (hasExited(child)) return false
  try {
    return child.kill('SIGKILL')
  } catch {
    // It exited between the check and the kill.
    return false
  }
}

/**
 * The work a registered Subagent run tracks: its lane's work, then verified cleanup of each CLI
 * process. An unproven exit rejects at the bound and remains registered for a later delete retry.
 */
export function settleSubagentRunWork(options: {
  work: Promise<unknown>
  cliProcesses: readonly ChildProcess[]
  stopSignal: AbortSignal
  label: string
  killGraceMs?: number
  boundMs?: number
}): { completion: Promise<void>; retryCleanup: () => Promise<void> } {
  const { work, cliProcesses, stopSignal, label } = options
  const killGraceMs = options.killGraceMs ?? SUBAGENT_CLI_KILL_GRACE_MS
  const boundMs = options.boundMs ?? SUBAGENT_RUN_SETTLE_BOUND_MS
  const settled = work.then(
    () => undefined,
    () => undefined
  )

  const attempt = (retry: boolean): Promise<void> => new Promise<void>((resolve, reject) => {
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let boundTimer: ReturnType<typeof setTimeout> | undefined
    let clockStarted = false
    let finished = false
    const waitAbort = new AbortController()

    const finish = (error?: unknown) => {
      if (finished) return
      finished = true
      if (killTimer) clearTimeout(killTimer)
      if (boundTimer) clearTimeout(boundTimer)
      stopSignal.removeEventListener('abort', startClock)
      waitAbort.abort(new Error('Subagent exit wait ended.'))
      if (error === undefined) resolve()
      else reject(error)
    }

    function startClock() {
      if (clockStarted || finished) return
      clockStarted = true
      killTimer = setTimeout(() => {
        for (const child of cliProcesses) {
          if (getCodexRunProcesses(child)) continue
          if (forceKill(child)) {
            console.warn(
              `[subagents] ${label}'s CLI (pid ${child.pid}) had not exited ${killGraceMs} ms after its run was stopped or ended; killed it (SIGKILL)`
            )
          }
        }
      }, killGraceMs)
      killTimer.unref?.()
      boundTimer = setTimeout(() => {
        const error = new Error(`${label}'s run had not settled or its command processes had not been confirmed exited after ${boundMs} ms.`)
        console.error(`[subagents] ${error.message}`)
        finish(error)
      }, boundMs)
      boundTimer.unref?.()
    }

    if (retry || stopSignal.aborted) startClock()
    else stopSignal.addEventListener('abort', startClock, { once: true })
    void settled.then(async () => {
      startClock()
      await Promise.all(cliProcesses.map((child) => {
        const codex = getCodexRunProcesses(child)
        return codex ? (retry ? codex.retryEnd() : codex.end()) : waitForProcessExit(child, waitAbort.signal)
      }))
      finish()
    }).catch(finish)
  })

  let retryInFlight: Promise<void> | undefined
  return {
    completion: attempt(false),
    retryCleanup: () => {
      retryInFlight ??= attempt(true).finally(() => { retryInFlight = undefined })
      return retryInFlight
    }
  }
}
