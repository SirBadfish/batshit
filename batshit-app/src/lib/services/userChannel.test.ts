import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveSubscriptionHandlers, LiveTarget } from '$lib/services/liveHub/liveHubClient'

/**
 * The user channel over the live hub (2026-09-18): one subscription per tab, however many
 * components hold it, applied to the sidebar's stores and handed to every listener.
 */

const hub = vi.hoisted(() => ({ subscriptions: [] as any[] }))
const stores = vi.hoisted(() => ({
  upsertSession: vi.fn(),
  patchSessionFromServer: vi.fn(),
  deleteSession: vi.fn(),
  applyServerRunStatus: vi.fn(),
  resetRunState: vi.fn(),
  applyDmInboxChanged: vi.fn()
}))

vi.mock('$lib/services/liveHub/liveHubClient', () => ({
  subscribeLive: vi.fn((target: LiveTarget, handlers: LiveSubscriptionHandlers) => {
    const subscription = {
      target,
      handlers,
      current: 'pending',
      unsubscribed: false,
      state: () => subscription.current,
      unsubscribe: () => {
        subscription.unsubscribed = true
      }
    }
    hub.subscriptions.push(subscription)
    return subscription
  })
}))
vi.mock('$lib/stores/session.svelte', () => ({
  upsertSession: stores.upsertSession,
  patchSessionFromServer: stores.patchSessionFromServer,
  deleteSession: stores.deleteSession
}))
vi.mock('$lib/stores/chatRunRegistry.svelte', () => ({
  applyServerRunStatus: stores.applyServerRunStatus,
  resetRunState: stores.resetRunState
}))
vi.mock('$lib/stores/dmInbox.svelte', () => ({
  applyDmInboxChanged: stores.applyDmInboxChanged
}))

import {
  isUserChannelConnected,
  onUserChannelEvent,
  startUserChannel,
  stopUserChannel
} from './userChannel'

describe('user channel over the live hub', () => {
  beforeEach(() => {
    stopUserChannel()
    hub.subscriptions.length = 0
    vi.clearAllMocks()
  })

  it('holds one user subscription for every holder and lets go with the last one', () => {
    const releaseSidebar = startUserChannel('josh')
    const releaseDialog = startUserChannel('josh')
    expect(hub.subscriptions).toHaveLength(1)
    expect(hub.subscriptions[0].target).toEqual({ scope: 'user' })

    releaseSidebar()
    expect(hub.subscriptions[0].unsubscribed).toBe(false)
    releaseDialog()
    expect(hub.subscriptions[0].unsubscribed).toBe(true)
  })

  it('applies events to the stores and hands them to every listener', () => {
    startUserChannel('josh')
    const heard: unknown[] = []
    const stop = onUserChannelEvent((event) => heard.push(event))
    const { handlers } = hub.subscriptions[0]

    handlers.onEvent(JSON.stringify({ type: 'session_created', session: { id: 'chat-9' } }))
    handlers.onEvent(JSON.stringify({ type: 'session_run_status', sessionId: 'chat-9', status: 'running' }))
    handlers.onEvent(JSON.stringify({ type: 'session_messages_changed', sessionId: 'chat-9', reason: 'message_deleted' }))
    handlers.onEvent('not json')

    expect(stores.upsertSession).toHaveBeenCalledWith({ id: 'chat-9' })
    expect(stores.applyServerRunStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'chat-9', status: 'running' })
    )
    expect(heard.map((event: any) => event.type)).toEqual([
      'session_created',
      'session_run_status',
      'session_messages_changed'
    ])
    stop()
  })

  it('drops a chat deleted in another tab from the sidebar, with its run state (2026-09-18)', () => {
    // Nothing told a tab that a chat it listed was gone: it stayed in the sidebar (and on
    // screen) until that tab reloaded. The server now says so once the chat is swept.
    startUserChannel('josh')
    const heard: unknown[] = []
    const stop = onUserChannelEvent((event) => heard.push(event))
    const { handlers } = hub.subscriptions[0]

    handlers.onEvent(JSON.stringify({ type: 'session_deleted', sessionId: 'chat-9' }))
    handlers.onEvent(JSON.stringify({ type: 'session_deleted' }))

    expect(stores.deleteSession).toHaveBeenCalledTimes(1)
    expect(stores.deleteSession).toHaveBeenCalledWith('chat-9')
    expect(stores.resetRunState).toHaveBeenCalledWith('chat-9')
    // The chat page hears it too: it forgets the chat's messages and its live connection.
    expect(heard).toContainEqual({ type: 'session_deleted', sessionId: 'chat-9' })
    stop()
  })

  it('reports connected only while the hub says the subscription is open', () => {
    startUserChannel('josh')
    expect(isUserChannelConnected()).toBe(false)
    hub.subscriptions[0].current = 'open'
    expect(isUserChannelConnected()).toBe(true)
    hub.subscriptions[0].current = 'down'
    expect(isUserChannelConnected()).toBe(false)
  })

  it('starts over for a different user', () => {
    startUserChannel('josh')
    startUserChannel('someone-else')
    expect(hub.subscriptions).toHaveLength(2)
    expect(hub.subscriptions[0].unsubscribed).toBe(true)
    expect(hub.subscriptions[1].unsubscribed).toBe(false)
  })
})
