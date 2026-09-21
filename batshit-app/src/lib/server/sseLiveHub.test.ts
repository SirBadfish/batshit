import { describe, expect, it, vi } from 'vitest'
import {
  createLiveHubRegistry,
  parseHubSubscriptionChange,
  wrapSseChunkForSubscription,
  type HubListener,
  type LiveHubAttachments
} from './sseLiveHub'
import { HUB_MAX_SUBSCRIPTIONS_PER_HUB, parseHubFrameData } from '$lib/services/liveHub/protocol'

/**
 * The server half of the live hub (2026-09-18). One HTTP stream per browser carries many
 * subscriptions, and each subscription is its OWN listener in `/api/sse`'s maps, so the route's
 * rules (drop an event nobody hears, replay a live turn to a new listener, tear a chat down when
 * its last listener goes) see exactly what they saw when every tab had its own stream.
 */

function readFrames(written: string[]) {
  return written
    .join('')
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n')
      return data
    })
}

function setup(
  options: { owned?: (sessionId: string) => boolean; ownsTurn?: (turnId: string, userId: string) => boolean } = {}
) {
  const sessionListeners = new Map<string, Set<HubListener>>()
  const userListeners = new Map<string, Set<HubListener>>()
  const turnListeners = new Map<string, Set<HubListener>>()
  const calls: string[] = []
  const attachments: LiveHubAttachments = {
    ownsSession: vi.fn(async (sessionId: string) =>
      (options.owned ?? (() => true))(sessionId)
        ? { ok: true as const }
        : { ok: false as const, status: 404, code: 'session_not_found' }
    ),
    attachSession: vi.fn(async (sessionId: string, listener: HubListener) => {
      calls.push(`attach ${sessionId} ${listener._id}`)
      const set = sessionListeners.get(sessionId) ?? new Set()
      set.add(listener)
      sessionListeners.set(sessionId, set)
      listener.enqueue(`data: ${JSON.stringify({ type: 'connected', sessionId })}\n\n`)
    }),
    detachSession: vi.fn(async (sessionId: string, listener: HubListener) => {
      calls.push(`detach ${sessionId} ${listener._id}`)
      listener._closed = true
      sessionListeners.get(sessionId)?.delete(listener)
    }),
    attachUser: vi.fn((userId: string, listener: HubListener) => {
      calls.push(`attach user ${userId}`)
      const set = userListeners.get(userId) ?? new Set()
      set.add(listener)
      userListeners.set(userId, set)
    }),
    detachUser: vi.fn((userId: string, listener: HubListener) => {
      calls.push(`detach user ${userId}`)
      listener._closed = true
      userListeners.get(userId)?.delete(listener)
    }),
    ownsTurn: vi.fn((turnId: string, userId: string) =>
      (options.ownsTurn ?? (() => true))(turnId, userId)
        ? { ok: true as const }
        : { ok: false as const, status: 404, code: 'turn_not_found' }
    ),
    attachTurn: vi.fn((turnId: string, listener: HubListener, userId: string) => {
      calls.push(`attach turn ${turnId} for ${userId}`)
      const set = turnListeners.get(turnId) ?? new Set()
      set.add(listener)
      turnListeners.set(turnId, set)
    }),
    detachTurn: vi.fn((turnId: string, listener: HubListener) => {
      calls.push(`detach turn ${turnId}`)
      listener._closed = true
      turnListeners.get(turnId)?.delete(listener)
    })
  }
  const registry = createLiveHubRegistry(attachments, { heartbeatMs: 0 })
  const written: string[] = []
  const sink = { write: vi.fn((text: string) => void written.push(text)), close: vi.fn() }
  return { registry, attachments, sessionListeners, userListeners, turnListeners, written, sink, calls }
}

describe('wrapSseChunkForSubscription', () => {
  it('wraps each data frame with its subscription id, keeping the event text exactly', () => {
    const event = JSON.stringify({ type: 'chunk', content: 'a "b"\nc', messageId: 'm1' })
    const wrapped = wrapSseChunkForSubscription(`data: ${event}\n\n`, 'sub-1')
    expect(wrapped).toBe(`data: {"sub":"sub-1","event":${event}}\n\n`)
    expect(parseHubFrameData(wrapped.slice(6, -2))).toEqual({ subscriptionId: 'sub-1', eventJson: event })
  })

  it('drops comments (the hub stream has its own heartbeat) and keeps several frames in order', () => {
    const one = JSON.stringify({ n: 1 })
    const two = JSON.stringify({ n: 2 })
    expect(wrapSseChunkForSubscription(':heartbeat\n\n', 'sub-1')).toBe('')
    expect(wrapSseChunkForSubscription(`data: ${one}\n\n:ping\n\ndata: ${two}\n\n`, 's')).toBe(
      `data: {"sub":"s","event":${one}}\n\ndata: {"sub":"s","event":${two}}\n\n`
    )
  })

  it('keeps a multi-line data frame valid by writing one data line per line', () => {
    const wrapped = wrapSseChunkForSubscription('data: line one\ndata: line two\n\n', 's')
    expect(wrapped).toBe('data: {"sub":"s","event":line one\ndata: line two}\n\n')
    expect(readFrames([wrapped])).toEqual(['{"sub":"s","event":line one\nline two}'])
  })
})

describe('parseHubSubscriptionChange', () => {
  it('accepts a well-formed change', () => {
    expect(
      parseHubSubscriptionChange({
        hubId: 'hub-1',
        add: [{ id: 'a', scope: 'user' }, { id: 'b', scope: 'session', sessionId: 'chat-1' }],
        remove: ['c']
      })
    ).toEqual({
      ok: true,
      value: {
        hubId: 'hub-1',
        add: [{ id: 'a', scope: 'user' }, { id: 'b', scope: 'session', sessionId: 'chat-1' }],
        remove: ['c']
      }
    })
  })

  it('accepts a send’s turn as a subscription (2026-09-18)', () => {
    expect(
      parseHubSubscriptionChange({ hubId: 'hub-1', add: [{ id: 't', scope: 'turn', turnId: 'turn_0a1b' }] })
    ).toEqual({ ok: true, value: { hubId: 'hub-1', add: [{ id: 't', scope: 'turn', turnId: 'turn_0a1b' }], remove: [] } })
  })

  it.each([
    ['no hub id', { add: [] }],
    ['an id with a space', { hubId: 'h', add: [{ id: 'a b', scope: 'user' }] }],
    ['an unknown scope', { hubId: 'h', add: [{ id: 'a', scope: 'everything' }] }],
    ['a chat subscription with no chat', { hubId: 'h', add: [{ id: 'a', scope: 'session' }] }],
    ['a turn subscription with no turn', { hubId: 'h', add: [{ id: 'a', scope: 'turn' }] }],
    ['a turn id with a space', { hubId: 'h', add: [{ id: 'a', scope: 'turn', turnId: 'turn 1' }] }],
    ['a removal that is not an id', { hubId: 'h', remove: [42] }],
    ['too many changes', { hubId: 'h', remove: Array.from({ length: 65 }, (_, i) => `r${i}`) }]
  ])('refuses %s', (_label, body) => {
    expect(parseHubSubscriptionChange(body).ok).toBe(false)
  })
})

describe('createLiveHubRegistry', () => {
  it('announces the hub, and writes each subscription\'s events wrapped with its own id', async () => {
    const { registry, sink, written } = setup()
    const hub = registry.open('user-1', sink)
    expect(readFrames(written)).toEqual([JSON.stringify({ type: 'hub_connected', hubId: hub.id })])

    const result = await registry.change('user-1', {
      hubId: hub.id,
      add: [
        { id: 'tab1-chat', scope: 'session', sessionId: 'chat-1' },
        { id: 'tab2-chat', scope: 'session', sessionId: 'chat-1' }
      ]
    })
    expect(result).toEqual({ status: 200, body: { added: ['tab1-chat', 'tab2-chat'], removed: [], refused: [] } })

    const frames = readFrames(written).slice(1).map((data) => parseHubFrameData(data))
    const connected = JSON.stringify({ type: 'connected', sessionId: 'chat-1' })
    expect(frames).toEqual([
      { subscriptionId: 'tab1-chat', eventJson: connected },
      { subscriptionId: 'tab2-chat', eventJson: connected }
    ])
  })

  it('makes every subscription its own listener, so two tabs on one chat are two listeners', async () => {
    const { registry, sink, sessionListeners, userListeners } = setup()
    const hub = registry.open('user-1', sink)
    await registry.change('user-1', {
      hubId: hub.id,
      add: [
        { id: 'a', scope: 'session', sessionId: 'chat-1' },
        { id: 'b', scope: 'session', sessionId: 'chat-1' },
        { id: 'u', scope: 'user' }
      ]
    })
    expect(sessionListeners.get('chat-1')?.size).toBe(2)
    expect(userListeners.get('user-1')?.size).toBe(1)
  })

  it('refuses a chat this user does not own, without attaching anything', async () => {
    const { registry, sink, attachments } = setup({ owned: (sessionId) => sessionId !== 'theirs' })
    const hub = registry.open('user-1', sink)
    const result = await registry.change('user-1', {
      hubId: hub.id,
      add: [{ id: 'x', scope: 'session', sessionId: 'theirs' }]
    })
    expect(result).toEqual({
      status: 200,
      body: { added: [], removed: [], refused: [{ id: 'x', status: 404, code: 'session_not_found' }] }
    })
    expect(attachments.attachSession).not.toHaveBeenCalled()
  })

  it('answers "not found" for another user\'s hub, or one that is gone', async () => {
    const { registry, sink, attachments } = setup()
    const hub = registry.open('user-1', sink)
    const theirs = await registry.change('user-2', { hubId: hub.id, add: [{ id: 'u', scope: 'user' }] })
    expect(theirs.status).toBe(404)
    await registry.close(hub.id)
    const gone = await registry.change('user-1', { hubId: hub.id, add: [{ id: 'u', scope: 'user' }] })
    expect(gone.status).toBe(404)
    expect(attachments.attachUser).not.toHaveBeenCalled()
  })

  it('detaches a removed subscription and stops writing its events', async () => {
    const { registry, sink, written, sessionListeners, attachments } = setup()
    const hub = registry.open('user-1', sink)
    await registry.change('user-1', { hubId: hub.id, add: [{ id: 'a', scope: 'session', sessionId: 'chat-1' }] })
    const listener = [...sessionListeners.get('chat-1')!][0]

    const result = await registry.change('user-1', { hubId: hub.id, remove: ['a', 'never-added'] })
    expect(result).toEqual({ status: 200, body: { added: [], removed: ['a', 'never-added'], refused: [] } })
    expect(attachments.detachSession).toHaveBeenCalledWith('chat-1', listener)

    const before = written.length
    listener.enqueue(`data: ${JSON.stringify({ type: 'chunk' })}\n\n`)
    expect(written.length).toBe(before)
  })

  it('treats adding the same subscription twice as one listener', async () => {
    const { registry, sink, sessionListeners } = setup()
    const hub = registry.open('user-1', sink)
    const add = [{ id: 'a', scope: 'session' as const, sessionId: 'chat-1' }]
    await registry.change('user-1', { hubId: hub.id, add })
    const again = await registry.change('user-1', { hubId: hub.id, add })
    expect(again.body).toEqual({ added: ['a'], removed: [], refused: [] })
    expect(sessionListeners.get('chat-1')?.size).toBe(1)
  })

  it('detaches every subscription when the stream closes, including one still attaching', async () => {
    const { registry, sink, attachments, calls } = setup()
    let finishAttach!: () => void
    vi.mocked(attachments.attachSession).mockImplementationOnce(async (sessionId, listener) => {
      calls.push(`attach ${sessionId} ${listener._id}`)
      await new Promise<void>((resolve) => {
        finishAttach = resolve
      })
      // The route files a chat's listener at the END of its attach (after its own awaits).
      calls.push(`attached ${sessionId}`)
    })
    const hub = registry.open('user-1', sink)
    await registry.change('user-1', { hubId: hub.id, add: [{ id: 'u', scope: 'user' }] })
    const slow = registry.change('user-1', {
      hubId: hub.id,
      add: [{ id: 'late', scope: 'session', sessionId: 'chat-9' }]
    })
    await vi.waitFor(() => expect(attachments.attachSession).toHaveBeenCalledOnce())

    const closing = registry.close(hub.id)
    finishAttach()
    await slow
    await closing

    // Detaching before the attach finished would leave the late listener filed forever.
    expect(calls.slice(calls.indexOf('attached chat-9'))).toEqual([
      'attached chat-9',
      'detach user user-1',
      expect.stringMatching(/^detach chat-9 /)
    ])
    expect(registry.inspect().hubs).toBe(0)
  })

  it('refuses a subscription whose attach throws, and takes back what it attached', async () => {
    const { registry, sink, attachments } = setup()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(attachments.attachSession).mockRejectedValueOnce(new Error('redis went away'))
    const hub = registry.open('user-1', sink)
    const result = await registry.change('user-1', {
      hubId: hub.id,
      add: [{ id: 'a', scope: 'session', sessionId: 'chat-1' }]
    })
    expect(result.body).toEqual({
      added: [],
      removed: [],
      refused: [{ id: 'a', status: 500, code: 'attach_failed' }]
    })
    expect(attachments.detachSession).toHaveBeenCalledOnce()
    expect(registry.inspect().subscriptions).toBe(0)
    errors.mockRestore()
  })

  it('stops a hub at its subscription limit', async () => {
    const { registry, sink } = setup()
    const hub = registry.open('user-1', sink)
    for (let batch = 0; batch < HUB_MAX_SUBSCRIPTIONS_PER_HUB / 64; batch += 1) {
      await registry.change('user-1', {
        hubId: hub.id,
        add: Array.from({ length: 64 }, (_, i) => ({ id: `u${batch}-${i}`, scope: 'user' as const }))
      })
    }
    const over = await registry.change('user-1', { hubId: hub.id, add: [{ id: 'one-more', scope: 'user' }] })
    expect(over.body).toEqual({
      added: [],
      removed: [],
      refused: [{ id: 'one-more', status: 429, code: 'hub_full' }]
    })
  })

  it('stops writing once the stream refuses a write, without throwing into the caller', async () => {
    const { registry, attachments } = setup()
    let open = true
    const writes: string[] = []
    const sink = {
      write: vi.fn((text: string) => {
        if (!open) throw new TypeError('Invalid state: Controller is already closed')
        writes.push(text)
      }),
      close: vi.fn()
    }
    const hub = registry.open('user-1', sink)
    await registry.change('user-1', { hubId: hub.id, add: [{ id: 'u', scope: 'user' }] })
    const listener = vi.mocked(attachments.attachUser).mock.calls[0][1]

    open = false
    expect(() => listener.enqueue(`data: ${JSON.stringify({ type: 'x' })}\n\n`)).not.toThrow()
    open = true
    listener.enqueue(`data: ${JSON.stringify({ type: 'y' })}\n\n`)
    expect(writes.some((text) => text.includes('"type":"y"'))).toBe(false)
  })

  it('attaches a send’s turn for the hub’s own user, and lets it go on removal and on close', async () => {
    // 2026-09-18: the tab that sent a message hears its turn's final answer here, instead of
    // holding one of the browser's connections open for the whole reply.
    const { registry, sink, attachments, turnListeners, calls } = setup()
    const hub = registry.open('user-1', sink)
    const added = await registry.change('user-1', {
      hubId: hub.id,
      add: [
        { id: 'turn-a', scope: 'turn', turnId: 'turn_a' },
        { id: 'turn-b', scope: 'turn', turnId: 'turn_b' }
      ]
    })
    expect(added.body).toEqual({ added: ['turn-a', 'turn-b'], removed: [], refused: [] })
    expect(attachments.ownsTurn).toHaveBeenCalledWith('turn_a', 'user-1')
    expect(calls).toContain('attach turn turn_a for user-1')
    expect(turnListeners.get('turn_a')?.size).toBe(1)

    await registry.change('user-1', { hubId: hub.id, remove: ['turn-a'] })
    expect(calls).toContain('detach turn turn_a')
    expect(turnListeners.get('turn_a')?.size).toBe(0)

    await registry.close(hub.id)
    expect(calls).toContain('detach turn turn_b')
  })

  it('refuses a turn this user does not own, without attaching it', async () => {
    const { registry, sink, attachments } = setup({ ownsTurn: (turnId) => turnId !== 'turn_theirs' })
    const hub = registry.open('user-1', sink)
    const result = await registry.change('user-1', {
      hubId: hub.id,
      add: [{ id: 't', scope: 'turn', turnId: 'turn_theirs' }]
    })
    expect(result.body).toEqual({ added: [], removed: [], refused: [{ id: 't', status: 404, code: 'turn_not_found' }] })
    expect(attachments.attachTurn).not.toHaveBeenCalled()
  })

  it('closes every stream at shutdown', () => {
    const { registry, sink } = setup()
    registry.open('user-1', sink)
    registry.closeAllStreams()
    expect(sink.close).toHaveBeenCalledOnce()
    expect(registry.inspect().hubs).toBe(0)
  })
})
