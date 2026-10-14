// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { unclosedReferenceReplies } from '$lib/test-utils/unclosedReferenceReplies'
import {
  CONCRETE_ZIP_ID,
  REFERENCE_SCAN_HAND_CASES,
  generateReferenceScanTexts
} from '$lib/test-utils/referenceScanTexts'

/**
 * BL-707: deleting a chat (`redis.deleteSession`) also deletes every zip its messages reference,
 * read from each stored message's words with `/\{\{batshit-zip:([^:}\s]+)(?::::[^}]+)?\}\}/g`.
 * That pattern's description part searched to the first `}` again from every opener: seconds of
 * the one Node process per message of openers that never close, inside the delete. It is one
 * scan now, with the same rules (no whitespace in the id, a description of at least one
 * character). The real facade drives the sweep with its client stubbed (the claim is CPU, not
 * Redis), and the sweeps it imports are stubbed so nothing touches a Redis.
 */

vi.mock('$lib/server/services/controlApprovals', () => ({ sweepSessionApprovals: vi.fn(async () => undefined) }))
vi.mock('$lib/server/services/postTurnCheckState', () => ({ sweepPostTurnRecords: vi.fn(async () => undefined) }))
vi.mock('$lib/server/services/codexCleanupWarnings', () => ({
  sweepCodexCleanupWarnings: vi.fn(async () => undefined)
}))

/** The sweep's two patterns as they were, kept here only as oracles. */
function oldSweptZipIds(content: string): string[] {
  const ids = new Set<string>()
  let match: RegExpExecArray | null
  const newZipPattern = /\{\{batshit-zip:([^:}\s]+)(?::::[^}]+)?\}\}/g
  while ((match = newZipPattern.exec(content || '')) !== null) ids.add(match[1])
  const oldZipPattern = /\{\{batshit\|id:([^|]+)\|/g
  while ((match = oldZipPattern.exec(content || '')) !== null) ids.add(match[1])
  return Array.from(ids).sort()
}

/** Deletes a chat holding one message with `content`; answers the zip ids it deleted and the time. */
async function deleteChatWithMessage(content: string) {
  const { RedisService } = await vi.importActual<typeof import('$lib/server/redis')>(
    '$lib/server/redis'
  )
  const service = new RedisService()
  const deletedZipIds: string[] = []
  const client = {
    json: {
      get: vi.fn(async (key: string) => {
        if (key === 'session:session-1') return { id: 'session-1', user_id: 'user-1' }
        if (key === 'message:session-1:m1') return { id: 'm1', role: 'assistant', content }
        return null
      })
    },
    lRange: vi.fn(async (key: string) => (key === 'messages:session-1' ? ['m1'] : [])),
    sMembers: vi.fn(async () => []),
    keys: vi.fn(async () => []),
    del: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (key.startsWith('zip:')) deletedZipIds.push(key.slice('zip:'.length))
      }
      return 1
    }),
    sRem: vi.fn(async () => 0)
  }
  vi.spyOn(service, 'execute').mockImplementation(async (operation: any) => operation(client))
  vi.spyOn(service as any, 'updateSession').mockResolvedValue(undefined)
  const started = performance.now()
  await service.deleteSession('session-1')
  const ms = performance.now() - started
  expect(client.del).toHaveBeenCalledWith('session:session-1')
  return { deletedZipIds: Array.from(new Set(deletedZipIds)).sort(), ms }
}

describe('deleting a chat reads its messages once (BL-707)', () => {
  it('deletes exactly the zips the old patterns read', async () => {
    const texts = [
      ...REFERENCE_SCAN_HAND_CASES,
      ...generateReferenceScanTexts(1_500, 4_707),
      `{{batshit-zip:${CONCRETE_ZIP_ID}:::x}} {{batshit|id:zip_old|name}}`
    ]
    let swept = 0
    for (const text of texts) {
      const expected = oldSweptZipIds(text)
      const { deletedZipIds } = await deleteChatWithMessage(text)
      expect(deletedZipIds, JSON.stringify(text)).toEqual(expected)
      if (expected.length > 0) swept++
    }
    expect(swept).toBeGreaterThan(300)
  }, 60_000)

  it('deletes a chat whose message holds 20,000 unclosed openers in 1 MB in well under 200 ms', async () => {
    for (const [shape, content] of Object.entries(unclosedReferenceReplies('zip'))) {
      const { deletedZipIds, ms } = await deleteChatWithMessage(content)
      expect(ms, shape).toBeLessThan(200)
      expect(deletedZipIds, shape).toEqual([])
    }
  })
})
