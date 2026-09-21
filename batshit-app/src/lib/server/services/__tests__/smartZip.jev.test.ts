// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ZipCompression, ZipExposed } from '$lib/services/messageCompiler'
import type { TypesafeConfig } from '$lib/types/typesafe'
import type { TypesafeCallOutcome, TypesafeClient, TypesafeSystemOneRequest } from '../typesafe/typesafeClient'

/**
 * SA-120 P5 — smart zip's pre-turn lane: candidate selection, request shape, both floors at
 * their exact boundaries, both caps, which likely results Batshit OPENS and why it leaves the
 * others zipped (explicit beats inferred), the DCM lines (which tell the agent exactly what
 * Batshit did), and the orchestrator against a fake client — the ONE global switch, the
 * DL-120-11 master-off pin, no key, nothing zipped, a deadline miss. No network, no Redis:
 * the compiler seam is pinned by compile contract S25 and `messageCompiler.test.ts`, the
 * stored state by `zipStateInferred.test.ts`.
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
  JEV_JUICE_ZIPS_CLOSED_HEADING,
  JEV_JUICE_ZIPS_HEADING,
  SMART_ZIP_LIMITS,
  SMART_ZIP_OPEN_LIMITS,
  SMART_ZIP_POST_TURN_LIMITS,
  SMART_ZIP_POST_TURN_THRESHOLDS,
  SMART_ZIP_QUESTIONS,
  SMART_ZIP_THRESHOLDS,
  buildSmartZipClosedDcmLines,
  buildSmartZipDcmLines,
  buildSmartZipPostTurnRequest,
  buildSmartZipRequest,
  clipSmartZipMessage,
  computeSmartZipHints,
  computeSmartZipRezips,
  decideSmartZipHints,
  decideSmartZipOpens,
  decideSmartZipRezips,
  jevJuiceZipsOpenedHeading,
  selectSmartZipCandidates,
  selectSmartZipPostTurnCandidates,
  type SmartZipCandidate,
  type SmartZipNewResult
} from '../smartZip.jev'

/** A zipped tool result as the compiler reports it; every one names its own target unless a case says otherwise. */
function zip(zipId: string, description: string, overrides: Partial<ZipCompression> = {}): ZipCompression {
  return {
    zipId,
    zipType: 'cool_tool',
    description,
    descriptionParts: { label: 'read_file', target: `target-of-${zipId}`, status: '' },
    tokens: 1200,
    operationKind: 'read_file',
    toolName: 'read_file',
    forceCompress: false,
    rezipped: false,
    rezippedBy: null,
    groupUnshared: false,
    messagesFromEnd: 3,
    ...overrides
  }
}

const ZIPPED = [
  zip('zip_aaa', 'read_file: src/lib/goons/cueParser.ts - 412 lines'),
  zip('zip_bbb', 'bash: npm run check - exit 0 - 3 lines', { operationKind: 'bash', toolName: 'bash', tokens: 40 }),
  zip('zip_ccc', 'read_file: docs/user-docs/voice/overview.md - 210 lines')
]
const SWITCH_ON = { zip_tool_notes_enabled: true, jev_juice_smart_zip: true }
const SWITCH_OFF = { zip_tool_notes_enabled: true }
const AGENT = { id: 'agent-1', user_id: 'josh', name: 'Lucy' }

function noulAnswers(values: Record<string, number>) {
  return Object.fromEntries(Object.entries(values).map(([key, noul]) => [`need_${key}`, { type: 'noul', noul }]))
}

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
        response: { model: 'jev-1.13.0', answers, usage: { inputTokens: 900, outputTokens: 60 } },
        latencyMs: 190,
        attempts: 1,
        deadlineHit: false,
        httpStatus: 200,
        requestChars: 2400,
        ...outcome
      } as never
    }
  }
}

beforeEach(() => {
  retrieve.mockReset()
  retrieve.mockResolvedValue('user-key')
  dynamicPrivateEnv.env = {}
  configState.config = { enabled: true, modelId: 'jev-1.13.0', attemptTimeoutMs: 5000, inChatWaitMs: 750, screenIncomingText: false, updatedAt: null }
})

describe('selectSmartZipCandidates', () => {
  it('keeps described tool results in chat order under short keys', () => {
    const { candidates, eligible, foldedRepeats } = selectSmartZipCandidates(ZIPPED)
    expect(eligible).toBe(3)
    expect(foldedRepeats).toBe(0)
    expect(candidates.map((candidate) => [candidate.key, candidate.zipId])).toEqual([
      ['z1', 'zip_aaa'],
      ['z2', 'zip_bbb'],
      ['z3', 'zip_ccc']
    ])
    expect(candidates[1]).toMatchObject({ description: 'bash: npm run check - exit 0 - 3 lines', tokens: 40, forceCompress: false, rezippedBy: null })
  })

  it('drops what is not a tool result, has no description, is a fetch-zip peek, repeats, or belongs to another group agent', () => {
    const { candidates, eligible } = selectSmartZipCandidates([
      zip('zip_img', 'image - 1 item', { zipType: 'image' }),
      zip('zip_err', 'error - 12 lines', { zipType: 'error' }),
      zip('zip_blank', '   '),
      zip('zip_peek', 'fetch_zip: zip_aaa - 1 item', { operationKind: 'fetch_zip', toolName: 'fetch_zip' }),
      zip('zip_peek2', 'fetch_zip: zip_bbb - 1 item', { operationKind: undefined, toolName: 'fetch_zip' }),
      zip('zip_other', 'read_file: secret.md - 9 lines', { groupUnshared: true }),
      zip('zip_aaa', 'read_file: a.ts - 1 line'),
      zip('zip_aaa', 'read_file: a.ts - 1 line')
    ])
    expect(eligible).toBe(1)
    expect(candidates.map((candidate) => candidate.zipId)).toEqual(['zip_aaa'])
  })

  it('judges the NEWEST results when a session holds more than the cap, and says how many exist', () => {
    const many = Array.from({ length: SMART_ZIP_LIMITS.maxCandidates + 5 }, (_, index) =>
      zip(`zip_${index}`, `read_file: file${index}.ts - 10 lines`)
    )
    const { candidates, eligible } = selectSmartZipCandidates(many)
    expect(eligible).toBe(SMART_ZIP_LIMITS.maxCandidates + 5)
    expect(candidates).toHaveLength(SMART_ZIP_LIMITS.maxCandidates)
    expect(candidates[0]).toMatchObject({ key: 'z1', zipId: 'zip_5' })
    expect(candidates.at(-1)?.zipId).toBe(`zip_${SMART_ZIP_LIMITS.maxCandidates + 4}`)
  })

  it('folds older repeats of the same tool call, target, and outcome into the newest run', () => {
    const parts = (label: string, target: string, status = '') => ({ descriptionParts: { label, target, status } })
    const { candidates, eligible, foldedRepeats } = selectSmartZipCandidates([
      zip('zip_log_old', 'bash: git log --oneline -5 - error - 11 lines', parts('bash', 'git log --oneline -5', 'error')),
      zip('zip_read_old', 'read_file: src/a.ts - 120 lines', parts('read_file', 'src/a.ts')),
      zip('zip_test_fail', 'bash: npm run test - exit 1 - 214 lines', parts('bash', 'npm run test', 'exit 1')),
      zip('zip_log_new', 'bash: git log --oneline -5 - error - 1 line', parts('bash', 'git log --oneline -5', 'error')),
      zip('zip_test_pass', 'bash: npm run test - exit 0 - 38 lines', parts('bash', 'npm run test', 'exit 0')),
      zip('zip_read_new', 'read_file: src/a.ts - 126 lines', parts('read_file', 'src/a.ts')),
      // No stored target: never folded, however alike two of them read.
      zip('zip_cal_1', 'mcp_google_calendar_list_events - 12 events', { operationKind: 'dynamic_use', descriptionParts: { label: 'mcp_google_calendar_list_events', target: '', status: '' } }),
      zip('zip_cal_2', 'mcp_google_calendar_list_events - 12 events', { operationKind: 'dynamic_use', descriptionParts: { label: 'mcp_google_calendar_list_events', target: '', status: '' } })
    ])
    // The newest run stands for its repeats, in its own chat position; a DIFFERENT outcome
    // is a different result ("why did it fail the first time?" needs the failed run).
    expect(candidates.map((candidate) => candidate.zipId)).toEqual([
      'zip_test_fail',
      'zip_log_new',
      'zip_test_pass',
      'zip_read_new',
      'zip_cal_1',
      'zip_cal_2'
    ])
    expect(eligible).toBe(6)
    expect(foldedRepeats).toBe(2)
  })

  it('drops a built-in file or shell result that names no target, and keeps a target-less result whose label is the information', () => {
    const { candidates } = selectSmartZipCandidates([
      // What a brokered zip fetch leaves behind on the API lane (F-P5-2): the inner tool's name and nothing else.
      zip('zip_copy', 'bash - 9 lines', { operationKind: 'bash', toolName: 'bash', descriptionParts: { label: 'bash', target: '', status: '' } }),
      zip('zip_bare', 'read_file - 1 line', { descriptionParts: undefined }),
      zip('zip_cal', 'mcp_google_calendar_list_events - 12 events', {
        operationKind: 'dynamic_use',
        toolName: 'mcp_google_calendar_list_events',
        descriptionParts: { label: 'mcp_google_calendar_list_events', target: '', status: '' }
      }),
      zip('zip_unknown', 'weather_lookup - 3 lines', { operationKind: undefined, toolName: 'weather_lookup', descriptionParts: undefined }),
      zip('zip_named', 'bash: git status --short - exit 0 - 9 lines', {
        operationKind: 'bash',
        toolName: 'bash',
        descriptionParts: { label: 'bash', target: 'git status --short', status: 'exit 0' }
      })
    ])
    expect(candidates.map((candidate) => candidate.zipId)).toEqual(['zip_cal', 'zip_unknown', 'zip_named'])
  })

  it('carries the oversized safety flag and clips a pathological description', () => {
    const { candidates } = selectSmartZipCandidates([
      zip('zip_big', `read_file: ${'x'.repeat(900)}`, { forceCompress: true, tokens: 41_000.4 })
    ])
    expect(candidates[0].forceCompress).toBe(true)
    expect(candidates[0].tokens).toBe(41_000)
    expect(candidates[0].description.length).toBe(SMART_ZIP_LIMITS.maxDescriptionChars)
  })
})

describe('buildSmartZipRequest', () => {
  it('asks one Noul per zipped result over a state of the message and short-keyed descriptions', () => {
    const built = buildSmartZipRequest('  make the cue fire\nearlier  ', ZIPPED)
    expect(built?.state).toEqual({
      message: 'make the cue fire earlier',
      zipped: {
        z1: 'read_file: src/lib/goons/cueParser.ts - 412 lines',
        z2: 'bash: npm run check - exit 0 - 3 lines',
        z3: 'read_file: docs/user-docs/voice/overview.md - 210 lines'
      }
    })
    expect(Object.keys(built?.questions ?? {})).toEqual(['need_z1', 'need_z2', 'need_z3'])
    expect(built?.questions.need_z2).toEqual({
      type: 'noul',
      instructions: SMART_ZIP_QUESTIONS.needed.instructions('z2'),
      criteria: SMART_ZIP_QUESTIONS.needed.criteria
    })
    expect(String(built?.questions.need_z2.instructions)).toContain('`zipped.z2`')
    expect(String(built?.questions.need_z2.instructions)).toContain('`message`')
    // Real zip ids stay home.
    expect(JSON.stringify({ state: built?.state, questions: built?.questions })).not.toContain('zip_aaa')
  })

  it('has nothing to ask without a message or a zipped tool result, and clips a long message', () => {
    expect(buildSmartZipRequest('   ', ZIPPED)).toBeNull()
    expect(buildSmartZipRequest('hello', [])).toBeNull()
    expect(buildSmartZipRequest('hello', [zip('zip_img', 'image', { zipType: 'image' })])).toBeNull()
    expect(buildSmartZipRequest('hello', [ZIPPED[0]])?.candidates).toHaveLength(1)
    expect(clipSmartZipMessage('x'.repeat(9000)).length).toBe(SMART_ZIP_LIMITS.maxMessageChars)
  })
})

describe('decideSmartZipHints', () => {
  const request = buildSmartZipRequest('make the cue fire earlier', ZIPPED)!

  it('sorts answers into the likely tier and the related band, best first', () => {
    const decision = decideSmartZipHints(noulAnswers({ z1: 0.84, z2: 0.07, z3: 0.38 }), request)
    expect(decision.likely.map((hint) => [hint.candidate.zipId, hint.probability])).toEqual([['zip_aaa', 0.84]])
    expect(decision.opened.map((hint) => hint.candidate.zipId)).toEqual(['zip_aaa'])
    expect(decision.notOpened).toEqual([])
    expect(decision.related.map((hint) => [hint.candidate.zipId, hint.probability])).toEqual([['zip_ccc', 0.38]])
    expect(decision.summary).toBe(
      'judged 3 zipped results; top zip_aaa 0.84, zip_ccc 0.38, zip_bbb 0.07 → opened 1 for 2 messages (about 1200 tokens, source inferred); named 1 related; floors 0.60 / 0.30'
    )
  })

  it('holds the likely floor at its exact boundary', () => {
    const at = decideSmartZipHints(noulAnswers({ z1: SMART_ZIP_THRESHOLDS.likelyFloor, z2: 0, z3: 0 }), request)
    expect(at.likely.map((hint) => hint.candidate.zipId)).toEqual(['zip_aaa'])
    expect(at.related).toEqual([])
    const under = decideSmartZipHints(noulAnswers({ z1: SMART_ZIP_THRESHOLDS.likelyFloor - 0.01, z2: 0, z3: 0 }), request)
    expect(under.likely).toEqual([])
    expect(under.related.map((hint) => hint.candidate.zipId)).toEqual(['zip_aaa'])
    // The floor itself is the number the design record and the probe settled on.
    expect(SMART_ZIP_THRESHOLDS.likelyFloor).toBe(0.6)
  })

  it('holds the related floor at its exact boundary', () => {
    const at = decideSmartZipHints(noulAnswers({ z1: SMART_ZIP_THRESHOLDS.relatedFloor, z2: 0, z3: 0 }), request)
    expect(at.related.map((hint) => hint.candidate.zipId)).toEqual(['zip_aaa'])
    const under = decideSmartZipHints(noulAnswers({ z1: SMART_ZIP_THRESHOLDS.relatedFloor - 0.01, z2: 0, z3: 0 }), request)
    expect(under.likely).toEqual([])
    expect(under.related).toEqual([])
    expect(under.summary).toContain('none at or over 0.30 → no hint, nothing opened')
    expect(SMART_ZIP_THRESHOLDS.relatedFloor).toBe(0.3)
  })

  it('caps each tier on its own and says so', () => {
    const many = Array.from({ length: 9 }, (_, index) => zip(`zip_${index}`, `read_file: f${index}.ts - 1 line`))
    const bigRequest = buildSmartZipRequest('everything', many)!
    const values: Record<string, number> = {}
    // Five over the likely floor, four in the related band.
    for (let index = 0; index < 5; index++) values[`z${index + 1}`] = 0.95 - index * 0.05
    for (let index = 5; index < 9; index++) values[`z${index + 1}`] = 0.55 - (index - 5) * 0.05
    const decision = decideSmartZipHints(noulAnswers(values), bigRequest)
    expect(decision.likely.map((hint) => hint.candidate.zipId)).toEqual(['zip_0', 'zip_1', 'zip_2'])
    expect(decision.related.map((hint) => hint.candidate.zipId)).toEqual(['zip_5', 'zip_6', 'zip_7'])
    expect(decision.likely).toHaveLength(SMART_ZIP_THRESHOLDS.maxLikely)
    expect(decision.related).toHaveLength(SMART_ZIP_THRESHOLDS.maxRelated)
    // A likely result the cap dropped never slides down into the related band.
    expect(decision.related.map((hint) => hint.candidate.zipId)).not.toContain('zip_3')
    expect(decision.summary).toContain('5 likely, cap 3')
    expect(decision.summary).toContain('4 related, cap 3')
    expect(SMART_ZIP_THRESHOLDS.maxLikely).toBe(3)
    expect(SMART_ZIP_THRESHOLDS.maxRelated).toBe(3)
  })

  it('never hints a result whose answer is missing or unreadable, and still reads the rest', () => {
    const decision = decideSmartZipHints(
      { need_z1: { type: 'noul', noul: 0.9 }, need_z2: { type: 'choice', choice: 'x' }, need_z3: { type: 'noul', noul: Number.NaN } },
      request
    )
    expect(decision.likely.map((hint) => hint.candidate.zipId)).toEqual(['zip_aaa'])
    expect(decision.readings.map((reading) => reading.probability)).toEqual([0.9, null, null])
    expect(decision.summary).toContain('2 unreadable')
  })

  it('keeps chat order between equal answers', () => {
    const decision = decideSmartZipHints(noulAnswers({ z1: 0.7, z2: 0.7, z3: 0.7 }), request)
    expect(decision.likely.map((hint) => hint.candidate.zipId)).toEqual(['zip_aaa', 'zip_bbb', 'zip_ccc'])
  })
})

describe('decideSmartZipOpens', () => {
  const hint = (zipId: string, probability: number, overrides: Partial<SmartZipCandidate> = {}) => ({
    candidate: { zipId, key: zipId, description: `read_file: ${zipId}.ts - 10 lines`, tokens: 1000, forceCompress: false, rezippedBy: null, ...overrides },
    probability
  })

  it('opens the best likely results, at most the cap, and names the rest with the reason', () => {
    const { opened, notOpened } = decideSmartZipOpens([hint('a', 0.9), hint('b', 0.8), hint('c', 0.7)])
    expect(opened.map((entry) => entry.candidate.zipId)).toEqual(['a', 'b'])
    expect(notOpened.map((entry) => [entry.candidate.zipId, entry.reason])).toEqual([['c', 'open_cap']])
    expect(SMART_ZIP_OPEN_LIMITS.maxOpen).toBe(2)
  })

  it('explicit beats inferred: never reopens what the user or the agent zipped by hand, but may reopen its own rezip', () => {
    const { opened, notOpened } = decideSmartZipOpens([
      hint('user_zip', 0.95, { rezippedBy: 'user' }),
      hint('agent_zip', 0.9, { rezippedBy: 'agent' }),
      hint('own_zip', 0.85, { rezippedBy: 'inferred' })
    ])
    expect(opened.map((entry) => entry.candidate.zipId)).toEqual(['own_zip'])
    expect(notOpened.map((entry) => [entry.candidate.zipId, entry.reason])).toEqual([
      ['user_zip', 'zipped_by_hand'],
      ['agent_zip', 'zipped_by_hand']
    ])
  })

  it('never opens an oversized safety row: an unzip cannot expand it', () => {
    const { opened, notOpened } = decideSmartZipOpens([hint('big', 0.99, { forceCompress: true, tokens: 41_000 }), hint('small', 0.7)])
    expect(opened.map((entry) => entry.candidate.zipId)).toEqual(['small'])
    expect(notOpened.map((entry) => [entry.candidate.zipId, entry.reason])).toEqual([['big', 'oversized']])
  })

  it('holds the token budget at its exact boundary, and a result that does not fit does not block a smaller one', () => {
    const budget = SMART_ZIP_OPEN_LIMITS.maxOpenTokens
    const exact = decideSmartZipOpens([hint('a', 0.9, { tokens: budget - 1000 }), hint('b', 0.8, { tokens: 1000 })])
    expect(exact.opened.map((entry) => entry.candidate.zipId)).toEqual(['a', 'b'])
    const over = decideSmartZipOpens([hint('a', 0.9, { tokens: budget - 1000 }), hint('b', 0.8, { tokens: 1001 }), hint('c', 0.7, { tokens: 900 })])
    expect(over.opened.map((entry) => entry.candidate.zipId)).toEqual(['a', 'c'])
    expect(over.notOpened.map((entry) => [entry.candidate.zipId, entry.reason])).toEqual([['b', 'over_budget']])
    expect(budget).toBe(10_000)
    expect(SMART_ZIP_OPEN_LIMITS.durationMessages).toBe(2)
  })
})

describe('buildSmartZipDcmLines', () => {
  const request = buildSmartZipRequest('make the cue fire earlier', [
    ...ZIPPED,
    zip('zip_big', 'read_file: send-routed/+server.ts - 4000 lines', { forceCompress: true, tokens: 41_000 }),
    zip('zip_mine', 'read_file: notes.md - 12 lines', { rezipped: true, rezippedBy: 'agent', tokens: 90 })
  ])!

  it('tells the agent exactly what Batshit did: what it unzipped, what it only names and why, with real zip ids', () => {
    const decision = decideSmartZipHints(noulAnswers({ z1: 0.84, z2: 0.07, z3: 0.38, z4: 0.66, z5: 0.71 }), request)
    expect(buildSmartZipDcmLines(decision, { fetchZipEnabled: true })).toEqual([
      jevJuiceZipsOpenedHeading(1),
      '- Unzipped for you (inferred): zip_aaa | read_file: src/lib/goons/cueParser.ts - 412 lines | about 1200 tokens | 0.84 | its full content is in this prompt, and it zips again by itself after 2 messages (zip control, when you have it, closes it sooner)',
      '- Likely needed, not unzipped (you or the user zipped it by hand, and Batshit does not undo that): zip_mine | read_file: notes.md - 12 lines | about 90 tokens | 0.71',
      '- Likely needed, not unzipped (oversized: it stays zipped even if unzipped, so fetch it): zip_big | read_file: send-routed/+server.ts - 4000 lines | about 41000 tokens | 0.66',
      '- Possibly related: zip_ccc | read_file: docs/user-docs/voice/overview.md - 210 lines | about 1200 tokens | 0.38',
      '- To read one that is still zipped, fetch it by its zip ID (a peek; zip state stays as it is). Zip control, when you have it, keeps one open for later turns.'
    ])
    expect(jevJuiceZipsOpenedHeading(1)).toContain('Batshit unzipped 1 of them for you and changed nothing else')
  })

  it('says Batshit unzipped nothing when it opened nothing', () => {
    const decision = decideSmartZipHints(noulAnswers({ z1: 0.1, z2: 0, z3: 0.38, z4: 0.66, z5: 0 }), request)
    const lines = buildSmartZipDcmLines(decision, { fetchZipEnabled: true })
    expect(lines[0]).toBe(JEV_JUICE_ZIPS_HEADING)
    expect(JEV_JUICE_ZIPS_HEADING).toContain('Batshit unzipped nothing')
    expect(JEV_JUICE_ZIPS_HEADING).toContain('ignore any that do not fit')
    expect(lines.join('\n')).not.toContain('Unzipped for you')
  })

  it('adds no how-to line when everything it names is already open', () => {
    const decision = decideSmartZipHints(noulAnswers({ z1: 0.84, z2: 0, z3: 0, z4: 0, z5: 0 }), request)
    expect(buildSmartZipDcmLines(decision, { fetchZipEnabled: true })).toHaveLength(2)
  })

  it('never tells an agent without Fetch Zip to fetch', () => {
    const decision = decideSmartZipHints(noulAnswers({ z1: 0, z2: 0, z3: 0.4, z4: 0, z5: 0 }), request)
    const lines = buildSmartZipDcmLines(decision, { fetchZipEnabled: false })
    expect(lines.at(-1)).toContain('Fetch Zip is off for you')
    expect(lines.join('\n')).not.toContain('fetch it by its zip ID')
  })

  it('costs no bytes on a quiet turn', () => {
    const decision = decideSmartZipHints(noulAnswers({ z1: 0.1, z2: 0.02, z3: 0.2, z4: 0.29, z5: 0 }), request)
    expect(buildSmartZipDcmLines(decision, { fetchZipEnabled: true })).toEqual([])
  })
})

describe('buildSmartZipClosedDcmLines', () => {
  it('tells the agent what Batshit zipped after its last reply, and is empty when there is nothing to tell', () => {
    expect(buildSmartZipClosedDcmLines([])).toEqual([])
    expect(
      buildSmartZipClosedDcmLines([{ zipId: 'zip_aaa', description: 'read_file: package.json - 142 lines', done: 0.91 }])
    ).toEqual([
      JEV_JUICE_ZIPS_CLOSED_HEADING,
      '- Zipped for you (inferred): zip_aaa | read_file: package.json - 142 lines | done with it 0.91'
    ])
    expect(JEV_JUICE_ZIPS_CLOSED_HEADING).toContain('fetch or unzip one if that was wrong')
  })
})

describe('computeSmartZipHints', () => {
  it('with the global switch OFF asks nothing and writes no record', async () => {
    const client = fakeClient({})
    for (const settings of [SWITCH_OFF, null, undefined, { jev_juice_smart_zip: 'true' }, { jev_juice_smart_zip: 1 }]) {
      const outcome = await computeSmartZipHints({
        userId: 'josh',
        agent: AGENT,
        globalZipSettings: settings as never,
        message: 'make the cue fire earlier',
        zippedItems: ZIPPED,
        client
      })
      expect(outcome).toEqual({ lines: [], opens: [], record: null, note: null, decision: null })
    }
    expect(client.calls).toHaveLength(0)
  })

  it('ON: one call under the compile-lane deadline, hint lines, an Execution Viewer row, no note', async () => {
    const client = fakeClient(noulAnswers({ z1: 0.84, z2: 0.07, z3: 0.38 }))
    const outcome = await computeSmartZipHints({
      userId: 'josh',
      agent: AGENT,
      globalZipSettings: SWITCH_ON,
      message: 'make the cue fire earlier',
      zippedItems: ZIPPED,
      client
    })
    expect(client.calls).toHaveLength(1)
    // The send waits on this call, so the budget is the user's In-Chat Wait Limit (SA-120 P8).
    expect(client.calls[0].deadlineMs).toBe(configState.config.inChatWaitMs)
    expect(client.calls[0].deadlineMs).toBe(750)
    expect(client.calls[0].model).toBe('jev-1.13.0')
    expect(client.calls[0].state).toEqual({
      message: 'make the cue fire earlier',
      zipped: {
        z1: 'read_file: src/lib/goons/cueParser.ts - 412 lines',
        z2: 'bash: npm run check - exit 0 - 3 lines',
        z3: 'read_file: docs/user-docs/voice/overview.md - 210 lines'
      }
    })
    expect(outcome.lines[0]).toBe(jevJuiceZipsOpenedHeading(1))
    expect(outcome.lines).toHaveLength(4)
    // What the compiler overlays and the route later stores: the opened result, as Jev judged it.
    expect(outcome.opens).toEqual([
      { zipId: 'zip_aaa', description: 'read_file: src/lib/goons/cueParser.ts - 412 lines', tokens: 1200, probability: 0.84, durationMessages: 2 }
    ])
    expect(outcome.note).toBeNull()
    expect(outcome.record).toMatchObject({
      feature: 'smart_zip',
      status: 'ok',
      questionCount: 3,
      usage: { inputTokens: 900, outputTokens: 60 },
      decision:
        'judged 3 zipped results; top zip_aaa 0.84, zip_ccc 0.38, zip_bbb 0.07 → opened 1 for 2 messages (about 1200 tokens, source inferred); named 1 related; floors 0.60 / 0.30'
    })
  })

  it('tailors the how-to line to the agent\'s own Fetch Zip toggle', async () => {
    const client = fakeClient(noulAnswers({ z1: 0.4, z2: 0, z3: 0 }))
    const outcome = await computeSmartZipHints({
      userId: 'josh',
      agent: { ...AGENT, provider_specific_settings: { nativeTools: { fetchZipEnabled: false } } },
      globalZipSettings: SWITCH_ON,
      message: 'make the cue fire earlier',
      zippedItems: ZIPPED,
      client
    })
    expect(outcome.lines.at(-1)).toContain('Fetch Zip is off for you')
  })

  it('with the master switch off (DL-120-11) makes no call and says so', async () => {
    configState.config = { ...configState.config, enabled: false }
    const client = fakeClient({})
    const outcome = await computeSmartZipHints({
      userId: 'josh',
      agent: AGENT,
      globalZipSettings: SWITCH_ON,
      message: 'make the cue fire earlier',
      zippedItems: ZIPPED,
      client
    })
    expect(client.calls).toHaveLength(0)
    expect(outcome.lines).toEqual([])
    expect(outcome.opens).toEqual([])
    expect(outcome.record).toMatchObject({ feature: 'smart_zip', status: 'unavailable', reason: 'master_off' })
    expect(outcome.note).toMatchObject({ feature: 'smart_zip', status: 'unavailable', reason: 'master_off' })
  })

  it('with no key makes no call and says so', async () => {
    retrieve.mockResolvedValue(null)
    const client = fakeClient({})
    const outcome = await computeSmartZipHints({
      userId: 'josh',
      agent: AGENT,
      globalZipSettings: SWITCH_ON,
      message: 'make the cue fire earlier',
      zippedItems: ZIPPED,
      client
    })
    expect(client.calls).toHaveLength(0)
    expect(outcome.note).toMatchObject({ reason: 'no_key' })
  })

  it('asks nothing in a chat with nothing zipped yet', async () => {
    const client = fakeClient({})
    const outcome = await computeSmartZipHints({
      userId: 'josh',
      agent: AGENT,
      globalZipSettings: SWITCH_ON,
      message: 'hello',
      zippedItems: [],
      client
    })
    expect(client.calls).toHaveLength(0)
    expect(outcome).toEqual({ lines: [], opens: [], record: null, note: null, decision: null })
  })

  it('a missed deadline omits the lines and leaves the inline note; the send is never failed', async () => {
    const client = fakeClient({}, { status: 'unavailable', reason: 'deadline', deadlineHit: true, response: undefined } as never)
    const outcome = await computeSmartZipHints({
      userId: 'josh',
      agent: AGENT,
      globalZipSettings: SWITCH_ON,
      message: 'make the cue fire earlier',
      zippedItems: ZIPPED,
      client
    })
    expect(outcome.lines).toEqual([])
    // A miss opens nothing: today's zip rules stand.
    expect(outcome.opens).toEqual([])
    expect(outcome.decision).toBeNull()
    expect(outcome.record).toMatchObject({ feature: 'smart_zip', status: 'unavailable', reason: 'deadline', deadlineHit: true })
    expect(outcome.note).toMatchObject({ feature: 'smart_zip', reason: 'deadline' })
  })

  it('says in the record when older repeats were folded', async () => {
    const parts = { descriptionParts: { label: 'bash', target: 'git log --oneline -5', status: 'error' } }
    const client = fakeClient(noulAnswers({ z1: 0.84 }))
    const outcome = await computeSmartZipHints({
      userId: 'josh',
      agent: AGENT,
      globalZipSettings: SWITCH_ON,
      message: 'which commit is newest in the git log you just got?',
      zippedItems: [
        zip('zip_log_old', 'bash: git log --oneline -5 - error - 11 lines', parts),
        zip('zip_log_new', 'bash: git log --oneline -5 - error - 1 line', parts)
      ],
      client
    })
    expect(client.calls[0].state).toEqual({
      message: 'which commit is newest in the git log you just got?',
      zipped: { z1: 'bash: git log --oneline -5 - error - 1 line' }
    })
    expect(outcome.lines[1]).toContain('Unzipped for you (inferred): zip_log_new')
    expect(outcome.opens.map((open) => open.zipId)).toEqual(['zip_log_new'])
    expect(outcome.record?.detail).toBe('1 older repeat of the same tool call folded into the newest run')
  })

  it('says in the record when the oldest results were left out', async () => {
    const many = Array.from({ length: SMART_ZIP_LIMITS.maxCandidates + 7 }, (_, index) =>
      zip(`zip_${index}`, `read_file: file${index}.ts - 10 lines`)
    )
    const client = fakeClient({})
    const outcome = await computeSmartZipHints({
      userId: 'josh',
      agent: AGENT,
      globalZipSettings: SWITCH_ON,
      message: 'hello',
      zippedItems: many,
      client
    })
    expect(Object.keys(client.calls[0].questions)).toHaveLength(SMART_ZIP_LIMITS.maxCandidates)
    expect(outcome.record?.detail).toBe(`the oldest 7 zipped results were not judged (cap ${SMART_ZIP_LIMITS.maxCandidates})`)
    expect(outcome.record?.decision).toContain(`judged the newest ${SMART_ZIP_LIMITS.maxCandidates} of ${SMART_ZIP_LIMITS.maxCandidates + 7} zipped results`)
  })
})

// ---------------------------------------------------------------------------
// After the reply (step 3)
// ---------------------------------------------------------------------------

function exposed(zipId: string, overrides: Partial<ZipExposed> = {}): ZipExposed {
  return {
    zipId,
    zipType: 'cool_tool',
    description: `read_file: ${zipId}.ts - 40 lines`,
    descriptionParts: { label: 'read_file', target: `${zipId}.ts`, status: '' },
    tokens: 900,
    operationKind: 'read_file',
    toolName: 'read_file',
    unzippedBy: null,
    recoveryHold: false,
    messagesFromEnd: 0,
    bufferSize: 2,
    autoZip: false,
    zipDisabled: false,
    ...overrides
  }
}

function fresh(zipId: string, overrides: Partial<SmartZipNewResult> = {}): SmartZipNewResult {
  return {
    zipId,
    zipType: 'cool_tool',
    description: `read_file: ${zipId}.ts - 40 lines`,
    descriptionParts: { label: 'read_file', target: `${zipId}.ts`, status: '' },
    tokens: 700,
    operationKind: 'read_file',
    toolName: 'read_file',
    expandedNextTurn: true,
    ...overrides
  }
}

const postAnswers = (values: Record<string, [number, number]>) =>
  Object.fromEntries(
    Object.entries(values).flatMap(([key, [done, again]]) => [
      [`done_${key}`, { type: 'noul', noul: done }],
      [`again_${key}`, { type: 'noul', noul: again }]
    ])
  )

describe('selectSmartZipPostTurnCandidates', () => {
  it('asks only about results that would stay open into the next turn and that Jev may close', () => {
    const candidates = selectSmartZipPostTurnCandidates(
      [
        exposed('stays_open'),
        // One more reply and the buffer closes it anyway: not worth a question.
        exposed('ages_out', { messagesFromEnd: 1, bufferSize: 2 }),
        // Explicit beats inferred: a pin, a lock, an agent's own choice, a recovery hold, an Off lane.
        exposed('user_pin', { unzippedBy: 'user' }),
        exposed('agent_kept', { unzippedBy: 'agent' }),
        exposed('held', { recoveryHold: true }),
        exposed('lane_off', { zipDisabled: true }),
        // Jev's own temporary unzip may be closed early.
        exposed('jev_opened', { unzippedBy: 'inferred', messagesFromEnd: 9, bufferSize: 0 }),
        exposed('an_image', { zipType: 'image' }),
        exposed('a_peek', { operationKind: 'fetch_zip', toolName: 'fetch_zip' }),
        exposed('no_target', { operationKind: 'bash', descriptionParts: { label: 'bash', target: '', status: '' } })
      ],
      [fresh('new_normal'), fresh('new_auto', { expandedNextTurn: false }), fresh('stays_open')]
    )
    expect(candidates.map((candidate) => [candidate.key, candidate.zipId, candidate.openedBy])).toEqual([
      ['r1', 'stays_open', 'buffer'],
      ['r2', 'jev_opened', 'inferred'],
      ['r3', 'new_normal', 'buffer']
    ])
  })

  it('keeps the newest when more are open than the cap', () => {
    const many = Array.from({ length: SMART_ZIP_POST_TURN_LIMITS.maxCandidates + 3 }, (_, index) => exposed(`open_${index}`))
    const candidates = selectSmartZipPostTurnCandidates(many, [])
    expect(candidates).toHaveLength(SMART_ZIP_POST_TURN_LIMITS.maxCandidates)
    expect(candidates[0]).toMatchObject({ key: 'r1', zipId: 'open_3' })
  })
})

describe('buildSmartZipPostTurnRequest', () => {
  it('asks two Nouls per open result over the request, the finished reply, and short-keyed descriptions', () => {
    const candidates = selectSmartZipPostTurnCandidates([exposed('pkg')], [])
    const built = buildSmartZipPostTurnRequest('  which vitest\nversion?  ', ' It asks for ^4.1.2. ', candidates)
    expect(built?.state).toEqual({
      request: 'which vitest version?',
      reply: 'It asks for ^4.1.2.',
      results: { r1: 'read_file: pkg.ts - 40 lines' }
    })
    expect(Object.keys(built?.questions ?? {})).toEqual(['done_r1', 'again_r1'])
    expect(built?.questions.done_r1).toEqual({
      type: 'noul',
      instructions: SMART_ZIP_QUESTIONS.done.instructions('r1'),
      criteria: SMART_ZIP_QUESTIONS.done.criteria
    })
    expect(String(built?.questions.again_r1.instructions)).toContain('`results.r1`')
    expect(JSON.stringify({ state: built?.state, questions: built?.questions })).not.toContain('pkg"')
  })

  it('has nothing to ask without a reply or an open result, and clips a long reply', () => {
    const candidates = selectSmartZipPostTurnCandidates([exposed('pkg')], [])
    expect(buildSmartZipPostTurnRequest('q', '   ', candidates)).toBeNull()
    expect(buildSmartZipPostTurnRequest('q', 'a reply', [])).toBeNull()
    expect(buildSmartZipPostTurnRequest('q', 'x'.repeat(9000), candidates)?.state.reply.length).toBe(SMART_ZIP_POST_TURN_LIMITS.maxReplyChars)
  })
})

describe('decideSmartZipRezips', () => {
  const candidates = selectSmartZipPostTurnCandidates([exposed('a'), exposed('b'), exposed('c')], [])
  const request = buildSmartZipPostTurnRequest('q', 'a reply', candidates)!

  it('zips only what clears BOTH rules: done with it AND not needed again soon', () => {
    const decision = decideSmartZipRezips(postAnswers({ r1: [0.93, 0.16], r2: [0.71, 0.74], r3: [0.13, 0.89] }), request)
    // r2 is the probe's "read the doc so we can discuss it": Jev calls it done, and the second rule saves it.
    expect(decision.rezips).toEqual([{ zipId: 'a', description: 'read_file: a.ts - 40 lines', tokens: 900, done: 0.93, again: 0.16 }])
    expect(decision.summary).toBe(
      'after the reply: judged 3 open results; a done 0.93 / again 0.16, b done 0.71 / again 0.74, c done 0.13 / again 0.89 → zipped 1 (about 900 tokens off the next prompt, source inferred); kept 2 open; rules done ≥ 0.70 and again ≤ 0.35'
    )
  })

  it('holds the done floor at its exact boundary', () => {
    const floor = SMART_ZIP_POST_TURN_THRESHOLDS.doneFloor
    expect(decideSmartZipRezips(postAnswers({ r1: [floor, 0], r2: [0, 0], r3: [0, 0] }), request).rezips.map((rezip) => rezip.zipId)).toEqual(['a'])
    expect(decideSmartZipRezips(postAnswers({ r1: [floor - 0.01, 0], r2: [0, 0], r3: [0, 0] }), request).rezips).toEqual([])
    expect(floor).toBe(0.7)
  })

  it('holds the again ceiling at its exact boundary', () => {
    const ceiling = SMART_ZIP_POST_TURN_THRESHOLDS.againCeiling
    expect(decideSmartZipRezips(postAnswers({ r1: [0.9, ceiling], r2: [0, 0], r3: [0, 0] }), request).rezips.map((rezip) => rezip.zipId)).toEqual(['a'])
    expect(decideSmartZipRezips(postAnswers({ r1: [0.9, ceiling + 0.01], r2: [0, 0], r3: [0, 0] }), request).rezips).toEqual([])
    expect(ceiling).toBe(0.35)
  })

  it('caps the rezips, the most finished first, and never zips on a missing answer', () => {
    const many = selectSmartZipPostTurnCandidates(Array.from({ length: 6 }, (_, index) => exposed(`z${index}`)), [])
    const manyRequest = buildSmartZipPostTurnRequest('q', 'a reply', many)!
    const values: Record<string, [number, number]> = {}
    many.forEach((candidate, index) => (values[candidate.key] = [0.75 + index * 0.04, 0.1]))
    const decision = decideSmartZipRezips(postAnswers(values), manyRequest)
    expect(decision.rezips.map((rezip) => rezip.zipId)).toEqual(['z5', 'z4', 'z3', 'z2'])
    expect(decision.summary).toContain(`6 finished, cap ${SMART_ZIP_POST_TURN_THRESHOLDS.maxRezips}`)
    expect(SMART_ZIP_POST_TURN_THRESHOLDS.maxRezips).toBe(4)

    const half = decideSmartZipRezips({ done_r1: { type: 'noul', noul: 0.99 } }, request)
    expect(half.rezips).toEqual([])
    expect(half.readings[0]).toMatchObject({ done: 0.99, again: null })
  })
})

describe('computeSmartZipRezips', () => {
  const base = {
    userId: 'josh',
    globalZipSettings: SWITCH_ON,
    userRequest: 'which vitest version?',
    reply: 'It asks for ^4.1.2.',
    exposed: [] as ZipExposed[],
    newResults: [fresh('pkg')]
  }

  it('with the global switch OFF asks nothing and writes no record', async () => {
    const client = fakeClient({})
    expect(await computeSmartZipRezips({ ...base, globalZipSettings: SWITCH_OFF, client })).toEqual({ rezips: [], record: null, decision: null })
    expect(client.calls).toHaveLength(0)
  })

  it('ON: one call under the after-reply budget, the rezips, and an Execution Viewer row', async () => {
    const client = fakeClient(postAnswers({ r1: [0.93, 0.16] }))
    const outcome = await computeSmartZipRezips({ ...base, client })
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0].deadlineMs).toBe(SMART_ZIP_POST_TURN_LIMITS.deadlineMs)
    expect(client.calls[0].state).toEqual({
      request: 'which vitest version?',
      reply: 'It asks for ^4.1.2.',
      results: { r1: 'read_file: pkg.ts - 40 lines' }
    })
    expect(outcome.rezips).toEqual([{ zipId: 'pkg', description: 'read_file: pkg.ts - 40 lines', tokens: 700, done: 0.93, again: 0.16 }])
    expect(outcome.record).toMatchObject({ feature: 'smart_zip', status: 'ok', questionCount: 2 })
    expect(outcome.record?.decision).toContain('after the reply: judged 1 open results')
  })

  it('nothing that would stay open means no call and no record', async () => {
    const client = fakeClient({})
    expect(await computeSmartZipRezips({ ...base, newResults: [fresh('auto', { expandedNextTurn: false })], client })).toEqual({
      rezips: [],
      record: null,
      decision: null
    })
    expect(client.calls).toHaveLength(0)
  })

  it('with the master switch off (DL-120-11) makes no call; a miss zips nothing and says so', async () => {
    configState.config = { ...configState.config, enabled: false }
    const off = fakeClient({})
    const denied = await computeSmartZipRezips({ ...base, client: off })
    expect(off.calls).toHaveLength(0)
    expect(denied.rezips).toEqual([])
    expect(denied.record).toMatchObject({ feature: 'smart_zip', status: 'unavailable', reason: 'master_off' })

    configState.config = { ...configState.config, enabled: true }
    const slow = fakeClient({}, { status: 'unavailable', reason: 'deadline', deadlineHit: true, response: undefined } as never)
    const missed = await computeSmartZipRezips({ ...base, client: slow })
    expect(missed.rezips).toEqual([])
    expect(missed.record).toMatchObject({ status: 'unavailable', reason: 'deadline' })
    expect(missed.record?.decision).toBe('after the reply: no answer, so nothing was zipped and the usual buffer rules stand')
  })
})
