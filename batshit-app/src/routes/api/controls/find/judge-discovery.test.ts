// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '$env/dynamic/private'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { buildDynamicMcpIndex } from '$lib/server/services/dynamicMcpIndex'
import { findControls, listVisibleControls, useControl } from '$lib/server/services/fabricRegistry'
import { defaultAppActionsPolicy } from '$lib/appActions/settings/managementContract'
import { POST as previewDcm } from '../../mcp/tools/dcm/+server'
import { POST } from './+server'

// Empty unrelated registries: the shared fake has no raw ArtifactsService client or
// gateway-cleanup Lua. Keep the discovery/filter and authenticated actor path real.
vi.mock('$lib/server/artifacts/artifactsService', () => ({
  ArtifactsService: class { async listByUser() { return [] } }
}))
vi.mock('$lib/server/services/mcpSelectionResolver', () => ({
  resolveMCPSelections: vi.fn(async () => ({ resolvedToolSelections: [], resolvedGateways: [] }))
}))

// BL-1572: real route/auth/registry/DCM seam, synthetic default-lane Redis only.
// Unlike agent-lane.test.ts, neither registry discovery function is mocked.
useRedisTestServer()

const USER = 'judge-discovery-user'
const AGENT = 'judge-discovery-primary'
const JUDGE = 'sys.judge.ask'
const SERVICE_TOKEN = 'test-judge-discovery-service-token'
let previousServiceToken: string | undefined
const toggles = {
  fetchZipEnabled: false, dynamicMcpEnabled: false, cliToolsEnabled: false,
  artifactRuntimeEnabled: false, batshitToolsEnabled: true, agentBrowserEnabled: false
}
const agent = {
  id: AGENT, user_id: USER, agentType: 'api', jev_juice_judge_tool: true,
  provider_specific_settings: { nativeTools: toggles }
}
let outbound: ReturnType<typeof vi.fn>

beforeEach(async () => {
  previousServiceToken = (env as Record<string, string | undefined>).BATSHIT_TOKEN
  ;(env as Record<string, string | undefined>).BATSHIT_TOKEN = SERVICE_TOKEN
  await redis.set(`agent:${AGENT}`, agent)
  await redis.set(`subagent:${AGENT}`, { id: AGENT, user_id: USER })
  vi.mocked(redis.get).mockClear()
  outbound = vi.fn(() => { throw new Error('Discovery must not call a provider') })
  vi.stubGlobal('fetch', outbound)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (previousServiceToken === undefined) delete (env as Record<string, string | undefined>).BATSHIT_TOKEN
  else (env as Record<string, string | undefined>).BATSHIT_TOKEN = previousServiceToken
})

async function httpFind(body: Record<string, unknown>, headers: Record<string, string> = {}, userId?: string) {
  return POST({
    locals: userId ? { user: { id: userId } } : {},
    request: new Request('http://localhost/api/controls/find', {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ query: JUDGE, brokerFamilies: ['batshit'], includeSchema: true, ...body })
    })
  } as any)
}

async function withOwnedPolicyRead<T>(run: (readCount: () => number) => Promise<T>) {
  const execute = vi.mocked(redis.execute)
  const original = execute.getMockImplementation()!
  const paths = ['$.id', '$.user_id', '$.agentType', '$.app_action_policy', '$.created_at']
  let reads = 0
  expect(original).toBeTypeOf('function')
  try {
    // Only the fixed authority owner's opaque read reply is supplied on the fake lane.
    // Real validation of identity, saved policy and lifecycle remains in that owner.
    execute.mockImplementation(operation => original(async client => operation(new Proxy(client, {
      get(target, property) {
        if (property !== 'eval') return Reflect.get(target, property)
        return async (script: string, options: { keys: string[]; arguments: string[] }) => {
          if (!script.includes("local out = {'OK'}") || !script.includes('for _, path in ipairs(cjson.decode(ARGV[1]))')) {
            const evaluate = Reflect.get(target, 'eval')
            if (typeof evaluate !== 'function') throw new Error('Unexpected raw operation in owned policy read fixture')
            return evaluate.call(target, script, options)
          }
          expect(options.keys).toEqual([`agent:${AGENT}`])
          expect(options.arguments).toEqual([JSON.stringify(paths)])
          reads += 1
          const row = await client.json.get(`agent:${AGENT}`) as Record<string, unknown> | null
          if (!row) return ['MISSING']
          return ['OK', ...[row.id, row.user_id, row.agentType, row.app_action_policy, row.created_at]
            .map(value => value === undefined ? '[]' : JSON.stringify([value]))]
        }
      }
    }))))
    return await run(() => reads)
  } finally {
    execute.mockImplementation(original)
  }
}

async function humanPreview(body: Record<string, unknown>) {
  const response = await previewDcm({
    locals: { user: { id: USER } }, request: new Request('http://localhost/api/mcp/tools/dcm', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: AGENT, runtime: 'cli', ...body })
    })
  } as never)
  expect(response.status).toBe(200)
  return response.json()
}

async function sessionFind(body: Record<string, unknown> = {}) {
  const response = await httpFind({ ...body, agentId: AGENT }, {}, USER)
  expect(response.status).toBe(200)
  return response.json()
}

describe('Judgment Tool discovery uses the saved opt-in and actor scope (BL-1572)', () => {
  it('session search follows ON → OFF → ON without a cached advertisement', async () => {
    expect((await sessionFind()).results.map((row: any) => row.controlId)).toContain(JUDGE)
    await redis.set(`agent:${AGENT}`, { ...agent, jev_juice_judge_tool: false })
    const off = await sessionFind()
    expect(off.results.map((row: any) => row.controlId)).not.toContain(JUDGE)
    expect(off.totalMatches).toBe(2)
    expect(await sessionFind({ allowedControlIds: ['sys.judge.*'] })).toMatchObject({ results: [], totalMatches: 0 })
    await redis.set(`agent:${AGENT}`, agent)
    expect((await sessionFind()).results.map((row: any) => row.controlId)).toContain(JUDGE)
    expect(outbound).not.toHaveBeenCalled()
  })

  it.each([
    ['absent switch', { ...agent, jev_juice_judge_tool: undefined }],
    ['malformed switch', { ...agent, jev_juice_judge_tool: 'true' }],
    ['Fabric & Utilities OFF', { ...agent, provider_specific_settings: { nativeTools: { ...toggles, batshitToolsEnabled: false } } }],
    ['foreign agent', { ...agent, user_id: 'another-user' }],
    ['retired Primary', { ...agent, agentType: 'n8n' }],
    ['missing agent', null]
  ])('omits %s from the actual registry list and search', async (_label, record) => {
    await redis.set(`agent:${AGENT}`, record)
    const options = { userId: USER, agentId: AGENT, actorType: 'in-process' as const, allowedControlIds: [JUDGE] }
    expect(await listVisibleControls(options)).toEqual([])
    expect(await findControls({ ...options, query: JUDGE })).toMatchObject({ results: [], totalMatches: 0 })
    expect(outbound).not.toHaveBeenCalled()
  })

  it('never lends an enabled Primary utility to a delegated run, even with a colliding scope id and overbroad credential', async () => {
    expect(await findControls({ userId: USER, agentId: AGENT, actorType: 'in-process', delegatedRun: true, scopeAgentId: AGENT, delegatedAllowedControlIds: [JUDGE], query: JUDGE })).toMatchObject({ results: [], totalMatches: 0 })
  })

  it('requires an owned agent context and excludes portable actors', async () => {
    for (const options of [{ userId: USER }, { userId: USER, agentId: AGENT, actorType: 'portable-skill' as const }]) {
      expect(await findControls({ ...options, query: JUDGE, allowedControlIds: [JUDGE] })).toMatchObject({ results: [], totalMatches: 0 })
    }
  })

  it('BL-2239: service, unknown and omitted actor lanes cannot borrow the saved Primary through an agent ID', async () => {
    await redis.set(`agent:${AGENT}`, { ...agent, dms_enabled: true })
    for (const actorType of ['service', 'unknown', undefined] as const) {
      const options = { userId: USER, agentId: AGENT, actorType, allowedControlIds: [JUDGE, 'sys.dm.*', 'sys.schedule.*'] }
      expect(await listVisibleControls(options)).toEqual([])
      expect(await findControls(options)).toMatchObject({ results: [], totalMatches: 0 })
    }
    expect(outbound).not.toHaveBeenCalled()
  })

  it('BL-2239: verified native, in-process and signed-in lanes retain exact caller narrowing', async () => {
    for (const actorType of ['in-process', 'session'] as const) {
      const options = { userId: USER, agentId: AGENT, actorType, allowedControlIds: [JUDGE] }
      expect((await listVisibleControls(options)).map(row => row.controlId)).toEqual([JUDGE])
      expect((await findControls(options)).results.map(row => row.controlId)).toEqual([JUDGE])
    }
    expect(outbound).not.toHaveBeenCalled()
  })

  it('BL-2239: actual service authentication overrides claimed actor fields for all Primary-only families', async () => {
    await redis.set(`agent:${AGENT}`, { ...agent, dms_enabled: true })
    const response = await httpFind({
      agentId: AGENT, actorType: 'agent', controlActorType: 'session',
      query: '', brokerFamilies: ['fabric', 'batshit'], allowedControlIds: [JUDGE, 'sys.dm.*', 'sys.schedule.*']
    }, { 'x-batshit-service-token': SERVICE_TOKEN, 'x-batshit-user-id': USER })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ auth: 'service', results: [], totalMatches: 0 })
    expect(outbound).not.toHaveBeenCalled()
  })

  it('BL-2239: session authentication preserves owned Primary discovery despite spoofed body markers', async () => {
    await redis.set(`agent:${AGENT}`, { ...agent, dms_enabled: true })
    const controls = [JUDGE, 'sys.dm.read', 'sys.schedule.update']
    const body = { query: '', brokerFamilies: ['fabric', 'batshit'], allowedControlIds: controls, actorType: 'service', controlActorType: 'service' }
    const result = await sessionFind(body)
    expect(result.results.map((row: any) => row.controlId).sort()).toEqual([...controls].sort())
    expect(outbound).not.toHaveBeenCalled()
  })

  it('BL-2239: body actor markers without authentication never reach discovery', async () => {
    const response = await httpFind({ userId: USER, agentId: AGENT, actorType: 'agent', controlActorType: 'session' })
    expect(response.status).toBe(401)
    expect(outbound).not.toHaveBeenCalled()
  })

  it('BL-2239: actual typed owned human preview retains enabled Settings metadata, while legacy and forged discovery do not', async () => {
    const pair = ['sys.app_settings.native.change', 'sys.app_settings.native.report']
    const policy = { ...defaultAppActionsPolicy(), enabled: true }
    // SA-139 R4 (D14): App Actions Settings serve an API Primary only; a leftover `cli` Primary is
    // no Settings subject, so this case's owned Primary is an API agent previewed on its own lane.
    await redis.json.set(`agent:${AGENT}`, '$', { ...agent, agentType: 'api', dms_enabled: true,
      created_at: '2026-10-25T00:00:00.000Z', app_action_policy: { generation: 1, policy } })
    const settingsRefs = (value: any) => value.discoverable.map((row: any) => row.ref)
      .filter((ref: string) => pair.some(id => ref === `fabric:${id}`)).sort()
    await withOwnedPolicyRead(async reads => {
      const typed = await humanPreview({ runtime: 'api', subjectKind: 'primary', ownedPrimaryPreview: false, controlActorType: 'service' })
      expect(settingsRefs(typed)).toEqual(pair.map(id => `fabric:${id}`))
      expect(reads()).toBeGreaterThan(0)
      const legacy = await humanPreview({ runtime: 'api', ownedPrimaryPreview: true, primarySettingsActor: true, controlActorType: 'session' })
      expect(settingsRefs(legacy)).toEqual([])
      expect(legacy.discoverable.some((row: any) => row.ref === 'batshit:sys.judge.ask')).toBe(true)
      const options = { userId: USER, agentId: AGENT, allowedControlIds: pair }
      expect((await listVisibleControls({ ...options, actorType: 'in-process' })).map(row => row.controlId)).toEqual(pair)
      for (const caller of [
        { actorType: 'session' as const },
        { actorType: 'service' as const, ownedPrimaryPreview: true },
        { actorType: 'unknown' as const, ownedPrimaryPreview: true },
        { actorType: 'in-process' as const, ownedPrimaryPreview: true, delegatedRun: true, delegatedAllowedControlIds: pair }
      ]) {
        expect(await listVisibleControls({ ...options, ...caller })).toEqual([])
        expect(await findControls({ ...options, ...caller })).toMatchObject({ results: [], totalMatches: 0 })
      }
      const forged = await httpFind({ agentId: AGENT, query: '', allowedControlIds: pair, ownedPrimaryPreview: true }, {}, USER)
      expect(forged.status).toBe(200)
      expect(await forged.json()).toMatchObject({ auth: 'session', results: [], totalMatches: 0 })
      await redis.json.set(`agent:${AGENT}`, '$.app_action_policy', { generation: 2, policy: { ...policy, enabled: false } })
      expect(settingsRefs(await humanPreview({ runtime: 'api', subjectKind: 'primary', ownedPrimaryPreview: true }))).toEqual([])
    })
    expect(outbound).not.toHaveBeenCalled()
  })

  it('BL-2239: session preview metadata never promotes a valid native report into execution authority', async () => {
    const row = { ...agent, created_at: '2026-10-25T00:00:00.000Z',
      app_action_policy: { generation: 1, policy: { ...defaultAppActionsPolicy(), enabled: true } } }
    await redis.json.set(`agent:${AGENT}`, '$', row)
    await withOwnedPolicyRead(async () => {
      const options = {
        userId: USER, agentId: AGENT, sessionId: 'owned-preview-session', actorType: 'session' as const,
        ownedPrimaryPreview: true, controlId: 'sys.app_settings.native.report',
        input: { domain: 'runtime-inspection' }, abortSignal: new AbortController().signal
      }
      const result = await useControl(options)
      expect(result).toMatchObject({ success: false, error: {
        code: 'CONTROL_NOT_ALLOWED', message: 'App Actions management requires a running Primary Agent.'
      } })
      expect(await redis.json.get(`agent:${AGENT}`)).toEqual(row)
    })
    expect(outbound).not.toHaveBeenCalled()
  })

  it('BL-2239: exact Primary read failure remains unavailable in both registry APIs and the authenticated route', async () => {
    const reads = vi.mocked(redis.get)
    const get = reads.getMockImplementation()!
    const failure = new Error('Primary discovery record unavailable')
    expect(get).toBeTypeOf('function')
    reads.mockClear()
    try {
      reads.mockImplementation(async (key, options) => {
        if (key === `agent:${AGENT}` && options?.throwOnError === true) throw failure
        return get(key, options)
      })
      const options = { userId: USER, agentId: AGENT, actorType: 'session' as const, allowedControlIds: [JUDGE] }
      await expect(listVisibleControls(options)).rejects.toBe(failure)
      await expect(findControls(options)).rejects.toBe(failure)
      const response = await httpFind({ agentId: AGENT, allowedControlIds: [JUDGE] }, {}, USER)
      expect(response.status).toBe(500)
      expect(await response.json()).toMatchObject({ success: false, error: failure.message })
      expect(reads.mock.calls.filter(([key, options]) => key === `agent:${AGENT}` && options?.throwOnError === true)).toEqual([
        [`agent:${AGENT}`, { throwOnError: true }], [`agent:${AGENT}`, { throwOnError: true }],
        [`agent:${AGENT}`, { throwOnError: true }]
      ])
      expect(outbound).not.toHaveBeenCalled()
    } finally {
      reads.mockImplementation(get)
    }
  })

  it.each(['api', 'cli'] as const)('%s DCM text, count, family words and hint candidates follow the same saved switch', async runtime => {
    const options = {
      userId: USER, agentId: AGENT, runtime, controlActorType: 'in-process' as const, brokerToggles: toggles,
      allowFabricControlTools: false, nativeDynamicMcpEnabled: false, cliToolsEnabled: false,
      dcmDisplaySettings: { version: 1 as const, groups: { '__fabric_controls__::Fabric Controls': 'group+tools+hints' as const }, tools: {} }
    }
    const on = await buildDynamicMcpIndex(options)
    expect(on.discoverable.map(row => row.ref)).toEqual(['batshit:sys.judge.ask'])
    expect(on.text).toContain('1 tool')
    expect(on.text).toContain('Judge Juice')
    await redis.set(`agent:${AGENT}`, { ...agent, jev_juice_judge_tool: false })
    // A stale explicit enablement from turn setup cannot widen current registry visibility.
    const off = await buildDynamicMcpIndex({ ...options, judgeControlsEnabled: true })
    expect(off.discoverable).toEqual([])
    expect(off.text).toBe('')
    expect(outbound).not.toHaveBeenCalled()
  })

  it.each(['service', 'unknown', undefined] as const)('BL-2239: live index actor %j cannot borrow an enabled Primary from saved IDs or stale feature flags', async controlActorType => {
    await redis.set(`agent:${AGENT}`, { ...agent, dms_enabled: true })
    const index = await buildDynamicMcpIndex({
      userId: USER, agentId: AGENT, runtime: 'api', controlActorType,
      brokerToggles: toggles, allowFabricControlTools: false,
      nativeDynamicMcpEnabled: false, cliToolsEnabled: false,
      judgeControlsEnabled: true, dmControlsEnabled: true, scheduleControlsEnabled: true
    })
    expect(index.discoverable).toEqual([])
    expect(index.text).toBe('')
    expect(outbound).not.toHaveBeenCalled()
  })

  it('preserves raw connected-MCP utility discovery when Judgment Tool is off', async () => {
    await redis.set(`agent:${AGENT}`, { ...agent, jev_juice_judge_tool: false })
    const result = await findControls({ userId: USER, agentId: AGENT, actorType: 'in-process', brokerFamilies: ['batshit'] })
    expect(result.results.map(row => row.controlId)).toEqual(['sys.mcp.dynamic.find', 'sys.mcp.dynamic.use'])
    expect(result.totalMatches).toBe(2)
    expect(outbound).not.toHaveBeenCalled()
  })
})
