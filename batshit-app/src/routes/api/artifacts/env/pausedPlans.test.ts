/**
 * Plan pause (FIX 1, provider-plan-approval plan, section 3/3a): an artifact
 * cannot be handed a paused plan's key, even when the artifact's own
 * `allowed_env_keys` names it. The server decides from the Dev panel gate and
 * its stored switch, never from the artifact's own metadata or the request.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiKeyService = vi.hoisted(() => ({ retrieve: vi.fn() }))
const redisStore = vi.hoisted(() => new Map<string, unknown>())
const testEnv = vi.hoisted(() => ({}) as Record<string, string | undefined>)

vi.mock('$env/dynamic/private', () => ({ env: testEnv }))
vi.mock('$lib/services/apiKey.server', () => ({ apiKeyService }))
vi.mock('$lib/server/services/artifactRuntimeAuth', () => ({
  isOpaqueArtifactRuntimeRequest: () => false,
  requireArtifactRuntimeClaims: vi.fn(),
  resolveArtifactRuntimeClaims: vi.fn(async () => null)
}))
vi.mock('$lib/server/redis', () => ({
  redis: {
    json: {
      get: vi.fn(async (key: string) => redisStore.get(key) ?? null)
    },
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => undefined)
  }
}))

function post(body: Record<string, unknown>) {
  return new Request('http://localhost/api/artifacts/env', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

function artifact(allowedEnvKeys: string[]) {
  redisStore.set('artifact:zcpause-artifact-1', {
    user_id: 'user-1',
    mode: 'draft',
    metadata: { allowed_env_keys: allowedEnvKeys }
  })
}

function devCopyWithSwitchOn() {
  testEnv.BATSHIT_ENABLE_INTERNAL_DEV_PANEL = '1'
  testEnv.BATSHIT_INTERNAL_DEV_PANEL_SECRET = 'test-se-secret-0123456789abcdef0123456789'
  redisStore.set('batshit:dev:paused_plans', { usePausedPlans: true })
}

describe('POST /api/artifacts/env and paused plans', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redisStore.clear()
    for (const key of Object.keys(testEnv)) delete testEnv[key]
    apiKeyService.retrieve.mockResolvedValue('zcpause-secret-value')
  })

  it('refuses a paused plan key even when the artifact lists it in allowed_env_keys', async () => {
    artifact(['zai_coding'])
    const { POST } = await import('./+server')
    const response = await POST({
      request: post({ artifactId: 'zcpause-artifact-1', keyName: 'zai_coding' }),
      locals: { user: { id: 'user-1' } }
    } as any)
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.error).toMatch(/Z\.ai Coding Plan is paused/)
    expect(apiKeyService.retrieve).not.toHaveBeenCalled()
  })

  it('refuses qwen_token_plan and mimo_token_plan the same way', async () => {
    const { POST } = await import('./+server')
    for (const service of ['qwen_token_plan', 'mimo_token_plan']) {
      artifact([service])
      const response = await POST({
        request: post({ artifactId: 'zcpause-artifact-1', keyName: service }),
        locals: { user: { id: 'user-1' } }
      } as any)
      expect(response.status).toBe(409)
    }
    expect(apiKeyService.retrieve).not.toHaveBeenCalled()
  })

  it('still hands out a key that is not a paused plan', async () => {
    artifact(['kimi_code'])
    const { POST } = await import('./+server')
    const response = await POST({
      request: post({ artifactId: 'zcpause-artifact-1', keyName: 'kimi_code' }),
      locals: { user: { id: 'user-1' } }
    } as any)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ value: 'zcpause-secret-value' })
  })

  it('hands out a paused plan key on a Dev copy with "Use paused plans on this copy" on', async () => {
    artifact(['zai_coding'])
    devCopyWithSwitchOn()
    const { POST } = await import('./+server')
    const response = await POST({
      request: post({ artifactId: 'zcpause-artifact-1', keyName: 'zai_coding' }),
      locals: { user: { id: 'user-1' } }
    } as any)
    expect(response.status).toBe(200)
    expect(apiKeyService.retrieve).toHaveBeenCalledWith('zai_coding', 'user-1')
  })
})
