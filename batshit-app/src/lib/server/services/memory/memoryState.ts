import type { MemoryRecord } from './memoryTypes'

/** Shared by Search, exact-id tools, compile, dreaming and management. */
export function memoryIsDeleted(record: MemoryRecord): boolean {
  return typeof record.deleted_ts === 'number'
}

export function memoryIsExpired(record: MemoryRecord, nowTs = Date.now()): boolean {
  return typeof record.expires_ts === 'number' && record.expires_ts <= nowTs
}

export function memoryIsEligible(record: MemoryRecord, includeExpired = false, nowTs = Date.now()): boolean {
  return !memoryIsDeleted(record) && (includeExpired || !memoryIsExpired(record, nowTs))
}

/** A read projection also settles the OLD state before renewal/restoration. */
export function effectiveMemoryRecord(record: MemoryRecord, nowTs = Date.now()): MemoryRecord {
  if (!memoryIsExpired(record, nowTs)) return record
  return { ...record, lane: 'ltm', ...(record.media_mode === 'always' ? { media_mode: 'on_recall' } : {}) }
}

export function requireActiveMemory(record: MemoryRecord): void {
  if (memoryIsDeleted(record)) throw new Error('This memory is in Deleted Memories. Restore it before editing or recalling it.')
}

/** Old invalid sets can shrink or stay unchanged, but cannot acquire new standing images. */
export function standingMemoryTransition(before: MemoryRecord[], after: MemoryRecord[], nowTs: number) {
  const state = (records: MemoryRecord[]) => {
    const identities = new Set<string>()
    let count = 0
    for (const record of records) {
      if (!memoryIsEligible(record, false, nowTs) || record.lane !== 'awareness' || record.is_superseded === 'y' || record.media_mode !== 'always') continue
      for (const media of record.media ?? []) { count++; identities.add(JSON.stringify([record.id, media.id, media.filename, media.sha256])) }
    }
    return { count, identities }
  }
  const old = state(before), next = state(after)
  const activation = [...next.identities].some(id => !old.identities.has(id))
  return { oldCount: old.count, postCount: next.count, activation, allowed: next.count <= 4 || next.count <= old.count && !activation }
}
