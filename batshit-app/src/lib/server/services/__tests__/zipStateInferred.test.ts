// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  loadRezippedSources,
  loadUntoldInferredRezips,
  markInferredRezipsTold,
  writeInferredRezips,
  writeInferredUnzips
} from '../zipStateInferred'

/**
 * SA-120 P5 — the only writer of `source: 'inferred'` zip state. Same keys and shapes as the
 * `/api/unzipping` routes (so deletion, backup, the compiler, and the badges need nothing
 * new), and explicit beats inferred AT THE WRITE: each write re-reads the state it would
 * replace and steps aside when the user or the agent owns it. Runs on the fake and, under
 * `npm run test:redis`, on real RedisJSON.
 */

useRedisTestServer()

let counter = 0
let SESSION = ''

const unzip = (zipId: string) => ({ zipId, description: `read_file: ${zipId}.ts - 9 lines`, tokens: 120, probability: 0.84, durationMessages: 2 })
const rezip = (zipId: string) => ({ zipId, description: `read_file: ${zipId}.ts - 9 lines`, done: 0.91, again: 0.08 })

async function storeSource(zipId: string, operationKind = 'read_file', metadata: Record<string, any> = {}) {
  await redis.json.set(`zip:${zipId}`, '$', {
    id: zipId, type: 'cool_tool', tokens: 120,
    metadata: { operationKind, toolName: operationKind, sessionId: SESSION, ...metadata },
    content: JSON.stringify({ schemaVersion: 1, type: 'tool', operationKind, rendererFamily: operationKind,
      toolName: operationKind, toolArgs: { filePath: `${zipId}.ts` }, toolResult: { success: true, content: 'file content' } })
  })
}
async function storeSources(...zipIds: string[]) { for (const id of zipIds) await storeSource(id) }
afterEach(() => vi.restoreAllMocks())

async function userUnzip(zipId: string, source: 'user' | 'agent' = 'user') {
  await redis.sAdd(`unzipped:${SESSION}`, zipId)
  await redis.set(`unzipped_item:${SESSION}:${zipId}`, { zipId, sessionId: SESSION, permanent: true, unzippedAt: 1, source })
}
async function handRezip(zipId: string, source: 'user' | 'agent') {
  await redis.sAdd(`rezipped:${SESSION}`, zipId)
  await redis.set(`rezipped_item:${SESSION}:${zipId}`, { zipId, sessionId: SESSION, source, rezippedAt: 1 })
}

beforeEach(() => {
  counter += 1
  SESSION = `zip-inferred-session-${counter}-${Date.now()}`
})

describe('writeInferredUnzips', () => {
  it('never opens or closes a stored skill read through generic Smart Zip', async () => {
    for (const metadata of [{ operationKind: 'skill_read' }, {}]) {
      const zipId = `cool_tool_skill_${Object.keys(metadata).length}x`
      await redis.execute((client: any) => client.json.set(`zip:${zipId}`, '$', {
        id: zipId, type: 'cool_tool', metadata,
        content: JSON.stringify({ schemaVersion: 1, operationKind: 'skill_read', toolName: 'native_skill', toolResult: { skillId: 'custom', action: 'read', content: 'procedure' } })
      }))
      expect(await writeInferredUnzips(SESSION, [unzip(zipId)])).toEqual([])
      expect(await writeInferredRezips(SESSION, [rezip(zipId)])).toEqual([])
    }
    expect(await redis.sMembers(`unzipped:${SESSION}`)).toEqual([])
    expect(await redis.sMembers(`rezipped:${SESSION}`)).toEqual([])
  })
  it('stores a temporary unzip in the routes\' own shape, marked inferred', async () => {
    await storeSources('zip_a')
    expect(await writeInferredUnzips(SESSION, [unzip('zip_a')])).toEqual(['zip_a'])
    expect(await redis.sMembers(`unzipped:${SESSION}`)).toEqual(['zip_a'])
    expect(await redis.get(`unzipped_item:${SESSION}:zip_a`)).toMatchObject({
      zipId: 'zip_a',
      sessionId: SESSION,
      permanent: false,
      duration: 2,
      messageCount: 0,
      description: 'read_file: zip_a.ts - 9 lines',
      tokens: 120,
      source: 'inferred',
      inferredProbability: 0.84
    })
  })

  it('steps aside for anything already unzipped, and never undoes a rezip made by hand', async () => {
    await storeSources('zip_user', 'zip_agent', 'zip_user_zipped', 'zip_agent_zipped')
    await userUnzip('zip_user')
    await userUnzip('zip_agent', 'agent')
    await handRezip('zip_user_zipped', 'user')
    await handRezip('zip_agent_zipped', 'agent')
    const written = await writeInferredUnzips(SESSION, [
      unzip('zip_user'),
      unzip('zip_agent'),
      unzip('zip_user_zipped'),
      unzip('zip_agent_zipped')
    ])
    expect(written).toEqual([])
    // The user's lock is untouched, and the hand-made rezips still stand.
    expect(await redis.get(`unzipped_item:${SESSION}:zip_user`)).toMatchObject({ source: 'user', permanent: true })
    expect((await redis.sMembers(`rezipped:${SESSION}`)).sort()).toEqual(['zip_agent_zipped', 'zip_user_zipped'])
    expect(await redis.get(`unzipped_item:${SESSION}:zip_user_zipped`)).toBeNull()
  })

  it('may reopen what Jev itself zipped, and clears that marker', async () => {
    await storeSources('zip_own')
    expect(await writeInferredRezips(SESSION, [rezip('zip_own')])).toEqual(['zip_own'])
    expect(await writeInferredUnzips(SESSION, [unzip('zip_own')])).toEqual(['zip_own'])
    expect(await redis.sMembers(`rezipped:${SESSION}`)).toEqual([])
    expect(await redis.get(`rezipped_item:${SESSION}:zip_own`)).toBeNull()
    expect(await redis.get(`unzipped_item:${SESSION}:zip_own`)).toMatchObject({ source: 'inferred' })
  })
})

describe('writeInferredRezips', () => {
  it('stores a rezip marker the way zip control does, marked inferred and not yet told', async () => {
    await storeSources('zip_b')
    expect(await writeInferredRezips(SESSION, [rezip('zip_b')])).toEqual(['zip_b'])
    expect(await redis.sMembers(`rezipped:${SESSION}`)).toEqual(['zip_b'])
    expect(await redis.get(`rezipped_item:${SESSION}:zip_b`)).toMatchObject({
      zipId: 'zip_b',
      sessionId: SESSION,
      source: 'inferred',
      reason: 'jev_done_with_it',
      description: 'read_file: zip_b.ts - 9 lines',
      done: 0.91,
      again: 0.08,
      toldAgent: false
    })
  })

  it('never zips what the user or the agent holds open, never replaces a rezip, and closes its own unzip', async () => {
    await storeSources('zip_user', 'zip_agent', 'zip_hand', 'zip_own')
    await userUnzip('zip_user')
    await userUnzip('zip_agent', 'agent')
    await handRezip('zip_hand', 'user')
    await writeInferredUnzips(SESSION, [unzip('zip_own')])
    const written = await writeInferredRezips(SESSION, [rezip('zip_user'), rezip('zip_agent'), rezip('zip_hand'), rezip('zip_own')])
    expect(written).toEqual(['zip_own'])
    expect((await redis.sMembers(`unzipped:${SESSION}`)).sort()).toEqual(['zip_agent', 'zip_user'])
    expect(await redis.get(`unzipped_item:${SESSION}:zip_own`)).toBeNull()
    expect(await redis.get(`rezipped_item:${SESSION}:zip_hand`)).toMatchObject({ source: 'user' })
    expect(await redis.get(`rezipped_item:${SESSION}:zip_own`)).toMatchObject({ source: 'inferred' })
  })
})

describe('telling the agent', () => {
  it('lists only Jev\'s own untold rezips, oldest first, and a told one never comes back', async () => {
    await storeSources('zip_hand', 'zip_first', 'zip_second')
    await handRezip('zip_hand', 'agent')
    await writeInferredRezips(SESSION, [rezip('zip_first')])
    await new Promise((resolve) => setTimeout(resolve, 5))
    await writeInferredRezips(SESSION, [rezip('zip_second')])
    expect((await loadUntoldInferredRezips(SESSION)).map((marker) => marker.zipId)).toEqual(['zip_first', 'zip_second'])

    await markInferredRezipsTold(SESSION, ['zip_first', 'zip_hand', 'zip_missing'])
    expect((await loadUntoldInferredRezips(SESSION)).map((marker) => marker.zipId)).toEqual(['zip_second'])
    // Marking told never rewrites someone else's marker.
    expect(await redis.get(`rezipped_item:${SESSION}:zip_hand`)).toEqual({ zipId: 'zip_hand', sessionId: SESSION, source: 'agent', rezippedAt: 1 })
    expect(await redis.get(`rezipped_item:${SESSION}:zip_first`)).toMatchObject({ source: 'inferred', toldAgent: true, done: 0.91 })
  })
})

describe('telling the agent, by the state id (BL-1515 class)', () => {
  it('marks told what it listed, whether or not the random part is all digits', async () => {
    // Jev's rezips are stored under the state id, `normalizeId(<raw id>)` (BL-476); the untold list
    // names those state ids, and the send marks them told by the same ids, never cut again.
    const raw = ['cool_tool_1790500000000_abcde', 'cool_tool_1790500000000_48213']
    await storeSources(...raw)
    await writeInferredRezips(SESSION, raw.map(rezip))
    const untold = (await loadUntoldInferredRezips(SESSION)).map((marker) => marker.zipId)
    expect(untold.sort()).toEqual(['cool_tool_1790500000000', 'cool_tool_1790500000000_abcde'])

    await markInferredRezipsTold(SESSION, untold)

    expect(await loadUntoldInferredRezips(SESSION)).toEqual([])
    expect(await redis.get(`rezipped_item:${SESSION}:cool_tool_1790500000000`)).toMatchObject({ source: 'inferred', toldAgent: true })
  })
})

describe('loadRezippedSources', () => {
  it('reads whose rezip each marker is; an unreadable one is the user\'s, the strongest', async () => {
    await storeSources('zip_i')
    await handRezip('zip_u', 'user')
    await handRezip('zip_a', 'agent')
    await writeInferredRezips(SESSION, [rezip('zip_i')])
    await redis.sAdd(`rezipped:${SESSION}`, 'zip_legacy')
    expect(await loadRezippedSources(SESSION, ['zip_u', 'zip_a', 'zip_i', 'zip_legacy'])).toEqual({
      zip_u: 'user',
      zip_a: 'agent',
      zip_i: 'inferred',
      zip_legacy: 'user'
    })
  })
})

describe.each(['open', 'close'] as const)('positive stored-source admission before inferred %s (BL-2265)', (direction) => {
  const write = (ids: string[], onSkipped = vi.fn()) => direction === 'open'
    ? writeInferredUnzips(SESSION, ids.map(unzip), { onSkipped })
    : writeInferredRezips(SESSION, ids.map(rezip), { onSkipped })

  it('changes a known non-skill result but skips missing, malformed and unknown sources individually with receipts', async () => {
    await storeSource('known_file')
    await redis.json.set('zip:malformed_source', '$', { type: 'cool_tool', metadata: { operationKind: 'unknown_tool' }, content: '{broken' })
    await redis.json.set('zip:unknown_source', '$', { type: 'cool_tool', metadata: {}, content: JSON.stringify({ example: 'unclassified data' }) })
    const onSkipped = vi.fn()
    expect(await write(['missing_source', 'malformed_source', 'unknown_source', 'known_file'], onSkipped)).toEqual(['known_file'])
    expect(onSkipped.mock.calls.map(([skip]) => skip)).toEqual([
      { zipId: 'missing_source', reason: 'unknown_source' },
      { zipId: 'malformed_source', reason: 'unknown_source' },
      { zipId: 'unknown_source', reason: 'unknown_source' }
    ])
    for (const id of ['missing_source', 'malformed_source', 'unknown_source']) {
      expect(await redis.get(`unzipped_item:${SESSION}:${id}`)).toBeNull()
      expect(await redis.get(`rezipped_item:${SESSION}:${id}`)).toBeNull()
    }
  })

  it('does not turn a Redis source-read failure into permission and still applies another good candidate', async () => {
    await storeSources('read_error_source', 'known_file')
    // The first source in this ordered batch fails; later reads keep the existing real/fake
    // implementation. Wrapping a vi.fn with another implementation would recursively call itself.
    vi.spyOn(redis.json, 'get').mockRejectedValueOnce(new Error('injected source read failure'))
    const onSkipped = vi.fn()
    expect(await write(['read_error_source', 'known_file'], onSkipped)).toEqual(['known_file'])
    expect(onSkipped).toHaveBeenCalledExactlyOnceWith({ zipId: 'read_error_source', reason: 'source_unavailable' })
    expect(await redis.get(`unzipped_item:${SESSION}:read_error_source`)).toBeNull()
    expect(await redis.get(`rezipped_item:${SESSION}:read_error_source`)).toBeNull()
  })

  it.each(['invoke', 'read'] as const)('never mutates canonical legacy native_skill %s, even under unknown_tool metadata', async (action) => {
    const zipId = `legacy_skill_${action}`
    await redis.json.set(`zip:${zipId}`, '$', {
      id: zipId, type: 'cool_tool', metadata: { operationKind: 'unknown_tool' },
      content: JSON.stringify({ schemaVersion: 1, type: 'tool', toolName: 'native_skill',
        toolArgs: { action, skillId: 'example', path: 'SKILL.md' },
        toolResult: { success: true, action, skillId: 'example', path: 'SKILL.md', content: '# Procedure' } })
    })
    const onSkipped = vi.fn()
    expect(await write([zipId], onSkipped)).toEqual([])
    expect(onSkipped).toHaveBeenCalledExactlyOnceWith({ zipId, reason: 'skill_lifecycle' })
    expect(await redis.sMembers(`unzipped:${SESSION}`)).toEqual([])
    expect(await redis.sMembers(`rezipped:${SESSION}`)).toEqual([])
  })
})
