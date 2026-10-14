/**
 * Plan pause: a paused plan's key cannot be added; the server decides from the
 * Dev panel gate and the stored switch, never from the request body.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiKeyService = vi.hoisted(() => ({
  getAllMasked: vi.fn(),
  store: vi.fn(),
  getMasked: vi.fn(),
  delete: vi.fn()
}))
const store = vi.hoisted(() => new Map<string, unknown>())
const testEnv = vi.hoisted(() => ({}) as Record<string, string | undefined>)

vi.mock('$lib/services/apiKey.server', () => ({ apiKeyService }))
vi.mock('$env/dynamic/private', () => ({ env: testEnv }))
vi.mock('$lib/server/services/codexProfileManager', () => ({ syncAgentCodexProfiles: vi.fn() }))
vi.mock('$lib/server/services/claudeProfileManager', () => ({ syncAgentClaudeProfiles: vi.fn() }))
vi.mock('$lib/server/redis', () => ({
  redis: {
    json: { get: vi.fn(async (key: string) => store.get(key) ?? null) },
    del: vi.fn()
  }
}))

const ZAI_SENTENCE =
  'Z.ai Coding Plan is paused: Z.ai does not list Batshit as an allowed tool yet. ' +
  "Z.ai's normal pay-as-you-go connection (Z.ai) works."

function post(body: Record<string, unknown>) {
  return new Request('http://localhost/api/settings/api-keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

function devCopyWithSwitchOn() {
  testEnv.BATSHIT_ENABLE_INTERNAL_DEV_PANEL = '1'
  testEnv.BATSHIT_INTERNAL_DEV_PANEL_SECRET = 'test-se-secret-0123456789abcdef0123456789'
  store.set('batshit:dev:paused_plans', { usePausedPlans: true })
}

describe('/api/settings/api-keys and paused plans', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.clear()
    for (const key of Object.keys(testEnv)) delete testEnv[key]
    apiKeyService.getAllMasked.mockResolvedValue({})
    apiKeyService.getMasked.mockResolvedValue('****1234')
  })

  it('refuses adding a paused plan key with the plain sentence and stores nothing', async () => {
    const { POST } = await import('./+server')
    const response = await POST({
      request: post({ service: 'zai_coding', apiKey: 'zcpause-key-0123456789' }),
      locals: { user: { id: 'user-1' } }
    } as any)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: ZAI_SENTENCE, code: 'paused_plan' })
    expect(apiKeyService.store).not.toHaveBeenCalled()
  })

  it('refuses the add even when the service is padded and cased differently (FIX 3)', async () => {
    const { POST } = await import('./+server')
    const response = await POST({
      request: post({ service: ' ZAI_CODING ', apiKey: 'zcpause-key-0123456789' }),
      locals: { user: { id: 'user-1' } }
    } as any)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: ZAI_SENTENCE, code: 'paused_plan' })
    expect(apiKeyService.store).not.toHaveBeenCalled()
  })

  it('a body field cannot switch the pause off', async () => {
    const { POST } = await import('./+server')
    const response = await POST({
      request: post({ service: 'mimo_token_plan', apiKey: 'zcpause-key-0123456789', usePausedPlans: true }),
      locals: { user: { id: 'user-1' } }
    } as any)
    expect(response.status).toBe(409)
    expect(apiKeyService.store).not.toHaveBeenCalled()
  })

  it('adds a plan that is not paused, and a paused plan on a Dev copy with the switch on', async () => {
    const { POST } = await import('./+server')
    const kimi = await POST({
      request: post({ service: 'kimi_code', apiKey: 'zcpause-key-0123456789' }),
      locals: { user: { id: 'user-1' } }
    } as any)
    expect(kimi.status).toBe(200)
    devCopyWithSwitchOn()
    const zai = await POST({
      request: post({ service: 'zai_coding', apiKey: 'zcpause-key-0123456789' }),
      locals: { user: { id: 'user-1' } }
    } as any)
    expect(zai.status).toBe(200)
    expect(apiKeyService.store).toHaveBeenCalledTimes(2)
  })

  it('GET gives each paused plan row its words: paused by default, on for a Dev copy', async () => {
    const { GET } = await import('./+server')
    const paused = await (
      await GET({ locals: { user: { id: 'user-1' } }, request: new Request('http://localhost') } as any)
    ).json()
    expect(paused.pausedPlans.zai_coding).toEqual({ paused: true, message: ZAI_SENTENCE })
    expect(paused.pausedPlans.kimi_code).toBeUndefined()

    devCopyWithSwitchOn()
    const on = await (
      await GET({ locals: { user: { id: 'user-1' } }, request: new Request('http://localhost') } as any)
    ).json()
    expect(on.pausedPlans.zai_coding).toEqual({
      paused: false,
      message:
        'Z.ai Coding Plan is paused for other copies of Batshit (Z.ai does not list Batshit yet) and on for this Dev copy.'
    })
  })
})
