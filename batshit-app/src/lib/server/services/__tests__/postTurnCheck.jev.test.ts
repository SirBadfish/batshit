// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JevJuicePostTurnFinding, TypesafeConfig } from '$lib/types/typesafe'
import type { TypesafeCallOutcome, TypesafeClient, TypesafeSystemOneRequest } from '../typesafe/typesafeClient'

/**
 * SA-120 P6 — the after-reply decision surface: facts first (which tool calls failed and were
 * not retried, whether a memory was saved), the request shapes, every floor and the one ceiling
 * at their exact boundaries, the counted half of the style coach, the lines the agent reads
 * next turn, and both orchestrators against a fake client — each lane's own switch, the
 * DL-120-11 master-off pin, and the all-or-nothing miss. No network and no Redis: the stored
 * record is pinned by `postTurnCheckState.test.ts`, the route glue by `jevJuiceTurn.test.ts`.
 */

const retrieve = vi.hoisted(() => vi.fn<(service: string, userId: string) => Promise<string | null>>())
const dynamicPrivateEnv = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }))
const configState = vi.hoisted(() => ({
  config: { enabled: true, modelId: 'jev-1.13.0', attemptTimeoutMs: 5000, inChatWaitMs: 750, screenIncomingText: false, updatedAt: null } as TypesafeConfig
}))

vi.mock('$lib/services/apiKey.server', () => ({ apiKeyService: { retrieve } }))
vi.mock('$env/dynamic/private', () => dynamicPrivateEnv)
vi.mock('../typesafe/typesafeConfig', () => ({ getTypesafeConfig: vi.fn(async () => configState.config) }))

import {
  POST_TURN_CHECK_LIMITS,
  POST_TURN_CHECK_QUESTIONS,
  REPLY_CHECK_DCM_HEADING,
  REPLY_CHECK_THRESHOLDS,
  STYLE_COACH_DCM_HEADING,
  STYLE_COACH_THRESHOLDS,
  buildPostTurnCheckDcmLines,
  buildReplyCheckRequest,
  buildStyleCoachRequest,
  clipMiddle,
  closerKey,
  computeReplyCheck,
  computeStyleCoach,
  countStyleRepeats,
  decideReplyCheck,
  decideStyleCoach,
  isFailedToolFact,
  openerKey,
  ownWordsOf,
  selectUnrecoveredFailures,
  styleProse,
  type PostTurnToolFact,
  type ReplyCheckFacts
} from '../postTurnCheck.jev'

function tool(description: string, kind: string, status: string, target = ''): PostTurnToolFact {
  return { description, kind, status, target }
}

const READ = tool('read_file: batshit-app/package.json - 142 lines', 'read_file', 'success', 'batshit-app/package.json')
const TESTS_FAIL = tool('bash: npm run test - exit 1 - 212 lines', 'bash', 'exit 1', 'npm run test')
const TESTS_PASS = tool('bash: npm run test - exit 0 - 38 lines', 'bash', 'exit 0', 'npm run test')

function facts(overrides: Partial<ReplyCheckFacts> = {}): ReplyCheckFacts {
  return {
    userRequest: 'Run the tests and tell me if they pass.',
    reply: 'I ran the full test suite and everything passes.',
    tools: [],
    extraToolLabels: [],
    earlierToolLabels: [],
    memoryEnabled: true,
    memorySaveAttempted: false,
    ...overrides
  }
}

const noul = (value: number) => ({ type: 'noul', noul: value })

function fakeClient(
  answers: Record<string, unknown>,
  outcome?: Partial<TypesafeCallOutcome>
): TypesafeClient & { calls: TypesafeSystemOneRequest[] } {
  const calls: TypesafeSystemOneRequest[] = []
  return {
    calls,
    async systemOne(request) {
      calls.push(request as TypesafeSystemOneRequest)
      return {
        status: 'ok',
        response: { model: 'jev-1.13.0', answers, usage: { inputTokens: 700, outputTokens: 40 } },
        latencyMs: 190,
        attempts: 1,
        deadlineHit: false,
        httpStatus: 200,
        requestChars: 1800,
        ...outcome
      } as never
    }
  }
}

const CHECK_AGENT = { id: 'agent-1', user_id: 'josh', jev_juice_reply_check: true }
const STYLE_AGENT = { id: 'agent-1', user_id: 'josh', jev_juice_style_coach: true }

beforeEach(() => {
  retrieve.mockReset()
  retrieve.mockResolvedValue('user-key')
  dynamicPrivateEnv.env = {}
  configState.config = { enabled: true, modelId: 'jev-1.13.0', attemptTimeoutMs: 5000, inChatWaitMs: 750, screenIncomingText: false, updatedAt: null }
})

describe('facts first: which tool calls failed', () => {
  it('reads failure off the stored status, and a clean exit or a success is never a failure', () => {
    expect(isFailedToolFact(tool('x', 'mcp_sheets', 'error'))).toBe(true)
    expect(isFailedToolFact(tool('x', 'bash', 'interrupted'))).toBe(true)
    expect(isFailedToolFact(TESTS_FAIL)).toBe(true)
    expect(isFailedToolFact(tool('x', 'bash', 'exit 128', 'git push'))).toBe(true)
    expect(isFailedToolFact(TESTS_PASS)).toBe(false)
    expect(isFailedToolFact(READ)).toBe(false)
    expect(isFailedToolFact(tool('x', 'web_search', ''))).toBe(false)
  })

  it('treats exit code 1 from a search or compare command as an answer, not a failure', () => {
    expect(isFailedToolFact(tool('x', 'bash', 'exit 1', 'grep -rn "cueParser" src'))).toBe(false)
    expect(isFailedToolFact(tool('x', 'bash', 'exit 1', 'rg TODO'))).toBe(false)
    expect(isFailedToolFact(tool('x', 'bash', 'exit 1', 'git diff --quiet'))).toBe(true)
    expect(isFailedToolFact(tool('x', 'bash', 'exit 1', 'diff a.txt b.txt'))).toBe(false)
    // A pipeline exits with its last command.
    expect(isFailedToolFact(tool('x', 'bash', 'exit 1', 'cat log.txt | grep ERROR'))).toBe(false)
    // An OR result of 1 proves the right side ran: a successful left side would have returned 0.
    expect(isFailedToolFact(tool('x', 'bash', 'exit 1', 'false || /usr/bin/grep -c foo bar'))).toBe(false)
    // Only exit 1 is "nothing found"; grep's exit 2 is a real error.
    expect(isFailedToolFact(tool('x', 'bash', 'exit 2', 'grep -rn foo missing-dir'))).toBe(true)
    // And only for those commands.
    expect(isFailedToolFact(tool('x', 'bash', 'exit 1', 'npm run build'))).toBe(true)
  })

  it('keeps that carve-out to shell commands: a read, write, edit, or listing names a PATH, so a file called `find` is not a search', () => {
    // Every lane stores a shell command as kind `bash` with the command as its target; a mapped
    // file action stores the path (a failed Codex shell read keeps its `exit N`, F-P6-5).
    expect(isFailedToolFact(tool('read_file: find - exit 1 - 1 line', 'read_file', 'exit 1', 'find'))).toBe(true)
    expect(isFailedToolFact(tool('x', 'read_file', 'exit 1', 'notes/grep'))).toBe(true)
    // `ls test` exits 1 on macOS when there is no `test`, a common folder name.
    expect(isFailedToolFact(tool('list_files: test - exit 1', 'list_files', 'exit 1', 'test'))).toBe(true)
    expect(isFailedToolFact(tool('x', 'write_file', 'exit 1', 'diff'))).toBe(true)
    expect(isFailedToolFact(tool('x', 'edit_file', 'exit 1', 'which'))).toBe(true)
    // The same word as a shell command is still an answer.
    expect(isFailedToolFact(tool('bash: grep x f - exit 1', 'bash', 'exit 1', 'grep x f'))).toBe(false)
  })

  it('does not excuse a search that a failed shell branch skipped', () => {
    expect(isFailedToolFact(tool('x', 'bash', 'exit 1', 'false && rg needle notes.md'))).toBe(true)
    expect(isFailedToolFact(tool('x', 'bash', 'exit 1', 'false && cat notes.md | grep needle'))).toBe(true)
    // `cd` may have supplied the exit 1 before grep ever ran.
    expect(isFailedToolFact(tool('x', 'bash', 'exit 1', 'cd missing && grep needle notes.md'))).toBe(true)
    expect(isFailedToolFact(tool('x', 'bash', 'exit 1', 'exit 1; false || rg needle notes.md'))).toBe(true)
    expect(isFailedToolFact(tool('x', 'bash', 'exit 1', 'set -eu; false; false || rg needle notes.md'))).toBe(true)
  })

  it('treats find exit 1 as a failure because an empty find succeeds', () => {
    expect(isFailedToolFact(tool('x', 'bash', 'exit 1', 'find /definitely-missing'))).toBe(true)
  })

  it('drops a failure the turn recovered from: a later success of the same tool kind is the retry', () => {
    expect(selectUnrecoveredFailures([TESTS_FAIL, READ, TESTS_PASS])).toEqual([])
    // A success of ANOTHER kind is not a retry.
    expect(selectUnrecoveredFailures([TESTS_FAIL, READ])).toEqual([TESTS_FAIL])
    // A success BEFORE the failure is not a retry either.
    expect(selectUnrecoveredFailures([TESTS_PASS, TESTS_FAIL])).toEqual([TESTS_FAIL])
  })

  it('asks about the newest failures only', () => {
    const failures = Array.from({ length: POST_TURN_CHECK_LIMITS.maxFailedTools + 2 }, (_, index) =>
      tool(`mcp_tool_${index}: call - error`, `mcp_tool_${index}`, 'error')
    )
    const selected = selectUnrecoveredFailures(failures)
    expect(selected).toHaveLength(POST_TURN_CHECK_LIMITS.maxFailedTools)
    expect(selected[selected.length - 1]).toBe(failures[failures.length - 1])
  })
})

describe('buildReplyCheckRequest', () => {
  it('always asks the three wording questions, with the exact reviewed wording, and keeps real ids home', () => {
    const request = buildReplyCheckRequest(facts({ tools: [READ], earlierToolLabels: ['web_search: "mqtt" - 10 results'] }))
    expect(request).not.toBeNull()
    expect(request?.state.request).toBe('Run the tests and tell me if they pass.')
    expect(request?.state.tools_this_turn).toEqual([READ.description])
    expect(request?.state.tools_earlier).toEqual(['web_search: "mqtt" - 10 results'])
    expect(request?.state.failed_tools).toBeUndefined()
    expect(request?.questions.claimed).toEqual({
      type: 'noul',
      instructions: POST_TURN_CHECK_QUESTIONS.claimed.instructions,
      criteria: POST_TURN_CHECK_QUESTIONS.claimed.criteria
    })
    expect(request?.questions.multi_part).toBeDefined()
    expect(request?.questions.unaddressed).toBeDefined()
  })

  it('says "none" rather than an empty list when no tool ran', () => {
    const request = buildReplyCheckRequest(facts())
    expect(request?.state.tools_this_turn).toBe('none')
    expect(request?.state.tools_earlier).toBe('none')
  })

  it('asks about a memory promise ONLY when Agent Memory is on and nothing was saved', () => {
    expect(buildReplyCheckRequest(facts())?.askedPromised).toBe(true)
    expect(buildReplyCheckRequest(facts())?.questions.promised).toBeDefined()
    const saved = buildReplyCheckRequest(facts({ memorySaveAttempted: true }))
    expect(saved?.askedPromised).toBe(false)
    expect(saved?.questions.promised).toBeUndefined()
    const memoryOff = buildReplyCheckRequest(facts({ memoryEnabled: false }))
    expect(memoryOff?.askedPromised).toBe(false)
    expect(memoryOff?.questions.promised).toBeUndefined()
  })

  it('asks whether the reply mentions a failure only for a failure the turn did not recover from', () => {
    expect(buildReplyCheckRequest(facts({ tools: [TESTS_FAIL, TESTS_PASS] }))?.failures).toEqual([])
    const request = buildReplyCheckRequest(facts({ tools: [READ, TESTS_FAIL] }))
    expect(request?.failures).toEqual([{ key: 'f1', tool: TESTS_FAIL }])
    expect(request?.state.failed_tools).toEqual({ f1: TESTS_FAIL.description })
    expect(request?.questions.mentions_failure_f1).toEqual({
      type: 'noul',
      instructions: POST_TURN_CHECK_QUESTIONS.mentionsFailure.instructions('f1'),
      criteria: POST_TURN_CHECK_QUESTIONS.mentionsFailure.criteria
    })
  })

  it('asks about a failed read of a file whose name is a search word, like any other failed read', () => {
    const readFind = tool('read_file: find - exit 1 - 1 line', 'read_file', 'exit 1', 'find')
    const request = buildReplyCheckRequest(facts({ tools: [readFind] }))
    expect(request?.failures).toEqual([{ key: 'f1', tool: readFind }])
    expect(request?.questions.mentions_failure_f1).toBeDefined()
  })

  it('sends the reply as the agent\'s OWN words: a tool label never rides inside it (found live: a label saying "error" read as the reply mentioning the failure)', () => {
    const request = buildReplyCheckRequest(
      facts({ reply: '[tool result: read_file: /nope.txt - error - 31 lines]ok [tool result]', tools: [tool('read_file: /nope.txt - error - 31 lines', 'read_file', 'error', '/nope.txt')] })
    )
    expect(request?.state.reply).toBe('[tool call]ok [tool call]')
    // The facts still travel, beside the text rather than inside it.
    expect(request?.state.tools_this_turn).toEqual(['read_file: /nope.txt - error - 31 lines'])
    expect(request?.state.failed_tools).toEqual({ f1: 'read_file: /nope.txt - error - 31 lines' })
    expect(ownWordsOf('plain words')).toBe('plain words')
  })

  it('lists memory controls beside the zipped tool calls, because they leave no tool-result zip', () => {
    const request = buildReplyCheckRequest(facts({ tools: [READ], extraToolLabels: ['memory: search'] }))
    expect(request?.state.tools_this_turn).toEqual([READ.description, 'memory: search'])
  })

  it('keeps the head and the tail of a long reply, and builds nothing without a reply or a request', () => {
    const long = `${'start '.repeat(500)}MIDDLE${' end'.repeat(900)}`
    const clipped = buildReplyCheckRequest(facts({ reply: long }))?.state.reply ?? ''
    expect(clipped.length).toBeLessThanOrEqual(POST_TURN_CHECK_LIMITS.maxReplyChars)
    expect(clipped.startsWith('start start')).toBe(true)
    expect(clipped.endsWith('end end')).toBe(true)
    expect(clipped).toContain('[…]')
    expect(clipped).not.toContain('MIDDLE')
    expect(clipMiddle('short', 100)).toBe('short')
    expect(buildReplyCheckRequest(facts({ reply: '   ' }))).toBeNull()
    expect(buildReplyCheckRequest(facts({ userRequest: '' }))).toBeNull()
  })
})

describe('decideReplyCheck', () => {
  const request = buildReplyCheckRequest(facts({ tools: [TESTS_FAIL] }))!
  const quiet = { claimed: noul(0.03), promised: noul(0.02), mentions_failure_f1: noul(0.9), multi_part: noul(0.05), unaddressed: noul(0.04) }
  const ids = (answers: Record<string, unknown>) => decideReplyCheck(answers, request).findings.map((finding) => finding.id)

  it('flags nothing on a clean reply', () => {
    const decision = decideReplyCheck(quiet, request)
    expect(decision.findings).toEqual([])
    expect(decision.summary).toContain('nothing flagged')
  })

  it('flags a claimed action at the floor and not a hair under it', () => {
    expect(ids({ ...quiet, claimed: noul(REPLY_CHECK_THRESHOLDS.claimedFloor) })).toEqual(['claimed_action'])
    expect(ids({ ...quiet, claimed: noul(REPLY_CHECK_THRESHOLDS.claimedFloor - 0.001) })).toEqual([])
  })

  it('flags a memory promise at the floor and not under it, and never when the question was not asked', () => {
    expect(ids({ ...quiet, promised: noul(REPLY_CHECK_THRESHOLDS.promisedFloor) })).toEqual(['promised_memory'])
    expect(ids({ ...quiet, promised: noul(REPLY_CHECK_THRESHOLDS.promisedFloor - 0.001) })).toEqual([])
    const notAsked = buildReplyCheckRequest(facts({ memorySaveAttempted: true }))!
    expect(decideReplyCheck({ ...quiet, promised: noul(0.99) }, notAsked).findings).toEqual([])
  })

  it('flags a silent failure at the ceiling and not a hair over it, as how sure it is of the SILENCE', () => {
    const atCeiling = decideReplyCheck({ ...quiet, mentions_failure_f1: noul(REPLY_CHECK_THRESHOLDS.mentionsFailureCeiling) }, request)
    expect(atCeiling.findings).toEqual([
      {
        id: 'silent_failure',
        lane: 'reply_check',
        source: 'inferred',
        probability: 1 - REPLY_CHECK_THRESHOLDS.mentionsFailureCeiling,
        detail: TESTS_FAIL.description
      }
    ])
    expect(ids({ ...quiet, mentions_failure_f1: noul(REPLY_CHECK_THRESHOLDS.mentionsFailureCeiling + 0.001) })).toEqual([])
  })

  it('flags a skipped part only when BOTH rules hold, each at its exact floor', () => {
    const both = { multi_part: noul(REPLY_CHECK_THRESHOLDS.multiPartFloor), unaddressed: noul(REPLY_CHECK_THRESHOLDS.unaddressedFloor) }
    expect(ids({ ...quiet, ...both })).toEqual(['unaddressed_part'])
    expect(ids({ ...quiet, ...both, multi_part: noul(REPLY_CHECK_THRESHOLDS.multiPartFloor - 0.001) })).toEqual([])
    expect(ids({ ...quiet, ...both, unaddressed: noul(REPLY_CHECK_THRESHOLDS.unaddressedFloor - 0.001) })).toEqual([])
    // A one-part request that reads as "unaddressed" is not a skipped part (probe: a quoted email, 0.54 / 0.07).
    expect(ids({ ...quiet, multi_part: noul(0.2), unaddressed: noul(0.95) })).toEqual([])
  })

  it('never flags on a missing or unreadable answer, and the other checks still stand', () => {
    const decision = decideReplyCheck({ claimed: noul(0.95), multi_part: { type: 'noul', noul: 'high' }, unaddressed: noul(0.99) }, request)
    expect(decision.findings.map((finding) => finding.id)).toEqual(['claimed_action'])
    expect(decision.summary).toContain('promised ?')
    expect(decision.summary).toContain('mentioned ?')
  })

  it('writes one decision line that names every reading', () => {
    const summary = decideReplyCheck({ ...quiet, claimed: noul(0.91) }, request).summary
    expect(summary).toBe(
      `after the reply: claimed 0.91; promised 0.02 (nothing saved); failed ${TESTS_FAIL.description} → mentioned 0.90; parts 0.05 / unaddressed 0.04 → flagged claimed_action`
    )
  })
})

describe('the numbers themselves (first guesses from the P6 wording probes)', () => {
  // The boundary cases above move WITH a constant, so they cannot see the constant change. These
  // use the probe's own readings on both sides of every rule: moving a number moves a verdict.
  const request = buildReplyCheckRequest(facts({ tools: [TESTS_FAIL] }))!
  const quiet = { claimed: noul(0.03), promised: noul(0.02), mentions_failure_f1: noul(0.9), multi_part: noul(0.05), unaddressed: noul(0.04) }
  const ids = (answers: Record<string, unknown>) => decideReplyCheck(answers, request).findings.map((finding) => finding.id)

  it('a claimed action: 0.70 flags and 0.69 does not (probe: false claims 0.88-0.96, everything else 0.17 at most)', () => {
    expect(ids({ ...quiet, claimed: noul(0.7) })).toEqual(['claimed_action'])
    expect(ids({ ...quiet, claimed: noul(0.69) })).toEqual([])
    expect(ids({ ...quiet, claimed: noul(0.17) })).toEqual([])
  })

  it('a memory promise: 0.70 flags and 0.69 does not (probe: promises 0.85-0.99, a bare "Understood." 0.56)', () => {
    expect(ids({ ...quiet, promised: noul(0.7) })).toEqual(['promised_memory'])
    expect(ids({ ...quiet, promised: noul(0.69) })).toEqual([])
    expect(ids({ ...quiet, promised: noul(0.56) })).toEqual([])
  })

  it('a silent failure: 0.15 flags and 0.16 does not (probe: silent 0.01-0.03, "mostly passing" 0.24, said 0.41 and up)', () => {
    expect(ids({ ...quiet, mentions_failure_f1: noul(0.15) })).toEqual(['silent_failure'])
    expect(ids({ ...quiet, mentions_failure_f1: noul(0.16) })).toEqual([])
    expect(ids({ ...quiet, mentions_failure_f1: noul(0.24) })).toEqual([])
  })

  it('a skipped part: several parts from 0.60 AND silent from 0.80 (probe: skipped 0.91-0.98, a quoted email 0.54 / 0.07)', () => {
    expect(ids({ ...quiet, multi_part: noul(0.6), unaddressed: noul(0.8) })).toEqual(['unaddressed_part'])
    expect(ids({ ...quiet, multi_part: noul(0.59), unaddressed: noul(0.8) })).toEqual([])
    expect(ids({ ...quiet, multi_part: noul(0.6), unaddressed: noul(0.79) })).toEqual([])
    // Found live: a part the USER asked the agent to skip read 0.76. That is not the agent's miss.
    expect(ids({ ...quiet, multi_part: noul(0.95), unaddressed: noul(0.76) })).toEqual([])
  })

  it('the style coach: praise from 0.70, the same habit from 0.80, a habit of speech from 0.70', () => {
    const style = buildStyleCoachRequest({
      reply: 'Great question! Volumes live outside the container layer.',
      recentReplies: ['Great question! One thing.', 'Short answer: no.', 'Great question! Two things.'],
      userMessages: []
    })!
    const styleIds = (answers: Record<string, unknown>) => decideStyleCoach(answers, style).findings.map((finding) => finding.id)
    expect(styleIds({ praise_o1: noul(0.7), praise_o2: noul(0.7) })).toEqual(['praise_openers'])
    expect(styleIds({ praise_o1: noul(0.69), praise_o2: noul(0.98) })).toEqual([])
    expect(styleIds({ praise_o1: noul(0.98), praise_o2: noul(0.69) })).toEqual([])
    expect(styleIds({ same_move: noul(0.8) })).toEqual(['same_move'])
    expect(styleIds({ same_move: noul(0.79) })).toEqual([])
    expect(styleIds({ filler_k1: noul(0.7) })).toEqual(['repeated_opener'])
    expect(styleIds({ filler_k1: noul(0.69) })).toEqual([])
  })
})

describe('the counted half of the style coach', () => {
  it('reads a reply as running prose: no code, tool marks, links, headings, or list marks', () => {
    const prose = styleProse(
      '## Summary\n\n[tool result: bash: npm test - exit 0]\n\nGreat question! See `npm run check` and https://example.com/docs.\n\n```ts\nconst a = 1\n```\n\n- **Done** with it.'
    )
    expect(prose).not.toContain('Summary')
    expect(prose).not.toContain('tool result')
    expect(prose).not.toContain('npm run check')
    expect(prose).not.toContain('example.com')
    expect(prose).not.toContain('const a')
    expect(prose).toContain('Great question!')
    expect(prose).toContain('Done with it.')
  })

  it('takes an opener from the first sentence and skips plain answers and words with no style', () => {
    expect(openerKey('Great question! Closures keep their scope.')).toBe('great question')
    expect(openerKey('What a great question, honestly. Closures…')).toBe('what a great')
    expect(openerKey('Certainly! Here it is.')).toBe('certainly')
    expect(openerKey('Yes. It works.')).toBeNull()
    expect(openerKey('Here is the plan. Step one…')).toBeNull()
    expect(openerKey('   ')).toBeNull()
  })

  it('takes a closer from the last sentence of a reply that has more than one', () => {
    expect(closerKey("Volumes persist. Let me know if you'd like a compose example!")).toBe('let me know if')
    expect(closerKey('Paris.')).toBeNull()
    // Found live: a sign-off hung on a semicolon is still the closer.
    expect(closerKey('A stash shelves your changes; Happy to go deeper if you want!')).toBe('happy to go deeper')
  })

  it('reports an opener at the repeat count and not one under it', () => {
    const earlier = ['Great question! One.', 'Short answer: no.', 'Great question! Two.']
    const findings = countStyleRepeats({ reply: 'Great question! Three.', recentReplies: earlier, userMessages: [] })
    expect(findings).toEqual([
      { id: 'repeated_opener', lane: 'style_coach', source: 'counted', detail: 'great question', count: 3, window: 4 }
    ])
    expect(STYLE_COACH_THRESHOLDS.openerRepeats).toBe(2)
    expect(
      countStyleRepeats({ reply: 'Great question! Three.', recentReplies: ['Great question! One.', 'Short answer: no.'], userMessages: [] })
    ).toEqual([])
  })

  it('only looks back as far as the opener window', () => {
    const old = ['Great question! One.', 'Great question! Two.']
    const filler = Array.from({ length: STYLE_COACH_THRESHOLDS.openerWindow }, (_, index) => `Plain reply number ${index} here.`)
    expect(countStyleRepeats({ reply: 'Great question! Now.', recentReplies: [...old, ...filler], userMessages: [] })).toEqual([])
  })

  it('reports a repeated closer', () => {
    const earlier = ["It persists. Let me know if you'd like more.", "It is fine. Let me know if that helps."]
    const findings = countStyleRepeats({ reply: 'Volumes persist. Let me know if you want a compose file.', recentReplies: earlier, userMessages: [] })
    expect(findings.map((finding) => [finding.id, finding.detail, finding.count, finding.window])).toEqual([
      ['repeated_closer', 'let me know if', 3, 3]
    ])
  })

  it('reports a stock phrase once, at its fullest, and never the user\'s own words', () => {
    const earlier = [
      'This design is a testament to careful planning overall.',
      'The cache is a testament to careful planning again.',
      'Plain reply with nothing special inside of it.',
      'Honestly the API is a testament to careful planning too.'
    ]
    const reply = 'That migration is a testament to careful planning, truly.'
    const findings = countStyleRepeats({ reply, recentReplies: earlier, userMessages: [] })
    expect(findings).toEqual([
      {
        id: 'repeated_phrase',
        lane: 'style_coach',
        source: 'counted',
        detail: 'a testament to careful planning',
        count: 4,
        window: 5
      }
    ])
    // The same words in the user's recent messages are the topic, not the agent's habit.
    expect(
      countStyleRepeats({ reply, recentReplies: earlier, userMessages: ['Is this a testament to careful planning or luck?'] })
    ).toEqual([])
    // One repeat under the count is not a habit yet.
    expect(countStyleRepeats({ reply, recentReplies: earlier.slice(0, 3), userMessages: [] })).toEqual([])
  })

  it('never builds a phrase around a number, and honest repetition is only ever a CANDIDATE', () => {
    const earlier = ['Tests: 38 pass in total now.', 'Tests: 38 pass in total now.', 'Tests: 38 pass in total now.']
    const input = { reply: 'Tests: 38 pass in total now.', recentReplies: earlier, userMessages: [] }
    const phrases = countStyleRepeats(input).filter((finding) => finding.id === 'repeated_phrase')
    expect(phrases.map((finding) => finding.detail)).toEqual(['pass in total now'])
    // Counting cannot tell a status line from a habit of speech; the habit judgment can (probe: 0.43).
    const request = buildStyleCoachRequest(input)!
    const key = request.counted.find((entry) => entry.finding.detail === 'pass in total now')!.key
    expect(decideStyleCoach({ [`filler_${key}`]: noul(0.43) }, request).findings).toEqual([])
  })
})

describe('buildStyleCoachRequest and decideStyleCoach', () => {
  const input = {
    reply: 'Great question! Volumes live outside the container layer.',
    recentReplies: ['Oldest reply. Nothing here.', 'Great question! A closure keeps its scope.', 'Love this idea! Rebase it.'],
    userMessages: []
  }

  it('needs an earlier reply: a habit takes at least two', () => {
    expect(buildStyleCoachRequest({ ...input, recentReplies: [] })).toBeNull()
  })

  it('sends the new opener and the two before it, newest first, and asks about the habit only with two earlier replies', () => {
    const request = buildStyleCoachRequest(input)!
    expect(request.state.openers).toEqual({ o1: 'Great question!', o2: 'Love this idea!', o3: 'Great question!' })
    expect(request.openerKeys).toEqual(['o1', 'o2', 'o3'])
    expect(Object.keys(request.state.recent_replies)).toEqual(['p1', 'p2', 'p3'])
    expect(request.state.recent_replies.p1).toBe('Love this idea! Rebase it.')
    expect(request.questions.praise_o1).toEqual({
      type: 'noul',
      instructions: POST_TURN_CHECK_QUESTIONS.praise.instructions('o1'),
      criteria: POST_TURN_CHECK_QUESTIONS.praise.criteria
    })
    expect(request.askedSameMove).toBe(true)
    const one = buildStyleCoachRequest({ ...input, recentReplies: ['Great question! A closure keeps its scope.'] })!
    expect(one.askedSameMove).toBe(false)
    expect(one.questions.same_move).toBeUndefined()
  })

  // Two of the three earlier replies open the way the new one does: a counted opener, 3 of 4.
  const repeating = { ...input, recentReplies: ['Great question! One thing.', 'Short answer: no.', 'Great question! Two things.'] }

  it('sends each counted repeat with its own habit-of-speech question', () => {
    const request = buildStyleCoachRequest(repeating)!
    expect(request.counted.map((entry) => [entry.key, entry.finding.id, entry.finding.detail])).toEqual([
      ['k1', 'repeated_opener', 'great question']
    ])
    expect(request.state.repeats).toEqual({ k1: 'great question' })
    expect(request.questions.filler_k1).toEqual({
      type: 'noul',
      instructions: POST_TURN_CHECK_QUESTIONS.filler.instructions('k1'),
      criteria: POST_TURN_CHECK_QUESTIONS.filler.criteria
    })
    // Nothing counted: no `repeats` in the state and no such question.
    const plain = buildStyleCoachRequest({ ...input, reply: 'Volumes live outside the container layer.' })!
    expect(plain.state.repeats).toBeUndefined()
    expect(Object.keys(plain.questions).some((id) => id.startsWith('filler_'))).toBe(false)
  })

  it('reports a counted repeat only when Jev judged it a habit of speech, at the floor and not under it', () => {
    const request = buildStyleCoachRequest(repeating)!
    const floor = STYLE_COACH_THRESHOLDS.fillerFloor
    expect(decideStyleCoach({ filler_k1: noul(floor) }, request).findings).toEqual([
      { id: 'repeated_opener', lane: 'style_coach', source: 'counted', detail: 'great question', count: 3, window: 4, probability: floor }
    ])
    expect(decideStyleCoach({ filler_k1: noul(floor - 0.001) }, request).findings).toEqual([])
    // A missing answer reports nothing: a count alone is never enough.
    expect(decideStyleCoach({}, request).findings).toEqual([])
    // Subject matter probed at 0.57 at most and must stay under the floor.
    expect(floor).toBeGreaterThan(0.57)
  })

  it('flags praise only as a HABIT: this reply at the floor AND an earlier one', () => {
    const request = buildStyleCoachRequest(input)!
    const floor = STYLE_COACH_THRESHOLDS.praiseFloor
    const ids = (answers: Record<string, unknown>) => decideStyleCoach(answers, request).findings.map((finding) => finding.id)
    expect(ids({ praise_o1: noul(floor), praise_o2: noul(floor), praise_o3: noul(0.1), same_move: noul(0.1) })).toEqual(['praise_openers'])
    // One compliment is not a habit.
    expect(ids({ praise_o1: noul(0.98), praise_o2: noul(0.1), praise_o3: noul(0.1), same_move: noul(0.1) })).toEqual([])
    // Earlier praise without praise NOW is over.
    expect(ids({ praise_o1: noul(0.1), praise_o2: noul(0.98), praise_o3: noul(0.98), same_move: noul(0.1) })).toEqual([])
    expect(ids({ praise_o1: noul(floor - 0.001), praise_o2: noul(0.98), praise_o3: noul(0.98), same_move: noul(0.1) })).toEqual([])
  })

  it('flags the same habit at its floor and not under it', () => {
    const request = buildStyleCoachRequest(input)!
    const quiet = { praise_o1: noul(0.1), praise_o2: noul(0.1), praise_o3: noul(0.1) }
    const floor = STYLE_COACH_THRESHOLDS.sameMoveFloor
    expect(decideStyleCoach({ ...quiet, same_move: noul(floor) }, request).findings.map((f) => f.id)).toEqual(['same_move'])
    expect(decideStyleCoach({ ...quiet, same_move: noul(floor - 0.001) }, request).findings).toEqual([])
    // A plain repeated status format probed at 0.61 and must stay under the floor.
    expect(floor).toBeGreaterThan(0.61)
  })

  it('names every counted repeat and its habit reading in the decision line, reported or not', () => {
    const request = buildStyleCoachRequest(repeating)!
    const decision = decideStyleCoach({ praise_o1: noul(0.1), same_move: noul(0.1), filler_k1: noul(0.3) }, request)
    expect(decision.findings).toEqual([])
    expect(decision.summary).toContain('counted repeated_opener "great question" 3/4 habit 0.30')
    expect(decision.summary).toContain('nothing noted')
  })
})

describe('buildPostTurnCheckDcmLines', () => {
  const findings: JevJuicePostTurnFinding[] = [
    { id: 'claimed_action', lane: 'reply_check', source: 'inferred', probability: 0.91 },
    { id: 'silent_failure', lane: 'reply_check', source: 'inferred', probability: 0.97, detail: TESTS_FAIL.description },
    { id: 'repeated_opener', lane: 'style_coach', source: 'counted', detail: 'great question', count: 3, window: 6, probability: 0.89 }
  ]

  it('prints one section per lane, says where each line comes from, and never claims the reply was changed', () => {
    const lines = buildPostTurnCheckDcmLines({ findings }, { replyCheck: true, styleCoach: true })
    expect(lines[0]).toBe(REPLY_CHECK_DCM_HEADING)
    expect(lines[1]).toContain('no tool call in this chat accounts for it (0.91)')
    expect(lines[2]).toContain(`(0.97): ${TESTS_FAIL.description}`)
    expect(lines[3]).toBe('')
    expect(lines[4]).toBe(STYLE_COACH_DCM_HEADING)
    expect(lines[5]).toBe('- You opened 3 of your last 6 replies with "great question" (counted; a habit of speech 0.89).')
    expect(REPLY_CHECK_DCM_HEADING).toContain('your reply was not changed')
    expect(STYLE_COACH_DCM_HEADING).toContain('your reply was not changed')
  })

  it('prints only the lanes that are switched on NOW, and nothing at all for a clean record', () => {
    expect(buildPostTurnCheckDcmLines({ findings }, { replyCheck: false, styleCoach: true })[0]).toBe(STYLE_COACH_DCM_HEADING)
    expect(buildPostTurnCheckDcmLines({ findings }, { replyCheck: true, styleCoach: false })).toHaveLength(3)
    expect(buildPostTurnCheckDcmLines({ findings }, { replyCheck: false, styleCoach: false })).toEqual([])
    expect(buildPostTurnCheckDcmLines({ findings: [] }, { replyCheck: true, styleCoach: true })).toEqual([])
    expect(buildPostTurnCheckDcmLines(null, { replyCheck: true, styleCoach: true })).toEqual([])
  })
})

describe('computeReplyCheck', () => {
  it('makes no call and no record with the agent switch OFF, in every shape', async () => {
    const client = fakeClient({})
    for (const agent of [{ id: 'a' }, { id: 'a', jev_juice_reply_check: false }, { id: 'a', jev_juice_reply_check: 'true' }, { id: 'a', jev_juice_reply_check: null }]) {
      const outcome = await computeReplyCheck({ ...facts(), userId: 'josh', agent, client })
      expect(outcome).toEqual({ findings: [], record: null, note: null })
    }
    expect(client.calls).toHaveLength(0)
  })

  it('asks once under the after-reply budget and returns the findings with an Execution Viewer row', async () => {
    const client = fakeClient({ claimed: noul(0.93), promised: noul(0.02), multi_part: noul(0.05), unaddressed: noul(0.03) })
    const outcome = await computeReplyCheck({ ...facts(), userId: 'josh', agent: CHECK_AGENT, client })
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0].deadlineMs).toBe(POST_TURN_CHECK_LIMITS.deadlineMs)
    expect(outcome.findings).toEqual([{ id: 'claimed_action', lane: 'reply_check', source: 'inferred', probability: 0.93 }])
    expect(outcome.note).toBeNull()
    expect(outcome.record).toMatchObject({ feature: 'reply_check', status: 'ok', questionCount: 4 })
    expect(outcome.record?.decision).toContain('flagged claimed_action')
  })

  it('DL-120-11: with the master switch off it makes no call, flags nothing, and says so', async () => {
    configState.config = { ...configState.config, enabled: false }
    const client = fakeClient({ claimed: noul(0.99) })
    const outcome = await computeReplyCheck({ ...facts(), userId: 'josh', agent: CHECK_AGENT, client })
    expect(client.calls).toHaveLength(0)
    expect(outcome.findings).toEqual([])
    expect(outcome.record).toMatchObject({ feature: 'reply_check', status: 'unavailable', reason: 'master_off' })
    expect(outcome.note).toMatchObject({ feature: 'reply_check', status: 'unavailable', reason: 'master_off' })
  })

  it('a miss flags nothing, even when an answer would have', async () => {
    const client = fakeClient({}, { status: 'unavailable', reason: 'deadline', deadlineHit: true } as never)
    const outcome = await computeReplyCheck({ ...facts(), userId: 'josh', agent: CHECK_AGENT, client })
    expect(outcome.findings).toEqual([])
    expect(outcome.record).toMatchObject({ status: 'unavailable', reason: 'deadline', deadlineHit: true })
    expect(outcome.record?.decision).toContain('the reply was not checked')
    expect(outcome.note).toMatchObject({ feature: 'reply_check', reason: 'deadline' })
  })
})

describe('computeStyleCoach', () => {
  const style = {
    reply: 'Great question! Volumes live outside the container layer.',
    recentReplies: ['Great question! One thing.', 'Great question! Two things.'],
    userMessages: []
  }

  it('makes no call and no record with the agent switch OFF', async () => {
    const client = fakeClient({})
    expect(await computeStyleCoach({ ...style, userId: 'josh', agent: CHECK_AGENT, client })).toEqual({ findings: [], record: null, note: null })
    expect(client.calls).toHaveLength(0)
  })

  it('returns the counted and the judged findings together', async () => {
    const client = fakeClient({ praise_o1: noul(0.97), praise_o2: noul(0.96), praise_o3: noul(0.95), same_move: noul(0.92), filler_k1: noul(0.89) })
    const outcome = await computeStyleCoach({ ...style, userId: 'josh', agent: STYLE_AGENT, client })
    expect(client.calls).toHaveLength(1)
    expect((client.calls[0].state as { repeats?: Record<string, string> }).repeats).toEqual({ k1: 'great question' })
    expect(outcome.findings.map((finding) => [finding.id, finding.source])).toEqual([
      ['repeated_opener', 'counted'],
      ['praise_openers', 'inferred'],
      ['same_move', 'inferred']
    ])
    expect(outcome.record).toMatchObject({ feature: 'style_coach', status: 'ok' })
  })

  it('is all-or-nothing: a miss drops the counted repeats too, and says so', async () => {
    const client = fakeClient({}, { status: 'unavailable', reason: 'network' } as never)
    const outcome = await computeStyleCoach({ ...style, userId: 'josh', agent: STYLE_AGENT, client })
    expect(outcome.findings).toEqual([])
    expect(outcome.record?.decision).toContain('1 counted repeat is dropped with it')
    expect(outcome.note).toMatchObject({ feature: 'style_coach', reason: 'network' })
  })

  it('DL-120-11: with the master switch off it makes no call', async () => {
    configState.config = { ...configState.config, enabled: false }
    const client = fakeClient({})
    const outcome = await computeStyleCoach({ ...style, userId: 'josh', agent: STYLE_AGENT, client })
    expect(client.calls).toHaveLength(0)
    expect(outcome.findings).toEqual([])
    expect(outcome.record).toMatchObject({ reason: 'master_off' })
  })

  it('has nothing to judge on the first reply of a chat: no call, no record', async () => {
    const client = fakeClient({})
    expect(await computeStyleCoach({ ...style, recentReplies: [], userId: 'josh', agent: STYLE_AGENT, client })).toEqual({
      findings: [],
      record: null,
      note: null
    })
    expect(client.calls).toHaveLength(0)
  })
})
