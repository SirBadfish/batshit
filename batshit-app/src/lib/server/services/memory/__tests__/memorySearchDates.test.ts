// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'

/** BL-788: exercise the real search op's date-to-filter boundary. The existing
 * default Redis fake holds the agent; only the index and embedder are injected.
 * This proves calendar arithmetic and argument propagation, not FT.HYBRID or
 * a live embedder. Keep the worker's timezone local to this suite and restore it.
 */
vi.mock('../memoryIndex', async (importOriginal) => ({
  ...await importOriginal<typeof import('../memoryIndex')>(),
  hybridSearchMemories: vi.fn(async () => []),
  hybridSearchSegments: vi.fn(async () => [])
}))
vi.mock('../memoryEmbedder', async (importOriginal) => ({
  ...await importOriginal<typeof import('../memoryEmbedder')>(),
  createMemoryEmbedderAsync: vi.fn(async () => ({ embedQuery: async () => [1, 0] }))
}))

import { redis } from '$lib/server/redis'
import { hybridSearchMemories, hybridSearchSegments } from '../memoryIndex'
import { MemoryToolError, searchMemoriesOp } from '../memoryTools'

useRedisTestServer()
const PREVIOUS_TZ = process.env.TZ
const USER = 'bl788-user'
const AGENT = 'bl788-agent'
const CONTEXT = { userId: USER, agentId: AGENT }

beforeAll(() => { process.env.TZ = 'America/Los_Angeles' })
afterAll(() => {
  if (PREVIOUS_TZ === undefined) delete process.env.TZ
  else process.env.TZ = PREVIOUS_TZ
})
beforeEach(async () => {
  vi.clearAllMocks()
  await redis.json.set(`agent:${AGENT}`, '$', {
    id: AGENT, user_id: USER, name: 'Calendar search', memory_enabled: true
  } as never)
})

describe('BL-788 memory search calendar-day bounds', () => {
  it('uses the actual Pacific timezone and both daylight-saving offsets', () => {
    expect(new Date('2026-03-08T08:00:00.000Z').getTimezoneOffset()).toBe(480)
    expect(new Date('2026-03-09T06:59:59.999Z').getTimezoneOffset()).toBe(420)
    expect(new Date('2026-11-01T07:00:00.000Z').getTimezoneOffset()).toBe(420)
    expect(new Date('2026-11-02T07:59:59.999Z').getTimezoneOffset()).toBe(480)
  })

  for (const prefix of ['event', 'saved'] as const) {
    it.each([
      ['2026-03-08', '2026-03-08T08:00:00.000Z', '2026-03-09T06:59:59.999Z'],
      ['2026-11-01', '2026-11-01T07:00:00.000Z', '2026-11-02T07:59:59.999Z'],
      ['2026-10-01', '2026-10-01T07:00:00.000Z', '2026-10-02T06:59:59.999Z'],
      ['2026-12-31', '2026-12-31T08:00:00.000Z', '2027-01-01T07:59:59.999Z']
    ])(`${prefix} bounds include exactly the local day %s`, async (day, start, end) => {
      await searchMemoriesOp(CONTEXT, {
        query: 'calendar', [`${prefix}_from`]: ` ${day} `, [`${prefix}_to`]: day
      })
      const min = Date.parse(start)
      const max = Date.parse(end)
      expect(vi.mocked(hybridSearchMemories).mock.calls[0][0].filters).toEqual({
        [`${prefix}TsMin`]: min, [`${prefix}TsMax`]: max
      })
      expect(vi.mocked(hybridSearchSegments).mock.calls[0][0].filters).toEqual({
        timeMin: min, timeMax: max
      })
      // The last millisecond belongs to the day; the next one is next-day midnight.
      expect(new Date(max).toString()).toContain('23:59:59')
      expect(new Date(max + 1).getHours()).toBe(0)
    })

    it(`${prefix} full timestamps retain their exact instant and offset`, async () => {
      await searchMemoriesOp(CONTEXT, {
        query: 'calendar', [`${prefix}_from`]: '2026-11-01T01:30:00-07:00',
        [`${prefix}_to`]: '2026-11-01T01:30:00-08:00'
      })
      expect(vi.mocked(hybridSearchMemories).mock.calls[0][0].filters).toEqual({
        [`${prefix}TsMin`]: Date.parse('2026-11-01T08:30:00.000Z'),
        [`${prefix}TsMax`]: Date.parse('2026-11-01T09:30:00.000Z')
      })
    })

    it(`${prefix} includes the repeated final hour in a midnight rollback`, async () => {
      process.env.TZ = 'America/Santiago'
      try {
        await searchMemoriesOp(CONTEXT, {
          query: 'calendar', [`${prefix}_from`]: '2026-04-04', [`${prefix}_to`]: '2026-04-04'
        })
        const min = Date.parse('2026-04-04T03:00:00.000Z')
        const max = Date.parse('2026-04-05T03:59:59.999Z')
        expect(new Date(min).getTimezoneOffset()).toBe(180)
        expect(new Date(max).getTimezoneOffset()).toBe(240)
        expect(vi.mocked(hybridSearchMemories).mock.calls[0][0].filters).toEqual({
          [`${prefix}TsMin`]: min, [`${prefix}TsMax`]: max
        })
        expect(vi.mocked(hybridSearchSegments).mock.calls[0][0].filters).toEqual({
          timeMin: min, timeMax: max
        })
      } finally {
        process.env.TZ = 'America/Los_Angeles'
      }
    })
  }

  it('keeps omitted/empty bounds absent and lane/superseded filters intact', async () => {
    await searchMemoriesOp(CONTEXT, {
      query: 'calendar', event_from: '', saved_to: '', lane: 'ltm', include_superseded: false
    })
    expect(vi.mocked(hybridSearchMemories).mock.calls[0][0].filters).toEqual({ lane: 'ltm', superseded: 'n' })
    expect(vi.mocked(hybridSearchSegments).mock.calls[0][0].filters).toEqual({})
  })

  it('keeps event bounds ahead of saved bounds for segment overlap', async () => {
    await searchMemoriesOp(CONTEXT, {
      query: 'calendar', event_from: '2026-11-01', event_to: '2026-11-01',
      saved_from: '2026-10-01', saved_to: '2026-10-01'
    })
    expect(vi.mocked(hybridSearchSegments).mock.calls[0][0].filters).toEqual({
      timeMin: Date.parse('2026-11-01T07:00:00.000Z'), timeMax: Date.parse('2026-11-02T07:59:59.999Z')
    })
  })

  it('preserves existing malformed timestamp/type refusals before index calls', async () => {
    await expect(searchMemoriesOp(CONTEXT, { query: 'calendar', saved_to: 'not a date' }))
      .rejects.toThrow('"saved_to" is not a valid timestamp')
    await expect(searchMemoriesOp(CONTEXT, { query: 'calendar', event_to: 123 as never }))
      .rejects.toBeInstanceOf(MemoryToolError)
    expect(hybridSearchMemories).not.toHaveBeenCalled()
  })

  it('preserves existing bare-date rollover rather than adding a validation change', async () => {
    await searchMemoriesOp(CONTEXT, { query: 'calendar', event_from: '2026-02-31', event_to: '2026-02-31' })
    expect(vi.mocked(hybridSearchMemories).mock.calls[0][0].filters).toEqual({
      eventTsMin: Date.parse('2026-03-03T08:00:00.000Z'), eventTsMax: Date.parse('2026-03-04T07:59:59.999Z')
    })
  })
})
