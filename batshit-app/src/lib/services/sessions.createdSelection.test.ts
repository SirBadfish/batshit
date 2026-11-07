import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseService } from './databaseRedis.client'
import { SessionService } from './sessions'
import * as sessionStore from '$lib/stores/session.svelte'

// Actual client service/store with a synthetic database response. No HTTP or Redis.
const created = { id: 'created_voice_chat', user_id: 'synthetic_voice_user', name: 'Created chat',
  created_at: '2026-10-27T12:00:00.000Z', last_modified_at: '2026-10-27T12:00:00.000Z', archived: false, locked: false }
beforeEach(() => {
  sessionStore.setSessions([])
  sessionStore.setCurrentSessionId(null)
  vi.spyOn(DatabaseService.prototype, 'createSession').mockResolvedValue(created as any)
})
afterEach(() => {
  sessionStore.setCurrentSessionId(null)
  sessionStore.setSessions([])
  vi.restoreAllMocks()
})

describe('owned first-send session selection', () => {
  it('hands off the created identity before publishing its row or selection', async () => {
    const beforeSelect = vi.fn(row => {
      expect(row).toEqual(created)
      expect(sessionStore.getCurrentSessionId()).toBeNull()
      expect(sessionStore.getSessions()).toEqual([])
      return true
    })
    expect(await new SessionService().createSession(created.user_id, undefined, 'agent-a', { beforeSelect })).toEqual(created)
    expect(beforeSelect).toHaveBeenCalledOnce()
    expect(sessionStore.getCurrentSessionId()).toBe(created.id)
    expect(sessionStore.getSessions().some(row => row.id === created.id)).toBe(true)
  })

  it('preserves a user selection made while creation waited when the exact send refuses handoff', async () => {
    let finish!: (row: any) => void
    vi.mocked(DatabaseService.prototype.createSession).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const pending = new SessionService().createSession(created.user_id, undefined, 'agent-a', {
      beforeSelect: () => sessionStore.getCurrentSessionId() === null
    })
    sessionStore.setCurrentSessionId('user_selected_chat')
    finish(created)
    expect(await pending).toEqual(created) // A created record is retained, never rolled back or called a send ACK.
    expect(sessionStore.getCurrentSessionId()).toBe('user_selected_chat')
    expect(sessionStore.getSessions().some(row => row.id === created.id)).toBe(true)
  })

  it('keeps the existing selection behavior when no hook is supplied', async () => {
    await new SessionService().createSession(created.user_id)
    expect(sessionStore.getCurrentSessionId()).toBe(created.id)
  })
})
