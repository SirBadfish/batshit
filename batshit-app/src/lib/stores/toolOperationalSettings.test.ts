import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('$app/env', () => ({ browser: true }))
import { resolveToolOperationalSettings } from '$lib/utils/toolOperationalSettings'
import { acceptToolOperationsSourceAck, getToolOperationsSource, refreshToolOperationsSource, resetToolOperationsSource, setToolOperationsOwner } from './toolOperationalSettings.svelte'
const token = (value: string) => `sha256:${value.repeat(64)}`
const envelope = (value: string, provider = 'duckduckgo-html') => ({ toolOperations: { revision: token(value), values: { ...resolveToolOperationalSettings(null), webSearchProvider: provider } } })
const response = (value: string, provider?: string) => Response.json(envelope(value, provider))
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
beforeEach(() => { resetToolOperationsSource(); setToolOperationsOwner('owner') })
afterEach(() => { resetToolOperationsSource(); vi.unstubAllGlobals() })
describe('global operational read-source ownership', () => {
  it('retains last known good on failed/malformed reads and never manufactures a baseline', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response('a')).mockResolvedValueOnce(new Response('unavailable', { status: 503 })).mockResolvedValueOnce(Response.json({ toolOperations: {} }))
    vi.stubGlobal('fetch', fetch)
    await refreshToolOperationsSource(); expect(getToolOperationsSource().status).toBe('confirmed')
    await refreshToolOperationsSource(); expect(getToolOperationsSource()).toMatchObject({ status: 'failed', source: { revision: token('a') } })
    await refreshToolOperationsSource(); expect(getToolOperationsSource()).toMatchObject({ status: 'failed', source: { revision: token('a') } })
  })
  it('discards an older demand and coalesces the event into one trailing current read', async () => {
    const first = deferred<Response>()
    const fetch = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(response('b', 'exa'))
    vi.stubGlobal('fetch', fetch)
    const reading = refreshToolOperationsSource(); const trailing = refreshToolOperationsSource()
    expect(fetch).toHaveBeenCalledOnce(); first.resolve(response('a'))
    await Promise.all([reading, trailing])
    expect(fetch).toHaveBeenCalledTimes(2); expect(getToolOperationsSource().source?.revision).toBe(token('b'))
  })
  it('does not publish another user or an older owner epoch after reset', async () => {
    const old = deferred<Response>(); const fetch = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(response('b'))
    vi.stubGlobal('fetch', fetch)
    const prior = refreshToolOperationsSource(); setToolOperationsOwner('new-owner'); await refreshToolOperationsSource('new-owner')
    old.resolve(response('a')); await prior
    expect(getToolOperationsSource()).toMatchObject({ owner: 'new-owner', source: { revision: token('b') } })
  })
  it('will not let an older own save receipt replace a different confirmed snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response('c')))
    await refreshToolOperationsSource()
    expect(acceptToolOperationsSourceAck('owner', token('a'), envelope('b').toolOperations as any)).toBe(false)
    expect(getToolOperationsSource().source?.revision).toBe(token('c'))
    expect(acceptToolOperationsSourceAck('owner', token('c'), envelope('d').toolOperations as any)).toBe(true)
    expect(getToolOperationsSource().source?.revision).toBe(token('d'))
  })
})
