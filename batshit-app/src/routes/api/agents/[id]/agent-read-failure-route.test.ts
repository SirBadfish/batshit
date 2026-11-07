// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Exercise the actual mixed-storage reader, including its error boundary. The only
// transport substitute is below RedisService.execute; no live Redis is acquired.
vi.mock('$lib/server/redis', async () => vi.importActual('$lib/server/redis'))
// SA-139 R4: Primary profile sync and the managed-config route left with the Claude Code CLI
// Primary lane; the remaining profile owners stay mocked so no owner read reaches them.
const effects = vi.hoisted(() => ({
  claudeRead: vi.fn(async () => '{}'),
  keyRead: vi.fn(async () => null)
}))
vi.mock('$lib/server/services/claudeProfileManager', () => ({
  deleteAgentClaudeConfig: vi.fn(),
  agentClaudeProfileResource: vi.fn(), buildClaudeProfileId: (id: string) => `batshit_agent_${id}`,
  getManagedClaudePaths: () => ({ settingsPath: '/unused-managed/settings.json' }),
  readManagedClaudeHomeFile: effects.claudeRead
}))
vi.mock('$lib/services/apiKey.server', () => ({ apiKeyService: { retrieve: effects.keyRead } }))

import { redis } from '$lib/server/redis'
import { SettingsLifecycleRefusal } from '$lib/server/services/appActions/settings/lifecycle'

const KEY = 'agent:read-probe'
const owner = { id: 'read-probe', user_id: 'reader', agentType: 'api', displayName: 'Saved name' }
let record: unknown
let storageType: string
let present: boolean
let failure: Error | undefined
let failingCommand: string | undefined
const reads: string[] = []
const client = {
  exists: async (key: string) => { touch('EXISTS', key); return present ? 1 : 0 },
  type: async (key: string) => { touch('TYPE', key); return storageType },
  json: { get: async (key: string) => { touch('JSON.GET', key); return record } },
  get: async (key: string) => { touch('GET', key); return JSON.stringify(record) }
}
function touch(command: string, key: string) {
  reads.push(`${command} ${key}`)
  if (key !== KEY) throw new Error(`Unexpected downstream read: ${key}`)
  if (command === failingCommand) throw failure
}

type Route = 'put' | 'chats'
let put: typeof import('./+server').PUT
let chats: typeof import('./chats/+server').GET
let update: ReturnType<typeof vi.spyOn>
let sessions: ReturnType<typeof vi.spyOn>
beforeAll(async () => {
  put = (await import('./+server')).PUT
  chats = (await import('./chats/+server')).GET
})
beforeEach(() => {
  record = { ...owner }; storageType = 'ReJSON-RL'; present = true
  failure = undefined; failingCommand = undefined; reads.length = 0
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(redis, 'execute').mockImplementation(async operation => operation(client as never))
  update = vi.spyOn(redis, 'updateAgent').mockResolvedValue(undefined)
  sessions = vi.spyOn(redis, 'getSessions').mockResolvedValue([])
})
afterEach(() => vi.restoreAllMocks())

async function call(route: Route, user: string | null = 'reader', body: Record<string, unknown> = { displayName: 'New name' }) {
  const event = { params: { id: 'read-probe' }, locals: user ? { user: { id: user } } : {},
    request: new Request('http://127.0.0.1/api/agents/read-probe', { method: 'PUT', body: JSON.stringify(body) }),
    url: new URL('http://127.0.0.1/api/agents/read-probe') }
  const response = await (route === 'put' ? put : chats)(event as never)
  return { status: response.status, body: await response.json() }
}
function expectNoDownstream() {
  for (const effect of [...Object.values(effects), update, sessions]) expect(effect).not.toHaveBeenCalled()
  expect(reads.every(read => read.endsWith(KEY))).toBe(true)
}

describe('BL-1519 strict initial agent owner reads', () => {
  for (const route of ['put', 'chats'] as const) {
    it.each(['EXISTS', 'TYPE', 'JSON.GET', 'GET'])(`${route}: a failed %s is500 with no downstream action`, async command => {
      storageType = command === 'GET' ? 'string' : 'ReJSON-RL'
      failingCommand = command; failure = new Error('storage unavailable')
      expect((await call(route, 'reader', { displayName: 'Must not save', goon_id: 'must-not-read' })).status).toBe(500)
      expectNoDownstream()
    })
    it(`${route}: only actual absence is404; foreign owner is403; signed-out is401`, async () => {
      present = false
      expect(await call(route)).toMatchObject({ status: 404, body: { error: 'Agent not found' } })
      expectNoDownstream()
      present = true; record = { ...owner, user_id: 'someone-else' }
      expect((await call(route)).status).toBe(403)
      expectNoDownstream()
      reads.length = 0
      expect((await call(route, null)).status).toBe(401)
      expect(reads).toEqual([]); expectNoDownstream()
    })
    it.each(['ReJSON-RL', 'json', 'JSON', 'string'])(`${route}: retains owned %s decoding`, async type => {
      storageType = type
      expect((await call(route)).status).toBe(200)
      if (route === 'put') expect(update).toHaveBeenCalledWith('read-probe', { displayName: 'New name' }, expect.any(Object))
      else expect(sessions).toHaveBeenCalledWith('reader', true)
    })
  }
  it.each(['put', 'chats'] as const)('%s retains the actual lifecycle refusal status and code before any side effect', async route => {
    const refusal = new SettingsLifecycleRefusal('The agent is being replaced.')
    failingCommand = 'JSON.GET'; failure = refusal
    expect(await call(route)).toMatchObject({ status: refusal.status, body: { code: refusal.code, error: refusal.message } })
    expectNoDownstream()
  })
  it.each(['EXISTS', 'TYPE', 'JSON.GET', 'GET'])('the default mixed getter retains its existing %s failure result', async command => {
    storageType = command === 'GET' ? 'string' : 'ReJSON-RL'
    failingCommand = command; failure = new Error('default caller remains unchanged')
    expect(await redis.get(KEY)).toBeNull()
  })
})
