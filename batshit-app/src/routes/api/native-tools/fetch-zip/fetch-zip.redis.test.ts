import { describe, expect, it } from 'vitest'
import { env } from '$env/dynamic/private'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  AGENT_RUN_CREDENTIAL_HEADER,
  mintRunCredential
} from '$lib/server/services/agentRunCredentials'
import { POST } from './+server'

// The route, run-credential verifier, zip service, and Redis records are all real here.
// This pins the actor/chat boundary that route tests with mocked auth cannot establish.
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

function request(
  token: string,
  zipId: string,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {}
) {
  return {
    request: new Request('http://localhost/api/native-tools/fetch-zip', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { [AGENT_RUN_CREDENTIAL_HEADER]: token } : {}),
        ...headers
      },
      body: JSON.stringify({ zipId, ...body })
    }),
    locals: {}
  } as any
}

async function run(agentId: string, sessionId: string, messageId = REPLY_A) {
  return (await mintRunCredential({
    userId: USER,
    agentId,
    sessionId,
    messageId,
    runtime: 'codex',
    fetchZipAllowed: true
  })).token
}

async function fetch(
  token: string,
  zipId: string,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {}
) {
  const response = await POST(request(token, zipId, body, headers))
  return { status: response.status, body: await response.json() as Record<string, any> }
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
describeRealRedis('real Redis model Fetch Zip route authorization', () => {
  it('uses the credential chat and user, never body ownership claims', async () => {
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

    const crossChat = await fetch(otherChatRun, OWN_ZIP, {
      userId: USER, sessionId: CHAT, agentId: AGENT_A,
      messageId: REPLY_A, fetchZipAllowed: true
    })
    expect(crossChat.status).toBe(200)
    expect(crossChat.body).toMatchObject({ found: false, reason: 'Zip belongs to a different chat.' })
    expect(JSON.stringify(crossChat.body)).not.toContain('OWN_CHAT_SECRET')

    const foreign = await fetch(ownRun, FOREIGN_ZIP, {
      userId: FOREIGN_USER, sessionId: 'fetch-foreign-chat'
    })
    expect(foreign.status).toBe(200)
    expect(foreign.body.found).toBe(false)
    expect(JSON.stringify(foreign.body)).not.toContain('FOREIGN_USER_SECRET')

    const disabled = (await mintRunCredential({
      userId: USER, agentId: AGENT_A, sessionId: CHAT,
      runtime: 'codex', fetchZipAllowed: false
    })).token
    const forgedPermission = await fetch(disabled, OWN_ZIP, { fetchZipAllowed: true })
    expect(forgedPermission.status).toBe(403)
    expect(JSON.stringify(forgedPermission.body)).not.toContain('OWN_CHAT_SECRET')

    const previousServiceToken = (env as Record<string, string | undefined>).BATSHIT_TOKEN
    const serviceToken = 'fetch-route-service-token-0123456789abcdef'
    ;(env as Record<string, string | undefined>).BATSHIT_TOKEN = serviceToken
    try {
      const service = await fetch('', OWN_ZIP, {
        userId: USER, sessionId: CHAT, agentId: AGENT_A,
        fetchZipAllowed: true
      }, {
        'x-batshit-service-token': serviceToken,
        'x-batshit-user-id': USER
      })
      expect(service.status).toBe(403)
      expect(JSON.stringify(service.body)).not.toContain('OWN_CHAT_SECRET')
    } finally {
      if (previousServiceToken === undefined) {
        delete (env as Record<string, string | undefined>).BATSHIT_TOKEN
      } else {
        ;(env as Record<string, string | undefined>).BATSHIT_TOKEN = previousServiceToken
      }
    }
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
    expect((await fetch(otherChatRun, LEGACY_ZIP, {
      sessionId: CHAT, agentId: AGENT_A
    })).body.found).toBe(false)
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
    expect((await fetch(other, WEB_ZIP, { agentId: AGENT_A })).body.found).toBe(false)

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
    const denied = await fetch(other, HIDDEN_RAW, {
      agentId: AGENT_A, messageId: REPLY_A, shared_tools: ['web_search']
    })
    expect(denied.body.found).toBe(false)
    expect(JSON.stringify(denied.body)).not.toContain('HIDDEN_RAW_SECRET')
  })
})
