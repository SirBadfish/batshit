/** Browser read of server-owned picture provenance; never persisted or written by a tab. */
import { readImageOriginResponseRecord, type ImageOriginRecord } from '$lib/utils/imageOriginRecord'
import { imageAddressOriginLine, type ImageAddressOriginState } from '$lib/utils/imageAddressOrigin'
import { sha256Hex } from '$lib/utils/sha256'
import { SvelteSet } from 'svelte/reactivity'

export type ImageOriginDisplay = { state: ImageAddressOriginState | 'pending'; line: string | null }
type Snapshot = { ready: boolean; records: Record<string, ImageOriginRecord> }
type Refresh = { revision: number; promise: Promise<void> | null }
let sessions = $state<Record<string, Snapshot>>({})
const refreshes = new Map<string, Refresh>()
const expectedHere = new SvelteSet<string>()
const pending: ImageOriginDisplay = { state: 'pending', line: 'Checking where this address came from.' }
const unknown: ImageOriginDisplay = { state: 'unknown', line: 'Batshit cannot tell where this address came from.' }

/** The page only binds a server decision to its exact saved version and original reply text. */
export function getImageOriginDisplay(input: {
  sessionId: string; messageId: string; content: string; address: string; isStreaming?: boolean; metadata?: unknown; textHash?: string
}): ImageOriginDisplay {
  if (input.isStreaming) return pending
  const snapshot = sessions[input.sessionId]
  if (!snapshot?.ready) return pending
  const record = snapshot.records[input.messageId]
  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata as Record<string, unknown> : {}
  const version = metadata.imageOriginExpectedVersion
  if (!record) return metadata.imageOriginExpected === true || version !== undefined || expectedHere.has(`${input.sessionId}\0${input.messageId}`) ? pending : unknown
  if (
    record.state !== 'decided' || typeof version !== 'number' || !Number.isSafeInteger(version) ||
    version < 1 || version !== record.version || !record.textHashes.includes(input.textHash ?? sha256Hex(input.content))
  ) return pending
  const decision = record.addresses[input.address]
  if (!decision) {
    console.warn('[Image origin] A drawn address is missing from the matching reply decision:', input.messageId)
    return pending
  }
  return { state: decision.state, line: imageAddressOriginLine(decision.rule) ?? (
    decision.state === 'unknown' ? unknown.line : decision.state === 'blocked' ? 'Batshit blocked this address.' : null
  ) }
}

function readSnapshot(payload: unknown): Snapshot {
  if (!payload || typeof payload !== 'object') throw new Error('Malformed image-origin response')
  const raw = (payload as Record<string, unknown>).records
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Malformed image-origin records')
  const records: Record<string, ImageOriginRecord> = Object.create(null)
  for (const [id, value] of Object.entries(raw)) {
    const record = readImageOriginResponseRecord(value, id)
    if (!record) throw new Error(`Malformed image-origin record: ${id}`)
    records[id] = record
  }
  return { ready: true, records }
}

/** One request per chat, with one trailing refresh for any number of events during that read. */
export function refreshImageOrigins(sessionId: string, fetcher: typeof fetch = fetch): Promise<void> {
  if (!sessionId) return Promise.resolve()
  let refresh = refreshes.get(sessionId)
  if (!refresh) {
    refresh = { revision: 0, promise: null }
    refreshes.set(sessionId, refresh)
  }
  refresh.revision++
  // A changed server record cannot inherit a previously accepted snapshot during the read.
  sessions[sessionId] = { ready: false, records: {} }
  if (refresh.promise) return refresh.promise
  const owner = refresh
  owner.promise = (async () => {
    while (refreshes.get(sessionId) === owner) {
      const revision = owner.revision
      try {
        const response = await fetcher(`/api/image-origins?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
        if (!response.ok) throw new Error(`Image-origin read failed: ${response.status}`)
        const snapshot = readSnapshot(await response.json())
        if (refreshes.get(sessionId) !== owner) return
        if (owner.revision === revision) sessions[sessionId] = snapshot
      } catch (error) {
        if (refreshes.get(sessionId) !== owner) return
        if (owner.revision === revision) sessions[sessionId] = { ready: false, records: {} }
        console.warn('[Image origin] Could not read where pictures came from:', error)
      }
      if (owner.revision === revision) break
    }
  })().finally(() => { owner.promise = null })
  return owner.promise
}

export function forgetImageOrigins(sessionId: string): void {
  refreshes.delete(sessionId)
  const { [sessionId]: _gone, ...rest } = sessions
  sessions = rest
  for (const key of expectedHere) if (key.startsWith(`${sessionId}\0`)) expectedHere.delete(key)
}

/** A stream seen in this tab is a modern reply even if both writes and its server end fail. */
export function markImageOriginExpected(sessionId: string, messageId: string): void {
  if (sessionId && messageId) expectedHere.add(`${sessionId}\0${messageId}`)
}
