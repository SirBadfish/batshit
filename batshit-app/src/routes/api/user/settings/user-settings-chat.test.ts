import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { POST } from './+server'

/**
 * SA-114 P3 (DL-114-01, LS-047) — `global_chat_settings` survives a save.
 *
 * The settings route merges every key by hand: a block that is not named in that list is
 * silently dropped, and the panel would then look like it saved while the send button kept
 * the old mode forever.
 *
 * The "unrelated save" case is carried by the ARGUMENT the route hands the store, and that
 * is deliberate: the round trip does NOT catch a dropped carry-forward on either lane
 * (measured 2026-09-11 by mutating the route to pass `undefined` — the round trip stayed
 * green on both). The fake merges shallowly and `JSON.stringify` eats `undefined` on the
 * way in; the real lane has a settings cache between the write and the read. So the round
 * trip here is a smoke check, and the argument assertion is the one with teeth.
 *
 * The spy only lands on the fake lane, where `RedisService` and the `redis` singleton are
 * the same object; on the real lane the route constructs its own instance and the spy sees
 * nothing, so the argument assertions are guarded rather than skipped wholesale.
 */

useRedisTestServer()

const USER = 'user-chat-settings'

function post(body: Record<string, unknown>) {
  return POST({
    request: new Request('http://localhost/api/user/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }),
    locals: { user: { id: USER, email: 'j@example.com' } }
  } as any)
}

let updateSpy: ReturnType<typeof vi.spyOn>

function lastUpdateArgument(): Record<string, any> {
  const calls = updateSpy.mock.calls
  if (calls.length === 0) throw new Error('The route never called updateUserSettings')
  return calls[calls.length - 1][1] as Record<string, any>
}

describe('global_chat_settings', () => {
  beforeEach(() => {
    updateSpy = vi.spyOn(redis, 'updateUserSettings')
  })

  afterEach(() => {
    updateSpy.mockRestore()
  })

  it('stores the busy-send mode and reads it back', async () => {
    const response = await post({ global_chat_settings: { busy_send_mode: 'interrupt' } })
    expect(response.status).toBe(200)

    const payload = await response.json()
    expect(payload.settings.global_chat_settings).toEqual({ busy_send_mode: 'interrupt' })

    const stored = await redis.getUserSettings(USER)
    expect((stored as any)?.global_chat_settings).toEqual({ busy_send_mode: 'interrupt' })
  })

  it('carries a stored mode forward when an unrelated save comes through', async () => {
    await post({ global_chat_settings: { busy_send_mode: 'interrupt' } })
    await post({ upload_provider: 'local' })

    const stored = await redis.getUserSettings(USER)
    expect((stored as any)?.global_chat_settings).toEqual({ busy_send_mode: 'interrupt' })
    if (updateSpy.mock.calls.length > 0) {
      expect(lastUpdateArgument().global_chat_settings).toEqual({ busy_send_mode: 'interrupt' })
    }
  })

  it('refuses to store anything but the two modes', async () => {
    const response = await post({ global_chat_settings: { busy_send_mode: 'queue' } })
    const payload = await response.json()
    expect(payload.settings.global_chat_settings).toEqual({ busy_send_mode: 'steer' })
    if (updateSpy.mock.calls.length > 0) {
      expect(lastUpdateArgument().global_chat_settings).toEqual({ busy_send_mode: 'steer' })
    }
  })
})
