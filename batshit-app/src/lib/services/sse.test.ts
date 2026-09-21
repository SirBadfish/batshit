import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveSubscriptionHandlers, LiveTarget } from '$lib/services/liveHub/liveHubClient'

/**
 * `SSEService` over the live hub (2026-09-18): the chat page's `connect` / `disconnect` /
 * `isConnected` keep their meaning while the connection itself is shared by every tab.
 */

type FakeSubscription = {
  target: LiveTarget
  handlers: LiveSubscriptionHandlers
  id: string
  current: 'pending' | 'open' | 'down' | 'refused'
  unsubscribed: boolean
  state(): 'pending' | 'open' | 'down' | 'refused'
  unsubscribe(): void
  status(status: 'open' | 'down' | 'refused', code?: string): void
}

const hub = vi.hoisted(() => ({ subscriptions: [] as any[] }))

vi.mock('$lib/services/liveHub/liveHubClient', () => ({
  subscribeLive: vi.fn((target: LiveTarget, handlers: LiveSubscriptionHandlers) => {
    const subscription: FakeSubscription = {
      target,
      handlers,
      id: `sub-${hub.subscriptions.length}`,
      current: 'pending',
      unsubscribed: false,
      state: () => subscription.current,
      unsubscribe: () => {
        subscription.unsubscribed = true
      },
      status: (status, code) => {
        subscription.current = status
        handlers.onStatus?.(status, code)
      }
    }
    hub.subscriptions.push(subscription)
    return subscription
  })
}))

import { SSEService } from './sse'

function last(): FakeSubscription {
  return hub.subscriptions.at(-1)
}

describe('SSEService over the live hub', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    hub.subscriptions.length = 0
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('subscribes to its chat and resolves only once the server has added it', async () => {
    const service = new SSEService('session-1')
    let resolved = false
    const connecting = service.connect(() => {}).then(() => {
      resolved = true
    })
    expect(last().target).toEqual({ scope: 'session', sessionId: 'session-1' })
    await Promise.resolve()
    expect(resolved).toBe(false)
    expect(service.isConnected()).toBe(false)

    last().status('open')
    await connecting
    expect(service.isConnected()).toBe(true)
  })

  it('hands each event to the page parsed, and logs a malformed one without throwing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const service = new SSEService('session-1')
    const received: unknown[] = []
    const connecting = service.connect((data) => received.push(data))
    last().handlers.onEvent(JSON.stringify({ type: 'connected', sessionId: 'session-1' }))
    last().status('open')
    await connecting
    last().handlers.onEvent('{not json')
    last().handlers.onEvent(JSON.stringify({ type: 'chunk', content: 'hi' }))

    expect(received).toEqual([{ type: 'connected', sessionId: 'session-1' }, { type: 'chunk', content: 'hi' }])
    expect(errors).toHaveBeenCalledWith('[SSE] Failed to parse message:', expect.any(SyntaxError), '{not json')
  })

  it('times out after five seconds, lets go of the subscription, and rejects', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const service = new SSEService('session-3')
    const connection = service.connect(() => {}).catch((error) => error)

    await vi.advanceTimersByTimeAsync(4999)
    expect(last().unsubscribed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    const error = await connection
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('SSE connection timeout')
    expect(last().unsubscribed).toBe(true)
    expect(service.isConnected()).toBe(false)
  })

  it('clears the pending timeout when disconnecting before the chat is added', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const service = new SSEService('session-1')
    const errors: string[] = []
    service.connect(() => {}).catch((error) => errors.push(error.message))

    service.disconnect()
    await vi.advanceTimersByTimeAsync(5000)

    expect(last().unsubscribed).toBe(true)
    expect(warnSpy).not.toHaveBeenCalledWith('[SSE] Connection timeout after 5 seconds')
    expect(errors).toEqual([])
  })

  it('ignores the old subscription after reconnecting', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const service = new SSEService('session-2')
    service.connect(() => {}).catch(() => {})
    const first = last()
    service.disconnect()

    const connected = service.connect(() => {})
    const second = last()
    first.status('refused', 'session_not_found')
    second.status('open')
    await connected
    await vi.advanceTimersByTimeAsync(5000)

    expect(warnSpy).not.toHaveBeenCalledWith('[SSE] Connection timeout after 5 seconds')
    expect(service.isConnected()).toBe(true)
    expect(second.unsubscribed).toBe(false)
  })

  it('rejects, reports, and lets go when the server refuses the chat', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const service = new SSEService('gone')
    const onError = vi.fn()
    const connection = service.connect(() => {}, onError).catch((error) => error)
    last().status('refused', 'session_not_found')

    const error = await connection
    expect(error.message).toBe('SSE subscription refused (session_not_found)')
    expect(onError).toHaveBeenCalledWith(error)
    expect(last().unsubscribed).toBe(true)
    expect(service.isConnected()).toBe(false)
  })

  it('reports a dropped connection and stays subscribed while the hub reconnects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const service = new SSEService('session-1')
    const onError = vi.fn()
    const connecting = service.connect(() => {}, onError)
    last().status('open')
    await connecting

    last().status('down')
    expect(onError).toHaveBeenCalledOnce()
    expect(service.isConnected()).toBe(false)
    expect(last().unsubscribed).toBe(false)

    last().status('open')
    expect(service.isConnected()).toBe(true)
  })
})
