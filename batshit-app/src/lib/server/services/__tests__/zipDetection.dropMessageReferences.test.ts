// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { ZipDetectionService } from '$lib/server/services/zipDetection'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'

useRedisTestServer()

/**
 * BL-871 (c): `/api/sse` takes the zips one chunk's detection made after the finalize closed the
 * reply out of the detector's list, so no later rebuild of the reply can take them. Only those
 * zips go; every other reference of the message stays, in order, and an empty list is let go.
 */
describe('ZipDetectionService.dropMessageReferences (BL-871 c)', () => {
  const SESSION = 'session-drop-refs'

  beforeEach(async () => {
    await redis.createSession({ id: SESSION, user_id: 'drop-refs-fixture', title: 'Drop refs fixture' } as any)
  })

  async function threeZips(service: ZipDetectionService, messageId: string) {
    for (const text of ['A <error>one</error> ', 'B <error>two</error> ', 'C <error>three</error>']) {
      await service.processChunk(SESSION, messageId, text)
    }
    const references = service.getMessageReferences(SESSION, messageId)
    expect(references).toHaveLength(3)
    return references
  }

  it('drops only the named zips, keeps the rest in order, and answers what it removed', async () => {
    const service = new ZipDetectionService()
    const [first, second, third] = await threeZips(service, 'm-drop')

    const removed = service.dropMessageReferences(SESSION, 'm-drop', [second.zipId!, 'error_not_in_the_list'])
    expect(removed).toEqual([second])
    expect(service.getMessageReferences(SESSION, 'm-drop')).toEqual([first, third])
  })

  it('lets go of the list once it is empty, and changes nothing for an unknown message or no ids', async () => {
    const service = new ZipDetectionService()
    const references = await threeZips(service, 'm-all')

    expect(service.dropMessageReferences(SESSION, 'm-all', [])).toEqual([])
    expect(service.dropMessageReferences(SESSION, 'm-unknown', [references[0].zipId!])).toEqual([])
    expect(service.getMessageReferences(SESSION, 'm-all')).toHaveLength(3)

    expect(service.dropMessageReferences(SESSION, 'm-all', references.map((ref) => ref.zipId!))).toEqual(references)
    expect(service.getMessageReferences(SESSION, 'm-all')).toEqual([])
    expect((service as any).messageZipReferences.has(`${SESSION}:m-all`)).toBe(false)
  })
})
