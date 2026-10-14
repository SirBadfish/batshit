// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { recordSkippedGroupUserReply } from '../groupReplySkipped'
import { buildGroupSpeakerRequest, decideGroupSpeaker, type GroupSpeakerOutcome } from '../groupSpeaker.jev'
import { executionViewerService } from '../executionViewerService'

useRedisTestServer()
const REAL_REDIS = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER = 'p3-receipt-owner'
let sessionId = ''
let counter = 0

function input() {
  const request = buildGroupSpeakerRequest({ eventType: 'user', message: 'Thanks, that settles it.',
    spokeLast: 'the user', earlierThisTurn: [], candidates: [{ agentId: 'a', name: 'A', preset: 'smart', about: null }] })!
  const decision = decideGroupSpeaker({
    speaker: { type: 'choice', choice: 'nobody', probabilities: { nobody: 0.93, a: 0.07 }, confidence: 0.9 },
    needs_reply: { type: 'noul', noul: 0.07 }, adds_value_a: { type: 'noul', noul: 0.1 }
  }, request)
  const outcome: GroupSpeakerOutcome = { decision, note: null, record: { feature: 'group_speaker',
    model: 'synthetic', status: 'ok', latencyMs: 1, usage: null, deadlineHit: false,
    questionCount: 3, at: '2026-10-11T05:00:00Z', decision: decision.summary } }
  return { userId: USER, sessionId, messageId: 'u1', content: request.state.message, groupTurnId: 'round1', eventIndex: 1, outcome }
}

afterEach(() => vi.restoreAllMocks())

it('does not invent a saved user-message id for a request-only turn', async () => {
  const snapshot = vi.spyOn(executionViewerService, 'recordSnapshot')
  expect(await recordSkippedGroupUserReply({ ...input(), messageId: null })).toEqual({ outcome: 'refused', evidenceRecorded: false })
  expect(snapshot).not.toHaveBeenCalled()
})

// The default lane has no Lua twin for this script. Do not add shared mock infrastructure or
// claim the real saved-data boundary from a fake. These cases run only on the explicitly owned isolated Redis+JSON lane.
describe.runIf(REAL_REDIS)('group no-reply receipt on real RedisJSON', () => {
  beforeEach(async () => {
    sessionId = `p3-receipt-${++counter}`
    await redis.createSession({ id: sessionId, user_id: USER, agent_id: 'a', title: 'Synthetic P3 receipt' } as any)
    await redis.saveMessage({ id: 'u1', session_id: sessionId, user_id: USER, agent_id: 'a', role: 'user',
      content: 'Thanks, that settles it.', metadata: { sibling: 'preserve' } } as any)
  })

  const saved = () => redis.execute((client) => client.json.get(`message:${sessionId}:u1`)) as Promise<any>

  it('stores only its metadata path plus a no-run EV entry, keeping content, timestamp, siblings and list identity', async () => {
    const before = await saved()
    expect(await recordSkippedGroupUserReply(input())).toEqual({ outcome: 'skipped', evidenceRecorded: true })
    const after = await saved()
    expect(after).toMatchObject({ content: before.content, created_at: before.created_at, metadata: { sibling: 'preserve',
      groupReplySkipped: { source: 'jev', messageId: 'u1', groupTurnId: 'round1', eventIndex: 1 } } })
    expect(await redis.execute((client) => client.lRange(`messages:${sessionId}`, 0, -1))).toEqual(['u1'])
    const entries = await executionViewerService.getSnapshots(sessionId)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: after.metadata.groupReplySkipped.snapshotId, agentId: null, agentType: 'group_speaker',
      structuredInput: null, executionMetadata: { typesafeCalls: [{ usage: null }], groupChat: { noReplyReceipt: 'saved', speakerSelection: { reason: 'no_reply' } } } })
    expect(entries[0].runtime).toBeUndefined()
  })

  it.each([
    ['another owner', { user_id: 'other' }], ['assistant record', { role: 'assistant' }],
    ['wrong id', { id: 'other' }], ['wrong session', { session_id: 'other' }], ['edited text', { content: 'Please answer instead.' }]
  ])('refuses %s without changing messages or creating EV evidence', async (_name, patch) => {
    const before = await saved()
    await redis.execute((client) => client.json.set(`message:${sessionId}:u1`, '$', { ...before, ...patch }))
    expect(await recordSkippedGroupUserReply(input())).toEqual({ outcome: 'refused', evidenceRecorded: false })
    expect((await saved()).metadata.groupReplySkipped).toBeUndefined()
    expect(await executionViewerService.getSnapshots(sessionId)).toEqual([])
  })

  it('refuses another owner’s session even if a corrupt message claims this owner', async () => {
    await redis.execute((client) => client.json.set(`session:${sessionId}`, '$.user_id', 'other'))
    expect(await recordSkippedGroupUserReply(input())).toEqual({ outcome: 'refused', evidenceRecorded: false })
    expect(await executionViewerService.getSnapshots(sessionId)).toEqual([])
  })

  it.each(['edit', 'delete', 'remove_list_id', 'stop'] as const)('rechecks after EV creation: %s cannot be stamped as a skip', async (change) => {
    const controller = new AbortController()
    const original = executionViewerService.recordSnapshot.bind(executionViewerService)
    vi.spyOn(executionViewerService, 'recordSnapshot').mockImplementation(async (snapshot) => {
      await original(snapshot)
      if (change === 'stop') controller.abort()
      else await redis.execute(async (client) => {
        if (change === 'edit') await client.json.set(`message:${sessionId}:u1`, '$.content', 'New question?')
        if (change === 'delete') await client.del(`message:${sessionId}:u1`)
        if (change === 'remove_list_id') await client.lRem(`messages:${sessionId}`, 0, 'u1')
      })
    })
    expect(await recordSkippedGroupUserReply({ ...input(), signal: controller.signal })).toEqual({ outcome: change === 'stop' ? 'stopped' : 'refused', evidenceRecorded: true })
    expect((await saved())?.metadata.groupReplySkipped).toBeUndefined()
    const entries = await executionViewerService.getSnapshots(sessionId)
    expect(entries[0].executionMetadata?.groupChat).toMatchObject({ noReplyReceipt: change === 'stop' ? 'stopped' : 'refused' })
    expect(entries[0].executionMetadata?.groupChat.speakerSelection).toBeUndefined()
    expect(entries[0].executionMetadata?.typesafeCalls[0].status).toBe('ok')
  })

  it('runs no skip when the first EV write fails', async () => {
    vi.spyOn(executionViewerService, 'recordSnapshot').mockRejectedValue(new Error('synthetic failure'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await recordSkippedGroupUserReply(input())).toEqual({ outcome: 'refused', evidenceRecorded: false })
    expect((await saved()).metadata.groupReplySkipped).toBeUndefined()
  })

  it('does not start a reply or erase a saved mark after the EV outcome update fails; the call entry stays honestly pending', async () => {
    vi.spyOn(executionViewerService, 'updateSnapshot').mockRejectedValue(new Error('synthetic outcome failure'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await recordSkippedGroupUserReply(input())).toEqual({ outcome: 'skipped', evidenceRecorded: true })
    expect((await saved()).metadata.groupReplySkipped).toMatchObject({ messageId: 'u1' })
    const entries = await executionViewerService.getSnapshots(sessionId)
    expect(entries[0].executionMetadata?.groupChat).toMatchObject({ noReplyReceipt: 'pending' })
    expect(entries[0].executionMetadata?.groupChat.speakerSelection).toBeUndefined()
    expect(entries[0].executionMetadata?.typesafeCalls[0].decision).toContain('no reply proposed')
  })

  it('confirms the exact mark when the real eval applies but its response is lost', async () => {
    const client: any = await redis.execute((connected) => Promise.resolve(connected))
    const withOptions = client.withCommandOptions.bind(client)
    const errorDetails = (error: unknown) => error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { name: 'NonError', message: String(error), stack: null }
    const diagnosticErrors: Array<{ stage: string; error: ReturnType<typeof errorDetails> }> = []
    const evals: Array<{ attempt: number; expectedMarkArgument?: unknown; expectedMark?: unknown;
      returnReceived: boolean; returnedValue?: unknown; error?: ReturnType<typeof errorDetails> }> = []
    let attempts = 0
    let completedEvals = 0
    let mutations = 0
    vi.spyOn(client, 'withCommandOptions').mockImplementation((options: any) => {
      const configured = withOptions(options)
      const evalCommand = configured.eval.bind(configured)
      configured.eval = async (...args: any[]) => {
        const observed: typeof evals[number] = { attempt: ++attempts, returnReceived: false }
        evals.push(observed)
        try {
          observed.expectedMarkArgument = args[1]?.arguments?.[4]
          observed.expectedMark = JSON.parse(observed.expectedMarkArgument as string)
        } catch (error) {
          diagnosticErrors.push({ stage: 'expected mark from actual EVAL arguments', error: errorDetails(error) })
        }
        try {
          observed.returnedValue = await evalCommand(...args)
          observed.returnReceived = true
          completedEvals += 1
          // This real Lua script returns 1 only after writing the mark; an attempt is not a mutation.
          if (observed.returnedValue === 1) mutations += 1
        } catch (error) {
          observed.error = errorDetails(error)
          throw error
        }
        throw new Error('synthetic response loss after the actual mutation')
      }
      return configured
    })
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let result: Awaited<ReturnType<typeof recordSkippedGroupUserReply>> | undefined
    let operationFailed = false
    let operationError: unknown
    try {
      result = await recordSkippedGroupUserReply(input())
    } catch (error) {
      operationFailed = true
      operationError = error
    }
    const productionWarnings = warnings.mock.calls.slice()
    // Read through the original configured client on this same owned DB. These bounded,
    // read-only observations must not replace a production error or the original assertion.
    const diagnosticRead = async (key: string): Promise<{ ok: true; value: any } | { ok: false }> => {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const value = await Promise.race([
          withOptions({ timeout: 1000, abortSignal: controller.signal }).json.get(key),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error('Diagnostic read deadline')) }, 1000)
          })
        ])
        return { ok: true, value }
      } catch (error) {
        diagnosticErrors.push({ stage: `diagnostic JSON.GET ${key}`, error: errorDetails(error) })
        return { ok: false }
      } finally {
        clearTimeout(timer)
        controller.abort()
      }
    }
    const [messageRead, evRead] = await Promise.all([
      diagnosticRead(`message:${sessionId}:u1`),
      diagnosticRead(`session:${sessionId}:execution_log`)
    ])
    const actual = messageRead.ok ? messageRead.value : null
    const ev = evRead.ok ? evRead.value : null
    try {
      console.info('[BL1299 synthetic real-Redis receipt diagnostic]', JSON.stringify({
        attempts, completedEvals, mutations, evals, result,
        operationError: operationFailed ? errorDetails(operationError) : null,
        messageReadOk: messageRead.ok,
        actualSavedIdentity: actual ? { id: actual.id, user_id: actual.user_id, session_id: actual.session_id,
          role: actual.role, content: actual.content } : null,
        actualSavedMark: actual?.metadata?.groupReplySkipped ?? null,
        evReadOk: evRead.ok,
        evStatus: Array.isArray(ev) ? ev.map((entry: any) => ({ id: entry.id,
          groupChat: entry.executionMetadata?.groupChat,
          typesafeCalls: entry.executionMetadata?.typesafeCalls?.map((call: any) => ({ status: call.status, decision: call.decision })) })) : ev,
        productionWarnings, diagnosticErrors
      }, (_key, value) => value instanceof Error ? errorDetails(value) : value))
    } catch (error) {
      // Even malformed diagnostic data must leave the original failure authoritative.
      console.info('[BL1299 diagnostic output unavailable]', errorDetails(error))
    }
    if (operationFailed) throw operationError
    expect(result).toEqual({ outcome: 'skipped', evidenceRecorded: true })
    expect(attempts).toBe(1)
    expect(mutations).toBe(1)
    const mark = (await saved()).metadata.groupReplySkipped
    const entries = await executionViewerService.getSnapshots(sessionId)
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe(mark.snapshotId)
    expect(entries[0].executionMetadata?.groupChat).toMatchObject({ noReplyReceipt: 'saved' })
  })

  it('binds the real save/send normalization without changing the stored user words', async () => {
    await redis.saveMessage({ id: 'u1', session_id: sessionId, user_id: USER, agent_id: 'a', role: 'user',
      content: '  Thanks,\n\n\n\nthat settles it.  ', metadata: { sibling: 'preserve' } } as any)
    const before = await saved()
    const sent = input()
    sent.content = 'Thanks,\n\nthat settles it.'
    expect(await recordSkippedGroupUserReply(sent)).toEqual({ outcome: 'skipped', evidenceRecorded: true })
    expect((await saved()).content).toBe(before.content)
    expect((await saved()).metadata.sibling).toBe('preserve')
  })
})

// Synthetic interaction proof for mutation uncertainty; these fakes do not claim to prove Lua.
describe('lost mutation reply reconciliation', () => {
  it.each(['applied', 'absent', 'read_failed', 'read_timeout', 'write_timeout', 'unexpected_reply'] as const)('%s preserves an honest no-run outcome', async (mode) => {
    sessionId = 'fake-outcome'
    const saved: any = { id: 'u1', role: 'user', user_id: USER, session_id: sessionId, content: input().content, metadata: {} }
    let readingAfterMutation = false
    let reconciliations = 0
    let applyLateWrite: (() => void) | undefined
    const client: any = {
      json: { get: vi.fn(async (key: string) => {
        if (readingAfterMutation) {
          reconciliations += 1
          if (mode === 'read_failed') throw new Error('synthetic read failure')
          if (mode === 'read_timeout') return new Promise(() => {})
        }
        return key.startsWith('session:') ? { user_id: USER } : saved
      }) },
      eval: vi.fn(async (_script: string, options: any) => {
        readingAfterMutation = true
        if (mode === 'applied') saved.metadata.groupReplySkipped = JSON.parse(options.arguments[4])
        if (mode === 'write_timeout') return new Promise((resolve) => {
          applyLateWrite = () => { saved.metadata.groupReplySkipped = JSON.parse(options.arguments[4]); resolve(1) }
        })
        if (mode === 'unexpected_reply') return undefined
        throw new Error('synthetic lost reply; mutation may have applied')
      })
    }
    client.withCommandOptions = vi.fn(() => client)
    vi.spyOn(redis, 'execute').mockImplementation((fn: any) => fn(client))
    vi.spyOn(executionViewerService, 'recordSnapshot').mockResolvedValue(undefined)
    const patch = vi.spyOn(executionViewerService, 'updateSnapshot').mockResolvedValue(undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await recordSkippedGroupUserReply(input())
    expect(result).toEqual({ outcome: mode === 'applied' ? 'skipped' : 'unconfirmed', evidenceRecorded: true })
    expect(client.eval).toHaveBeenCalledTimes(1)
    expect(client.withCommandOptions).toHaveBeenCalledWith(expect.objectContaining({ timeout: 1000 }))
    expect(reconciliations).toBe(mode === 'unexpected_reply' ? 0 : 1)
    const meta: any = patch.mock.calls.at(-1)?.[2]?.executionMetadata
    expect(meta.typesafeCalls[0].status).toBe('ok')
    expect(meta.groupChat.noReplyReceipt).toBe(mode === 'applied' ? 'saved' : 'unconfirmed')
    if (mode !== 'applied') expect(meta.groupChat.speakerSelection).toBeUndefined()
    if (mode === 'applied') {
      // The real RedisJSON receipt above observed this exact pair. Keep invalid and
      // meaningfully changed receipts unconfirmed, even after the same successful write.
      const readings: Array<{ label: string; storedConfidence: unknown; expectedConfidence?: number;
        snapshotId?: string; confirmed: boolean }> = [
        { label: 'observed decimal round trip', storedConfidence: 0.93, confirmed: true },
        { label: 'genuinely different probability', storedConfidence: 0.91, confirmed: false },
        { label: 'larger than one representation step', storedConfidence: 0.9300000000000002, confirmed: false },
        { label: 'NaN', storedConfidence: NaN, confirmed: false },
        { label: 'infinity', storedConfidence: Infinity, confirmed: false },
        { label: 'string probability', storedConfidence: '0.93', confirmed: false },
        { label: 'floor crossing', expectedConfidence: 0.5000000000000001, storedConfidence: 0.5, confirmed: false },
        { label: 'above probability range', storedConfidence: 1.01, confirmed: false },
        { label: 'another snapshot with equivalent confidence', storedConfidence: 0.93, snapshotId: 'foreign-snapshot', confirmed: false }
      ]
      for (const reading of readings) {
        readingAfterMutation = false
        reconciliations = 0
        saved.metadata = {}
        client.eval.mockClear().mockImplementation(async (_script: string, options: any) => {
          readingAfterMutation = true
          saved.metadata.groupReplySkipped = { ...JSON.parse(options.arguments[4]), confidence: reading.storedConfidence,
            ...(reading.snapshotId ? { snapshotId: reading.snapshotId } : {}) }
          throw new Error('synthetic lost reply after the observed receipt was stored')
        })
        patch.mockClear()
        const sent = input()
        if (reading.expectedConfidence !== undefined) sent.outcome.decision!.noReplyConfidence = reading.expectedConfidence
        expect(await recordSkippedGroupUserReply(sent), reading.label).toEqual({
          outcome: reading.confirmed ? 'skipped' : 'unconfirmed', evidenceRecorded: true
        })
        expect(client.eval, reading.label).toHaveBeenCalledTimes(1)
        expect(reconciliations, reading.label).toBe(1)
        expect(patch, reading.label).toHaveBeenCalledTimes(1)
        const updated: any = patch.mock.calls[0][2].executionMetadata
        expect(updated.typesafeCalls[0].status, reading.label).toBe('ok')
        expect(updated.groupChat.noReplyReceipt, reading.label).toBe(reading.confirmed ? 'saved' : 'unconfirmed')
        if (!reading.confirmed) expect(updated.groupChat.speakerSelection, reading.label).toBeUndefined()
      }
    }
    if (applyLateWrite) {
      // A command already sent before disconnect may apply after our bounded observation.
      // The terminal result stays unconfirmed; it never re-enters the scheduler or patches
      // a newer turn through a late promise continuation.
      applyLateWrite()
      await Promise.resolve()
      await Promise.resolve()
      expect(result.outcome).toBe('unconfirmed')
      expect(saved.metadata.groupReplySkipped.snapshotId).toBeTruthy()
      expect(patch).toHaveBeenCalledTimes(1)
      expect(client.eval).toHaveBeenCalledTimes(1)
    }
  })

  it('bounds a disconnected EV patch after a confirmed mark without undoing the skip', async () => {
    sessionId = 'fake-saved-patch-timeout'
    const saved: any = { id: 'u1', role: 'user', user_id: USER, session_id: sessionId, content: input().content, metadata: {} }
    const client: any = {
      json: { get: async (key: string) => key.startsWith('session:') ? { user_id: USER } : saved },
      eval: vi.fn(async (_script: string, options: any) => { saved.metadata.groupReplySkipped = JSON.parse(options.arguments[4]); return 1 })
    }
    client.withCommandOptions = () => client
    vi.spyOn(redis, 'execute').mockImplementation((fn: any) => fn(client))
    const initial = vi.spyOn(executionViewerService, 'recordSnapshot').mockResolvedValue(undefined)
    const patch = vi.spyOn(executionViewerService, 'updateSnapshot').mockImplementation(() => new Promise(() => {}))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await recordSkippedGroupUserReply(input())).toEqual({ outcome: 'skipped', evidenceRecorded: true })
    expect(saved.metadata.groupReplySkipped.snapshotId).toBeTruthy()
    expect(initial.mock.calls[0][0].executionMetadata?.groupChat).toMatchObject({ noReplyReceipt: 'pending' })
    expect(patch).toHaveBeenCalledTimes(1)
    expect(client.eval).toHaveBeenCalledTimes(1)
  })
})
