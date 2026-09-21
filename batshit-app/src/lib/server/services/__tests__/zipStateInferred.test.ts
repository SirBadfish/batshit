// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
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
  it('stores a temporary unzip in the routes\' own shape, marked inferred', async () => {
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
    expect(await writeInferredRezips(SESSION, [rezip('zip_own')])).toEqual(['zip_own'])
    expect(await writeInferredUnzips(SESSION, [unzip('zip_own')])).toEqual(['zip_own'])
    expect(await redis.sMembers(`rezipped:${SESSION}`)).toEqual([])
    expect(await redis.get(`rezipped_item:${SESSION}:zip_own`)).toBeNull()
    expect(await redis.get(`unzipped_item:${SESSION}:zip_own`)).toMatchObject({ source: 'inferred' })
  })
})

describe('writeInferredRezips', () => {
  it('stores a rezip marker the way zip control does, marked inferred and not yet told', async () => {
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

describe('loadRezippedSources', () => {
  it('reads whose rezip each marker is; an unreadable one is the user\'s, the strongest', async () => {
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
