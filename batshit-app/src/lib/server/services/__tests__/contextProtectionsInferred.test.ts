// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { loadContextProtections } from '../contextTokenPreview'
import { writeInferredUnzips } from '../zipStateInferred'

/**
 * SA-120 P5 — a result Jev Juice opened (`source: 'inferred'`) is Batshit's guess, not a pin.
 * Every other unzip shields its message from Manual Trim, Compact, and a nap; this one must
 * not, or an inferred state would outrank the user's own context controls.
 */

useRedisTestServer()

describe('loadContextProtections', () => {
  it('protects what the user and the agent hold open, and never what Jev Juice opened', async () => {
    const sessionId = `protections-${Date.now()}`
    for (const [zipId, source] of [['zip_user', 'user'], ['zip_agent', 'agent']] as const) {
      await redis.sAdd(`unzipped:${sessionId}`, zipId)
      await redis.set(`unzipped_item:${sessionId}:${zipId}`, { zipId, sessionId, permanent: true, unzippedAt: 1, source })
    }
    await writeInferredUnzips(sessionId, [{ zipId: 'zip_jev', probability: 0.84, durationMessages: 2 }])
    // An id in the set whose record cannot be read keeps protecting, as every unzip always has.
    await redis.sAdd(`unzipped:${sessionId}`, 'zip_no_record')

    const protections = await loadContextProtections(sessionId)
    expect([...protections.protectedUnzippedZipIds].sort()).toEqual(['zip_agent', 'zip_no_record', 'zip_user'])
    expect([...protections.userUnzippedZipIds].sort()).toEqual(['zip_agent', 'zip_no_record', 'zip_user'])
  })
})
