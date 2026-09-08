import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  deleteSession,
  getCurrentSessionId,
  getSessions,
  patchSessionFromServer,
  setCurrentSessionId,
  setSessions,
  upsertSession,
  type ChatSession
} from './session.svelte'

const LAST_SESSION_STORAGE_KEY = 'batshit:lastSessionId'

function session(id: string): ChatSession {
  return {
    id,
    user_id: 'user-1',
    name: id,
    created_at: '2026-06-06T00:00:00.000Z',
    last_modified_at: '2026-06-06T00:00:00.000Z'
  }
}

describe('session store', () => {
  beforeEach(() => {
    localStorage.clear()
    setSessions([])
    setCurrentSessionId(null)
  })

  afterEach(() => {
    setSessions([])
    setCurrentSessionId(null)
    localStorage.clear()
  })

  it('clears the persisted selected session when deleting the selected session', () => {
    setSessions([session('session-a')])
    setCurrentSessionId('session-a')

    expect(localStorage.getItem(LAST_SESSION_STORAGE_KEY)).toBe('session-a')

    deleteSession('session-a')

    expect(getCurrentSessionId()).toBeNull()
    expect(localStorage.getItem(LAST_SESSION_STORAGE_KEY)).toBeNull()
  })

  // SA-113 P1 (DL-113-06): sessions that arrive on the user channel.
  it('upsertSession adds a server-created chat at the top of the list', () => {
    setSessions([session('session-a')])

    upsertSession({ ...session('session-woken'), name: 'DM from Cooper' })

    expect(getSessions().map((entry) => entry.id)).toEqual(['session-woken', 'session-a'])
  })

  it('upsertSession patches instead of duplicating when the chat is already listed', () => {
    setSessions([session('session-a'), session('session-b')])

    upsertSession({ ...session('session-a'), name: 'Renamed by the server' })

    const sessions = getSessions()
    expect(sessions).toHaveLength(2)
    expect(sessions.find((entry) => entry.id === 'session-a')?.name).toBe(
      'Renamed by the server'
    )
  })

  it('patchSessionFromServer does not re-stamp last_modified_at, so the sidebar keeps its order', () => {
    setSessions([session('session-a')])

    patchSessionFromServer('session-a', { name: 'Server rename' })

    const updated = getSessions()[0]
    expect(updated.name).toBe('Server rename')
    expect(updated.last_modified_at).toBe('2026-06-06T00:00:00.000Z')
  })

  it('patchSessionFromServer ignores an unknown chat', () => {
    setSessions([session('session-a')])
    patchSessionFromServer('session-missing', { name: 'nope' })
    expect(getSessions()).toHaveLength(1)
  })
})
