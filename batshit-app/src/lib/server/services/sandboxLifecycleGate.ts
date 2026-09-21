/**
 * One in-process owner for each named execution sandbox's lifecycle (F-P5-1).
 *
 * The API lane runs one step's tool calls in parallel, so a chat's first few
 * `native_bash_execute` calls all reach "is this chat's sandbox there? no, create it" at
 * the same moment. Without a gate one create wins and the rest fail with "container
 * already exists", and a caller that lists while the winner is still starting sees the
 * new sandbox as `stopped` (Apple Container lists a starting container that way for about
 * a second) and deletes it. Each sandbox backend adapter routes every create and remove of
 * a named sandbox through its gate:
 *
 * - `ensure`: concurrent callers for one name share ONE in-flight ensure, so every caller
 *   for a name must pass an equivalent `run`. An ensure that arrives while a removal of
 *   that name runs waits for the removal, then starts fresh.
 * - `lease`: a caller holds a lease from before its ensure until its command returns.
 * - `removeIfIdle`: a removal that is SKIPPED while any lease is held, so cleaning up a
 *   one-shot or stopped sandbox never pulls it out from under a running command.
 * - `remove`: a removal that runs even while leased. Run-end cleanup uses it, because a
 *   command still running when its chat's run ended is abandoned.
 *
 * Removals and ensures of one name run one at a time, in arrival order. The gate knows
 * nothing about any CLI and coordinates this process only: a second process can still
 * race, and each adapter handles that case from the CLI's own answer.
 */

export type SandboxRemovalOutcome<T> = { removed: true; value: T } | { removed: false }

export interface SandboxLifecycleGate {
  ensure<T>(name: string, run: () => Promise<T>): Promise<T>
  lease(name: string): () => void
  removeIfIdle<T>(name: string, run: () => Promise<T>): Promise<SandboxRemovalOutcome<T>>
  remove<T>(name: string, run: () => Promise<T>): Promise<T>
  /** True while the name is leased or has a queued or running ensure/removal. */
  isBusy(name: string): boolean
  /** How many names the gate still tracks; an idle name is forgotten. */
  trackedNameCount(): number
}

type GateEntry = {
  leases: number
  queuedOperations: number
  inFlightEnsure: Promise<unknown> | null
  tail: Promise<void>
}

export function createSandboxLifecycleGate(): SandboxLifecycleGate {
  const entries = new Map<string, GateEntry>()

  const entryFor = (name: string): GateEntry => {
    const existing = entries.get(name)
    if (existing) return existing
    const created: GateEntry = {
      leases: 0,
      queuedOperations: 0,
      inFlightEnsure: null,
      tail: Promise.resolve()
    }
    entries.set(name, created)
    return created
  }

  // Sandbox names are per chat, so an entry must not outlive its last user.
  const forgetIfIdle = (name: string, entry: GateEntry) => {
    if (entry.leases === 0 && entry.queuedOperations === 0 && entries.get(name) === entry) {
      entries.delete(name)
    }
  }

  const enqueue = <T>(name: string, entry: GateEntry, run: () => Promise<T>): Promise<T> => {
    entry.queuedOperations += 1
    const operation = entry.tail.then(run)
    entry.tail = operation.then(
      () => undefined,
      () => undefined
    )
    // Registered before the caller's own await, so the caller resumes with this
    // operation already counted out.
    const settle = () => {
      entry.queuedOperations -= 1
      forgetIfIdle(name, entry)
    }
    operation.then(settle, settle)
    return operation
  }

  // A caller that arrives after a removal was queued must not join the ensure queued
  // before it: that sandbox may be gone by the time the caller runs its command.
  const enqueueRemoval = <T>(name: string, run: (entry: GateEntry) => Promise<T>): Promise<T> => {
    const entry = entryFor(name)
    entry.inFlightEnsure = null
    return enqueue(name, entry, () => run(entry))
  }

  return {
    ensure<T>(name: string, run: () => Promise<T>): Promise<T> {
      const entry = entryFor(name)
      if (entry.inFlightEnsure) return entry.inFlightEnsure as Promise<T>
      const flight = enqueue(name, entry, run)
      entry.inFlightEnsure = flight
      const clear = () => {
        if (entry.inFlightEnsure === flight) entry.inFlightEnsure = null
      }
      flight.then(clear, clear)
      return flight
    },

    lease(name: string) {
      const entry = entryFor(name)
      entry.leases += 1
      let released = false
      return () => {
        if (released) return
        released = true
        entry.leases -= 1
        forgetIfIdle(name, entry)
      }
    },

    removeIfIdle<T>(name: string, run: () => Promise<T>): Promise<SandboxRemovalOutcome<T>> {
      return enqueueRemoval(name, async (entry): Promise<SandboxRemovalOutcome<T>> => {
        if (entry.leases > 0) return { removed: false }
        return { removed: true, value: await run() }
      })
    },

    remove<T>(name: string, run: () => Promise<T>): Promise<T> {
      return enqueueRemoval(name, run)
    },

    isBusy(name: string) {
      const entry = entries.get(name)
      return Boolean(entry && (entry.leases > 0 || entry.queuedOperations > 0))
    },

    trackedNameCount() {
      return entries.size
    }
  }
}
