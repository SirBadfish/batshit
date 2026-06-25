import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  deleteSession,
  getCurrentSessionId,
  setCurrentSessionId,
  setSessions,
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
})
