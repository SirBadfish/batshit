import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GET /api/agents/[id]/chats (BL-778 part 2): the delete dialog's checkbox names how many of
 * the agent's deletable chats are archived, the same word BL-388's folder-delete dialog uses
 * (`describeFolderDeleteWithChats` in folderDeleteDialog.ts) -- the sidebar hides archived
 * chats, so the user may not remember they exist. The count is real (not derived from anything
 * the page already has), so the route must answer it directly.
 */

const store = vi.hoisted(() => ({
  agents: new Map<string, any>(),
  sessions: [] as any[]
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    get: vi.fn(async (key: string) => store.agents.get(key) ?? null),
    getSessions: vi.fn(async () => store.sessions)
  }
}))

async function callGet(userId: string | null, agentId = 'bob') {
  const { GET } = await import('./+server')
  const response = await GET({
    params: { id: agentId },
    locals: userId ? { user: { id: userId } } : {}
  } as any)
  return { status: response.status, payload: await response.json() }
}

describe('GET /api/agents/[id]/chats', () => {
  beforeEach(() => {
    store.agents.clear()
    store.agents.set('agent:bob', { id: 'bob', user_id: 'user-1' })
    store.sessions = []
  })

  it('names how many deletable chats are archived, alongside the existing counts', async () => {
    store.sessions = [
      { id: 'c1', agent_id: 'bob', locked: false, archived: false, metadata: {} },
      { id: 'c2', agent_id: 'bob', locked: false, archived: true, metadata: {} },
      { id: 'c3', agent_id: 'bob', locked: false, archived: true, metadata: {} },
      { id: 'c4', agent_id: 'bob', locked: true, archived: false, metadata: {} } // kept, not deletable
    ]

    const { status, payload } = await callGet('user-1')

    expect(status).toBe(200)
    expect(payload).toEqual({
      deletable: 3,
      infinite: 0,
      keptLocked: 1,
      archived: 2
    })
  })

  it('answers zero archived when none of the deletable chats are archived', async () => {
    store.sessions = [{ id: 'c1', agent_id: 'bob', locked: false, archived: false, metadata: {} }]
    const { payload } = await callGet('user-1')
    expect(payload.archived).toBe(0)
  })
})
