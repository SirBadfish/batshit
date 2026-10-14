// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '$lib/utils/logger'
import { unclosedReferenceReplies } from '$lib/test-utils/unclosedReferenceReplies'
import {
  MAX_REPLAY_EVENTS,
  __countReplyRecordChatsForTests,
  __resetReplyRecordsForTests,
  forgetChatReplyRecords,
  stampReplyEventId,
  buildRecordedReplyEnd,
  closeReplyRecord,
  flushHeldReplyText,
  hasReplyRecord,
  isLateReplyEvent,
  listReplayEvents,
  rebuildRecordedReply,
  recordReplyEvent,
  replyZipDetection,
  retractReplySegment,
  REPLY_RECORDED_EVENT_TYPES,
  takeStreamMadeZipReferences,
  scheduleReplyRecordCleanup,
  startReplyRecord
} from '$lib/server/services/replyStreamRecord'
import { redis } from '$lib/server/redis'
import { SegmentedText } from '$lib/utils/segmentedText'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'

useRedisTestServer()

/**
 * BL-775: the server owns a reply's saved record, and its text has ONE maker, the stream path: the
 * events `/api/sse` records here, rebuilt by `rebuildRecordedReply` for send-routed's finalize,
 * which saves the result and then publishes `end`. These tests pin the record (the replay buffer
 * a joining tab reads, the uncapped reconstruction the rebuild reads) and the rebuild (the old
 * `/api/sse` `end` rules plus the edits the chat page made before its save).
 */

vi.mock('$lib/server/zipService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  finalizeAllZipBlocks: vi.fn(async () => [])
}))

const SESSION = 'session-record'
beforeEach(async () => { await redis.createSession({ id: SESSION, user_id: 'reply-record-fixture', title: 'Reply record fixture' } as any) })
const COOL_A = '{{batshit-zip:cool_tool_1790000000001_abcd12:::read_file: a.ts - 3 lines}}'

function start(messageId: string, metadata: Record<string, unknown> = {}) {
  startReplyRecord(SESSION, { type: 'start', sessionId: SESSION, messageId, metadata })
}

function chunk(messageId: string, content: string) {
  recordReplyEvent(SESSION, { type: 'chunk', sessionId: SESSION, messageId, content })
}

async function rebuild(messageId: string, extra: Partial<Parameters<typeof rebuildRecordedReply>[0]> = {}) {
  return rebuildRecordedReply({
    sessionId: SESSION,
    messageId,
    inlineCapable: true,
    replyControlFinalized: true,
    ...extra
  })
}

describe('replyStreamRecord: the recorded events of a running reply', () => {
  beforeEach(() => __resetReplyRecordsForTests())
  afterEach(() => {
    vi.useRealTimers()
    __resetReplyRecordsForTests()
  })

  it('stamps each message-scoped event once and replays it with the same id', () => {
    start('m1')
    chunk('m1', 'Hello')
    const replay = listReplayEvents(SESSION)
    expect(replay.map((event) => event.sseEventId)).toEqual(['m1:1', 'm1:2'])
    expect(listReplayEvents(SESSION).map((event) => event.sseEventId)).toEqual(['m1:1', 'm1:2'])
    expect(recordReplyEvent(SESSION, { type: 'chunk', content: 'no owner' })).toBe(false)
  })

  it('stamps an event it does not record without keeping anything for the chat', () => {
    const event = stampReplyEventId('chat-never-recorded', { type: 'zip_activity_change', messageId: 'm9' })
    expect(event.sseEventId).toMatch(/^m9:\d+$/)
    expect(__countReplyRecordChatsForTests()).toBe(0)
  })

  it('forgets a deleted chat: its record, its cleanup timer, and its zip detector state', async () => {
    vi.useFakeTimers()
    start('m1')
    chunk('m1', 'Hello')
    scheduleReplyRecordCleanup(SESSION, 'm1')
    await replyZipDetection.processChunk(SESSION, 'm1', '<error> open')
    forgetChatReplyRecords(SESSION)
    expect(hasReplyRecord(SESSION, 'm1')).toBe(false)
    expect(__countReplyRecordChatsForTests()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(replyZipDetection.takeUnclosedText(SESSION, 'm1')).toBe('')
  })

  it('caps the joining replay, keeps the start pinned for a late tab, and rebuilds the whole reply past the cap', async () => {
    start('m-long', { approvalResume: { version: 42, prior: { content: 'Prefix.', metadata: {}, intermediateSteps: [] } } })
    for (let index = 0; index < MAX_REPLAY_EVENTS + 1; index += 1) chunk('m-long', 'x')

    const replay = listReplayEvents(SESSION)
    expect(replay[0]).toMatchObject({ type: 'start', messageId: 'm-long' })
    expect(replay).toHaveLength(MAX_REPLAY_EVENTS + 1)

    const rebuilt = await rebuild('m-long')
    expect(rebuilt?.content).toBe(`Prefix.\n\n${'x'.repeat(MAX_REPLAY_EVENTS + 1)}`)
    expect(rebuilt?.continuesEarlierPart).toBe(true)
  })

  it('a second approval start under the same id replaces the earlier run, so nothing is doubled', async () => {
    const resume = (version: number, content: string) => ({ approvalResume: { version, prior: { content, metadata: {}, intermediateSteps: [] } } })
    start('m-card', resume(1, 'Before approval.'))
    chunk('m-card', 'First continuation.')
    expect((await rebuild('m-card'))?.content).toBe('Before approval.\n\nFirst continuation.')

    start('m-card', resume(2, 'Before approval.\n\nFirst continuation.'))
    chunk('m-card', 'Second continuation.')
    const second = await rebuild('m-card')
    expect(second?.content).toBe('Before approval.\n\nFirst continuation.\n\nSecond continuation.')
    expect(listReplayEvents(SESSION).filter((event) => event.type === 'start')).toHaveLength(1)
  })

  it('lets a finished message go after its terminal wait, and tells the caller when the chat is empty', () => {
    vi.useFakeTimers()
    const onChatEmpty = vi.fn()
    start('m1')
    chunk('m1', 'Done.')
    scheduleReplyRecordCleanup(SESSION, 'm1', { onChatEmpty })
    vi.advanceTimersByTime(4999)
    expect(hasReplyRecord(SESSION, 'm1')).toBe(true)
    vi.advanceTimersByTime(1)
    expect(hasReplyRecord(SESSION, 'm1')).toBe(false)
    expect(listReplayEvents(SESSION)).toEqual([])
    expect(onChatEmpty).toHaveBeenCalledTimes(1)
  })

  it('one group speaker’s end leaves the next speaker’s record and open block alone', async () => {
    vi.useFakeTimers()
    start('speaker-1')
    chunk('speaker-1', 'First speaker.')
    start('speaker-2')
    chunk('speaker-2', 'Second speaker: ')
    await replyZipDetection.processChunk(SESSION, 'speaker-2', '<error>still open')
    // The first speaker's reply is rebuilt and ends.
    await rebuild('speaker-1')
    scheduleReplyRecordCleanup(SESSION, 'speaker-1')
    vi.advanceTimersByTime(10_000)
    expect(hasReplyRecord(SESSION, 'speaker-1')).toBe(false)
    expect(hasReplyRecord(SESSION, 'speaker-2')).toBe(true)
    vi.useRealTimers()
    expect((await rebuild('speaker-2'))?.content).toBe('Second speaker: <error>still open')
  })

  it('a new start of the same id cancels a pending cleanup, so the continuation keeps its record', () => {
    vi.useFakeTimers()
    start('m1')
    scheduleReplyRecordCleanup(SESSION, 'm1')
    start('m1')
    chunk('m1', 'still here')
    vi.advanceTimersByTime(10_000)
    expect(hasReplyRecord(SESSION, 'm1')).toBe(true)
  })
})

describe('replyStreamRecord: the rebuild the finalize saves', () => {
  beforeEach(() => __resetReplyRecordsForTests())
  afterEach(() => __resetReplyRecordsForTests())

  it('has nothing to rebuild for a reply it never recorded', async () => {
    expect(await rebuild('never-recorded')).toBeNull()
  })

  it('places a tool card where it ran, and writes the allow-list from the references and the text', async () => {
    start('m-tool')
    chunk('m-tool', 'Reading it.')
    recordReplyEvent(SESSION, { type: 'tool-call', sessionId: SESSION, messageId: 'm-tool', toolCallId: 'call-1', toolName: 'read_file', args: { path: 'a.ts' } })
    recordReplyEvent(SESSION, {
      type: 'tool-result',
      sessionId: SESSION,
      messageId: 'm-tool',
      toolCallId: 'call-1',
      toolName: 'read_file',
      args: { path: 'a.ts' },
      result: { content: 'x' },
      zipReferences: [{ zipId: 'cool_tool_1790000000001_abcd12', reference: COOL_A }]
    })
    chunk('m-tool', 'It has three lines.')

    const rebuilt = await rebuild('m-tool', {
      incomingZipReferences: [{ zipId: 'cool_tool_1790000000001_abcd12', reference: COOL_A }],
      endContent: 'Reading it. It has three lines.'
    })
    expect(rebuilt?.content).toBe(`Reading it.\n\n${COOL_A}\n\nIt has three lines.`)
    expect(rebuilt?.zipIds).toEqual(['cool_tool_1790000000001_abcd12'])
    expect(rebuilt?.ownIntermediateSteps).toMatchObject([{ toolName: 'read_file', toolArgs: { path: 'a.ts' } }])
  })

  it('writes an empty allow-list for a reply with no zips, never none', async () => {
    start('m-plain')
    chunk('m-plain', 'Just words.')
    const rebuilt = await rebuild('m-plain')
    expect(rebuilt?.zipIds).toEqual([])
    expect(rebuilt?.content).toBe('Just words.')
  })

  it('drops the control blocks the reply end applied, and only when it says so', () => {
    const blocks = '\n<batshit-tool-notes>{"notes":[{"toolName":"bash","summary":"ok"}]}</batshit-tool-notes>'
    const reconstruction = { start: null, events: [{ type: 'chunk', messageId: 'm', content: `All done.${blocks}` }] }
    expect(buildRecordedReplyEnd({ reconstruction, inlineCapable: true, replyControlFinalized: true }).content).toBe('All done.')
    // The page's own sanitize still removed a complete bulky control block from an unfinalized reply.
    expect(
      buildRecordedReplyEnd({ reconstruction, inlineCapable: true, replyControlFinalized: false }).content
    ).toBe('All done.')
  })

  it('strips a group speaker’s Goon cues, emote tags and stage directions, as its own copy is stripped', () => {
    const reconstruction = {
      start: null,
      events: [{
        type: 'chunk',
        messageId: 'm',
        content: ['<batshit-cue>{"mood":"playful"}</batshit-cue>', '<emote-wink>.</emote-wink>', '*goon: wave*', 'Visible group reply.'].join('\n')
      }]
    }
    const group = buildRecordedReplyEnd({ reconstruction, inlineCapable: true, replyControlFinalized: true, groupChat: true })
    expect(group.content).toBe('Visible group reply.')
    const single = buildRecordedReplyEnd({ reconstruction, inlineCapable: true, replyControlFinalized: true })
    expect(single.content).toContain('*goon: wave*')
  })

  it('uses the server’s own text only when the record holds no words', () => {
    const reconstruction = { start: { type: 'start', messageId: 'm' }, events: [] }
    expect(
      buildRecordedReplyEnd({ reconstruction, endContent: 'Server text.', inlineCapable: true, replyControlFinalized: true }).content
    ).toBe('Server text.')
  })

  it('joins an approval resume’s earlier part once, and keeps this run’s steps apart from the merged list', () => {
    const priorStep = { toolName: 'bash', toolArgs: { command: 'ls' } }
    const ownStep = { toolName: 'read_file', toolArgs: { path: 'a.ts' } }
    const reconstruction = {
      start: {
        type: 'start',
        messageId: 'm-card',
        metadata: { approvalResume: { version: 7, prior: { content: 'Before the card.', metadata: {}, intermediateSteps: [priorStep] } } }
      },
      events: [{ type: 'chunk', messageId: 'm-card', content: 'After the click.' }]
    }
    const rebuilt = buildRecordedReplyEnd({
      reconstruction,
      intermediateSteps: [ownStep],
      inlineCapable: true,
      replyControlFinalized: true
    })
    expect(rebuilt.content).toBe('Before the card.\n\nAfter the click.')
    expect(rebuilt.ownIntermediateSteps).toEqual([ownStep])
    expect(rebuilt.intermediateSteps).toEqual([priorStep, ownStep])
  })

  it('takes the words of an error block that never closed into the record, where they were written (BL-489)', async () => {
    start('m-open')
    chunk('m-open', 'Intro. ')
    await replyZipDetection.processChunk(SESSION, 'm-open', '<error> never closed')
    const rebuilt = await rebuild('m-open')
    expect(rebuilt?.content).toBe('Intro. <error> never closed')
    expect(listReplayEvents(SESSION).at(-1)).toMatchObject({ type: 'chunk', content: '<error> never closed' })
  })

  // BL-775 deep read: the finalize's order is flush, close, rebuild. The rebuild used to write the
  // held words itself, after the close, where a closed reply refuses every content event: the last
  // words of a reply that ended inside an unclosed error block, or in a lone `<` up to `<erro`,
  // were lost from the stored reply and from `end`.
  it('keeps the held words when the finalize flushes them, then closes, then rebuilds (the real order)', async () => {
    start('m-held')
    chunk('m-held', 'Intro. ')
    await replyZipDetection.processChunk(SESSION, 'm-held', '<error>Traceback: never closed')
    expect(flushHeldReplyText(SESSION, 'm-held')).toBe(true)
    closeReplyRecord(SESSION, 'm-held')

    const rebuilt = await rebuild('m-held')
    expect(rebuilt?.content).toBe('Intro. <error>Traceback: never closed')
    // Written once, as a chunk of the still open reply, and the detector gives nothing twice.
    expect(listReplayEvents(SESSION).filter((event) => event.type === 'chunk').map((event) => event.content)).toEqual([
      'Intro. ',
      '<error>Traceback: never closed'
    ])
    expect(replyZipDetection.takeUnclosedText(SESSION, 'm-held')).toBe('')
  })

  it('keeps a lone start of the error tag the reply ended on', async () => {
    for (const tail of ['<', '<e', '<er', '<erro']) {
      __resetReplyRecordsForTests()
      start('m-tag')
      chunk('m-tag', 'And then ')
      await replyZipDetection.processChunk(SESSION, 'm-tag', tail)
      expect(flushHeldReplyText(SESSION, 'm-tag')).toBe(true)
      closeReplyRecord(SESSION, 'm-tag')
      expect((await rebuild('m-tag'))?.content, tail).toBe(`And then ${tail}`)
    }
  })

  it('flushes nothing when the detector holds nothing, and leaves a reply with no record alone', async () => {
    start('m-none')
    chunk('m-none', 'All closed.')
    expect(flushHeldReplyText(SESSION, 'm-none')).toBe(false)
    expect(listReplayEvents(SESSION).filter((event) => event.type === 'chunk')).toHaveLength(1)

    // Held words with no record to write them to stay held; the finalize then saves its own copy.
    await replyZipDetection.processChunk(SESSION, 'never-recorded', '<error>held')
    expect(flushHeldReplyText(SESSION, 'never-recorded')).toBe(false)
    expect(hasReplyRecord(SESSION, 'never-recorded')).toBe(false)
    expect(replyZipDetection.takeUnclosedText(SESSION, 'never-recorded')).toBe('<error>held')
  })

  // A finalize that closes without flushing is a bug in the caller; the rebuild says so loudly and
  // still keeps the words, in this rebuild only: the closed record is not written to.
  it('reports held words found at the rebuild of a closed reply, and still keeps them in the rebuild', async () => {
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => {})
    try {
      start('m-late-held')
      chunk('m-late-held', 'Intro. ')
      await replyZipDetection.processChunk(SESSION, 'm-late-held', '<error>Traceback: never closed')
      closeReplyRecord(SESSION, 'm-late-held')

      const rebuilt = await rebuild('m-late-held')
      expect(rebuilt?.content).toBe('Intro. <error>Traceback: never closed')
      expect(errorLog).toHaveBeenCalledTimes(1)
      expect(errorLog.mock.calls[0][1]).toMatchObject({ sessionId: SESSION, messageId: 'm-late-held' })
      // The closed record was not written to.
      expect(listReplayEvents(SESSION).filter((event) => event.type === 'chunk').map((event) => event.content)).toEqual(['Intro. '])
    } finally {
      errorLog.mockRestore()
    }
  })

  it('a rebuild of a reply that was never closed still takes the held words itself', async () => {
    start('m-open-rebuild')
    chunk('m-open-rebuild', 'Intro. ')
    await replyZipDetection.processChunk(SESSION, 'm-open-rebuild', '<error> never closed')
    expect((await rebuild('m-open-rebuild'))?.content).toBe('Intro. <error> never closed')
  })

  // Moved from the `/api/sse` end tests with the rebuild (BL-775).
  it('keeps the words the reply end kept when it drops the finalized blocks (BL-442)', () => {
    const words = [
      'Here is how:',
      '```',
      '<batshit-memory>{"lane":"ltm","content":"example"}</batshit-memory>',
      '```',
      'I write a <batshit-memory> block to save it. If x < 5 it waits.'
    ].join('\n')
    const reconstruction = {
      start: null,
      events: [{ type: 'chunk', messageId: 'm', content: `${words}\n<batshit-memory>{"lane":"ltm","content":"Josh likes tea"}</batshit-memory>\nThe end <` }]
    }
    expect(buildRecordedReplyEnd({ reconstruction, inlineCapable: true, replyControlFinalized: true }).content).toBe(`${words}\n\nThe end <`)
  })

  it('keeps a trusted prior zip when a resumed record has an allow-list id but no zip metadata', () => {
    const zipId = 'cool_tool_1789786818581_y9csi'
    const reference = `{{batshit-zip:${zipId}}}`
    const reconstruction = {
      start: {
        type: 'start',
        messageId: 'm',
        metadata: { approvalResume: { version: 43, prior: { content: `Before approval.\n\n${reference}`, metadata: { zipIds: [zipId] }, intermediateSteps: [] } } }
      },
      events: []
    }
    const rebuilt = buildRecordedReplyEnd({ reconstruction, inlineCapable: true, replyControlFinalized: true })
    expect(rebuilt.content).toBe(`Before approval.\n\n${reference}`)
    expect(rebuilt.zipIds).toEqual([zipId])
  })

  // BL-707, BL-746: every scan of the rebuild is linear; a reply of openers that never close, or
  // of whitespace-only lines with tool artifacts, used to hold the one Node process for seconds.
  it('rebuilds a 1 MB reply of 20,000 unclosed openers in well under 200 ms (BL-707)', () => {
    for (const family of ['zip', 'toolLoadingPlaceholder'] as const) {
      for (const [shape, reply] of Object.entries(unclosedReferenceReplies(family))) {
        const reconstruction = { start: null, events: [{ type: 'chunk', messageId: 'm', content: reply }] }
        const started = performance.now()
        const rebuilt = buildRecordedReplyEnd({
          reconstruction,
          intermediateSteps: [{ toolName: 'bash', toolResult: 'ok' }],
          incomingZipReferences: [{ reference: reply } as any],
          endContent: reply,
          inlineCapable: true,
          replyControlFinalized: true
        })
        expect(performance.now() - started, `${family}, ${shape}`).toBeLessThan(200)
        expect(rebuilt.content.length, shape).toBeGreaterThan(0)
      }
    }
  }, 60_000)

  it('rebuilds a 1 MB reply of whitespace-only lines with tool artifacts in well under a second (BL-746)', () => {
    const size = 1024 * 1024
    const lines = (unit: string, last = '') => unit.repeat(Math.ceil((size - last.length) / unit.length)) + last
    for (const reply of [lines('\n '), lines('\n\t'), lines('\r\n '), lines('\n ', 'x'), lines('\n ', '{'), lines('\r\n\t', '[')]) {
      const reconstruction = { start: null, events: [{ type: 'chunk', messageId: 'm', content: reply }] }
      const started = performance.now()
      const rebuilt = buildRecordedReplyEnd({
        reconstruction,
        intermediateSteps: [{ toolName: 'bash', toolResult: 'ok' }],
        endContent: reply,
        inlineCapable: true,
        replyControlFinalized: true
      })
      expect(performance.now() - started).toBeLessThan(1_000)
      expect(rebuilt.content).toBe(reply.trim())
    }
  }, 60_000)

  // BL-775: after the finalize closed a reply, a content or tool event of it is refused at the
  // write itself (the route checks on arrival and before its zip detection too); the next start
  // (an approval resume) reopens it, and a terminal event is never refused.
  it('refuses a late content or tool event of a closed reply at the write, until its next start', () => {
    start('m-closed')
    expect(recordReplyEvent(SESSION, { type: 'chunk', messageId: 'm-closed', content: 'On time.' })).toBe(true)
    closeReplyRecord(SESSION, 'm-closed')
    expect(isLateReplyEvent(SESSION, { type: 'chunk', messageId: 'm-closed' })).toBe(true)
    expect(isLateReplyEvent(SESSION, { type: 'end', messageId: 'm-closed' })).toBe(false)
    expect(recordReplyEvent(SESSION, { type: 'chunk', messageId: 'm-closed', content: ' Late.' })).toBe(false)
    expect(recordReplyEvent(SESSION, { type: 'tool-result', messageId: 'm-closed', toolCallId: 'c1' })).toBe(false)
    expect(recordReplyEvent(SESSION, { type: 'complete', messageId: 'm-closed' })).toBe(true)
    const chunks = listReplayEvents(SESSION).filter((event) => event.type === 'chunk').map((event) => event.content)
    expect(chunks).toEqual(['On time.'])

    start('m-closed')
    expect(isLateReplyEvent(SESSION, { type: 'chunk', messageId: 'm-closed' })).toBe(false)
    expect(recordReplyEvent(SESSION, { type: 'chunk', messageId: 'm-closed', content: 'Resumed.' })).toBe(true)
  })
})


/**
 * BL-759: a managed lane may take back a segment of a reply (a Codex message that dropped and was
 * started again), by the segment's name. The record keeps each segment's text apart (adjacent
 * chunks of different segments are never joined), and a retract removes that segment's chunks
 * from the rebuild's reconstruction and from a joining tab's replay, rewinds the zip detector, and
 * removes a zip made from the fragment. It answers the reply's text as it now reads, for the tabs.
 */
describe('replyStreamRecord: a segment taken back (BL-759)', () => {
  beforeEach(() => __resetReplyRecordsForTests())
  afterEach(() => __resetReplyRecordsForTests())

  function segmentChunk(messageId: string, content: string, segmentId?: string) {
    return recordReplyEvent(SESSION, {
      type: 'chunk',
      sessionId: SESSION,
      messageId,
      content,
      ...(segmentId ? { segmentId } : {})
    })
  }

  it('never joins adjacent chunks of different segments, so a retract removes exactly the fragment', async () => {
    start('m-retry')
    segmentChunk('m-retry', 'Intro. ')
    segmentChunk('m-retry', 'Partial ', 'msg_1')
    segmentChunk('m-retry', 'before the drop ', 'msg_1')

    const retracted = await retractReplySegment(SESSION, 'm-retry', 'msg_1')
    expect(retracted).toMatchObject({ removedText: 'Partial before the drop ', detector: 'unknown', removedZipIds: [], content: 'Intro. ' })

    segmentChunk('m-retry', 'Hello after the retry.', 'msg_2')
    expect((await rebuild('m-retry'))?.content).toBe('Intro. Hello after the retry.')
  })

  it('a tab that joins after the retract is never sent the fragment', async () => {
    start('m-join')
    segmentChunk('m-join', 'Partial ', 'msg_1')
    await retractReplySegment(SESSION, 'm-join', 'msg_1')
    segmentChunk('m-join', 'Hello.', 'msg_2')

    const chunks = listReplayEvents(SESSION).filter((event) => event.type === 'chunk')
    expect(chunks.map((event) => [event.segmentId, event.content])).toEqual([['msg_2', 'Hello.']])
  })

  it('keeps a finished message and a tool card before the fragment, in place', async () => {
    const toolReply = (messageId: string, fragment: boolean) => {
      start(messageId)
      segmentChunk(messageId, 'Let me check. ', 'msg_1')
      recordReplyEvent(SESSION, { type: 'tool_start', messageId, toolCallId: 'call_1', order: 0 })
      recordReplyEvent(SESSION, { type: 'tool-call', messageId, toolCallId: 'call_1', order: 0 })
      recordReplyEvent(SESSION, {
        type: 'tool-result',
        messageId,
        toolCallId: 'call_1',
        order: 0,
        zipReferences: [{ zipId: 'cool_tool_1790000000001_abcd12', reference: COOL_A }]
      })
      if (fragment) segmentChunk(messageId, 'The answer is', 'msg_2')
    }
    const refs = [{ zipId: 'cool_tool_1790000000001_abcd12', reference: COOL_A }]

    toolReply('m-tool', true)
    const retracted = await retractReplySegment(SESSION, 'm-tool', 'msg_2')
    // The text so far, as a tab draws it: the card where it ran, no fragment.
    expect(retracted?.content).toBe(`Let me check. \n\n${COOL_A}`)
    segmentChunk('m-tool', 'It said pong.', 'msg_3')

    toolReply('m-never-dropped', false)
    segmentChunk('m-never-dropped', 'It said pong.', 'msg_3')

    const rebuilt = await rebuild('m-tool', { incomingZipReferences: refs })
    const reference = await rebuild('m-never-dropped', { incomingZipReferences: refs })
    expect(rebuilt?.content).toBe(reference?.content)
    expect(rebuilt?.content).toContain(COOL_A)
    expect(rebuilt?.content).not.toContain('The answer is')
    expect(rebuilt?.content.endsWith('It said pong.')).toBe(true)
  })

  it('rewinds the zip detector and removes an Error zip the fragment closed', async () => {
    start('m-zip')
    const fragment = await replyZipDetection.processChunk(SESSION, 'm-zip', 'Oops <error>trace</error> then', 'msg_1')
    segmentChunk('m-zip', fragment.content, 'msg_1')
    const [ref] = replyZipDetection.getMessageReferences(SESSION, 'm-zip')
    expect(ref?.zipId).toMatch(/^error_/)
    expect(await redis.json.get(`zip:${ref.zipId}`)).not.toBeNull()

    const retracted = await retractReplySegment(SESSION, 'm-zip', 'msg_1')
    expect(retracted).toMatchObject({ removedText: fragment.content, detector: 'rewound', removedZipIds: [ref.zipId], content: '' })
    expect(await redis.json.get(`zip:${ref.zipId}`)).toBeNull()
    expect(replyZipDetection.getMessageReferences(SESSION, 'm-zip')).toEqual([])

    const answer = await replyZipDetection.processChunk(SESSION, 'm-zip', 'Hello.', 'msg_2')
    segmentChunk('m-zip', answer.content, 'msg_2')
    const rebuilt = await rebuild('m-zip')
    expect(rebuilt?.content).toBe('Hello.')
    expect(rebuilt?.zipReferences).toEqual([])
  })

  it('refuses a retract of a reply the finalize already closed, and counts a retract as a recorded event', async () => {
    start('m-late')
    segmentChunk('m-late', 'Partial ', 'msg_1')
    closeReplyRecord(SESSION, 'm-late')

    expect(isLateReplyEvent(SESSION, { type: 'text_retract', messageId: 'm-late' })).toBe(true)
    expect(await retractReplySegment(SESSION, 'm-late', 'msg_1')).toBeNull()
    expect(listReplayEvents(SESSION).filter((event) => event.type === 'chunk')).toHaveLength(1)
    // A forward of a retract that fails or passes its limit is a gap, like a chunk's (BL-775).
    expect(REPLY_RECORDED_EVENT_TYPES.has('text_retract')).toBe(true)
  })

  /** A chunk as `/api/sse` reads one: through the stream path's zip detector, then recorded. */
  async function streamed(messageId: string, content: string, segmentId?: string) {
    const out = await replyZipDetection.processChunk(SESSION, messageId, content, segmentId)
    if (out.shouldStream) segmentChunk(messageId, out.content, segmentId)
  }

  it('takes back a fragment the retry left last, before the steer marker the retried answer reads after it', async () => {
    start('m-steer')
    await streamed('m-steer', 'Oops <error>trace', 'msg_1')
    // The adapter hands on the retract before the steer (BL-759 review), so the fragment is last.
    const retracted = await retractReplySegment(SESSION, 'm-steer', 'msg_1')
    expect(retracted).toMatchObject({ detector: 'rewound', removedText: 'Oops ', content: '' })
    await streamed('m-steer', '[steer] ')
    await streamed('m-steer', 'Hello.', 'msg_2')
    expect((await rebuild('m-steer'))?.content).toBe('[steer] Hello.')
  })

  /**
   * A forced `superseded` (the adapter never lets one happen for Codex): the record is left as it
   * is and reported untrusted; `/api/sse` then answers the forward without success, send-routed
   * marks the reply a gap and its finalize saves its own copy (taken back by segment) and removes
   * the stream-made zips no message names. The last part is send-routed's finalize, emulated here
   * with the same calls (`takeStreamMadeZipReferences`, `redis.removeUnclaimedZipsMadeByMessage`);
   * its handler-level proof is phase 2.
   */
  async function savedThroughTheGap(messageId: string, ownCopy: SegmentedText) {
    await redis.saveMessage({ id: messageId, session_id: SESSION, role: 'assistant', content: ownCopy.toString() } as any)
    const streamMade = await takeStreamMadeZipReferences(SESSION, messageId)
    const ids = streamMade.map((ref) => ref.zipId).filter((id): id is string => Boolean(id))
    await redis.removeUnclaimedZipsMadeByMessage(SESSION, messageId, ids)
    return { saved: ((await redis.json.get(`message:${SESSION}:${messageId}`)) as any)?.content, ids }
  }

  const forcedCases: Array<{ name: string; chunks: Array<[string, string | undefined]> }> = [
    {
      name: 'a segment read in two runs',
      chunks: [['Oops <error>trace</error> then ', 'msg_1'], ['Steer. ', undefined], ['more', 'msg_1']]
    },
    {
      name: 'case A: the fragment closed a block an earlier segment began, then words with no segment',
      chunks: [['Intro <error>r-words ', 'msg_r'], ['x</error> y', 'msg_1'], ['Steer. ', undefined]]
    },
    {
      name: 'case C: the fragment\'s held start of a tag read into words with no segment',
      chunks: [['Intro. ', 'msg_r'], ['Oops <err', 'msg_1'], ['or>Steer. ', undefined]]
    }
  ]

  for (const { name, chunks } of forcedCases) {
    it(`a forced superseded retract leaves the record untrusted, and the gap path saves the right text (${name})`, async () => {
      const messageId = `m-forced-${forcedCases.findIndex((entry) => entry.name === name)}`
      start(messageId)
      const ownCopy = new SegmentedText()
      for (const [content, segmentId] of chunks) {
        await streamed(messageId, content, segmentId)
        ownCopy.append(content, segmentId)
      }
      const replayBefore = listReplayEvents(SESSION).length
      const refsBefore = replyZipDetection.getMessageReferences(SESSION, messageId)

      expect(await retractReplySegment(SESSION, messageId, 'msg_1')).toEqual({ detector: 'superseded' })
      // Nothing was taken out: the record is not trusted, and the finalize will not read it.
      expect(listReplayEvents(SESSION).length).toBe(replayBefore)
      expect(replyZipDetection.getMessageReferences(SESSION, messageId)).toEqual(refsBefore)

      ownCopy.retract('msg_1')
      await streamed(messageId, 'Hello.', 'msg_2')
      ownCopy.append('Hello.', 'msg_2')
      const expected = chunks
        .filter(([, segmentId]) => segmentId !== 'msg_1')
        .map(([content]) => content)
        .join('') + 'Hello.'

      const { saved, ids } = await savedThroughTheGap(messageId, ownCopy)
      expect(saved).toBe(expected)
      // No orphan: every zip the stream path made for the reply is gone (the own copy names none).
      for (const zipId of ids) expect(await redis.json.get(`zip:${zipId}`)).toBeNull()
    })
  }

  // Phase 2 review: once a retract of a reply was superseded, its record is not trusted; a later
  // retract that could rewind must not send the tabs a text built from it (it still holds the
  // first fragment). A new start (an approval resume) trusts the record again.
  it('refuses every later retract of a reply whose record is no longer trusted', async () => {
    start('m-untrusted')
    await streamed('m-untrusted', 'First try', 'msg_1')
    await streamed('m-untrusted', ' kept', undefined)
    expect(await retractReplySegment(SESSION, 'm-untrusted', 'msg_1')).toEqual({ detector: 'superseded' })
    await streamed('m-untrusted', 'Second try', 'msg_2')
    const replayBefore = listReplayEvents(SESSION).length
    expect(await retractReplySegment(SESSION, 'm-untrusted', 'msg_2')).toEqual({ detector: 'superseded' })
    expect(listReplayEvents(SESSION).length).toBe(replayBefore)

    start('m-untrusted')
    await streamed('m-untrusted', 'Resumed try', 'msg_3')
    expect((await retractReplySegment(SESSION, 'm-untrusted', 'msg_3'))?.detector).toBe('rewound')
  })

  it('a retract after an approval resume keeps the earlier part first', async () => {
    start('m-resumed', { approvalResume: { version: 3, prior: { content: 'Before approval.', metadata: {}, intermediateSteps: [] } } })
    segmentChunk('m-resumed', 'Continued. ')
    segmentChunk('m-resumed', 'Partial', 'msg_1')

    const retracted = await retractReplySegment(SESSION, 'm-resumed', 'msg_1')
    expect(retracted?.content).toBe('Before approval.\n\nContinued. ')
    segmentChunk('m-resumed', 'Answer.', 'msg_2')
    expect((await rebuild('m-resumed'))?.content).toBe('Before approval.\n\nContinued. Answer.')
  })

  it('does not remove a fragment\'s zip that a stored message already names', async () => {
    start('m-claimed')
    await streamed('m-claimed', 'Oops <error>trace</error>', 'msg_1')
    const [ref] = replyZipDetection.getMessageReferences(SESSION, 'm-claimed')
    await redis.saveMessage({
      id: 'm-earlier',
      session_id: SESSION,
      role: 'assistant',
      content: 'An earlier reply.',
      metadata: { zipIds: [ref.zipId] }
    } as any)

    const retracted = await retractReplySegment(SESSION, 'm-claimed', 'msg_1')
    expect(retracted).toMatchObject({ detector: 'rewound', removedZipIds: [] })
    expect(await redis.json.get(`zip:${ref.zipId}`)).not.toBeNull()
  })

  it('has nothing to take back from a reply it never recorded', async () => {
    expect(await retractReplySegment(SESSION, 'm-none', 'msg_1')).toBeNull()
  })
})
