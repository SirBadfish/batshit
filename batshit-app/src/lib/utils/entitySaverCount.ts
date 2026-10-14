import { createSaverCount } from './saverCount'

type Saver = ReturnType<typeof createSaverCount>

interface EntityDebouncer {
  saver: Saver
  enqueue: (payload: { id: string }) => void
}

interface EntitySaverRecord {
  counter: Saver
  debouncers: Map<symbol, EntityDebouncer>
}

/**
 * Counts saves by entity while keeping every debounce lane independent. This lets a panel hold
 * one entity's form until that entity's own queued and in-flight writes have settled, even when
 * another entity queues the same kind of save before its timer fires.
 */
export function createEntitySaverCount(settled: () => void, onChanged?: () => void) {
  const owners = new Map<string, EntitySaverRecord>()

  function notifyChanged() {
    onChanged?.()
  }

  function isBusy(record: EntitySaverRecord) {
    return record.counter.busy() || [...record.debouncers.values()].some(({ saver }) => saver.busy())
  }

  function isInFlight(record: EntitySaverRecord) {
    return record.counter.inFlight() || [...record.debouncers.values()].some(({ saver }) => saver.inFlight())
  }

  function settleRecord(ownerId: string, record: EntitySaverRecord) {
    if (owners.get(ownerId) === record) {
      for (const [key, debouncer] of record.debouncers) {
        if (record.debouncers.get(key) === debouncer && !debouncer.saver.busy()) {
          record.debouncers.delete(key)
        }
      }
      if (owners.get(ownerId) === record && !isBusy(record) && record.debouncers.size === 0) {
        owners.delete(ownerId)
      }
    }
    try {
      notifyChanged()
    } finally {
      settled()
    }
  }

  function recordFor(ownerId: string): EntitySaverRecord {
    const existing = owners.get(ownerId)
    if (existing) return existing

    let record!: EntitySaverRecord
    const counter = createSaverCount(() => settleRecord(ownerId, record))
    record = { counter, debouncers: new Map() }
    owners.set(ownerId, record)
    return record
  }

  function busy(ownerId?: string): boolean {
    if (ownerId !== undefined) {
      const record = owners.get(ownerId)
      return record ? isBusy(record) : false
    }
    return [...owners.values()].some(isBusy)
  }

  function pendingOwners(): string[] {
    return [...owners.entries()]
      .filter(([, record]) => isBusy(record))
      .map(([ownerId]) => ownerId)
  }

  function inFlight(ownerId?: string): boolean {
    if (ownerId !== undefined) {
      const record = owners.get(ownerId)
      return record ? isInFlight(record) : false
    }
    return [...owners.values()].some(isInFlight)
  }

  function inFlightOwners(): string[] {
    return [...owners.entries()]
      .filter(([, record]) => isInFlight(record))
      .map(([ownerId]) => ownerId)
  }

  function run<T>(ownerId: string, save: () => Promise<T>): Promise<T> {
    const record = recordFor(ownerId)
    return record.counter.run(() => {
      notifyChanged()
      return save()
    })
  }

  function debounce<P extends { id: string }>(
    save: (payload: P) => Promise<unknown>,
    delay: number
  ): (payload: P) => void {
    const key = Symbol('entity-debouncer')

    return (payload: P) => {
      const record = recordFor(payload.id)
      let entry = record.debouncers.get(key)
      if (!entry) {
        const debouncerSaver = createSaverCount(() => settleRecord(payload.id, record))
        const created: EntityDebouncer = {
          saver: debouncerSaver,
          enqueue: debouncerSaver.debounce((next: { id: string }) => {
            notifyChanged()
            return save(next as P)
          }, delay)
        }
        record.debouncers.set(key, created)
        entry = created
      }

      entry.enqueue(payload)
      notifyChanged()
    }
  }

  return { busy, inFlight, pendingOwners, inFlightOwners, run, debounce }
}
