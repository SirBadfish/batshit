import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'

/**
 * A Subagent or Worker run never gets Subagent tools (depth 1, found live in the 2026-09-25 bug
 * batch).
 *
 * `subagentRunner.ts` starts an API Subagent or Worker in process with `agentId` = its PARENT and
 * `assignedSubagents: []`. The brain treated an empty list as "no list" and fell back to reading
 * `agent:<agentId>`, the parent's record, so the run was offered the parent's Subagents as tools,
 * itself included (seen on the wire: `zbcontext_sub` in its own tool list). A provided list is the
 * authority, an empty one included; only a caller that passes no list reads the agent record.
 *
 * Drives the REAL `buildToolsForMode3` on the default lane's Redis; the native tool set and the
 * Subagent prompt compile are stubbed because neither decides which Subagent tools exist.
 */

vi.mock('../nativeTools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../nativeTools')>()
  return {
    ...actual,
    nativeToolService: {
      ...actual.nativeToolService,
      buildMode3NativeTools: vi.fn(async () => ({ tools: {}, toolApprovals: {} }))
    }
  }
})

vi.mock('../subagentRunner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../subagentRunner')>()),
  compileManagedSubagentSystemPrompt: vi.fn(async (subagent: any) => ({
    systemPrompt: '',
    description: `Delegate to ${subagent.displayName}`
  }))
}))

const { VercelAIBrain } = await import('../vercelBrain')

const USER = 'zbctx_user'
const PARENT = 'zbctx_parent'
const SUBAGENT = { id: 'zbctx_sub', user_id: USER, displayName: 'zbctx Research Bot', subagentType: 'api' }
const SIBLING = { id: 'zbctx_sibling', user_id: USER, displayName: 'zbctx Sibling', subagentType: 'api' }

async function subagentToolNames(agentContext: { assignedSubagents?: any[] } | undefined) {
  const brain = new VercelAIBrain() as any
  const { tools, maps } = await brain.buildToolsForMode3(
    undefined,
    undefined,
    'zbctx_session',
    USER,
    [],
    undefined,
    PARENT,
    agentContext,
    null,
    null,
    'off',
    { scopeAgentId: agentContext?.assignedSubagents ? SUBAGENT.id : null }
  )
  return { toolKeys: Object.keys(tools ?? {}).sort(), subagentTools: Array.from(maps.subagentTools.keys()).sort() }
}

beforeEach(async () => {
  await redis.set(`agent:${PARENT}`, { id: PARENT, user_id: USER, assignedSubagents: [SUBAGENT.id, SIBLING.id] })
  await redis.json.set(`subagent:${SUBAGENT.id}`, '$', SUBAGENT as never)
  await redis.json.set(`subagent:${SIBLING.id}`, '$', SIBLING as never)
})

afterEach(async () => {
  for (const key of [`agent:${PARENT}`, `subagent:${SUBAGENT.id}`, `subagent:${SIBLING.id}`]) await redis.del(key)
  vi.clearAllMocks()
})

describe('Subagent tools in a delegated run', () => {
  it('registers none when the caller passes an empty list, whatever its parent has assigned', async () => {
    const { toolKeys, subagentTools } = await subagentToolNames({ assignedSubagents: [] })

    expect(subagentTools).toEqual([])
    expect(toolKeys).not.toContain(SUBAGENT.id)
    expect(toolKeys).not.toContain(SIBLING.id)
  })

  it('registers exactly the list a primary send passes', async () => {
    const { subagentTools } = await subagentToolNames({ assignedSubagents: [SIBLING] })

    expect(subagentTools).toEqual([SIBLING.id])
  })

  it('still reads the agent record when a caller passes no list at all', async () => {
    const { subagentTools } = await subagentToolNames(undefined)

    expect(subagentTools).toEqual([SIBLING.id, SUBAGENT.id].sort())
  })
})
