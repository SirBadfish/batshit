import { describe, expect, it, beforeEach } from 'vitest'
import { InMemoryRateLimiter, resetRateLimiterBucketsForTest } from './rateLimiter'
import type { RequestEvent } from '@sveltejs/kit'

function makeEvent({
  ip = '127.0.0.1',
  userAgent = 'vitest'
}: {
  ip?: string
  userAgent?: string
} = {}): RequestEvent {
  return {
    request: new Request('http://localhost/api/test', {
      headers: {
        'user-agent': userAgent
      }
    }),
    getClientAddress: () => ip
  } as RequestEvent
}

describe('InMemoryRateLimiter', () => {
  beforeEach(() => {
    resetRateLimiterBucketsForTest()
  })

  it('limits repeated requests from the same IP', async () => {
    const limiter = new InMemoryRateLimiter({ IP: [2, 'h'] })
    const event = makeEvent()

    await expect(limiter.check(event)).resolves.toEqual({ limited: false })
    await expect(limiter.check(event)).resolves.toEqual({ limited: false })

    const result = await limiter.check(event)
    expect(result.limited).toBe(true)
    expect(result.reason).toContain('IP exceeded 2/h')
  })

  it('tracks IP plus user-agent separately from the IP-only bucket', async () => {
    const limiter = new InMemoryRateLimiter({ IP: [10, 'h'], IPUA: [1, 'h'] })

    await expect(limiter.check(makeEvent({ userAgent: 'first' }))).resolves.toEqual({
      limited: false
    })
    await expect(limiter.check(makeEvent({ userAgent: 'second' }))).resolves.toEqual({
      limited: false
    })

    const result = await limiter.check(makeEvent({ userAgent: 'first' }))
    expect(result.limited).toBe(true)
    expect(result.reason).toContain('IPUA exceeded 1/h')
  })
})
