import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as agentStore from '$lib/stores/agents.svelte'

/**
 * SA-122 A-1y (LS-067/LS-068): when the agent changes its own Settings, the shared agent store reads
 * that agent again and takes only the changed family's fields. Its reads are guarded per agent AND
 * family (Ashe's refinement a): a later identity read never drops an earlier memory read, and only a
 * newer read of the same family drops an older one, whatever order the answers come in.
 */

const AGENT = 'agent-refresh'
const OTHER = 'agent-other'

type Pending = { url: string; resolve: (record: unknown, status?: number) => void; reject: (error: Error) => void }
let pending: Pending[] = []

function seedStore() {
  agentStore.setAgents([
    {
      id: AGENT,
      user_id: 'user-refresh',
      displayName: 'Probe',
      memory_lane_budgets: { on_my_mind: 100, triggers: 200, recalled: 300 },
      memoryLaneBudgets: { on_my_mind: 1, triggers: 1, recalled: 1 },
      memory_linger_turns: 2,
      system_prompt: 'Stays as it is.'
    },
    { id: OTHER, user_id: 'user-refresh', displayName: 'Other' }
  ] as any)
}

function agent(id = AGENT): any {
  return agentStore.getAgentById(id)
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT,
    user_id: 'user-refresh',
    displayName: 'Probe',
    memory_lane_budgets: { on_my_mind: 100, triggers: 200, recalled: 300 },
    memory_linger_turns: 2,
    system_prompt: 'Changed on the server, not by this family.',
    ...overrides
  }
}

beforeEach(() => {
  pending = []
  seedStore()
  vi.stubGlobal('fetch', vi.fn((url: string) =>
    new Promise<Response>((resolve, reject) => {
      pending.push({
        url,
        resolve: (body, status = 200) => resolve(new Response(JSON.stringify(body), { status })),
        reject
      })
    })
  ))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the agent store reads a changed family again (SA-122 A-1y)', () => {
  it('identity: takes displayName only; memory and every other field stay as they were', async () => {
    const done = agentStore.refreshAgentFieldsFromServer(AGENT, 'identity')
    expect(pending.map((call) => call.url)).toEqual([`/api/agents/${AGENT}`])
    pending[0].resolve(record({ displayName: 'Probe 2', memory_linger_turns: 7 }))
    await done

    expect(agent()).toMatchObject({ displayName: 'Probe 2', memory_linger_turns: 2, system_prompt: 'Stays as it is.' })
  })

  it('memory: takes every stored memory name; a name the record no longer holds is cleared', async () => {
    const done = agentStore.refreshAgentFieldsFromServer(AGENT, 'memory')
    pending[0].resolve(record({ memory_lane_budgets: { on_my_mind: 120, triggers: 200, recalled: 300 }, displayName: 'Not this family' }))
    await done

    expect(agent().memory_lane_budgets).toEqual({ on_my_mind: 120, triggers: 200, recalled: 300 })
    expect(agent().memoryLaneBudgets).toBeUndefined()
    expect(agent().displayName).toBe('Probe')
    expect(agent().system_prompt).toBe('Stays as it is.')
  })

  it('a memory read and an identity read whose answers come back in reverse order: both land', async () => {
    const memory = agentStore.refreshAgentFieldsFromServer(AGENT, 'memory')
    const identity = agentStore.refreshAgentFieldsFromServer(AGENT, 'identity')
    expect(pending).toHaveLength(2)

    // The later identity read answers first; the earlier memory read must not be dropped for it.
    pending[1].resolve(record({ displayName: 'Probe 2' }))
    await identity
    pending[0].resolve(record({ displayName: 'Probe 2', memory_lane_budgets: { on_my_mind: 120, triggers: 200, recalled: 300 } }))
    await memory

    expect(agent().displayName).toBe('Probe 2')
    expect(agent().memory_lane_budgets).toEqual({ on_my_mind: 120, triggers: 200, recalled: 300 })
  })

  it('two memory reads whose answers come back in reverse order: the newer read wins, the older answer is dropped', async () => {
    const older = agentStore.refreshAgentFieldsFromServer(AGENT, 'memory')
    const newer = agentStore.refreshAgentFieldsFromServer(AGENT, 'memory')

    pending[1].resolve(record({ memory_lane_budgets: { on_my_mind: 130, triggers: 200, recalled: 300 } }))
    await newer
    pending[0].resolve(record({ memory_lane_budgets: { on_my_mind: 120, triggers: 200, recalled: 300 } }))
    await older

    expect(agent().memory_lane_budgets).toEqual({ on_my_mind: 130, triggers: 200, recalled: 300 })
  })

  it('reads of two agents are independent', async () => {
    const first = agentStore.refreshAgentFieldsFromServer(AGENT, 'identity')
    const second = agentStore.refreshAgentFieldsFromServer(OTHER, 'identity')
    pending[1].resolve({ id: OTHER, displayName: 'Other 2' })
    await second
    pending[0].resolve(record({ displayName: 'Probe 2' }))
    await first

    expect(agent().displayName).toBe('Probe 2')
    expect(agent(OTHER).displayName).toBe('Other 2')
  })

  it('a failed read, or an answer for another agent, changes nothing and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failed = agentStore.refreshAgentFieldsFromServer(AGENT, 'identity')
    pending[0].resolve({ error: 'Agent not found' }, 404)
    await failed
    const wrong = agentStore.refreshAgentFieldsFromServer(AGENT, 'identity')
    pending[1].resolve({ id: OTHER, displayName: 'Wrong agent' })
    await wrong
    const thrown = agentStore.refreshAgentFieldsFromServer(AGENT, 'memory')
    pending[2].reject(new Error('offline'))
    await thrown

    expect(agent().displayName).toBe('Probe')
    expect(agent().memory_lane_budgets).toEqual({ on_my_mind: 100, triggers: 200, recalled: 300 })
    expect(warn).toHaveBeenCalledTimes(3)
  })

  it('an agent this tab has not loaded is not read', async () => {
    await agentStore.refreshAgentFieldsFromServer('agent-unknown', 'identity')
    expect(pending).toHaveLength(0)
  })
})
