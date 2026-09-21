// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * SA-120 P4b — the route glue for recall by meaning (`buildSemanticRecallTurn`): which turns
 * get a provider at all, that the lane is asked ONCE per send however often the send
 * compiles, and that the memory commit reads that one answer instead of asking again.
 *
 * SA-120 P5 — the smart zip turn (`buildSmartZipTurn`): the ONE global switch is the gate
 * (OFF means no turn at all, so the compile is today's bytes and nothing is ever written),
 * the lane is asked ONCE per send, its tail provider only replays the decision, the commit
 * reads that same answer, and Batshit's earlier rezips are told first, Jev or no Jev. And
 * `composeJevJuiceHintProviders`, which runs the tail lanes side by side in a fixed order.
 *
 * SA-120 P6 — the after-reply check turn (`buildPostTurnCheckTurn`): two per-agent switches
 * are the gate (both OFF means no turn, so nothing is read or written and the compile is
 * today's bytes); before a reply it only REPLAYS what was stored about the most recent
 * assistant message, once, and names the record to mark as told; after a reply it gathers the
 * turn's FACTS (tool results, memory writes, earlier tool labels, the agent's own recent
 * replies), runs both lanes side by side, stores what was noticed, tells every tab, and appends
 * its Execution Viewer rows only after the other after-reply step has settled.
 */

const computeSemanticRecall = vi.hoisted(() => vi.fn())
const computeSmartZipHints = vi.hoisted(() => vi.fn())
const computeSmartZipRezips = vi.hoisted(() => vi.fn())
const computeReplyCheck = vi.hoisted(() => vi.fn())
const computeStyleCoach = vi.hoisted(() => vi.fn())
vi.mock('../../memory/semanticRecall.jev', () => ({ computeSemanticRecall }))
vi.mock('../../skillToolHints.jev', () => ({ computeSkillToolHints: vi.fn() }))
vi.mock('../../smartZip.jev', () => ({
  computeSmartZipHints,
  computeSmartZipRezips,
  buildSmartZipClosedDcmLines: (markers: Array<{ zipId: string }>) =>
    markers.length > 0 ? ['jev_juice_zips_closed:', ...markers.map((marker) => `- Zipped for you (inferred): ${marker.zipId}`)] : []
}))
// The lanes are faked; the line builder and the limits the glue reads stay real.
vi.mock('../../postTurnCheck.jev', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../postTurnCheck.jev')>()),
  computeReplyCheck,
  computeStyleCoach
}))
vi.mock('../../zipStateInferred', () => ({
  loadUntoldInferredRezips: vi.fn(async () => []),
  writeInferredRezips: vi.fn(async () => [])
}))
vi.mock('$lib/server/redis', () => ({ redis: { getZip: vi.fn(async () => null) } }))
vi.mock('$lib/server/ssePublisher', () => ({ publishUserEvent: vi.fn(async () => undefined) }))
vi.mock('../typesafeEvidence', () => ({ appendTypesafeCallRecords: vi.fn(async () => true) }))
const involvesAgent = vi.hoisted(() => vi.fn<(id: string) => boolean>())
vi.mock('$lib/utils/jevJuiceQuickActions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/jevJuiceQuickActions')>()
  return { ...actual, quickActionInvolvesAgent: (id: string) => involvesAgent(id) }
})

import * as actualQuickActionsModule from '$lib/utils/jevJuiceQuickActions'
import {
  buildJevJuiceMessageMetadata,
  buildPostTurnCheckTurn,
  buildQuickActionTellProvider,
  buildSemanticRecallTurn,
  buildSmartZipTurn,
  collectEarlierToolLabels,
  inlineControlLabels,
  composeJevJuiceHintProviders,
  createJevJuiceTurnCollector,
  replyProseForJudgment
} from '../jevJuiceTurn'

const AGENT = { id: 'agent-1', user_id: 'josh', memory_enabled: true, jev_juice_memory_recall: true }
const RECORD = { feature: 'memory_recall', status: 'ok', latencyMs: 210 } as never

function input(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'josh',
    agent: AGENT,
    message: 'what snack should I bring?',
    isGroupTurn: false,
    collector: createJevJuiceTurnCollector(),
    ...overrides
  } as Parameters<typeof buildSemanticRecallTurn>[0]
}

beforeEach(() => {
  computeSemanticRecall.mockReset()
  computeSemanticRecall.mockResolvedValue({
    recalls: [{ id: 'mem_a', probability: 0.91 }],
    record: RECORD,
    note: null,
    decision: null
  })
})

describe('buildSemanticRecallTurn', () => {
  it('builds nothing for an ineligible turn: switch off, memory off, a group turn, or no user message', () => {
    expect(buildSemanticRecallTurn(input({ agent: { ...AGENT, jev_juice_memory_recall: false } }))).toBeUndefined()
    expect(buildSemanticRecallTurn(input({ agent: { ...AGENT, jev_juice_memory_recall: 'true' } }))).toBeUndefined()
    expect(buildSemanticRecallTurn(input({ agent: { ...AGENT, memory_enabled: false } }))).toBeUndefined()
    expect(buildSemanticRecallTurn(input({ agent: null }))).toBeUndefined()
    expect(buildSemanticRecallTurn(input({ isGroupTurn: true }))).toBeUndefined()
    expect(buildSemanticRecallTurn(input({ message: '   ' }))).toBeUndefined()
    expect(computeSemanticRecall).not.toHaveBeenCalled()
  })

  it('asks the lane once per send and hands the commit the same answer', async () => {
    const collector = createJevJuiceTurnCollector()
    const turn = buildSemanticRecallTurn(input({ collector }))
    expect(turn).toBeDefined()
    // Before the compile ran there is nothing to commit.
    expect(turn?.getRecalls()).toEqual([])

    const first = await turn?.provider({ currentUserMessage: 'ignored: the route owns the message', excludeIds: ['mem_z'] })
    const second = await turn?.provider({ currentUserMessage: 'a second compile of the same send', excludeIds: [] })
    expect(computeSemanticRecall).toHaveBeenCalledTimes(1)
    expect(computeSemanticRecall).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'josh', agent: AGENT, message: 'what snack should I bring?', excludeIds: ['mem_z'] })
    )
    expect(first).toEqual([{ id: 'mem_a', probability: 0.91 }])
    expect(second).toBe(first)
    expect(turn?.getRecalls()).toEqual([{ id: 'mem_a', probability: 0.91 }])
    // One Execution Viewer row, however often the provider was called.
    expect(collector.records).toEqual([RECORD])
    expect(collector.notes).toEqual([])
  })

  it('carries a miss note to the collector and commits nothing', async () => {
    const note = { feature: 'memory_recall', status: 'unavailable', reason: 'deadline', at: 'now' }
    computeSemanticRecall.mockResolvedValue({ recalls: [], record: RECORD, note, decision: null })
    const collector = createJevJuiceTurnCollector()
    const turn = buildSemanticRecallTurn(input({ collector }))
    expect(await turn?.provider({ currentUserMessage: 'x', excludeIds: [] })).toEqual([])
    expect(turn?.getRecalls()).toEqual([])
    expect(collector.notes).toEqual([note])
  })

  it('a lane that throws costs the turn its inferred recalls, never the send', async () => {
    computeSemanticRecall.mockRejectedValue(new Error('lane bug'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const turn = buildSemanticRecallTurn(input())
    expect(await turn?.provider({ currentUserMessage: 'x', excludeIds: [] })).toEqual([])
    expect(turn?.getRecalls()).toEqual([])
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('recall by meaning threw'), expect.any(Error))
    errorSpy.mockRestore()
  })
})

describe('buildSmartZipTurn', () => {
  const ZIP_AGENT = { id: 'agent-1', user_id: 'josh' }
  const ON = { zip_tool_notes_enabled: true, jev_juice_smart_zip: true }
  const ZIP_RECORD = { feature: 'smart_zip', status: 'ok', latencyMs: 190 } as never
  const ZIPPED = [{ zipId: 'zip_aaa', zipType: 'cool_tool', description: 'read_file: a.ts - 1 line' }] as never
  const OPEN = { zipId: 'zip_aaa', description: 'read_file: a.ts - 1 line', tokens: 40, probability: 0.84, durationMessages: 2 }
  const TAIL_CONTEXT = { currentUserMessage: 'x', skills: [], discoverable: [], resolvedGatewayIds: null } as never

  function zipInput(overrides: Record<string, unknown> = {}) {
    return {
      userId: 'josh',
      sessionId: 'session-1',
      agent: ZIP_AGENT,
      globalZipSettings: ON,
      message: 'make the cue fire earlier',
      isGroupTurn: false,
      collector: createJevJuiceTurnCollector(),
      loadUntoldRezips: async () => [],
      ...overrides
    } as Parameters<typeof buildSmartZipTurn>[0]
  }

  beforeEach(() => {
    computeSmartZipHints.mockReset()
    computeSmartZipHints.mockResolvedValue({
      lines: ['jev_juice_zips:', '- Unzipped for you (inferred): zip_aaa'],
      opens: [OPEN],
      record: ZIP_RECORD,
      note: null,
      decision: null
    })
  })

  it('builds nothing with the global switch off or absent, for a group turn, or without a user message', () => {
    expect(buildSmartZipTurn(zipInput({ globalZipSettings: { zip_tool_notes_enabled: true } }))).toBeUndefined()
    expect(buildSmartZipTurn(zipInput({ globalZipSettings: { jev_juice_smart_zip: false } }))).toBeUndefined()
    expect(buildSmartZipTurn(zipInput({ globalZipSettings: { jev_juice_smart_zip: 'true' } }))).toBeUndefined()
    expect(buildSmartZipTurn(zipInput({ globalZipSettings: undefined }))).toBeUndefined()
    expect(buildSmartZipTurn(zipInput({ agent: null }))).toBeUndefined()
    expect(buildSmartZipTurn(zipInput({ isGroupTurn: true }))).toBeUndefined()
    expect(buildSmartZipTurn(zipInput({ message: '   ' }))).toBeUndefined()
    expect(buildSmartZipTurn(zipInput({ sessionId: '' }))).toBeUndefined()
    expect(computeSmartZipHints).not.toHaveBeenCalled()
  })

  it('asks the lane once per send: the compiler gets the results to open, the tail replays the lines, the commit reads the same answer', async () => {
    const collector = createJevJuiceTurnCollector()
    const turn = buildSmartZipTurn(zipInput({ collector }))
    expect(turn?.getOpens()).toEqual([])

    expect(await turn?.openProvider({ currentUserMessage: 'ignored: the route owns the message', zippedItems: ZIPPED })).toEqual([OPEN])
    // A second compile of the same send, and the tail provider after it: no second call.
    expect(await turn?.openProvider({ currentUserMessage: 'again', zippedItems: [] })).toEqual([OPEN])
    expect(await turn?.hintProvider(TAIL_CONTEXT)).toEqual(['jev_juice_zips:', '- Unzipped for you (inferred): zip_aaa'])
    expect(computeSmartZipHints).toHaveBeenCalledTimes(1)
    expect(computeSmartZipHints).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'josh',
        agent: ZIP_AGENT,
        globalZipSettings: ON,
        message: 'make the cue fire earlier',
        zippedItems: ZIPPED
      })
    )
    expect(turn?.getOpens()).toEqual([OPEN])
    expect(collector.records).toEqual([ZIP_RECORD])
    expect(collector.notes).toEqual([])
    // Nothing is stored by the turn: what was opened reaches the reply only after the route's commit.
    expect(collector.zips.opened).toEqual([])
    expect(buildJevJuiceMessageMetadata(collector)).toBeNull()
  })

  it('tells the agent what Batshit zipped after its last reply first, even when Jev misses, and names those ids for the commit', async () => {
    const note = { feature: 'smart_zip', status: 'unavailable', reason: 'deadline', at: 'now' }
    computeSmartZipHints.mockResolvedValue({ lines: [], opens: [], record: ZIP_RECORD, note, decision: null })
    const collector = createJevJuiceTurnCollector()
    const turn = buildSmartZipTurn(
      zipInput({ collector, loadUntoldRezips: async () => [{ zipId: 'zip_old', description: 'read_file: b.ts', done: 0.9 }] })
    )
    expect(await turn?.openProvider({ currentUserMessage: 'x', zippedItems: ZIPPED })).toEqual([])
    expect(await turn?.hintProvider(TAIL_CONTEXT)).toEqual(['jev_juice_zips_closed:', '- Zipped for you (inferred): zip_old'])
    expect(turn?.getToldRezipIds()).toEqual(['zip_old'])
    expect(turn?.getOpens()).toEqual([])
    expect(collector.notes).toEqual([note])

    // With hint lines too, the two blocks are separated by one blank line, closed notice first.
    computeSmartZipHints.mockResolvedValue({ lines: ['jev_juice_zips:', '- Possibly related: zip_aaa'], opens: [], record: ZIP_RECORD, note: null, decision: null })
    const both = buildSmartZipTurn(
      zipInput({ loadUntoldRezips: async () => [{ zipId: 'zip_old', description: '', done: 0.9 }] })
    )
    await both?.openProvider({ currentUserMessage: 'x', zippedItems: ZIPPED })
    expect(await both?.hintProvider(TAIL_CONTEXT)).toEqual([
      'jev_juice_zips_closed:',
      '- Zipped for you (inferred): zip_old',
      '',
      'jev_juice_zips:',
      '- Possibly related: zip_aaa'
    ])
  })

  it('a lane that throws, or a notice that cannot be read, costs the turn its zip lines, never the send', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    computeSmartZipHints.mockRejectedValue(new Error('lane bug'))
    const turn = buildSmartZipTurn(zipInput())
    expect(await turn?.openProvider({ currentUserMessage: 'x', zippedItems: ZIPPED })).toEqual([])
    expect(await turn?.hintProvider(TAIL_CONTEXT)).toEqual([])
    expect(turn?.getOpens()).toEqual([])
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('smart zip lane threw'), expect.any(Error))

    computeSmartZipHints.mockResolvedValue({ lines: ['jev_juice_zips:', '- x'], opens: [OPEN], record: ZIP_RECORD, note: null, decision: null })
    const unreadable = buildSmartZipTurn(
      zipInput({
        loadUntoldRezips: async () => {
          throw new Error('redis down')
        }
      })
    )
    expect(await unreadable?.openProvider({ currentUserMessage: 'x', zippedItems: ZIPPED })).toEqual([OPEN])
    expect(unreadable?.getToldRezipIds()).toEqual([])
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('could not read its earlier rezips'), expect.any(Error))
    errorSpy.mockRestore()
  })

  it('carries what the route stored to the reply metadata, so the tab knows to re-read zip state', () => {
    const collector = createJevJuiceTurnCollector()
    collector.zips.opened.push({ zipId: 'zip_aaa', probability: 0.84 })
    expect(buildJevJuiceMessageMetadata(collector)).toEqual({ notes: [], zips: { opened: [{ zipId: 'zip_aaa', probability: 0.84 }] } })
  })
})

describe('smart zip after the reply (runPostTurn)', () => {
  const ON = { jev_juice_smart_zip: true, buffer_size_read_file: 2, auto_zip_list_files: true }
  const POST_RECORD = { feature: 'smart_zip', status: 'ok', latencyMs: 180 } as any
  const REZIP = { zipId: 'zip_pkg', description: 'read_file: package.json - 142 lines', tokens: 1256, done: 0.93, again: 0.16 }
  const storedZip = (overrides: Record<string, unknown> = {}) => ({
    id: 'zip_pkg',
    type: 'cool_tool',
    description: 'read_file: package.json - 142 lines',
    tokens: 3000,
    metadata: { operationKind: 'read_file', toolName: 'read_file', promptTokens: 1256, zipDescriptionLabel: 'read_file', zipDescriptionTarget: 'package.json' },
    ...overrides
  })

  function postTurn(overrides: Record<string, unknown> = {}, deps: Record<string, unknown> = {}) {
    const calls = {
      loadZip: vi.fn(async (zipId: string) => (zipId === 'zip_pkg' ? storedZip() : null)),
      writeRezips: vi.fn(async (_sessionId: string, items: Array<{ zipId: string }>) => items.map((item) => item.zipId)),
      appendRecords: vi.fn(async () => true),
      publish: vi.fn(async () => undefined),
      ...deps
    }
    const turn = buildSmartZipTurn({
      userId: 'josh',
      sessionId: 'session-1',
      agent: { id: 'agent-1', user_id: 'josh' },
      globalZipSettings: ON,
      message: 'which vitest version?',
      isGroupTurn: false,
      collector: createJevJuiceTurnCollector(),
      loadUntoldRezips: async () => [],
      postTurnDeps: calls as never,
      ...overrides
    } as never)
    return { turn: turn!, calls }
  }

  beforeEach(() => {
    computeSmartZipRezips.mockReset()
    computeSmartZipRezips.mockResolvedValue({ rezips: [REZIP], record: POST_RECORD, decision: null })
  })

  it('hands the lane the compile\'s exposed zips and this reply\'s new results, zips what it says, tells every tab, and appends the row', async () => {
    const { turn, calls } = postTurn()
    const exposedByCompile = [{ zipId: 'zip_old', zipType: 'cool_tool' }] as never
    turn.exposedObserver(exposedByCompile)

    const zipped = await turn.runPostTurn({
      messageId: 'msg-9',
      reply: 'It asks for ^4.1.2. {{batshit-zip:zip_pkg:::read_file: package.json - 142 lines}}',
      newZipIds: ['zip_pkg', 'zip_pkg', 'zip_gone']
    })

    expect(calls.loadZip).toHaveBeenCalledTimes(2)
    expect(computeSmartZipRezips).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'josh',
        globalZipSettings: ON,
        userRequest: 'which vitest version?',
        reply: 'It asks for ^4.1.2. [tool result: read_file: package.json - 142 lines]',
        exposed: exposedByCompile,
        newResults: [
          {
            zipId: 'zip_pkg',
            zipType: 'cool_tool',
            description: 'read_file: package.json - 142 lines',
            descriptionParts: { label: 'read_file', target: 'package.json', status: '' },
            tokens: 1256,
            operationKind: 'read_file',
            toolName: 'read_file',
            // Read File is a Normal lane with a buffer here: today's rules would leave it open next turn.
            expandedNextTurn: true
          }
        ]
      })
    )
    expect(calls.writeRezips).toHaveBeenCalledWith('session-1', [
      { zipId: 'zip_pkg', description: 'read_file: package.json - 142 lines', done: 0.93, again: 0.16 }
    ])
    expect(calls.publish).toHaveBeenCalledWith('josh', {
      type: 'zip_state_changed',
      sessionId: 'session-1',
      source: 'inferred',
      opened: [],
      rezipped: ['zip_pkg']
    })
    expect(calls.appendRecords).toHaveBeenCalledWith('session-1', 'msg-9', [POST_RECORD])
    expect(zipped).toEqual([REZIP])
  })

  it('predicts with today\'s zip rules: a result on an Auto lane is already zipped next turn, so it is not offered as open', async () => {
    const { turn } = postTurn({}, {
      loadZip: vi.fn(async () =>
        storedZip({
          description: 'list_files: src - 14 entries',
          metadata: { operationKind: 'list_files', toolName: 'list_files', promptTokens: 300, zipDescriptionLabel: 'list_files', zipDescriptionTarget: 'src' }
        })
      )
    })
    await turn.runPostTurn({ messageId: 'msg-9', reply: 'Listed.', newZipIds: ['zip_pkg'] })
    expect(computeSmartZipRezips.mock.calls[0][0].newResults[0]).toMatchObject({ operationKind: 'list_files', expandedNextTurn: false })
  })

  it('the user or the agent winning the write is reported, and nobody is told about a rezip that did not happen', async () => {
    const { turn, calls } = postTurn({}, { writeRezips: vi.fn(async () => []) })
    expect(await turn.runPostTurn({ messageId: 'msg-9', reply: 'Done.', newZipIds: ['zip_pkg'] })).toEqual([])
    expect(calls.publish).not.toHaveBeenCalled()
    expect(calls.appendRecords).toHaveBeenCalledTimes(1)
    expect((calls.appendRecords.mock.calls[0] as any)[2][0].detail).toBe('1 left alone: the user or the agent changed it first')
  })

  it('no record means nothing happened: no write, no notice, no row; an empty reply is never judged', async () => {
    computeSmartZipRezips.mockResolvedValue({ rezips: [], record: null, decision: null })
    const { turn, calls } = postTurn()
    expect(await turn.runPostTurn({ messageId: 'msg-9', reply: 'Done.', newZipIds: [] })).toEqual([])
    expect(calls.writeRezips).not.toHaveBeenCalled()
    expect(calls.appendRecords).not.toHaveBeenCalled()

    computeSmartZipRezips.mockClear()
    await turn.runPostTurn({ messageId: 'msg-9', reply: '  <batshit-zip-control>{"zip":["x"]}</batshit-zip-control> ', newZipIds: [] })
    expect(computeSmartZipRezips).not.toHaveBeenCalled()
  })

  it('never throws into a finished send', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    computeSmartZipRezips.mockRejectedValue(new Error('lane bug'))
    const { turn } = postTurn()
    expect(await turn.runPostTurn({ messageId: 'msg-9', reply: 'Done.', newZipIds: [] })).toEqual([])
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('after-reply step threw'), expect.any(Error))
    errorSpy.mockRestore()
  })
})

describe('replyProseForJudgment', () => {
  it('gives Jev what the agent said: no hidden control blocks, and zip references read as the tool results they stand for', () => {
    const raw = [
      'The version is ^4.1.2.',
      '{{batshit-zip:cool_tool_1_abcde:::read_file: package.json - 142 lines}}',
      '{{batshit-zip:cool_tool_2_fghij}}',
      '<batshit-zip-control>{"zip":["cool_tool_1_abcde"]}</batshit-zip-control>',
      '<batshit-tool-notes>{"notes":[{"toolName":"read_file","summary":"vitest ^4.1.2"}]}</batshit-tool-notes>'
    ].join('\n')
    expect(replyProseForJudgment(raw)).toBe(
      'The version is ^4.1.2.\n[tool result: read_file: package.json - 142 lines]\n[tool result]'
    )
    expect(replyProseForJudgment('')).toBe('')
  })
})

describe('composeJevJuiceHintProviders', () => {
  const CONTEXT = { currentUserMessage: 'x', skills: [], discoverable: [], resolvedGatewayIds: null } as never

  it('is no provider at all when no lane is on, and the lane itself when one is', () => {
    expect(composeJevJuiceHintProviders([undefined, undefined])).toBeUndefined()
    const only = async () => ['a']
    expect(composeJevJuiceHintProviders([undefined, only])).toBe(only)
  })

  it('runs the lanes side by side and joins their lines in the order given, whichever answers first', async () => {
    const started: string[] = []
    let releaseFirst: (lines: string[]) => void = () => {}
    const slowFirst = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          started.push('first')
          releaseFirst = resolve
        })
    )
    const fastSecond = vi.fn(async () => {
      started.push('second')
      return ['jev_juice_zips:', '- Likely needed: zip_aaa']
    })
    const composed = composeJevJuiceHintProviders([slowFirst, fastSecond])
    const pending = composed?.(CONTEXT)
    // The second lane started without waiting for the first to finish.
    await Promise.resolve()
    expect(started).toEqual(['first', 'second'])
    releaseFirst(['jev_juice_hints:', '- Likely tool: x'])
    expect(await pending).toEqual(['jev_juice_hints:', '- Likely tool: x', '', 'jev_juice_zips:', '- Likely needed: zip_aaa'])
    expect(slowFirst).toHaveBeenCalledWith(CONTEXT)
    expect(fastSecond).toHaveBeenCalledWith(CONTEXT)
  })

  it('a quiet lane adds no blank line, and a rejecting lane only loses its own lines', async () => {
    const quiet = async () => [] as string[]
    const loud = async () => ['jev_juice_zips:', '- Likely needed: zip_aaa']
    expect(await composeJevJuiceHintProviders([quiet, loud])?.(CONTEXT)).toEqual(['jev_juice_zips:', '- Likely needed: zip_aaa'])

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = async () => {
      throw new Error('lane bug')
    }
    expect(await composeJevJuiceHintProviders([broken, loud])?.(CONTEXT)).toEqual(['jev_juice_zips:', '- Likely needed: zip_aaa'])
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('a hint lane rejected'), expect.any(Error))
    errorSpy.mockRestore()
  })
})

describe('buildQuickActionTellProvider (SA-120 P9)', () => {
  beforeEach(() => {
    // The real rule, from the real catalog (the mock only replaces `quickActionInvolvesAgent`).
    const real = (id: string) => actualQuickActionsModule.quickActionDefinition(id)?.involvesAgent === true
    involvesAgent.mockImplementation((id: string) => real(id))
  })
  const CONTEXT = { currentUserMessage: 'x', skills: [], discoverable: [], resolvedGatewayIds: null } as never
  const dockMark = { id: 'open_goon_dock', tab: null, confidence: 0.98, onlyThis: true, snapshotId: 'qa_1', at: '2026-09-17T23:00:00.000Z' }
  const settingsMark = { id: 'open_settings', tab: 'voice', confidence: 0.92, onlyThis: false, snapshotId: null, at: '2026-09-17T23:01:00.000Z' }

  it('tells the agent nothing about the six v1 actions: none of them involves the agent (Josh, 2026-09-18)', () => {
    const messages = [
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'open the dock', metadata: { quickAction: dockMark } },
      { role: 'user', content: 'stop', metadata: { quickAction: { ...dockMark, id: 'stop' } } },
      { role: 'user', content: 'hang up', metadata: { quickAction: { ...dockMark, id: 'end_voice_mode' } } },
      { role: 'user', content: 'open the voice settings, which voice?', metadata: { quickAction: settingsMark } },
      { role: 'user', content: 'show me what you did', metadata: { quickAction: { ...dockMark, id: 'show_execution_viewer' } } }
    ]
    expect(buildQuickActionTellProvider({ isGroupTurn: false, messages })).toBeUndefined()
  })

  it('tells the agent, in order, every quick action since its last reply that involves it, and nothing older', async () => {
    // The first action that involves the agent will be a Goon expression; until then, stand one in.
    involvesAgent.mockImplementation((id: string) => id === 'open_goon_dock' || id === 'open_settings')
    const provider = buildQuickActionTellProvider({
      isGroupTurn: false,
      messages: [
        { role: 'user', content: 'hush', metadata: { quickAction: { ...dockMark, id: 'stop' } } },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'open the dock', metadata: { quickAction: dockMark } },
        { role: 'user', content: 'open the voice settings, which voice do you recommend?', metadata: { quickAction: settingsMark } }
      ]
    })
    expect(provider).toBeDefined()
    expect(await provider!(CONTEXT)).toEqual([
      'jev_juice_quick_actions (Batshit acted on what your user said in Voice Mode, judged by a fast judgment model; your user saw a mark for each one):',
      '- The user said "open the dock" and Batshit opened the Goon Dock for them (a quick action by Jev, not you); that turn never reached you.',
      '- In this message the user also asked Batshit to act, and Batshit opened Settings (Voice) (a quick action by Jev, not you) before you read it.'
    ])
  })

  it('is no provider at all with nothing to tell: no marks, marks the agent already saw, a group turn, or no history', () => {
    involvesAgent.mockImplementation(() => true)
    expect(buildQuickActionTellProvider({ isGroupTurn: false, messages: [{ role: 'user', content: 'hi' }] })).toBeUndefined()
    expect(
      buildQuickActionTellProvider({
        isGroupTurn: false,
        messages: [{ role: 'user', content: 'open the dock', metadata: { quickAction: dockMark } }, { role: 'assistant', content: 'sure' }, { role: 'user', content: 'thanks' }]
      })
    ).toBeUndefined()
    expect(buildQuickActionTellProvider({ isGroupTurn: true, messages: [{ role: 'user', content: 'open the dock', metadata: { quickAction: dockMark } }] })).toBeUndefined()
    expect(buildQuickActionTellProvider({ isGroupTurn: false, messages: [] })).toBeUndefined()
    expect(buildQuickActionTellProvider({ isGroupTurn: false, messages: null })).toBeUndefined()
    // A mark that is not a real action id is ignored, never printed.
    expect(buildQuickActionTellProvider({ isGroupTurn: false, messages: [{ role: 'user', content: 'x', metadata: { quickAction: { id: 'launch_missiles' } } }] })).toBeUndefined()
  })
})

describe('buildPostTurnCheckTurn', () => {
  const CHECK_AGENT = { id: 'agent-1', user_id: 'josh', memory_enabled: true, jev_juice_reply_check: true, jev_juice_style_coach: true }
  const CLAIMED = { id: 'claimed_action', lane: 'reply_check', source: 'inferred', probability: 0.9149 }
  const OPENER = { id: 'repeated_opener', lane: 'style_coach', source: 'counted', detail: 'great question', count: 3, window: 4, probability: 0.887 }
  const CHECK_ROW = { feature: 'reply_check', status: 'ok', latencyMs: 200 } as never
  const STYLE_ROW = { feature: 'style_coach', status: 'ok', latencyMs: 180 } as never
  const HISTORY = [
    { id: 'u1', role: 'user', content: 'Which vitest version do we use?' },
    {
      id: 'a1',
      role: 'assistant',
      agent_id: 'agent-1',
      content: 'Great question! {{batshit-zip:zip_old:::read_file: batshit-app/package.json - 142 lines}} It asks for ^4.1.2.'
    },
    { id: 'u2', role: 'user', content: 'And svelte?' },
    { id: 'a-other', role: 'assistant', agent_id: 'agent-2', content: 'Another agent spoke here.' },
    { id: 'a-failed', role: 'assistant', agent_id: 'agent-1', content: 'Half a rep', metadata: { response_failed: true } },
    { id: 'a2', role: 'assistant', agent_id: 'agent-1', content: 'Great question! It asks for ^5.55.1.' }
  ]

  function deps(overrides: Record<string, unknown> = {}) {
    return {
      loadZip: vi.fn(async (zipId: string) =>
        zipId === 'zip_new'
          ? {
              type: 'cool_tool',
              description: 'bash: npm run test - exit 1 - 212 lines',
              metadata: { operationKind: 'bash', zipDescriptionLabel: 'bash', zipDescriptionTarget: 'npm run test', zipDescriptionStatus: 'exit 1' }
            }
          : zipId === 'zip_image'
            ? { type: 'image', description: 'a screenshot' }
            : null
      ),
      loadRecord: vi.fn(async () => null),
      writeRecord: vi.fn(async () => true),
      appendRecords: vi.fn(async () => true),
      publish: vi.fn(async () => undefined),
      ...overrides
    }
  }

  function turnInput(overrides: Record<string, unknown> = {}) {
    return {
      userId: 'josh',
      sessionId: 'session-1',
      agent: CHECK_AGENT,
      message: 'Run the tests please.',
      isGroupTurn: false,
      history: HISTORY,
      deps: deps(),
      ...overrides
    } as Parameters<typeof buildPostTurnCheckTurn>[0]
  }

  const postTurn = (overrides: Record<string, unknown> = {}) => ({
    messageId: 'a3',
    reply: 'I ran the tests and they all pass. {{batshit-zip:zip_new:::bash: npm run test - exit 1 - 212 lines}}',
    newZipIds: ['zip_new', 'zip_image', 'zip_new'],
    toolSteps: [],
    awaitingApproval: false,
    ...overrides
  })

  beforeEach(() => {
    computeReplyCheck.mockReset()
    computeStyleCoach.mockReset()
    computeReplyCheck.mockResolvedValue({ findings: [CLAIMED], record: CHECK_ROW, note: null })
    computeStyleCoach.mockResolvedValue({ findings: [OPENER], record: STYLE_ROW, note: null })
  })

  it('builds nothing for an ineligible turn: both switches off in every shape, a group turn, no message, no session, no agent', () => {
    for (const agent of [
      { id: 'agent-1' },
      { id: 'agent-1', jev_juice_reply_check: false, jev_juice_style_coach: false },
      { id: 'agent-1', jev_juice_reply_check: 'true', jev_juice_style_coach: 1 },
      { id: 'agent-1', jev_juice_reply_check: null },
      null
    ]) {
      expect(buildPostTurnCheckTurn(turnInput({ agent }))).toBeUndefined()
    }
    expect(buildPostTurnCheckTurn(turnInput({ isGroupTurn: true }))).toBeUndefined()
    expect(buildPostTurnCheckTurn(turnInput({ message: '   ' }))).toBeUndefined()
    expect(buildPostTurnCheckTurn(turnInput({ sessionId: '' }))).toBeUndefined()
    // Either switch alone is enough.
    expect(buildPostTurnCheckTurn(turnInput({ agent: { id: 'agent-1', jev_juice_style_coach: true } }))).toBeDefined()
    expect(buildPostTurnCheckTurn(turnInput({ agent: { id: 'agent-1', jev_juice_reply_check: true } }))).toBeDefined()
  })

  it('replays what was stored about the MOST RECENT assistant message, reads it once per send, and names it for the told mark', async () => {
    const d = deps({ loadRecord: vi.fn(async () => ({ messageId: 'a2', findings: [CLAIMED, OPENER], notes: [], toldAgent: false })) })
    const turn = buildPostTurnCheckTurn(turnInput({ deps: d }))!
    expect(turn.getToldMessageId()).toBeNull()
    const first = await turn.hintProvider({} as never)
    const second = await turn.hintProvider({} as never)
    expect(d.loadRecord).toHaveBeenCalledTimes(1)
    expect(d.loadRecord).toHaveBeenCalledWith('session-1', 'a2')
    expect(second).toBe(first)
    expect(first[0]).toContain('jev_juice_reply_check (')
    expect(first.some((line) => line.startsWith('jev_juice_style_coach ('))).toBe(true)
    expect(turn.getToldMessageId()).toBe('a2')
    // Before a reply this lane never asks Jev anything.
    expect(computeReplyCheck).not.toHaveBeenCalled()
    expect(computeStyleCoach).not.toHaveBeenCalled()
  })

  it('tells nothing, and marks nothing, for a record already told, a reply with no record, or a record with nothing for the lanes that are on', async () => {
    const told = buildPostTurnCheckTurn(turnInput({ deps: deps({ loadRecord: vi.fn(async () => ({ messageId: 'a2', findings: [CLAIMED], notes: [], toldAgent: true })) }) }))!
    expect(await told.hintProvider({} as never)).toEqual([])
    expect(told.getToldMessageId()).toBeNull()

    const none = buildPostTurnCheckTurn(turnInput())!
    expect(await none.hintProvider({} as never)).toEqual([])
    expect(none.getToldMessageId()).toBeNull()

    // Only the style coach noticed something, and only the reply check is switched on now.
    const replyCheckOnly = buildPostTurnCheckTurn(
      turnInput({
        agent: { id: 'agent-1', jev_juice_reply_check: true },
        deps: deps({ loadRecord: vi.fn(async () => ({ messageId: 'a2', findings: [OPENER], notes: [], toldAgent: false })) })
      })
    )!
    expect(await replyCheckOnly.hintProvider({} as never)).toEqual([])
    expect(replyCheckOnly.getToldMessageId()).toBeNull()
  })

  it('a read that fails costs the agent its notes this turn, never the send', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const turn = buildPostTurnCheckTurn(turnInput({ deps: deps({ loadRecord: vi.fn(async () => { throw new Error('redis down') }) }) }))!
    expect(await turn.hintProvider({} as never)).toEqual([])
    expect(turn.getToldMessageId()).toBeNull()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('after-reply notes could not be read'), expect.any(Error))
    errorSpy.mockRestore()
  })

  it('checks nothing for a reply that stopped to wait for an approval, or that has no words', async () => {
    const d = deps()
    const turn = buildPostTurnCheckTurn(turnInput({ deps: d }))!
    expect(await turn.runPostTurn(postTurn({ awaitingApproval: true }))).toBeNull()
    expect(await turn.runPostTurn(postTurn({ reply: '<batshit-zip-control>{"zip":[]}</batshit-zip-control>' }))).toBeNull()
    expect(computeReplyCheck).not.toHaveBeenCalled()
    expect(d.writeRecord).not.toHaveBeenCalled()
    expect(d.appendRecords).not.toHaveBeenCalled()
  })

  it('hands the reply check the turn\'s FACTS: tool results only, earlier tool labels, and whether a memory was saved', async () => {
    const turn = buildPostTurnCheckTurn(turnInput())!
    await turn.runPostTurn(postTurn())
    const facts = computeReplyCheck.mock.calls[0][0]
    expect(facts.userRequest).toBe('Run the tests please.')
    // Prose for Jev: the zip reference reads as the tool result it stands for.
    expect(facts.reply).toBe('I ran the tests and they all pass. [tool result: bash: npm run test - exit 1 - 212 lines]')
    // One fact per tool result: the repeat and the image zip are gone.
    expect(facts.tools).toEqual([
      { description: 'bash: npm run test - exit 1 - 212 lines', kind: 'bash', target: 'npm run test', status: 'exit 1' }
    ])
    expect(facts.earlierToolLabels).toEqual(['read_file: batshit-app/package.json - 142 lines'])
    expect(facts.memoryEnabled).toBe(true)
    expect(facts.memorySaveAttempted).toBe(false)
    expect(facts.extraToolLabels).toEqual([])
  })

  it('knows a memory was saved from the inline block or from a memory write control, and lists memory controls as tool calls', async () => {
    const inline = buildPostTurnCheckTurn(turnInput())!
    await inline.runPostTurn(postTurn({ reply: 'Noted. <batshit-memory>{"gist":"likes tabs","content":"Prefers tabs."}</batshit-memory>' }))
    expect(computeReplyCheck.mock.calls[0][0].memorySaveAttempted).toBe(true)
    // Found live: the block is stripped from the prose, so the save must travel as a FACT, or
    // "saving that now" reads as a claim nothing accounts for.
    expect(computeReplyCheck.mock.calls[0][0].extraToolLabels).toEqual(['memory: save (inline block)'])
    expect(computeReplyCheck.mock.calls[0][0].reply).toBe('Noted.')

    computeReplyCheck.mockClear()
    const byTool = buildPostTurnCheckTurn(turnInput())!
    await byTool.runPostTurn(
      postTurn({
        toolSteps: [
          { toolName: 'native_batshit_tool_use', toolInput: { ref: 'fabric:sys.memory.search', input: { query: 'tabs' } } },
          { toolName: 'batshit_tool_use', toolArgs: { arguments: { ref: 'fabric:sys.memory.save', input: {} } } }
        ]
      })
    )
    expect(computeReplyCheck.mock.calls[0][0].memorySaveAttempted).toBe(true)
    expect(computeReplyCheck.mock.calls[0][0].extraToolLabels).toEqual(['memory: search', 'memory: save'])

    computeReplyCheck.mockClear()
    const searchOnly = buildPostTurnCheckTurn(turnInput())!
    await searchOnly.runPostTurn(postTurn({ toolSteps: [{ toolInput: { ref: 'fabric:sys.memory.search' } }] }))
    expect(computeReplyCheck.mock.calls[0][0].memorySaveAttempted).toBe(false)
  })

  it('hands the style coach this agent\'s own finished replies, oldest first, and the user\'s words', async () => {
    const turn = buildPostTurnCheckTurn(turnInput())!
    await turn.runPostTurn(postTurn())
    const style = computeStyleCoach.mock.calls[0][0]
    expect(style.recentReplies).toEqual([
      'Great question! [tool result: read_file: batshit-app/package.json - 142 lines] It asks for ^4.1.2.',
      'Great question! It asks for ^5.55.1.'
    ])
    expect(style.userMessages).toEqual(['Which vitest version do we use?', 'And svelte?', 'Run the tests please.'])
  })

  it('stores what was noticed with rounded numbers, tells every tab, and appends BOTH rows in one write', async () => {
    const d = deps()
    const turn = buildPostTurnCheckTurn(turnInput({ deps: d }))!
    const stored = await turn.runPostTurn(postTurn())
    expect(d.writeRecord).toHaveBeenCalledTimes(1)
    expect(d.writeRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'a3',
        sessionId: 'session-1',
        agentId: 'agent-1',
        toldAgent: false,
        notes: [],
        findings: [
          { ...CLAIMED, probability: 0.91 },
          { ...OPENER, probability: 0.89 }
        ]
      })
    )
    expect(stored?.findings).toHaveLength(2)
    expect(d.publish).toHaveBeenCalledWith('josh', { type: 'jev_juice_post_turn', sessionId: 'session-1', messageId: 'a3' })
    expect(d.appendRecords).toHaveBeenCalledTimes(1)
    expect(d.appendRecords).toHaveBeenCalledWith('session-1', 'a3', [CHECK_ROW, STYLE_ROW])
  })

  it('stores nothing and tells no tab for a clean reply, and still records that it looked', async () => {
    computeReplyCheck.mockResolvedValue({ findings: [], record: CHECK_ROW, note: null })
    computeStyleCoach.mockResolvedValue({ findings: [], record: null, note: null })
    const d = deps()
    const turn = buildPostTurnCheckTurn(turnInput({ deps: d }))!
    expect(await turn.runPostTurn(postTurn())).toBeNull()
    expect(d.writeRecord).not.toHaveBeenCalled()
    expect(d.publish).not.toHaveBeenCalled()
    expect(d.appendRecords).toHaveBeenCalledWith('session-1', 'a3', [CHECK_ROW])
  })

  it('stores a lane that could not run, so the chip can say so', async () => {
    const note = { feature: 'reply_check', status: 'unavailable', reason: 'master_off', at: 'now' }
    computeReplyCheck.mockResolvedValue({ findings: [], record: CHECK_ROW, note })
    computeStyleCoach.mockResolvedValue({ findings: [], record: null, note: null })
    const d = deps()
    const turn = buildPostTurnCheckTurn(turnInput({ deps: d }))!
    await turn.runPostTurn(postTurn())
    expect(d.writeRecord).toHaveBeenCalledWith(expect.objectContaining({ findings: [], notes: [note] }))
    expect(d.publish).toHaveBeenCalledTimes(1)
  })

  it('judges beside the other after-reply step but appends its rows only once that one has settled', async () => {
    const order: string[] = []
    let release: () => void = () => {}
    const other = new Promise<void>((resolve) => {
      release = () => {
        order.push('other step settled')
        resolve()
      }
    })
    computeReplyCheck.mockImplementation(async () => {
      order.push('judged')
      return { findings: [], record: CHECK_ROW, note: null }
    })
    const d = deps({ appendRecords: vi.fn(async () => (order.push('rows appended'), true)) })
    const turn = buildPostTurnCheckTurn(turnInput({ deps: d }))!
    const running = turn.runPostTurn(postTurn({ appendRowsAfter: other }))
    await vi.waitFor(() => expect(order).toContain('judged'))
    expect(order).not.toContain('rows appended')
    release()
    await running
    expect(order).toEqual(['judged', 'other step settled', 'rows appended'])
  })

  it('a lane that throws costs the reply its check, never anything else', async () => {
    computeReplyCheck.mockRejectedValue(new Error('lane bug'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const d = deps()
    const turn = buildPostTurnCheckTurn(turnInput({ deps: d }))!
    expect(await turn.runPostTurn(postTurn())).toBeNull()
    expect(d.writeRecord).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('after-reply check threw'), expect.any(Error))
    errorSpy.mockRestore()
  })

  it('lists every inline control block a reply carries as a fact, and nothing for plain prose', () => {
    expect(inlineControlLabels('Plain prose about <batshit-memory> tags, with no block.')).toEqual([])
    expect(
      inlineControlLabels(
        'Zipped it. <batshit-zip-control>{"zip":["tool_result_1"]}</batshit-zip-control> <batshit-cue>{"goon_mood":"happy"}</batshit-cue>'
      )
    ).toEqual(['zip control: zip or unzip tool results (inline block)', 'goon cue (inline block)'])
  })

  it('collects earlier tool labels once each, oldest first, from assistant messages only', () => {
    expect(
      collectEarlierToolLabels([
        { role: 'user', content: '{{batshit-zip:zip_u:::pasted by the user}}' },
        { role: 'assistant', content: '{{batshit-zip:z1:::read_file: a.ts - 9 lines}} and {{batshit-zip:z2:::bash: ls - exit 0}}' },
        { role: 'assistant', content: '{{batshit-zip:z3:::read_file: a.ts - 9 lines}} {{batshit-zip:z4}}' }
      ])
    ).toEqual(['read_file: a.ts - 9 lines', 'bash: ls - exit 0'])
  })
})
