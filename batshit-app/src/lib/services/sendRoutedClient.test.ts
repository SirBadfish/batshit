import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { postSendRouted, type SendRoutedClientDeps } from './sendRoutedClient'
import type { LiveSubscriptionHandlers, LiveTarget } from './liveHub/liveHubClient'

/**
 * A browser send no longer holds a connection for the whole reply (2026-09-18).
 *
 * The page awaited `POST /api/messages/send-routed` until the turn was over, and each running
 * reply held one of the browser's six HTTP/1.1 connections to the server: five replies at once
 * froze every other request of every tab, Stop included (`_local/sconn-proof/`). `postSendRouted`
 * asks for the answer once the server owns the turn (`Prefer: respond-async`) and then waits
 * for the turn's FINAL answer over the live hub, which already holds the browser's one live
 * connection. It resolves with a `Response` made from that answer, so every caller runs on
 * exactly what it read before: the status, the error body, the 409 retry, the toasts.
 */

type Subscribed = {
  target: LiveTarget
  handlers: LiveSubscriptionHandlers
  unsubscribed: boolean
}

function setup(answers: Array<Response | Error>) {
  const posts: Array<{ url: string; init: RequestInit }> = []
  const subscriptions: Subscribed[] = []
  const deps: SendRoutedClientDeps = {
    fetch: vi.fn(async (url: any, init: any) => {
      posts.push({ url: String(url), init })
      if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
      const next = answers.shift()
      if (!next) throw new Error('no answer left')
      if (next instanceof Error) throw next
      return next
    }) as any,
    subscribe: vi.fn((target: LiveTarget, handlers: LiveSubscriptionHandlers) => {
      const entry: Subscribed = { target, handlers, unsubscribed: false }
      subscriptions.push(entry)
      return {
        id: `sub-${subscriptions.length}`,
        state: () => 'pending' as const,
        unsubscribe: () => {
          entry.unsubscribed = true
        }
      }
    }),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
  return { deps, posts, subscriptions }
}

function accepted(turnId = 'turn_0123456789abcdef') {
  return new Response(JSON.stringify({ accepted: true, turnId, sessionId: 's-1' }), {
    status: 202,
    headers: { 'content-type': 'application/json', 'preference-applied': 'respond-async' }
  })
}

function turnOver(turnId: string, status: number, body: unknown, contentType = 'application/json') {
  return JSON.stringify({
    type: 'turn_over',
    turnId,
    status,
    contentType,
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
}

async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('postSendRouted', () => {
  it('asks for the answer once the server owns the turn, with the body and signal it was given', async () => {
    const { deps, posts } = setup([new Response('{"success":true}', { status: 200 })])
    const signal = new AbortController().signal
    await postSendRouted('{"content":"hi"}', { signal }, deps)
    expect(posts).toHaveLength(1)
    expect(posts[0].url).toBe('/api/messages/send-routed')
    expect(posts[0].init.method).toBe('POST')
    expect(new Headers(posts[0].init.headers).get('prefer')).toBe('respond-async')
    expect(new Headers(posts[0].init.headers).get('content-type')).toBe('application/json')
    expect(posts[0].init.body).toBe('{"content":"hi"}')
    expect(posts[0].init.signal).toBe(signal)
  })

  it('returns a direct answer untouched: a refusal before the lock is still an HTTP error', async () => {
    const refusal = new Response(JSON.stringify({ error: 'busy', code: 'session_turn_in_progress' }), { status: 409 })
    const { deps, subscriptions } = setup([refusal])
    const response = await postSendRouted('{}', {}, deps)
    expect(response).toBe(refusal)
    expect(subscriptions).toHaveLength(0)
  })

  it('waits for the turn’s final answer over the live hub, and gives back exactly that', async () => {
    const { deps, subscriptions } = setup([accepted('turn_aaaa1111')])
    let settled: Response | null = null
    const waiting = postSendRouted('{}', {}, deps).then((response) => {
      settled = response
      return response
    })
    await flush()
    expect(subscriptions).toHaveLength(1)
    expect(subscriptions[0].target).toEqual({ scope: 'turn', turnId: 'turn_aaaa1111' })
    expect(settled).toBeNull()

    const finalBody = { error: 'Failed to stream response', details: 'The provider said "no".' }
    subscriptions[0].handlers.onEvent(turnOver('turn_aaaa1111', 502, finalBody))
    const response = await waiting
    expect(response.status).toBe(502)
    expect(response.ok).toBe(false)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toEqual(finalBody)
    expect(subscriptions[0].unsubscribed).toBe(true)
  })

  it('an accepted and finished turn reads as the old 200 answer', async () => {
    const { deps, subscriptions } = setup([accepted('turn_bbbb2222')])
    const waiting = postSendRouted('{}', {}, deps)
    await flush()
    subscriptions[0].handlers.onEvent(turnOver('turn_bbbb2222', 200, { success: true, messageId: 'm-1' }))
    const response = await waiting
    expect(response.ok).toBe(true)
    expect(await response.json()).toEqual({ success: true, messageId: 'm-1' })
  })

  it('ignores anything that is not this turn’s answer', async () => {
    const { deps, subscriptions } = setup([accepted('turn_cccc3333')])
    let done = false
    const waiting = postSendRouted('{}', {}, deps).then((response) => {
      done = true
      return response
    })
    await flush()
    subscriptions[0].handlers.onEvent('not json')
    subscriptions[0].handlers.onEvent(JSON.stringify({ type: 'connected' }))
    subscriptions[0].handlers.onEvent(turnOver('turn_other', 200, {}))
    await flush()
    expect(done).toBe(false)
    subscriptions[0].handlers.onEvent(turnOver('turn_cccc3333', 200, {}))
    expect((await waiting).status).toBe(200)
  })

  it('Stop ends the wait at once, as it ended the request: an AbortError, and the hub lets go', async () => {
    const { deps, subscriptions } = setup([accepted()])
    const controller = new AbortController()
    const waiting = postSendRouted('{}', { signal: controller.signal }, deps)
    await flush()
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    expect(subscriptions[0].unsubscribed).toBe(true)
  })

  it('a live connection that drops and comes back keeps waiting (the hub re-adds the turn)', async () => {
    const { deps, subscriptions } = setup([accepted('turn_dddd4444')])
    const waiting = postSendRouted('{}', {}, deps)
    await flush()
    subscriptions[0].handlers.onStatus?.('down')
    subscriptions[0].handlers.onStatus?.('open')
    subscriptions[0].handlers.onEvent(turnOver('turn_dddd4444', 200, {}))
    expect((await waiting).status).toBe(200)
    expect(subscriptions).toHaveLength(1)
  })

  it('a turn the server no longer knows (it restarted) is a failed send', async () => {
    const { deps, subscriptions } = setup([accepted()])
    const waiting = postSendRouted('{}', {}, deps)
    await flush()
    subscriptions[0].handlers.onStatus?.('refused', 'turn_not_found')
    await expect(waiting).rejects.toThrow('Failed to send message')
    expect(subscriptions[0].unsubscribed).toBe(true)
  })

  it('any other refusal subscribes again, and the answer still arrives', async () => {
    const { deps, subscriptions } = setup([accepted('turn_eeee5555')])
    const waiting = postSendRouted('{}', {}, deps)
    await flush()
    subscriptions[0].handlers.onStatus?.('refused', 'hub_closed')
    expect(subscriptions[0].unsubscribed).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(subscriptions).toHaveLength(2)
    expect(subscriptions[1].target).toEqual({ scope: 'turn', turnId: 'turn_eeee5555' })
    subscriptions[1].handlers.onEvent(turnOver('turn_eeee5555', 200, {}))
    expect((await waiting).status).toBe(200)
  })

  it('gives up after repeated refusals instead of waiting forever', async () => {
    const { deps, subscriptions } = setup([accepted()])
    const waiting = postSendRouted('{}', {}, deps)
    const outcome = waiting.then(
      () => 'resolved',
      (error) => String(error?.message)
    )
    await flush()
    for (let attempt = 0; attempt < 12 && subscriptions.at(-1) && !subscriptions.at(-1)!.unsubscribed; attempt += 1) {
      subscriptions.at(-1)!.handlers.onStatus?.('refused', 'attach_failed')
      await vi.advanceTimersByTimeAsync(60_000)
    }
    expect(await outcome).toBe('Failed to send message')
    expect(subscriptions.length).toBeGreaterThan(1)
    expect(subscriptions.length).toBeLessThanOrEqual(8)
  })

  it('a 202 the server did not mark as respond-async is an ordinary answer', async () => {
    const plain = new Response('{"accepted":true}', { status: 202 })
    const { deps, subscriptions } = setup([plain])
    expect(await postSendRouted('{}', {}, deps)).toBe(plain)
    expect(subscriptions).toHaveLength(0)
  })

  it('an answer with no body status keeps no body', async () => {
    const { deps, subscriptions } = setup([accepted('turn_ffff6666')])
    const waiting = postSendRouted('{}', {}, deps)
    await flush()
    subscriptions[0].handlers.onEvent(turnOver('turn_ffff6666', 204, ''))
    const response = await waiting
    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
  })

  it('says when the server accepted the send, once, before the turn’s final answer', async () => {
    const { deps, subscriptions } = setup([accepted('turn_cccc3333')])
    const order: string[] = []
    const waiting = postSendRouted('{}', { onAccepted: () => order.push('accepted') }, deps).then(
      (response) => {
        order.push(`final ${response.status}`)
        return response
      }
    )
    await flush()
    expect(order).toEqual(['accepted'])
    subscriptions[0].handlers.onEvent(turnOver('turn_cccc3333', 502, { error: 'provider failed' }))
    await waiting
    expect(order).toEqual(['accepted', 'final 502'])
  })

  it('never says accepted for an answer before the lock, or for a 202 it cannot follow', async () => {
    const onAccepted = vi.fn()
    const refusal = new Response(JSON.stringify({ code: 'session_turn_in_progress' }), { status: 409 })
    const first = setup([refusal])
    await postSendRouted('{}', { onAccepted }, first.deps)

    const nameless = setup([
      new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { 'content-type': 'application/json', 'preference-applied': 'respond-async' }
      })
    ])
    await expect(postSendRouted('{}', { onAccepted }, nameless.deps)).rejects.toThrow('Failed to send message')
    expect(onAccepted).not.toHaveBeenCalled()
  })
})

