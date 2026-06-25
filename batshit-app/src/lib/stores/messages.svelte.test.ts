import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  addMessage,
  clearMessages,
  getMessage,
  getMessages,
  setActiveSession,
  setMessagesForSession,
  updateMessage,
  type Message
} from './messages.svelte'

function message(overrides: Partial<Message> & { id: string; session_id: string; content: string }): Message {
  return {
    id: overrides.id,
    session_id: overrides.session_id,
    user_id: overrides.user_id ?? 'user-1',
    role: overrides.role ?? 'assistant',
    content: overrides.content,
    timestamp: overrides.timestamp ?? '2026-06-06T00:00:00.000Z',
    created_at: overrides.created_at ?? '2026-06-06T00:00:00.000Z',
    status: overrides.status ?? 'complete',
    ...overrides
  }
}

describe('messages store session cache', () => {
  afterEach(() => {
    vi.useRealTimers()
    setActiveSession(null)
    clearMessages()
  })

  it('keeps visible messages derived from the active session', () => {
    setMessagesForSession('session-a', [message({ id: 'msg-a', session_id: 'session-a', content: 'A' })])
    setMessagesForSession('session-b', [message({ id: 'msg-b', session_id: 'session-b', content: 'B' })])

    setActiveSession('session-a')
    expect(getMessages().map((entry) => entry.id)).toEqual(['msg-a'])

    setActiveSession('session-b')
    expect(getMessages().map((entry) => entry.id)).toEqual(['msg-b'])
  })

  it('routes background message additions by message session_id', () => {
    setActiveSession('session-a')
    setMessagesForSession('session-a', [message({ id: 'msg-a', session_id: 'session-a', content: 'A' })])

    addMessage({
      id: 'msg-b',
      session_id: 'session-b',
      user_id: 'user-1',
      role: 'assistant',
      content: 'B',
      status: 'in_progress'
    })

    expect(getMessages().map((entry) => entry.id)).toEqual(['msg-a'])
    expect(getMessages('session-b').map((entry) => entry.id)).toEqual(['msg-b'])
  })

  it('updates a background message without overwriting the selected session', () => {
    setMessagesForSession('session-a', [message({ id: 'msg-a', session_id: 'session-a', content: 'A' })])
    setMessagesForSession('session-b', [message({ id: 'msg-b', session_id: 'session-b', content: 'B' })])
    setActiveSession('session-a')

    updateMessage('msg-b', { content: 'B updated', status: 'complete' })

    expect(getMessages()).toHaveLength(1)
    expect(getMessages()[0].content).toBe('A')
    expect(getMessage('msg-b')?.content).toBe('B updated')
  })

  it('preserves local in-progress messages during a session history refresh', () => {
    setActiveSession('session-a')
    setMessagesForSession('session-a', [
      message({
        id: 'msg-user',
        session_id: 'session-a',
        role: 'user',
        content: 'Hello',
        created_at: '2026-06-06T00:00:00.000Z'
      })
    ])
    addMessage({
      id: 'msg-assistant-live',
      session_id: 'session-a',
      user_id: 'user-1',
      role: 'assistant',
      content: 'Streaming so far',
      status: 'in_progress',
      created_at: '2026-06-06T00:00:01.000Z',
      timestamp: '2026-06-06T00:00:01.000Z'
    })

    setMessagesForSession(
      'session-a',
      [
        message({
          id: 'msg-user',
          session_id: 'session-a',
          role: 'user',
          content: 'Hello',
          created_at: '2026-06-06T00:00:00.000Z'
        })
      ],
      { preserveLocalInProgress: true }
    )

    expect(getMessages('session-a').map((entry) => entry.id)).toEqual([
      'msg-user',
      'msg-assistant-live'
    ])
    expect(getMessage('msg-assistant-live', 'session-a')?.content).toBe('Streaming so far')
  })

  it('briefly preserves a locally finalized assistant message during a stale history refresh', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-06T00:00:00.000Z'))

    setActiveSession('session-a')
    setMessagesForSession('session-a', [
      message({
        id: 'msg-user',
        session_id: 'session-a',
        role: 'user',
        content: 'Hello',
        created_at: '2026-06-06T00:00:00.000Z'
      })
    ])
    addMessage({
      id: 'msg-assistant-live',
      session_id: 'session-a',
      user_id: 'user-1',
      role: 'assistant',
      content: 'Final streamed content',
      status: 'in_progress',
      created_at: '2026-06-06T00:00:01.000Z',
      timestamp: '2026-06-06T00:00:01.000Z'
    })

    updateMessage('msg-assistant-live', { status: 'complete' })
    setMessagesForSession('session-a', [
      message({
        id: 'msg-user',
        session_id: 'session-a',
        role: 'user',
        content: 'Hello',
        created_at: '2026-06-06T00:00:00.000Z'
      })
    ])

    expect(getMessages('session-a').map((entry) => entry.id)).toEqual([
      'msg-user',
      'msg-assistant-live'
    ])
    expect(getMessage('msg-assistant-live', 'session-a')?.content).toBe('Final streamed content')
    expect(getMessage('msg-assistant-live', 'session-a')?.status).toBe('complete')
  })

  it('drops finalized-message refresh protection once the server history catches up', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-06T00:00:00.000Z'))

    setMessagesForSession('session-a', [
      message({
        id: 'msg-assistant-live',
        session_id: 'session-a',
        content: 'Final streamed content',
        status: 'in_progress'
      })
    ])

    updateMessage('msg-assistant-live', { status: 'complete' })
    setMessagesForSession('session-a', [
      message({
        id: 'msg-assistant-live',
        session_id: 'session-a',
        content: 'Server content',
        status: 'complete'
      })
    ])
    setMessagesForSession('session-a', [])

    expect(getMessage('msg-assistant-live', 'session-a')).toBeNull()
  })

  it('expires finalized-message refresh protection after the handoff grace window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-06T00:00:00.000Z'))

    setMessagesForSession('session-a', [
      message({
        id: 'msg-assistant-live',
        session_id: 'session-a',
        content: 'Final streamed content',
        status: 'in_progress'
      })
    ])

    updateMessage('msg-assistant-live', { status: 'complete' })
    vi.advanceTimersByTime(8_001)
    setMessagesForSession('session-a', [])

    expect(getMessage('msg-assistant-live', 'session-a')).toBeNull()
  })
})
