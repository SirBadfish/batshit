import { afterEach, describe, expect, it, vi } from 'vitest'
import { sha256Hex } from '$lib/utils/sha256'
import { forgetImageOrigins, getImageOriginDisplay, refreshImageOrigins } from '../imageAddressOrigins.svelte'

const session = 'image-origin-tab'
const address = 'https://pictures.example.org/cat.png'
const text = `<img src="${address}">`
const expected = { imageOriginExpected: true, imageOriginExpectedVersion: 2 }
const record = (version = 2, hashes = [sha256Hex(text)]) => ({
  messageId: 'reply', version, state: 'decided', textHashes: hashes, lane: 'api', complete: true,
  addresses: { [address]: { state: 'as_read', rule: 1, evidence: { inRecord: true, startInRecord: false, sharesChatRun: false, complete: true } } }
})
const response = (records: unknown) => new Response(JSON.stringify({ records }), { status: 200 })
const display = (metadata: unknown = expected, content = text, isStreaming = false, src = address) =>
  getImageOriginDisplay({ sessionId: session, messageId: 'reply', content, metadata, isStreaming, address: src })

afterEach(() => forgetImageOrigins(session))

describe('server image origins in a browser tab', () => {
  it('uses the server outcome without recalculating it in the client table', async () => {
    const projected=record()
    projected.addresses[address].state='blocked'
    projected.addresses[address].rule=4
    await refreshImageOrigins(session,(async()=>response({reply:projected})) as typeof fetch)
    expect(display().state).toBe('blocked')
  })
  it('requires an exact expected version AND text hash, even on an old same-text resume', async () => {
    await refreshImageOrigins(session, (async () => response({ reply: record() })) as typeof fetch)
    expect(display().state).toBe('as_read')
    expect(display({ ...expected, imageOriginExpectedVersion: 3 }).state).toBe('pending')
    expect(display(expected, `${text} changed`).state).toBe('pending')
    expect(display(expected, text, true).state).toBe('pending')
    expect(display(expected, text, false, `${address}?new`).state).toBe('pending')
    expect(display({ imageOriginExpected: true }).state).toBe('pending')
  })

  it('distinguishes legacy absence from failed or malformed reads and expected absence', async () => {
    expect(display(undefined).state).toBe('pending')
    await refreshImageOrigins(session, (async () => response({})) as typeof fetch)
    expect(display({}).state).toBe('unknown')
    expect(display().state).toBe('pending')
    await refreshImageOrigins(session, (async () => new Response('{}', { status: 500 })) as typeof fetch)
    expect(display({}).state).toBe('pending')
    await refreshImageOrigins(session, (async () => response({ reply: { ...record(), textHashes: ['bad'] } })) as typeof fetch)
    expect(display({}).state).toBe('pending')
  })

  it('never applies a fetched decision lacking an expected version', async () => {
    await refreshImageOrigins(session, (async () => response({ reply: record() })) as typeof fetch)
    expect(display({}).state).toBe('pending')
  })

  it('coalesces events while a read runs, refuses its stale result, and does one trailing read', async () => {
    let resolve!: (value: Response) => void
    const pending = new Promise<Response>((done) => { resolve = done })
    const fetcher = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(response({ reply: record() }))
    const first = refreshImageOrigins(session, fetcher)
    const second = refreshImageOrigins(session, fetcher)
    const third = refreshImageOrigins(session, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
    resolve(response({}))
    await Promise.all([first, second, third])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(display().state).toBe('as_read')
  })

  it('cannot revive a deleted chat with a late read', async () => {
    let resolve!: (value: Response) => void
    const pending = new Promise<Response>((done) => { resolve = done })
    const request = refreshImageOrigins(session, (() => pending) as typeof fetch)
    forgetImageOrigins(session)
    resolve(response({ reply: record() }))
    await request
    expect(display().state).toBe('pending')
  })
})
