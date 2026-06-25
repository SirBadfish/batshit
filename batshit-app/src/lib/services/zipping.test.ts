import { beforeEach, describe, expect, it, vi } from 'vitest'
import { zippingService } from './zipping'

const jsonResponse = (payload: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })

describe('zippingService manual zip state', () => {
  beforeEach(() => {
    zippingService.hydrate('test-reset', [])
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

  it('increments and persists temporary unzip message countdowns', () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return jsonResponse({ success: true })
    }) as unknown as typeof fetch

    zippingService.hydrate('session-007-countdown', [
      {
        zipId: 'zip-countdown',
        sessionId: 'session-007-countdown',
        permanent: false,
        duration: 10,
        messageCount: 4,
        unzippedAt: 123,
        source: 'user',
      },
    ])

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

  it('does not burn countdowns for messages added to another session', () => {
    const fetcher = vi.fn(async () => jsonResponse({ success: true })) as unknown as typeof fetch

    zippingService.hydrate('session-visible', [
      {
        zipId: 'zip-countdown',
        sessionId: 'session-visible',
        permanent: false,
        duration: 10,
        messageCount: 4,
        unzippedAt: 123,
        source: 'user',
      },
    ])

    zippingService.incrementMessageCount('session-background', fetcher)

    expect(zippingService.getUnzippedInfo('zip-countdown')?.messageCount).toBe(4)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
