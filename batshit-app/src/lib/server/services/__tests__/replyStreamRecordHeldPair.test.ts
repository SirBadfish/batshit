// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetReplyRecordsForTests,
  closeReplyRecord,
  flushHeldReplyText,
  listReplayEvents,
  rebuildRecordedReply,
  recordReplyEvent,
  replyZipDetection,
  startReplyRecord,
  takeStreamMadeZipReferences
} from '$lib/server/services/replyStreamRecord'
import { redis } from '$lib/server/redis'
import { logger } from '$lib/utils/logger'
import { scanZipReferences } from '$lib/utils/zipReferenceSafety'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'

useRedisTestServer()

/**
 * BL-779 (a), the stream's half: the stream path's zip detector holds a closed `<error>` pair
 * whose opening tag follows a stray backtick in its paragraph, because a later backtick may still
 * make it code, as the full-reply pass would read it. The finalize's flush settles it: at the reply
 * end the pair is zipped, and its reference is recorded into the still open reply, before
 * `closeReplyRecord` (BL-775), so the saved reply names it. A reply the record does not hold makes
 * no zip of it at all.
 */

vi.mock('$lib/server/zipService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  finalizeAllZipBlocks: vi.fn(async () => [])
}))

const SESSION = 'session-held-pair'

beforeEach(async () => {
  __resetReplyRecordsForTests()
  await redis.createSession({ id: SESSION, user_id: 'held-pair-fixture', title: 'Held pair fixture' } as any)
})

/** One chunk through the stream path's detector, recorded as `/api/sse` records what it hands back. */
async function streamChunk(messageId: string, content: string) {
  const processed = await replyZipDetection.processChunk(SESSION, messageId, content)
  if (processed.shouldStream) {
    recordReplyEvent(SESSION, { type: 'chunk', sessionId: SESSION, messageId, content: processed.content })
  }
}

function recordedChunks(messageId: string) {
  return listReplayEvents(SESSION)
    .filter((event) => event.type === 'chunk' && event.messageId === messageId)
    .map((event) => event.content)
}

async function zipsOf(messageId: string) {
  const ids = (await redis.execute((client: any) => client.sMembers(`session:${SESSION}:zips`))) as string[]
  const zips = await Promise.all(ids.map(async (id) => (await redis.execute((client: any) => client.json.get(`zip:${id}`))) as any))
  return zips.filter((zip) => zip?.metadata?.messageId === messageId)
}

describe('reply record: a pair held after a stray backtick is settled by the finalize (BL-779 a)', () => {
  it('holds the pair while it may still be code, then zips it at the reply end and records it before the close', async () => {
    startReplyRecord(SESSION, { type: 'start', sessionId: SESSION, messageId: 'm-end', metadata: {} })
    await streamChunk('m-end', 'Use `<error>boom</error>')
    await streamChunk('m-end', ' and more.')

    // Held: a later backtick could still pair with the stray one over the tag.
    expect(recordedChunks('m-end')).toEqual(['Use `'])
    expect(await zipsOf('m-end')).toEqual([])

    expect(await flushHeldReplyText(SESSION, 'm-end')).toBe(true)
    closeReplyRecord(SESSION, 'm-end')

    const [zip] = await zipsOf('m-end')
    expect(zip?.content).toBe('boom')
    const reference = `{{batshit-zip:${zip.id}`
    expect(recordedChunks('m-end')).toHaveLength(2)
    expect(recordedChunks('m-end')[1]).toContain(reference)

    const rebuilt = await rebuildRecordedReply({ sessionId: SESSION, messageId: 'm-end', inlineCapable: true, replyControlFinalized: false })
    expect(rebuilt?.content.startsWith('Use `{{batshit-zip:')).toBe(true)
    expect(rebuilt?.content.endsWith('}} and more.')).toBe(true)
    expect(scanZipReferences(rebuilt!.content).map((ref) => ref.id)).toEqual([zip.id])
    expect(rebuilt?.zipIds).toContain(zip.id)
  })

  it('hands the pair back as words when a later backtick shows it was code, and makes no zip', async () => {
    startReplyRecord(SESSION, { type: 'start', sessionId: SESSION, messageId: 'm-code', metadata: {} })
    await streamChunk('m-code', 'Use `<error>boom</error>')
    await streamChunk('m-code', ' and `x` later.')

    expect(await flushHeldReplyText(SESSION, 'm-code')).toBe(false)
    closeReplyRecord(SESSION, 'm-code')
    const rebuilt = await rebuildRecordedReply({ sessionId: SESSION, messageId: 'm-code', inlineCapable: true, replyControlFinalized: false })
    expect(rebuilt?.content).toBe('Use `<error>boom</error> and `x` later.')
    expect(await zipsOf('m-code')).toEqual([])
  })

  it('makes the zip of a pair it settles for a gap reply a stream-made zip, which the own-copy sweep removes', async () => {
    startReplyRecord(SESSION, { type: 'start', sessionId: SESSION, messageId: 'm-gap', metadata: {} })
    await streamChunk('m-gap', 'Use `<error>boom</error>')
    expect(await flushHeldReplyText(SESSION, 'm-gap')).toBe(true)
    closeReplyRecord(SESSION, 'm-gap')

    // The finalize's own-copy path (the record is a gap): the stream-made zips no message names go.
    const streamMade = await takeStreamMadeZipReferences(SESSION, 'm-gap')
    const [zip] = await zipsOf('m-gap')
    expect(streamMade.map((ref) => ref.zipId)).toEqual([zip.id])
    await redis.removeUnclaimedZipsMadeByMessage(SESSION, 'm-gap', [zip.id])
    expect(await zipsOf('m-gap')).toEqual([])
  })

  it('says loudly what was lost when the reply refuses the held words its flush took (review N1)', async () => {
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => {})
    startReplyRecord(SESSION, { type: 'start', sessionId: SESSION, messageId: 'm-refused', metadata: {} })
    await streamChunk('m-refused', 'Use `<error>boom</error> and more.')
    const settle = replyZipDetection.takeHeldText.bind(replyZipDetection)
    vi.spyOn(replyZipDetection, 'takeHeldText').mockImplementationOnce(async (sessionId, messageId) => {
      const text = await settle(sessionId, messageId)
      closeReplyRecord(SESSION, 'm-refused')
      return text
    })

    expect(await flushHeldReplyText(SESSION, 'm-refused')).toBe(false)

    const [zip] = await zipsOf('m-refused')
    const call = errorLog.mock.calls.find((args) => String(args[0]).includes('BL-779'))
    expect(call?.[1]).toMatchObject({
      sessionId: SESSION,
      messageId: 'm-refused',
      droppedCharacters: expect.any(Number),
      zipIds: [zip.id]
    })
    expect((call?.[1] as { droppedCharacters: number }).droppedCharacters).toBeGreaterThan(0)
    errorLog.mockRestore()
  })

  it('makes no zip for a reply with no record: the held pair is dropped with the stream state, and the end releases nothing', async () => {
    await replyZipDetection.processChunk(SESSION, 'm-none', 'Use `<error>boom</error> and more.')

    expect(await flushHeldReplyText(SESSION, 'm-none')).toBe(false)
    // The finalize's own-copy sweep takes the stream state, then `complete` lets go of the reply.
    expect(await takeStreamMadeZipReferences(SESSION, 'm-none')).toEqual([])
    expect(replyZipDetection.releaseEndedReply(SESSION, 'm-none')).toBe('')
    expect(await zipsOf('m-none')).toEqual([])
  })
})
