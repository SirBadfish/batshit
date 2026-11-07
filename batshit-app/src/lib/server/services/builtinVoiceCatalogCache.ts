import type { BuiltinVoiceCatalogSnapshot, VoiceCatalogView } from '$lib/types/builtinVoiceCatalog'
import { BuiltinVoiceCatalogError, compareVoiceCatalogAdmission, verifyBuiltinVoiceCatalog,
  assertVoiceCatalogBlockConservation } from '$lib/utils/builtinVoiceCatalog'
import { BUILTIN_VOICE_PROVIDER_IDS } from '$lib/data/builtinVoiceCatalog'
import { selectedVoiceCatalogCompatibility } from '$lib/utils/builtinVoiceCatalogProjection'
import type { VoiceCatalogStringStore } from './builtinVoiceCatalogStore'

const FETCH_FRESH_MS = 60 * 60_000
const MAX_CACHE_BYTES = 1024 * 1024 + 1024
type CacheRecord = { schemaVersion: 1; checkedAt: string; snapshot: BuiltinVoiceCatalogSnapshot }

async function admitCache(raw: string, nowMs: number): Promise<CacheRecord> {
  if (new TextEncoder().encode(raw).length > MAX_CACHE_BYTES) throw new BuiltinVoiceCatalogError('cache_too_large')
  const value = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 ||
    Object.keys(value).sort().join(',') !== 'checkedAt,schemaVersion,snapshot' || typeof value.checkedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.checkedAt)) || new Date(value.checkedAt).toISOString() !== value.checkedAt ||
    Date.parse(value.checkedAt) > nowMs + 300_000) throw new BuiltinVoiceCatalogError('invalid_cache')
  return { schemaVersion: 1, checkedAt: value.checkedAt, snapshot: await verifyBuiltinVoiceCatalog(JSON.stringify(value.snapshot), nowMs) }
}

/** One instance per installed process. Runtime reads never call the injected network reader. */
export function createBuiltinVoiceCatalogReader(options: {
  store: VoiceCatalogStringStore
  fetchSnapshot(): Promise<string>
  now?: () => number
}) {
  const now = options.now ?? Date.now
  let held: CacheRecord | null = null
  // A failed/losing persistence attempt cannot hide newly observed restrictions.
  // Keep its floor in memory until a strict same/newer persistent cut settles it.
  let pending: BuiltinVoiceCatalogSnapshot | null = null
  let flight: Promise<VoiceCatalogView> | null = null

  function retained(warning?: VoiceCatalogView['warning']): VoiceCatalogView {
    return { snapshot: held?.snapshot ?? null, checkedAt: held?.checkedAt ?? null,
      source: pending || !held && warning === 'cache-unavailable' ? 'unavailable' : held ? 'retained' : 'bundled', ...(warning ? { warning } : {}) }
  }

  function settlePending(snapshot: BuiltinVoiceCatalogSnapshot): void {
    if (pending && compareVoiceCatalogAdmission(pending, snapshot) !== 'stale') {
      assertVoiceCatalogBlockConservation(pending, snapshot)
      pending = null
    }
  }

  function restrictsPrior(incoming: BuiltinVoiceCatalogSnapshot, prior: BuiltinVoiceCatalogSnapshot): boolean {
    return BUILTIN_VOICE_PROVIDER_IDS.some(providerId => incoming.providers[providerId].entries.some(entry => {
      const before = selectedVoiceCatalogCompatibility({ snapshot: prior, source: 'retained', checkedAt: null }, providerId, entry.lane, entry.modelId)
      const after = selectedVoiceCatalogCompatibility({ snapshot: incoming, source: 'retained', checkedAt: null }, providerId, entry.lane, entry.modelId)
      return before.state === 'compatible' && after.state !== 'compatible'
    }))
  }

  function hold(value: CacheRecord): void {
    const decision = compareVoiceCatalogAdmission(held?.snapshot ?? null, value.snapshot)
    if (decision === 'stale') throw new BuiltinVoiceCatalogError('cache_order_regressed')
    assertVoiceCatalogBlockConservation(held?.snapshot ?? null, value.snapshot)
    // A later local read may carry the same snapshot with an older check timestamp.
    if (decision === 'same' && held && Date.parse(value.checkedAt) < Date.parse(held.checkedAt)) return
    held = value
  }

  async function capture() {
    const read = await options.store.read()
    if (!read || (read.state !== 'absent' && read.state !== 'present')) throw new BuiltinVoiceCatalogError('cache_read_unavailable')
    if (read.state === 'present') {
      const value = await admitCache(read.raw, now())
      hold(value); settlePending(value.snapshot)
    }
    return read
  }

  async function readCurrent(): Promise<VoiceCatalogView> {
    try { await capture(); return retained() } catch { return retained('cache-unavailable') }
  }

  async function refreshOnce(force: boolean): Promise<VoiceCatalogView> {
    let captured: Awaited<ReturnType<typeof capture>>
    try { captured = await capture() } catch { return retained('cache-unavailable') }
    if (!force && !pending && held && now() - Date.parse(held.checkedAt) < FETCH_FRESH_MS) return retained()
    let incoming: BuiltinVoiceCatalogSnapshot
    try { incoming = await verifyBuiltinVoiceCatalog(await options.fetchSnapshot(), now()) } catch { return retained('remote-unavailable') }
    try {
      if (compareVoiceCatalogAdmission(held?.snapshot ?? null, incoming) === 'stale') return retained('remote-stale')
      if (pending && compareVoiceCatalogAdmission(pending, incoming) === 'stale') return retained('remote-stale')
      assertVoiceCatalogBlockConservation(held?.snapshot ?? null, incoming)
      assertVoiceCatalogBlockConservation(pending, incoming)
      const record: CacheRecord = { schemaVersion: 1, checkedAt: new Date(now()).toISOString(), snapshot: incoming }
      let stored: boolean
      try {
        stored = await options.store.compareAndSet(captured.state === 'present' ? captured.raw : null, JSON.stringify(record))
        if (stored !== true && stored !== false) throw new BuiltinVoiceCatalogError('cache_write_unconfirmed')
      } catch {
        pending = incoming
        // A write-then-answer-loss can be reconciled by one strict read, never replay.
        try { await capture() } catch { /* Preserve pending custody on unreadable state. */ }
        return retained('cache-unavailable')
      }
      if (stored === true) { hold(record); settlePending(incoming); return { ...retained(), source: 'remote' } }
      if (stored !== false) throw new BuiltinVoiceCatalogError('cache_write_unconfirmed')
      if (held ? restrictsPrior(incoming, held.snapshot) : BUILTIN_VOICE_PROVIDER_IDS.some(id => incoming.providers[id].entries.some(entry => entry.admission === 'blocked'))) pending = incoming
      const winner = await options.store.read()
      if (winner.state !== 'present') return retained('cache-conflict')
      const admitted = await admitCache(winner.raw, now())
      // The losing fetch never became a floor. Adopt the persisted winner against
      // held state even when it is below this request's uncommitted proposal.
      hold(admitted)
      if (compareVoiceCatalogAdmission(admitted.snapshot, incoming) === 'newer' && restrictsPrior(incoming, admitted.snapshot)) pending = incoming
      else settlePending(admitted.snapshot)
      return retained(pending ? 'cache-conflict' : undefined)
    } catch { return retained('cache-unavailable') }
  }

  return { readCurrent, peekCurrent: () => retained(), refresh(force = false): Promise<VoiceCatalogView> {
    if (flight) return flight
    flight = refreshOnce(force).finally(() => { flight = null })
    return flight
  } }
}
