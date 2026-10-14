/**
 * BL-1386: the Docker MCP profile env file follows the STORED gateway. PUT and POST write it only
 * after the gateway write is stored, from the profile as stored when the write runs, one write at a
 * time; a refused save writes no file, and a failed file write after the save is a 500 that says
 * the settings were saved. Default lane: the shared fake store and the real service, queue and
 * pre-check; only the file writer itself (`writeDockerMcpProfileEnv`) is a stand-in, so no test
 * touches a real env file. The CLI profile syncs and discovery are stand-ins too.
 *
 * Cases titled "changes:" were red on the base `2665058620` (the file was written before the save).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const profileSync = vi.hoisted(() => ({
  codex: vi.fn(async () => undefined),
  claude: vi.fn(async () => ({}))
}))
/** What the stand-in writer left in "the file", and every profile it was asked to write. */
const profileFile = vi.hoisted(() => ({ content: null as string | null }))
const writer = vi.hoisted(() =>
  vi.fn(async (profile: string) => {
    profileFile.content = profile
  })
)
vi.mock('$lib/server/services/codexProfileManager', () => ({ syncAgentCodexProfiles: profileSync.codex }))
vi.mock('$lib/server/services/claudeProfileManager', () => ({ syncAgentClaudeProfiles: profileSync.claude }))
vi.mock('$lib/server/services/workflowDiscovery', () => ({
  workflowDiscovery: { discoverDirectMCPClients: vi.fn(async () => []) }
}))
vi.mock('$lib/server/services/dockerGatewayProfileConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/dockerGatewayProfileConfig')>()),
  writeDockerMcpProfileEnv: writer
}))

import { env } from '$env/dynamic/private'
import { redis } from '$lib/server/redis'
import { mcpGatewayService } from '$lib/server/services/mcpGatewayService'
import { normalizeDockerMcpProfile, runDockerMcpProfileWrite } from '$lib/server/services/dockerGatewayProfileConfig'
import { POST as createRoute } from './+server'
import { PUT as putRoute } from './[id]/+server'

const USER = 'bl1386_user'
const REGISTRY = `mcp_gateways:${USER}`
const DOCKER_URL = 'http://localhost:8080/mcp'
const FILE_NOT_FINISHED =
  'The Docker MCP Gateway settings were saved, but Batshit could not finish writing the Docker profile file. Change the profile, or another Gateway Setting, to write it again.'

const json = redis.json as unknown as Record<string, any>
const originalSetIfUnchanged = json.setIfUnchanged.getMockImplementation()

function docker(id: string, profile = 'default') {
  return {
    id,
    name: `Docker ${id}`,
    type: 'docker-catalog' as const,
    url: DOCKER_URL,
    enabled: true,
    created_at: '2026-10-11T00:00:00.000Z',
    discoveredTools: ['tool_a'],
    lastDiscovery: 1,
    metadata: { dockerProfile: profile, note: 'kept' }
  }
}

const put = (id: string, body: Record<string, unknown>) =>
  putRoute({
    request: new Request(`http://localhost/api/mcp/gateways/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    locals: { user: { id: USER } },
    params: { id },
    url: new URL(`http://localhost/api/mcp/gateways/${id}`)
  } as any) as Promise<Response>

const post = (body: Record<string, unknown>) =>
  createRoute({
    request: new Request('http://localhost/api/mcp/gateways', { method: 'POST', body: JSON.stringify(body) }),
    locals: { user: { id: USER } }
  } as any) as Promise<Response>

async function storedProfile(id: string) {
  const registry = (await redis.json.get(REGISTRY)) as { gateways: any[] } | null
  return registry?.gateways.find((gateway) => gateway.id === id)?.metadata?.dockerProfile ?? null
}

let errorSpy: ReturnType<typeof vi.spyOn>
let quietSpies: Array<ReturnType<typeof vi.spyOn>> = []

describe.runIf(process.env.VITEST_USE_REAL_REDIS !== 'true')('BL-1386: the Docker profile file follows the stored gateway', () => {
  beforeEach(async () => {
    ;(redis as any).__resetTestStore()
    vi.clearAllMocks()
    json.setIfUnchanged.mockImplementation(originalSetIfUnchanged)
    // The stand-in keeps the real writer's profile id check (its only check after the save).
    writer.mockReset().mockImplementation(async (profile: string) => {
      profileFile.content = normalizeDockerMcpProfile(profile)
    })
    profileFile.content = null
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    quietSpies = (['log', 'info', 'warn', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {})
    )
    await mcpGatewayService.create(USER, docker('gw-d') as any)
  })
  afterEach(() => {
    json.setIfUnchanged.mockImplementation(originalSetIfUnchanged)
    errorSpy.mockRestore()
    for (const spy of quietSpies) spy.mockRestore()
    profileSync.codex.mockReset().mockImplementation(async () => undefined)
    profileSync.claude.mockReset().mockImplementation(async () => ({}))
  })

  // --- a save that is not stored writes no file ---

  it('changes: a refused save (409) writes no profile file', async () => {
    json.setIfUnchanged.mockClear().mockImplementation(async () => false)

    const response = await put('gw-d', { metadata: { dockerProfile: 'work' } })

    expect(response.status).toBe(409)
    // All three refused writes were `update`'s tries at the element, never a normalizing write at `$`.
    expect(json.setIfUnchanged.mock.calls.map((call: any[]) => call[1])).toEqual(Array(3).fill('$.gateways[0]'))
    expect(writer).not.toHaveBeenCalled()
    expect(await storedProfile('gw-d')).toBe('default')
  })

  it('changes: a save of a gateway that is gone (404) writes no profile file', async () => {
    const response = await put('gw-gone', { type: 'docker-catalog', metadata: { dockerProfile: 'work' } })

    expect(response.status).toBe(404)
    expect(writer).not.toHaveBeenCalled()
  })

  it('changes: a save whose gateway fields fail validation (400) writes no profile file', async () => {
    const response = await put('gw-d', { url: 'not a url', metadata: { dockerProfile: 'work' } })

    expect(response.status).toBe(400)
    expect(writer).not.toHaveBeenCalled()
    expect(await storedProfile('gw-d')).toBe('default')
  })

  it('an invalid profile id is refused (400) before anything is written', async () => {
    const before = await redis.json.getRaw(REGISTRY, '$')

    const response = await put('gw-d', { metadata: { dockerProfile: 'bad profile!' } })

    expect(response.status).toBe(400)
    expect(writer).not.toHaveBeenCalled()
    expect(await redis.json.getRaw(REGISTRY, '$')).toBe(before)
  })

  it('changes: a gateway write with no answer (500 before it is confirmed) writes no profile file', async () => {
    json.setIfUnchanged.mockRejectedValueOnce(new Error('socket closed before the answer'))

    const response = await put('gw-d', { metadata: { dockerProfile: 'work' } })

    expect(response.status).toBe(500)
    expect((await response.json()).error).toBe('Failed to update gateway')
    expect(writer).not.toHaveBeenCalled()
    expect(profileSync.codex).not.toHaveBeenCalled()
  })

  it('changes: a containerized save of a profile is refused before any Redis write, with no file', async () => {
    const before = await redis.json.getRaw(REGISTRY, '$')
    const saved = env.BATSHIT_CONTAINERIZED
    env.BATSHIT_CONTAINERIZED = '1'
    try {
      const response = await put('gw-d', { metadata: { dockerProfile: 'work' } })

      expect(response.status).toBe(500)
      expect(writer).not.toHaveBeenCalled()
      expect(await redis.json.getRaw(REGISTRY, '$')).toBe(before)
    } finally {
      if (saved === undefined) delete env.BATSHIT_CONTAINERIZED
      else env.BATSHIT_CONTAINERIZED = saved
    }
  })

  // --- a stored save writes the stored profile ---

  it('changes: the file gets the profile as stored when its write runs, after the gateway write', async () => {
    const update = mcpGatewayService.update.bind(mcpGatewayService)
    const spy = vi.spyOn(mcpGatewayService, 'update').mockImplementationOnce(async (...args: Parameters<typeof update>) => {
      const answer = await update(...args)
      // Another write stores a newer profile right after this save, before its file write runs.
      await update(USER, 'gw-d', (stored) => ({ metadata: { ...stored.metadata, dockerProfile: 'night' } }))
      return answer
    })
    try {
      const response = await put('gw-d', { metadata: { dockerProfile: 'work' } })

      expect(response.status).toBe(200)
      expect(writer.mock.calls).toEqual([['night']])
      expect(profileFile.content).toBe('night')
      expect(await storedProfile('gw-d')).toBe('night')
    } finally {
      spy.mockRestore()
    }
  })

  it('changes: two stored saves write the file one at a time; the last write is the newest stored profile', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    writer.mockImplementationOnce(async (profile: string) => {
      await held
      profileFile.content = profile
    })

    const first = put('gw-d', { metadata: { dockerProfile: 'p1' } })
    await vi.waitFor(() => expect(writer).toHaveBeenCalledTimes(1))
    const second = put('gw-d', { metadata: { dockerProfile: 'p2' } })
    await vi.waitFor(async () => expect(await storedProfile('gw-d')).toBe('p2'))
    release()

    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)
    expect(writer.mock.calls.map(([profile]) => profile)).toEqual(['p1', 'p2'])
    expect(profileFile.content).toBe('p2')
  })

  it('a save that carries no profile writes no file', async () => {
    const response = await put('gw-d', { name: 'Renamed' })

    expect(response.status).toBe(200)
    expect(writer).not.toHaveBeenCalled()
  })

  /** After the stored save, before its file write runs, another write changes the registry. */
  function afterTheSave<T extends 'update' | 'create'>(method: T, change: (registry: { gateways: any[] }) => void) {
    const original = (mcpGatewayService[method] as (...args: any[]) => Promise<any>).bind(mcpGatewayService)
    return vi.spyOn(mcpGatewayService, method as any).mockImplementationOnce(async (...args: any[]) => {
      const answer = await original(...args)
      const registry = (await redis.json.get(REGISTRY)) as { gateways: any[] }
      change(registry)
      await redis.json.set(REGISTRY, '$', registry)
      return answer
    })
  }

  it('a gateway gone or no longer Docker when its file write runs writes no file', async () => {
    const gone = afterTheSave('update', (registry) => {
      registry.gateways = registry.gateways.filter((gateway) => gateway.id !== 'gw-d')
    })
    try {
      const response = await put('gw-d', { metadata: { dockerProfile: 'work' } })

      expect(response.status).toBe(200)
      expect(writer).not.toHaveBeenCalled()
    } finally {
      gone.mockRestore()
    }

    await mcpGatewayService.create(USER, docker('gw-t') as any)
    const retyped = afterTheSave('update', (registry) => {
      const gateway = registry.gateways.find((candidate) => candidate.id === 'gw-t')
      gateway.type = 'custom'
    })
    try {
      const response = await put('gw-t', { metadata: { dockerProfile: 'work' } })

      expect(response.status).toBe(200)
      expect(writer).not.toHaveBeenCalled()
    } finally {
      retyped.mockRestore()
    }

    const removedAfterCreate = afterTheSave('create', (registry) => {
      registry.gateways = registry.gateways.filter((gateway) => gateway.id !== 'gw-h')
    })
    try {
      const response = await post({ id: 'gw-h', name: 'Gone', type: 'docker-catalog', url: DOCKER_URL, metadata: { dockerProfile: 'work' } })

      expect(response.status).toBe(201)
      expect(writer).not.toHaveBeenCalled()
    } finally {
      removedAfterCreate.mockRestore()
    }
  })

  it('a stored profile the writer refuses (restored data) is the 500 that says the file could not be finished', async () => {
    const invalid = afterTheSave('update', (registry) => {
      registry.gateways.find((gateway) => gateway.id === 'gw-d').metadata.dockerProfile = 'bad profile!'
    })
    try {
      const response = await put('gw-d', { metadata: { dockerProfile: 'work' } })

      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: FILE_NOT_FINISHED, gatewaySaved: true, gatewayId: 'gw-d' })
      expect(profileFile.content).toBeNull()
    } finally {
      invalid.mockRestore()
    }
  })

  // --- a file write that fails after the save: a 500 that says so; nothing undone, no retry ---

  it('changes: a file write that fails before writing answers the 500 that says the settings were saved', async () => {
    writer.mockRejectedValueOnce(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))

    const response = await put('gw-d', { metadata: { dockerProfile: 'work' } })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: FILE_NOT_FINISHED, gatewaySaved: true, gatewayId: 'gw-d' })
    expect(writer).toHaveBeenCalledTimes(1)
    expect(profileFile.content).toBeNull()
    expect(await storedProfile('gw-d')).toBe('work')
    expect(profileSync.codex).toHaveBeenCalledTimes(1)
    expect(profileSync.claude).toHaveBeenCalledTimes(1)
    // The cause is kept for diagnosis.
    expect(errorSpy.mock.calls.flat().some((arg: unknown) => arg instanceof Error && (arg as any).code === 'EACCES')).toBe(true)
  })

  it('changes: a file write that wrote and then failed is not undone; the 500 says it could not finish', async () => {
    writer.mockImplementationOnce(async (profile: string) => {
      profileFile.content = profile
      throw new Error('ENOSPC: no space left on device')
    })

    const response = await put('gw-d', { metadata: { dockerProfile: 'work' } })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: FILE_NOT_FINISHED, gatewaySaved: true, gatewayId: 'gw-d' })
    // Never written back to the old profile, never written again by the route.
    expect(writer.mock.calls).toEqual([['work']])
    expect(profileFile.content).toBe('work')
    expect(await storedProfile('gw-d')).toBe('work')
  })

  it('changes: the next save that carries the profile writes the file again, the same profile included', async () => {
    writer.mockRejectedValueOnce(new Error('EACCES: permission denied'))

    const first = await put('gw-d', { metadata: { dockerProfile: 'work' } })

    expect(first.status).toBe(500)
    expect(await storedProfile('gw-d')).toBe('work')
    expect(writer).toHaveBeenCalledTimes(1)

    const unrelated = await put('gw-d', { name: 'Renamed' })

    expect(unrelated.status).toBe(200)
    expect(writer).toHaveBeenCalledTimes(1)

    const again = await put('gw-d', { name: 'Renamed again', metadata: { dockerProfile: 'work' } })

    expect(again.status).toBe(200)
    expect(writer.mock.calls).toEqual([['work'], ['work']])
    expect(profileFile.content).toBe('work')
  })

  it('a failed file write rejects its own caller and does not stop the next one', async () => {
    const failure = new Error('step failed')
    const first = runDockerMcpProfileWrite(async () => {
      throw failure
    })
    const second = runDockerMcpProfileWrite(async () => {
      profileFile.content = 'after'
    })

    await expect(first).rejects.toBe(failure)
    await expect(second).resolves.toBeUndefined()
    expect(profileFile.content).toBe('after')
  })

  // --- POST: the same order around the create ---

  it('changes: POST writes the file only after the gateway is created, from the stored profile', async () => {
    const refused = await post({ id: 'gw-d', name: 'Again', type: 'docker-catalog', url: DOCKER_URL, metadata: { dockerProfile: 'work' } })

    expect(refused.status).toBe(400)
    expect(writer).not.toHaveBeenCalled()

    const created = await post({ id: 'gw-e', name: 'Second', type: 'docker-catalog', url: DOCKER_URL, metadata: { dockerProfile: 'work' } })

    expect(created.status).toBe(201)
    expect(writer.mock.calls).toEqual([['work']])
    expect(await storedProfile('gw-e')).toBe('work')
  })

  it('changes: a POST whose file write fails after the create answers the 500 that says the settings were saved', async () => {
    writer.mockImplementationOnce(async (profile: string) => {
      profileFile.content = profile
      throw new Error('ENOSPC: no space left on device')
    })

    const response = await post({ id: 'gw-f', name: 'Third', type: 'docker-catalog', url: DOCKER_URL, metadata: { dockerProfile: 'work' } })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: FILE_NOT_FINISHED, gatewaySaved: true, gatewayId: 'gw-f' })
    expect(await storedProfile('gw-f')).toBe('work')
    expect(writer).toHaveBeenCalledTimes(1)
  })

  it('a POST with no profile writes no file', async () => {
    const response = await post({ id: 'gw-g', name: 'Plain', type: 'docker-catalog', url: DOCKER_URL })

    expect(response.status).toBe(201)
    expect(writer).not.toHaveBeenCalled()
  })

  // --- BL-1410 / BL-1411: only a confirmed record write says so, with the id it confirmed ---

  it('a refusal or a write with no answer never claims the record was saved', async () => {
    json.setIfUnchanged.mockImplementation(async () => false)
    const conflict = await (await put('gw-d', { metadata: { dockerProfile: 'work' } })).json()
    json.setIfUnchanged.mockImplementation(originalSetIfUnchanged)
    const gone = await (await put('gw-gone', { type: 'docker-catalog', metadata: { dockerProfile: 'work' } })).json()
    const invalid = await (await put('gw-d', { metadata: { dockerProfile: 'bad profile!' } })).json()
    json.setIfUnchanged.mockRejectedValueOnce(new Error('socket closed before the answer'))
    const unknown = await (await put('gw-d', { metadata: { dockerProfile: 'work' } })).json()
    const exists = await (await post({ id: 'gw-d', name: 'Again', type: 'docker-catalog', url: DOCKER_URL })).json()

    for (const body of [conflict, gone, invalid, unknown, exists]) {
      expect(body).not.toHaveProperty('gatewaySaved')
      expect(body).not.toHaveProperty('gatewayId')
    }
  })

  it('changes: a POST that let the server pick the id names the created id on a failure after the create', async () => {
    writer.mockRejectedValueOnce(new Error('EACCES: permission denied'))

    const response = await post({ name: 'Picked', type: 'docker-catalog', url: DOCKER_URL, metadata: { dockerProfile: 'work' } })

    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body).toEqual({ error: FILE_NOT_FINISHED, gatewaySaved: true, gatewayId: expect.any(String) })
    const created = await mcpGatewayService.get(USER, body.gatewayId)
    expect(created?.name).toBe('Picked')
  })

  it('changes: the id a POST names is the one its create answered, never a later read (the gateway is gone by then)', async () => {
    const removed = afterTheSave('create', (registry) => {
      registry.gateways = registry.gateways.filter((gateway) => gateway.id !== 'gw-r')
    })
    profileSync.codex.mockRejectedValueOnce(new Error('sync down'))
    try {
      const response = await post({ id: 'gw-r', name: 'Removed', type: 'docker-catalog', url: DOCKER_URL })

      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({
        error: expect.stringMatching(/^The gateway settings were saved, but /),
        gatewaySaved: true,
        gatewayId: 'gw-r'
      })
      expect(await mcpGatewayService.get(USER, 'gw-r')).toBeNull()
    } finally {
      removed.mockRestore()
    }
  })
})
