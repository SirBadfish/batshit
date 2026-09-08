import { beforeEach, describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { resolveWokenTurnState } from '../wokenTurn'

/**
 * SA-113 F-SEC-1 / F-SEC-1b — the one read that tells a woken turn from a typed one.
 *
 * `useControl` refuses every risky Fabric control when this says `woken`, so what is pinned
 * here is the window (the RECENT fifty, not the first fifty — F-P2-1's lesson), the recovery
 * path (a human reply ends the woken state), and the fail-closed rule.
 */

useRedisTestServer()

const SESSION = 'sess-woken-turn'
const USER = 'user-woken-turn'

let sequence = 0

async function save(role: 'user' | 'assistant', metadata: Record<string, any> = {}) {
  sequence += 1
  await redis.saveMessage({
    id: `msg-${String(sequence).padStart(4, '0')}`,
    session_id: SESSION,
    user_id: USER,
    agent_id: 'agent-cooper',
    role,
    status: 'complete',
    content: `${role} ${sequence}`,
    created_at: new Date(Date.parse('2026-09-08T09:00:00.000Z') + sequence * 1000).toISOString(),
    metadata
  } as any)
}

beforeEach(async () => {
  sequence = 0
  await redis.del(`messages:${SESSION}`)
  // Real Redis `saveMessage` requires the session to exist — the in-memory fake did not,
  // which is the fourth-plus time this story's Vitest fake has been more permissive than
  // the thing it stands in for. Create it here so both lanes behave the same.
  await redis.createSession({
    id: SESSION,
    user_id: USER,
    name: 'Woken turn reads',
    agent_id: 'agent-cooper',
    created_at: '2026-09-08T09:00:00.000Z',
    last_modified_at: '2026-09-08T09:00:00.000Z',
    metadata: { agent_id: 'agent-cooper' }
  } as any)
})

describe('resolveWokenTurnState', () => {
  it('says a chat with no session and a chat the user typed in are both not woken', async () => {
    expect(await resolveWokenTurnState(undefined)).toEqual({ woken: false })
    expect(await resolveWokenTurnState('   ')).toEqual({ woken: false })

    await save('user')
    expect(await resolveWokenTurnState(SESSION)).toEqual({ woken: false })
  })

  it('reports a woken turn and the DM that started it', async () => {
    await save('user', { wake: { chainDepth: 1, dmId: 'dm_42' } })
    expect(await resolveWokenTurnState(SESSION)).toEqual({ woken: true, dmId: 'dm_42' })
  })

  it('reports a webhook wake, which carries no DM id on the message', async () => {
    await save('user', { wake: { chainDepth: 1 } })
    expect(await resolveWokenTurnState(SESSION)).toEqual({ woken: true, dmId: null })
  })

  it('stops being woken the moment the user replies — the whole recovery path', async () => {
    await save('user', { wake: { chainDepth: 1, dmId: 'dm_42' } })
    await save('assistant')
    expect(await resolveWokenTurnState(SESSION)).toMatchObject({ woken: true })

    await save('user')
    expect(await resolveWokenTurnState(SESSION)).toEqual({ woken: false })
  })

  it('reads the RECENT end, so a long woken chat is still woken (F-P2-1)', async () => {
    // The head of this chat is a typed turn. Reading the first fifty would answer about it
    // forever and hand a woken turn the risky controls it must not have.
    await save('user')
    for (let index = 0; index < 60; index += 1) await save('assistant')
    await save('user', { wake: { chainDepth: 1, dmId: 'dm_late' } })

    expect(await resolveWokenTurnState(SESSION)).toEqual({ woken: true, dmId: 'dm_late' })
  })

  it('fails CLOSED when the session cannot be read', async () => {
    // A security gate that cannot tell must not guess "a human did this".
    expect(await resolveWokenTurnState('sess-that-does-not-exist')).toEqual({ woken: false })

    const original = redis.getRecentMessages
    ;(redis as any).getRecentMessages = async () => {
      throw new Error('redis is down')
    }
    try {
      expect(await resolveWokenTurnState(SESSION)).toEqual({ woken: true, dmId: null })
    } finally {
      ;(redis as any).getRecentMessages = original
    }
  })
})
