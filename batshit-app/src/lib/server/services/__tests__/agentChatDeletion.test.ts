import { describe, expect, it, vi } from 'vitest'

vi.mock('$lib/server/redis', () => ({
  redis: { getSessions: vi.fn(), updateSession: vi.fn() }
}))
vi.mock('$lib/server/services/sessionDeleteTurnStop', () => ({
  deleteSessionStoppingItsTurn: vi.fn()
}))

import { deleteAgentChats, selectAgentChats } from '$lib/server/services/agentChatDeletion'

const fixed = { fixedSession: { version: 1, enabled: true, created_at: '2026-08-31T06:35:32.808Z' } }

const sessions = [
  { id: 'bob-regular', agent_id: 'bob', locked: false, archived: false, metadata: {} },
  { id: 'bob-archived', agent_id: 'bob', locked: false, archived: true, metadata: {} },
  { id: 'bob-infinite', agent_id: 'bob', locked: true, archived: false, metadata: { ...fixed } },
  { id: 'bob-kept', agent_id: 'bob', locked: true, archived: false, metadata: {} },
  { id: 'bob-group', agent_id: 'bob', locked: false, archived: false, metadata: { group_chat: true } },
  { id: 'lucy-regular', agent_id: 'lucy', locked: false, archived: false, metadata: {} },
  { id: 'no-agent', locked: false, archived: false, metadata: {} }
]

describe('selectAgentChats (2026-09-19: "Also delete its chats")', () => {
  it('takes the agent’s own chats, archived ones included, and its Infinite Session; keeps a chat the user locked; never a group', () => {
    const selection = selectAgentChats(sessions, 'bob')
    expect(selection.deletable.map((chat) => chat.id)).toEqual([
      'bob-regular',
      'bob-archived',
      'bob-infinite'
    ])
    expect(selection.deletable.find((chat) => chat.id === 'bob-infinite')).toMatchObject({
      fixed: true,
      locked: true
    })
    expect(selection.keptLocked.map((chat) => chat.id)).toEqual(['bob-kept'])
  })

  it('selects nothing for an agent with no chats', () => {
    expect(selectAgentChats(sessions, 'nobody')).toEqual({ deletable: [], keptLocked: [] })
  })
})

describe('deleteAgentChats', () => {
  it('unlocks only the Infinite Session, deletes every deletable chat through the door, and reports kept locked chats', async () => {
    const unlock = vi.fn(async () => {})
    const deleteOne = vi.fn(async () => ({ kind: 'no_turn' as const }))
    const result = await deleteAgentChats('josh', 'bob', {
      select: async () => selectAgentChats(sessions, 'bob'),
      unlock,
      deleteOne
    })
    expect(unlock.mock.calls.map(([id]) => id)).toEqual(['bob-infinite'])
    expect(deleteOne.mock.calls.map(([id]) => id)).toEqual(['bob-regular', 'bob-archived', 'bob-infinite'])
    expect(result).toEqual({
      deleted: ['bob-regular', 'bob-archived', 'bob-infinite'],
      keptLocked: ['bob-kept']
    })
  })

  it('stops at the first refusal and rethrows it untouched, so the route can answer 409 and keep the agent', async () => {
    const refusal = Object.assign(new Error('still stopping'), { status: 409 })
    const deleteOne = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'no_turn' })
      .mockRejectedValueOnce(refusal)
    await expect(
      deleteAgentChats('josh', 'bob', {
        select: async () => selectAgentChats(sessions, 'bob'),
        unlock: async () => {},
        deleteOne
      })
    ).rejects.toBe(refusal)
    expect(deleteOne).toHaveBeenCalledTimes(2)
  })

  it('uses the real door and the real unlock by default', async () => {
    const { redis } = await import('$lib/server/redis')
    const { deleteSessionStoppingItsTurn } = await import('$lib/server/services/sessionDeleteTurnStop')
    vi.mocked(redis.getSessions).mockResolvedValue(sessions as never)
    vi.mocked(redis.updateSession).mockResolvedValue(undefined as never)
    vi.mocked(deleteSessionStoppingItsTurn).mockResolvedValue({ kind: 'no_turn' })

    const result = await deleteAgentChats('josh', 'bob')
    expect(redis.getSessions).toHaveBeenCalledWith('josh', true)
    expect(redis.updateSession).toHaveBeenCalledWith('bob-infinite', { locked: false })
    expect(vi.mocked(deleteSessionStoppingItsTurn).mock.calls.map(([id]) => id)).toEqual([
      'bob-regular',
      'bob-archived',
      'bob-infinite'
    ])
    expect(result.deleted).toHaveLength(3)
  })
})
