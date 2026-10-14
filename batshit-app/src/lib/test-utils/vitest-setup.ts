import { afterEach, vi } from 'vitest'
// Extend expect with DOM matchers (toBeInTheDocument, toBeDisabled, etc.)
import '@testing-library/jest-dom/vitest'
import { waitForDelayedBodyScrollCleanup } from './delayedBodyScrollCleanup'
import {
  collectTrustedClipIdsFromMetadata,
  neutralizeAllZipReferenceSyntax,
  neutralizeUntrustedClipReferenceSyntax
} from '$lib/utils/zipReferenceSafety'
// BL-4: the fake's message-list readers skip a waiting send's message exactly as the real ones
// do (the same leaf, the same positional filter), so no suite on this lane can pass on a fake
// that shows it.
import { filterQueuedSendMessageIds } from '$lib/server/services/queuedSendHiddenIds'
import { unclaimedZipsMadeByMessage, zipClaimsOfMessage, zipsOwnedOnlyByMessage } from '$lib/utils/messageDeletionZips'
import { withZipStateLock } from '$lib/server/services/zipStateLock'
import { MessageStillRunningError } from '$lib/server/messageStillRunningError'
import { assertBrowserMessageMutation, preserveServerSteerMetadata, type BrowserMessageMutationPolicy } from '$lib/server/browserMessageMutation'

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
    // RedisJSON indexed projections preserve missing-field holes by path, not by
    // compacting several wildcard result arrays and pairing unrelated records.
    const indexed = /^\$\[(\d+)\]\.(.+)$/.exec(path)
    if (indexed) {
      let current = value?.[Number(indexed[1])]
      for (const part of indexed[2].split('.')) {
        if (current == null || typeof current !== 'object' || !(part in current)) return []
        current = current[part]
      }
      return [clone(current)]
    }
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

  // BL-1371: the facade's raw compare-and-set (`getRaw`, `setIfUnchanged`, `delIfUnchanged`).
  // Their own bounded paths (`$` and `$.<field>[<n>]` only); `readJsonPath` and
  // `resolveJsonWriteTarget` above stay as they are for every other operation.
  const { createJsonCompareAndWriteTwins } = await import('$lib/test-utils/redisJsonCompareAndWriteTwin')
  const jsonCompareAndWrite = createJsonCompareAndWriteTwins({
    read: (key) => {
      const entry = redisStore.get(key)
      if (!entry) return undefined
      if (entry.type !== 'json') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value')
      return entry.value
    },
    write: (key, document) => {
      redisStore.set(key, { type: 'json', value: clone(document) })
    },
    remove: (key) => {
      redisStore.delete(key)
      expireStore.delete(key)
    }
  })

  // BL-1397: the n8n Instance token's two guarded writes over the same documents (bounded paths).
  const { createN8nCredentialScriptTwins } = await import('$lib/test-utils/n8nCredentialScriptsTwin')
  const n8nCredentialScripts = createN8nCredentialScriptTwins({
    read: (key) => {
      const entry = redisStore.get(key)
      if (!entry) return undefined
      if (entry.type !== 'json') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value')
      return entry.value
    },
    write: (key, document) => {
      redisStore.set(key, { type: 'json', value: clone(document) })
    },
    remove: (key) => {
      redisStore.delete(key)
      expireStore.delete(key)
    }
  })

  const redisJsonMock = {
    get: vi.fn(async (key: string, options?: { path?: string | string[] }) => {
      const entry = redisStore.get(key)
      if (!entry) return null
      if (entry.type === 'json') {
        if (Array.isArray(options?.path)) {
          return Object.fromEntries(options.path.map(path => [path, readJsonPath(entry.value, path)]))
        }
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
    // BL-753: `JSON.SET … XX`, the real one's twin: nothing is written when the key is gone.
    setIfExists: vi.fn(async (key: string, path: string, value: any) => {
      const entry = redisStore.get(key)
      if (!entry || entry.type !== 'json') return false
      if (!path || path === '$') {
        redisStore.set(key, { type: 'json', value: clone(value) })
        return true
      }
      const target = resolveJsonWriteTarget(entry.value, path)
      if (!target || !(target.key in target.parent)) return false
      target.parent[target.key] = clone(value)
      return true
    }),
    // BL-516: `JSON.SET … NX`, the real one's twin: nothing is written when the key (or path) exists.
    setIfAbsent: vi.fn(async (key: string, path: string, value: any) => {
      const entry = redisStore.get(key)
      if (!path || path === '$') {
        if (entry) return false
        redisStore.set(key, { type: 'json', value: clone(value) })
        return true
      }
      if (!entry || entry.type !== 'json') return false
      const target = resolveJsonWriteTarget(entry.value, path)
      if (!target || target.key in target.parent) return false
      target.parent[target.key] = clone(value)
      return true
    }),
    getRaw: vi.fn(jsonCompareAndWrite.getRaw),
    setIfUnchanged: vi.fn(jsonCompareAndWrite.setIfUnchanged),
    delIfUnchanged: vi.fn(jsonCompareAndWrite.delIfUnchanged),
    moveLegacyN8nToken: vi.fn(n8nCredentialScripts.moveLegacyN8nToken),
    deleteN8nToken: vi.fn(n8nCredentialScripts.deleteN8nToken),
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
    // BL-768: the real one runs `planAgentRecordUpdate`'s by-path writes in a Lua script. This twin
    // builds the SAME script arguments (`agentUpdateScriptArguments`) and applies them by their
    // path strings, read as RedisJSON reads them (`test-utils/agentUpdateScriptTwin.ts`, review
    // item 3). Same order as the real one: a refused save throws before anything (a 400), a gone
    // agent throws "Agent not found" and is not recreated, a key of another type throws RedisJSON's
    // wrong-type error.
    // BL-1294: a save of the memory settings (`options.expectedMemory`) is compared with the stored
    // ones first, by the real `agentMemoryBaseMatches`, and its guard goes to the twin.
    updateAgent: vi.fn(async (id: string, updates: any, options?: { expectedMemory?: Record<string, unknown> }) => {
      const {
        AGENT_MEMORY_SOURCE_PATHS,
        AgentMemorySettingsConflictError,
        agentMemoryBaseMatches,
        planAgentRecordUpdate,
        agentUpdateScriptArguments
      } = await import('$lib/server/agentRecordUpdate')
      const { REDISJSON_WRONG_TYPE_MESSAGE, agentTypeSnapshotOf, runAgentUpdateScriptTwin } = await import(
        '$lib/test-utils/agentUpdateScriptTwin'
      )
      const plan = planAgentRecordUpdate({ updates: clone(updates ?? {}), now: new Date().toISOString() })
      const existingEntry = redisStore.get(`agent:${id}`)
      if (!existingEntry) throw new Error('Agent not found')
      if (existingEntry.type !== 'json') throw new Error(REDISJSON_WRONG_TYPE_MESSAGE)
      const guardsMemory = options?.expectedMemory !== undefined
      if (guardsMemory && !agentMemoryBaseMatches(existingEntry.value, options!.expectedMemory)) {
        throw new AgentMemorySettingsConflictError()
      }
      const { answer, record } = runAgentUpdateScriptTwin(
        existingEntry.value,
        agentUpdateScriptArguments(
          plan,
          agentTypeSnapshotOf(existingEntry.value),
          guardsMemory ? agentTypeSnapshotOf(existingEntry.value, AGENT_MEMORY_SOURCE_PATHS) : null
        )
      )
      // One step here, so the type fields cannot change between the read and the script.
      if (answer !== 'OK') throw new Error(`The update of agent ${id} answered ${answer}.`)
      redisStore.set(`agent:${id}`, { type: 'json', value: record })
    }),
    // BL-914: the Subagent's twin of the above. The real one plans `planSubagentRecordUpdate`'s
    // by-path writes and runs them in `UPDATE_SUBAGENT_FIELDS_SCRIPT`; this twin makes the SAME
    // script argument and applies it by its path strings. A refused save throws before anything
    // (a 400), a gone Subagent answers `false` and is not recreated, a key of another type throws
    // RedisJSON's wrong-type error.
    updateSubagent: vi.fn(async (id: string, writes: any) => {
      const { serializeAgentRecordPlan } = await import('$lib/server/agentRecordUpdate')
      const { planSubagentRecordUpdate } = await import('$lib/server/subagentRecordUpdate')
      const { REDISJSON_WRONG_TYPE_MESSAGE, runSubagentUpdateScriptTwin } = await import(
        '$lib/test-utils/agentUpdateScriptTwin'
      )
      const plan = planSubagentRecordUpdate({ writes: clone(writes ?? {}), now: new Date().toISOString() })
      const existingEntry = redisStore.get(`subagent:${id}`)
      if (!existingEntry) return false
      if (existingEntry.type !== 'json') throw new Error(REDISJSON_WRONG_TYPE_MESSAGE)
      const { record } = runSubagentUpdateScriptTwin(existingEntry.value, [serializeAgentRecordPlan(plan.ops)])
      redisStore.set(`subagent:${id}`, { type: 'json', value: record })
      return true
    }),
    // BL-770: twins of the `/fix` route's two helpers (the real ones read TYPE, and replace a string
    // record only while it is still the same string, in one Lua step).
    readAgentRecordStorage: vi.fn(async (id: string) => {
      const entry = redisStore.get(`agent:${id}`)
      if (!entry) return { type: 'none' }
      if (entry.type === 'json') return { type: 'json', record: clone(entry.value) }
      if (entry.type === 'string') return { type: 'string', raw: entry.value }
      return { type: 'other' }
    }),
    replaceStringAgentRecord: vi.fn(async (id: string, raw: string, record: any) => {
      const entry = redisStore.get(`agent:${id}`)
      if (!entry || entry.type !== 'string' || entry.value !== raw) return false
      redisStore.set(`agent:${id}`, { type: 'json', value: clone(record) })
      return true
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
    saveMessage: vi.fn(async (message: any, options: { browserMutation?: BrowserMessageMutationPolicy } = {}) => {
      if (!message?.session_id || !message?.id) return null
      const messageRecord = {
        ...clone(message),
        created_at: message.created_at || new Date().toISOString()
      }
      const key = `message:${message.session_id}:${message.id}`
      if (options.browserMutation) {
        const current = redisStore.get(key)?.value
        assertBrowserMessageMutation(options.browserMutation, redisStore.get(`session:${message.session_id}`)?.value, current, messageRecord)
        messageRecord.metadata = preserveServerSteerMetadata({ ...current?.metadata, ...messageRecord.metadata }, current?.metadata)
        if (current?.created_at) messageRecord.created_at = current.created_at
        // No await between the current identity/markers read and the fake's atomic write.
        redisStore.set(key, { type: 'json', value: clone(messageRecord) })
      } else {
        await redisJsonMock.set(key, '$', messageRecord)
      }
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
    // BL-734: the real one is a Lua script; this twin keeps its contract: only the named top-level
    // fields are written (`undefined` skipped, `null` kept, a `metadata` replaces that one block),
    // then the stamp; a chat that is gone throws and is not recreated.
    updateSession: vi.fn(async (id: string, updates: Record<string, unknown>) => {
      const entry = redisStore.get(`session:${id}`)
      for (const name of Object.keys(updates)) {
        if (!/^[a-z_]+$/.test(name)) throw new Error(`Not a chat field name: ${name}`)
      }
      if (!entry || entry.type !== 'json') {
        throw new Error('Session not found')
      }
      const session = clone(entry.value)
      for (const [name, value] of Object.entries(updates)) {
        if (value !== undefined) session[name] = clone(value)
      }
      session.last_modified_at = new Date().toISOString()
      redisStore.set(`session:${id}`, { type: 'json', value: clone(session) })
    }),
    // BL-690: the real one is a Lua script; this twin keeps its contract: only the named fields
    // and the group are written, every other field and metadata block stays.
    updateSessionFields: vi.fn(
      async (id: string, fields: Record<string, unknown>, groupChat: Record<string, unknown> | null | undefined) => {
        const entry = redisStore.get(`session:${id}`)
        if (!entry || entry.type !== 'json') return false
        const session = clone(entry.value)
        for (const [name, value] of Object.entries(fields)) session[name] = clone(value ?? null)
        if (groupChat !== undefined) {
          const metadata =
            session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
              ? session.metadata
              : {}
          if (groupChat === null) delete metadata.group_chat
          else metadata.group_chat = clone(groupChat)
          session.metadata = metadata
        }
        session.last_modified_at = new Date().toISOString()
        redisStore.set(`session:${id}`, { type: 'json', value: clone(session) })
        return true
      }
    ),
    // BL-723: the real one is a Lua script; this twin keeps its contract: only the mark is
    // written, the segment id joins the stored list (the last 100 kept), every other block stays.
    // BL-737: a compare-and-set on `expectedLastGraduatedMessageId` (the id this graduation read
    // as its starting mark, `null` for "read none") against the mark's CURRENT stored id — not an
    // ordering check on any timestamp. A mismatch answers `superseded` and writes nothing.
    writeRegularGraduationMark: vi.fn(
      async (
        id: string,
        mark: {
          lastGraduatedMessageId: string
          lastGraduatedAt: string
          segmentId: string
        },
        expectedLastGraduatedMessageId: string | null
      ) => {
        const entry = redisStore.get(`session:${id}`)
        if (!entry || entry.type !== 'json') return 'missing'
        const session = clone(entry.value)
        const metadata =
          session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
            ? session.metadata
            : {}
        const stored = metadata.memoryGraduation
        const hasMark = Boolean(stored) && typeof stored === 'object' && !Array.isArray(stored)
        // BL-737 review: an empty-string stored id is "no mark" too, the same sentinel as null.
        const storedId =
          hasMark && typeof stored.lastGraduatedMessageId === 'string' && stored.lastGraduatedMessageId !== ''
            ? stored.lastGraduatedMessageId
            : null
        if (storedId !== expectedLastGraduatedMessageId) {
          // BL-737 review: the winner already reused THIS call's own segment id — its
          // segmentIds already lists it — so the caller must not delete it.
          const storedSegmentIds =
            hasMark && Array.isArray(stored.segmentIds) ? stored.segmentIds : []
          if (storedSegmentIds.includes(mark.segmentId)) {
            return 'superseded_linked'
          }
          return 'superseded'
        }
        if (!hasMark) {
          metadata.memoryGraduation = {
            version: 1,
            lastGraduatedMessageId: mark.lastGraduatedMessageId,
            lastGraduatedAt: mark.lastGraduatedAt,
            segmentIds: [mark.segmentId]
          }
        } else {
          stored.version = 1
          stored.lastGraduatedMessageId = mark.lastGraduatedMessageId
          stored.lastGraduatedAt = mark.lastGraduatedAt
          stored.segmentIds = Array.isArray(stored.segmentIds)
            ? [...stored.segmentIds, mark.segmentId].slice(-100)
            : [mark.segmentId]
        }
        session.metadata = metadata
        session.last_modified_at = new Date().toISOString()
        redisStore.set(`session:${id}`, { type: 'json', value: clone(session) })
        return 'ok'
      }
    ),
    // BL-736: the real one is a Lua script; this twin keeps its contract: the removal happens
    // only while the chat's LIVE `metadata.group_chat.group_id` still names this Group.
    clearGroupChatIfMatches: vi.fn(async (id: string, groupId: string) => {
      const entry = redisStore.get(`session:${id}`)
      if (!entry || entry.type !== 'json') return false
      const session = clone(entry.value)
      const metadata =
        session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
          ? session.metadata
          : {}
      if (!metadata.group_chat || metadata.group_chat.group_id !== groupId) return false
      delete metadata.group_chat
      session.metadata = metadata
      session.last_modified_at = new Date().toISOString()
      redisStore.set(`session:${id}`, { type: 'json', value: clone(session) })
      return true
    }),
    // BL-474 step 2: the real one is a Lua script; this twin keeps its contract: the chat and its
    // owner, a decided record only for this chat's own assistant reply, never over a newer version,
    // and a pending write never over a decided record of the same version.
    writeImageOriginRecord: vi.fn(
      async (input: {
        userId: string
        sessionId: string
        messageId: string
        version: number
        state: 'pending' | 'decided'
        record: Record<string, unknown>
      }) => {
        if (
          !input.record ||
          typeof input.record !== 'object' ||
          Array.isArray(input.record) ||
          input.record.messageId !== input.messageId ||
          input.record.state !== input.state ||
          input.record.version !== input.version
        ) {
          throw new Error('Image origin record does not match write arguments.')
        }
        const session = redisStore.get(`session:${input.sessionId}`)
        if (!session) return 'missing_chat'
        if (session.type !== 'json' || session.value?.user_id !== input.userId) return 'not_owner'
        if (input.state === 'decided') {
          const reply = redisStore.get(`message:${input.sessionId}:${input.messageId}`)
          if (!reply) return 'missing_reply'
          const value = reply.type === 'json' ? reply.value : null
          if (
            value?.role !== 'assistant' ||
            value?.session_id !== input.sessionId ||
            value?.id !== input.messageId ||
            value?.user_id !== input.userId
          ) return 'not_reply'
        }
        const itemKey = `image_origin:${input.sessionId}:${input.messageId}`
        const previous = redisStore.get(itemKey)
        if (previous && previous.type !== 'json') throw new Error('Image origin record has the wrong type')
        const stored = previous?.value
        if (typeof stored?.version === 'number') {
          if (stored.version > input.version) return 'older'
          if (stored.version === input.version && input.state === 'pending' && stored.state === 'decided') return 'kept'
        }
        redisStore.set(itemKey, { type: 'json', value: clone(input.record) })
        await redisMock.sAdd(`image_origins:${input.sessionId}`, input.messageId)
        return 'ok'
      }
    ),
    // BL-735: the real one is a Lua script; this twin keeps its contract: only `metadata.fixedSession`
    // and `locked` are written, every other field and metadata block stays.
    writeFixedSessionMark: vi.fn(async (id: string, fixedSession: Record<string, unknown>) => {
      const entry = redisStore.get(`session:${id}`)
      if (!entry || entry.type !== 'json') return false
      const session = clone(entry.value)
      const metadata =
        session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
          ? session.metadata
          : {}
      metadata.fixedSession = clone(fixedSession)
      session.metadata = metadata
      session.locked = true
      session.last_modified_at = new Date().toISOString()
      redisStore.set(`session:${id}`, { type: 'json', value: clone(session) })
      return true
    }),
    // BL-622: the real one is a Lua script (one step inside Redis); this twin keeps its contract:
    // refuse unless the last countable Compact event is the one read, then add the event at its
    // own path and leave every other metadata field as it is stored now.
    appendContextCompactionEvent: vi.fn(
      async (id: string, event: Record<string, unknown>, expectedLastEventId: string | null) => {
        const entry = redisStore.get(`session:${id}`)
        if (!entry || entry.type !== 'json') return { ok: false, reason: 'missing' }
        const session = clone(entry.value)
        const metadata =
          session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
            ? session.metadata
            : {}
        const block = metadata.contextCompaction
        const events: any[] | null = Array.isArray(block?.events) ? block.events : null
        const counted = (events ?? []).filter(
          (candidate: any) =>
            candidate &&
            typeof candidate === 'object' &&
            typeof candidate.id === 'string' &&
            typeof candidate.createdAt === 'string' &&
            typeof candidate.summary === 'string' &&
            Array.isArray(candidate.sourceMessageIds)
        )
        const lastEventId = counted.length > 0 ? counted[counted.length - 1].id : ''
        if (lastEventId !== (expectedLastEventId ?? '')) {
          return { ok: false, reason: 'changed', lastEventId: lastEventId || null }
        }
        metadata.contextCompaction = events
          ? { ...block, events: [...events, clone(event)] }
          : { version: 1, events: [clone(event)] }
        session.metadata = metadata
        session.last_modified_at = new Date().toISOString()
        redisStore.set(`session:${id}`, { type: 'json', value: clone(session) })
        return { ok: true, contextCompaction: clone(metadata.contextCompaction) }
      }
    ),
    // BL-549 (N4): the real ones are Lua scripts; these twins keep their contracts: only the
    // named list in `metadata.fixedSession` changes, as stored now; every other block stays.
    appendFixedSessionGraduationEvent: vi.fn(async (id: string, event: Record<string, unknown>) => {
      const entry = redisStore.get(`session:${id}`)
      if (!entry || entry.type !== 'json') return 'missing'
      const session = clone(entry.value)
      if (session.metadata?.fixedSession?.enabled !== true) return 'not_fixed'
      const fixed = session.metadata.fixedSession
      if (Array.isArray(fixed.graduation?.events)) fixed.graduation.events.push(clone(event))
      else fixed.graduation = { version: 1, events: [clone(event)] }
      session.last_modified_at = new Date().toISOString()
      redisStore.set(`session:${id}`, { type: 'json', value: clone(session) })
      return 'ok'
    }),
    swapFixedSessionGraduationEvents: vi.fn(
      async (id: string, removeEventIds: string[], eraEvent: Record<string, unknown>) => {
        if (removeEventIds.length === 0) {
          throw new Error('swapFixedSessionGraduationEvents requires at least one event id to replace.')
        }
        const entry = redisStore.get(`session:${id}`)
        if (!entry || entry.type !== 'json') return { ok: false, reason: 'missing' }
        const session = clone(entry.value)
        if (session.metadata?.fixedSession?.enabled !== true) return { ok: false, reason: 'not_fixed' }
        const fixed = session.metadata.fixedSession
        const events: any[] = Array.isArray(fixed.graduation?.events) ? fixed.graduation.events : []
        const present = new Set(
          events.filter((event) => event && typeof event.id === 'string').map((event) => event.id)
        )
        const missing = removeEventIds.filter((eventId) => !present.has(eventId))
        if (missing.length > 0) return { ok: false, reason: 'changed', missing }
        const remove = new Set(removeEventIds)
        const firstIndex = events.findIndex((event) => event && remove.has(event.id))
        const kept = events.filter((event) => !(event && remove.has(event.id)))
        kept.splice(firstIndex, 0, clone(eraEvent))
        fixed.graduation.events = kept
        session.last_modified_at = new Date().toISOString()
        redisStore.set(`session:${id}`, { type: 'json', value: clone(session) })
        return { ok: true }
      }
    ),
    appendFixedSessionNapRecord: vi.fn(
      async (id: string, record: Record<string, unknown>, limit = 20) => {
        const entry = redisStore.get(`session:${id}`)
        if (!entry || entry.type !== 'json') return null
        const session = clone(entry.value)
        const metadata =
          session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
            ? session.metadata
            : {}
        const fixed =
          metadata.fixedSession && typeof metadata.fixedSession === 'object' && !Array.isArray(metadata.fixedSession)
            ? metadata.fixedSession
            : {}
        fixed.naps = (Array.isArray(fixed.naps) ? [...fixed.naps, clone(record)] : [clone(record)]).slice(-limit)
        metadata.fixedSession = fixed
        session.metadata = metadata
        session.last_modified_at = new Date().toISOString()
        redisStore.set(`session:${id}`, { type: 'json', value: clone(session) })
        return clone(metadata)
      }
    ),
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
      const messageIds = filterQueuedSendMessageIds(
        sessionId,
        await redisMock.lRange(`messages:${sessionId}`, 0, limit - 1)
      )
      const messages = await Promise.all(
        messageIds.map((messageId) => redisJsonMock.get(`message:${sessionId}:${messageId}`))
      )

      return messages.filter(Boolean)
    }),
    getRecentMessages: vi.fn(async (sessionId: string, limit = 100) => {
      if (!Number.isFinite(limit) || limit <= 0) return []
      const messageIds = filterQueuedSendMessageIds(
        sessionId,
        await redisMock.lRange(`messages:${sessionId}`, -limit, -1)
      )
      const messages = await Promise.all(
        messageIds.map((messageId) => redisJsonMock.get(`message:${sessionId}:${messageId}`))
      )

      return messages.filter(Boolean)
    }),
    getAllMessages: vi.fn(async (sessionId: string) => {
      const messageIds = filterQueuedSendMessageIds(
        sessionId,
        await redisMock.lRange(`messages:${sessionId}`, 0, -1)
      )
      const messages = await Promise.all(
        messageIds.map((messageId) => redisJsonMock.get(`message:${sessionId}:${messageId}`))
      )
      return messages.filter(Boolean)
    }),
    // BL-4: the real `moveMessageToEnd` — the list move, and `created_at` set to now (or to
    // the time a resent message's tab sent it). BL-195: the real one is one Lua script, so
    // this one never awaits between its check and its writes: nothing can land in between.
    moveMessageToEnd: vi.fn(
      async (sessionId: string, messageId: string, options: { createdAt?: string | null } = {}) => {
      if (!sessionId || !messageId) return null
      const messageKey = `message:${sessionId}:${messageId}`
      const entry = redisStore.get(messageKey)
      if (!redisStore.has(`session:${sessionId}`) || !entry) return null
      if (entry.type !== 'json') throw new Error(`WRONGTYPE ${messageKey} is not a JSON record`)
      const createdAt = options.createdAt ?? new Date().toISOString()
      if (entry.value && typeof entry.value === 'object') entry.value.created_at = createdAt
      const list = ensureList(`messages:${sessionId}`)
      const kept = list.filter((id) => id !== messageId)
      list.splice(0, list.length, ...kept, messageId)
      return clone(entry.value)
      }
    ),
    getSessionMessages: vi.fn(async (sessionId: string) =>
      redisMock.getRecentMessages(sessionId, 1000)
    ),
    getAllSessionMessages: vi.fn(async (sessionId: string) =>
      redisMock.getAllMessages(sessionId)
    ),
    // SA-129 P2: the real `getZip` reads the JSON record at `zip:{id}` with the exact id.
    getZip: vi.fn(async (zipId: string) => redisJsonMock.get(`zip:${zipId}`)),
    /**
     * SA-116 P3: the fake had NO `updateMessage`, so every caller of it threw
     * "is not a function" — and a caller that (correctly) catches its own persistence
     * failures then looked like it had written nothing wrong. That is the fourth
     * fake-vs-client gap in this family, after `getMessages` head-vs-tail, `sRem` array
     * flattening, and `json.set` ignoring its path.
     *
     * Faithful to the real client, including the two properties that matter to callers:
     * the ownership checks throw, and `metadata` is REPLACED by the update rather than
     * merged into (which is why `settleControlApprovalCard` reads before it writes).
     */
    updateMessage: vi.fn(async (
      messageId: string,
      sessionId: string,
      updates: Record<string, any>,
      userId: string,
      options: { browserMutation?: BrowserMessageMutationPolicy } = {}
    ) => {
      const session = await redisJsonMock.get(`session:${sessionId}`)
      if (!session) throw new Error('Session not found')
      if ((session as any).user_id !== userId) {
        throw new Error('Unauthorized: Session does not belong to user')
      }

      const key = `message:${sessionId}:${messageId}`
      const existing = await redisJsonMock.get(key)
      if (!existing) throw new Error('Message not found')

      const updated: Record<string, any> = {
        ...(existing as any),
        ...clone(updates),
        updated_at: new Date().toISOString()
      }
      if (updated.role === 'user' && typeof updated.content === 'string') {
        const trustedClipIds = new Set(collectTrustedClipIdsFromMetadata(updated.metadata))
        const state = await redisJsonMock.get(`session:${sessionId}:clip_state`)
        const stateClips = Array.isArray((state as any)?.clips) ? (state as any).clips : []
        for (const entry of stateClips) {
          if (typeof entry?.clipId === 'string' && entry.clipId.trim()) {
            trustedClipIds.add(entry.clipId.trim())
          }
        }
        for (const clipId of await redisMock.sMembers(`session:${sessionId}:active_clips`)) {
          if (clipId) trustedClipIds.add(clipId)
        }
        for (const clipId of await redisMock.sMembers(`session:${sessionId}:clips`)) {
          if (clipId) trustedClipIds.add(clipId)
        }
        updated.content = neutralizeUntrustedClipReferenceSyntax(
          neutralizeAllZipReferenceSyntax(updated.content),
          { trustedClipIds }
        )
      }

      // The real client also calls `touchSession` here. This fake models no session
      // touching anywhere (its `saveMessage` does not either), so `last_modified_at` is
      // not a thing any test on this lane may assert about a message write.
      if (options.browserMutation) {
        const current = redisStore.get(key)?.value
        assertBrowserMessageMutation(options.browserMutation, redisStore.get(`session:${sessionId}`)?.value, current, updated)
        updated.metadata = preserveServerSteerMetadata(updated.metadata, current?.metadata)
        if (current?.created_at) updated.created_at = current.created_at
        redisStore.set(key, { type: 'json', value: clone(updated) })
      } else {
        await redisJsonMock.set(key, '$', updated)
      }
    }),
    deleteMessage: vi.fn(async (
      messageId: string,
      sessionId: string,
      userId: string,
      options: { stillRunning?: () => boolean } = {}
    ) => {
      const session = await redisJsonMock.get(`session:${sessionId}`)
      if (!session) throw new Error('Session not found')
      if ((session as any).user_id !== userId) {
        throw new Error('Unauthorized: Session does not belong to user')
      }

      // BL-390 / BL-381: the real delete (`redis.deleteMessage`) decides under the chat's zip state
      // lock which zips go with the message, refuses a damaged other message, and asks the route's
      // running check again right before it writes; the same rules apply here over the fake.
      await withZipStateLock(sessionId, async () => {
        const message = (await redisJsonMock.get(`message:${sessionId}:${messageId}`)) as any
        const zipSetKey = `session:${sessionId}:zips`
        const candidates = [...new Set([...(await redisMock.sMembers(zipSetKey)), ...zipClaimsOfMessage(message)])]
        const zips = []
        for (const zipId of candidates) {
          const zip = (await redisJsonMock.get(`zip:${zipId}`)) as any
          zips.push({ zipId, messageId: zip?.metadata?.messageId, sessionId: zip?.metadata?.sessionId })
        }
        const otherMessages: unknown[] = []
        const otherMessageIds: string[] = []
        for (const id of await redisMock.lrange(`messages:${sessionId}`, 0, -1)) {
          if (id === messageId) continue
          otherMessageIds.push(id)
          const key = `message:${sessionId}:${id}`
          const other = await redisJsonMock.get(key)
          if (other == null && redisStore.has(key)) {
            throw new Error('Another message of this chat could not be read, so nothing was deleted.')
          }
          otherMessages.push(other)
        }
        const zipIdsToDelete = zipsOwnedOnlyByMessage({
          messageId,
          sessionId,
          zips,
          message,
          otherMessageIds,
          otherMessages
        })
        if (options.stillRunning?.()) throw new MessageStillRunningError()
        for (const zipId of zipIdsToDelete) {
          await redisMock.del(`zip:${zipId}`)
          await redisMock.sRem(zipSetKey, zipId)
          await redisMock.del(`unzipped_item:${sessionId}:${zipId}`)
          await redisMock.sRem(`unzipped:${sessionId}`, zipId)
          await redisMock.del(`rezipped_item:${sessionId}:${zipId}`)
          await redisMock.sRem(`rezipped:${sessionId}`, zipId)
        }
        await redisMock.del(`message:${sessionId}:${messageId}`)
        await redisMock.lRem(`messages:${sessionId}`, 0, messageId)
      })
      await redisMock.del(`session:${sessionId}:messages`)
    }),
    // BL-775: the real `redis.removeUnclaimedZipsMadeByMessage`, same rules over the fake.
    removeUnclaimedZipsMadeByMessage: vi.fn(async (sessionId: string, messageId: string, zipIds: string[]) => {
      const candidates = [...new Set(zipIds.filter((id) => typeof id === 'string' && id.length > 0))].sort()
      if (!sessionId || !messageId || candidates.length === 0) return []
      const chatMessages: unknown[] = []
      for (const id of await redisMock.lrange(`messages:${sessionId}`, 0, -1)) {
        const key = `message:${sessionId}:${id}`
        const message = await redisJsonMock.get(key)
        if (message == null && redisStore.has(key)) {
          throw new Error('A message of this chat could not be read, so no zip was removed.')
        }
        chatMessages.push(message)
      }
      return withZipStateLock(sessionId, async () => {
        const zips = []
        for (const zipId of candidates) {
          const zip = (await redisJsonMock.get(`zip:${zipId}`)) as any
          zips.push({ zipId, messageId: zip?.metadata?.messageId, sessionId: zip?.metadata?.sessionId })
        }
        const removable = unclaimedZipsMadeByMessage({ messageId, sessionId, zips, chatMessages })
        for (const zipId of removable) {
          await redisMock.del(`zip:${zipId}`)
          await redisMock.sRem(`session:${sessionId}:zips`, zipId)
          await redisMock.del(`unzipped_item:${sessionId}:${zipId}`)
          await redisMock.sRem(`unzipped:${sessionId}`, zipId)
          await redisMock.del(`rezipped_item:${sessionId}:${zipId}`)
          await redisMock.sRem(`rezipped:${sessionId}`, zipId)
        }
        return removable
      })
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
          // BL-537: a zip state Release and Hold are one MULTI each (`zipHolds.ts`).
          sAdd: (key: string, ...members: any[]) => {
            queue.push(() => redisMock.sAdd(key, ...members))
            return multiApi
          },
          sRem: (key: string, ...members: any[]) => {
            queue.push(() => redisMock.sRem(key, ...members))
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
        // LPOS with RANK: a negative rank counts matches from the tail (BL-4's resend check).
        lPos: vi.fn(async (key: string, element: any, options: { RANK?: number } = {}) => {
          const list: string[] = await redisMock.lRange(key, 0, -1)
          const rank = options?.RANK ?? 1
          const indexes = list.map((_, index) => index)
          let seen = 0
          for (const index of rank < 0 ? indexes.reverse() : indexes) {
            if (list[index] === String(element) && ++seen === Math.abs(rank)) return index
          }
          return null
        }),
        rPush: vi.fn(async (key: string, value: any) => redisMock.rPush(key, value)),
        sAdd: vi.fn(async (key: string, ...members: any[]) => redisMock.sAdd(key, ...members)),
        sMembers: vi.fn(async (key: string) => redisMock.sMembers(key)),
        sIsMember: vi.fn(async (key: string, member: string) =>
          (await redisMock.sMembers(key)).includes(member)
        ),
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
        // Most fake-Redis suites predate EVAL and check `if (client.eval)` to decide whether
        // this environment supports Lua scripts at all, falling back to their own no-EVAL path
        // when it is absent. `eval` must stay undefined by default -- BL-787 review (2026-09-28)
        // found that making it unconditionally defined broke 15 tests across 4 unrelated
        // repository suites (hairImportJobRepository.server, hairAssetRepository.server,
        // clothingAssetRepository, hairImportLifecycle.server): about ten repositories reached
        // this SAME fake with THEIR OWN scripts, which fell through every branch here into "This
        // Redis fake does not implement that Lua script" instead of their intended no-EVAL path.
        // Both script families stay opt-in, each behind its own flag: the retained-output script
        // (`VITEST_FAKE_RETAINED_OUTPUT_EVAL`) and BL-787's three Portable Skill Token scripts
        // (`VITEST_FAKE_PORTABLE_SKILL_TOKEN_EVAL`, stubbed only in
        // nativeToolAuth.portable.test.ts, the one fake-lane suite that reaches them).
        ...(process.env.VITEST_FAKE_RETAINED_OUTPUT_EVAL === 'true' ||
        process.env.VITEST_FAKE_PORTABLE_SKILL_TOKEN_EVAL === 'true'
          ? { eval: vi.fn(async (script: string, options: { keys?: string[]; arguments?: string[] } = {}) => {
          if (
            process.env.VITEST_FAKE_RETAINED_OUTPUT_EVAL === 'true' &&
            script.includes('BATSHIT_RETAINED_OUTPUT_PUBLICATION_V2')
          ) {
            const [indexKey, zipKey] = options.keys ?? []
            const [zipId, zipJson] = options.arguments ?? []
            if (!indexKey || !zipKey || !zipId || !zipJson) {
              throw new Error('Retained output publication needs two keys and two arguments.')
            }
            const index = redisStore.get(indexKey)
            if (index && index.type !== 'set') throw new Error('Retained output index has the wrong Redis type.')
            if (redisStore.has(zipKey)) throw new Error('Retained output zip id already exists.')
            const parsed = JSON.parse(zipJson)
            const members = index ? index.value as Set<string> : new Set<string>()
            members.add(zipId)
            redisStore.set(indexKey, { type: 'set', value: members })
            redisStore.set(zipKey, { type: 'json', value: clone(parsed) })
            return 1
          }

          // BL-787: JS twins of the three atomic Portable Skill Token scripts. Each reads the
          // record's CURRENT state from this same fake store (never a value a caller captured
          // earlier) and refuses on a missing/revoked record, exactly like the real scripts.
          // Review round 2: as strict as the Lua. `JSON.TYPE $.revokedAt` on a MISSING path
          // returns nil, and `nil ~= 'null'` is true in Lua, so a record with no revokedAt
          // field at all fails closed (REVOKED), the same as an actually-revoked one -- only a
          // JSON `null` value reads as "not revoked". A tokenHash that is not a string is a
          // malformed record: error, never delete a `${prefix}undefined` nonsense key.
          const isRevoked = (record: any) => record?.revokedAt !== null
          const getJson = (key: string) => {
            const entry = redisStore.get(key)
            return entry && entry.type === 'json' ? entry.value : null
          }
          const setJson = (key: string, value: any) => redisStore.set(key, { type: 'json', value: clone(value) })

          if (
            process.env.VITEST_FAKE_PORTABLE_SKILL_TOKEN_EVAL === 'true' &&
            script.includes('BATSHIT_PORTABLE_SKILL_TOKEN_UPDATE_V1')
          ) {
            const [recordKey] = options.keys ?? []
            const [updatedAt, hasLabelFlag, labelJson, hasFamiliesFlag, familiesJson] = options.arguments ?? []
            const existing = getJson(recordKey)
            if (!existing) return 'MISSING'
            if (isRevoked(existing)) return 'REVOKED'
            const next = { ...existing }
            if (hasFamiliesFlag === '1') {
              const families = JSON.parse(familiesJson)
              if (families.length === 0) return 'EMPTY_FAMILIES'
              next.families = families
            }
            if (hasLabelFlag === '1') next.label = JSON.parse(labelJson)
            next.updatedAt = updatedAt
            setJson(recordKey, next)
            return 'OK'
          }

          if (
            process.env.VITEST_FAKE_PORTABLE_SKILL_TOKEN_EVAL === 'true' &&
            script.includes('BATSHIT_PORTABLE_SKILL_TOKEN_ROTATE_V1')
          ) {
            const [recordKey, newHashIndexKey] = options.keys ?? []
            const [newTokenHash, tokenPrefix, tokenSuffix, updatedAt, userId, tokenId, hashPrefix] =
              options.arguments ?? []
            const existing = getJson(recordKey)
            if (!existing) return 'MISSING'
            if (isRevoked(existing)) return 'REVOKED'
            if (typeof existing.tokenHash !== 'string') {
              return 'MALFORMED'
            }
            const oldHash = existing.tokenHash
            setJson(recordKey, { ...existing, tokenHash: newTokenHash, tokenPrefix, tokenSuffix, updatedAt })
            redisStore.delete(`${hashPrefix}${oldHash}`)
            setJson(newHashIndexKey, { userId, tokenId })
            return 'OK'
          }

          if (
            process.env.VITEST_FAKE_PORTABLE_SKILL_TOKEN_EVAL === 'true' &&
            script.includes('BATSHIT_PORTABLE_SKILL_TOKEN_REVOKE_V1')
          ) {
            const [recordKey, setKey] = options.keys ?? []
            const [revokedAt, tokenId, hashPrefix] = options.arguments ?? []
            const existing = getJson(recordKey)
            if (!existing) return 'MISSING'
            if (isRevoked(existing)) return 'ALREADY_REVOKED'
            if (typeof existing.tokenHash !== 'string') {
              return 'MALFORMED'
            }
            const hash = existing.tokenHash
            setJson(recordKey, { ...existing, revokedAt, updatedAt: revokedAt })
            redisStore.delete(`${hashPrefix}${hash}`)
            await redisMock.sRem(setKey, tokenId)
            return 'OK'
          }

          throw new Error(`This Redis fake does not implement that Lua script: ${script.slice(0, 80)}`)
        }) }
          : {}),
        json: redisJsonMock,
        multi: vi.fn(() => createMulti())
      }

      return operation(client)
    })
  }

  redisMockInstance = redisMock

  return {
    redis: redisMock,
    // SA-114 P3: the real module exports the CLASS too, and several routes construct their
    // own instance (`new RedisService()`) instead of importing the singleton. Without this
    // the fake lane throws "No RedisService export is defined" for those routes, which
    // looks like a broken test rather than a missing export. `new` on a function that
    // returns an object yields that object, so both shapes reach the same fake.
    RedisService: vi.fn(function RedisService() {
      return redisMock
    }),
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
