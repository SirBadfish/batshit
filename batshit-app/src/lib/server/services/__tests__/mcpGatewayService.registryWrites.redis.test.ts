import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

// BL-1371: the real RedisService, even if other suites mocked the module earlier.
vi.mock('$lib/server/redis', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis')
  return actual
})

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { createSettingsRedisAdmission } from '$lib/test-utils/settingsRedisAdmission'
import { defaultAppActionsPolicy } from '$lib/appActions/settings/managementContract'
import type { MCPGateway, MCPGatewayRegistry } from '$lib/types/database'
import { mcpGatewayService } from '$lib/server/services/mcpGatewayService'
import { mcpToolListCache } from '$lib/server/services/mcpToolListCache'
import type { AdapterContext } from '../appActions/managementTypes'
import { captureSettingsLifecycle, withSettingsRecordReplacement } from '../appActions/settings/lifecycle'
import {
  CONDITIONAL_MCP_GATEWAY_WRITE_SCRIPT, createGatewayManagementWriteContext,
  writeManagedGateway, type GatewayRawFence
} from '../appActions/mcp/gatewayWriteContext'

/**
 * BL-1371 on Redis 8 + JSON: the gateway registry's compare-and-set (`redis.json.getRaw`,
 * `setIfUnchanged`, `delIfUnchanged`, one Lua script) and the one interleave the default lane
 * cannot run, the real Lua check (`RECORD_STDIO_CHECK_SCRIPT`) landing between a save's snapshot
 * and its compare-and-set. The primitive checks pin the true RedisJSON shapes the default lane's
 * twin copies (`test-utils/redisJsonCompareAndWriteTwin.test.ts`): raw `$` arrays, `[]` for a path
 * that matches nothing, null for a missing key, and success only when the write reports it.
 *
 * Real-Redis suite (G-0228): it runs only under `npm run test:redis` and reports as skipped in the
 * default lane. The default-lane twin of the service cases is `mcpGatewayService.registryWrites.test.ts`.
 */

const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'
// Existing CI cases retain their normal lane. N1e requires the separately owned
// fresh allocation; when supplied, strict admission precedes ALL file cleanup.
const N1E_ALLOCATED_LANE = REAL_REDIS_LANE && Object.hasOwn(process.env, 'SA122_SETTINGS_REDIS_ALLOCATION')
const strictAdmission = N1E_ALLOCATED_LANE ? createSettingsRedisAdmission(redis) : undefined
const admission = useRedisTestServer(strictAdmission ? { beforeCleanupAdmission: strictAdmission.beforeCleanupAdmission } : {})
afterAll(() => strictAdmission?.close())
afterEach(() => {
  vi.restoreAllMocks()
  mcpToolListCache.clearAll()
})
const USER = 'bl1371_real_user'
const KEY = `mcp_gateways:${USER}`
const OTHER_KEY = `mcp_gateways:${USER}_absent`
const OLD_ARGS = ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']
const NEW_ARGS = ['-y', '@modelcontextprotocol/server-filesystem', '/Users/example/projects']

function stdioGateway(id: string, name: string) {
  return {
    id,
    name,
    type: 'stdio' as const,
    enabled: true,
    created_at: '2026-10-11T00:00:00.000Z',
    stdioConfig: { command: 'npx', args: [...OLD_ARGS], cwdPolicy: 'none' as const }
  }
}

function customGateway(id: string, name: string) {
  return {
    id,
    name,
    type: 'custom' as const,
    url: `https://${id}.example.test/mcp`,
    enabled: true,
    created_at: '2026-10-11T00:00:00.000Z'
  }
}

async function seed() {
  await mcpGatewayService.create(USER, stdioGateway('gw-a', 'Alpha'))
  await mcpGatewayService.create(USER, stdioGateway('gw-b', 'Beta'))
  await mcpGatewayService.create(USER, customGateway('gw-c', 'Gamma'))
}

async function stored(id: string) {
  const registry = (await redis.json.get(KEY)) as { gateways: any[] } | null
  return registry?.gateways.find((gateway) => gateway.id === id) ?? null
}

/** Runs `competitor` once, just before the first compare-and-set write of the registry. */
function beforeFirstSetIfUnchanged(competitor: () => Promise<unknown>) {
  const original = redis.json.setIfUnchanged
  let armed = true
  return vi.spyOn(redis.json, 'setIfUnchanged').mockImplementation(async (key, path, expectedRaw, value) => {
    if (armed && key === KEY) {
      armed = false
      await competitor()
    }
    return original(key, path, expectedRaw, value)
  })
}

describe.runIf(REAL_REDIS_LANE)('BL-1371: gateway registry compare-and-set (real Redis)', () => {
  it('a launch save keeps the real check result written between its snapshot and its write', async () => {
    await seed()
    const otherBefore = await stored('gw-a')
    const writes = beforeFirstSetIfUnchanged(() =>
      mcpGatewayService.recordStdioCheckResult(USER, 'gw-b', {
        lastTestStatus: 'passed',
        lastTestAt: '2026-10-11T18:00:00.000Z',
        lastError: null,
        toolCount: 7
      })
    )

    const saved = await mcpGatewayService.update(USER, 'gw-b', {
      stdioConfig: { ...stdioGateway('gw-b', 'Beta').stdioConfig, args: [...NEW_ARGS] }
    })

    const config = (await stored('gw-b')).stdioConfig
    expect(config.args).toEqual(NEW_ARGS)
    expect(config).toMatchObject({
      lastTestStatus: 'passed',
      lastTestAt: '2026-10-11T18:00:00.000Z',
      lastError: null,
      toolCount: 7
    })
    expect(saved.stdioConfig).toEqual(config)
    // The first compare-and-set was refused by the check's write; the second stored.
    expect(writes.mock.calls.filter((call) => call[0] === KEY)).toHaveLength(2)
    expect(await stored('gw-a')).toEqual(otherBefore)
  })

  it('a save lands on its own gateway when a delete shifts the list before its write', async () => {
    await seed()
    const gammaBefore = await stored('gw-c')
    beforeFirstSetIfUnchanged(() => mcpGatewayService.delete(USER, 'gw-a'))

    await mcpGatewayService.update(USER, 'gw-b', { name: 'Beta renamed' })

    expect(await stored('gw-a')).toBeNull()
    expect((await stored('gw-b')).name).toBe('Beta renamed')
    expect(await stored('gw-c')).toEqual(gammaBefore)
  })

  it('compares raw text with non-ASCII characters byte for byte (no refusal from the UTF-8 round trip)', async () => {
    await seed()
    const writes = vi.spyOn(redis.json, 'setIfUnchanged')

    await mcpGatewayService.update(USER, 'gw-b', { name: 'Bêta 🦇 ü' })
    await mcpGatewayService.update(USER, 'gw-b', { enabled: false })

    expect(await stored('gw-b')).toMatchObject({ name: 'Bêta 🦇 ü', enabled: false })
    // One compare-and-set each: the second compared the stored non-ASCII text and matched.
    expect(writes.mock.calls.filter((call) => call[0] === KEY)).toHaveLength(2)
  })

  it('reads the raw RedisJSON shapes: a $ array, [] for a path past the end, null for no key', async () => {
    await seed()
    const root = await redis.json.getRaw(KEY, '$')
    expect(typeof root).toBe('string')
    const rootMatches = JSON.parse(root!)
    expect(Array.isArray(rootMatches) && rootMatches.length).toBe(1)
    expect(rootMatches[0].gateways.map((gateway: any) => gateway.id)).toEqual(['gw-a', 'gw-b', 'gw-c'])

    const element = JSON.parse((await redis.json.getRaw(KEY, '$.gateways[1]'))!)
    expect(element).toHaveLength(1)
    expect(element[0].id).toBe('gw-b')

    expect(await redis.json.getRaw(KEY, '$.gateways[3]')).toBe('[]')
    expect(await redis.json.getRaw(OTHER_KEY, '$')).toBeNull()
  })

  it('setIfUnchanged writes from the exact text and refuses a stale one, writing nothing', async () => {
    await seed()
    const raw = (await redis.json.getRaw(KEY, '$.gateways[1]'))!
    const before = JSON.parse(raw)[0]
    const siblingsBefore = [await redis.json.getRaw(KEY, '$.gateways[0]'), await redis.json.getRaw(KEY, '$.gateways[2]')]

    expect(await redis.json.setIfUnchanged(KEY, '$.gateways[1]', raw, { ...before, name: 'Beta one' })).toBe(true)
    expect((await stored('gw-b')).name).toBe('Beta one')
    expect([await redis.json.getRaw(KEY, '$.gateways[0]'), await redis.json.getRaw(KEY, '$.gateways[2]')]).toEqual(siblingsBefore)

    const registryText = await redis.json.getRaw(KEY, '$')
    expect(await redis.json.setIfUnchanged(KEY, '$.gateways[1]', raw, { ...before, name: 'Beta stale' })).toBe(false)
    expect(await redis.json.getRaw(KEY, '$')).toBe(registryText)
  })

  it('setIfUnchanged creates an absent key only from the empty text, once', async () => {
    expect(await redis.json.setIfUnchanged(OTHER_KEY, '$', '', { gateways: [] })).toBe(true)
    expect(await redis.json.get(OTHER_KEY)).toEqual({ gateways: [] })
    expect(await redis.json.setIfUnchanged(OTHER_KEY, '$', '', { gateways: [{ id: 'late' }] })).toBe(false)
    expect(await redis.json.get(OTHER_KEY)).toEqual({ gateways: [] })
  })

  it('refuses an index that now holds another gateway, and an index whose gateway was deleted', async () => {
    await seed()
    const rawA = (await redis.json.getRaw(KEY, '$.gateways[0]'))!
    const rawB = (await redis.json.getRaw(KEY, '$.gateways[1]'))!
    const rawC = (await redis.json.getRaw(KEY, '$.gateways[2]'))!

    expect(await redis.json.delIfUnchanged(KEY, '$.gateways[0]', rawA)).toBe(true)
    // Index 1 now holds gw-c: the snapshot of gw-b no longer matches.
    expect(await redis.json.setIfUnchanged(KEY, '$.gateways[1]', rawB, { id: 'gw-b', name: 'wrong place' })).toBe(false)
    expect(await redis.json.getRaw(KEY, '$.gateways[1]')).toBe(rawC)
    // Index 2 is past the end now: `[]`, so the old text of gw-c there is refused too.
    expect(await redis.json.setIfUnchanged(KEY, '$.gateways[2]', rawC, { id: 'gw-c', name: 'gone' })).toBe(false)
    expect(await redis.json.delIfUnchanged(KEY, '$.gateways[2]', rawC)).toBe(false)
    expect(((await redis.json.get(KEY)) as any).gateways.map((gateway: any) => gateway.id)).toEqual(['gw-b', 'gw-c'])
  })

  it('delIfUnchanged removes one gateway only and keeps its siblings byte for byte; $ removes the key', async () => {
    await seed()
    const rawA = await redis.json.getRaw(KEY, '$.gateways[0]')
    const rawB = (await redis.json.getRaw(KEY, '$.gateways[1]'))!
    const rawC = await redis.json.getRaw(KEY, '$.gateways[2]')

    expect(await redis.json.delIfUnchanged(KEY, '$.gateways[1]', '[{"id":"gw-b"}]')).toBe(false)
    expect(await redis.json.delIfUnchanged(KEY, '$.gateways[1]', rawB)).toBe(true)
    expect(await redis.json.getRaw(KEY, '$.gateways[0]')).toBe(rawA)
    expect(await redis.json.getRaw(KEY, '$.gateways[1]')).toBe(rawC)

    expect(await redis.json.delIfUnchanged(KEY, '$', (await redis.json.getRaw(KEY, '$'))!)).toBe(true)
    expect(await redis.exists(KEY)).toBe(false)
  })

  it('a compare that passes but cannot write throws and writes nothing, never answers true', async () => {
    await seed()
    const registryText = await redis.json.getRaw(KEY, '$')
    // `$.gateways[5]` matches nothing (`[]`), so the compare passes; RedisJSON cannot create it.
    await expect(redis.json.setIfUnchanged(KEY, '$.gateways[5]', '[]', { id: 'gw-z' })).rejects.toThrow()
    await expect(redis.json.delIfUnchanged(KEY, '$.gateways[5]', '[]')).rejects.toThrow()
    await expect(redis.json.delIfUnchanged(OTHER_KEY, '$', '')).rejects.toThrow()
    expect(await redis.json.getRaw(KEY, '$')).toBe(registryText)
    expect(await redis.exists(OTHER_KEY)).toBe(false)
  })
})

const ACTOR_KEY = 'n1e:gateway:actor'
const SOURCE_KEY = 'n1e:gateway:source'
const KEY_REFERENCE = 'n1e:gateway:key-reference'
type EvalOptions = { keys: string[]; arguments: string[] }

async function managedFixture() {
  if (!strictAdmission) throw new Error('N1e requires its fresh strict Redis allocation.')
  admission.requireAdmission()
  await seed()
  for (const key of [ACTOR_KEY, SOURCE_KEY, KEY_REFERENCE]) await redis.json.set(key, '$', { revision: 1 })
  const checks: GatewayRawFence[] = []
  for (const key of [ACTOR_KEY, SOURCE_KEY, KEY_REFERENCE]) {
    const raw = await redis.json.getRaw(key, '$.revision')
    if (raw === null) throw new Error('The owned fixture raw fence is missing.')
    checks.push({ key, paths: [['$.revision', raw]] })
  }
  const originalStop = new AbortController(), operationStop = new AbortController()
  // Fixture authority only: this does NOT prove route authentication, consumed
  // consent, a genuine MCP issuer, or an originating managed/API reply Stop.
  const adapter: AdapterContext = {
    admission: {
      actor: { userId: USER, kind: 'native', id: 'n1e-fixture', generation: 1, label: 'fixture' },
      policy: defaultAppActionsPolicy(), signal: originalStop.signal,
      fence: { ...checks[0], lifecycle: captureSettingsLifecycle([ACTOR_KEY]) }
    },
    signal: operationStop.signal, deadlineAt: Date.now() + 10_000,
    assertCurrent() {
      admission.requireAdmission()
      if (originalStop.signal.aborted || operationStop.signal.aborted) throw new Error('Fixture operation stopped.')
    },
    async refreshAuthority() {}
  }
  const onSaved = vi.fn()
  const contextFor = (mode: 'create' | 'update', gatewayId: string, expectedRaw: string, approvedPostimage: unknown) =>
    createGatewayManagementWriteContext({ mode, gatewayId, expectedRaw, approvedPostimage, adapter,
      fences: checks.slice(1), beforeIssue() {}, onSaved })
  const registry = await redis.json.get(KEY) as MCPGatewayRegistry
  const raw = await redis.json.getRaw(KEY, '$')
  if (raw === null) throw new Error('The owned fixture registry is missing.')
  // Already-normalized simple fields and an explicit slug avoid duplicating the
  // service normalizer. This postimage is fixture input, not a production issuer.
  const gateway: MCPGateway = { ...customGateway('gw-n1e', 'Managed'), slug: 'managed_n1e' }
  const value = { ...registry, gateways: [...registry.gateways, gateway] }
  const write = { mode: 'create' as const, gatewayId: gateway.id, key: KEY, path: '$', raw, value }
  return { client: await redis.execute(async client => client), context: contextFor('create', gateway.id, raw, value),
    contextFor, checks, gateway, write, onSaved, adapter, stop: () => operationStop.abort() }
}

describe.runIf(N1E_ALLOCATED_LANE)('N1e gateway writer: allocated real Redis protocol only', () => {
  afterEach(async () => {
    if (!admission.isAdmitted()) return
    const errors: unknown[] = []
    for (const key of [KEY, OTHER_KEY, ACTOR_KEY, SOURCE_KEY, KEY_REFERENCE, 'agent:n1e-fixture']) {
      try { await redis.del(key) } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'N1e owned-key cleanup failed.')
  })

  it('I1 bounded metadata and original prepared normalization use real raw cuts without normalization or secret disclosure', async () => {
    const f = await managedFixture(), before = await redis.json.getRaw(KEY, '$')
    const sources = await mcpGatewayService.readManagementSources(USER)
    expect(sources).toHaveLength(3)
    expect(sources[0]).toMatchObject({ id: 'gw-a', slug: 'alpha', name: 'Alpha' })
    expect(await redis.json.getRaw(KEY, '$')).toBe(before)
    const captured = await mcpGatewayService.prepareGatewaySave(USER, { mode: 'create', gateway: {
      name: 'Alpha', type: 'custom', enabled: true, url: 'https://i1-source.example/mcp',
      metadata: { appActionsSource: { evidence: { kind: 'supplied', uri: 'https://i1-source.example/docs' } } }
    } })
    expect(captured.review.after).toMatchObject({ slug: 'alpha_1', name: 'Alpha' })
    expect(await redis.json.getRaw(KEY, '$')).toBe(before)
    expect(Object.keys(captured.plan)).toEqual([])
    await expect(mcpGatewayService.assertPreparedGatewayCurrent(structuredClone(captured.plan))).rejects.toThrow('original prepared')
    const onSaved = vi.fn()
    await mcpGatewayService.commitPreparedGatewaySave(captured.plan, { adapter: f.adapter, fences: f.checks.slice(1), beforeIssue() {}, onSaved })
    expect(onSaved).toHaveBeenCalledOnce()
    const saved = await stored(captured.review.resource.gatewayId)
    expect(saved).toMatchObject({ id: captured.review.after.id, slug: 'alpha_1', url: captured.review.after.url })
    expect(saved.created_at).toBe(saved.updated_at)
    // Actual SAME-EVAL postimage, not this later read adopted as a save base.
    const evidence = mcpGatewayService.readPreparedMcpSource(captured.plan)
    expect(evidence.saved).toBe('saved')
    expect(JSON.parse(evidence.raw)).toEqual([saved])
    expect(evidence.gateway).toEqual(saved)
    expect(() => mcpGatewayService.readPreparedMcpSource(structuredClone(captured.plan))).toThrow('original prepared')
    await expect(mcpGatewayService.commitPreparedGatewaySave(captured.plan, { adapter: f.adapter, fences: f.checks.slice(1), beforeIssue() {}, onSaved })).rejects.toThrow('cannot issue again')
    expect(onSaved).toHaveBeenCalledOnce()
  })

  it('retains an unchanged declared-no-key source without a dummy write and joins raw current actor/authority', async () => {
    const f = await managedFixture()
    await redis.json.set('agent:n1e-fixture', '$', { id: 'n1e-fixture', user_id: USER, agentType: 'api', created_at: '2026-10-21T00:00:00.000Z' })
    const captured = await mcpGatewayService.prepareGatewaySave(USER, { mode: 'update', gatewayId: 'gw-c', updates: {} })
    mcpGatewayService.assertPreparedMcpHttpCohort(captured.plan)
    const original = await redis.json.getRaw(KEY, '$'), beforeIssue = vi.fn()
    const auth = await mcpGatewayService.withPreparedMcpHttpAuth(captured.plan, [], async () => {
      expect(mcpGatewayService.readPreparedMcpHttpAuth(captured.plan)).toEqual({ headers: {}, reference: undefined, keyName: null })
      await mcpGatewayService.retainUnchangedMcpSource(captured.plan, 'n1e-fixture', f.adapter, f.checks.slice(1))
      const evidence = mcpGatewayService.readPreparedMcpSource(captured.plan)
      expect(evidence.saved).toBe('not_requested')
      const current = await mcpGatewayService.readMcpPrerequisiteIssueCut(USER, 'n1e-fixture', 'gw-c', f.adapter.deadlineAt, f.checks)
      expect(current.sourceRaw).toBe(evidence.raw)
      expect(current.sourceIdentity).toEqual({ gatewayId: 'gw-c', createdAt: evidence.gateway.created_at })
      await redis.json.set(KEY_REFERENCE, '$.revision', 2)
      await expect(mcpGatewayService.readMcpPrerequisiteIssueCut(USER, 'n1e-fixture', 'gw-c', f.adapter.deadlineAt, f.checks)).rejects.toThrow('refused')
      return evidence
    })
    expect(auth.saved).toBe('not_requested'); expect(await redis.json.getRaw(KEY, '$')).toBe(original)
    expect(() => mcpGatewayService.readPreparedMcpHttpAuth(captured.plan)).toThrow('lifetime ended')
    await expect(mcpGatewayService.commitPreparedGatewaySave(captured.plan, { adapter: f.adapter, fences: [], beforeIssue, onSaved() {} })).rejects.toThrow('cannot issue again')
    expect(beforeIssue).not.toHaveBeenCalled()
  })

  it('I1 stale prepared creates refuse instead of picking a new slug or retrying under old approval', async () => {
    const f = await managedFixture()
    const captured = await mcpGatewayService.prepareGatewaySave(USER, { mode: 'create', gateway: { name: 'New source', type: 'custom', enabled: true, url: 'https://i1-source.example/mcp' } })
    await mcpGatewayService.create(USER, customGateway('interloper', 'New source'))
    const exact = await redis.json.getRaw(KEY, '$'), onSaved = vi.fn()
    await expect(mcpGatewayService.assertPreparedGatewayCurrent(captured.plan)).rejects.toThrow('source changed')
    await expect(mcpGatewayService.commitPreparedGatewaySave(captured.plan, { adapter: f.adapter, fences: f.checks.slice(1), beforeIssue() {}, onSaved })).rejects.toMatchObject({ code: 'MCP_WRITE_CONFLICT' })
    expect(await redis.json.getRaw(KEY, '$')).toBe(exact)
    expect(await stored(captured.review.after.id)).toBeNull(); expect(onSaved).not.toHaveBeenCalled()
  })

  it('creates at the approved destination and updates the actual selected index, preserving siblings', async () => {
    const f = await managedFixture(), client = f.client
    const siblings = await Promise.all([0, 1, 2].map(index => redis.json.getRaw(KEY, `$.gateways[${index}]`)))
    const actualAbort = client.withAbortSignal.bind(client), issued: EvalOptions[] = []
    vi.spyOn(client, 'withAbortSignal').mockImplementation(((signal: AbortSignal) => {
      const command = actualAbort(signal)
      return { eval(script: string, options: EvalOptions) { issued.push(options); return command.eval(script, options) } }
    }) as never)
    await expect(mcpGatewayService.create(`${USER}_absent`, f.gateway, f.context)).rejects.toMatchObject({ code: 'MCP_DESTINATION_CONFLICT' })
    expect(await redis.exists(OTHER_KEY)).toBe(false)
    expect(issued).toHaveLength(0)
    expect(await mcpGatewayService.create(USER, f.gateway, f.context)).toEqual(f.gateway)
    expect(issued[0].keys[0]).toBe(KEY)
    expect(issued[0].arguments.slice(0, 2)).toEqual(['$', f.write.raw])
    const created = await stored(f.gateway.id), raw = await redis.json.getRaw(KEY, '$.gateways[3]')
    if (raw === null) throw new Error('The created gateway element is missing.')
    const context = f.contextFor('update', f.gateway.id, raw, { ...created, enabled: false })
    const updated = await mcpGatewayService.update(USER, f.gateway.id, { enabled: false }, context)
    expect(issued).toHaveLength(2)
    expect(issued[1].keys[0]).toBe(KEY)
    expect(issued[1].arguments.slice(0, 2)).toEqual(['$.gateways[3]', raw])
    expect(updated).toMatchObject({ ...f.gateway, enabled: false })
    expect(await stored(f.gateway.id)).toEqual(updated)
    expect(await Promise.all([0, 1, 2].map(index => redis.json.getRaw(KEY, `$.gateways[${index}]`)))).toEqual(siblings)
    expect(f.onSaved).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['authority', ACTOR_KEY, '$.revision', 2, 'MCP_WRITE_AUTHORITY_CHANGED'],
    ['source', SOURCE_KEY, '$.revision', 2, 'MCP_WRITE_AUTHORITY_CHANGED'],
    ['key reference', KEY_REFERENCE, '$.revision', 2, 'MCP_WRITE_AUTHORITY_CHANGED'],
    ['target', KEY, '$.gateways[0].enabled', false, 'MCP_WRITE_CONFLICT']
  ] as const)('refuses a physical %s raw race before the Lua mutation', async (_name, key, path, value, code) => {
    const f = await managedFixture(), actualAbort = f.client.withAbortSignal.bind(f.client)
    let changed: string | null | undefined, attempts = 0
    vi.spyOn(f.client, 'withAbortSignal').mockImplementation(((signal: AbortSignal) => {
      const command = actualAbort(signal)
      return { eval: async (script: string, options: EvalOptions) => {
        attempts += 1
        await redis.json.set(key, path, value)
        changed = await redis.json.getRaw(KEY, '$')
        return command.eval(script, options)
      } }
    }) as never)
    await expect(writeManagedGateway(f.client, f.context, f.write)).rejects.toMatchObject({ code })
    expect(attempts).toBe(1)
    expect(changed).toBeDefined()
    expect(await redis.json.getRaw(KEY, '$')).toBe(changed)
    expect(await stored(f.gateway.id)).toBeNull()
    expect(f.onSaved).not.toHaveBeenCalled()
    await expect(withSettingsRecordReplacement(ACTOR_KEY, async () => undefined)).resolves.toBeUndefined()
  })

  it('uses actual Redis TIME to refuse a past script deadline without changing the registry', async () => {
    const f = await managedFixture()
    const time = await f.client.sendCommand(['TIME']) as string[]
    expect(time).toHaveLength(2)
    const now = Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000)
    expect(Number.isSafeInteger(now) && now > 0).toBe(true)
    // Direct physical-script proof, distinct from the writer's JS Stop/deadline
    // admission: a past Redis-derived deadline reaches the real Lua unchanged.
    expect(await f.client.eval(CONDITIONAL_MCP_GATEWAY_WRITE_SCRIPT, {
      keys: [KEY, ...f.checks.map(fence => fence.key)],
      arguments: ['$', f.write.raw, JSON.stringify(f.write.value), String(now - 1), JSON.stringify(f.checks.map(fence => fence.paths))]
    })).toBe('EXPIRED')
    expect(await redis.json.getRaw(KEY, '$')).toBe(f.write.raw)
    expect(f.onSaved).not.toHaveBeenCalled()
  })

  it('aborts the real installed-client queue in the same turn before socket flush, with no write', async () => {
    const f = await managedFixture(), actualAbort = f.client.withAbortSignal.bind(f.client)
    let attempts = 0
    vi.spyOn(f.client, 'withAbortSignal').mockImplementation(((signal: AbortSignal) => {
      const command = actualAbort(signal)
      return { eval(script: string, options: EvalOptions) {
        attempts += 1
        const pending = command.eval(script, options)
        // Actual eval has entered node-redis toWrite; its scheduled socket flush
        // cannot run before this synchronous abort. No synthetic AbortError.
        f.stop()
        return pending
      } }
    }) as never)
    await expect(writeManagedGateway(f.client, f.context, f.write)).rejects.toMatchObject({ code: 'MCP_WRITE_UNSENT' })
    expect(attempts).toBe(1)
    expect(await redis.json.getRaw(KEY, '$')).toBe(f.write.raw)
    expect(f.onSaved).not.toHaveBeenCalled()
    await expect(withSettingsRecordReplacement(ACTOR_KEY, async () => undefined)).resolves.toBeUndefined()
  })

  // Last by design: the writer's ambiguous lifecycle custody is NEVER released
  // for another attempt. Only settled fixture keys/connections are cleaned up.
  it('keeps an executed but withheld application result unknown, settled underneath and never replayed', async () => {
    const f = await managedFixture(), actualAbort = f.client.withAbortSignal.bind(f.client)
    let release!: () => void, physical: Promise<unknown> | undefined, attempts = 0, finished = false
    const withheld = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(f.client, 'withAbortSignal').mockImplementation(((signal: AbortSignal) => {
      const command = actualAbort(signal)
      return { eval(script: string, options: EvalOptions) {
        attempts += 1
        physical = command.eval(script, options)
        return physical.then(async () => {
          await withheld
          throw new Error('Fixture withheld an actually successful application result; not TCP-loss proof.')
        })
      } }
    }) as never)
    const pending = writeManagedGateway(f.client, f.context, f.write).then(() => undefined, error => error)
      .finally(() => { finished = true })
    let outcome: unknown
    try {
      expect(physical).toBeDefined()
      expect(await physical).toEqual(['OK', JSON.stringify([f.gateway])])
      expect(await redis.json.get(KEY)).toEqual(f.write.value)
      expect(finished).toBe(false)
    } finally {
      release()
      outcome = await pending
    }
    expect(outcome).toMatchObject({ code: 'MCP_GATEWAY_WRITE_UNCONFIRMED', gatewaySaved: false, gatewayId: f.gateway.id })
    expect(f.onSaved).not.toHaveBeenCalled()
    // The separate physical read above cannot certify the writer's lost result.
    await expect(writeManagedGateway(f.client, f.context, f.write)).rejects.toMatchObject({ code: 'MCP_WRITE_ALREADY_ISSUED' })
    expect(attempts).toBe(1)
    let replacementRan = false
    await expect(withSettingsRecordReplacement(ACTOR_KEY, async () => { replacementRan = true })).rejects.toThrow(/unknown outcome/)
    expect(replacementRan).toBe(false)
  })
})


describe.runIf(REAL_REDIS_LANE)('private original HTTP issue cut (actual read-only Lua)', () => {
  it('observes source, encrypted raw reference and actor DCM together without writes or normalization', async () => {
    const gateway = { ...customGateway('held-http', 'Held'), authKeyName: 'http-reference' }
    const registry = { gateways: [gateway] }
    const keyName = `api_keys:${USER}:http-reference`, actorKey = `agent:${USER}_http_actor`
    const actor = { id: `${USER}_http_actor`, user_id: USER, agentType: 'api', created_at: 'held-actor', dcmDisplaySettings: null }
    const key = { encrypted: 'synthetic-ciphertext', iv: 'synthetic-iv', authTag: 'synthetic-tag' }
    await redis.json.set(KEY, '$', registry)
    await redis.json.set(keyName, '$', key)
    await redis.json.set(actorKey, '$', actor)
    const before = await Promise.all([KEY, keyName, actorKey].map(key => redis.json.getRaw(key, '$')))
    const cut = await mcpGatewayService.readMcpHttpIssueCut(USER, actor.id, gateway.id, 'http-reference')
    expect(cut.gateway).toEqual(gateway)
    expect(cut.keyRaw).toBe(before[1])
    expect(cut.actor).toEqual(actor)
    expect(Object.hasOwn(cut.actor, 'dcm_display_settings')).toBe(false)
    expect(await Promise.all([KEY, keyName, actorKey].map(key => redis.json.getRaw(key, '$')))).toEqual(before)
    // Same plaintext semantics cannot erase a different encrypted record cut.
    await redis.json.set(keyName, '$', { ...key, iv: 'rotated-synthetic-iv' })
    const rotated = await mcpGatewayService.readMcpHttpIssueCut(USER, actor.id, gateway.id, 'http-reference')
    expect(rotated.keyRaw).not.toBe(cut.keyRaw)
    expect(rotated.sourceRaw).toBe(cut.sourceRaw)
    await redis.json.set(KEY, '$', { gateways: [gateway, { ...gateway }] })
    const duplicate = await redis.json.getRaw(KEY, '$')
    await expect(mcpGatewayService.readMcpHttpIssueCut(USER, actor.id, gateway.id, 'http-reference')).rejects.toThrow('MCP_SOURCE_DUPLICATE')
    expect(await redis.json.getRaw(KEY, '$')).toBe(duplicate)
  })
  // The new matrix requires the existing strict allocation, not the older CI lane.
  describe.runIf(N1E_ALLOCATED_LANE)('allocated raw-shape matrix', () => {
    async function issueFixture() {
      if (!strictAdmission) throw new Error('The issue-cut matrix requires the fresh strict Redis allocation.')
      admission.requireAdmission()
      const id = randomUUID(), userId = `${USER}_m5_${id}`, actorId = `m5_actor_${id}`
      const gateway = { ...customGateway(`m5_source_${id}`, 'Synthetic issue-cut source'), authKeyName: 'http-reference' }
      const actor = { id: actorId, user_id: userId, agentType: 'api', created_at: 'synthetic-original-incarnation' }
      const registryKey = `mcp_gateways:${userId}`, actorKey = `agent:${actorId}`, keyName = `api_keys:${userId}:http-reference`
      const key = { encrypted: 'synthetic-ciphertext', iv: 'synthetic-iv', authTag: 'synthetic-tag' }
      await redis.json.set(registryKey, '$', { gateways: [gateway] })
      await redis.json.set(actorKey, '$', actor)
      await redis.json.set(keyName, '$', key)
      return { userId, actorId, gateway, actor, registryKey, actorKey, keyName, key, keys: [registryKey, actorKey, keyName] }
    }
    type IssueFixture = Awaited<ReturnType<typeof issueFixture>>
    async function rawState(f: IssueFixture) {
      return redis.execute(async client => {
        const keys: string[] = []
        let cursor = '0'
        do {
          const page = await client.scan(cursor, { COUNT: 50 })
          cursor = String(page.cursor); keys.push(...page.keys)
        } while (cursor !== '0')
        const values = await Promise.all(f.keys.map(async key => {
          const type = await client.type(key)
          const raw = type === 'none' ? null : type === 'string' ? await client.get(key) : await client.sendCommand(['JSON.GET', key, '$'])
          // Absolute expiry stays exact across READ; a remaining TTL decrements.
          const expiresAt = await client.sendCommand(['PEXPIRETIME', key])
          return { key, type, raw, expiresAt }
        }))
        return { keys: keys.sort(), values }
      })
    }
    async function observeRead(f: IssueFixture) {
      // Synthetic setup mutations/expiries all precede the exported READ.
      await redis.execute(async client => {
        for (const key of f.keys) await client.sendCommand(['PEXPIRE', key, '600000'])
      })
      const before = await rawState(f)
      expect(before.keys).toEqual(before.values.filter(row => row.type !== 'none').map(row => row.key).sort())
      for (const row of before.values) {
        if (row.type === 'none') expect(row.expiresAt).toBe(-2)
        else { expect(typeof row.expiresAt).toBe('number'); expect(row.expiresAt).toBeGreaterThan(0) }
      }
      let cut: Awaited<ReturnType<typeof mcpGatewayService.readMcpHttpIssueCut>> | undefined
      let error: unknown, rejected = false
      try { cut = await mcpGatewayService.readMcpHttpIssueCut(f.userId, f.actorId, f.gateway.id, 'http-reference') }
      catch (failure) { rejected = true; error = failure }
      // Outside expected-rejection assertions: a failed state check cannot
      // masquerade as correct refusal. No EVAL reply/ACK is mocked.
      expect(await rawState(f)).toEqual(before)
      return { cut, error, rejected, before }
    }
    it.each(['absent registry', 'wrong registry Redis type', 'malformed gateways shape', 'missing gateway',
      'duplicate gateway', 'invalid enabled shape', 'unsupported source type', 'missing saved-reference field'] as const)(
      'refuses %s without changing raw records, keyset or expiry', async boundary => {
        const f = await issueFixture()
        if (boundary === 'absent registry') await redis.del(f.registryKey)
        else if (boundary === 'wrong registry Redis type') await redis.execute(client => client.set(f.registryKey, 'synthetic wrong Redis type'))
        else if (boundary === 'malformed gateways shape') await redis.json.set(f.registryKey, '$', { gateways: { unexpected: true } })
        else if (boundary === 'missing gateway') await redis.json.set(f.registryKey, '$', { gateways: [] })
        else if (boundary === 'duplicate gateway') await redis.json.set(f.registryKey, '$', { gateways: [f.gateway, { ...f.gateway }] })
        else {
          const gateway: Record<string, unknown> = { ...f.gateway }
          if (boundary === 'invalid enabled shape') gateway.enabled = 'true'
          else if (boundary === 'unsupported source type') gateway.type = 'stdio'
          else delete gateway.authKeyName
          await redis.json.set(f.registryKey, '$', { gateways: [gateway] })
        }
        const result = await observeRead(f)
        expect(result.rejected).toBe(true)
        expect(result.cut).toBeUndefined()
        expect(result.error).toBeInstanceOf(Error)
        if (boundary === 'absent registry' || boundary === 'missing gateway') expect(result.error).toMatchObject({ message: expect.stringContaining('MCP_SOURCE_MISSING') })
        if (boundary === 'duplicate gateway') expect(result.error).toMatchObject({ message: expect.stringContaining('MCP_SOURCE_DUPLICATE') })
      })
    it.each(['absent', 'present null', 'malformed encrypted object', 'wrong Redis type'] as const)(
      'keeps the saved-reference %s raw shape separate from key readiness', async boundary => {
        const f = await issueFixture()
        if (boundary === 'absent') await redis.del(f.keyName)
        else if (boundary === 'present null') await redis.json.set(f.keyName, '$', null)
        else if (boundary === 'malformed encrypted object') await redis.json.set(f.keyName, '$', { encrypted: 17, iv: null, authTag: [] })
        else await redis.execute(client => client.set(f.keyName, 'synthetic wrong Redis type'))
        const result = await observeRead(f)
        if (boundary === 'wrong Redis type') {
          expect(result.rejected).toBe(true); expect(result.cut).toBeUndefined(); expect(result.error).toBeInstanceOf(Error)
        } else {
          if (result.rejected) throw result.error
          expect(result.cut?.gateway).toEqual(f.gateway)
          expect(result.cut?.actor).toEqual(f.actor)
          const raw = result.before.values.find(row => row.key === f.keyName)!.raw
          expect(result.cut?.keyRaw).toBe(boundary === 'absent' ? '[]' : raw)
          if (boundary === 'present null') expect(result.cut?.keyRaw).toBe('[null]')
          if (boundary === 'malformed encrypted object') expect(await redis.json.get(f.keyName)).toEqual({ encrypted: 17, iv: null, authTag: [] })
          // The raw observer does not decrypt/vouch for any of these keys.
        }
      })
    it.each(['absent', 'different id', 'different user', 'non-API type', 'wrong Redis type'] as const)(
      'refuses an actor with %s and leaves its actual raw source untouched', async boundary => {
        const f = await issueFixture()
        if (boundary === 'absent') await redis.del(f.actorKey)
        else if (boundary === 'wrong Redis type') await redis.execute(client => client.set(f.actorKey, 'synthetic wrong actor type'))
        else await redis.json.set(f.actorKey, '$', { ...f.actor,
          ...(boundary === 'different id' ? { id: 'another-synthetic-actor' } : {}),
          ...(boundary === 'different user' ? { user_id: 'another-synthetic-user' } : {}),
          ...(boundary === 'non-API type' ? { agentType: 'cli' } : {}) })
        const result = await observeRead(f)
        expect(result.rejected).toBe(true); expect(result.cut).toBeUndefined(); expect(result.error).toBeInstanceOf(Error)
      })
    it.each(['absent', 'explicit null', 'distinct data'] as const)(
      'projects optional incarnation/DCM/source fields as %s from the same actual query', async boundary => {
        const f = await issueFixture(), actor: Record<string, unknown> = { ...f.actor }, gateway: Record<string, unknown> = { ...f.gateway }
        if (boundary === 'absent') delete actor.created_at
        else if (boundary === 'explicit null') {
          actor.dcmDisplaySettings = null; actor.dcm_display_settings = null
          gateway.dcmDisplayDefaults = null
        } else {
          actor.dcmDisplaySettings = { syntheticCamel: false }
          actor.dcm_display_settings = { syntheticSnake: 0 }
          gateway.dcmDisplayDefaults = { syntheticGateway: 'hidden' }
          gateway.toolGroupings = [{ mcpName: 'synthetic-group', toolIds: ['synthetic-tool'] }]
          gateway.metadata = { authToken: 'synthetic-inline-observation-only' }
          gateway.stdioConfig = { command: 'synthetic-never-executed', args: ['synthetic'] }
        }
        await redis.json.set(f.actorKey, '$', actor)
        await redis.json.set(f.registryKey, '$', { gateways: [gateway] })
        const result = await observeRead(f)
        if (result.rejected) throw result.error
        expect(result.cut?.actor).toEqual(actor)
        expect(result.cut?.gateway).toEqual(gateway)
        expect(Object.hasOwn(result.cut!.actor, 'dcmDisplaySettings')).toBe(boundary !== 'absent')
        expect(Object.hasOwn(result.cut!.actor, 'dcm_display_settings')).toBe(boundary !== 'absent')
        expect(Object.hasOwn(result.cut!.actor, 'created_at')).toBe(boundary !== 'absent')
        expect(Object.hasOwn(result.cut!.gateway, 'dcmDisplayDefaults')).toBe(boundary !== 'absent')
        // Inline/auth/DCM data projection is not configuration/use admission.
      })
    it.each(['source', 'actor incarnation', 'DCM data'] as const)(
      'observes controlled %s rotation without normalizing/writing any cut member', async boundary => {
        const f = await issueFixture(), first = await observeRead(f)
        if (first.rejected) throw first.error
        if (boundary === 'source') await redis.json.set(f.registryKey, '$', { gateways: [{ ...f.gateway, enabled: false, url: 'https://synthetic-rotation.invalid/mcp' }] })
        else if (boundary === 'actor incarnation') await redis.json.set(f.actorKey, '$', { ...f.actor, created_at: 'synthetic-replacement-incarnation' })
        else await redis.json.set(f.actorKey, '$', { ...f.actor, dcmDisplaySettings: { syntheticCurrent: true } })
        const next = await observeRead(f)
        if (next.rejected) throw next.error
        expect(next.cut?.keyRaw).toBe(first.cut?.keyRaw)
        if (boundary === 'source') {
          expect(next.cut?.sourceRaw).not.toBe(first.cut?.sourceRaw)
          expect(next.cut?.gateway).toMatchObject({ enabled: false, url: 'https://synthetic-rotation.invalid/mcp' })
          expect(next.cut?.actorIdentityRaw).toBe(first.cut?.actorIdentityRaw)
        } else {
          expect(next.cut?.sourceRaw).toBe(first.cut?.sourceRaw)
          if (boundary === 'actor incarnation') {
            expect(next.cut?.actorIdentityRaw).not.toBe(first.cut?.actorIdentityRaw)
            expect(next.cut?.actor.created_at).toBe('synthetic-replacement-incarnation')
          } else {
            expect(next.cut?.actorIdentityRaw).toBe(first.cut?.actorIdentityRaw) // identity-only hash; actual DCM is separate
            expect(next.cut?.actor.dcmDisplaySettings).toEqual({ syntheticCurrent: true })
          }
        }
      })
  })

})


describe.runIf(REAL_REDIS_LANE)('human source fixed pre-issue facade and real CAS', () => {
  it('checks after actual client acquisition and serialization, and a genuine ended-owner guard issues zero EVAL', async () => {
    const before = { gateways: [customGateway('human-real', 'Shown')] }
    await redis.json.set(KEY, '$', before)
    const raw = await redis.json.getRaw(KEY, '$'), actualExecute = redis.execute.bind(redis)
    let acquired = false, serialized = false, issued = 0
    const stop = new Error('actual source owner stopped before physical issue')
    vi.spyOn(redis, 'execute').mockImplementation(operation => actualExecute(client => {
      acquired = true
      return operation(new Proxy(client, { get(target, key) {
        if (key === 'eval') return (...args: Parameters<typeof client.eval>) => { issued++; return Reflect.apply(target.eval, target, args) }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      } }))
    }))
    await expect(redis.json.setIfUnchanged(KEY, '$', raw!, { toJSON() { serialized = true; return before } }, { beforeIssue() { expect(acquired).toBe(true); expect(serialized).toBe(true); throw stop } })).rejects.toBe(stop)
    expect(issued).toBe(0)
    expect(await redis.json.getRaw(KEY, '$')).toBe(raw)
  })
  it('retains unknown after an actual successful source Lua write loses its answer, without retry or guessed ACK', async () => {
    const gateway = await mcpGatewayService.create(USER, customGateway('human-real', 'Shown'))
    const { humanGatewaySourceRevision } = await import('../mcpGatewayService')
    const shown = humanGatewaySourceRevision(USER, gateway, captureSettingsLifecycle([KEY]))
    const actualExecute = redis.execute.bind(redis)
    let issued = 0, acknowledged = 0
    vi.spyOn(redis, 'execute').mockImplementation(operation => actualExecute(client => operation(new Proxy(client, { get(target, key) {
      if (key === 'eval') return async (script: string, command: { keys: string[]; arguments: string[] }) => {
        const answer = await target.eval(script, command)
        if (command.keys[0] === KEY && script.includes('Unknown compare-and-write operation') && command.arguments[0] === 'SET') { issued++; throw new Error('Synthetic answer loss after actual Lua returned') }
        return answer
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } }))))
    await expect(mcpGatewayService.update(USER, gateway.id, { name: 'Actual Lua stored' }, undefined, { expectedGatewaySource: shown, onSaved() { acknowledged++ } })).rejects.toMatchObject({ code: 'gateway_source_save_unconfirmed', gatewaySaved: false })
    expect(issued).toBe(1); expect(acknowledged).toBe(0)
    expect((await stored(gateway.id)).name).toBe('Actual Lua stored')
  })
})
