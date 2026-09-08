import { afterEach, vi } from 'vitest'
// Extend expect with DOM matchers (toBeInTheDocument, toBeDisabled, etc.)
import '@testing-library/jest-dom/vitest'
import { waitForDelayedBodyScrollCleanup } from './delayedBodyScrollCleanup'

// Svelte Testing Library owns component cleanup. This earlier-registered global
// hook runs after its per-file hook and lets Bits UI finish a delayed body unlock
// before Vitest tears down jsdom.
afterEach(waitForDelayedBodyScrollCleanup)

// Force tests to use the test Redis DB (15) unless explicitly opting into real dev data.
// This prevents accidental wipes of DB0 when suites bypass mocks.
if (!process.env.VITEST_REDIS_URL) {
  process.env.VITEST_REDIS_URL = 'redis://127.0.0.1:6379/15'
}
if (!process.env.REDIS_URL || process.env.REDIS_URL.endsWith('/0')) {
  process.env.REDIS_URL = process.env.VITEST_REDIS_URL
}

type ModelFactory = (modelId: string, options?: any) => Record<string, any>

const createProviderFactory = (provider: string) => {
  const modelFactory = vi.fn<ModelFactory>((modelId: string, options?: any) => ({
    provider,
    modelId,
    options
  }))

  const createFn = vi.fn((_config?: Record<string, any>) => modelFactory)

  return { createFn, modelFactory }
}

const anthropicFactory = createProviderFactory('anthropic')
const openaiFactory = createProviderFactory('openai')
const googleFactory = createProviderFactory('google')
const groqFactory = createProviderFactory('groq')
const mistralFactory = createProviderFactory('mistral')
const openRouterFactory = createProviderFactory('openrouter')

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: anthropicFactory.createFn
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: openaiFactory.createFn
}))

vi.mock('@ai-sdk/google', () => ({
  createGoogle: googleFactory.createFn,
  createGoogleGenerativeAI: googleFactory.createFn
}))

vi.mock('@ai-sdk/groq', () => ({
  createGroq: groqFactory.createFn
}))

vi.mock('@ai-sdk/mistral', () => ({
  createMistral: mistralFactory.createFn
}))

;(vi as any).mock(
  '@openrouter/ai-sdk-provider',
  () => ({
    createOpenRouter: vi.fn((_config?: Record<string, any>) => {
      const modelFactory = openRouterFactory.createFn(_config)
      ;(modelFactory as any).chat = vi.fn<ModelFactory>((modelId: string, options?: any) => ({
        provider: 'openrouter',
        modelId,
        options
      }))
      return modelFactory
    })
  }),
  { virtual: true }
)

let redisMockInstance: any | undefined

vi.mock('$lib/server/redis', async () => {
  if (process.env.VITEST_USE_REAL_REDIS === 'true') {
    const actual = await vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis')
    redisMockInstance = undefined
    return actual
  }

  const redisStore = new Map<string, { type: string; value: any }>()
  const expireStore = new Map<string, number>() // unix seconds

  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

  const resolveMatch = (pattern: string) => {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp('^' + escaped.replace(/\\\*/g, '.*') + '$')
    return regex
  }

  const ensureList = (key: string) => {
    const existing = redisStore.get(key)
    if (!existing || existing.type !== 'list') {
      redisStore.set(key, { type: 'list', value: [] })
    }
    return redisStore.get(key)!.value as any[]
  }

  const ensureSet = (key: string) => {
    const existing = redisStore.get(key)
    if (!existing || existing.type !== 'set') {
      redisStore.set(key, { type: 'set', value: new Set<any>() })
    }
    return redisStore.get(key)!.value as Set<any>
  }

  /**
   * SA-113 P2: sorted-set support, for the DM inbox/sent/user indexes (DL-113-02). The
   * ordering is load-bearing — urgent-first then oldest-first comes from the score, not
   * from a JS sort — so the fake has to keep scores, not just membership.
   */
  const ensureZset = (key: string) => {
    const existing = redisStore.get(key)
    if (!existing || existing.type !== 'zset') {
      redisStore.set(key, { type: 'zset', value: new Map<string, number>() })
    }
    return redisStore.get(key)!.value as Map<string, number>
  }

  const zsetMembersAscending = (key: string) =>
    Array.from(ensureZset(key).entries())
      .sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : a[1] - b[1]))
      .map(([member]) => member)

  const nowSeconds = () => Math.floor(Date.now() / 1000)

  const setExpiryValue = (key: string, seconds: number) => {
    expireStore.set(key, nowSeconds() + seconds)
    return true
  }

  const clearExpiryValue = (key: string) => expireStore.delete(key)

  const getTtl = (key: string) => {
    if (!expireStore.has(key)) return -1
    const ttl = expireStore.get(key)! - nowSeconds()
    return ttl < 0 ? -2 : ttl
  }

  const readJsonPath = (value: any, path: string) => {
    if (path === '$') return [clone(value)]
    if (!path.startsWith('$.')) return null

    const parts = path
      .slice(2)
      .split('.')
      .filter(Boolean)

    let current = value
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return [null]
      current = current[part]
    }

    return [clone(current)]
  }

  /**
   * Resolve `$.a.b` down to `{ parent, key }` so a path write lands on ONE field.
   *
   * SA-113 F-P3-2: this fake used to ignore the path entirely and replace the whole
   * record with the value — the third place it disagreed with the real client (after
   * `getMessages` head-vs-tail and `sRem` array flattening, both found in P3). Real
   * RedisJSON refuses a path write when the root key is missing, and returns nil
   * without writing when an intermediate segment does not resolve; both are copied
   * here, because a fake that quietly succeeds is worse than no test at all.
   */
  const resolveJsonWriteTarget = (root: any, path: string) => {
    if (!path.startsWith('$.')) return null
    const parts = path
      .slice(2)
      .split('.')
      .filter(Boolean)
    if (parts.length === 0) return null

    let current = root
    for (const part of parts.slice(0, -1)) {
      if (current == null || typeof current !== 'object') return null
      current = current[part]
    }
    if (current == null || typeof current !== 'object') return null
    return { parent: current, key: parts[parts.length - 1] }
  }

  const redisJsonMock = {
    get: vi.fn(async (key: string, options?: { path?: string }) => {
      const entry = redisStore.get(key)
      if (!entry) return null
      if (entry.type === 'json') {
        if (options?.path) return readJsonPath(entry.value, options.path)
        return clone(entry.value)
      }
      return null
    }),
    set: vi.fn(async (key: string, path: string, value: any) => {
      if (!path || path === '$') {
        redisStore.set(key, { type: 'json', value: clone(value) })
        return 'OK'
      }

      const entry = redisStore.get(key)
      if (!entry || entry.type !== 'json') {
        // Real RedisJSON: "ERR new objects must be created at the root".
        throw new Error(`ERR new objects must be created at the root (key ${key}, path ${path})`)
      }

      const target = resolveJsonWriteTarget(entry.value, path)
      if (!target) return null
      target.parent[target.key] = clone(value)
      return 'OK'
    }),
    numIncrBy: vi.fn(async (key: string, path: string, by: number) => {
      const entry = redisStore.get(key)
      if (!entry || entry.type !== 'json') {
        throw new Error(`ERR could not perform this operation on a key that doesn't exist (${key})`)
      }
      const target = resolveJsonWriteTarget(entry.value, path)
      if (!target) return null
      const current = target.parent[target.key]
      const next = (typeof current === 'number' ? current : 0) + by
      target.parent[target.key] = next
      return next
    }),
    del: vi.fn(async (key: string) => (redisStore.delete(key) ? 1 : 0))
  }

  const redisMock = {
    json: redisJsonMock,
    __resetTestStore: vi.fn(() => {
      redisStore.clear()
      expireStore.clear()
    }),
    createSession: vi.fn(async (session: any) => {
      if (!session?.id || !session?.user_id) {
        throw new Error('Session id and user_id are required')
      }

      const now = new Date().toISOString()
      const sessionData = {
        ...clone(session),
        created_at: session.created_at || now,
        last_modified_at: session.last_modified_at || now,
        archived: false,
        locked: Boolean(session.locked)
      }

      redisStore.set(`session:${session.id}`, { type: 'json', value: clone(sessionData) })
      await redisMock.sAdd(`user:${session.user_id}:sessions`, session.id)
      await redisMock.del(`messages:${session.id}`)

      return clone(sessionData)
    }),
    createAgent: vi.fn(async (agent: any) => {
      if (!agent?.id || !agent?.user_id) {
        throw new Error('Agent id and user_id are required')
      }

      const now = new Date().toISOString()
      const agentData = {
        ...clone(agent),
        created_at: agent.created_at || now,
        updated_at: now
      }

      redisStore.set(`agent:${agent.id}`, { type: 'json', value: clone(agentData) })
      await redisMock.sAdd(`user:${agent.user_id}:agents`, agent.id)

      return clone(agentData)
    }),
    updateAgent: vi.fn(async (id: string, updates: any) => {
      const existingEntry = redisStore.get(`agent:${id}`)
      if (!existingEntry || existingEntry.type !== 'json') {
        throw new Error('Agent not found')
      }

      const updated = {
        ...clone(existingEntry.value),
        ...clone(updates),
        updated_at: new Date().toISOString()
      }

      redisStore.set(`agent:${id}`, { type: 'json', value: clone(updated) })
    }),
    getAgents: vi.fn(async (userId: string) => {
      const agentIds = Array.from(ensureSet(`user:${userId}:agents`).values())
      const agents = agentIds
        .map((agentId) => {
          const entry = redisStore.get(`agent:${agentId}`)
          return entry?.type === 'json' ? clone(entry.value) : null
        })
        .filter(Boolean)

      return agents.sort((a: any, b: any) => {
        const dateA = new Date(a.created_at || 0).getTime()
        const dateB = new Date(b.created_at || 0).getTime()
        return dateB - dateA
      })
    }),
    getUserSettings: vi.fn(async (userId: string) => {
      const entry = redisStore.get(`user:${userId}:settings`)
      return entry?.type === 'json' ? clone(entry.value) : null
    }),
    updateUserSettings: vi.fn(async (userId: string, updates: any) => {
      const existing = (await redisMock.getUserSettings(userId)) ?? {
        id: `settings_${userId}`,
        user_id: userId
      }

      const merged = {
        ...existing,
        ...clone(updates)
      }

      redisStore.set(`user:${userId}:settings`, { type: 'json', value: clone(merged) })
      return clone(merged)
    }),
    saveMessage: vi.fn(async (message: any) => {
      if (!message?.session_id || !message?.id) return null
      const messageRecord = {
        ...clone(message),
        created_at: message.created_at || new Date().toISOString()
      }
      const key = `message:${message.session_id}:${message.id}`
      await redisJsonMock.set(key, '$', messageRecord)
      const existingMessages = await redisMock.lRange(`messages:${message.session_id}`, 0, -1)
      if (!existingMessages.includes(message.id)) {
        await redisMock.rPush(`messages:${message.session_id}`, message.id)
      }
      return messageRecord
    }),
    // SA-113 P1: the wake primitive resolves a "One at a time" target by listing the
    // agent's sessions, so the fake needs the same list-and-sort contract the real client
    // has (newest first by last_modified_at, archived hidden unless asked for).
    getSessions: vi.fn(async (userId: string, includeArchived = false) => {
      const sessionIds = Array.from(ensureSet(`user:${userId}:sessions`).values())
      const sessions = sessionIds
        .map((sessionId) => {
          const entry = redisStore.get(`session:${sessionId}`)
          return entry?.type === 'json' ? clone(entry.value) : null
        })
        .filter(Boolean)
        .filter((session: any) => includeArchived || !session.archived)

      return sessions.sort((a: any, b: any) => {
        const dateA = new Date(a.last_modified_at || a.created_at || 0).getTime()
        const dateB = new Date(b.last_modified_at || b.created_at || 0).getTime()
        return dateB - dateA
      })
    }),
    // SA-113 P1: the generic session PUT (which re-attaches a stored `metadata.origin`)
    // needs the real client's top-level merge, including the wholesale metadata replace
    // that the re-attach resolver exists to defend against.
    updateSession: vi.fn(async (id: string, updates: any) => {
      const entry = redisStore.get(`session:${id}`)
      if (!entry || entry.type !== 'json') {
        throw new Error('Session not found')
      }
      const updated = {
        ...clone(entry.value),
        ...clone(updates),
        last_modified_at: new Date().toISOString()
      }
      redisStore.set(`session:${id}`, { type: 'json', value: clone(updated) })
    }),
    getSession: vi.fn(async (sessionId: string) => {
      const entry = redisStore.get(`session:${sessionId}`)
      if (!entry || entry.type !== 'json') return null
      return clone(entry.value)
    }),
    // SA-113 P3 (F-P2-1): this fake used to return the LAST `limit` messages while the real
    // client returns the FIRST `limit` (`lRange(key, 0, limit - 1)`). That drift is exactly
    // what hid the chain-depth and presence bugs — under the fake both readers looked at
    // the right end of the chat, and in production they looked at the wrong one. The fake
    // now lies about nothing: `getMessages` is head-first, `getRecentMessages` is the tail.
    getMessages: vi.fn(async (sessionId: string, limit = 100) => {
      const messageIds = await redisMock.lRange(`messages:${sessionId}`, 0, limit - 1)
      const messages = await Promise.all(
        messageIds.map((messageId) => redisJsonMock.get(`message:${sessionId}:${messageId}`))
      )

      return messages.filter(Boolean)
    }),
    getRecentMessages: vi.fn(async (sessionId: string, limit = 100) => {
      if (!Number.isFinite(limit) || limit <= 0) return []
      const messageIds = await redisMock.lRange(`messages:${sessionId}`, -limit, -1)
      const messages = await Promise.all(
        messageIds.map((messageId) => redisJsonMock.get(`message:${sessionId}:${messageId}`))
      )

      return messages.filter(Boolean)
    }),
    deleteMessage: vi.fn(async (messageId: string, sessionId: string, userId: string) => {
      const session = await redisJsonMock.get(`session:${sessionId}`)
      if (!session) throw new Error('Session not found')
      if ((session as any).user_id !== userId) {
        throw new Error('Unauthorized: Session does not belong to user')
      }

      await redisMock.del(`message:${sessionId}:${messageId}`)
      await redisMock.lRem(`messages:${sessionId}`, 0, messageId)
      await redisMock.del(`session:${sessionId}:messages`)
    }),
    get: vi.fn(async (key: string) => {
      const entry = redisStore.get(key)
      if (!entry) return null
      if (entry.type === 'string' || entry.type === 'number') {
        return entry.type === 'number' ? String(entry.value) : entry.value
      }
      if (entry.type === 'json') {
        return clone(entry.value)
      }
      if (entry.type === 'list') {
        return clone(entry.value)
      }
      return entry.value
    }),
    set: vi.fn(async (key: string, value: any) => {
      const type = typeof value === 'string' ? 'string' : typeof value === 'number' ? 'number' : 'json'
      redisStore.set(key, { type, value: type === 'json' ? clone(value) : value })
      return 'OK'
    }),
    del: vi.fn(async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key]
      let removed = 0
      for (const currentKey of keys) {
        if (redisStore.delete(currentKey)) removed++
      }
      return removed
    }),
    exists: vi.fn(async (key: string) => redisStore.has(key)),
    incr: vi.fn(async (key: string) => {
      const current = Number(redisStore.get(key)?.value ?? 0)
      const next = current + 1
      redisStore.set(key, { type: 'number', value: next })
      return next
    }),
    ttl: vi.fn(async (key: string) => getTtl(key)),
    expire: vi.fn(async (key: string, seconds: number) => setExpiryValue(key, seconds)),
    persist: vi.fn(async (key: string) => clearExpiryValue(key)),
    keys: vi.fn(async (pattern: string) => {
      const regex = resolveMatch(pattern)
      return Array.from(redisStore.keys()).filter((key) => regex.test(key))
    }),
    lpush: vi.fn(async (key: string, value: any) => {
      const list = ensureList(key)
      list.unshift(value)
      return list.length
    }),
    rPush: vi.fn(async (key: string, value: any) => {
      const list = ensureList(key)
      list.push(value)
      return list.length
    }),
    rpush: vi.fn(async (key: string, value: any) => redisMock.rPush(key, value)),
    ltrim: vi.fn(async (key: string, start: number, stop: number) => {
      const list = ensureList(key)
      const trimmed = list.slice(start, stop + 1)
      redisStore.set(key, { type: 'list', value: trimmed })
      return 'OK'
    }),
    lRem: vi.fn(async (key: string, _count: number, value: any) => {
      const list = ensureList(key)
      const filtered = list.filter((entry) => entry !== value)
      redisStore.set(key, { type: 'list', value: filtered })
      return list.length - filtered.length
    }),
    lrange: vi.fn(async (key: string, start: number, stop: number) => {
      const list = ensureList(key)
      const end = stop === -1 ? list.length : stop + 1
      return clone(list.slice(start, end))
    }),
    lRange: vi.fn(async (key: string, start: number, stop: number) => redisMock.lrange(key, start, stop)),
    sAdd: vi.fn(async (key: string, ...members: any[]) => {
      const set = ensureSet(key)
      const flattened = members.length === 1 && Array.isArray(members[0]) ? members[0] : members
      flattened.forEach((m: any) => set.add(m))
      return set.size
    }),
    sMembers: vi.fn(async (key: string) => Array.from(ensureSet(key).values())),
    zAdd: vi.fn(async (key: string, entries: any) => {
      const zset = ensureZset(key)
      const list = Array.isArray(entries) ? entries : [entries]
      let added = 0
      for (const entry of list) {
        if (!zset.has(String(entry.value))) added += 1
        zset.set(String(entry.value), Number(entry.score))
      }
      return added
    }),
    zRange: vi.fn(async (key: string, start: number, stop: number) => {
      const ordered = zsetMembersAscending(key)
      const end = stop === -1 ? ordered.length : stop + 1
      return ordered.slice(start, end)
    }),
    zRem: vi.fn(async (key: string, members: any) => {
      const zset = ensureZset(key)
      const list = Array.isArray(members) ? members : [members]
      let removed = 0
      for (const member of list) {
        if (zset.delete(String(member))) removed += 1
      }
      return removed
    }),
    zRangeWithScores: vi.fn(async (key: string, start: number, stop: number) => {
      const zset = ensureZset(key)
      const ordered = zsetMembersAscending(key)
      const end = stop === -1 ? ordered.length : stop + 1
      return ordered
        .slice(start, end)
        .map((member) => ({ value: member, score: zset.get(member) ?? 0 }))
    }),
    zCard: vi.fn(async (key: string) => ensureZset(key).size),
    sRem: vi.fn(async (key: string, ...members: any[]) => {
      const set = ensureSet(key)
      // node-redis accepts `sRem(key, ['a','b'])` as well as `sRem(key, 'a', 'b')`, and
      // `sAdd` above already flattens. Without the same flattening here, a caller passing
      // an array removed NOTHING under test while working correctly against real Redis.
      const flattened = members.length === 1 && Array.isArray(members[0]) ? members[0] : members
      let removed = 0
      flattened.forEach((m: any) => {
        if (set.delete(m)) removed++
      })
      return removed
    }),
    type: vi.fn(async (key: string) => {
      const entry = redisStore.get(key)
      if (!entry) return 'none'
      if (entry.type === 'json') return 'ReJSON-RL'
      if (entry.type === 'list') return 'list'
      if (entry.type === 'set') return 'set'
      if (entry.type === 'zset') return 'zset'
      return 'string'
    }),
    execute: vi.fn(async (operation: (client: any) => Promise<any>) => {
      if (typeof operation !== 'function') return undefined

      const createMulti = () => {
        const queue: Array<() => Promise<any>> = []

        const multiApi = {
          incr: (key: string) => {
            queue.push(() => redisMock.incr(key))
            return multiApi
          },
          expire: (key: string, seconds: number) => {
            queue.push(() => redisMock.expire(key, seconds))
            return multiApi
          },
          set: (key: string, value: any) => {
            queue.push(() => redisMock.set(key, value))
            return multiApi
          },
          del: (key: string) => {
            queue.push(() => redisMock.del(key))
            return multiApi
          },
          json: {
            set: (key: string, path: string, value: any) => {
              queue.push(() => redisJsonMock.set(key, path, value))
              return multiApi
            },
            numIncrBy: (key: string, path: string, by: number) => {
              queue.push(() => redisJsonMock.numIncrBy(key, path, by))
              return multiApi
            }
          },
          exec: vi.fn(async () => {
            const results = []
            for (const task of queue) {
              results.push(await task())
            }
            return results
          }),
          discard: vi.fn(() => {
            queue.length = 0
            return 'OK'
          })
        }

        return multiApi
      }

      const client = {
        expire: vi.fn(async (key: string, seconds: number) => redisMock.expire(key, seconds)),
        persist: vi.fn(async (key: string) => (clearExpiryValue(key) ? 1 : 0)),
        exists: vi.fn(async (key: string) => (redisStore.has(key) ? 1 : 0)),
        ttl: vi.fn(async (key: string) => redisMock.ttl(key)),
        type: vi.fn(async (key: string) => redisMock.type(key)),
        set: vi.fn(async (key: string, value: any) => redisMock.set(key, value)),
        get: vi.fn(async (key: string) => {
          const entry = redisStore.get(key)
          if (entry?.type === 'json') {
            throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value')
          }
          return redisMock.get(key)
        }),
        del: vi.fn(async (key: string) => redisMock.del(key)),
        keys: vi.fn(async (pattern: string) => redisMock.keys(pattern)),
        lRange: vi.fn(async (key: string, start: number, stop: number) =>
          redisMock.lRange(key, start, stop)
        ),
        rPush: vi.fn(async (key: string, value: any) => redisMock.rPush(key, value)),
        sAdd: vi.fn(async (key: string, ...members: any[]) => redisMock.sAdd(key, ...members)),
        sMembers: vi.fn(async (key: string) => redisMock.sMembers(key)),
        sRem: vi.fn(async (key: string, ...members: any[]) => redisMock.sRem(key, ...members)),
        zAdd: vi.fn(async (key: string, entries: any) => redisMock.zAdd(key, entries)),
        zRange: vi.fn(async (key: string, start: number, stop: number) =>
          redisMock.zRange(key, start, stop)
        ),
        zRem: vi.fn(async (key: string, members: any) => redisMock.zRem(key, members)),
        zRangeWithScores: vi.fn(async (key: string, start: number, stop: number) =>
          redisMock.zRangeWithScores(key, start, stop)
        ),
        zCard: vi.fn(async (key: string) => redisMock.zCard(key)),
        json: redisJsonMock,
        multi: vi.fn(() => createMulti())
      }

      return operation(client)
    })
  }

  redisMockInstance = redisMock

  return {
    redis: redisMock,
    default: redisMock
  }
})

const isStepCountMock = vi.fn((count: number) => ({ type: 'step-count', count }))

// Mirrors the AI SDK 7 surface Batshit imports (SA-098). `stepCountIs` is kept
// as the SDK's own deprecated alias of `isStepCount`.
const aiModuleMock = {
  streamText: vi.fn(),
  generateText: vi.fn(),
  convertToModelMessages: vi.fn(async (messages: any) => messages),
  tool: vi.fn((config: any) => config),
  dynamicTool: vi.fn((config: any) => config),
  isStepCount: isStepCountMock,
  stepCountIs: isStepCountMock,
  extractReasoningMiddleware: vi.fn((config: any) => ({
    type: 'extract-reasoning-middleware',
    ...config
  })),
  wrapLanguageModel: vi.fn(({ model, middleware }: any) => ({
    type: 'wrapped-language-model',
    model,
    middleware
  })),
  createGateway: vi.fn(() => (modelId: string) => ({ modelId })),
  jsonSchema: vi.fn((schema: any) => schema),
  asSchema: vi.fn((schema: any) => ({ jsonSchema: schema })),
  generateImage: vi.fn(),
  generateSpeech: vi.fn(),
  transcribe: vi.fn(),
  InvalidToolInputError: class InvalidToolInputError extends Error {
    static isInstance(error: unknown): boolean {
      return error instanceof this
    }
  },
  NoSuchToolError: class NoSuchToolError extends Error {
    static isInstance(error: unknown): boolean {
      return error instanceof this
    }
  },
  Output: {
    object: vi.fn((config: any) => ({ ...config, type: 'output.object' }))
  },
  z: {
    object: vi.fn(() => ({}))
  }
}

vi.mock('ai', () => aiModuleMock)

export const testProviders = {
  anthropicFactory,
  openaiFactory,
  googleFactory,
  groqFactory,
  mistralFactory,
  openRouterFactory
}

export const testRedis = redisMockInstance
export const testAI = aiModuleMock
