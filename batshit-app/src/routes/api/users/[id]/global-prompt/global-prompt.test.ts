import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { failRedisJsonGets, stopFailingRedisJsonGets } from '$lib/test-utils/failRedisJsonGets'
import { GET, PUT } from './+server'

/**
 * BL-978(d): a failed read is not a successful empty global prompt.
 * Actual handlers and strict settings getter/facade, on the existing default Redis twin.
 * This proves HTTP error/empty distinction and unchanged API boundaries, not real Redis.
 */
useRedisTestServer()

const USER = 'global-prompt-user'
const KEY = `user:${USER}:settings`
const SAVED = {
  id: `settings_${USER}`,
  user_id: USER,
  displayName: 'Saved name',
  global_custom_system_prompt: '  Saved instructions.\nKeep the literal wording — and spacing.  ',
  global_chat_settings: { busy_send_mode: 'queue' }
}

let service: InstanceType<typeof import('$lib/server/redis').RedisService>

beforeAll(async () => {
  const { RedisService } = await vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis')
  service = new RedisService()
}, 60_000)

beforeEach(() => {
  vi.clearAllMocks()
  // The default fake getter reads its Map directly. Run the actual lazy service through
  // the existing fake client so failRedisJsonGets reaches the production read, with no socket.
  vi.spyOn(service, 'execute').mockImplementation(operation => redis.execute(operation))
  vi.spyOn(redis, 'getUserSettings').mockImplementation(userId => service.getUserSettings(userId))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  stopFailingRedisJsonGets()
  vi.restoreAllMocks()
})

function get(userId: string | null = USER, target = USER) {
  return GET({ params: { id: target }, locals: userId ? { user: { id: userId } } : {} } as any)
}

function put(prompt: string, userId: string | null = USER, target = USER) {
  const request = new Request(`http://localhost/api/users/${target}/global-prompt`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt })
  })
  const readBody = vi.spyOn(request, 'json')
  return {
    readBody,
    response: PUT({ params: { id: target }, locals: userId ? { user: { id: userId } } : {}, request } as any)
  }
}

describe('global prompt GET', () => {
  it('BL-978(d): returns a stable 500 after a storage read fails, without claiming an empty prompt or changing it', async () => {
    await redis.json.set(KEY, '$', SAVED)
    const failure = failRedisJsonGets(key => key === KEY, new Error('private Redis endpoint detail'))

    const response = await get()
    expect(failure.failures).toBe(1)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to get global prompt' })
    expect(console.error).toHaveBeenCalledWith('Error getting global prompt:', expect.any(Error))

    failure.stop()
    expect(await redis.json.get(KEY)).toEqual(SAVED)
    const recovered = await get()
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toEqual({ prompt: SAVED.global_custom_system_prompt })
    expect(await redis.json.get(KEY)).toEqual(SAVED)
  })

  it('returns a successful empty prompt for a genuinely missing record without creating one', async () => {
    const response = await get()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ prompt: '' })
    expect(await redis.json.get(KEY)).toBeNull()
  })

  it.each([
    ['missing prompt', { displayName: SAVED.displayName }],
    ['explicit empty prompt', { ...SAVED, global_custom_system_prompt: '' }],
    ['literal saved prompt', SAVED]
  ])('keeps successful %s semantics and leaves the record unchanged', async (_label, record) => {
    await redis.json.set(KEY, '$', record)
    const response = await get()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ prompt: 'global_custom_system_prompt' in record ? record.global_custom_system_prompt : '' })
    expect(await redis.json.get(KEY)).toEqual(record)
  })

  it.each([
    ['unauthenticated', null, USER, 401, 'Unauthorized'],
    ['foreign user', USER, 'another-user', 403, 'Forbidden']
  ])('refuses %s requests before reading storage', async (_label, userId, target, status, error) => {
    await redis.json.set(KEY, '$', SAVED)
    const failure = failRedisJsonGets(() => true)
    const response = await get(userId, target)
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error })
    expect(redis.getUserSettings).not.toHaveBeenCalled()
    expect(failure.failures).toBe(0)
    failure.stop()
    expect(await redis.json.get(KEY)).toEqual(SAVED)
  })
})

describe('unchanged global prompt PUT boundary', () => {
  it.each([
    ['unauthenticated', null, USER, 401, 'Unauthorized'],
    ['foreign user', USER, 'another-user', 403, 'Forbidden']
  ])('refuses %s requests before body/storage access', async (_label, userId, target, status, error) => {
    await redis.json.set(KEY, '$', SAVED)
    const failure = failRedisJsonGets(() => true)
    const { response, readBody } = put('Unadmitted replacement', userId, target)
    const result = await response
    expect(result.status).toBe(status)
    expect(await result.json()).toEqual({ error })
    expect(readBody).not.toHaveBeenCalled()
    expect(redis.getUserSettings).not.toHaveBeenCalled()
    expect(failure.failures).toBe(0)
    failure.stop()
    expect(await redis.json.get(KEY)).toEqual(SAVED)
  })

  it.each(['  Deliberate replacement.\nKeep this text exactly.  ', ''])('persists deliberate text/clear while preserving other saved settings', async prompt => {
    await redis.json.set(KEY, '$', SAVED)
    const response = await put(prompt).response
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
    expect(await redis.json.get(KEY)).toEqual({ ...SAVED, global_custom_system_prompt: prompt })
    const reloaded = await get()
    expect(await reloaded.json()).toEqual({ prompt })
  })

  it('keeps an unsuccessful PUT as 500 and preserves saved text', async () => {
    await redis.json.set(KEY, '$', SAVED)
    const failure = failRedisJsonGets(key => key === KEY)
    const response = await put('Replacement that cannot read its saved base').response
    expect(failure.failures).toBe(1)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to update global prompt' })
    failure.stop()
    expect(await redis.json.get(KEY)).toEqual(SAVED)
  })
})
