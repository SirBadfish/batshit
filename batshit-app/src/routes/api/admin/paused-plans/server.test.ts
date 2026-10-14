/** Plan pause, section 3a: the Dev switch route exists only on a Dev copy. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => new Map<string, unknown>())
const testEnv = vi.hoisted(() => ({}) as Record<string, string | undefined>)

vi.mock('$env/dynamic/private', () => ({ env: testEnv }))
vi.mock('$lib/server/redis', () => ({
  redis: {
    json: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, _path: string, value: unknown) => {
        store.set(key, value)
      })
    },
    del: vi.fn(async (key: string) => {
      store.delete(key)
    })
  }
}))

const locals = { user: { id: 'user-1' } } as any
const put = (body: unknown) =>
  new Request('http://localhost/api/admin/paused-plans', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })

describe('/api/admin/paused-plans', () => {
  beforeEach(() => {
    store.clear()
    for (const key of Object.keys(testEnv)) delete testEnv[key]
  })

  it('is not found on a copy without the Dev panel, and writes nothing', async () => {
    const { GET, PUT } = await import('./+server')
    expect((await GET({ locals } as any)).status).toBe(404)
    expect((await PUT({ locals, request: put({ usePausedPlans: true }) } as any)).status).toBe(404)
    expect(store.size).toBe(0)
  })

  it('on a Dev copy: off by default, switched on and off by the signed-in user', async () => {
    testEnv.BATSHIT_ENABLE_INTERNAL_DEV_PANEL = '1'
    testEnv.BATSHIT_INTERNAL_DEV_PANEL_SECRET = 'test-se-secret-0123456789abcdef0123456789'
    const { GET, PUT } = await import('./+server')
    expect(await (await GET({ locals } as any)).json()).toEqual({ usePausedPlans: false })
    expect((await PUT({ locals: {}, request: put({ usePausedPlans: true }) } as any)).status).toBe(401)
    expect((await PUT({ locals, request: put({ usePausedPlans: 'yes' }) } as any)).status).toBe(400)
    expect(await (await PUT({ locals, request: put({ usePausedPlans: true }) } as any)).json()).toEqual({
      usePausedPlans: true
    })
    expect(await (await PUT({ locals, request: put({ usePausedPlans: false }) } as any)).json()).toEqual({
      usePausedPlans: false
    })
    expect(store.size).toBe(0)
  })
})
