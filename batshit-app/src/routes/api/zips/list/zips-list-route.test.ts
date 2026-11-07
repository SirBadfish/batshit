import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { normalizeId } from '$lib/utils/idNormalizer'
import { GET } from './+server'

/**
 * BL-1515: the Zip Manager's list reads the chat's hold state, which is keyed on the state id,
 * `normalizeId(<raw id>)` (BL-476), while each zip record carries its raw id. `normalizeId` cuts an
 * all-digit tail, so only the raw side is normalized, once: a held zip whose random part is all
 * digits (about 1 in 600) must still read as held, with its hold record.
 */

useRedisTestServer()

// The default lane's fake Redis has no `getSessionZips`; the real one reads the chat's zip set
// (`redis.ts`), so the fake lane gets exactly that read. The real lane keeps the real method.
const fakeLaneSessionZips = typeof (redis as any).getSessionZips !== 'function'
beforeAll(() => {
  if (fakeLaneSessionZips) {
    ;(redis as any).getSessionZips = async (sessionId: string) => (await redis.sMembers(`session:${sessionId}:zips`)) ?? []
  }
})
afterAll(() => {
  if (fakeLaneSessionZips) delete (redis as any).getSessionZips
})

const USER = 'user-zips-list'

async function ownedSession() {
  const sessionId = `zips-list-${Date.now()}-${Math.round(Math.random() * 1e6)}`
  await redis.createSession({ id: sessionId, user_id: USER, name: 'zip list', agent_id: 'agent-1' } as any)
  return sessionId
}

async function storedZip(sessionId: string, zipId: string) {
  await redis.execute((client: any) =>
    client.json.set(`zip:${zipId}`, '$', {
      id: zipId,
      type: 'cool_tool',
      content: 'small',
      tokens: 2,
      description: 'read_file: notes.md - 1 line',
      createdAt: 1781258400000,
      metadata: { sessionId, messageId: 'm1' }
    })
  )
  await redis.sAdd(`session:${sessionId}:zips`, zipId)
}

async function hold(sessionId: string, rawZipId: string) {
  const stateId = normalizeId(rawZipId)
  await redis.sAdd(`unzipped:${sessionId}`, stateId)
  await redis.set(`unzipped_item:${sessionId}:${stateId}`, {
    zipId: stateId,
    sessionId,
    permanent: true,
    unzippedAt: 1781258400000,
    source: 'user'
  })
}

function event(sessionId: string) {
  return {
    url: new URL(`http://localhost/api/zips/list?sessionId=${sessionId}`),
    locals: { user: { id: USER, email: 'j@example.com' } }
  } as any
}

describe('/api/zips/list hold state (BL-1515)', () => {
  it('reads a held zip as held by its state id, whether or not its random part is all digits', async () => {
    const sessionId = await ownedSession()
    const held = ['cool_tool_1790500000000_abcde', 'cool_tool_1790500000001_48213']
    const free = 'cool_tool_1790500000002_59120'
    expect(held.map((id) => normalizeId(id))).toEqual(['cool_tool_1790500000000_abcde', 'cool_tool_1790500000001'])
    for (const zipId of [...held, free]) await storedZip(sessionId, zipId)
    for (const zipId of held) await hold(sessionId, zipId)

    const response = await GET(event(sessionId))
    expect(response.status).toBe(200)
    const body = await response.json()
    const rows = new Map<string, any>(body.zips.map((row: any) => [row.id, row]))
    expect([...rows.keys()].sort()).toEqual([...held, free].sort())
    for (const zipId of held) {
      expect(rows.get(zipId)?.isUnzipped, zipId).toBe(true)
      expect(rows.get(zipId)?.unzippedItem, zipId).toMatchObject({ zipId: normalizeId(zipId), source: 'user' })
    }
    expect(rows.get(free)?.isUnzipped).toBe(false)
    expect(rows.get(free)?.unzippedItem).toBeNull()
  })
})
