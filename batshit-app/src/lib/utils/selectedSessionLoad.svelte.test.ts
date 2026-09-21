import { flushSync } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'

import * as chatRunRegistry from '$lib/stores/chatRunRegistry.svelte'
import * as messageStore from '$lib/stores/messages.svelte'
import type { Message } from '$lib/stores/messages.svelte'
import {
  createChatLoadQueue,
  resolveSelectedSessionLoadStep,
  watchSelectedSessionLoad
} from './selectedSessionLoad.svelte'

function storedMessage(sessionId: string, id: string, role: Message['role'] = 'user'): Message {
  return {
    id,
    session_id: sessionId,
    user_id: 'user-1',
    role,
    content: `${id} content`,
    timestamp: '2026-09-18T00:00:00.000Z',
    created_at: '2026-09-18T00:00:00.000Z',
    status: 'complete'
  }
}

const destroyers: Array<() => void> = []
const touchedSessions = new Set<string>()

/**
 * The chat page's load, wired the way `+page.svelte` wires it and pointed at the REAL
 * message store and run registry: the defect lived in what the load READ from them.
 *
 * `load` does what the page's does before its fetch answers (shows the cached chat, mirrors
 * the chat's tool state from the run registry) and queues what the page does when the fetch
 * lands (the chat's cache is replaced). `settle` lets the fetches land, round after round,
 * the way the network would: before the fix every round loaded the chat again.
 */
function mountChatPage(initial: { selected?: string | null; creating?: string[] } = {}) {
  let selected = $state<string | null>(initial.selected ?? null)
  let creatingIds = $state<string[]>(initial.creating ?? [])
  const missing = new Set<string>()
  const steps: string[] = []
  let pendingFetches: Array<() => void> = []

  const destroy = $effect.root(() => {
    watchSelectedSessionLoad({
      selectedSessionId: () => selected,
      isCreating: (sessionId) => creatingIds.includes(sessionId),
      isMissing: (sessionId) => missing.has(sessionId),
      clearMissing: (sessionId) => {
        steps.push(`clear_missing:${sessionId}`)
        messageStore.clearMessages(sessionId)
        messageStore.setActiveSession(null)
      },
      holdForCreation: (sessionId) => {
        steps.push(`hold:${sessionId}`)
        messageStore.setActiveSession(sessionId)
      },
      load: (sessionId) => {
        touchedSessions.add(sessionId)
        steps.push(`load:${sessionId}`)
        messageStore.setActiveSession(sessionId)
        void chatRunRegistry.getRunState(sessionId).activeToolMessageIds
        pendingFetches.push(() => {
          messageStore.setMessagesForSession(sessionId, [storedMessage(sessionId, `${sessionId}-stored`)])
          if (selected === sessionId) messageStore.setActiveSession(sessionId)
        })
      }
    })
  })
  destroyers.push(destroy)
  flushSync()

  return {
    steps,
    select(sessionId: string | null) {
      selected = sessionId
      flushSync()
    },
    setCreating(sessionIds: string[]) {
      creatingIds = sessionIds
      flushSync()
    },
    markMissing(sessionId: string) {
      missing.add(sessionId)
    },
    settle(rounds = 5) {
      for (let round = 0; round < rounds; round += 1) {
        const landing = pendingFetches
        pendingFetches = []
        for (const land of landing) land()
        flushSync()
      }
    }
  }
}

afterEach(() => {
  while (destroyers.length > 0) destroyers.pop()?.()
  messageStore.setActiveSession(null)
  messageStore.clearMessages()
  for (const sessionId of touchedSessions) chatRunRegistry.resetRunState(sessionId)
  touchedSessions.clear()
})

describe('resolveSelectedSessionLoadStep', () => {
  it('answers each case the chat page has', () => {
    expect(resolveSelectedSessionLoadStep({ sessionId: null, missing: false, creating: false })).toBe('none')
    expect(resolveSelectedSessionLoadStep({ sessionId: 'chat', missing: false, creating: false })).toBe('load')
    expect(resolveSelectedSessionLoadStep({ sessionId: 'chat', missing: false, creating: true })).toBe(
      'hold_for_creation'
    )
    expect(resolveSelectedSessionLoadStep({ sessionId: 'chat', missing: true, creating: false })).toBe(
      'clear_missing'
    )
  })

  it('clears a missing chat even while it is marked as being created', () => {
    // A chat the server says is gone must not wait for a first reply that cannot come.
    expect(resolveSelectedSessionLoadStep({ sessionId: 'chat', missing: true, creating: true })).toBe(
      'clear_missing'
    )
  })
})

describe('watchSelectedSessionLoad', () => {
  it('loads the selected chat once, and the load landing does not load it again', () => {
    const page = mountChatPage({ selected: 'chat-a' })
    expect(page.steps).toEqual(['load:chat-a'])

    // The defect: the load's own `setMessagesForSession` re-ran the load, whose answer
    // re-ran it again, about ten times a second for as long as the chat was open.
    page.settle()

    expect(page.steps).toEqual(['load:chat-a'])
    expect(messageStore.getMessages().map((message) => message.id)).toEqual(['chat-a-stored'])
  })

  it('does not reload the chat on screen for a streamed reply, a tool call, or another chat', () => {
    const page = mountChatPage({ selected: 'chat-a' })
    page.settle()

    // A reply streams in: the page adds the bubble and writes every chunk into the cache.
    messageStore.addMessage({
      id: 'chat-a-reply',
      session_id: 'chat-a',
      role: 'assistant',
      content: '',
      status: 'in_progress'
    })
    flushSync()
    messageStore.updateMessage('chat-a-reply', { content: 'Hello' }, 'chat-a')
    flushSync()
    // The run registry moves with it: a run starts, a tool runs, the tool ends.
    chatRunRegistry.startRun({ sessionId: 'chat-a', transport: 'api', activeMessageId: 'chat-a-reply' })
    flushSync()
    chatRunRegistry.setToolProcessing('chat-a', 'chat-a-reply', 'bash')
    flushSync()
    chatRunRegistry.clearToolProcessing('chat-a', 'chat-a-reply')
    flushSync()
    messageStore.updateMessage('chat-a-reply', { content: 'Hello there', status: 'complete' }, 'chat-a')
    flushSync()
    // And another chat's history lands in the background.
    messageStore.setMessagesForSession('chat-b', [storedMessage('chat-b', 'chat-b-stored')])
    flushSync()
    page.settle()

    expect(page.steps).toEqual(['load:chat-a'])
    expect(messageStore.getMessages().map((message) => message.id)).toEqual([
      'chat-a-stored',
      'chat-a-reply'
    ])
  })

  it('loads each switch exactly once, including a switch back, and not a re-select', () => {
    const page = mountChatPage({ selected: 'chat-a' })
    page.settle()
    page.select('chat-b')
    page.settle()
    page.select('chat-a')
    page.settle()
    page.select('chat-a')
    page.settle()

    expect(page.steps).toEqual(['load:chat-a', 'load:chat-b', 'load:chat-a'])
  })

  it('holds a chat that is still being created, then loads it once when the hold lifts', () => {
    const page = mountChatPage({ selected: 'chat-new', creating: ['chat-new'] })
    expect(page.steps).toEqual(['hold:chat-new'])

    // The first send's own messages land in the cache while the hold is on.
    messageStore.addMessage({
      id: 'chat-new-user',
      session_id: 'chat-new',
      role: 'user',
      content: 'First message'
    })
    flushSync()
    messageStore.addMessage({
      id: 'chat-new-reply',
      session_id: 'chat-new',
      role: 'assistant',
      content: 'Streaming',
      status: 'in_progress'
    })
    flushSync()
    expect(page.steps).toEqual(['hold:chat-new'])

    // The first reply finalized: the page clears the hold.
    page.setCreating([])
    page.settle()

    expect(page.steps).toEqual(['hold:chat-new', 'load:chat-new'])
  })

  it('does not reload the chat on screen when ANOTHER chat starts or stops being created', () => {
    const page = mountChatPage({ selected: 'chat-a' })
    page.settle()

    page.setCreating(['chat-b'])
    page.setCreating(['chat-b', 'chat-c'])
    page.setCreating([])
    page.settle()

    expect(page.steps).toEqual(['load:chat-a'])
  })

  it('clears a chat found missing instead of loading it', () => {
    const page = mountChatPage({ selected: null })
    page.markMissing('chat-gone')

    page.select('chat-gone')
    page.settle()

    expect(page.steps).toEqual(['clear_missing:chat-gone'])
  })

  it('does nothing while no chat is selected, and nothing when the selection is cleared', () => {
    const page = mountChatPage({ selected: null })
    expect(page.steps).toEqual([])

    page.select('chat-a')
    page.settle()
    page.select(null)
    page.settle()

    expect(page.steps).toEqual(['load:chat-a'])
  })
})

describe('createChatLoadQueue', () => {
  function deferredLoads() {
    const started: string[] = []
    const finishers: Array<() => void> = []
    const queue = createChatLoadQueue(
      (sessionId) =>
        new Promise<void>((resolve) => {
          started.push(sessionId)
          finishers.push(resolve)
        })
    )
    return { started, finishers, queue }
  }

  it('runs one load at a time per chat and one catch-up for what was asked meanwhile', async () => {
    const { started, finishers, queue } = deferredLoads()

    void queue.request('chat-a')
    void queue.request('chat-a')
    void queue.request('chat-a')
    expect(started).toEqual(['chat-a'])
    expect(queue.isLoading('chat-a')).toBe(true)

    // The answer in flight was read before those requests, so exactly one more load runs.
    finishers.shift()?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(started).toEqual(['chat-a', 'chat-a'])

    finishers.shift()?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(started).toEqual(['chat-a', 'chat-a'])
    expect(queue.isLoading('chat-a')).toBe(false)
  })

  it('keeps chats apart', async () => {
    const { started, finishers, queue } = deferredLoads()

    void queue.request('chat-a')
    void queue.request('chat-b')
    expect(started).toEqual(['chat-a', 'chat-b'])

    finishers.shift()?.()
    finishers.shift()?.()
    await Promise.resolve()
    expect(started).toEqual(['chat-a', 'chat-b'])
  })

  it('drops the catch-up load for a chat that is gone', async () => {
    const { started, finishers, queue } = deferredLoads()

    void queue.request('chat-a')
    void queue.request('chat-a')
    queue.forget('chat-a')
    finishers.shift()?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(started).toEqual(['chat-a'])
  })

  it('still runs the catch-up load after a load that threw', async () => {
    const started: string[] = []
    const queue = createChatLoadQueue(async (sessionId) => {
      started.push(sessionId)
      if (started.length === 1) throw new Error('network')
    })

    const first = queue.request('chat-a').catch(() => 'handled')
    void queue.request('chat-a')
    await first
    await Promise.resolve()

    expect(started).toEqual(['chat-a', 'chat-a'])
  })
})
