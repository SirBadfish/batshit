import { browser } from '$app/env'
import { parseToolOperationsResponse, type ToolOperationsClientSnapshot } from '$lib/utils/toolOperationalSettingsSave'

/** One read-only source cache per authenticated user; editable drafts/bases belong to Admin. */
let owner: string | null = null
let epoch = 0, demand = 0
let pending: Promise<ToolOperationsClientSnapshot | null> | null = null
let source = $state.raw<ToolOperationsClientSnapshot | null>(null)
let status = $state<'unread' | 'loading' | 'confirmed' | 'failed'>('unread')
let error = $state<string | null>(null)
let version = $state(0)
export function getToolOperationsSource() { return { owner, source, status, error, version } }
export function setToolOperationsOwner(userId: string | null) {
  if (owner === userId) return
  owner = userId; epoch += 1; demand += 1; pending = null
  source = null; status = 'unread'; error = null; version += 1
}
export function resetToolOperationsSource() { setToolOperationsOwner(null) }
export function refreshToolOperationsSource(userId: string | null = owner): Promise<ToolOperationsClientSnapshot | null> {
  if (!browser || !userId || userId !== owner) return Promise.resolve(null)
  demand += 1
  if (pending) return pending
  const readEpoch = epoch
  status = 'loading'; error = null
  const run = async () => {
    try {
      let seen: number
      do {
        seen = demand
        try {
          const response = await fetch('/api/user/settings?toolOperations=1', { cache: 'no-store' })
          if (!response.ok) throw new Error('Saved global tool options could not load. Read them again before another choice.')
          const next = parseToolOperationsResponse(await response.json())
          if (epoch === readEpoch && owner === userId && seen === demand) { source = next; status = 'confirmed'; error = null; version += 1 }
        } catch (cause) {
          if (epoch === readEpoch && owner === userId && seen === demand) { status = 'failed'; error = cause instanceof Error ? cause.message : 'Global tool options could not load'; version += 1 }
        }
      } while (epoch === readEpoch && owner === userId && seen !== demand)
      return epoch === readEpoch && owner === userId ? source : null
    } finally { if (epoch === readEpoch) pending = null }
  }
  pending = run()
  return pending
}
/** An owned save may advance its original cache base; never overwrite a different confirmed read. */
export function acceptToolOperationsSourceAck(userId: string, expected: string, snapshot: ToolOperationsClientSnapshot): boolean {
  if (owner !== userId || source && source.revision !== expected && source.revision !== snapshot.revision) return false
  demand += 1 // Any older in-flight response loses and drains one current read.
  source = snapshot; status = 'confirmed'; error = null; version += 1
  return true
}
