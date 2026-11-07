// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  LIVE_FILE_READ_OUTCOME_MAX_COPIES,
  LIVE_FILE_READ_OUTCOME_TTL_SECONDS,
  LiveFileReadOutcome,
  deleteLiveFileReadOutcomesOfAgent,
  liveFileReadOutcomeKey,
  readLiveFileReadOutcome,
  receiptCopiesOf
} from '../liveFileReadOutcome.server'
import type { LiveCopyOutcome } from '../liveFileReadTurn.server'
import { DatabaseService } from '$lib/services/databaseRedis.server'
import { LIVE_FILE_READ_FACTS_MAX_COPIES } from '$lib/utils/liveFileReadFacts'

/**
 * SA-137 P4 (D10, V3): the chat's live-file-read receipt on real Redis 8 + JSON. One writer, one
 * key per chat; reserve, prepare and issue are compare-and-set by generation under the chat's
 * owner; a newer turn wins over a late older one; an issued receipt becomes dated history at the
 * next reservation, an unsent one is dropped; nothing is shown from another app process. The Lua
 * script runs only on the real lane (`npm run test:redis`, or VITEST_USE_REAL_REDIS with a scratch
 * Redis); the fake lane has no EVAL, where every step fails soft.
 */

useRedisTestServer()

const real = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER = 'user-live-receipt'
let counter = 0

async function chat(userId = USER) {
  counter += 1
  const sessionId = `live-receipt-${counter}-${Date.now()}`
  await redis.createSession({ id: sessionId, user_id: userId, title: 'Live reads', agent_id: 'agent-a' } as any)
  return sessionId
}

function snapshot(entries: Array<[string, LiveCopyOutcome]>, compileId = 'compile-1') {
  return { compileId, copies: new Map(entries) }
}

const refreshed = (promptTokens: number): LiveCopyOutcome => ({ status: 'refreshed', text: 'x', parts: [], promptTokens })

async function raw(sessionId: string) {
  return (await redis.execute((client: any) => client.json.get(liveFileReadOutcomeKey(sessionId)))) as any
}

async function settle() {
  // noteIssued is fire-and-forget; give its one Redis call time to land.
  await new Promise((resolve) => setTimeout(resolve, 50))
}

describe.runIf(real)('the live file read receipt on real Redis', () => {
  it('reserve, prepare and issue: the pending receipt carries the outcomes, the key has a TTL', async () => {
    const sessionId = await chat()
    const turn = LiveFileReadOutcome.reserve({ userId: USER, sessionId, agentId: 'agent-a', messageId: 'reply-1' })
    await turn.prepared(snapshot([['zip-a', refreshed(120)], ['zip-b', { status: 'static', reason: 'deadline' }]]), null)
    let record = await readLiveFileReadOutcome(sessionId, USER)
    expect(record?.pending).toMatchObject({ generation: turn.generation, delivery: 'prepared', messageId: 'reply-1', compileId: 'compile-1' })
    expect(record?.pending?.copies).toEqual([
      { zipId: 'zip-a', status: 'refreshed', promptTokens: 120 },
      { zipId: 'zip-b', status: 'static', reason: 'deadline' }
    ])
    turn.noteIssued()
    await settle()
    record = await readLiveFileReadOutcome(sessionId, USER)
    expect(record?.pending?.delivery).toBe('issued')
    expect(typeof record?.pending?.issuedAt).toBe('string')
    const ttl = await redis.execute((client: any) => client.ttl(liveFileReadOutcomeKey(sessionId)))
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(LIVE_FILE_READ_OUTCOME_TTL_SECONDS)
    // No file text anywhere in the record.
    expect(JSON.stringify(await raw(sessionId))).not.toContain('"text"')
  })

  it('a newer turn wins: the older turn\'s late prepare and issue change nothing', async () => {
    const sessionId = await chat()
    const older = LiveFileReadOutcome.reserve({ userId: USER, sessionId, agentId: 'agent-a', messageId: 'reply-1' })
    const newer = LiveFileReadOutcome.reserve({ userId: USER, sessionId, agentId: 'agent-b', messageId: 'reply-2' })
    await newer.prepared(snapshot([['zip-new', refreshed(10)]], 'compile-new'), null)
    await older.prepared(snapshot([['zip-old', refreshed(10)]], 'compile-old'), null)
    older.noteIssued()
    await settle()
    const record = await readLiveFileReadOutcome(sessionId, USER)
    expect(record?.pending).toMatchObject({ generation: newer.generation, delivery: 'prepared', agentId: 'agent-b', compileId: 'compile-new' })
    expect(record?.delivered).toBeNull()
  })

  it('an issued receipt becomes dated history at the next reservation; an unsent one is dropped', async () => {
    const sessionId = await chat()
    const first = LiveFileReadOutcome.reserve({ userId: USER, sessionId, agentId: 'agent-a', messageId: 'reply-1' })
    await first.prepared(snapshot([['zip-a', refreshed(5)]]), null)
    first.noteIssued()
    await settle()
    const second = LiveFileReadOutcome.reserve({ userId: USER, sessionId, agentId: 'agent-a', messageId: 'reply-2' })
    await second.prepared(snapshot([]), null)
    let record = await readLiveFileReadOutcome(sessionId, USER)
    expect(record?.delivered).toMatchObject({ generation: first.generation, delivery: 'issued' })
    expect(record?.pending).toMatchObject({ generation: second.generation, delivery: 'prepared', copies: [] })
    // The second never reached a request: at the third reservation it is dropped, the first stays.
    const third = LiveFileReadOutcome.reserve({ userId: USER, sessionId, agentId: 'agent-a', messageId: 'reply-3' })
    await third.prepared(snapshot([]), 'replay-expired')
    record = await readLiveFileReadOutcome(sessionId, USER)
    expect(record?.delivered?.generation).toBe(first.generation)
    expect(record?.pending).toMatchObject({ generation: third.generation, replayUnavailable: 'replay-expired' })
    // An empty list stays a list (Lua's cjson would have made it an object).
    expect(Array.isArray(record?.pending?.copies)).toBe(true)
  })

  it('issue only after prepare, and once', async () => {
    const sessionId = await chat()
    const turn = LiveFileReadOutcome.reserve({ userId: USER, sessionId, agentId: 'agent-a', messageId: 'reply-1' })
    turn.noteIssued()
    await settle()
    expect((await readLiveFileReadOutcome(sessionId, USER))?.pending?.delivery).toBe('reserved')
  })

  it('writes nothing into another user\'s chat or a missing one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const theirs = await chat('someone-else')
    const intruder = LiveFileReadOutcome.reserve({ userId: USER, sessionId: theirs, agentId: 'agent-a', messageId: 'reply-1' })
    await intruder.prepared(snapshot([['zip-a', refreshed(5)]]), null)
    expect(await raw(theirs)).toBeNull()
    const missing = LiveFileReadOutcome.reserve({ userId: USER, sessionId: 'no-such-chat', agentId: 'agent-a', messageId: 'reply-1' })
    await missing.prepared(snapshot([]), null)
    expect(await raw('no-such-chat')).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('shows nothing written by another app process, another owner, or a malformed record', async () => {
    const sessionId = await chat()
    const turn = LiveFileReadOutcome.reserve({ userId: USER, sessionId, agentId: 'agent-a', messageId: 'reply-1' })
    await turn.prepared(snapshot([['zip-a', refreshed(5)]]), null)
    expect(await readLiveFileReadOutcome(sessionId, USER)).not.toBeNull()
    expect(await readLiveFileReadOutcome(sessionId, 'someone-else')).toBeNull()
    await redis.execute((client: any) => client.json.set(liveFileReadOutcomeKey(sessionId), '$.boot', 'an-earlier-process'))
    expect(await readLiveFileReadOutcome(sessionId, USER)).toBeNull()
    // A step of this process over a record of an earlier one starts over; it never trusts that one.
    const next = LiveFileReadOutcome.reserve({ userId: USER, sessionId, agentId: 'agent-a', messageId: 'reply-2' })
    await next.prepared(snapshot([]), null)
    const record = await readLiveFileReadOutcome(sessionId, USER)
    expect(record?.pending?.generation).toBe(next.generation)
    expect(record?.delivered).toBeNull()
    await redis.execute((client: any) => client.json.set(liveFileReadOutcomeKey(sessionId), '$.pending.copies', '{"not":"a list"}'))
    expect(await readLiveFileReadOutcome(sessionId, USER)).toBeNull()
  })

  it('deleting the chat, or the agent, removes its receipt; another agent\'s stays', async () => {
    const sessionId = await chat()
    const other = await chat()
    await LiveFileReadOutcome.reserve({ userId: USER, sessionId, agentId: 'agent-a', messageId: 'reply-1' }).prepared(snapshot([]), null)
    await LiveFileReadOutcome.reserve({ userId: USER, sessionId: other, agentId: 'agent-b', messageId: 'reply-1' }).prepared(snapshot([]), null)
    expect(await redis.execute((client: any) => deleteLiveFileReadOutcomesOfAgent(client, 'agent-a'))).toBe(1)
    expect(await raw(sessionId)).toBeNull()
    expect(await raw(other)).not.toBeNull()
    // Two agents in one chat: deleting one clears only its slot.
    const shared = await chat()
    const first = LiveFileReadOutcome.reserve({ userId: USER, sessionId: shared, agentId: 'agent-x', messageId: 'reply-1' })
    await first.prepared(snapshot([]), null)
    first.noteIssued()
    await settle()
    await LiveFileReadOutcome.reserve({ userId: USER, sessionId: shared, agentId: 'agent-y', messageId: 'reply-2' }).prepared(snapshot([]), null)
    expect(await redis.execute((client: any) => deleteLiveFileReadOutcomesOfAgent(client, 'agent-x'))).toBe(1)
    const left = await raw(shared)
    expect(left.delivered).toBeNull()
    expect(left.pending?.agentId).toBe('agent-y')
    await redis.deleteSession(other)
    expect(await raw(other)).toBeNull()
  })
})

describe.runIf(real)('what the zip badges are told (findSessionZipFacts, V5 server half)', () => {
  const PROJECT = '/tmp/sa137-facts-project'
  const readZipOf = (n: number) => `cool_tool_${1790000137100 + n}_rdzip`
  const editZipOf = (n: number) => `cool_tool_${1790000137100 + n}_edzip`

  async function seed(options: { liveReads: boolean }) {
    const sessionId = await chat()
    const agent = await redis.createAgent({ id: `agent-facts-${counter}`, user_id: USER, name: 'Facts', agentType: 'api', live_file_reads: options.liveReads } as any)
    await redis.execute(async (client: any) => {
      await client.json.set(`zip:${readZipOf(counter)}`, '$', {
        id: readZipOf(counter), type: 'cool_tool', tokens: 40, description: 'read_file: src/a.js - 1 lines',
        content: JSON.stringify({ toolName: 'read_file', originalToolName: 'native_bash_execute', operationKind: 'read_file', toolCallId: 'call-read',
          toolArgs: { filePath: 'src/a.js', path: 'src/a.js', innerCommand: 'cat src/a.js' }, toolResult: { filePath: 'src/a.js', content: 'old' } }),
        metadata: { toolName: 'read_file', operationKind: 'read_file', promptTokens: 40, sessionId, userId: USER }
      })
      await client.json.set(`zip:${editZipOf(counter)}`, '$', {
        id: editZipOf(counter), type: 'cool_tool', tokens: 30, description: 'edit_file: src/a.js - 2 lines',
        content: JSON.stringify({ toolName: 'edit_file', operationKind: 'edit_file',
          toolArgs: { filePath: 'src/a.js', innerCommand: "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: src/a.js\n@@\n-old\n+new\n*** End Patch\nPATCH" },
          toolResult: { filePath: 'src/a.js', diff: '-old\n+new' } }),
        metadata: { toolName: 'edit_file', operationKind: 'edit_file', promptTokens: 30, sessionId, userId: USER }
      })
    })
    const base = { session_id: sessionId, user_id: USER, timestamp: new Date().toISOString() }
    const messages = [
      { ...base, id: 'u-1', role: 'user', content: 'Read it', metadata: { projectPath: PROJECT } },
      { ...base, id: 'a-1', role: 'assistant', agent_id: agent.id, content: `Read: {{batshit-zip:${readZipOf(counter)}:::read_file: src/a.js - 1 lines}}`, metadata: { zipIds: [readZipOf(counter)] } },
      { ...base, id: 'u-2', role: 'user', content: 'Change it', metadata: { projectPath: PROJECT } },
      { ...base, id: 'a-2', role: 'assistant', agent_id: agent.id, content: `Changed: {{batshit-zip:${editZipOf(counter)}:::edit_file: src/a.js - 2 lines}}`, metadata: { zipIds: [editZipOf(counter)] } }
    ]
    await redis.execute(async (client: any) => {
      for (const message of messages) {
        await client.json.set(`message:${sessionId}:${message.id}`, '$', message)
        await client.rPush(`messages:${sessionId}`, message.id)
      }
    })
    return { sessionId, agentId: agent.id, readZip: readZipOf(counter) }
  }

  it('an edit still makes a refreshed copy stale (no exemption since 2026-11-04, D3 amended); the receipt still carries its refreshed size', async () => {
    const { sessionId, agentId, readZip } = await seed({ liveReads: true })
    const service = new DatabaseService(fetch)
    expect((await service.findSessionZipFacts(sessionId, USER)).deadCopies.get(readZip)).toBe('stale')
    const turn = LiveFileReadOutcome.reserve({ userId: USER, sessionId, agentId, messageId: 'a-2' })
    await turn.prepared(snapshot([[readZip, refreshed(17_000)]]), null)
    turn.noteIssued()
    await settle()
    const facts = await service.findSessionZipFacts(sessionId, USER)
    expect(facts.deadCopies.get(readZip)).toBe('stale')
    expect(facts.liveReads).toMatchObject({ state: 'current', replyId: 'a-2', agentId, delivery: 'issued', copies: { [readZip]: { status: 'refreshed', promptTokens: 17_000 } } })
  })

  it('a receipt of an earlier reply, or with the setting now off, is "changed": no copies, the stored copy\'s own state', async () => {
    const { sessionId, agentId, readZip } = await seed({ liveReads: true })
    const service = new DatabaseService(fetch)
    const older = LiveFileReadOutcome.reserve({ userId: USER, sessionId, agentId, messageId: 'a-1' })
    await older.prepared(snapshot([[readZip, refreshed(10)]]), null)
    let facts = await service.findSessionZipFacts(sessionId, USER)
    // The agent has live reads on and no record names its newest reply: unknown, never a guess.
    expect(facts.liveReads).toMatchObject({ state: 'unknown', replyId: 'a-2', unknownReason: 'missing' })
    expect(facts.deadCopies.get(readZip)).toBe('stale')

    const newest = LiveFileReadOutcome.reserve({ userId: USER, sessionId, agentId, messageId: 'a-2' })
    await newest.prepared(snapshot([[readZip, refreshed(10)]]), null)
    expect((await service.findSessionZipFacts(sessionId, USER)).liveReads?.state).toBe('current')
    await redis.execute((client: any) => client.json.set(`agent:${agentId}`, '$.live_file_reads', false))
    facts = await service.findSessionZipFacts(sessionId, USER)
    expect(facts.liveReads).toMatchObject({ state: 'changed', replyId: 'a-2', copies: {} })
    expect(facts.deadCopies.get(readZip)).toBe('stale')
  })

  it('unknown when the newest reply has no usable record: missing, or unreadable; its live-capable reads say so', async () => {
    const { sessionId, agentId, readZip } = await seed({ liveReads: true })
    await redis.execute((client: any) => client.json.set(`zip:${readZip}`, '$.metadata.fileReadSource', {
      version: 1, owner: { userId: USER, agentId, sessionId, messageId: 'a-1', toolCallId: 'call-read' }, backend: 'local',
      workspaceRoot: PROJECT, rootIdentity: '1:2', cwd: PROJECT, locator: 'src/a.js', view: { kind: 'whole', numbering: 'none' }, liveReadsOn: true
    }))
    const service = new DatabaseService(fetch)
    let facts = await service.findSessionZipFacts(sessionId, USER)
    expect(facts.liveReads).toEqual({ state: 'unknown', replyId: 'a-2', agentId, unknownReason: 'missing', copies: { [readZip]: { status: 'unknown' } }, overflow: 0 })
    // A record of another type (a read error) is unreadable: still unknown, never the OFF answer or a 500.
    await redis.execute((client: any) => client.set(liveFileReadOutcomeKey(sessionId), 'not json'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    facts = await service.findSessionZipFacts(sessionId, USER)
    warn.mockRestore()
    expect(facts.liveReads).toMatchObject({ state: 'unknown', unknownReason: 'unreadable' })
    expect(facts.deadCopies.get(readZip)).toBe('stale')
  })

  it('a receipt is current only for the chat\'s newest reply: another agent replying last makes it changed', async () => {
    const { sessionId, agentId, readZip } = await seed({ liveReads: true })
    const turn = LiveFileReadOutcome.reserve({ userId: USER, sessionId, agentId, messageId: 'a-2' })
    await turn.prepared(snapshot([[readZip, refreshed(10)]]), null)
    const service = new DatabaseService(fetch)
    expect((await service.findSessionZipFacts(sessionId, USER)).liveReads?.state).toBe('current')
    // Another agent (live reads off) replies last; its compile never refreshes this agent's read.
    const other = await redis.createAgent({ id: `agent-other-${counter}`, user_id: USER, name: 'Other', agentType: 'api' } as any)
    await redis.execute(async (client: any) => {
      await client.json.set(`message:${sessionId}:b-1`, '$', { session_id: sessionId, user_id: USER, timestamp: new Date().toISOString(), id: 'b-1', role: 'assistant', agent_id: other.id, content: 'hello', metadata: {} })
      await client.rPush(`messages:${sessionId}`, 'b-1')
    })
    const facts = await service.findSessionZipFacts(sessionId, USER)
    expect(facts.liveReads).toMatchObject({ state: 'changed', replyId: 'a-2', copies: {} })
    expect(facts.deadCopies.get(readZip)).toBe('stale')
  })

  it('no receipt, no live facts: the route reports null and the dead copies as before', async () => {
    const { sessionId, readZip } = await seed({ liveReads: false })
    const facts = await new DatabaseService(fetch).findSessionZipFacts(sessionId, USER)
    expect(facts.liveReads).toBeNull()
    expect(facts.deadCopies.get(readZip)).toBe('stale')
  })
})

describe('badge facts for a chat with more live-capable reads than the facts hold (default lane, no receipt)', () => {
  it('names the NEWEST 512 Read File copies unknown, not the oldest (review H)', async () => {
    const sessionId = await chat()
    const agent = await redis.createAgent({
      id: `agent-bound-${counter}`, user_id: USER, name: 'Bound', agentType: 'api', live_file_reads: true,
      provider_specific_settings: { nativeTools: { executionBackend: 'local' } }
    } as any)
    const total = LIVE_FILE_READ_FACTS_MAX_COPIES + 8
    const zipOf = (n: number) => `cool_tool_${1790000200000 + n}_bound`
    for (let n = 0; n < total; n += 1) {
      await redis.json.set(`zip:${zipOf(n)}`, '$', {
        id: zipOf(n), type: 'cool_tool', tokens: 20, description: `read_file: src/f${n}.js - 1 lines`,
        content: JSON.stringify({ toolName: 'read_file', originalToolName: 'native_bash_execute', operationKind: 'read_file', toolCallId: `call-${n}`,
          toolArgs: { filePath: `src/f${n}.js`, path: `src/f${n}.js`, innerCommand: `cat src/f${n}.js` }, toolResult: { filePath: `src/f${n}.js`, content: 'x' } }),
        metadata: { toolName: 'read_file', operationKind: 'read_file', promptTokens: 20, sessionId, userId: USER }
      })
    }
    const base = { session_id: sessionId, user_id: USER, timestamp: new Date().toISOString() }
    // Ten replies of 52 reads each, oldest first; the newest reply is the last.
    const perReply = 52
    for (let reply = 0; reply * perReply < total; reply += 1) {
      const ids = Array.from({ length: perReply }, (_, index) => reply * perReply + index).filter((n) => n < total).map(zipOf)
      const message = {
        ...base, id: `a-${reply}`, role: 'assistant', agent_id: agent.id,
        content: ids.map((id) => `Read: {{batshit-zip:${id}:::read_file: ${id} - 1 lines}}`).join('\n'),
        metadata: { zipIds: ids }
      }
      await redis.json.set(`message:${sessionId}:${message.id}`, '$', message)
      await redis.rPush(`messages:${sessionId}`, message.id)
    }
    const facts = (await new DatabaseService(fetch).findSessionZipFacts(sessionId, USER)).liveReads
    expect(facts).toMatchObject({ state: 'unknown', unknownReason: 'missing', agentId: agent.id })
    const named = Object.keys(facts!.copies)
    expect(named).toHaveLength(LIVE_FILE_READ_FACTS_MAX_COPIES)
    // The newest kept, the oldest eight dropped.
    expect(named).toContain(zipOf(total - 1))
    expect(named).toContain(zipOf(8))
    for (let n = 0; n < 8; n += 1) expect(named, zipOf(n)).not.toContain(zipOf(n))
  })
})

describe('receipt bounds (no Redis)', () => {
  it('keeps at most 512 copies and counts the rest as overflow', () => {
    const entries: Array<[string, LiveCopyOutcome]> = Array.from({ length: LIVE_FILE_READ_OUTCOME_MAX_COPIES + 9 }, (_, index) => [`cool_tool_${index}_abcd`, refreshed(index)])
    const { copies, overflow } = receiptCopiesOf({ copies: new Map(entries) })
    expect(copies).toHaveLength(LIVE_FILE_READ_OUTCOME_MAX_COPIES)
    expect(overflow).toBe(9)
  })

  it('stops at the byte bound before the count bound for long ids and reasons', () => {
    const entries: Array<[string, LiveCopyOutcome]> = Array.from({ length: 400 }, (_, index) => [`${'z'.repeat(200)}_${index}`, { status: 'static', reason: 'reader-unavailable' }])
    const { copies, overflow } = receiptCopiesOf({ copies: new Map(entries) })
    expect(copies.length + overflow).toBe(400)
    expect(overflow).toBeGreaterThan(0)
    expect(Buffer.byteLength(JSON.stringify(copies))).toBeLessThanOrEqual(56 * 1024)
  })

  it.skipIf(real)('fails soft on the fake lane (no EVAL): a turn is never stopped by its receipt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const turn = LiveFileReadOutcome.reserve({ userId: USER, sessionId: 'any', agentId: 'agent-a', messageId: 'reply-1' })
    await expect(turn.prepared(snapshot([]), null)).resolves.toBeUndefined()
    expect(() => turn.noteIssued()).not.toThrow()
    await settle()
    warn.mockRestore()
  })
})
