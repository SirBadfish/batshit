import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { isToolModelCutView } from '$lib/utils/toolModelTextSizeGuard'
import { VercelAIBrain } from '../vercelBrain'
import { fetchZipForModel } from '../fetchZipForModel'
import { clearStreamAbort, registerStreamAbort } from '../streamAbortRegistry'
import { __resetToolModelRetentionTurnBudgetsForTests } from '../toolModelRetentionTurnBudget'

/**
 * BL-680: an API Subagent runs in process with the PARENT as its agent and its own made-up reply
 * id (`subagent-<id>-<uuid>`, subagentRunner.ts). In a group chat its kept copy names that id,
 * which is never saved and never the chat's running reply, so Fetch Zip refuses it: a cut line
 * with an id and an offset promised a fetch that could not work. The rule tested here: a cut line
 * names an id exactly when that run's own Fetch Zip accepts it.
 */

useRedisTestServer()

const USER = 'bl680-user'
const PARENT = 'bl680-parent-agent'
const MEMBER_REPLY = 'bl680-member-reply'
const SUBAGENT_RUN = 'subagent-bl680-sub-7c0a5a1e-0000-4000-8000-000000000001'
let chat = ''
let counter = 0

// The in-memory lane's fake has no group reader; read the key `redis.getGroup` reads.
const hadGetGroup = typeof (redis as any).getGroup === 'function'
if (!hadGetGroup) (redis as any).getGroup = async (id: string) => redis.json.get(`group:${id}`)

beforeEach(async () => {
  if (process.env.VITEST_USE_REAL_REDIS !== 'true') vi.stubEnv('VITEST_FAKE_RETAINED_OUTPUT_EVAL', 'true')
  counter += 1
  chat = `bl680-chat-${counter}-${Date.now()}`
})

afterEach(() => {
  clearStreamAbort(chat)
  __resetToolModelRetentionTurnBudgetsForTests()
  vi.unstubAllEnvs()
})

async function seedChat(group: boolean) {
  await redis.createSession({
    id: chat, user_id: USER, agent_id: PARENT, title: 'BL-680',
    ...(group ? { metadata: { group_chat: { group_id: `group-${chat}` } } } : {})
  } as any)
  if (group) {
    await redis.json.set(`group:group-${chat}`, '$', {
      id: `group-${chat}`, user_id: USER, name: 'BL-680 group', agent_ids: [PARENT], shared_tools: []
    } as any)
  }
  // The member's reply is the chat's running reply, as send-routed registers it.
  registerStreamAbort(chat, MEMBER_REPLY, new AbortController())
}

/** The real API lane: a tool's output through vercelBrain's wrapper, as this run's context. */
async function cutLineFor(messageId: string): Promise<string> {
  const text = 'one line of a large tool result\n'.repeat(4_000)
  const wrapped = (VercelAIBrain.prototype as any).wrapToolsWithReadableModelOutput({
    example_tool: { execute: async () => text }
  }, { userId: USER, sessionId: chat, messageId, agentId: PARENT, fetchZipAllowed: true })
  const model = await wrapped.example_tool.toModelOutput({ toolCallId: `bl680-${messageId}`, input: {}, output: text })
  expect(isToolModelCutView(String(model.value))).toBe(true)
  return String(model.value)
}

async function keptCopyId(): Promise<string> {
  const ids = await redis.sMembers(`session:${chat}:zips`)
  expect(ids).toHaveLength(1)
  return ids[0]
}

function promisedFetch(line: string): { zipId: string; offset: number } | null {
  const match = line.match(/Call Fetch Zip with zipId (\S+) and offset (\d+) to read the rest\./)
  return match ? { zipId: match[1], offset: Number(match[2]) } : null
}

describe('BL-680: a cut line names an id only when the run can fetch it', () => {
  it('gives an API Subagent in a group chat the line with no id, and its fetch would be refused', async () => {
    await seedChat(true)
    const line = await cutLineFor(SUBAGENT_RUN)
    expect(promisedFetch(line)).toBeNull()
    expect(line).toContain("in a group chat only the member's own reply can fetch its kept copy")
    expect(line).toContain('Run the tool again for a smaller part.')

    // Proof the old line was a false promise: the Subagent's own fetch of its copy is refused.
    const copy = await keptCopyId()
    const own = await fetchZipForModel({ userId: USER, sessionId: chat, agentId: PARENT, messageId: SUBAGENT_RUN }, { zipId: copy })
    expect(own.found).toBe(false)
  })

  it('still names the id for the member\'s own reply in the same group chat, and that fetch works', async () => {
    await seedChat(true)
    const line = await cutLineFor(MEMBER_REPLY)
    const promised = promisedFetch(line)
    expect(promised).not.toBeNull()
    const page = await fetchZipForModel(
      { userId: USER, sessionId: chat, agentId: PARENT, messageId: MEMBER_REPLY },
      { zipId: promised!.zipId, offset: promised!.offset }
    )
    expect(page.found).toBe(true)
    expect(page.offset).toBe(promised!.offset)
  })

  it('names the id for an API Subagent outside a group chat, where its fetch works', async () => {
    await seedChat(false)
    const line = await cutLineFor(SUBAGENT_RUN)
    const promised = promisedFetch(line)
    expect(promised).not.toBeNull()
    const page = await fetchZipForModel(
      { userId: USER, sessionId: chat, agentId: PARENT, messageId: SUBAGENT_RUN },
      { zipId: promised!.zipId, offset: promised!.offset }
    )
    expect(page.found).toBe(true)
  })
})
