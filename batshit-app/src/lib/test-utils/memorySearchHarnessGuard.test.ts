import { describe, expect, it } from 'vitest'
import {
  memorySearchTestInstanceRefusal,
  memorySearchTestUrlRefusal
} from '$lib/test-utils/memory-search-server'

/**
 * BL-1824: the memory-search harness runs FLUSHALL, which empties every database of the
 * instance. It accepted a MEMORY_TEST_REDIS_URL naming db 15 and an instance whose only data sat
 * in db 14 or 15 (it checked `user:*` in db 0 alone), so a shared test Redis was flushed whole.
 */
describe('memory-search harness guards before any flush (BL-1824)', () => {
  it('refuses a URL that names a database other than 0, and says why', () => {
    const refusal = memorySearchTestUrlRefusal('redis://127.0.0.1:6431/15')
    expect(refusal).toMatch(/refuses 127\.0\.0\.1:6431\/15/)
    expect(refusal).toMatch(/WHOLE instance/)
    expect(memorySearchTestUrlRefusal('redis://127.0.0.1:6431/1')).not.toBeNull()
  })

  it('accepts db 0 or no database on a port that is not a Batshit lane', () => {
    expect(memorySearchTestUrlRefusal('redis://127.0.0.1:6431/0')).toBeNull()
    expect(memorySearchTestUrlRefusal('redis://127.0.0.1:6431')).toBeNull()
  })

  it("still refuses Batshit's own runtime ports whatever the database", () => {
    // 5659 is Pinokio's Redis, missing from the harness's own copy of the list before BL-1824.
    for (const port of [6379, 5639, 5659, 6380, 5649]) {
      expect(memorySearchTestUrlRefusal(`redis://127.0.0.1:${port}/0`)).toMatch(/real Batshit Redis lane/)
    }
  })

  it('refuses a URL it cannot read', () => {
    expect(memorySearchTestUrlRefusal('not a url')).toMatch(/not a Redis URL/)
  })

  it('refuses an unclaimed instance with keys in ANY database, naming them', () => {
    const keyspace = '# Keyspace\r\ndb14:keys=6,expires=0,avg_ttl=0\r\ndb15:keys=8,expires=2,avg_ttl=10\r\n'
    const refusal = memorySearchTestInstanceRefusal({ claimed: false, keyspace })
    expect(refusal).toMatch(/db14 holds 6 keys, db15 holds 8 keys/)
    expect(memorySearchTestInstanceRefusal({ claimed: false, keyspace: '# Keyspace\r\ndb0:keys=1,expires=0,avg_ttl=0\r\n' })).toMatch(/db0 holds 1 key\./)
  })

  it('accepts an empty unclaimed instance and its own claimed instance', () => {
    expect(memorySearchTestInstanceRefusal({ claimed: false, keyspace: '# Keyspace\r\n' })).toBeNull()
    expect(memorySearchTestInstanceRefusal({ claimed: false, keyspace: 'db0:keys=0,expires=0,avg_ttl=0' })).toBeNull()
    expect(memorySearchTestInstanceRefusal({ claimed: true, keyspace: 'db0:keys=40,expires=0,avg_ttl=0\r\ndb15:keys=3' })).toBeNull()
  })
})
