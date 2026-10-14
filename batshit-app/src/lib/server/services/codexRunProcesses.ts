import type { ChildProcess } from 'node:child_process'
import { readHostProcessTable as readProcesses, type HostProcessIdentity as ProcessIdentity, type HostProcessTable as ProcessTable } from './hostProcessIdentity'
import { registerRuntimeShutdownTask } from './runtimeShutdown'

/** BL-659/660: Codex's shell sessions need not share the app-server's process group. */

export const CODEX_PROCESS_KILL_GRACE_MS = 400
const ROOT_KILL_GRACE_MS = 15_000
const EXIT_BOUND_MS = 3_000
const controllers = new WeakMap<ChildProcess, CodexRunProcesses>()
let nextControllerId = 0
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))


function matches(before: ProcessIdentity, now: ProcessIdentity | undefined): now is ProcessIdentity {
  return !!now && before.pid === now.pid && before.started === now.started && before.group === now.group
}

function running(row: ProcessIdentity): boolean {
  return !row.state.startsWith('Z')
}

/**
 * One owner per spawned CLI, retained through wrapper exit. No global process watcher, command
 * name matching, or environment inspection. Snapshot BEFORE interrupt: afterward the native
 * CLI can exit and reparent its background shells, losing the ancestry that proves ownership.
 */
export class CodexRunProcesses {
  private readonly known: ProcessTable = new Map()
  private readonly groups = new Set<number>()
  /** Establish ownership before sending initialize or the exec prompt to the CLI. */
  readonly ready: Promise<void>
  private stopping = false
  private preparation: Promise<void> | undefined
  private ending: Promise<void> | undefined
  private stopStarted: number | undefined
  private readonly unregisterShutdown: () => void
  private failed = false
  private retrying = false
  private stopCaptured = false
  private failureReported = false
  private shutdownStarted: number | undefined

  constructor(private readonly child: ChildProcess, private readonly options: {
    rootGraceMs?: number
    onFailure?: (error: Error) => void | Promise<void>
    onExit?: () => void | Promise<void>
    /** Persist observations before initialize/interrupt can destroy the run ancestry. */
    onCapture?: (processes: ProcessIdentity[]) => void | Promise<void>
    /** Failure must retain the run: an uncommitted durable completion is not completion. */
    onVerifiedExit?: () => void | Promise<void>
  } = {}) {
    controllers.set(child, this)
    this.unregisterShutdown = registerRuntimeShutdownTask(`codex-processes-${++nextControllerId}-${child.pid ?? 'spawn-failed'}`, async () => {
      // The Mac supervisor gives the app only five seconds before killing its group.
      // Detached Codex groups must finish their escalation inside that outer bound.
      this.shutdownStarted ??= Date.now()
      void this.prepareStop().catch(() => {})
      await this.retryEnd()
    })
    this.ready = this.capture(false).then(() => {
      if (child.pid && process.platform !== 'win32' && !this.known.has(child.pid)) {
        throw new Error('Codex cleanup could not establish the spawned process identity before it exited.')
      }
    })
    // Keep the rejection for the awaited cleanup, without an unhandled rejection at spawn.
    void this.ready.catch(() => {})
  }

  private async capture(includeDescendants: boolean, requireAncestry = false): Promise<void> {
    if (!this.child.pid || process.platform === 'win32') return
    const table = await readProcesses()
    const root = table.get(this.child.pid)
    const previous = this.known.get(this.child.pid)
    if (root && (!previous || matches(previous, root)) &&
        (previous || (this.child.exitCode === null && this.child.signalCode === null))) {
      this.known.set(root.pid, root)
      // Only a spawn with detached:true may give this controller group authority.
      if (root.group === root.pid) this.groups.add(root.group)
    }
    if (requireAncestry && !this.stopCaptured && ![...this.known.values()].some(
      (before) => matches(before, table.get(before.pid)) && running(table.get(before.pid)!),
    )) {
      throw new Error('Codex cleanup lost the run ancestry before it could inspect its commands.')
    }
    let changed = true
    while (changed) {
      changed = false
      for (const row of table.values()) {
        if (this.known.has(row.pid)) continue
        const parent = this.known.get(row.parent)
        const anchoredGroup = this.groups.has(row.group) && [...this.known.values()].some(
          (anchor) => anchor.group === row.group && matches(anchor, table.get(anchor.pid)),
        )
        if (anchoredGroup || (includeDescendants && parent && matches(parent, table.get(parent.pid)))) {
          this.known.set(row.pid, row)
          if (includeDescendants && row.pid === row.group) this.groups.add(row.group)
          changed = true
        }
      }
    }
    await this.options.onCapture?.([...this.known.values()].map(row => ({ ...row })))
  }

  /** Must resolve before asking the CLI to interrupt, or signalling it. */
  prepareStop(): Promise<void> {
    this.stopping = true
    this.stopStarted ??= Date.now()
    this.preparation ??= this.ready.then(() => this.capture(true, true)).then(() => { this.stopCaptured = true })
    return this.preparation
  }

  private async signal(name: NodeJS.Signals | 0, rootKillAt = 0): Promise<boolean> {
    // Stop can arrive while normal cleanup's process-table read is in flight. Let its
    // ancestry capture finish before the first signal can destroy that ancestry.
    let preparation = this.preparation
    await preparation
    let table = await readProcesses()
    if (preparation !== this.preparation) {
      preparation = this.preparation
      await preparation
      table = await readProcesses()
    }
    const signalledGroups = new Set<number>()
    let alive = false
    for (const before of this.known.values()) {
      const now = table.get(before.pid)
      if (!matches(before, now) || !running(now)) continue
      alive = true
      const group = this.groups.has(now.group) ? now.group : null
      if (group && signalledGroups.has(group)) continue
      try {
        // Preserve the CLI's existing 15-second interrupt/flush grace. Shell sessions
        // in their own groups get the shorter command grace instead.
        const rootGroup = now.group === this.child.pid || now.pid === this.child.pid
        process.kill(group ? -group : now.pid, name === 'SIGKILL' && rootGroup && Date.now() < this.rootDeadline(rootKillAt) ? 0 : name)
        if (group) signalledGroups.add(group)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    // A group with no surviving identity anchor must never be signalled by number alone.
    // It also cannot be certified empty: report ambiguity instead of claiming cleanup.
    for (const group of this.groups) {
      if ([...table.values()].some((row) => row.group === group && running(row)) &&
          ![...this.known.values()].some((row) => row.group === group && matches(row, table.get(row.pid)))) {
        throw new Error(`Codex cleanup cannot verify ownership of remaining process group ${group}.`)
      }
    }
    return alive
  }

  private rootDeadline(deadline: number): number {
    return this.shutdownStarted === undefined ? deadline : Math.min(deadline, this.shutdownStarted + CODEX_PROCESS_KILL_GRACE_MS)
  }

  /** Idempotent; Primary, Worker and Subagent delete all await this same completion. */
  end(): Promise<void> {
    this.ending ??= this.endOnce().then(async () => {
      await this.options.onVerifiedExit?.()
      this.unregisterShutdown()
      try { await this.options.onExit?.() } catch (error) {
        console.error('[Codex] Processes exited but run resource cleanup failed', error)
      }
    }).catch((error) => {
      this.failed = true
      // A failed identity check authorizes no signal, including a numeric PID fallback.
      // Retain ownership and the failure so deletion refuses and a later attempt can retry.
      if (!this.failureReported) {
        this.failureReported = true
        void Promise.resolve().then(() => this.options.onFailure?.(error instanceof Error ? error : new Error(String(error))))
          .catch((noticeError) => console.error('[Codex] Could not report process cleanup failure', noticeError))
      }
      throw error
    })
    return this.ending
  }

  /** A delete retry joins active cleanup or starts a fresh bounded attempt after failure. */
  retryEnd(): Promise<void> {
    if (!this.failed) return this.end()
    this.failed = false
    this.retrying = true
    this.ending = undefined
    this.preparation = undefined
    this.stopStarted = this.stopping ? Date.now() : undefined
    return this.end()
  }

  private async endOnce(): Promise<void> {
    if (!this.child.pid) {
      // A failed spawn has no owned OS process. Never signal an uninitialized handle.
      return
    }
    if (process.platform === 'win32') {
      throw new Error('Codex process-tree cleanup requires the supported macOS or Linux runtime.')
    }
    if (this.retrying) {
      // Re-establish a failed initial inspection only while the original child or a
      // previously captured member still proves ownership. Lost ancestry is not empty.
      await this.capture(this.stopping, this.stopping)
      if (!this.known.has(this.child.pid)) throw new Error('Codex cleanup cannot verify its original process identity.')
      if (this.stopping) this.stopCaptured = true
    } else {
      await this.ready
      if (this.stopping) await this.prepareStop()
    }
    await this.capture(this.stopping)
    const rootKillAt = (this.stopStarted ?? Date.now()) + (this.options.rootGraceMs ?? ROOT_KILL_GRACE_MS)
    if (!await this.signal('SIGTERM')) return
    const killAt = Date.now() + CODEX_PROCESS_KILL_GRACE_MS
    while (Date.now() < Math.max(killAt, this.rootDeadline(rootKillAt)) + EXIT_BOUND_MS) {
      await pause(25)
      // Capture children created by a TERM handler while an owned parent still exists.
      await this.capture(this.stopping)
      if (!await this.signal(Date.now() < killAt ? 0 : 'SIGKILL', rootKillAt)) return
    }
    throw new Error('Codex cleanup could not confirm that its processes exited after SIGKILL.')
  }
}

/** Undefined for other CLI providers: they retain their existing settle contract. */
export function getCodexRunProcesses(child: ChildProcess): CodexRunProcesses | undefined {
  return controllers.get(child)
}
