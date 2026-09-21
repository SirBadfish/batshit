import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createZipStateView, zippingService, type UnzippedItem } from './zipping'

const jsonResponse = (payload: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })

/** Serves one session's stored unzips to the tab's load, the way `/api/unzipping` does. */
const storedStateFetcher = (unzipped: UnzippedItem[]) =>
  vi.fn(async () => jsonResponse({ unzipped, rezipped: [], rezippedSources: {} })) as unknown as typeof fetch

let resetCount = 0

describe('zippingService manual zip state', () => {
  beforeEach(async () => {
    resetCount += 1
    await zippingService.setCurrentSession(`test-reset-${resetCount}`, storedStateFetcher([]))
    vi.restoreAllMocks()
  })

  it('loads persisted manual rezips alongside unzipped items', async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        unzipped: [
          {
            zipId: 'zip-expanded',
            sessionId: 'session-007-load',
            permanent: true,
            unzippedAt: 123,
            source: 'user',
          },
        ],
        rezipped: ['zip-manual'],
        rezippedSources: {
          'zip-manual': 'agent',
        },
      }),
    ) as unknown as typeof fetch

    await zippingService.setCurrentSession('session-007-load', fetcher)

    expect(zippingService.isUnzipped('zip-expanded')).toBe(true)
    expect(zippingService.isRezipped('zip-manual')).toBe(true)
    expect(zippingService.getRezippedSource('zip-manual')).toBe('agent')
  })

  it('persists zip-now and then clears it when returning to automatic', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.startsWith('/api/unzipping?')) {
        return jsonResponse({ unzipped: [], rezipped: [], rezippedSources: {} })
      }
      return jsonResponse({ success: true })
    }) as unknown as typeof fetch

    await zippingService.setCurrentSession('session-007-manual', fetcher)
    await zippingService.unzip(
      'zip-target',
      true,
      20,
      'Read File',
      'Read File output',
      857,
      'user',
      fetcher,
    )

    expect(zippingService.isUnzipped('zip-target')).toBe(true)

    await zippingService.rezip('zip-target', 'user', fetcher)

    expect(zippingService.isUnzipped('zip-target')).toBe(false)
    expect(zippingService.isRezipped('zip-target')).toBe(true)
    expect(zippingService.getRezippedSource('zip-target')).toBe('user')
    expect(calls.some((call) =>
      call.url === '/api/unzipping/zip-target?sessionId=session-007-manual&source=user' &&
      call.init?.method === 'DELETE'
    )).toBe(true)

    await zippingService.returnToAutomatic('zip-target', fetcher)

    expect(zippingService.isUnzipped('zip-target')).toBe(false)
    expect(zippingService.isRezipped('zip-target')).toBe(false)
    expect(calls.some((call) =>
      call.url === '/api/unzipping/zip-target?sessionId=session-007-manual&mode=automatic' &&
      call.init?.method === 'DELETE'
    )).toBe(true)
  })

  it('increments and persists temporary unzip message countdowns', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return jsonResponse({ success: true })
    }) as unknown as typeof fetch

    await zippingService.setCurrentSession('session-007-countdown', storedStateFetcher([
      {
        zipId: 'zip-countdown',
        sessionId: 'session-007-countdown',
        permanent: false,
        duration: 10,
        messageCount: 4,
        unzippedAt: 123,
        source: 'user',
      },
    ]))

    zippingService.incrementMessageCount('session-007-countdown', fetcher)

    expect(zippingService.getUnzippedInfo('zip-countdown')?.messageCount).toBe(5)
    const postCall = calls.find((call) =>
      call.url === '/api/unzipping' &&
      call.init?.method === 'POST'
    )
    expect(postCall).toBeTruthy()
    expect(JSON.parse(String(postCall?.init?.body))).toMatchObject({
      zipId: 'zip-countdown',
      messageCount: 5,
      duration: 10,
      source: 'user',
    })
  })

  it('does not burn countdowns for messages added to another session', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ success: true })) as unknown as typeof fetch

    await zippingService.setCurrentSession('session-visible', storedStateFetcher([
      {
        zipId: 'zip-countdown',
        sessionId: 'session-visible',
        permanent: false,
        duration: 10,
        messageCount: 4,
        unzippedAt: 123,
        source: 'user',
      },
    ]))

    zippingService.incrementMessageCount('session-background', fetcher)

    expect(zippingService.getUnzippedInfo('zip-countdown')?.messageCount).toBe(4)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('keeps an inferred source on load, and re-reads the session from the server on demand (SA-120 P5)', async () => {
    let served = { unzipped: [] as unknown[], rezipped: [] as string[], rezippedSources: {} as Record<string, string> }
    const fetcher = vi.fn(async () => jsonResponse(served)) as unknown as typeof fetch

    await zippingService.setCurrentSession('session-inferred', fetcher)
    expect(zippingService.getAllUnzipped()).toEqual([])

    // The SERVER opened one and zipped another at the accepted-send boundary; nothing was posted from here.
    served = {
      unzipped: [
        { zipId: 'zip-opened', sessionId: 'session-inferred', permanent: false, duration: 2, messageCount: 0, unzippedAt: 1, source: 'inferred' }
      ],
      rezipped: ['zip-closed', 'zip-odd'],
      rezippedSources: { 'zip-closed': 'inferred', 'zip-odd': 'mystery' }
    }
    const changed = vi.fn()
    window.addEventListener('batshit:zip-state-changed', changed)
    await zippingService.refreshFromServer('session-inferred', fetcher)
    window.removeEventListener('batshit:zip-state-changed', changed)

    expect(zippingService.getUnzippedInfo('zip-opened')).toMatchObject({ source: 'inferred', duration: 2, permanent: false })
    expect(zippingService.getRezippedSource('zip-closed')).toBe('inferred')
    // An unknown source is never invented into the map.
    expect(zippingService.getRezippedSource('zip-odd')).toBeUndefined()
    expect(changed).toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: 'POST' }))
  })

  it('burns an inferred unzip with the ordinary countdown and persists it with its source intact (SA-120 P5)', async () => {
    const posted: any[] = []
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') posted.push(JSON.parse(String(init.body)))
      return jsonResponse({
        unzipped: [
          { zipId: 'zip-opened', sessionId: 'session-burn', permanent: false, duration: 2, messageCount: 0, unzippedAt: 1, source: 'inferred' }
        ],
        rezipped: [],
        rezippedSources: {}
      })
    }) as unknown as typeof fetch
    await zippingService.setCurrentSession('session-burn', fetcher)

    zippingService.incrementMessageCount('session-burn', fetcher)
    await Promise.resolve()
    expect(zippingService.getUnzippedInfo('zip-opened')?.messageCount).toBe(1)
    expect(posted).toEqual([expect.objectContaining({ zipId: 'zip-opened', messageCount: 1, source: 'inferred' })])

    // The second message reaches the duration: it returns to automatic, like any timed unzip.
    zippingService.incrementMessageCount('session-burn', fetcher)
    expect(zippingService.isUnzipped('zip-opened')).toBe(false)
  })
})

describe('createZipStateView (F-P5-11: one per server compile)', () => {
  const item = (zipId: string, sessionId: string, overrides: Partial<UnzippedItem> = {}): UnzippedItem => ({
    zipId,
    sessionId,
    permanent: false,
    duration: 2,
    messageCount: 0,
    unzippedAt: 1,
    source: 'user',
    ...overrides
  })

  it('answers for its own chat only, and neither the tab singleton nor another view sees it', async () => {
    await zippingService.setCurrentSession('session-tab', storedStateFetcher([item('zip-tab', 'session-tab')]))

    const chatA = createZipStateView([item('zip-a', 'session-a')], ['zip-a-closed'], { 'zip-a-closed': 'agent' })
    const chatB = createZipStateView([item('zip-b', 'session-b', { source: 'inferred' })])

    expect(chatA.isUnzipped('zip-a')).toBe(true)
    expect(chatA.isUnzipped('zip-b')).toBe(false)
    expect(chatA.isRezipped('zip-a-closed')).toBe(true)
    expect(chatA.getRezippedSource('zip-a-closed')).toBe('agent')
    expect(chatB.isUnzipped('zip-a')).toBe(false)
    expect(chatB.isRezipped('zip-a-closed')).toBe(false)
    expect(chatB.getUnzippedInfo('zip-b')?.source).toBe('inferred')
    expect(zippingService.getAllUnzipped().map((entry) => entry.zipId)).toEqual(['zip-tab'])
    expect(zippingService.isUnzipped('zip-a')).toBe(false)
  })

  it('keeps first-seen order, lets a later record for the same zip replace the earlier one, and drops an unknown rezip source', () => {
    const view = createZipStateView(
      [
        item('zip-1', 'session-a'),
        item('zip-2', 'session-a'),
        item('zip-1', 'session-a', { source: 'inferred', duration: 5 }),
        { ...item('', 'session-a') }
      ],
      ['zip-closed', 'zip-odd'],
      { 'zip-closed': 'inferred', 'zip-odd': 'mystery' as never }
    )

    expect(view.getAllUnzipped().map((entry) => [entry.zipId, entry.source, entry.duration])).toEqual([
      ['zip-1', 'inferred', 5],
      ['zip-2', 'user', 2]
    ])
    expect(view.getRezippedSource('zip-closed')).toBe('inferred')
    expect(view.isRezipped('zip-odd')).toBe(true)
    expect(view.getRezippedSource('zip-odd')).toBeUndefined()
  })

  it('is read-only and does not change when the records it was built from change', () => {
    const items = [item('zip-1', 'session-a')]
    const rezipped = ['zip-closed']
    const view = createZipStateView(items, rezipped)

    items.push(item('zip-late', 'session-a'))
    items[0].source = 'agent'
    rezipped.push('zip-late-closed')

    expect(view.getAllUnzipped().map((entry) => [entry.zipId, entry.source])).toEqual([['zip-1', 'user']])
    expect(view.isRezipped('zip-late-closed')).toBe(false)
    expect(Object.isFrozen(view)).toBe(true)
    expect(() => {
      ;(view.getUnzippedInfo('zip-1') as UnzippedItem).source = 'agent'
    }).toThrow(TypeError)
    // A caller that edits the list it was handed changes nothing inside the view.
    view.getAllUnzipped().pop()
    expect(view.getAllUnzipped()).toHaveLength(1)
  })
})
