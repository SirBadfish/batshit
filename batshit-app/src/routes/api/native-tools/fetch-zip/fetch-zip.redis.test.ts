import { describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { nativeToolService } from '$lib/server/services/nativeTools'

// The live in-process Fetch Zip owner, zip service, and Redis records are real here.
useRedisTestServer()

const USER = 'fetch-owner'
const FOREIGN_USER = 'fetch-foreign'
const CHAT = 'fetch-chat'
const OTHER_CHAT = 'fetch-other-chat'
const GROUP_CHAT = 'fetch-group-chat'
const AGENT_A = 'fetch-agent-a'
const AGENT_B = 'fetch-agent-b'
const REPLY_A = 'fetch-reply-a'
const OWN_ZIP = 'cool_tool_1790000000000_aaaa'
const FOREIGN_ZIP = 'cool_tool_1790000000000_bbbb'
const LEGACY_ZIP = 'cool_tool_1790000000000_cccc'
const WEB_ZIP = 'cool_tool_1790000000000_dddd'
const HIDDEN_RAW = 'tool_raw_1790000000000_eeee'

function run(agentId: string, sessionId: string, messageId = REPLY_A) {
  return { userId: USER, agentId, sessionId, messageId, actorType: 'in-process' as const }
}
async function fetch(context: ReturnType<typeof run>, zipId: string) {
  return { status: 200, body: await nativeToolService.nativeFetchZip({ ...context, zipId }) }
}

async function seed() {
  for (const [id, userId] of [[AGENT_A, USER], [AGENT_B, USER]] as const) {
    await redis.createAgent({
      id, user_id: userId, displayName: id, agentType: 'api',
      primary_model_provider: 'anthropic', primary_model_name: 'claude-sonnet-4-5'
    } as any)
  }
  for (const [id, userId] of [
    [CHAT, USER], [OTHER_CHAT, USER], ['fetch-foreign-chat', FOREIGN_USER]
  ] as const) {
    await redis.createSession({ id, user_id: userId, name: id } as any)
  }
  await redis.createGroup({
    id: 'fetch-group', user_id: USER, name: 'Fetch group',
    agent_ids: [AGENT_A, AGENT_B], shared_tools: []
  } as any)
  await redis.createSession({
    id: GROUP_CHAT, user_id: USER, name: 'Fetch group chat',
    metadata: { group_chat: { group_id: 'fetch-group' } }
  } as any)
}

async function zip(id: string, content: string, metadata: Record<string, unknown>, type = 'cool_tool') {
  await redis.createZip({ id, content, type, tokens: 40, description: id, metadata })
}

const describeRealRedis = process.env.VITEST_USE_REAL_REDIS === 'true' ? describe : describe.skip
describeRealRedis('real Redis API model Fetch Zip authorization', () => {
  it('uses the server-owned chat and user scope', async () => {
    await seed()
    await zip(OWN_ZIP, 'OWN_CHAT_SECRET', { userId: USER, sessionId: CHAT })
    await zip(FOREIGN_ZIP, 'FOREIGN_USER_SECRET', {
      userId: FOREIGN_USER, sessionId: 'fetch-foreign-chat'
    })

    const ownRun = await run(AGENT_A, CHAT)
    const otherChatRun = await run(AGENT_A, OTHER_CHAT)
    const own = await fetch(ownRun, OWN_ZIP)
    expect(own.status).toBe(200)
    expect(own.body).toMatchObject({ found: true, content: 'OWN_CHAT_SECRET' })

    const crossChat = await fetch(otherChatRun, OWN_ZIP)
    expect(crossChat.status).toBe(200)
    expect(crossChat.body).toMatchObject({ found: false, reason: 'Zip belongs to a different chat.' })
    expect(JSON.stringify(crossChat.body)).not.toContain('OWN_CHAT_SECRET')

    const foreign = await fetch(ownRun, FOREIGN_ZIP)
    expect(foreign.status).toBe(200)
    expect(foreign.body.found).toBe(false)
    expect(JSON.stringify(foreign.body)).not.toContain('FOREIGN_USER_SECRET')


  })

  it('requires a trusted saved link before an old user-only zip crosses into a chat', async () => {
    await seed()
    await zip(LEGACY_ZIP, 'LEGACY_SECRET', { userId: USER })
    const ownRun = await run(AGENT_A, CHAT)
    const otherChatRun = await run(AGENT_A, OTHER_CHAT)
    expect((await fetch(ownRun, LEGACY_ZIP)).body.found).toBe(false)

    await redis.saveMessage({
      id: REPLY_A, session_id: CHAT, user_id: USER, agent_id: AGENT_A,
      role: 'assistant', content: 'Older tool result',
      metadata: { zipIds: [LEGACY_ZIP] }
    } as any)
    const linkedLegacy = (await fetch(ownRun, LEGACY_ZIP)).body
    expect(linkedLegacy, JSON.stringify(linkedLegacy)).toMatchObject({
      found: true, content: 'LEGACY_SECRET'
    })
    expect((await fetch(otherChatRun, LEGACY_ZIP)).body.found).toBe(false)
  })

  it('shares only configured saved group tools, and keeps hidden raw with its author', async () => {
    await seed()
    await zip(WEB_ZIP, 'WEB_SEARCH_SECRET', {
      userId: USER, sessionId: GROUP_CHAT, messageId: REPLY_A, toolName: 'web_search'
    })
    await redis.saveMessage({
      id: REPLY_A, session_id: GROUP_CHAT, user_id: USER, agent_id: AGENT_A,
      role: 'assistant', content: `{{batshit-zip:${WEB_ZIP}:::web_search}}`,
      metadata: { zipIds: [WEB_ZIP] }
    } as any)
    const author = await run(AGENT_A, GROUP_CHAT)
    const other = await run(AGENT_B, GROUP_CHAT, 'fetch-reply-b')
    const authorResult = (await fetch(author, WEB_ZIP)).body
    expect(authorResult.found, JSON.stringify(authorResult)).toBe(true)
    expect((await fetch(other, WEB_ZIP)).body.found).toBe(false)

    await redis.createGroup({
      id: 'fetch-group', user_id: USER, name: 'Fetch group',
      agent_ids: [AGENT_A, AGENT_B], shared_tools: ['web_search']
    } as any)
    expect((await fetch(other, WEB_ZIP)).body).toMatchObject({
      found: true, content: 'WEB_SEARCH_SECRET'
    })

    await zip(HIDDEN_RAW, 'HIDDEN_RAW_SECRET', {
      userId: USER, sessionId: GROUP_CHAT, messageId: REPLY_A,
      agentId: AGENT_A, retainedForSizeGuard: true, toolName: 'web_search'
    }, 'tool_raw')
    expect((await fetch(author, HIDDEN_RAW)).body.found).toBe(true)
    const denied = await fetch(other, HIDDEN_RAW)
    expect(denied.body.found).toBe(false)
    expect(JSON.stringify(denied.body)).not.toContain('HIDDEN_RAW_SECRET')
  })
})
