/**
 * DL-5 parity harness for the buildFormattedChatInput twins (Gauntlet G-0001).
 *
 * Runs IDENTICAL scenarios through both implementations and diffs the output:
 *   - server twin: databaseRedis.server.ts (API/CLI path, direct Redis)
 *   - client twin: databaseRedis.client.ts (n8n path, HTTP fetch)
 *
 * Feeding identical state:
 *   - One fixture store backs a vi.mock of $lib/server/redis. The server twin reads it
 *     directly. The client twin's fetch router serves the REAL SvelteKit route handlers
 *     (/api/redis/get, /api/users/.../settings, /api/projects, /api/zips, /api/unzipping,
 *     /api/session-clips/state, /api/clips, /api/slash-commands/agent-capabilities,
 *     /api/skills/session-context, /api/controls/find, /api/mcp/tools/dcm) — which import
 *     the same mocked redis. Any twin divergence the harness finds is real drift, not
 *     fixture skew, because both lanes consume one seeded state through production code.
 *
 * KNOWN DRIFTS — ALL FIXED in the Wave 2 twins cluster (2026-06-12) and flipped to
 * equality scenarios per the original harness contract:
 *   - G-0026  (S7/S7b)  both lanes teach the broker fabric:sys.zip.fetch contract, and
 *             the trailing native_tools_fetch_zip line is conditional in both.
 *   - G-0027  (S8)      the default sandbox backend is a single server fact
 *             (resolveDefaultNativeExecutionBackend) delivered to the client lane on the
 *             settings envelope's runtime_defaults rider — never guessed in the browser.
 *   - G-0063  (S5)      both lanes resolve clip URLs late via resolveClipPreferredUrl —
 *             the client lane through /api/clips/[id]?resolve_model_url=1.
 *   - G-0148  (S6)      userStore.getProjects unwraps the {projects} wrapper; agent
 *             default projects resolve identically in both lanes.
 *   - G-0031 / G-0152a  (S9)  settings-source failure now REJECTS the compile loudly in
 *             both lanes (USER_SETTINGS_UNAVAILABLE) instead of fabricating defaults;
 *             the 60s error caches are gone.
 *   - G-0032  (S4b)     the base64 decoder is one identical implementation in both twins
 *             (globalThis.Buffer fallback, loud CLIP_DECODE_FAILED instead of '').
 *   - Structural (intentional per context-pipeline.md): server-only managed-subagent
 *     dynamic info appendix; server-side compaction (n8n pre-compacts upstream);
 *     send-routed addenda are OUTSIDE both twins and out of scope.
 *
 * Platform note: equality scenarios still pin process.platform to 'darwin' for
 * determinism, but the sandbox default now flows through the shared helper in BOTH
 * lanes, so parity holds on any platform.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type FixtureState = {
  kv: Map<string, any>
  sets: Map<string, Set<string>>
  /** SA-104 P6: redis LIST fixtures (the episode ledger uses lRange). */
  lists: Map<string, string[]>
  session: any
  userSettings: any
  projects: any[]
  zips: Map<string, any>
  failUserSettings: boolean
  failSettingsRoute: boolean
}

const state = vi.hoisted(() => ({
  current: null as unknown as FixtureState
}))

const redisFake = vi.hoisted(() => {
  // SA-104 P4: the recall engine lists memory records via the KEYS house pattern, so
  // the fake serves glob patterns from the fixture map instead of always-empty.
  const keysMatching = (pattern: string) => {
    const regex = new RegExp(
      `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`
    )
    return Array.from(state.current.kv.keys()).filter((key) => regex.test(key))
  }

  // Raw node-redis-style client used by execute()/getClient() consumers
  // (fabricRegistry, mcpSelectionResolver, artifactsService, goon reads).
  const makeRawClient = () => ({
    json: {
      get: async (key: string) =>
        state.current.kv.has(key) ? state.current.kv.get(key) : null,
      set: async (key: string, path: string, value: any) => {
        // Root writes replace the record; the recall engine's last-interaction stamp
        // uses field-level paths on the agent record.
        if (path === '$') {
          state.current.kv.set(key, value)
        } else if (path.startsWith('$.')) {
          const existing = state.current.kv.get(key)
          if (existing && typeof existing === 'object') {
            existing[path.slice(2)] = value
          }
        }
        return 'OK'
      }
    },
    get: async (key: string) =>
      state.current.kv.has(key) ? state.current.kv.get(key) : null,
    set: async (key: string, value: any) => {
      state.current.kv.set(key, value)
      return 'OK'
    },
    del: async () => 1,
    keys: async (pattern: string) => keysMatching(pattern),
    sMembers: async (key: string) => Array.from(state.current.sets.get(key) ?? []),
    lRange: async (key: string, start: number, stop: number) => {
      const list = state.current.lists.get(key) ?? []
      return list.slice(start, stop === -1 ? undefined : stop + 1)
    },
    sendCommand: async () => null
  })
  const base = {
    json: {
      get: async (key: string) =>
        state.current.kv.has(key) ? state.current.kv.get(key) : null,
      set: async (key: string, path: string, value: any) => {
        if (path === '$') {
          state.current.kv.set(key, value)
        } else if (path.startsWith('$.')) {
          const existing = state.current.kv.get(key)
          if (existing && typeof existing === 'object') {
            ;(existing as Record<string, any>)[path.slice(2)] = value
          }
        }
        return 'OK'
      }
    },
    async get(key: string) {
      return state.current.kv.has(key) ? state.current.kv.get(key) : null
    },
    async set(key: string, value: any) {
      state.current.kv.set(key, value)
      return 'OK'
    },
    async del(key: string) {
      state.current.kv.delete(key)
      return 1
    },
    async keys(pattern: string) {
      return keysMatching(pattern)
    },
    async sMembers(key: string) {
      return Array.from(state.current.sets.get(key) ?? [])
    },
    async sAdd(key: string, member: string) {
      const set = state.current.sets.get(key) ?? new Set<string>()
      set.add(member)
      state.current.sets.set(key, set)
      return 1
    },
    async getSession(sessionId: string) {
      const session = state.current.session
      return session && session.id === sessionId ? session : null
    },
    async getUserSettings(userId: string) {
      if (state.current.failUserSettings) {
        throw new Error('parity-harness: injected user settings failure')
      }
      return userId === state.current.userSettings?.id ? state.current.userSettings : null
    },
    async getProjects() {
      return state.current.projects
    },
    async getZip(zipId: string) {
      return state.current.zips.get(zipId) ?? null
    },
    async getZips(zipIds: string[]) {
      const result = new Map<string, any>()
      for (const id of zipIds) {
        const zip = state.current.zips.get(id)
        if (zip) result.set(id, zip)
      }
      return result
    },
    async getAgents() {
      return []
    },
    async getSubagents() {
      return []
    },
    async getMessages() {
      return []
    },
    async hGetAll() {
      return {}
    },
    async hGet() {
      return null
    },
    async lRange(key: string, start: number, stop: number) {
      const list = state.current.lists.get(key) ?? []
      return list.slice(start, stop === -1 ? undefined : stop + 1)
    },
    async exists() {
      return 0
    },
    async sIsMember() {
      return false
    },
    getClient() {
      return makeRawClient()
    },
    async execute(fn: (client: any) => any) {
      return fn(makeRawClient())
    }
  }
  // Services reached through the real route handlers may call redis methods this
  // harness does not model. Surface them without exploding: warn once, return null.
  const warned = new Set<string>()
  return new Proxy(base, {
    get(target, prop: string | symbol) {
      if (prop in target) return (target as any)[prop]
      // Never make the fake thenable (await redisFake would hang) and never fabricate
      // well-known symbol protocol members.
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'catch' || prop === 'finally') {
        return undefined
      }
      if (!warned.has(prop)) {
        warned.add(prop)
        console.warn(`[parity-harness] unmodeled redis method called: ${String(prop)}`)
      }
      return async () => null
    }
  })
})

vi.mock('$lib/server/redis', () => ({
  redis: redisFake,
  RedisService: class {
    get(key: string) {
      return redisFake.get(key)
    }
    getProjects(_userId?: string) {
      // The /api/projects route constructs its own RedisService — serve the same
      // seeded fixture so the client lane's G-0148 path exercises the real handler.
      return redisFake.getProjects()
    }
    getClient() {
      // SA-096 P4: the capability index reaches the Fabric registry, which reaches
      // ArtifactsService, which constructs its own RedisService and asks for the raw
      // client. Serve the same seeded fixture rather than a second store.
      return redisFake.getClient()
    }
    execute(fn: (client: any) => any) {
      return redisFake.execute(fn)
    }
  }
}))

vi.mock('$env/dynamic/public', () => ({
  env: {}
}))

import { DatabaseService as ServerDatabaseService, invalidateUserSettingsCache as invalidateServerSettingsCache } from './databaseRedis.server'
import { DatabaseService as ClientDatabaseService, invalidateUserSettingsCache as invalidateClientSettingsCache } from './databaseRedis.client'
import { applyFixedSessionGraduationToMessages } from '$lib/utils/fixedSessionGraduation'

const USER_ID = 'josh'

function freshState(sessionId: string): FixtureState {
  return {
    kv: new Map<string, any>([
      ['batshit:batshit_mode3_system_prompt', 'API PRIMARY PROMPT BODY'],
      ['batshit:batshit_mode4_system_prompt', 'CLI PRIMARY PROMPT BODY'],
      ['batshit:n8n_mode2_system_prompt', 'N8N PRIMARY PROMPT BODY'],
      ['batshit:sub_system_prompt', 'SUBAGENT BASE PROMPT BODY']
    ]),
    sets: new Map<string, Set<string>>(),
    lists: new Map<string, string[]>(),
    session: { id: sessionId, user_id: USER_ID, name: 'Parity Session', metadata: {} },
    userSettings: {
      id: USER_ID,
      global_custom_system_prompt: 'GLOBAL CUSTOM RULES BODY',
      default_workspace_path: '/Users/example/global-default',
      ui_settings: {}
    },
    projects: [],
    zips: new Map<string, any>(),
    failUserSettings: false,
    failSettingsRoute: false
  }
}

function apiAgent(overrides: Record<string, any> = {}) {
  return {
    id: 'agent-api-parity',
    name: 'Cody',
    primary_agent_type: 'api',
    agentType: 'api',
    include_global_prompt: true,
    system_prompt: 'AGENT USER PROMPT BODY with {{ $unresolved_var }}',
    ...overrides
  }
}

function n8nAgent(overrides: Record<string, any> = {}) {
  return {
    id: 'agent-n8n-parity',
    name: 'Enn',
    primary_agent_type: 'n8n',
    agentType: 'n8n',
    include_global_prompt: true,
    system_prompt: 'N8N AGENT USER PROMPT BODY',
    ...overrides
  }
}

function baseMessages() {
  return [
    {
      id: 'msg-1',
      role: 'user',
      content: 'Earlier question about the project',
      timestamp: '2026-06-12T09:00:00.000Z',
      metadata: {}
    },
    {
      id: 'msg-2',
      role: 'assistant',
      content: 'Earlier answer about the project',
      timestamp: '2026-06-12T09:00:30.000Z',
      metadata: {}
    }
  ] as any[]
}

type RouteModule = Record<string, (event: any) => Promise<Response>>

const routeImports: Record<string, () => Promise<RouteModule>> = {
  redisGet: () => import('../../routes/api/redis/get/[key]/+server'),
  userSettings: () => import('../../routes/api/users/[id]/settings/+server'),
  projects: () => import('../../routes/api/projects/+server'),
  zips: () => import('../../routes/api/zips/+server'),
  unzipping: () => import('../../routes/api/unzipping/+server'),
  sessionClips: () => import('../../routes/api/session-clips/state/[sessionId]/+server'),
  clips: () => import('../../routes/api/clips/[id]/+server'),
  goon: () => import('../../routes/api/goons/[id]/+server'),
  agentCapabilities: () => import('../../routes/api/slash-commands/agent-capabilities/+server'),
  skillSessionContext: () => import('../../routes/api/skills/session-context/+server'),
  controlsFind: () => import('../../routes/api/controls/find/+server'),
  mcpToolsDcm: () => import('../../routes/api/mcp/tools/dcm/+server'),
  memoryCompileContext: () => import('../../routes/api/memory/compile-context/+server')
} as any

function buildLocals() {
  return { user: { id: USER_ID, email: 'user@batshit.ai', is_admin: true } }
}

async function invokeRoute(
  moduleKey: keyof typeof routeImports,
  method: 'GET' | 'POST',
  url: URL,
  params: Record<string, string>,
  init?: RequestInit
): Promise<Response> {
  const module = await routeImports[moduleKey]()
  const handler = module[method]
  if (!handler) {
    return new Response(`parity-harness: no ${method} handler for ${String(moduleKey)}`, {
      status: 405
    })
  }
  const request = new Request(url.toString(), { method, ...init })
  return handler({
    request,
    url,
    params,
    locals: buildLocals(),
    cookies: { get: () => null, set: () => undefined, delete: () => undefined },
    fetch: globalThis.fetch,
    getClientAddress: () => '127.0.0.1'
  })
}

function createFetchRouter() {
  return async function parityFetch(input: any, init?: RequestInit): Promise<Response> {
    const rawUrl = typeof input === 'string' ? input : input?.url
    const url = new URL(rawUrl, 'http://localhost')
    if (process.env.PARITY_DEBUG === '1') {
      console.log('[parity-fetch]', init?.method ?? 'GET', url.pathname + url.search)
    }
    const method = ((init?.method || (typeof input !== 'string' && input?.method) || 'GET') as string).toUpperCase() as
      | 'GET'
      | 'POST'
    const path = url.pathname

    let match: RegExpMatchArray | null = null
    if ((match = path.match(/^\/api\/redis\/get\/(.+)$/))) {
      return invokeRoute('redisGet', method, url, { key: decodeURIComponent(match[1]) }, init)
    }
    if ((match = path.match(/^\/api\/users\/([^/]+)\/settings$/))) {
      if (state.current.failSettingsRoute) {
        return new Response(JSON.stringify({ error: 'injected settings failure' }), { status: 500 })
      }
      return invokeRoute('userSettings', method, url, { id: decodeURIComponent(match[1]) }, init)
    }
    if (path === '/api/projects') {
      return invokeRoute('projects', method, url, {}, init)
    }
    if (path === '/api/zips') {
      return invokeRoute('zips', method, url, {}, init)
    }
    if (path === '/api/unzipping') {
      return invokeRoute('unzipping', method, url, {}, init)
    }
    if ((match = path.match(/^\/api\/session-clips\/state\/([^/]+)$/))) {
      return invokeRoute('sessionClips', method, url, { sessionId: decodeURIComponent(match[1]) }, init)
    }
    if ((match = path.match(/^\/api\/clips\/([^/]+)$/))) {
      return invokeRoute('clips', method, url, { id: decodeURIComponent(match[1]) }, init)
    }
    if ((match = path.match(/^\/api\/goons\/([^/]+)$/))) {
      return invokeRoute('goon', method, url, { id: decodeURIComponent(match[1]) }, init)
    }
    if (path === '/api/slash-commands/agent-capabilities') {
      return invokeRoute('agentCapabilities', method, url, {}, init)
    }
    if (path === '/api/skills/session-context') {
      return invokeRoute('skillSessionContext', method, url, {}, init)
    }
    if (path === '/api/controls/find') {
      return invokeRoute('controlsFind', method, url, {}, init)
    }
    if (path === '/api/mcp/tools/dcm') {
      return invokeRoute('mcpToolsDcm', method, url, {}, init)
    }
    if (path === '/api/memory/compile-context') {
      return invokeRoute('memoryCompileContext', method, url, {}, init)
    }
    return new Response(`parity-harness: unrouted fetch ${method} ${path}`, { status: 501 })
  }
}

type TwinArgs = {
  sessionId: string
  messages: any[]
  agent: any
  currentUserMessage: string
  assignedSubagents?: any[]
  options?: Record<string, any>
}

async function runBothTwins(args: TwinArgs) {
  const router = createFetchRouter()
  vi.stubGlobal('fetch', router)

  // Client first: zippingService is a shared singleton — the client lane loads honestly
  // over HTTP, then the server lane's hydrate() overwrites with the same seeded state.
  const clientService = new ClientDatabaseService(router as any)
  const clientResult = await clientService.buildFormattedChatInput(
    args.sessionId,
    args.messages,
    args.agent,
    args.currentUserMessage,
    args.assignedSubagents ?? [],
    USER_ID,
    { ...(args.options ?? {}), fetch: router }
  )

  invalidateServerSettingsCache(USER_ID)
  invalidateClientSettingsCache(USER_ID)

  const serverService = new ServerDatabaseService()
  const serverResult = await serverService.buildFormattedChatInput(
    args.sessionId,
    args.messages,
    args.agent,
    args.currentUserMessage,
    args.assignedSubagents ?? [],
    USER_ID,
    { ...(args.options ?? {}) }
  )

  return { server: serverResult, client: clientResult }
}

function normalize(result: any) {
  const clone = JSON.parse(JSON.stringify(result))
  if (clone?.structuredInput?.metadata) {
    // The metadata.agent field echoes the input fixture object — identical by construction.
    delete clone.structuredInput.metadata.agent
  }
  return clone
}

function currentUserMessageContent(result: any): string {
  const messages = result?.structuredInput?.messages ?? []
  const lastUser = [...messages].reverse().find((message: any) => message?.role === 'user')
  return typeof lastUser?.content === 'string' ? lastUser.content : ''
}

let scenarioCounter = 0
function nextSessionId() {
  scenarioCounter += 1
  return `parity-session-${scenarioCounter}`
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

beforeAll(() => {
  // Deterministic across dev Macs and Linux CI: the server twin's sandbox default is
  // platform-dependent (G-0027); pin darwin so equality scenarios compare cleanly.
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
})

afterAll(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
})

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-06-12T10:00:00.000Z'), toFake: ['Date'] })
  delete process.env.BATSHIT_CONTAINERIZED
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete process.env.BATSHIT_CONTAINERIZED
})

describe('buildFormattedChatInput twins parity (DL-5 / G-0001)', () => {
  it('S1: baseline API-agent compile is identical across twins', async () => {
    const sessionId = nextSessionId()
    state.current = freshState(sessionId)

    const { server, client } = await runBothTwins({
      sessionId,
      messages: baseMessages(),
      agent: apiAgent(),
      currentUserMessage: 'What changed in the project today?',
      options: { runtimeFlavor: 'vercel' }
    })

    expect(normalize(server)).toEqual(normalize(client))
    expect(server.primarySystemPrompt).toContain('API PRIMARY PROMPT BODY')
  })

  it('S2: system prompt merge order and unresolved variables are identical', async () => {
    const sessionId = nextSessionId()
    state.current = freshState(sessionId)

    const { server, client } = await runBothTwins({
      sessionId,
      messages: [],
      agent: apiAgent(),
      currentUserMessage: 'hello',
      options: { runtimeFlavor: 'vercel' }
    })

    expect(server.primarySystemPrompt).toBe(client.primarySystemPrompt)
    const prompt = server.primarySystemPrompt ?? ''
    const primaryIndex = prompt.indexOf('API PRIMARY PROMPT BODY')
    const globalIndex = prompt.indexOf('==== GLOBAL CUSTOM SYSTEM PROMPT ====')
    const userIndex = prompt.indexOf('==== USER SYSTEM PROMPT ====')
    expect(primaryIndex).toBeGreaterThanOrEqual(0)
    expect(globalIndex).toBeGreaterThan(primaryIndex)
    expect(userIndex).toBeGreaterThan(globalIndex)
    // Unresolved {{ $variable }} placeholders pass through as literals in BOTH lanes.
    expect(prompt).toContain('{{ $unresolved_var }}')
  })

  it('S3: zip-bearing history with manual unzip state compiles identically', async () => {
    const sessionId = nextSessionId()
    state.current = freshState(sessionId)
    state.current.zips.set('zip-001', {
      id: 'zip-001',
      sessionId,
      userId: USER_ID,
      type: 'terminal',
      content: 'line one of terminal output\nline two of terminal output',
      tokens: 24,
      description: '2 lines of terminal output',
      metadata: {}
    })
    state.current.sets.set(`unzipped:${sessionId}`, new Set(['zip-001']))
    state.current.kv.set(`unzipped_item:${sessionId}:zip-001`, {
      zipId: 'zip-001',
      sessionId,
      content: 'line one of terminal output\nline two of terminal output',
      description: '2 lines of terminal output',
      tokens: 24,
      source: 'user',
      unzippedAt: '2026-06-12T09:30:00.000Z'
    })

    const messages = baseMessages()
    messages[1] = {
      ...messages[1],
      content: 'Ran the command: {{batshit-zip:zip-001:::2 lines of terminal output}}',
      metadata: { zipIds: ['zip-001'] }
    }

    const { server, client } = await runBothTwins({
      sessionId,
      messages,
      agent: apiAgent(),
      currentUserMessage: 'Summarize that output',
      options: { runtimeFlavor: 'vercel' }
    })

    expect(normalize(server)).toEqual(normalize(client))
    // Observed behavior pinned as-is (identical in both twins): in the default
    // appended view mode the compact ref stays inline and the manual-unzip state
    // surfaces through the DCM zip-state line. Whether the unzipped BODY should
    // also reach the model here is a zip-system question for the approved zip
    // cluster (G-0057+), not a twins-parity question.
    const history = JSON.stringify(server.structuredInput.messages)
    expect(history).toContain('{{batshit-zip:zip-001:::2 lines of terminal output}}')
    expect(history).toContain('2 lines of terminal output | zip-001 | user-locked')
  })

  it('S4: text + image clips (localBase64) compile identically', async () => {
    const sessionId = nextSessionId()
    state.current = freshState(sessionId)
    state.current.kv.set(`clip:${USER_ID}:clip-text-1`, {
      id: 'clip-text-1',
      filename: 'notes.txt',
      fileType: 'text',
      mimeType: 'text/plain',
      content: 'clip text body line',
      localTokens: 6,
      fileSize: 19
    })
    state.current.kv.set(`clip:${USER_ID}:clip-image-1`, {
      id: 'clip-image-1',
      filename: 'pixel.png',
      fileType: 'image',
      mimeType: 'image/png',
      localBase64:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      externalTokens: 765,
      fileSize: 68
    })
    state.current.kv.set(`session:${sessionId}:clip_state`, {
      sessionId,
      clips: [{ clipId: 'clip-text-1' }, { clipId: 'clip-image-1' }]
    })

    const { server, client } = await runBothTwins({
      sessionId,
      messages: [],
      agent: apiAgent(),
      currentUserMessage: 'Use the attached files',
      options: { runtimeFlavor: 'vercel' }
    })

    expect(normalize(server)).toEqual(normalize(client))
    const clipped = JSON.stringify(server.structuredInput)
    expect(clipped).toContain('clip text body line')
    expect(clipped).toContain('data:image/png;base64,')
  })

  it('S4b FIXED G-0032: non-UTF8 base64 text clips decode identically (loud, never a silent "")', async () => {
    const sessionId = nextSessionId()
    state.current = freshState(sessionId)
    // base64 of bytes [0xC3, 0x28] — an invalid UTF-8 sequence: the atob+decodeURIComponent
    // fast path throws URIError, forcing the unified Buffer fallback in both lanes.
    state.current.kv.set(`clip:${USER_ID}:clip-bad-utf8`, {
      id: 'clip-bad-utf8',
      filename: 'legacy.txt',
      fileType: 'text',
      mimeType: 'text/plain',
      localBase64: 'data:text/plain;base64,wyg=',
      fileSize: 2
    })
    state.current.kv.set(`session:${sessionId}:clip_state`, {
      sessionId,
      clips: [{ clipId: 'clip-bad-utf8' }]
    })

    const { server, client } = await runBothTwins({
      sessionId,
      messages: [],
      agent: apiAgent(),
      currentUserMessage: 'Use the attached legacy file',
      options: { runtimeFlavor: 'vercel' }
    })

    expect(normalize(server)).toEqual(normalize(client))
    // Buffer's utf-8 decode replaces the invalid byte with U+FFFD and keeps '(' — the
    // same bytes in both lanes, never a silently-dropped empty string (G-0032).
    const clipped = JSON.stringify(server.structuredInput)
    expect(clipped).toContain('�(')
  })

  it('S5 FIXED G-0063: tunnel-backed clip URLs resolve identically in both lanes', async () => {
    const sessionId = nextSessionId()
    state.current = freshState(sessionId)
    state.current.userSettings.ui_settings = {
      upload_settings: {
        tunnel_provider: 'manual',
        tunnel_url: 'tunnel.example.com',
        use_https: true
      }
    }
    state.current.kv.set(`clip:${USER_ID}:clip-doc-1`, {
      id: 'clip-doc-1',
      filename: 'spec.pdf',
      fileType: 'document',
      mimeType: 'application/pdf',
      tunnelPath: '/uploads/documents/spec.pdf',
      localUrl: 'http://localhost:5600/uploads/documents/spec.pdf',
      fileSize: 1024
    })
    state.current.kv.set(`session:${sessionId}:clip_state`, {
      sessionId,
      clips: [{ clipId: 'clip-doc-1' }]
    })

    const { server, client } = await runBothTwins({
      sessionId,
      messages: [],
      agent: apiAgent(),
      currentUserMessage: 'Read the attached spec',
      options: { runtimeFlavor: 'vercel' }
    })

    // Both lanes run the same late tunnel resolution (server inline, client via the
    // clip route's resolve_model_url lane) — byte-equal output, tunnel URL present.
    expect(normalize(server)).toEqual(normalize(client))
    const serverClip = JSON.stringify(server.structuredInput)
    const clientClip = JSON.stringify(client.structuredInput)
    expect(serverClip).toContain('https://tunnel.example.com/uploads/documents/spec.pdf')
    expect(clientClip).toContain('https://tunnel.example.com/uploads/documents/spec.pdf')
    expect(clientClip).not.toContain('http://localhost:5600/uploads/documents/spec.pdf')
  })

  it('S6 FIXED G-0148: agent default_project_id resolves identically in both lanes', async () => {
    const sessionId = nextSessionId()
    state.current = freshState(sessionId)
    state.current.projects = [
      {
        id: 'proj-1',
        name: 'Project One',
        root_path: '/Users/example/proj-one',
        rules_json: { allowedRoots: ['/Users/example/proj-one'] }
      }
    ]

    const { server, client } = await runBothTwins({
      sessionId,
      messages: [],
      agent: apiAgent({ default_project_id: 'proj-1' }),
      currentUserMessage: 'Where are we working?',
      options: { runtimeFlavor: 'vercel' }
    })

    // Both lanes resolve the agent default project; the client lane unwraps the
    // route's {projects} envelope correctly now (G-0148).
    expect(server.resolvedProjectPath).toBe('/Users/example/proj-one')
    expect(client.resolvedProjectPath).toBe('/Users/example/proj-one')
    expect(normalize(server)).toEqual(normalize(client))
  })

  it('S7 FIXED G-0026: n8n automation pack teaches the broker fetch-zip contract in both lanes', async () => {
    const sessionId = nextSessionId()
    state.current = freshState(sessionId)

    const { server, client } = await runBothTwins({
      sessionId,
      messages: [],
      agent: n8nAgent(),
      currentUserMessage: 'n8n turn with native tools',
      options: { runtimeFlavor: 'n8n' }
    })

    const serverDcm = currentUserMessageContent(server)
    const clientDcm = currentUserMessageContent(client)

    // Both lanes teach exactly the broker fabric lane — no standalone fetch_zip action.
    for (const dcm of [serverDcm, clientDcm]) {
      expect(dcm).toContain('native_tools_broker_families: mcp, cli, artifact, agent_browser, fabric')
      expect(dcm).toContain('fabric:sys.zip.fetch input:')
      expect(dcm).toContain(
        'native_tools_fetch_zip: use batshit_tool_use ref="fabric:sys.zip.fetch" from n8n primary calls; blocked for subagent calls'
      )
      expect(dcm).not.toContain('fetch_zip input:')
      expect(dcm).not.toMatch(/native_tools_actions_enabled:.*\bfetch_zip\b/)
    }
    expect(normalize(server)).toEqual(normalize(client))
  })

  it('S7b FIXED G-0026: with fetch-zip disabled, neither lane advertises fetch-zip', async () => {
    const sessionId = nextSessionId()
    state.current = freshState(sessionId)

    const { server, client } = await runBothTwins({
      sessionId,
      messages: [],
      agent: n8nAgent({
        provider_specific_settings: { nativeTools: { fetchZipEnabled: false } }
      }),
      currentUserMessage: 'n8n turn with fetch-zip disabled',
      options: { runtimeFlavor: 'n8n' }
    })

    const serverDcm = currentUserMessageContent(server)
    const clientDcm = currentUserMessageContent(client)

    // The trailing fetch-zip line is conditional in BOTH lanes now (the client used to
    // emit it unconditionally — the sharpest pre-fix G-0026 pin).
    expect(serverDcm).not.toContain('native_tools_fetch_zip')
    expect(clientDcm).not.toContain('native_tools_fetch_zip')
    expect(serverDcm).not.toContain('fabric:sys.zip.fetch')
    expect(clientDcm).not.toContain('fabric:sys.zip.fetch')
    expect(normalize(server)).toEqual(normalize(client))
  })

  it('S8 FIXED G-0027: BATSHIT_CONTAINERIZED=1 yields docker_sandbox in BOTH lanes', async () => {
    const sessionId = nextSessionId()
    state.current = freshState(sessionId)
    process.env.BATSHIT_CONTAINERIZED = '1'

    const { server, client } = await runBothTwins({
      sessionId,
      messages: [],
      agent: apiAgent(),
      currentUserMessage: 'bash-capable turn',
      options: { runtimeFlavor: 'vercel' }
    })

    const serverDcm = currentUserMessageContent(server)
    const clientDcm = currentUserMessageContent(client)

    // The backend is one server fact (shared helper → settings envelope rider): the
    // client no longer guesses apple_container while commands run in docker_sandbox.
    expect(serverDcm).toContain('runtime_network: backend=docker_sandbox')
    expect(clientDcm).toContain('runtime_network: backend=docker_sandbox')
    expect(normalize(server)).toEqual(normalize(client))
  })

  it('S9 FIXED G-0031/G-0152a: settings-source failure rejects the compile loudly in BOTH lanes', async () => {
    const sessionId = nextSessionId()
    state.current = freshState(sessionId)
    state.current.failUserSettings = true
    state.current.failSettingsRoute = true

    const router = createFetchRouter()
    vi.stubGlobal('fetch', router)
    invalidateServerSettingsCache(USER_ID)
    invalidateClientSettingsCache(USER_ID)

    // runBothTwins is not usable here: both lanes must REJECT, not return output.
    const clientService = new ClientDatabaseService(router as any)
    await expect(
      clientService.buildFormattedChatInput(
        sessionId,
        [],
        apiAgent(),
        'turn during settings outage',
        [],
        USER_ID,
        { runtimeFlavor: 'vercel', fetch: router }
      )
    ).rejects.toThrow(/USER_SETTINGS_UNAVAILABLE/)

    invalidateServerSettingsCache(USER_ID)
    invalidateClientSettingsCache(USER_ID)

    const serverService = new ServerDatabaseService()
    await expect(
      serverService.buildFormattedChatInput(
        sessionId,
        [],
        apiAgent(),
        'turn during settings outage',
        [],
        USER_ID,
        { runtimeFlavor: 'vercel' }
      )
    ).rejects.toThrow(/USER_SETTINGS_UNAVAILABLE/)
  })

  it('S10: subagent roster compiles to the same slugs; server may append managed dynamic info only', async () => {
    const sessionId = nextSessionId()
    state.current = freshState(sessionId)

    const assignedSubagents = [
      {
        id: 'api_helper',
        name: 'API Helper',
        displayName: 'Renamed API Helper',
        description: 'API slice coverage',
        system_prompt: 'API HELPER CUSTOM PROMPT'
      },
      {
        id: 'display_only_slug',
        displayName: 'Display Only',
        description: 'Display-name slug edge'
      }
    ]

    const { server, client } = await runBothTwins({
      sessionId,
      messages: [],
      agent: apiAgent(),
      currentUserMessage: 'use a subagent',
      assignedSubagents,
      options: { runtimeFlavor: 'vercel' }
    })

    expect(Object.keys(server.subagentPrompts ?? {}).sort()).toEqual(
      Object.keys(client.subagentPrompts ?? {}).sort()
    )
    expect(Object.keys(server.subagentPrompts ?? {})).toEqual(
      expect.arrayContaining(['api_helper', 'display_only_slug'])
    )
    expect(server.subagentDescription).toEqual(client.subagentDescription)

    // Structural asymmetry (intentional, context-pipeline.md): the server twin appends
    // managed-subagent dynamic info AFTER the shared compilation; the client never does.
    // The shared prefix must stay byte-identical.
    for (const key of Object.keys(client.subagentPrompts ?? {})) {
      const serverPrompt = server.subagentPrompts?.[key] ?? ''
      const clientPrompt = client.subagentPrompts?.[key] ?? ''
      expect(serverPrompt.startsWith(clientPrompt)).toBe(true)
    }
  })

  it('S11: voice-state DCM lines are identical across twins', async () => {
    const sessionId = nextSessionId()
    state.current = freshState(sessionId)

    const { server, client } = await runBothTwins({
      sessionId,
      messages: [],
      agent: apiAgent(),
      currentUserMessage: 'spoken message',
      options: {
        runtimeFlavor: 'vercel',
        voiceState: { stt: true, tts: true, voiceMode: 'voice', provider: 'fish' }
      }
    })

    expect(normalize(server)).toEqual(normalize(client))
    const dcm = currentUserMessageContent(server)
    expect(dcm).toContain('Voice runtime context:')
  })

  it('S12: Desktop Goon presentation DCM is identical across twins', async () => {
    const sessionId = nextSessionId()
    state.current = freshState(sessionId)
    state.current.userSettings.goons_settings = {
      dockOpen: true,
      globalCloset: { items: {} },
      kitchen: {
        cues: {
          happy: {
            name: 'happy',
            kind: 'mood',
            playback: 'loop',
            description: 'Happy idle'
          },
          smile: {
            name: 'smile',
            kind: 'emote',
            playback: 'oneshot',
            description: 'Warm smile'
          }
        },
        emojiMap: { '🙂': 'smile' },
        scenes: { rooftop: { id: 'rooftop', name: 'Neon Rooftop' } },
        roomTextures: {},
        bodyVariants: { items: {} }
      }
    }
    state.current.kv.set('goon:desktop-parity', {
      id: 'desktop-parity',
      user_id: USER_ID,
      name: 'Desktop Parity',
      files: { vrm: { url: '/goons/desktop-parity.vrm', filename: 'desktop-parity.vrm' } },
      cues: { enabled: ['happy', 'smile'], overrides: {}, emojiOverrides: {} },
      defaults: { baseLoop: 'happy', sceneId: 'rooftop' },
      created_at: '2026-08-12T00:00:00.000Z',
      updated_at: '2026-08-12T00:00:00.000Z'
    })

    const { server, client } = await runBothTwins({
      sessionId,
      messages: [],
      agent: apiAgent({ goon_id: 'desktop-parity' }),
      currentUserMessage: 'talk to me from the desktop',
      options: {
        runtimeFlavor: 'vercel',
        goonsEnabled: true,
        goonPresentationMode: 'desktop',
        voiceState: { tts: true, voiceMode: 'voice' },
        goonsSettings: state.current.userSettings.goons_settings
      }
    })

    expect(normalize(server)).toEqual(normalize(client))
    const dcm = currentUserMessageContent(server)
    expect(dcm).toContain('Presentation: Desktop Mode')
    expect(dcm).toContain('does not give you screen vision')
    expect(dcm).toContain('Moods: happy (Happy idle)')
    expect(dcm).toContain('Emotes: smile (Warm smile)')
    expect(dcm).not.toContain('Scene: Neon Rooftop')
  })

  const DISCOVERY_BLOCK_HEADER = '==== DYNAMIC TOOL SEARCH / DISCOVERY (WHEN ENABLED) ===='

  it('S13 SA-096 P5: Dynamic MCP off but Fabric live still ships broker guidance in BOTH lanes', async () => {
    const sessionId = nextSessionId()
    state.current = freshState(sessionId)

    // This agent gets native_batshit_tool_search registered off the Fabric family alone.
    // Before P5 the guidance was gated on dynamicMcpEnabled, so it received the broker
    // tools and zero instructions for them.
    const nativeTools = {
      dynamicMcpEnabled: false,
      cliToolsEnabled: false,
      artifactRuntimeEnabled: false,
      batshitToolsEnabled: false,
      fetchZipEnabled: true
    }

    const { server, client } = await runBothTwins({
      sessionId,
      messages: [],
      agent: apiAgent({ provider_specific_settings: { nativeTools } }),
      currentUserMessage: 'what can you do?',
      options: { runtimeFlavor: 'vercel' }
    })

    expect(server.primarySystemPrompt).toContain(DISCOVERY_BLOCK_HEADER)
    expect(client.primarySystemPrompt).toContain(DISCOVERY_BLOCK_HEADER)
    expect(normalize(server)).toEqual(normalize(client))
  })

  it('S14 SA-096 P5: no reachable family withholds broker guidance in BOTH lanes', async () => {
    const sessionId = nextSessionId()
    state.current = freshState(sessionId)

    const nativeTools = {
      dynamicMcpEnabled: false,
      cliToolsEnabled: false,
      artifactRuntimeEnabled: false,
      batshitToolsEnabled: false,
      fetchZipEnabled: false,
      agentBrowserEnabled: false
    }

    const { server, client } = await runBothTwins({
      sessionId,
      messages: [],
      agent: apiAgent({ provider_specific_settings: { nativeTools } }),
      currentUserMessage: 'what can you do?',
      options: { runtimeFlavor: 'vercel' }
    })

    // The broker is not registered for this agent, so ~900 tokens explaining it would be
    // an instruction for a tool that does not exist.
    expect(server.primarySystemPrompt).not.toContain(DISCOVERY_BLOCK_HEADER)
    expect(client.primarySystemPrompt).not.toContain(DISCOVERY_BLOCK_HEADER)
    // The surrounding tool + zip guidance is unaffected — only the broker block is gated.
    expect(server.primarySystemPrompt).toContain('==== TOOL + ZIP GUIDANCE')
    expect(client.primarySystemPrompt).toContain('==== TOOL + ZIP GUIDANCE')
    expect(normalize(server)).toEqual(normalize(client))
  })

  it('S15 SA-096 P5: an n8n agent with only fetch-zip left on still ships broker guidance', async () => {
    const sessionId = nextSessionId()
    state.current = freshState(sessionId)

    // The n8n automation pack opens its Fabric family from fetch-zip, so the gate must
    // follow the pack's rules rather than the API lane's.
    const { server, client } = await runBothTwins({
      sessionId,
      messages: [],
      agent: n8nAgent({
        provider_specific_settings: {
          nativeTools: {
            dynamicMcpEnabled: false,
            cliToolsEnabled: false,
            artifactRuntimeEnabled: false,
            batshitToolsEnabled: false,
            agentBrowserEnabled: false,
            fetchZipEnabled: true
          }
        }
      }),
      currentUserMessage: 'n8n turn with only fetch-zip',
      options: { runtimeFlavor: 'n8n' }
    })

    expect(server.primarySystemPrompt).toContain(DISCOVERY_BLOCK_HEADER)
    expect(client.primarySystemPrompt).toContain(DISCOVERY_BLOCK_HEADER)
    expect(currentUserMessageContent(server)).toContain('native_tools_broker_families: fabric')
    expect(normalize(server)).toEqual(normalize(client))
  })

  it('S16 SA-096 P1: no instruction appears in two blocks of the same compiled prompt', async () => {
    const sessionId = nextSessionId()
    state.current = freshState(sessionId)

    const { server, client } = await runBothTwins({
      sessionId,
      messages: [],
      agent: apiAgent(),
      currentUserMessage: 'compile a full default prompt',
      options: { runtimeFlavor: 'vercel' }
    })

    for (const prompt of [server.primarySystemPrompt ?? '', client.primarySystemPrompt ?? '']) {
      // A default API agent receives all three blocks, which is exactly when the
      // duplication used to bite.
      expect(prompt).toContain('==== API PRIMARY SYSTEM PROMPT ====')
      expect(prompt).toContain('==== TOOL + ZIP GUIDANCE')
      expect(prompt).toContain(DISCOVERY_BLOCK_HEADER)

      const occurrences = (needle: string) => prompt.split(needle).length - 1

      // Broker rules: discovery block only.
      expect({ needle: 'Never invent placeholder refs', n: occurrences('Never invent placeholder refs') })
        .toEqual({ needle: 'Never invent placeholder refs', n: 1 })
      expect({ needle: 'Prefer the broker over bash', n: occurrences('Prefer the broker over bash') })
        .toEqual({ needle: 'Prefer the broker over bash', n: 1 })

      // Bash policy: tool + zip block only.
      expect({ needle: 'POLICY_BLOCKED', n: occurrences('POLICY_BLOCKED') })
        .toEqual({ needle: 'POLICY_BLOCKED', n: 1 })
      expect({ needle: 'native_bash', n: occurrences('native_bash') })
        .toEqual({ needle: 'native_bash', n: 1 })

      // Fetch Zip: one canonical statement, referenced by name elsewhere.
      expect({ needle: 'fabric:sys.zip.fetch', n: occurrences('fabric:sys.zip.fetch') })
        .toEqual({ needle: 'fabric:sys.zip.fetch', n: 1 })

      // DL-4: an API agent is never shown a tool name it does not have.
      expect(prompt).not.toMatch(/(^|[^_])\bbatshit_tool_use\b/)
      expect(prompt).not.toMatch(/(^|[^_])\bbatshit_tool_search\b/)
    }

    expect(normalize(server)).toEqual(normalize(client))
  })

  it('S17 SA-104 P3: memory guidance ships for memory-enabled agents in BOTH lanes and stays absent otherwise', async () => {
    const MEMORY_BLOCK_HEADER = '==== MEMORY (AGENT MEMORY ENABLED) ===='

    // Default agent: memory is opt-in, so the block must be absent.
    {
      const sessionId = nextSessionId()
      state.current = freshState(sessionId)
      const { server, client } = await runBothTwins({
        sessionId,
        messages: [],
        agent: apiAgent(),
        currentUserMessage: 'no memory here',
        options: { runtimeFlavor: 'vercel' }
      })
      expect(server.primarySystemPrompt).not.toContain(MEMORY_BLOCK_HEADER)
      expect(client.primarySystemPrompt).not.toContain(MEMORY_BLOCK_HEADER)
      expect(normalize(server)).toEqual(normalize(client))
    }

    // Memory-enabled API agent: block present in both lanes, API tool names only (DL-4).
    {
      const sessionId = nextSessionId()
      state.current = freshState(sessionId)
      const { server, client } = await runBothTwins({
        sessionId,
        messages: [],
        agent: apiAgent({ memory_enabled: true }),
        currentUserMessage: 'remember things for me',
        options: { runtimeFlavor: 'vercel' }
      })
      for (const prompt of [server.primarySystemPrompt ?? '', client.primarySystemPrompt ?? '']) {
        expect(prompt).toContain(MEMORY_BLOCK_HEADER)
        expect(prompt).toContain('<batshit-memory>')
        expect(prompt).toContain('fabric:sys.memory.search')
        expect(prompt).not.toMatch(/(^|[^_])\bbatshit_tool_use\b/)
        expect(prompt).not.toMatch(/(^|[^_])\bbatshit_tool_search\b/)
      }
      expect(normalize(server)).toEqual(normalize(client))
    }

    // Memory-enabled n8n agent: block present with the n8n broker action names.
    {
      const sessionId = nextSessionId()
      state.current = freshState(sessionId)
      const { server, client } = await runBothTwins({
        sessionId,
        messages: [],
        agent: n8nAgent({ memory_enabled: true }),
        currentUserMessage: 'n8n memory turn',
        options: { runtimeFlavor: 'n8n' }
      })
      for (const prompt of [server.primarySystemPrompt ?? '', client.primarySystemPrompt ?? '']) {
        expect(prompt).toContain(MEMORY_BLOCK_HEADER)
        expect(prompt).toContain('batshit_tool_search')
      }
      expect(normalize(server)).toEqual(normalize(client))
    }
  })

  it('S18 SA-104 P4: recall-engine context (on-my-mind, DCM inserts, time awareness) is identical across twins', async () => {
    const ON_MY_MIND_HEADER = '==== AWARENESS (AGENT MEMORY) ===='

    const seedMemoryFixtures = (agentId: string, sessionId: string) => {
      state.current.kv.set(`agent:${agentId}`, {
        id: agentId,
        user_id: USER_ID,
        name: 'Memory Twin',
        memory_enabled: true,
        memory_last_interaction_at: '2026-06-09T10:00:00.000Z',
        memory_last_interaction_ts: new Date('2026-06-09T10:00:00.000Z').getTime()
      })
      state.current.kv.set(`memory:${agentId}:mem_awareness_1`, {
        id: 'mem_awareness_1',
        agent_id: agentId,
        user_id: USER_ID,
        lane: 'awareness',
        content: 'The user prefers plain-English explanations.',
        importance: 9,
        event_at: null,
        event_ts: null,
        saved_at: '2026-06-01T09:00:00.000Z',
        saved_ts: new Date('2026-06-01T09:00:00.000Z').getTime(),
        is_superseded: 'n',
        provenance: [{ session_id: 'older-session', source: 'agent' }],
        visibility: 'normal',
        embedding: [],
        embedding_model: 'test',
        schema_version: 1
      })
      state.current.kv.set(`memory:${agentId}:mem_trigger_1`, {
        id: 'mem_trigger_1',
        agent_id: agentId,
        user_id: USER_ID,
        lane: 'stm',
        content: 'Maggie is the user’s Irish Setter.',
        trigger_terms: ['maggie'],
        importance: 7,
        event_at: '2026-05-01T12:00:00.000Z',
        event_ts: new Date('2026-05-01T12:00:00.000Z').getTime(),
        saved_at: '2026-05-01T12:00:00.000Z',
        saved_ts: new Date('2026-05-01T12:00:00.000Z').getTime(),
        is_superseded: 'n',
        provenance: [{ session_id: 'older-session', source: 'agent' }],
        visibility: 'normal',
        embedding: [],
        embedding_model: 'test',
        schema_version: 1
      })
      state.current.kv.set(`memory:${agentId}:mem_recall_1`, {
        id: 'mem_recall_1',
        agent_id: agentId,
        user_id: USER_ID,
        lane: 'ltm',
        content: 'The lake house trip is planned for July.',
        importance: 5,
        event_at: null,
        event_ts: null,
        saved_at: '2026-06-05T09:00:00.000Z',
        saved_ts: new Date('2026-06-05T09:00:00.000Z').getTime(),
        is_superseded: 'n',
        provenance: [{ session_id: sessionId, source: 'agent' }],
        visibility: 'normal',
        embedding: [],
        embedding_model: 'test',
        schema_version: 1
      })
      state.current.kv.set(`memlinger:${sessionId}`, {
        pending: [
          {
            memory_id: 'mem_recall_1',
            agent_id: agentId,
            requested_at: '2026-06-12T09:59:00.000Z',
            source: 'tool'
          }
        ],
        schema_version: 1
      })
    }

    // API-flavor pair: full recall context, byte-identical.
    {
      const sessionId = nextSessionId()
      state.current = freshState(sessionId)
      seedMemoryFixtures('agent-api-parity', sessionId)
      const { server, client } = await runBothTwins({
        sessionId,
        messages: baseMessages(),
        agent: apiAgent({ memory_enabled: true }),
        currentUserMessage: 'How is Maggie doing today?',
        options: { runtimeFlavor: 'vercel' }
      })
      expect(normalize(server)).toEqual(normalize(client))
      for (const result of [server, client]) {
        const prompt = result.primarySystemPrompt ?? ''
        expect(prompt).toContain(ON_MY_MIND_HEADER)
        expect(prompt.indexOf(ON_MY_MIND_HEADER)).toBeGreaterThan(
          prompt.indexOf('==== MEMORY (AGENT MEMORY ENABLED) ====')
        )
        expect(prompt).toContain('The user prefers plain-English explanations.')

        const userMessage = currentUserMessageContent(result)
        expect(userMessage).toContain('Memory context:')
        expect(userMessage).toContain('- Last interaction with the user: 3 days ago')
        expect(userMessage).toContain('- Current (new this message):')
        expect(userMessage).toContain('trigger "maggie" | stm | mem_trigger_1')
        expect(userMessage).toContain('recalled | ltm | mem_recall_1')
        expect(userMessage).toContain('this chat')
        expect(userMessage).toContain('another chat,')

        const memoryContext = result.structuredInput?.metadata?.memoryContext
        expect(memoryContext?.inserts).toHaveLength(2)
        expect(memoryContext?.onMyMind?.count).toBe(1)
      }
    }

    // n8n-flavor pair: same engine output through the client route, still identical.
    {
      const sessionId = nextSessionId()
      state.current = freshState(sessionId)
      seedMemoryFixtures('agent-n8n-parity', sessionId)
      const { server, client } = await runBothTwins({
        sessionId,
        messages: baseMessages(),
        agent: n8nAgent({ memory_enabled: true }),
        currentUserMessage: 'Any news about maggie?',
        options: { runtimeFlavor: 'n8n' }
      })
      expect(normalize(server)).toEqual(normalize(client))
      expect(server.primarySystemPrompt ?? '').toContain(ON_MY_MIND_HEADER)
      expect(currentUserMessageContent(server)).toContain('trigger "maggie" | stm | mem_trigger_1')
    }

    // Group runs get no recall lanes in v1 (recorded limitation): guidance block stays,
    // recall context is absent, twins stay identical.
    {
      const sessionId = nextSessionId()
      state.current = freshState(sessionId)
      seedMemoryFixtures('agent-api-parity', sessionId)
      const { server, client } = await runBothTwins({
        sessionId,
        messages: baseMessages(),
        agent: apiAgent({ memory_enabled: true }),
        currentUserMessage: 'maggie in a group chat',
        options: {
          runtimeFlavor: 'vercel',
          groupContext: {
            agentOrder: ['agent-api-parity'],
            agentDisplayNames: { 'agent-api-parity': 'Cody' },
            currentAgentId: 'agent-api-parity'
          }
        }
      })
      expect(normalize(server)).toEqual(normalize(client))
      for (const result of [server, client]) {
        expect(result.primarySystemPrompt ?? '').not.toContain(ON_MY_MIND_HEADER)
        expect(currentUserMessageContent(result)).not.toContain('Memory context:')
        expect(result.structuredInput?.metadata?.memoryContext).toBeUndefined()
      }
    }

    // Default agents (memory off) stay byte-identical to pre-P4 output: no recall surfaces.
    {
      const sessionId = nextSessionId()
      state.current = freshState(sessionId)
      const { server, client } = await runBothTwins({
        sessionId,
        messages: baseMessages(),
        agent: apiAgent(),
        currentUserMessage: 'maggie without memory',
        options: { runtimeFlavor: 'vercel' }
      })
      expect(normalize(server)).toEqual(normalize(client))
      for (const result of [server, client]) {
        expect(result.primarySystemPrompt ?? '').not.toContain(ON_MY_MIND_HEADER)
        expect(currentUserMessageContent(result)).not.toContain('Memory context:')
        expect(result.structuredInput?.metadata?.memoryContext).toBeUndefined()
      }
    }
  })

  it('S19 SA-104 P6: graduation splices and the episode whiteboard are identical across twins; regular sessions stay untouched', async () => {
    const WHITEBOARD_HEADER = '==== EPISODE WHITEBOARD (CURRENT EPISODE) ===='
    const allCompiledContent = (result: any): string =>
      (result?.structuredInput?.messages ?? [])
        .map((message: any) => (typeof message?.content === 'string' ? message.content : ''))
        .join('\n')

    const graduationEvent = {
      id: 'grad_parity_1',
      createdAt: '2026-06-09T22:00:00.000Z',
      source: 'nap' as const,
      episodeId: 'ep_done',
      segmentId: 'memseg_parity_1',
      sourceMessageIds: ['msg-1'],
      compactedMessageCount: 1,
      summary: 'Earlier stretch: the lake trip was planned and booked.',
      summaryTokenEstimate: 12
    }

    const seedFixedSessionFixtures = (agentId: string, sessionId: string) => {
      // The session record carries the Infinite Session block + graduation bookmark; the
      // engine reads it from kv, the twins via getSession — keep both in sync.
      const sessionRecord = {
        id: sessionId,
        user_id: USER_ID,
        name: 'Parity Infinite Session',
        metadata: {
          fixedSession: {
            version: 1,
            enabled: true,
            created_at: '2026-06-01T00:00:00.000Z',
            graduation: { version: 1, events: [graduationEvent] }
          }
        }
      }
      state.current.session = sessionRecord
      state.current.kv.set(`session:${sessionId}`, sessionRecord)
      state.current.kv.set(`agent:${agentId}`, {
        id: agentId,
        user_id: USER_ID,
        name: 'Memory Twin',
        memory_enabled: true
      })
      // Open episode with a whiteboard (the ledger is a LIST + JSON records).
      state.current.lists.set(`session:${sessionId}:episodes`, ['ep_open'])
      state.current.kv.set(`episode:${sessionId}:ep_open`, {
        id: 'ep_open',
        session_id: sessionId,
        agent_id: agentId,
        state: 'open',
        opened_at: '2026-06-10T08:00:00.000Z',
        whiteboard: {
          content: 'Current goal: finish the garage shelving order.',
          updated_at: '2026-06-10T09:00:00.000Z'
        },
        schema_version: 1
      })
    }

    // Fixed-session pair: the production client shape pre-splices via the shared
    // applier; the server twin re-applies idempotently — byte-equal output with the
    // gist spliced, the graduated message gone, and the whiteboard block present.
    for (const flavor of ['vercel', 'n8n'] as const) {
      const sessionId = nextSessionId()
      state.current = freshState(sessionId)
      const agent =
        flavor === 'vercel'
          ? apiAgent({ memory_enabled: true })
          : n8nAgent({ memory_enabled: true })
      seedFixedSessionFixtures(agent.id, sessionId)
      const windowMessages = applyFixedSessionGraduationToMessages(
        baseMessages() as never,
        state.current.session
      )
      expect(windowMessages.map((message: any) => message.id)).not.toContain('msg-1')

      const { server, client } = await runBothTwins({
        sessionId,
        messages: windowMessages,
        agent,
        currentUserMessage: 'Where were we?',
        options: { runtimeFlavor: flavor }
      })
      expect(normalize(server)).toEqual(normalize(client))
      for (const result of [server, client]) {
        expect(allCompiledContent(result)).toContain('Graduated episode summary:')
        expect(allCompiledContent(result)).toContain('lake trip was planned')
        const prompt = result.primarySystemPrompt ?? ''
        expect(prompt).toContain(WHITEBOARD_HEADER)
        expect(prompt).toContain('Current goal: finish the garage shelving order.')
        expect(prompt.indexOf(WHITEBOARD_HEADER)).toBeGreaterThan(
          prompt.indexOf('==== MEMORY (AGENT MEMORY ENABLED) ====')
        )
        expect(result.structuredInput?.metadata?.memoryContext?.whiteboard?.present).toBe(true)
      }
    }

    // Regular session of the same memory-enabled agent: no splices, no whiteboard —
    // compile stays byte-identical even with memsegs stored (DL-104-12).
    {
      const sessionId = nextSessionId()
      state.current = freshState(sessionId)
      state.current.kv.set(`agent:agent-api-parity`, {
        id: 'agent-api-parity',
        user_id: USER_ID,
        name: 'Memory Twin',
        memory_enabled: true
      })
      state.current.kv.set(`session:${sessionId}`, state.current.session)
      // Fixture Redis key; 'agent-api-parity' trips the generic-api-key scanner rule.
      state.current.kv.set(`memseg:agent-api-parity:memseg_parity_1`, { // gitleaks:allow
        id: 'memseg_parity_1',
        agent_id: 'agent-api-parity',
        user_id: USER_ID,
        session_id: 'some-old-session',
        message_ids: ['x'],
        summary: 'Old graduated stretch.',
        first_message_at: '2026-06-01T08:00:00.000Z',
        first_message_ts: 0,
        last_message_at: '2026-06-01T09:00:00.000Z',
        last_message_ts: 0,
        token_count: 10,
        graduated_at: '2026-06-02T00:00:00.000Z',
        graduated_by: 'idle',
        embedding: [],
        embedding_model: 'test',
        schema_version: 1
      })
      const { server, client } = await runBothTwins({
        sessionId,
        messages: baseMessages(),
        agent: apiAgent({ memory_enabled: true }),
        currentUserMessage: 'Regular chat continues',
        options: { runtimeFlavor: 'vercel' }
      })
      expect(normalize(server)).toEqual(normalize(client))
      for (const result of [server, client]) {
        expect(allCompiledContent(result)).not.toContain('Graduated episode summary:')
        expect(result.primarySystemPrompt ?? '').not.toContain(WHITEBOARD_HEADER)
      }
    }
  })
})
