import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { DatabaseService as ServerDatabaseService } from '$lib/services/databaseRedis.server'
import { resolveCompiledMessageElement, type CompiledSpeakerView } from '$lib/utils/compiledChatTags'
import { resolveCompiledSpeakerView } from '../compiledSpeakerView'

/**
 * BL-224: a Compact or graduation transcript names speakers with the compiler's own speaker view.
 *
 * `resolveCompiledSpeakerView` reads names the way the compiler's `buildSpeakerView` does, and
 * `resolveCompiledMessageElement` picks the element the way its `resolveMessageElement` does. The
 * compiler keeps its own private copies, so the parity block below runs the REAL compiler methods
 * and the shared ones over one history and requires the same element for every message.
 */

const AGENT_KEYS = ['agent:zbctx_bram', 'agent:zbctx_lucy', 'agent:zbctx_cody']

function history() {
  return [
    { id: 'u1', role: 'user', content: 'Which color for the kitchen?', metadata: {} },
    { id: 'a1', role: 'assistant', agent_id: 'zbctx_cody', content: 'Sage green.', metadata: {} },
    // Named from the agent record, whatever the reply was stored with.
    { id: 'a2', role: 'assistant', agent_id: 'zbctx_bram', content: 'Navy.', metadata: { agentDisplayName: 'Old Bram' } },
    // `name` when the record has no `displayName`.
    { id: 'a3', role: 'assistant', agentId: 'zbctx_lucy', content: 'Teal.', metadata: {} },
    // No record: the stored name.
    { id: 'a4', role: 'assistant', content: 'Gray.', metadata: { agentId: 'zbctx_gone', agentName: 'Gone Agent' } },
    // No record and no stored name: the id.
    { id: 'a5', role: 'assistant', agent_id: 'zbctx_ghost', content: 'White.', metadata: {} },
    // No agent id at all: the compile's own agent (DP-4).
    { id: 'a6', role: 'assistant', content: 'Older reply.', metadata: {} },
    // A woken turn's DM is Batshit's note, not the user.
    { id: 'u2', role: 'user', content: '[Agent DM — from Bram, not from the user] ping', metadata: { wake: { chainDepth: 1 } } },
    { id: 's1', role: 'system', content: 'Context compact summary: …', metadata: {} }
  ] as any[]
}

beforeEach(async () => {
  await redis.set('agent:zbctx_bram', { id: 'zbctx_bram', displayName: 'Bram', name: 'bram-name' })
  await redis.set('agent:zbctx_lucy', { id: 'zbctx_lucy', name: 'Lucy' })
  await redis.set('agent:zbctx_cody', { id: 'zbctx_cody', displayName: 'Cody' })
})

afterEach(async () => {
  for (const key of AGENT_KEYS) await redis.del(key)
  vi.restoreAllMocks()
})

describe('resolveCompiledSpeakerView (BL-224)', () => {
  it('names every other agent from its record, then its stored name, then its id', async () => {
    const view = await resolveCompiledSpeakerView({ messages: history(), selfAgentId: 'zbctx_cody' })

    expect(view.selfAgentId).toBe('zbctx_cody')
    expect(Object.fromEntries(view.agentNames)).toEqual({
      zbctx_bram: 'Bram',
      zbctx_lucy: 'Lucy',
      zbctx_gone: 'Gone Agent',
      zbctx_ghost: 'zbctx_ghost'
    })
  })

  it('reads each other agent once and never the view\'s own agent', async () => {
    const getSpy = vi.spyOn(redis, 'get')
    getSpy.mockClear()
    const messages = [...history(), { id: 'a7', role: 'assistant', agent_id: 'zbctx_bram', content: 'Again.' }]

    await resolveCompiledSpeakerView({ messages, selfAgentId: 'zbctx_cody' })

    const reads = getSpy.mock.calls.map(([key]) => key)
    expect(reads.filter((key) => key === 'agent:zbctx_bram')).toHaveLength(1)
    expect(reads).not.toContain('agent:zbctx_cody')
  })

  it('names the chat agent too when the summary is for no one agent (a group chat)', async () => {
    const view = await resolveCompiledSpeakerView({ messages: history(), selfAgentId: null })

    expect(view.agentNames.get('zbctx_cody')).toBe('Cody')
  })

  it('falls back to the stored name when a record cannot be read, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // The fake's `get` is itself a mock: keep its implementation and put it back afterwards.
    const realGet = (redis.get as any).getMockImplementation()
    ;(redis.get as any).mockImplementation(async (key: string) => {
      if (key === 'agent:zbctx_bram') throw new Error('redis down')
      return realGet(key)
    })

    let view: CompiledSpeakerView
    try {
      view = await resolveCompiledSpeakerView({ messages: history(), selfAgentId: 'zbctx_cody' })
    } finally {
      ;(redis.get as any).mockImplementation(realGet)
    }

    expect(view.agentNames.get('zbctx_bram')).toBe('Old Bram')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not read agent zbctx_bram'),
      expect.any(Error)
    )
  })
})

describe('the transcript speaker view matches the compiler (BL-224 parity)', () => {
  async function compilerElements(messages: any[], agent: any) {
    const compiler = new ServerDatabaseService() as any
    const speakers = await compiler.buildSpeakerView(messages, agent)
    return messages.map((message) => compiler.resolveMessageElement(message, speakers))
  }

  async function sharedElements(messages: any[], selfAgentId: string | null) {
    const speakers: CompiledSpeakerView = await resolveCompiledSpeakerView({ messages, selfAgentId })
    return messages.map((message) => resolveCompiledMessageElement(message, speakers))
  }

  it('BL-472: artifact and agent shares are notes in both compiler and transcript views', async () => {
    const messages = ['user', 'agent', 'artifact'].map((shareInitiator) => ({
      role: 'user', content: 'Shared output', metadata: { source: 'artifact_share', shareInitiator }
    }))
    const expected = ['user', 'note', 'note']
    expect((await compilerElements(messages, { id: 'zbctx_cody' })).map(({ tag }) => tag)).toEqual(expected)
    expect((await sharedElements(messages, 'zbctx_cody')).map(({ tag }) => tag)).toEqual(expected)
  })

  it('gives every message the same element and name, for each agent the history is compiled for', async () => {
    const messages = history()
    for (const self of ['zbctx_cody', 'zbctx_bram', 'zbctx_ghost']) {
      const fromCompiler = await compilerElements(messages, { id: self })
      const fromShared = await sharedElements(messages, self)
      expect(fromShared, self).toEqual(fromCompiler)
    }
    // And the elements are the ones DL-02 describes, not two copies that agree on something else.
    expect((await sharedElements(messages, 'zbctx_cody')).map((element) => element.name ?? element.tag)).toEqual([
      'user',
      'assistant',
      'Bram',
      'Lucy',
      'Gone Agent',
      'zbctx_ghost',
      'assistant',
      'note',
      'note'
    ])
  })
})
