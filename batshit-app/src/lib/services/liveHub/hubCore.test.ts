import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HubCore, type HubStream, type HubStreamHandlers, type HubPortLike } from './hubCore'
import {
  formatHubFrameData,
  type HubClientMessage,
  type HubServerMessage,
  type HubSubscriptionChange,
  type HubSubscriptionRequest
} from './protocol'

/**
 * The live hub's rules (2026-09-18): ONE live connection for the whole browser, however many
 * tabs and chats; each event reaches only the tab that asked for it; the server hears one
 * subscription change at a time; a dropped connection re-adds everything.
 */

const CONNECTING = 0
const OPEN = 1
const CLOSED = 2

class FakeStream implements HubStream {
  state = CONNECTING
  closed = false

  constructor(private readonly handlers: HubStreamHandlers) {}

  readyState() {
    return this.state
  }

  close() {
    this.closed = true
    this.state = CLOSED
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

  drop(readyState: number) {
    this.state = readyState
    this.handlers.onError()
  }
}

type Deferred = {
  change: HubSubscriptionChange
  resolve: (value: { status: number; body: unknown }) => void
  reject: (error: unknown) => void
}

class Port implements HubPortLike {
  messages: HubServerMessage[] = []
  postMessage(message: HubServerMessage) {
    this.messages.push(message)
  }
  statuses() {
    return this.messages.filter((message) => message.type === 'status')
  }
  events() {
    return this.messages.filter((message) => message.type === 'event')
  }
}

function sessionSub(id: string, sessionId: string): HubSubscriptionRequest {
  return { id, scope: 'session', sessionId }
}

function userSub(id: string): HubSubscriptionRequest {
  return { id, scope: 'user' }
}

function state(clientId: string, subscriptions: HubSubscriptionRequest[]): HubClientMessage {
  return { type: 'state', clientId, subscriptions }
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

describe('HubCore', () => {
  let streams: FakeStream[]
  let patches: Deferred[]
  let core: HubCore
  let now: number

  beforeEach(() => {
    vi.useFakeTimers()
    streams = []
    patches = []
    now = 1_000_000
    core = new HubCore({
      openStream: (handlers) => {
        const stream = new FakeStream(handlers)
        streams.push(stream)
        return stream
      },
      patch: (change) =>
        new Promise((resolve, reject) => {
          patches.push({ change, resolve, reject })
        }),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      now: () => now,
      warn: () => {}
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Answer the oldest pending change the way the server does when it adds and removes all. */
  async function acceptOldest() {
    const pending = patches.shift()
    if (!pending) throw new Error('no pending change')
    pending.resolve({
      status: 200,
      body: {
        added: (pending.change.add ?? []).map((request) => request.id),
        removed: pending.change.remove ?? [],
        refused: []
      }
    })
    await settle()
    return pending.change
  }

  it('holds ONE live connection for five tabs on five chats and adds all ten subscriptions in one change', async () => {
    const ports = Array.from({ length: 5 }, () => new Port())
    ports.forEach((port, index) => {
      core.receive(port, state(`tab-${index}`, [userSub(`u${index}`), sessionSub(`s${index}`, `chat-${index}`)]))
    })
    await settle()

    expect(streams).toHaveLength(1)
    expect(patches).toHaveLength(0)

    streams[0].connect('hub-1')
    await settle()

    expect(patches).toHaveLength(1)
    const change = await acceptOldest()
    expect(change.hubId).toBe('hub-1')
    expect(change.add?.map((request) => request.id).sort()).toEqual(
      ['s0', 's1', 's2', 's3', 's4', 'u0', 'u1', 'u2', 'u3', 'u4']
    )
    expect(streams).toHaveLength(1)
    ports.forEach((port, index) => {
      expect(port.statuses().map((message) => [message.id, message.status]).sort()).toEqual([
        [`s${index}`, 'open'],
        [`u${index}`, 'open']
      ])
    })
  })

  it('hands each event, byte for byte, only to the tab that asked for it', async () => {
    const tabA = new Port()
    const tabB = new Port()
    core.receive(tabA, state('tab-a', [sessionSub('a-chat', 'chat-1')]))
    core.receive(tabB, state('tab-b', [sessionSub('b-chat', 'chat-1')]))
    await settle()
    streams[0].connect('hub-1')
    await settle()
    await acceptOldest()

    const json = streams[0].frame('b-chat', { type: 'chunk', messageId: 'm1', content: 'héllo "quoted"\n' })

    expect(tabB.events()).toEqual([{ type: 'event', id: 'b-chat', data: json }])
    expect(tabA.events()).toEqual([])
  })

  it('delivers events that arrive before the change answer (the replay a new listener gets)', async () => {
    const tab = new Port()
    core.receive(tab, state('tab-a', [sessionSub('a-chat', 'chat-1')]))
    await settle()
    streams[0].connect('hub-1')
    await settle()

    const json = streams[0].frame('a-chat', { type: 'connected', sessionId: 'chat-1' })
    expect(tab.events()).toEqual([{ type: 'event', id: 'a-chat', data: json }])

    await acceptOldest()
    expect(tab.statuses()).toEqual([{ type: 'status', id: 'a-chat', status: 'open' }])
  })

  it('sends one change at a time and folds everything asked meanwhile into the next one', async () => {
    const tab = new Port()
    core.receive(tab, state('tab-a', [sessionSub('first', 'chat-1')]))
    await settle()
    streams[0].connect('hub-1')
    await settle()
    expect(patches).toHaveLength(1)

    core.receive(tab, state('tab-a', [sessionSub('first', 'chat-1'), sessionSub('second', 'chat-2')]))
    core.receive(
      tab,
      state('tab-a', [sessionSub('first', 'chat-1'), sessionSub('second', 'chat-2'), userSub('third')])
    )
    await settle()
    expect(patches).toHaveLength(1)

    await acceptOldest()
    expect(patches).toHaveLength(1)
    expect(patches[0].change.add?.map((request) => request.id)).toEqual(['second', 'third'])
    await acceptOldest()
    expect(patches).toHaveLength(0)
  })

  it('removes a subscription the tab no longer lists', async () => {
    const tab = new Port()
    core.receive(tab, state('tab-a', [userSub('u'), sessionSub('s', 'chat-1')]))
    await settle()
    streams[0].connect('hub-1')
    await settle()
    await acceptOldest()

    core.receive(tab, state('tab-a', [userSub('u')]))
    await settle()

    expect(patches).toHaveLength(1)
    expect(patches[0].change).toEqual({ hubId: 'hub-1', add: [], remove: ['s'] })
    await acceptOldest()
    // Once the server has let go of it, it is never asked to again.
    expect(patches).toHaveLength(0)
  })

  it('closes the connection when the last subscription goes, and opens a new one for the next', async () => {
    const tab = new Port()
    core.receive(tab, state('tab-a', [userSub('u')]))
    await settle()
    streams[0].connect('hub-1')
    await settle()
    await acceptOldest()

    core.receive(tab, state('tab-a', []))
    await settle()
    expect(streams[0].closed).toBe(true)
    // The server detaches everything when the stream closes; no change request is needed.
    expect(patches).toHaveLength(0)

    core.receive(tab, state('tab-a', [userSub('u2')]))
    await settle()
    expect(streams).toHaveLength(2)
    expect(streams[1].closed).toBe(false)
  })

  it('tells each tab its subscription is down when the connection drops, and re-adds everything on the next hub', async () => {
    const tab = new Port()
    core.receive(tab, state('tab-a', [userSub('u'), sessionSub('s', 'chat-1')]))
    await settle()
    streams[0].connect('hub-1')
    await settle()
    await acceptOldest()
    tab.messages = []

    // The browser is already retrying by itself (CONNECTING).
    streams[0].drop(CONNECTING)
    await settle()
    expect(tab.statuses().map((message) => [message.id, message.status]).sort()).toEqual([
      ['s', 'down'],
      ['u', 'down']
    ])
    expect(streams).toHaveLength(1)
    expect(patches).toHaveLength(0)

    tab.messages = []
    streams[0].connect('hub-2')
    await settle()
    const change = await acceptOldest()
    expect(change.hubId).toBe('hub-2')
    expect(change.add?.map((request) => request.id).sort()).toEqual(['s', 'u'])
    expect(tab.statuses().map((message) => [message.id, message.status]).sort()).toEqual([
      ['s', 'open'],
      ['u', 'open']
    ])
  })

  it('opens a new stream with a growing delay when the browser gives up on one (CLOSED)', async () => {
    const tab = new Port()
    core.receive(tab, state('tab-a', [userSub('u')]))
    await settle()
    streams[0].drop(CLOSED)
    await settle()
    expect(streams).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(999)
    expect(streams).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(streams).toHaveLength(2)

    streams[1].drop(CLOSED)
    await vi.advanceTimersByTimeAsync(1999)
    expect(streams).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(streams).toHaveLength(3)

    // A hub that connects resets the delay.
    streams[2].connect('hub-3')
    await settle()
    await acceptOldest()
    streams[2].drop(CLOSED)
    await vi.advanceTimersByTimeAsync(1000)
    expect(streams).toHaveLength(4)
  })

  it('reports a refused subscription to its tab and never asks for it again', async () => {
    const tab = new Port()
    core.receive(tab, state('tab-a', [sessionSub('gone', 'deleted-chat'), userSub('u')]))
    await settle()
    streams[0].connect('hub-1')
    await settle()
    const pending = patches.shift()!
    pending.resolve({
      status: 200,
      body: { added: ['u'], removed: [], refused: [{ id: 'gone', status: 404, code: 'session_not_found' }] }
    })
    await settle()

    expect(tab.statuses()).toEqual(
      expect.arrayContaining([
        { type: 'status', id: 'gone', status: 'refused', code: 'session_not_found' },
        { type: 'status', id: 'u', status: 'open' }
      ])
    )

    core.receive(tab, state('tab-a', [sessionSub('gone', 'deleted-chat'), userSub('u'), userSub('u2')]))
    await settle()
    expect(patches).toHaveLength(1)
    expect(patches[0].change.add?.map((request) => request.id)).toEqual(['u2'])
  })

  it('counts a subscription the answer does not mention as refused, so it cannot loop', async () => {
    const tab = new Port()
    core.receive(tab, state('tab-a', [userSub('u')]))
    await settle()
    streams[0].connect('hub-1')
    await settle()
    patches.shift()!.resolve({ status: 200, body: { added: [], removed: [], refused: [] } })
    await settle()

    expect(tab.statuses()).toEqual([{ type: 'status', id: 'u', status: 'refused', code: 'unanswered' }])
    expect(patches).toHaveLength(0)
  })

  it('ignores the answer to a change made for a hub that has since been replaced', async () => {
    const tab = new Port()
    core.receive(tab, state('tab-a', [userSub('u')]))
    await settle()
    streams[0].connect('hub-1')
    await settle()
    const stale = patches.shift()!

    streams[0].drop(CONNECTING)
    streams[0].connect('hub-2')
    await settle()
    expect(patches).toHaveLength(0)

    stale.resolve({ status: 200, body: { added: ['u'], removed: [], refused: [] } })
    await settle()
    expect(tab.statuses().filter((message) => message.status === 'open')).toEqual([])

    expect(patches).toHaveLength(1)
    expect(patches[0].change.hubId).toBe('hub-2')
    await acceptOldest()
    expect(tab.statuses().filter((message) => message.status === 'open')).toHaveLength(1)
  })

  it('reconnects when the server no longer knows the hub', async () => {
    const tab = new Port()
    core.receive(tab, state('tab-a', [userSub('u')]))
    await settle()
    streams[0].connect('hub-1')
    await settle()
    patches.shift()!.resolve({ status: 404, body: { code: 'hub_not_found' } })
    await settle()

    expect(streams[0].closed).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(streams).toHaveLength(2)
  })

  it('retries a change that failed on the network', async () => {
    const tab = new Port()
    core.receive(tab, state('tab-a', [userSub('u')]))
    await settle()
    streams[0].connect('hub-1')
    await settle()
    patches.shift()!.reject(new TypeError('Failed to fetch'))
    await settle()
    expect(patches).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1000)
    expect(patches).toHaveLength(1)
    expect(patches[0].change.add?.map((request) => request.id)).toEqual(['u'])
  })

  it('drops a tab that says bye, and a tab that stays silent past the limit until it speaks again', async () => {
    const tabA = new Port()
    const tabB = new Port()
    core.receive(tabA, state('tab-a', [sessionSub('a', 'chat-1')]))
    core.receive(tabB, state('tab-b', [sessionSub('b', 'chat-2')]))
    await settle()
    streams[0].connect('hub-1')
    await settle()
    await acceptOldest()

    core.receive(tabA, { type: 'bye', clientId: 'tab-a' })
    await settle()
    expect(patches[0].change.remove).toEqual(['a'])
    await acceptOldest()

    now += 5 * 60_000 - 1
    core.sweep()
    await settle()
    expect(patches).toHaveLength(0)

    now += 1
    core.sweep()
    await settle()
    // The last subscription left with the silent tab, so the connection closed.
    expect(streams[0].closed).toBe(true)

    core.receive(tabB, state('tab-b', [sessionSub('b', 'chat-2')]))
    await settle()
    expect(streams).toHaveLength(2)
    streams[1].connect('hub-2')
    await settle()
    expect(patches[0].change).toEqual({ hubId: 'hub-2', add: [sessionSub('b', 'chat-2')], remove: [] })
  })

  it('ignores a malformed subscription instead of sending it to the server', async () => {
    const tab = new Port()
    core.receive(tab, state('tab-a', [
      { id: 'has space', scope: 'user' } as HubSubscriptionRequest,
      { id: 'no-chat', scope: 'session', sessionId: '' } as HubSubscriptionRequest,
      userSub('fine')
    ]))
    await settle()
    streams[0].connect('hub-1')
    await settle()
    expect(patches[0].change.add).toEqual([userSub('fine')])
  })
})
