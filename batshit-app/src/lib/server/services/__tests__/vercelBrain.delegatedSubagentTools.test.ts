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

const runnerMocks = vi.hoisted(() => ({ executeManagedSubagent: vi.fn() }))

vi.mock('../subagentRunner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../subagentRunner')>()),
  compileManagedSubagentSystemPrompt: vi.fn(async (subagent: any) => ({
    systemPrompt: '',
    description: `Delegate to ${subagent.displayName}`
  })),
  executeManagedSubagent: (...args: any[]) => runnerMocks.executeManagedSubagent(...args)
}))

const { VercelAIBrain } = await import('../vercelBrain')

const USER = 'zbctx_user'
const PARENT = 'zbctx_parent'
const SUBAGENT = { id: 'zbctx_sub', user_id: USER, displayName: 'zbctx Research Bot', subagentType: 'api' }
const SIBLING = { id: 'zbctx_sibling', user_id: USER, displayName: 'zbctx Sibling', subagentType: 'api' }

async function subagentToolNames(agentContext: { assignedSubagents?: any[] } | undefined) {
  const brain = new VercelAIBrain() as any
  const { tools, maps } = await brain.buildToolsForMode3(
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

describe('the Subagent tool result on the API Primary lane (delegation limits, 2026-10-24)', () => {
  async function callSubagentTool(status: string) {
    runnerMocks.executeManagedSubagent.mockResolvedValueOnce({
      output: status === 'partial' ? '[Partial result: …]\n\nHalf done.' : 'Done.',
      intermediateSteps: [],
      subagentType: 'api',
      usage: null,
      modelId: 'm',
      provider: 'p',
      durationMs: 1,
      status,
      thread: 'fresh'
    })
    const brain = new VercelAIBrain() as any
    const { tools } = await brain.buildToolsForMode3(
      'zbctx_session', USER, [], undefined, PARENT,
      { assignedSubagents: [SIBLING] }, null, null, 'off', { scopeAgentId: null }
    )
    return tools[SIBLING.id].execute({ chatInput: 'Go.' }, { toolCallId: 'c1', messages: [] })
  }

  it('a run its step limit stopped is not a failed call: success, with status partial', async () => {
    await expect(callSubagentTool('partial')).resolves.toMatchObject({ kind: 'subagent', success: true, status: 'partial' })
  })

  it('a failed or timed-out run still reads as unsuccessful', async () => {
    await expect(callSubagentTool('timed_out')).resolves.toMatchObject({ success: false, status: 'timed_out' })
    await expect(callSubagentTool('failed')).resolves.toMatchObject({ success: false, status: 'failed' })
    await expect(callSubagentTool('completed')).resolves.toMatchObject({ success: true, status: 'completed' })
  })
})
