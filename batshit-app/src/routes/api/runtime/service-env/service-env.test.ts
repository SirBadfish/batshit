import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiKeyService = {
  retrieve: vi.fn().mockResolvedValue('')
}
const fsMock = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn()
}))
const dynamicPrivateEnv = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>
}))

vi.mock('$lib/services/apiKey.server', () => ({ apiKeyService }))
vi.mock('$env/dynamic/private', () => dynamicPrivateEnv)
vi.mock('fs/promises', () => ({ default: fsMock, ...fsMock }))

describe('/api/runtime/service-env under the Pinokio launcher', () => {
  let routeModule: typeof import('./+server')

  beforeEach(async () => {
    vi.clearAllMocks()
    for (const key of Object.keys(dynamicPrivateEnv.env)) delete dynamicPrivateEnv.env[key]
    fsMock.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    fsMock.writeFile.mockResolvedValue(undefined)
    routeModule = await import('./+server')
  })

  it('never writes the internal token into the install folder', async () => {
    dynamicPrivateEnv.env.BATSHIT_RUNTIME_OWNER = 'pinokio'
    dynamicPrivateEnv.env.BATSHIT_TOKEN = 'test-io-runtime-token-2468'
    dynamicPrivateEnv.env.BATSHIT_ARTIFACT_COMPLETE_URL = 'http://127.0.0.1:5650/api/artifacts/complete'

    const response = await routeModule.POST({
      request: new Request('http://127.0.0.1:5650/api/runtime/service-env', { method: 'POST' }),
      locals: { user: { id: 'josh' } }
    } as any)
    const payload = await response.json()

    expect(payload).toMatchObject({
      success: true,
      status: 'runtime-managed',
      managedByRuntime: true,
      artifactCompleteUrl: 'http://127.0.0.1:5650/api/artifacts/complete',
      detail: 'BATSHIT_TOKEN is managed by Pinokio launcher.'
    })
    expect(fsMock.writeFile).not.toHaveBeenCalled()
  })

  it('still writes batshit-server/server/.env for a source checkout', async () => {
    dynamicPrivateEnv.env.BATSHIT_TOKEN = 'source-runtime-token-1357'

    const response = await routeModule.POST({
      request: new Request('http://localhost:5620/api/runtime/service-env', { method: 'POST' }),
      locals: { user: { id: 'josh' } }
    } as any)

    expect(response.status).toBe(200)
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1)
    expect(String(fsMock.writeFile.mock.calls[0][0])).toMatch(/batshit-server\/server\/\.env$/)
  })
})
