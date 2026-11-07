import { describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { normalizeId } from '$lib/utils/idNormalizer'
import { getVisualState } from '$lib/server/visualIndicatorService'

/**
 * BL-1515: `getVisualState` reads a zip's record by its raw id and the chat's hold set by the
 * state id, `normalizeId(<raw id>)` (BL-476). `normalizeId` cuts an all-digit tail, so only the
 * raw side is normalized, once. Real Redis only: the default lane's fake `sIsMember` answers a
 * boolean, the real client (node-redis 5) 1 or 0, and the reader compares with 1.
 */

useRedisTestServer()

describe.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('getVisualState hold reading (BL-1515)', () => {
  it('reads a held zip as unzipped by its state id, whether or not its random part is all digits', async () => {
    const sessionId = `visual-state-${Date.now()}-${Math.round(Math.random() * 1e6)}`
    const held = ['cool_tool_1790500000000_abcde', 'cool_tool_1790500000001_48213']
    const free = 'cool_tool_1790500000002_59120'
    for (const zipId of [...held, free]) {
      await redis.execute((client: any) => client.json.set(`zip:${zipId}`, '$', { id: zipId, metadata: { sessionId } }))
    }
    for (const zipId of held) await redis.sAdd(`unzipped:${sessionId}`, normalizeId(zipId))

    for (const zipId of held) {
      expect(await getVisualState(zipId, sessionId), zipId).toEqual({ isZipped: true, isUnzipped: true })
    }
    expect(await getVisualState(free, sessionId)).toEqual({ isZipped: true, isUnzipped: false })
  })
})
