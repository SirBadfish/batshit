import { afterEach, describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'

/**
 * BL-723: a regular chat's graduation mark (`metadata.memoryGraduation`) is written at its own
 * path, in one step inside Redis (`redis.writeRegularGraduationMark`). The graduation used to
 * read the chat and write that copy's whole metadata back through `updateSession`, which erased
 * a Compact event, the origin block, or the group written in between.
 *
 * BL-737: the write is a COMPARE-AND-SET on `lastGraduatedMessageId` — the id the CALLER read as
 * its starting mark (`expectedLastGraduatedMessageId`, `null` for "read none") — against the
 * mark's CURRENT stored id. Two graduations of one chat can run at once (an idle timer and a
 * session-close, say); a timestamp-ordering fix here used to let the later WRITE win even when it
 * carried an older tail, and got permanently stuck once the marked message was deleted (the next
 * graduation could never find it again, so its check compared against a stale tail forever and
 * answered STALE on every write). The CAS never gets stuck: a resumed graduation always reads and
 * matches the CURRENT stored id, deleted message or not.
 *
 * Real Redis 8 under `npm run test:redis` (a Lua script there); the default lane's fake twin
 * under plain `npm test`.
 */

useRedisTestServer()

const USER = 'zcmeta_user'
const SESSION = 'zcmeta_mark_session'

const compactEvent = {
  id: 'zcmeta_evt',
  createdAt: '2026-09-27T12:00:00.000Z',
  sourceMessageIds: ['u1', 'a1'],
  summary: 'Written by a Compact.'
}

async function seed(record: Record<string, unknown>) {
  await redis.json.set(`session:${SESSION}`, '$', {
    id: SESSION,
    user_id: USER,
    name: 'Shed',
    created_at: '2026-09-27T09:00:00.000Z',
    last_modified_at: '2026-09-27T09:00:00.000Z',
    ...record
  } as never)
}

async function stored() {
  return (await redis.getSession(SESSION)) as any
}

afterEach(async () => {
  await redis.del(`session:${SESSION}`)
})

describe('the graduation mark is written by path (BL-723)', () => {
  it('writes the mark and leaves every other metadata block and field as stored', async () => {
    await seed({
      locked: true,
      metadata: {
        agent_id: 'zcmeta_agent',
        contextCompaction: { version: 1, events: [compactEvent] },
        origin: { kind: 'zcmeta_origin' }
      }
    })

    const written = await redis.writeRegularGraduationMark(
      SESSION,
      {
        lastGraduatedMessageId: 'a7',
        lastGraduatedAt: '2026-09-27T13:00:00.000Z',
        segmentId: 'zcmeta_seg_1'
      },
      null
    )

    expect(written).toBe('ok')
    const record = await stored()
    expect(record.metadata).toEqual({
      agent_id: 'zcmeta_agent',
      contextCompaction: { version: 1, events: [compactEvent] },
      origin: { kind: 'zcmeta_origin' },
      memoryGraduation: {
        version: 1,
        lastGraduatedMessageId: 'a7',
        lastGraduatedAt: '2026-09-27T13:00:00.000Z',
        segmentIds: ['zcmeta_seg_1']
      }
    })
    expect(record.locked).toBe(true)
    expect(record.name).toBe('Shed')
    expect(record.last_modified_at).not.toBe('2026-09-27T09:00:00.000Z')
  })

  it('adds the segment to the stored list, not to a list read earlier, and keeps the last 100', async () => {
    const before = Array.from({ length: 100 }, (_, index) => `zcmeta_seg_old_${index}`)
    await seed({
      metadata: {
        memoryGraduation: {
          version: 1,
          lastGraduatedMessageId: 'a1',
          lastGraduatedAt: '2026-09-26T00:00:00.000Z',
          segmentIds: before
        }
      }
    })

    expect(
      await redis.writeRegularGraduationMark(
        SESSION,
        {
          lastGraduatedMessageId: 'a9',
          lastGraduatedAt: '2026-09-27T13:00:00.000Z',
          segmentId: 'zcmeta_seg_new'
        },
        'a1'
      )
    ).toBe('ok')

    const mark = (await stored()).metadata.memoryGraduation
    expect(mark.lastGraduatedMessageId).toBe('a9')
    expect(mark.lastGraduatedAt).toBe('2026-09-27T13:00:00.000Z')
    expect(mark.segmentIds).toEqual([...before.slice(1), 'zcmeta_seg_new'])
  })

  it('writes the mark on a chat record with no metadata object, or with a mark that is not an object', async () => {
    await seed({})
    expect(
      await redis.writeRegularGraduationMark(
        SESSION,
        {
          lastGraduatedMessageId: 'a2',
          lastGraduatedAt: '2026-09-27T13:00:00.000Z',
          segmentId: 'zcmeta_seg_1'
        },
        null
      )
    ).toBe('ok')
    expect((await stored()).metadata).toEqual({
      memoryGraduation: {
        version: 1,
        lastGraduatedMessageId: 'a2',
        lastGraduatedAt: '2026-09-27T13:00:00.000Z',
        segmentIds: ['zcmeta_seg_1']
      }
    })

    await seed({ metadata: { memoryGraduation: 'broken', origin: { kind: 'zcmeta_origin' } } })
    expect(
      await redis.writeRegularGraduationMark(
        SESSION,
        {
          lastGraduatedMessageId: 'a3',
          lastGraduatedAt: '2026-09-27T14:00:00.000Z',
          segmentId: 'zcmeta_seg_2'
        },
        null
      )
    ).toBe('ok')
    expect((await stored()).metadata).toEqual({
      origin: { kind: 'zcmeta_origin' },
      memoryGraduation: {
        version: 1,
        lastGraduatedMessageId: 'a3',
        lastGraduatedAt: '2026-09-27T14:00:00.000Z',
        segmentIds: ['zcmeta_seg_2']
      }
    })
  })

  it('replaces a stored segmentIds that is not a list, rather than appending to it (BL-738)', async () => {
    await seed({
      metadata: {
        memoryGraduation: {
          version: 1,
          lastGraduatedMessageId: 'a1',
          lastGraduatedAt: '2026-09-26T00:00:00.000Z',
          segmentIds: 'zcmeta_not_a_list'
        }
      }
    })

    expect(
      await redis.writeRegularGraduationMark(
        SESSION,
        {
          lastGraduatedMessageId: 'a5',
          lastGraduatedAt: '2026-09-27T13:00:00.000Z',
          segmentId: 'zcmeta_seg_new'
        },
        'a1'
      )
    ).toBe('ok')

    const mark = (await stored()).metadata.memoryGraduation
    expect(mark.lastGraduatedMessageId).toBe('a5')
    expect(mark.segmentIds).toEqual(['zcmeta_seg_new'])
  })

  it('writes the mark on a chat whose stored metadata is null (BL-738)', async () => {
    await seed({ metadata: null })

    expect(
      await redis.writeRegularGraduationMark(
        SESSION,
        {
          lastGraduatedMessageId: 'a2',
          lastGraduatedAt: '2026-09-27T13:00:00.000Z',
          segmentId: 'zcmeta_seg_1'
        },
        null
      )
    ).toBe('ok')
    expect((await stored()).metadata).toEqual({
      memoryGraduation: {
        version: 1,
        lastGraduatedMessageId: 'a2',
        lastGraduatedAt: '2026-09-27T13:00:00.000Z',
        segmentIds: ['zcmeta_seg_1']
      }
    })
  })

  it('a chat that is gone: "missing", and nothing is written', async () => {
    expect(
      await redis.writeRegularGraduationMark(
        SESSION,
        {
          lastGraduatedMessageId: 'a2',
          lastGraduatedAt: '2026-09-27T13:00:00.000Z',
          segmentId: 'zcmeta_seg_1'
        },
        null
      )
    ).toBe('missing')
    expect(await redis.exists(`session:${SESSION}`)).toBe(false)
  })
})

describe('the graduation mark write is a compare-and-set (BL-737)', () => {
  it('the marked message was deleted, then a graduation resumes: it reads the current id and its CAS matches', async () => {
    // The chat's mark points at 'a5', but that message no longer exists in the chat (deleted).
    // A resuming graduation reads 'a5' as its OWN starting mark (memoryGraduation.ts's
    // `findIndex` fails, `tailStart` falls back to 0, but `lastGraduatedId` itself is still read
    // as 'a5') and its tail now ends past it — its write must succeed and move the mark forward.
    await seed({
      metadata: {
        memoryGraduation: {
          version: 1,
          lastGraduatedMessageId: 'a5',
          lastGraduatedAt: '2026-09-26T00:00:00.000Z',
          segmentIds: ['zcmeta_seg_old']
        }
      }
    })

    expect(
      await redis.writeRegularGraduationMark(
        SESSION,
        {
          lastGraduatedMessageId: 'a12',
          lastGraduatedAt: '2026-09-27T13:00:00.000Z',
          segmentId: 'zcmeta_seg_resumed'
        },
        'a5'
      )
    ).toBe('ok')

    const mark = (await stored()).metadata.memoryGraduation
    expect(mark.lastGraduatedMessageId).toBe('a12')
    expect(mark.segmentIds).toEqual(['zcmeta_seg_old', 'zcmeta_seg_resumed'])
  })

  it('two overlapping graduations: the later-starting one that read the same old id answers superseded and leaves the first mark', async () => {
    // Both graduations read the chat with no mark yet (a fresh chat) and started their own
    // summary calls. The one covering the NEWER tail happens to finish first.
    await seed({ metadata: { agent_id: 'zcmeta_agent' } })

    expect(
      await redis.writeRegularGraduationMark(
        SESSION,
        {
          lastGraduatedMessageId: 'a10',
          lastGraduatedAt: '2026-09-27T13:05:00.000Z',
          segmentId: 'zcmeta_seg_newer'
        },
        null
      )
    ).toBe('ok')

    // The other graduation ALSO read no mark at its own start (it raced the first one, before
    // either had written). Its CAS still expects `null`, but the stored id is now 'a10': the CAS
    // no longer matches, so it must answer `superseded` and change nothing — never overwrite the
    // mark that already recorded the newer tail with its own, older one.
    expect(
      await redis.writeRegularGraduationMark(
        SESSION,
        {
          lastGraduatedMessageId: 'a5',
          lastGraduatedAt: '2026-09-27T13:06:00.000Z',
          segmentId: 'zcmeta_seg_older_race'
        },
        null
      )
    ).toBe('superseded')

    const mark = (await stored()).metadata.memoryGraduation
    expect(mark.lastGraduatedMessageId).toBe('a10')
    expect(mark.segmentIds).toEqual(['zcmeta_seg_newer'])
  })

  it('a second write reading the same already-advanced id also answers superseded', async () => {
    await seed({
      metadata: {
        memoryGraduation: {
          version: 1,
          lastGraduatedMessageId: 'a10',
          lastGraduatedAt: '2026-09-27T13:05:00.000Z',
          segmentIds: ['zcmeta_seg_first']
        }
      }
    })

    // A caller whose read is now stale (it read 'a1', say, before the mark above ever existed)
    // must not be able to write over the current mark.
    expect(
      await redis.writeRegularGraduationMark(
        SESSION,
        {
          lastGraduatedMessageId: 'a11',
          lastGraduatedAt: '2026-09-27T13:07:00.000Z',
          segmentId: 'zcmeta_seg_duplicate'
        },
        'a1'
      )
    ).toBe('superseded')

    const mark = (await stored()).metadata.memoryGraduation
    expect(mark.lastGraduatedMessageId).toBe('a10')
    expect(mark.segmentIds).toEqual(['zcmeta_seg_first'])
  })

  it('the chat is gone by the time the mark write runs: "missing", not "superseded"', async () => {
    // No seed at all: the chat does not exist. `EXISTS` must be checked before the CAS.
    expect(
      await redis.writeRegularGraduationMark(
        SESSION,
        {
          lastGraduatedMessageId: 'a2',
          lastGraduatedAt: '2026-09-27T13:00:00.000Z',
          segmentId: 'zcmeta_seg_1'
        },
        null
      )
    ).toBe('missing')
  })

  // BL-737 review: a CAS loser whose own segment the WINNER already reused and linked into its
  // mark must not answer plain `superseded` — the caller (`graduateRegularSessionTail`) uses
  // that answer to decide whether to delete the segment it just created, and deleting a segment
  // the winning mark now lists would leave that mark naming a segment that no longer exists.
  it('a CAS loser whose own segment the winner already linked answers superseded_linked, not superseded', async () => {
    await seed({ metadata: { agent_id: 'zcmeta_agent' } })

    // B (the winner) reuses A's segment 'zcmeta_seg_shared' and writes first.
    expect(
      await redis.writeRegularGraduationMark(
        SESSION,
        {
          lastGraduatedMessageId: 'a10',
          lastGraduatedAt: '2026-09-27T13:05:00.000Z',
          segmentId: 'zcmeta_seg_shared'
        },
        null
      )
    ).toBe('ok')

    // A (the loser) created 'zcmeta_seg_shared' itself and reads the same "no mark" start B did.
    // Its CAS no longer matches, but its own segment is already stored and listed by the winner.
    expect(
      await redis.writeRegularGraduationMark(
        SESSION,
        {
          lastGraduatedMessageId: 'a9',
          lastGraduatedAt: '2026-09-27T13:04:00.000Z',
          segmentId: 'zcmeta_seg_shared'
        },
        null
      )
    ).toBe('superseded_linked')

    // Nothing was overwritten: the winner's mark stands, and the shared segment is still listed.
    const mark = (await stored()).metadata.memoryGraduation
    expect(mark.lastGraduatedMessageId).toBe('a10')
    expect(mark.segmentIds).toEqual(['zcmeta_seg_shared'])
  })

  // BL-737 review: a stored `lastGraduatedMessageId` of `''` reads as "no mark" too, the same
  // sentinel a caller that read no mark at all passes as `null`/`''` — never a real id to CAS
  // against, and never a state the CAS can never again match.
  it('a stored empty-string mark id is read as "no mark", not as a permanent mismatch', async () => {
    await seed({
      metadata: {
        memoryGraduation: {
          version: 1,
          lastGraduatedMessageId: '',
          lastGraduatedAt: '2026-09-26T00:00:00.000Z',
          segmentIds: ['zcmeta_seg_old']
        }
      }
    })

    // A caller that also read no mark (the natural read of an empty-string id) must succeed.
    expect(
      await redis.writeRegularGraduationMark(
        SESSION,
        {
          lastGraduatedMessageId: 'a3',
          lastGraduatedAt: '2026-09-27T13:00:00.000Z',
          segmentId: 'zcmeta_seg_new'
        },
        null
      )
    ).toBe('ok')

    const mark = (await stored()).metadata.memoryGraduation
    expect(mark.lastGraduatedMessageId).toBe('a3')
    expect(mark.segmentIds).toEqual(['zcmeta_seg_old', 'zcmeta_seg_new'])
  })
})
