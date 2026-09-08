import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WAKE_CALLBACK_TIMEOUT_MS } from '$lib/utils/dmControl'
import { deliverWakeCallback, isAllowedCallbackUrl } from '../wakeCallback'

/**
 * SA-113 P3 (DL-113-09) — the one-shot webhook result callback.
 *
 * It fires once, waits ten seconds, and never retries. What is pinned here is that it can
 * never turn a successful close into a failure, and that its status string tells the truth
 * about what happened.
 */

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('which URLs are allowed', () => {
  it('accepts http and https, including loopback', () => {
    // n8n on 127.0.0.1 or host.docker.internal is the main thing this exists for, so an
    // SSRF block list here would break the feature it was written for.
    expect(isAllowedCallbackUrl('http://127.0.0.1:5678/webhook/x')).toBe(true)
    expect(isAllowedCallbackUrl('http://host.docker.internal:5678/webhook/x')).toBe(true)
    expect(isAllowedCallbackUrl('https://example.test/hook')).toBe(true)
  })

  it('refuses every other scheme and anything unparseable', () => {
    expect(isAllowedCallbackUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedCallbackUrl('data:text/plain,hi')).toBe(false)
    expect(isAllowedCallbackUrl('ftp://example.test/x')).toBe(false)
    expect(isAllowedCallbackUrl('not a url')).toBe(false)
    expect(isAllowedCallbackUrl('')).toBe(false)
    expect(isAllowedCallbackUrl(undefined)).toBe(false)
  })
})

describe('delivering', () => {
  const payload = {
    dm_id: 'dm_1',
    status: 'done' as const,
    result: 'Build is green.',
    agent: { id: 'agent-cooper', name: 'Cooper' },
    completed_at: '2026-09-07T10:00:00.000Z'
  }

  it('POSTs the payload as JSON and reports the status', async () => {
    const calls: { url: string; init: any }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any, init?: any) => {
        calls.push({ url: String(input), init })
        return new Response('ok', { status: 200 })
      })
    )

    const status = await deliverWakeCallback('http://127.0.0.1:5678/webhook/result', payload)

    expect(status).toBe('delivered: 200')
    expect(calls).toHaveLength(1)
    expect(calls[0].init.method).toBe('POST')
    // A redirect would send the payload somewhere the user did not name.
    expect(calls[0].init.redirect).toBe('manual')
    expect(JSON.parse(calls[0].init.body)).toEqual(payload)
  })

  it('reports a non-2xx answer as failed without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    await expect(deliverWakeCallback('https://example.test/hook', payload)).resolves.toBe(
      'failed: 500'
    )
  })

  it('reports a network failure without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      })
    )
    await expect(deliverWakeCallback('https://example.test/hook', payload)).resolves.toMatch(
      /^failed: ECONNREFUSED/
    )
  })

  it('gives up after the timeout and says so', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: any, init?: any) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            )
          })
      )
    )

    vi.useFakeTimers()
    const pending = deliverWakeCallback('https://example.test/slow', payload)
    await vi.advanceTimersByTimeAsync(WAKE_CALLBACK_TIMEOUT_MS + 10)

    await expect(pending).resolves.toMatch(/^failed: no answer within 10s/)
  })

  it('skips a URL it would never have accepted', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(deliverWakeCallback('file:///etc/passwd', payload)).resolves.toMatch(/^skipped/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
