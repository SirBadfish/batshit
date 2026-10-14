import { describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  composeInPlaceResumeMessage,
  continueResumedSnapshotPatch,
  createApprovalResumeStart,
  hasUserTurnContent,
  isInPlaceApprovalResume,
  joinResumedContent,
  mergeResumedMetadata,
  mergeResumedPerformance,
  mergeResumedReasoning,
  mergeResumedSteps,
  mergeResumedUsage,
  readStoredAssistantRecord,
  resolveFailedTurnContent,
  withPriorTypesafeCalls,
  readObservedUsage
} from '../approvalResumeMessage'
import { executionViewerService } from '../executionViewerService'
import { buildDelegatedExecutionSummary } from '../delegatedRunAccounting'
import { buildTokenStat, buildTokenUsage } from '../executionViewerLlmCapture'
import { summarizeRunningCost } from '$lib/utils/tokenPanel'

describe('returned Codex child observations through frozen-prefix resume', () => {
  it('retains the child once beside known siblings without changing parent usage or filling child totals', () => {
    const observedUsage = { completeness: 'partial', parts: [{ source: 'codex-app-server-progress', counts: { outputTokens: 0 } }] }
    const child = buildDelegatedExecutionSummary([{ toolCallId: 'prior-child', toolOutput: { kind: 'subagent', status: 'failed', usage: null, observedUsage } }])
    const known = buildDelegatedExecutionSummary([{ toolCallId: 'next-child', toolOutput: { kind: 'subagent', status: 'completed', usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 } } }])
    const frozen = { usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }, delegated: child }
    const resumed = { usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55 }, delegated: known }
    const joined = mergeResumedMetadata(frozen, resumed)
    expect(mergeResumedMetadata(frozen, resumed)).toEqual(joined)
    expect(joined.usage).toMatchObject({ inputTokens: 150, outputTokens: 15, totalTokens: 165 })
    expect(joined.delegated.runs).toHaveLength(2)
    expect(joined.delegated.runs[0]).toMatchObject({ usage: null, observedUsage })
    expect(joined.delegated.totals).toMatchObject({ usageKnownRuns: 1, usageUnknownRuns: 1, usage: { totalTokens: 22 } })
    expect(frozen.delegated?.runs).toHaveLength(1)
  })
})
import type { ExecutionSnapshot } from '$lib/types/executionViewer'
import type { SavedModel } from '$lib/types/savedModels'

/**
 * An API-lane approval resume writes into the message the card was ON, and its stream starts
 * empty. Measured live on 2026-09-18 (`_local/approval-resume-proof/words-before-card*.json`):
 * "Checking with the shell now." before the card became
 * `{{batshit-zip:…bash: expr 8675309 + 1…}}**8675310**` after the click — the words were gone,
 * on the old code as well as the new. These pin the rule that fixes it: what a resume writes
 * is APPENDED to what the message held.
 *
 * Real RedisJSON under `npm run test:redis`, the in-memory fake under plain `npm test`.
 */

useRedisTestServer()

describe('BL-1361: observed portions stay separate through a frozen-prefix resume', () => {
  const known = { inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedInputTokens: 20, cacheCreationInputTokens: 30 }
  const partial = { completeness: 'partial' as const, parts: [{ source: 'codex-app-server-progress' as const, counts: { inputTokens: 50, outputTokens: 5, totalTokens: 55, cacheCreationInputTokens: 0 } }] }
  const prior = { usage: known }

  it('retains each portion once, explicitly clears canonical usage, and carries it on the next start', () => {
    const own = { usage: null, observedUsage: partial }
    const merged = mergeResumedMetadata(prior, own)
    expect(merged.usage).toBeNull()
    expect(merged.observedUsage).toEqual({ completeness: 'partial', parts: [{ source: 'run-usage-prefix', counts: known }, ...partial.parts] })
    expect(mergeResumedMetadata(prior, own)).toEqual(merged)
    expect(createApprovalResumeStart({ metadata: merged }).prior.metadata.observedUsage).toEqual(merged.observedUsage)
    const third = mergeResumedMetadata(merged, { usage: { inputTokens: 7, outputTokens: 0, totalTokens: 7 } })
    expect(third.usage).toBeNull()
    expect(third.observedUsage.parts).toEqual([...merged.observedUsage.parts, { source: 'run-usage-prefix', counts: { inputTokens: 7, outputTokens: 0, totalTokens: 7 } }])
  })

  it('a new half with no observation still clears the old canonical total and retains its known prefix', () => {
    const merged = mergeResumedMetadata(prior, {})
    expect(Object.prototype.hasOwnProperty.call(merged, 'usage')).toBe(true)
    expect(merged.usage).toBeNull()
    expect(merged.observedUsage.parts).toEqual([{ source: 'run-usage-prefix', counts: known }])
    // Model the real shallow merge: the old total must not survive omission.
    expect({ ...prior, ...merged }.usage).toBeNull()
  })

  it('keeps a zero or a cache-only observation without inventing any other member', () => {
    const observed = { completeness: 'partial', parts: [{ source: 'codex-app-server-progress', counts: { cacheCreationInputTokens: 0 } }] }
    expect(readObservedUsage(observed)).toEqual(observed)
    const merged = mergeResumedMetadata({ observedUsage: observed, usage: null }, { usage: null })
    expect(merged.observedUsage).toEqual(observed)
    expect(merged.observedUsage.parts[0].counts.inputTokens).toBeUndefined()
    expect(merged.usage).toBeNull()
  })

  it('keeps response and LLM canonical totals unknown even when other saved parts reported numbers', () => {
    const before: any = {
      responseSummary: { content: { value: 'Before', confidence: 'exact' }, usage: buildTokenUsage(known, 'exact'), toolCallsCount: buildTokenStat(0, 'exact') },
      llmSummary: { callsCount: buildTokenStat(1, 'speculative'), totalUsage: buildTokenUsage(known, 'exact'), breakdownConfidence: 'speculative' },
    }
    const own: any = {
      responseSummary: { content: { value: '', confidence: 'exact' }, usage: buildTokenUsage(null, 'estimated'), toolCallsCount: buildTokenStat(null, 'estimated'), observedUsage: partial },
      llmSummary: { callsCount: buildTokenStat(1, 'speculative'), totalUsage: buildTokenUsage(null, 'estimated'), breakdownConfidence: 'speculative' },
    }
    const merged = continueResumedSnapshotPatch(before, own)
    expect(merged.responseSummary?.usage.inputTokens.value).toBeNull()
    expect(merged.responseSummary?.usage.totalTokens.value).toBeNull()
    expect(merged.llmSummary?.totalUsage.totalTokens.value).toBeNull()
    expect(merged.responseSummary?.observedUsage?.parts).toEqual([{ source: 'run-usage-prefix', counts: known }, ...partial.parts])
    expect(continueResumedSnapshotPatch(before, own)).toEqual(merged)
    const absent = continueResumedSnapshotPatch(before, { ...own, responseSummary: { ...own.responseSummary, observedUsage: undefined } })
    expect(absent.responseSummary?.usage.totalTokens.value).toBeNull()
    expect(absent.llmSummary?.totalUsage.totalTokens.value).toBeNull()
    expect(absent.responseSummary?.observedUsage?.parts).toEqual([{ source: 'run-usage-prefix', counts: known }])
  })

  it('does not change the successful known-half sum or add an observation ledger to it', () => {
    const merged = mergeResumedMetadata(prior, { usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55 } })
    expect(merged.usage).toEqual({ inputTokens: 150, outputTokens: 15, totalTokens: 165 })
    expect(merged.observedUsage).toBeUndefined()
  })

  it('refuses malformed portions rather than silently trimming stored evidence', () => {
    expect(() => readObservedUsage({ completeness: 'partial', parts: [...partial.parts, { source: 'invented', counts: known }] })).toThrow('unknown source')
    expect(() => readObservedUsage({ completeness: 'partial', parts: [] })).toThrow('no portions')
  })
})

const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER = 'user-approval-resume'
const SESSION = 'session-approval-resume'
const MESSAGE = 'msg_card'
const EARLIER_ZIP = 'cool_tool_1789712000000_early'
const RESUMED_ZIP = 'cool_tool_1789712566257_rp4al'
const earlierRef = `{{batshit-zip:${EARLIER_ZIP}:::bash: ls - exit 0 - 3 lines}}`
const resumedRef = `{{batshit-zip:${RESUMED_ZIP}:::bash: expr 8675309 + 1 - exit 0 - 1 line}}`

describe('joinResumedContent', () => {
  it('keeps the words before the card and puts the resumed reply after a blank line', () => {
    expect(joinResumedContent('Checking with the shell now.', `${resumedRef}**8675310**`)).toBe(
      `Checking with the shell now.\n\n${resumedRef}**8675310**`
    )
  })

  it('keeps an earlier tool card too', () => {
    expect(joinResumedContent(`Looking first.\n\n${earlierRef}\n\nNow the sum.`, `${resumedRef}8675310`)).toBe(
      `Looking first.\n\n${earlierRef}\n\nNow the sum.\n\n${resumedRef}8675310`
    )
  })

  it('changes nothing when the card had no words before it', () => {
    expect(joinResumedContent('', `${resumedRef}8675310`)).toBe(`${resumedRef}8675310`)
    expect(joinResumedContent(undefined, `${resumedRef}8675310`)).toBe(`${resumedRef}8675310`)
  })

  it('keeps the words when the resume produced nothing', () => {
    expect(joinResumedContent('Checking with the shell now.', '')).toBe('Checking with the shell now.')
    expect(joinResumedContent('Checking with the shell now.', '  \n')).toBe('Checking with the shell now.')
  })

  it('does not double words a resume replays', () => {
    const replayed = `Checking with the shell now.\n\n${resumedRef}8675310`
    expect(joinResumedContent('Checking with the shell now.', replayed)).toBe(replayed)
  })
})

describe('mergeResumedMetadata', () => {
  it('unions the zip allow-list, zip references, image zips, and steers, earlier first', () => {
    const merged = mergeResumedMetadata(
      {
        zipIds: [EARLIER_ZIP],
        zipReferences: [{ zipId: EARLIER_ZIP, reference: earlierRef }],
        imageZipIds: ['img_early', 'img_shared'],
        steers: [
          { steerId: 'steer_1', text: 'use ls first' },
          { steerId: 'steer_shared', text: 'keep it short' }
        ],
        toolApprovals: { approvals: [{ approvalId: 'aitxt-1', status: 'pending' }] }
      },
      {
        zipIds: [RESUMED_ZIP],
        zipReferences: [{ zipId: RESUMED_ZIP, reference: resumedRef }],
        imageZipIds: ['img_shared', 'img_late'],
        steers: [
          { steerId: 'steer_shared', text: 'keep it short' },
          { steerId: 'steer_2', text: 'then add' }
        ],
        toolApprovals: null,
        model: 'claude-sonnet-4-6'
      }
    )

    expect(merged.zipIds).toEqual([EARLIER_ZIP, RESUMED_ZIP])
    expect(merged.zipReferences).toEqual([
      { zipId: EARLIER_ZIP, reference: earlierRef },
      { zipId: RESUMED_ZIP, reference: resumedRef }
    ])
    // Each list keeps what came earlier, adds what is new, and holds a shared entry once.
    expect(merged.imageZipIds).toEqual(['img_early', 'img_shared', 'img_late'])
    expect(merged.steers.map((steer: any) => steer.steerId)).toEqual(['steer_1', 'steer_shared', 'steer_2'])
    // Everything else is the resume's, exactly as before: the spent card is cleared.
    expect(merged.toolApprovals).toBeNull()
    expect(merged.model).toBe('claude-sonnet-4-6')
  })

  it("keeps the first part's reply-end record: notes, memory saves, control errors, and what the step did (SA-129 P2b, BL-350)", () => {
    const pauseError = { tag: 'batshit-tool-notes', error: 'You have no whole read of b.ts', at: '2026-09-27T01:00:00.000Z' }
    const resumeError = { tag: 'batshit-memory', error: 'bad save', at: '2026-09-27T01:01:00.000Z' }
    const merged = mergeResumedMetadata(
      {
        zipControl: {
          unzip: [],
          zip: [],
          toolResultsSummary: [{ toolName: 'read_file', summary: 'a.ts: exports run()' }],
          hold: ['a.ts']
        },
        memorySaves: [{ id: 'mem_1', gist: 'first' }],
        controlErrors: [pauseError],
        zipHolds: { held: [{ path: 'a.ts', zipId: 'zip_a' }] }
      },
      {
        zipControl: {
          unzip: [],
          zip: [],
          toolResultsSummary: [{ toolName: 'bash', summary: 'tests pass' }],
          release: ['a.ts']
        },
        // The resume saved only its own memory; the first part's save must survive the write.
        memorySaves: [{ id: 'mem_2', gist: 'second' }],
        controlErrors: [resumeError],
        zipHolds: { released: [{ path: 'a.ts', zipId: 'zip_a' }] },
        replyControlFinalized: true
      }
    )

    expect(merged.zipControl).toEqual({
      unzip: [],
      zip: [],
      toolResultsSummary: [
        { toolName: 'read_file', summary: 'a.ts: exports run()' },
        { toolName: 'bash', summary: 'tests pass' }
      ],
      hold: ['a.ts'],
      release: ['a.ts']
    })
    expect(merged.memorySaves.map((save: any) => save.id)).toEqual(['mem_1', 'mem_2'])
    expect(merged.controlErrors).toEqual([pauseError, resumeError])
    expect(merged.zipHolds).toEqual({
      held: [{ path: 'a.ts', zipId: 'zip_a' }],
      released: [{ path: 'a.ts', zipId: 'zip_a' }]
    })
    expect(merged.replyControlFinalized).toBe(true)
  })

  it("keeps the first part's notes when the resume wrote none, and the resume's when the first part wrote none", () => {
    const notes = { unzip: [], zip: [], toolResultsSummary: [{ toolName: 'read_file', summary: 'x' }] }
    expect(mergeResumedMetadata({ zipControl: notes }, { replyControlFinalized: true }).zipControl).toEqual(notes)
    expect(mergeResumedMetadata({}, { zipControl: notes }).zipControl).toEqual(notes)
  })

  it('adds no empty lists and keeps the resume\'s own when nothing came earlier', () => {
    const merged = mergeResumedMetadata(undefined, { zipIds: [RESUMED_ZIP], toolApprovals: null })
    expect(merged).toEqual({ zipIds: [RESUMED_ZIP], toolApprovals: null })
    expect(mergeResumedMetadata({}, { toolApprovals: null })).toEqual({ toolApprovals: null })
  })
})

describe('mergeResumedSteps', () => {
  it('keeps the earlier steps before the resumed ones, and stays undefined when there are none', () => {
    expect(mergeResumedSteps([{ tool: 'ls' }], [{ tool: 'expr' }])).toEqual([{ tool: 'ls' }, { tool: 'expr' }])
    expect(mergeResumedSteps(undefined, [{ tool: 'expr' }])).toEqual([{ tool: 'expr' }])
    expect(mergeResumedSteps([{ tool: 'ls' }], undefined)).toEqual([{ tool: 'ls' }])
    expect(mergeResumedSteps(undefined, [])).toBeUndefined()
  })
})

describe('resolveFailedTurnContent', () => {
  it('stores the error line for an ordinary failed turn', () => {
    expect(
      resolveFailedTurnContent({ inPlaceResume: false, errorText: 'Provider down', prior: { content: 'Earlier words' } })
    ).toBe('Provider down')
  })

  it('keeps the words a resumed message already held; the failure rides the metadata', () => {
    expect(
      resolveFailedTurnContent({
        inPlaceResume: true,
        errorText: 'Provider down',
        prior: { role: 'assistant', content: 'Checking with the shell now.' }
      })
    ).toBe('Checking with the shell now.')
  })

  it('falls back to the error line when a resumed message held nothing', () => {
    expect(resolveFailedTurnContent({ inPlaceResume: true, errorText: 'Provider down', prior: null })).toBe(
      'Provider down'
    )
    expect(
      resolveFailedTurnContent({ inPlaceResume: true, errorText: 'Provider down', prior: { content: '   ' } })
    ).toBe('Provider down')
  })
})

describe('isInPlaceApprovalResume', () => {
  it('is the stream handler\'s rule: approval responses and no user turn', () => {
    expect(isInPlaceApprovalResume({ approvalResponseCount: 1, content: '', controlResumeContent: null })).toBe(true)
    expect(isInPlaceApprovalResume({ approvalResponseCount: 1, content: '   ', controlResumeContent: null })).toBe(true)
    expect(isInPlaceApprovalResume({ approvalResponseCount: 1, content: null, controlResumeContent: null })).toBe(true)
  })

  it('is not a resume without responses, with a user turn, or for a CLI control resume', () => {
    expect(isInPlaceApprovalResume({ approvalResponseCount: 0, content: '', controlResumeContent: null })).toBe(false)
    expect(isInPlaceApprovalResume({ approvalResponseCount: 1, content: 'next question', controlResumeContent: null })).toBe(false)
    expect(isInPlaceApprovalResume({ approvalResponseCount: 1, content: [{ type: 'text' }], controlResumeContent: null })).toBe(false)
    expect(
      isInPlaceApprovalResume({ approvalResponseCount: 1, content: '', controlResumeContent: '[Approval — from the user]' })
    ).toBe(false)
  })

  it('reads a user turn the way the stream handler does', () => {
    expect(hasUserTurnContent('')).toBe(false)
    expect(hasUserTurnContent('  ')).toBe(false)
    expect(hasUserTurnContent(null)).toBe(false)
    expect(hasUserTurnContent([])).toBe(false)
    expect(hasUserTurnContent('hi')).toBe(true)
    expect(hasUserTurnContent([{ type: 'text', text: 'hi' }])).toBe(true)
    expect(hasUserTurnContent({ type: 'text' })).toBe(true)
  })
})

describe('the resumed message as Redis stores it', () => {
  async function storeCardMessage() {
    await redis.createSession({ id: SESSION, user_id: USER, name: SESSION, agent_id: 'agent-1' } as any)
    await redis.saveMessage({
      id: MESSAGE,
      session_id: SESSION,
      user_id: USER,
      agent_id: 'agent-1',
      role: 'assistant',
      content: `Checking with the shell now.\n\n${earlierRef}`,
      created_at: '2026-09-18T06:22:00.000Z',
      intermediateSteps: [{ tool: 'native_bash_execute', toolArgs: { command: 'ls' } }],
      metadata: {
        zipIds: [EARLIER_ZIP],
        zipReferences: [{ zipId: EARLIER_ZIP, reference: earlierRef }],
        toolApprovals: { mode: 'all', approvals: [{ approvalId: 'aitxt-1', status: 'pending' }], source: 'vercel' },
        agentType: 'api'
      }
    } as any)
  }

  const resumedWrite = {
    content: `${resumedRef}**8675310**`,
    metadata: {
      zipIds: [RESUMED_ZIP],
      zipReferences: [{ zipId: RESUMED_ZIP, reference: resumedRef }],
      toolApprovals: null,
      model: 'claude-sonnet-4-6'
    },
    intermediateSteps: [{ tool: 'native_bash_execute', toolArgs: { command: 'expr 8675309 + 1' } }]
  }

  async function stored() {
    return (await redis.execute(async (client) => client.json.get(`message:${SESSION}:${MESSAGE}`))) as any
  }

  it('is WHY the rule exists: saving the resume alone replaces the words and the allow-list', async () => {
    await storeCardMessage()
    await redis.saveMessage({
      id: MESSAGE,
      session_id: SESSION,
      user_id: USER,
      agent_id: 'agent-1',
      role: 'assistant',
      created_at: '2026-09-18T06:22:05.000Z',
      ...resumedWrite
    } as any)

    const record = await stored()
    expect(record.content).not.toContain('Checking with the shell now.')
    expect(record.metadata.zipIds).toEqual([RESUMED_ZIP])
  })

  it('keeps the words, the earlier tool card, its allow-list entry, and its step once composed', async () => {
    await storeCardMessage()
    const prior = await readStoredAssistantRecord(SESSION, MESSAGE)
    expect(prior?.content).toBe(`Checking with the shell now.\n\n${earlierRef}`)

    const continued = composeInPlaceResumeMessage(prior!, resumedWrite)
    await redis.saveMessage({
      id: MESSAGE,
      session_id: SESSION,
      user_id: USER,
      agent_id: 'agent-1',
      role: 'assistant',
      created_at: '2026-09-18T06:22:05.000Z',
      ...continued
    } as any)

    const record = await stored()
    expect(record.content).toBe(`Checking with the shell now.\n\n${earlierRef}\n\n${resumedRef}**8675310**`)
    expect(record.metadata.zipIds).toEqual([EARLIER_ZIP, RESUMED_ZIP])
    expect(record.metadata.zipReferences.map((ref: any) => ref.zipId)).toEqual([EARLIER_ZIP, RESUMED_ZIP])
    expect(record.intermediateSteps.map((step: any) => step.toolArgs.command)).toEqual(['ls', 'expr 8675309 + 1'])
    // The spent card is still cleared.
    expect(record.metadata.toolApprovals).toBeNull()
  })

  // Real `saveMessage` merges metadata shallowly, so what the resume does not mention stays.
  // The default lane's fake REPLACES the whole record, so this claim is real-Redis only.
  it.runIf(REAL_REDIS_LANE)('leaves the rest of the stored metadata alone (real RedisJSON merge)', async () => {
    await storeCardMessage()
    const prior = await readStoredAssistantRecord(SESSION, MESSAGE)
    await redis.saveMessage({
      id: MESSAGE,
      session_id: SESSION,
      user_id: USER,
      agent_id: 'agent-1',
      role: 'assistant',
      created_at: '2026-09-18T06:22:05.000Z',
      ...composeInPlaceResumeMessage(prior!, resumedWrite)
    } as any)

    const record = await stored()
    expect(record.metadata.agentType).toBe('api')
    expect(record.metadata.model).toBe('claude-sonnet-4-6')
  })

  it('reads only an assistant record', async () => {
    await storeCardMessage()
    expect(await readStoredAssistantRecord(SESSION, 'msg_missing')).toBeNull()
    await redis.saveMessage({
      id: 'msg_user',
      session_id: SESSION,
      user_id: USER,
      role: 'user',
      content: 'Run it',
      created_at: '2026-09-18T06:21:00.000Z',
      metadata: {}
    } as any)
    expect(await readStoredAssistantRecord(SESSION, 'msg_user')).toBeNull()
  })
})

/**
 * BL-525: after Approve, the resume's finish REPLACED the paused half's numbers (the message's
 * `usage`, `performance`, `reasoningSummary`, `delegated`; the snapshot's `responseSummary`,
 * `llmSummary`, `delegated`, `executionMetadata.typesafeCalls`), so the Token Panel's running cost
 * dropped the first half and its Subagent spend. Both halves count now; unknown stays unknown.
 */
describe('a resumed message counts both halves (BL-525)', () => {
  const subagentStep = (id: string, input: number, output: number) => ({
    toolCallId: id,
    toolName: 'native_run_subagent',
    toolResult: {
      kind: 'subagent',
      status: 'completed',
      subagentName: `Helper ${id}`,
      modelId: 'claude-sonnet-4',
      provider: 'anthropic',
      usage: { inputTokens: input, outputTokens: output, totalTokens: input + output },
      durationMs: 1000
    }
  })

  describe('the message', () => {
    it('adds the two halves’ tokens, field by field', () => {
      expect(
        mergeResumedUsage(
          { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, cachedInputTokens: 800 },
          { inputTokens: 1200, outputTokens: 50, totalTokens: 1250, cachedInputTokens: 1100 }
        )
      ).toEqual({
        inputTokens: 2200,
        outputTokens: 150,
        totalTokens: 2350,
        cachedInputTokens: 1900,
        inputTokenDetails: { cacheReadTokens: 1900 }
      })
    })

    it('leaves out a count only one half reported (never a partial sum as the whole)', () => {
      const merged = mergeResumedUsage({ inputTokens: 1000, outputTokens: 100, cachedInputTokens: 800 }, { inputTokens: 1200, outputTokens: 50 })
      // Each half's total is its input plus output (`normalizeUsageLike`), so the total adds too.
      expect(merged).toEqual({ inputTokens: 2200, outputTokens: 150, totalTokens: 2350 })
      expect(merged).not.toHaveProperty('cachedInputTokens')
    })

    it('says unknown (null) when a half reported no usage, and never turns it into zero', () => {
      expect(mergeResumedUsage({ inputTokens: 1000, outputTokens: 100 }, undefined)).toBeNull()
      expect(mergeResumedUsage(undefined, { inputTokens: 1200, outputTokens: 50 })).toBeNull()
      expect(mergeResumedUsage({ inputTokens: 1000, outputTokens: 100 }, null)).toBeNull()
      // Neither half says anything: the key is left alone.
      expect(mergeResumedUsage(undefined, undefined)).toBeUndefined()
      // A real zero is a number, and adds like one.
      expect(mergeResumedUsage({ inputTokens: 0, outputTokens: 0 }, { inputTokens: 5, outputTokens: 1 })).toEqual({ inputTokens: 5, outputTokens: 1, totalTokens: 6 })
    })

    it('takes each performance field by its own definition', () => {
      expect(
        mergeResumedPerformance(
          { schemaVersion: 1, source: 'ai-sdk', timeToFirstOutputMs: 900, outputTokensPerSecond: 40, responseTimeMs: 3000, modelCalls: 2 },
          { schemaVersion: 1, source: 'ai-sdk', timeToFirstOutputMs: 300, outputTokensPerSecond: 55, responseTimeMs: 1500, modelCalls: 1 }
        )
      ).toEqual({
        schemaVersion: 1,
        source: 'ai-sdk',
        // The FIRST model call's, which is in the paused half.
        timeToFirstOutputMs: 900,
        // The final answer call's, which is in the resume.
        outputTokensPerSecond: 55,
        // Totals over the whole send.
        responseTimeMs: 4500,
        modelCalls: 3
      })
    })

    it('leaves a performance total unknown when a half has none', () => {
      expect(
        mergeResumedPerformance(undefined, { schemaVersion: 1, source: 'ai-sdk', timeToFirstOutputMs: 300, outputTokensPerSecond: 55, responseTimeMs: 1500, modelCalls: 1 })
      ).toEqual({ schemaVersion: 1, source: 'ai-sdk', outputTokensPerSecond: 55 })
      expect(mergeResumedPerformance({ schemaVersion: 1, source: 'ai-sdk', responseTimeMs: 3000 }, undefined)).toBeNull()
      expect(mergeResumedPerformance(undefined, undefined)).toBeUndefined()
    })

    it('keeps both halves’ reasoning, earlier first, without doubling a replay', () => {
      expect(mergeResumedReasoning('Check the folder first.', 'The listing shows three files.')).toBe(
        'Check the folder first.\n\nThe listing shows three files.'
      )
      expect(mergeResumedReasoning('Check the folder first.', 'Check the folder first.\n\nThen count.')).toBe(
        'Check the folder first.\n\nThen count.'
      )
      expect(mergeResumedReasoning('Check the folder first.', undefined)).toBe('Check the folder first.')
      expect(mergeResumedReasoning(undefined, undefined)).toBeUndefined()
    })

    it('mergeResumedMetadata joins all four, and keeps the paused half’s Subagent runs when the resume ran none', () => {
      const pausedDelegated = buildDelegatedExecutionSummary([subagentStep('call_a', 4000, 400)])
      const merged = mergeResumedMetadata(
        {
          usage: { inputTokens: 1000, outputTokens: 100 },
          performance: { schemaVersion: 1, source: 'ai-sdk', timeToFirstOutputMs: 900, responseTimeMs: 3000, modelCalls: 2 },
          reasoningSummary: 'First.',
          delegated: pausedDelegated
        },
        {
          usage: { inputTokens: 1200, outputTokens: 50 },
          performance: { schemaVersion: 1, source: 'ai-sdk', outputTokensPerSecond: 55, responseTimeMs: 1500, modelCalls: 1 },
          reasoningSummary: 'Second.'
        }
      )
      expect(merged.usage).toEqual({ inputTokens: 2200, outputTokens: 150, totalTokens: 2350 })
      expect(merged.performance).toMatchObject({ timeToFirstOutputMs: 900, outputTokensPerSecond: 55, responseTimeMs: 4500, modelCalls: 3 })
      expect(merged.reasoningSummary).toBe('First.\n\nSecond.')
      expect(merged.delegated).toEqual(pausedDelegated)
    })

    it('mergeResumedMetadata adds both halves’ Subagent runs', () => {
      const merged = mergeResumedMetadata(
        { delegated: buildDelegatedExecutionSummary([subagentStep('call_a', 4000, 400)]) },
        { delegated: buildDelegatedExecutionSummary([subagentStep('call_b', 2000, 200)]) }
      )
      expect(merged.delegated.runs.map((run: any) => run.name)).toEqual(['Helper call_a', 'Helper call_b'])
      expect(merged.delegated.totals).toMatchObject({
        runs: 2,
        completed: 2,
        usageKnownRuns: 2,
        usageUnknownRuns: 0,
        usage: { inputTokens: 6000, outputTokens: 600, totalTokens: 6600 }
      })
    })

    it('mergeResumedMetadata writes an unknown usage as null, so the paused half’s cannot stand for the whole', () => {
      const merged = mergeResumedMetadata({ usage: { inputTokens: 1000, outputTokens: 100 } }, { interrupted: true })
      expect(merged).toHaveProperty('usage', null)
    })

    it('the resume start carries the paused half’s numbers, so the live `end` sums what the saved record sums', () => {
      const prior = {
        role: 'assistant',
        content: 'Checking.',
        metadata: {
          usage: { inputTokens: 1000, outputTokens: 100 },
          performance: { schemaVersion: 1, source: 'ai-sdk', timeToFirstOutputMs: 900 },
          delegated: buildDelegatedExecutionSummary([subagentStep('call_a', 4000, 400)])
        }
      }
      const start = createApprovalResumeStart(prior, 100)
      for (const key of ['usage', 'performance', 'delegated']) {
        expect(start.prior.metadata[key]).toEqual((prior.metadata as any)[key])
      }
      const resumedEnd = { usage: { inputTokens: 1200, outputTokens: 50 } }
      expect(mergeResumedMetadata(start.prior.metadata, resumedEnd).usage).toEqual(
        composeInPlaceResumeMessage(prior, { content: 'Done.', metadata: resumedEnd }).metadata.usage
      )
    })
  })

  describe('the Execution Viewer snapshot and the Token Panel', () => {
    const SNAPSHOT_SESSION = 'session-bl525'
    const RUN = 'msg_card_bl525'
    const model: SavedModel = {
      id: 'model-bl525',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4',
      modelName: 'Claude Sonnet 4',
      contextWindow: 200000,
      pricing: { input: 3, output: 15 },
      connection: { id: 'direct:anthropic', type: 'direct', service: 'anthropic', useDeveloperPrefix: false },
      createdAt: '2026-09-27T00:00:00.000Z',
      updatedAt: '2026-09-27T00:00:00.000Z'
    } as SavedModel

    const finishPatch = (input: number, output: number, delegatedSteps: any[], text: string): Partial<ExecutionSnapshot> => ({
      llmSummary: {
        callsCount: buildTokenStat(1, 'exact'),
        totalUsage: buildTokenUsage({ inputTokens: input, outputTokens: output }, 'exact', 'provider'),
        breakdownConfidence: 'exact'
      },
      delegated: buildDelegatedExecutionSummary(delegatedSteps),
      responseSummary: {
        content: { value: text, confidence: 'exact' },
        usage: buildTokenUsage({ inputTokens: input, outputTokens: output }, 'exact', 'provider'),
        toolCallsCount: buildTokenStat(delegatedSteps.length, 'exact', 'vercel ai sdk')
      }
    })

    const baseSnapshot = (): ExecutionSnapshot => ({
      id: RUN,
      sessionId: SNAPSHOT_SESSION,
      userId: USER,
      agentId: 'agent-1',
      agentName: 'Primary Agent',
      createdAt: '2026-09-27T00:00:00.000Z',
      structuredInput: {},
      runtime: { runtimeId: 'vercel', providerId: 'anthropic', connectionId: 'direct:anthropic', modelName: 'claude-sonnet-4' }
    })

    /** The pause, then the resume, the way send-routed writes them; `continued` is BL-525's rule. */
    async function pauseThenResume({ continued }: { continued: boolean }) {
      await executionViewerService.clearSnapshots(SNAPSHOT_SESSION)
      await executionViewerService.recordSnapshot({
        ...baseSnapshot(),
        executionMetadata: { typesafeCalls: [{ feature: 'memory_recall', status: 'ok' }] }
      })
      await executionViewerService.updateSnapshot(SNAPSHOT_SESSION, RUN, finishPatch(10_000, 1_000, [subagentStep('call_a', 4000, 400)], 'Checking.'))

      // The resume: the paused half is read once, then the resume records its own snapshot over it.
      const prior = continued ? await executionViewerService.getSnapshot(SNAPSHOT_SESSION, RUN) : null
      await executionViewerService.recordSnapshot({
        ...baseSnapshot(),
        executionMetadata: {
          typesafeCalls: continued ? withPriorTypesafeCalls(prior?.executionMetadata?.typesafeCalls, []) : []
        }
      })
      const resumeFinish = finishPatch(12_000, 500, [], 'Done.')
      // Written twice, as the finish and a backfill can: the first half must not count twice.
      await executionViewerService.updateSnapshot(SNAPSHOT_SESSION, RUN, continueResumedSnapshotPatch(prior, resumeFinish))
      await executionViewerService.updateSnapshot(SNAPSHOT_SESSION, RUN, continueResumedSnapshotPatch(prior, resumeFinish))
      return (await executionViewerService.getSnapshots(SNAPSHOT_SESSION))[0]
    }

    // (10,000 + 12,000) input at $3/M + (1,000 + 500) output at $15/M = $0.0885; the Subagent's
    // 4,000 in and 400 out at the same prices = $0.018.
    const bothHalves = (22_000 / 1e6) * 3 + (1_500 / 1e6) * 15
    const subagent = (4_000 / 1e6) * 3 + (400 / 1e6) * 15

    it('counts both halves and the paused half’s Subagent spend in the running cost', async () => {
      const snapshot = await pauseThenResume({ continued: true })
      expect(snapshot.responseSummary?.usage.inputTokens.value).toBe(22_000)
      expect(snapshot.responseSummary?.usage.outputTokens.value).toBe(1_500)
      expect(snapshot.llmSummary?.totalUsage.inputTokens.value).toBe(22_000)
      expect(snapshot.responseSummary?.content.value).toBe('Checking.\n\nDone.')
      expect(snapshot.delegated?.runs).toHaveLength(1)
      expect(snapshot.executionMetadata?.typesafeCalls).toEqual([{ feature: 'memory_recall', status: 'ok' }])

      const cost = summarizeRunningCost([snapshot], model, null, [model])
      expect(cost.cost).toBeCloseTo(bothHalves + subagent, 10)
      expect(cost.delegatedRunCount).toBe(1)
    })

    it('is WHY the rule exists: without it the resume replaced the paused half’s numbers', async () => {
      const snapshot = await pauseThenResume({ continued: false })
      expect(snapshot.responseSummary?.usage.inputTokens.value).toBe(12_000)
      expect(snapshot.delegated).toBeNull()
      expect(snapshot.executionMetadata?.typesafeCalls).toEqual([])
      const cost = summarizeRunningCost([snapshot], model, null, [model])
      expect(cost.cost).toBeCloseTo((12_000 / 1e6) * 3 + (500 / 1e6) * 15, 10)
    })

    it('a resume that called the model and then failed leaves the message’s usage unknown, never a partial as exact', () => {
      const prior = { ...baseSnapshot(), ...finishPatch(10_000, 1_000, [], 'Checking.') } as ExecutionSnapshot
      const failed = continueResumedSnapshotPatch(prior, {
        llmSummary: { callsCount: buildTokenStat(1, 'exact'), totalUsage: buildTokenUsage(null, 'estimated'), breakdownConfidence: 'estimated' },
        responseSummary: {
          content: { value: '', confidence: 'exact' },
          usage: buildTokenUsage(null, 'estimated'),
          toolCallsCount: buildTokenStat(null, 'estimated')
        }
      })
      expect(failed.responseSummary?.usage.inputTokens.value).toBeNull()
      expect(failed.llmSummary?.totalUsage.inputTokens.value).toBeNull()
      expect(failed.responseSummary?.content.value).toBe('Checking.')
      const cost = summarizeRunningCost([{ ...prior, ...failed } as ExecutionSnapshot], model, null, [model])
      expect(cost.cost).toBeNull()
      expect(cost.state).toBe('unknown')
    })

    it('changes nothing for a run that is not a resume', () => {
      const patch = finishPatch(12_000, 500, [], 'Done.')
      expect(continueResumedSnapshotPatch(null, patch)).toBe(patch)
    })

    // Review D1: a cache count only one half reported is `value: null` on the merged snapshot. The
    // running cost prices a null count as no cache (the whole input at the input price), so the
    // total must say it is an estimate, never exact.
    describe('a cache count only one half reported (review D1)', () => {
      const cachedModel = { ...model, pricing: { input: 3, output: 15, cachedInput: 0.3 } } as SavedModel
      const half = (input: number, output: number, cached?: number): Partial<ExecutionSnapshot> => {
        const usage = buildTokenUsage(
          { inputTokens: input, outputTokens: output, ...(cached !== undefined ? { cachedInputTokens: cached } : {}) },
          'exact',
          'provider'
        )
        return {
          llmSummary: { callsCount: buildTokenStat(1, 'exact'), totalUsage: usage, breakdownConfidence: 'exact' },
          responseSummary: {
            content: { value: 'x', confidence: 'exact' },
            usage,
            toolCallsCount: buildTokenStat(0, 'exact', 'vercel ai sdk')
          }
        }
      }
      const merged = (pause: Partial<ExecutionSnapshot>, resume: Partial<ExecutionSnapshot>) =>
        ({ ...baseSnapshot(), ...pause, ...continueResumedSnapshotPatch({ ...baseSnapshot(), ...pause } as ExecutionSnapshot, resume) }) as ExecutionSnapshot

      it('is an estimate, priced at the full input rate, when the paused half reported no cache count', () => {
        const snapshot = merged(half(40_000, 1_000), half(50_000, 500, 30_000))
        expect(snapshot.responseSummary?.usage.cachedInputTokens).toMatchObject({ value: null })

        const cost = summarizeRunningCost([snapshot], cachedModel, null, [cachedModel])
        // 90,000 input at $3/M (no cache known) + 1,500 output at $15/M.
        expect(cost.cost).toBeCloseTo((90_000 / 1e6) * 3 + (1_500 / 1e6) * 15, 10)
        expect(cost.state).toBe('estimated')
      })

      it('control: both halves reported their cache, so the sum is exact and priced with it', () => {
        const snapshot = merged(half(40_000, 1_000, 10_000), half(50_000, 500, 30_000))
        expect(snapshot.responseSummary?.usage.cachedInputTokens?.value).toBe(40_000)

        const cost = summarizeRunningCost([snapshot], cachedModel, null, [cachedModel])
        expect(cost.cost).toBeCloseTo((50_000 / 1e6) * 3 + (40_000 / 1e6) * 0.3 + (1_500 / 1e6) * 15, 10)
        expect(cost.state).toBe('exact')
      })
    })
  })
})
