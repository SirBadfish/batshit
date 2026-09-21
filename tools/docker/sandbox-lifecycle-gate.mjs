// One in-process owner for each named Docker Sandbox's lifecycle (F-P5-1).
//
// This is the host operator's copy of batshit-app's `sandboxLifecycleGate.ts`; the operator
// runs as its own Node process from the repo checkout and cannot import app source, so a
// change to either copy must be made in both. Parallel tool calls reach the operator as
// parallel `/v1/sandbox/execute` requests, and without a gate each one found the chat's
// sandbox missing and ran `create` for the same name.
//
// - ensure(name, run): concurrent callers for one name share ONE in-flight ensure, so every
//   caller for a name must pass an equivalent `run`. An ensure that arrives while a removal
//   of that name runs waits for the removal, then starts fresh.
// - lease(name): a caller holds a lease from before its ensure until its command returns.
// - removeIfIdle(name, run): a removal that is SKIPPED while any lease is held.
// - remove(name, run): a removal that runs even while leased (run-end cleanup).
//
// Removals and ensures of one name run one at a time, in arrival order.

export function createSandboxLifecycleGate() {
  const entries = new Map()

  const entryFor = (name) => {
    const existing = entries.get(name)
    if (existing) return existing
    const created = { leases: 0, queuedOperations: 0, inFlightEnsure: null, tail: Promise.resolve() }
    entries.set(name, created)
    return created
  }

  // Sandbox names are per chat, so an entry must not outlive its last user.
  const forgetIfIdle = (name, entry) => {
    if (entry.leases === 0 && entry.queuedOperations === 0 && entries.get(name) === entry) {
      entries.delete(name)
    }
  }

  const enqueue = (name, entry, run) => {
    entry.queuedOperations += 1
    const operation = entry.tail.then(run)
    entry.tail = operation.then(
      () => undefined,
      () => undefined
    )
    const settle = () => {
      entry.queuedOperations -= 1
      forgetIfIdle(name, entry)
    }
    operation.then(settle, settle)
    return operation
  }

  // A caller that arrives after a removal was queued must not join the ensure queued
  // before it: that sandbox may be gone by the time the caller runs its command.
  const enqueueRemoval = (name, run) => {
    const entry = entryFor(name)
    entry.inFlightEnsure = null
    return enqueue(name, entry, () => run(entry))
  }

  return {
    ensure(name, run) {
      const entry = entryFor(name)
      if (entry.inFlightEnsure) return entry.inFlightEnsure
      const flight = enqueue(name, entry, run)
      entry.inFlightEnsure = flight
      const clear = () => {
        if (entry.inFlightEnsure === flight) entry.inFlightEnsure = null
      }
      flight.then(clear, clear)
      return flight
    },

    lease(name) {
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

    removeIfIdle(name, run) {
      return enqueueRemoval(name, async (entry) => {
        if (entry.leases > 0) return { removed: false }
        return { removed: true, value: await run() }
      })
    },

    remove(name, run) {
      return enqueueRemoval(name, run)
    },

    isBusy(name) {
      const entry = entries.get(name)
      return Boolean(entry && (entry.leases > 0 || entry.queuedOperations > 0))
    },

    trackedNameCount() {
      return entries.size
    }
  }
}
