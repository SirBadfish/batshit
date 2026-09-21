import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLiveHubClient, type HubClientPort, type LiveHubClient } from './liveHubClient'
import { HubCore, type HubStream, type HubStreamHandlers, type HubPortLike } from './hubCore'
import {
  formatHubFrameData,
  type HubClientMessage,
  type HubServerMessage,
  type HubSubscriptionChange
} from './protocol'

/**
 * Tabs and the hub together (2026-09-18): several tab clients talk to ONE `HubCore` the way tabs
 * talk to the SharedWorker (messages delivered later, never in the same call), and the hub holds
 * one fake stream for all of them.
 */

const OPEN = 1

class FakeStream implements HubStream {
  state = 0
  closed = false
  constructor(private readonly handlers: HubStreamHandlers) {}
  readyState() {
    return this.state
  }
  close() {
    this.closed = true
    this.state = 2
  }
  connect(hubId: string) {
    this.state = OPEN
    this.handlers.onMessage(JSON.stringify({ type: 'hub_connected', hubId }))
  }
  frame(subscriptionId: string, event: Record<string, unknown>) {
    const json = JSON.stringify(event)
    this.handlers.onMessage(formatHubFrameData(subscriptionId, json))
    return json
  }
}

async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

describe('live hub tab client', () => {
  let streams: FakeStream[]
  let changes: HubSubscriptionChange[]
  let core: HubCore
  let now: number
  let nextId: number

  beforeEach(() => {
    vi.useFakeTimers()
    streams = []
    changes = []
    now = 0
    nextId = 0
    core = new HubCore({
      openStream: (handlers) => {
        const stream = new FakeStream(handlers)
        streams.push(stream)
        return stream
      },
      patch: async (change) => {
        changes.push(change)
        return {
          status: 200,
          body: { added: (change.add ?? []).map((request) => request.id), removed: change.remove ?? [], refused: [] }
        }
      },
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      now: () => now,
      warn: () => {}
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** A tab's port to the shared hub; both directions deliver on a later microtask. */
  function openTab(): { client: LiveHubClient; sent: HubClientMessage[] } {
    const sent: HubClientMessage[] = []
    let deliver: ((message: HubServerMessage) => void) | null = null
    const hubSide: HubPortLike = {
      postMessage: (message) => queueMicrotask(() => deliver?.(message))
    }
    const port: HubClientPort = {
      postMessage: (message) => {
        sent.push(message)
        queueMicrotask(() => core.receive(hubSide, message))
      },
      onMessage: (handler) => {
        deliver = handler
      }
    }
    const client = createLiveHubClient({
      clientId: `tab-${nextId++}`,
      port,
      makeId: () => `sub-${nextId++}`,
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
      heartbeatMs: 15_000
    })
    return { client, sent }
  }

  it('five tabs, each with its user channel and its own chat, share one stream', async () => {
    const tabs = Array.from({ length: 5 }, () => openTab())
    const heard = tabs.map(() => [] as string[])
    const subscriptions = tabs.flatMap(({ client }, index) => [
      client.subscribe({ scope: 'user' }, { onEvent: (data) => heard[index].push(data) }),
      client.subscribe({ scope: 'session', sessionId: `chat-${index}` }, { onEvent: (data) => heard[index].push(data) })
    ])
    await flush()
    expect(streams).toHaveLength(1)

    streams[0].connect('hub-1')
    await flush()
    expect(changes).toHaveLength(1)
    expect(changes[0].add).toHaveLength(10)
    expect(subscriptions.every((subscription) => subscription.state() === 'open')).toBe(true)

    const chatOfTab3 = subscriptions[7]
    const json = streams[0].frame(chatOfTab3.id, { type: 'chunk', content: 'for tab 3 only' })
    await flush()
    expect(heard[3]).toEqual([json])
    expect(heard.filter((_, index) => index !== 3).flat()).toEqual([])
  })

  it('unsubscribing tells the hub; the last one closes the stream', async () => {
    const { client } = openTab()
    const user = client.subscribe({ scope: 'user' }, { onEvent: () => {} })
    const chat = client.subscribe({ scope: 'session', sessionId: 'chat-1' }, { onEvent: () => {} })
    await flush()
    streams[0].connect('hub-1')
    await flush()

    chat.unsubscribe()
    await flush()
    expect(changes.at(-1)).toEqual({ hubId: 'hub-1', add: [], remove: [chat.id] })
    expect(client.inspect()).toEqual({ subscriptions: 1, heartbeat: true })

    user.unsubscribe()
    await flush()
    expect(streams[0].closed).toBe(true)
    expect(client.inspect()).toEqual({ subscriptions: 0, heartbeat: false })
  })

  it('a tab the hub dropped for silence comes back on its next heartbeat', async () => {
    const { client, sent } = openTab()
    const chat = client.subscribe({ scope: 'session', sessionId: 'chat-1' }, { onEvent: () => {} })
    await flush()
    streams[0].connect('hub-1')
    await flush()
    expect(chat.state()).toBe('open')

    // The tab was frozen: no heartbeat reached the hub for more than five minutes.
    now = 5 * 60_000 + 1
    core.sweep()
    await flush()
    expect(streams[0].closed).toBe(true)

    await vi.advanceTimersByTimeAsync(15_000)
    await flush()
    expect(sent.filter((message) => message.type === 'state').length).toBeGreaterThanOrEqual(2)
    expect(streams).toHaveLength(2)
    streams[1].connect('hub-2')
    await flush()
    expect(changes.at(-1)).toEqual({
      hubId: 'hub-2',
      add: [{ id: chat.id, scope: 'session', sessionId: 'chat-1' }],
      remove: []
    })
  })

  it('says bye when the page goes away and re-sends everything when it is shown again', async () => {
    const { client } = openTab()
    const chat = client.subscribe({ scope: 'session', sessionId: 'chat-1' }, { onEvent: () => {} })
    await flush()
    streams[0].connect('hub-1')
    await flush()

    client.bye()
    await flush()
    expect(streams[0].closed).toBe(true)

    client.resend()
    await flush()
    streams[1].connect('hub-2')
    await flush()
    expect(changes.at(-1)?.add).toEqual([{ id: chat.id, scope: 'session', sessionId: 'chat-1' }])
  })

  it('moves every subscription to a new hub when the shared one fails to start', async () => {
    const dead: HubClientPort = { postMessage: () => {}, onMessage: () => {} }
    const client = createLiveHubClient({
      clientId: 'tab-x',
      port: dead,
      makeId: () => `sub-${nextId++}`,
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
    })
    const statuses: string[] = []
    const chat = client.subscribe(
      { scope: 'session', sessionId: 'chat-1' },
      { onEvent: () => {}, onStatus: (status) => statuses.push(status) }
    )

    let deliver: ((message: HubServerMessage) => void) | null = null
    const hubSide: HubPortLike = { postMessage: (message) => queueMicrotask(() => deliver?.(message)) }
    client.replacePort({
      postMessage: (message) => queueMicrotask(() => core.receive(hubSide, message)),
      onMessage: (handler) => {
        deliver = handler
      }
    })
    await flush()
    streams[0].connect('hub-1')
    await flush()
    expect(chat.state()).toBe('open')
    expect(statuses).toEqual(['open'])
  })

  it('a send’s turn is a subscription of its own, and its answer reaches only the tab that sent', async () => {
    // 2026-09-18: a browser send is answered once the server owns its turn, and the turn's
    // final answer comes over the hub instead of holding a connection for the whole reply.
    const sender = openTab()
    const other = openTab()
    const heard: string[] = []
    const otherHeard: string[] = []
    const turn = sender.client.subscribe({ scope: 'turn', turnId: 'turn_0123abcd' }, { onEvent: (data) => heard.push(data) })
    other.client.subscribe({ scope: 'session', sessionId: 'chat-1' }, { onEvent: (data) => otherHeard.push(data) })
    await flush()
    streams[0].connect('hub-1')
    await flush()
    expect(changes[0].add).toContainEqual({ id: turn.id, scope: 'turn', turnId: 'turn_0123abcd' })
    expect(turn.state()).toBe('open')

    const json = streams[0].frame(turn.id, { type: 'turn_over', turnId: 'turn_0123abcd', status: 200, contentType: 'application/json', body: '{}' })
    await flush()
    expect(heard).toEqual([json])
    expect(otherHeard).toEqual([])
  })

  it('never forwards a turn subscription with a malformed id', async () => {
    const { client } = openTab()
    client.subscribe({ scope: 'turn', turnId: 'bad id with spaces' }, { onEvent: () => {} })
    client.subscribe({ scope: 'session', sessionId: 'chat-1' }, { onEvent: () => {} })
    await flush()
    streams[0].connect('hub-1')
    await flush()
    expect(changes[0].add).toEqual([expect.objectContaining({ scope: 'session', sessionId: 'chat-1' })])
  })

  it('keeps a handler that throws from breaking the others', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client } = openTab()
    const heard: string[] = []
    const bad = client.subscribe({ scope: 'user' }, { onEvent: () => { throw new Error('boom') } })
    const good = client.subscribe({ scope: 'session', sessionId: 'chat-1' }, { onEvent: (data) => heard.push(data) })
    await flush()
    streams[0].connect('hub-1')
    await flush()
    streams[0].frame(bad.id, { type: 'x' })
    const json = streams[0].frame(good.id, { type: 'y' })
    await flush()
    expect(errors).toHaveBeenCalledWith('[LiveHub] A live-update handler threw:', expect.any(Error))
    expect(heard).toEqual([json])
    errors.mockRestore()
  })
})
