// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '$env/dynamic/private'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { __resetWakeRunRegistryForTests, registerWakeRun } from '$lib/server/services/wakeRunRegistry'
import {
  __resetReplyRecordsForTests,
  closeReplyRecord,
  listReplayEvents,
  replyZipDetection
} from '$lib/server/services/replyStreamRecord'
import { buildSessionOrigin } from '$lib/utils/sessionOrigin'
import { POST } from './+server'

/**
 * BL-779 (a), `/api/sse`'s half, against the real route, the real stream detector and record: the
 * detector holds a closed `<error>` pair whose opening tag follows a stray backtick, because a later
 * backtick may still make it code. A tool card settles it: the pair is zipped and its reference goes
 * out, recorded, BEFORE the card (a block never spans a tool card). When the finalize closed the
 * reply while that zip was being written (a stalled forward, BL-871 c), the zip is removed again and
 * the card refused. A reply that ends with `complete` or `error` gets its held words back as words:
 * it was saved already, so a zip made then would be named by no saved reply.
 */

useRedisTestServer()

const USER = 'user-held-pair'
let SESSION = ''
let count = 0
const REPLY = 'msg-held-pair'
const envRecord = env as Record<string, string | undefined>
let previousToken: string | undefined

async function post(body: Record<string, unknown>) {
  const response = (await (POST as any)({
    request: new Request('http://localhost:5621/api/sse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-batshit-service-token': 'test-service-token',
        'x-internal-api-request': '1'
      },
      body: JSON.stringify({ sessionId: SESSION, messageId: REPLY, ...body })
    }),
    locals: {}
  })) as Response
  return response.json()
}

function recorded() {
  return listReplayEvents(SESSION)
    .filter((event) => event.messageId === REPLY && event.type !== 'start')
    .map((event) => (event.type === 'chunk' ? `chunk:${event.content}` : event.type))
}

async function zipsOfReply() {
  const ids = (await redis.execute((client: any) => client.sMembers(`session:${SESSION}:zips`))) as string[]
  const zips = await Promise.all(ids.map(async (id) => (await redis.execute((client: any) => client.json.get(`zip:${id}`))) as any))
  return zips.filter((zip) => zip?.metadata?.messageId === REPLY)
}

beforeEach(async () => {
  count += 1
  SESSION = `sess-held-pair-${count}`
  previousToken = envRecord.BATSHIT_TOKEN
  envRecord.BATSHIT_TOKEN = 'test-service-token'
  __resetReplyRecordsForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  await redis.createSession({ id: SESSION, user_id: USER, name: 'Held pair', agent_id: 'agent-held' } as any)
  registerWakeRun({
    sessionId: SESSION,
    agentId: 'agent-held',
    userId: USER,
    origin: buildSessionOrigin({ kind: 'dm', label: 'Faye', chainDepth: 1 }),
    startedAt: Date.now(),
    assistantMessageId: REPLY,
    controller: new AbortController(),
    timer: setTimeout(() => {}, 60_000)
  })
  expect(await post({ type: 'start', metadata: {} })).toEqual({ success: true })
})

afterEach(() => {
  __resetWakeRunRegistryForTests()
  __resetReplyRecordsForTests()
  if (previousToken === undefined) delete envRecord.BATSHIT_TOKEN
  else envRecord.BATSHIT_TOKEN = previousToken
  vi.restoreAllMocks()
})

describe('/api/sse: a held pair is settled at a tool card and released at the reply end (BL-779 a)', () => {
  it('zips the held pair before a tool card, and records it before the card', async () => {
    expect(await post({ type: 'chunk', content: 'Use `<error>boom</error> and' })).toEqual({ success: true })
    expect(recorded()).toEqual(['chunk:Use `'])

    expect(await post({ type: 'tool_start', toolCallId: 'call-1', toolName: 'bash' })).toEqual({ success: true })

    const [zip] = await zipsOfReply()
    expect(zip?.content).toBe('boom')
    expect(recorded()).toEqual([
      'chunk:Use `',
      `chunk:${replyZipDetection.getMessageReferences(SESSION, REPLY)[0]?.reference} and`,
      'tool_start'
    ])
    expect(recorded()[1]).toContain(`{{batshit-zip:${zip.id}`)
  })

  it('removes the zip it settled when the reply closed meanwhile, and refuses the tool card (BL-871 c)', async () => {
    await post({ type: 'chunk', content: 'Use `<error>boom</error> and' })
    const settle = replyZipDetection.takeHeldText.bind(replyZipDetection)
    vi.spyOn(replyZipDetection, 'takeHeldText').mockImplementation(async (sessionId, messageId) => {
      const text = await settle(sessionId, messageId)
      // The finalize of a stalled reply closes it while the settle's zip was being written.
      closeReplyRecord(SESSION, REPLY)
      return text
    })

    expect(await post({ type: 'tool_start', toolCallId: 'call-1', toolName: 'bash' })).toMatchObject({ success: false })

    expect(await zipsOfReply()).toEqual([])
    expect(replyZipDetection.getMessageReferences(SESSION, REPLY)).toEqual([])
    expect(recorded()).toEqual(['chunk:Use `'])
  })

  it('hands held words back as words when the reply ends with complete, and makes no zip', async () => {
    await post({ type: 'chunk', content: 'Use `<error>boom</error> and' })

    expect(await post({ type: 'complete', metadata: {} })).toEqual({ success: true })

    expect(await zipsOfReply()).toEqual([])
    expect(recorded()).toEqual(['chunk:Use `', 'chunk:<error>boom</error> and', 'complete'])
    expect(replyZipDetection.getMessageReferences(SESSION, REPLY)).toEqual([])
  })
})
