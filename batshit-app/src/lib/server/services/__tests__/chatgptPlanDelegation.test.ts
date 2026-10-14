// @vitest-environment node
/** Actual delegated runner, scope resolver, thread storage and SDK; fixture provider only. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.unmock('ai'); vi.unmock('@ai-sdk/openai')
const slot = vi.hoisted(() => ({ runtime: null as any }))
vi.mock('$lib/server/services/chatgptPlanHost', () => ({ getChatgptPlanRuntime: () => slot.runtime }))
vi.mock('$lib/server/services/codexBridge', () => ({ CodexBridge: vi.fn() }))
vi.mock('$lib/server/services/claudeBridge', () => ({ ClaudeBridge: vi.fn() }))
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { ChatgptPlanVault } from '../chatgptPlanVault'
import { ChatgptPlanOAuth } from '../chatgptPlanOAuth'
import { ChatgptPlanRuntime, type PlanLease } from '../chatgptPlanRuntime'
import { VercelAIBrain } from '../vercelBrain'
import { executeManagedSubagent } from '../subagentRunner'
import { buildSubagentThreadKey } from '../subagentThreads'
import { ArtifactsService } from '$lib/server/artifacts/artifactsService'
useRedisTestServer()
const USER = 'sa130-delegate-user', SESSION = 'sa130-delegate-session', PARENT = 'sa130-delegate-parent', PRESET = 'sa130-delegate-preset', SUB = 'sa130-delegate-sub'
let root: string, runtime: ChatgptPlanRuntime, vault: ChatgptPlanVault, subagent: any, bodies: any[], requests: any[], leases: PlanLease[]
beforeEach(async () => {
  if (process.env.VITEST_USE_REAL_REDIS !== 'true') {
    // Artifacts constructs its own RedisService. The default fake exposes its
    // client through execute, whereas production exposes the private getClient.
    // Keep the real artifact listing/Fabric/scope code on the same fake client.
    vi.spyOn(ArtifactsService.prototype as any, 'client').mockImplementation(() => redis.execute(async client => client))
  }
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sa130-delegate-'))); bodies = []; requests = []; leases = []
  vault = new ChatgptPlanVault(root, 'sa130-synthetic-delegate-key-0123456789')
  const row = vault.connect({ userId: USER, issuer: 'https://auth.openai.com', subject: 'Delegate-fixture', clientId: 'oaiapp_Fixture', email: '' }, { accessToken: 'DELEGATE_ACCESS_FIXTURE', refreshToken: 'DELEGATE_REFRESH_FIXTURE', idToken: 'DELEGATE_ID_FIXTURE', scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'], expiresAt: Date.now() + 3600000 }, vault.beginAuthorization(USER))
  const http = vi.fn(async (_url, init) => {
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer DELEGATE_ACCESS_FIXTURE'); bodies.push(JSON.parse(String(init?.body)))
    const events = [{ type: 'response.created', response: { id: 'resp_fixture', created_at: 1790000000, model: 'fixture-model' } }, { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_fixture' } }, { type: 'response.output_text.delta', item_id: 'msg_fixture', output_index: 0, delta: 'Completed delegated fixture.' }, { type: 'response.completed', response: { usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35 } } }]
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  runtime = new ChatgptPlanRuntime(vault, new ChatgptPlanOAuth(vault, async () => true, http), http); slot.runtime = runtime
  const acquire = runtime.acquire.bind(runtime)
  vi.spyOn(runtime, 'acquire').mockImplementation((...args) => { const lease = acquire(...args); leases.push(lease); return lease })
  vi.spyOn(VercelAIBrain.prototype as any, 'buildToolsForMode3').mockResolvedValue({ tools: {}, maps: { workflowTools: new Map(), gatewayTools: new Map(), subagentTools: new Map() }, toolApprovals: {}, ephemeralImages: null })
  const processNative = VercelAIBrain.prototype.processNativeMode
  vi.spyOn(VercelAIBrain.prototype, 'processNativeMode').mockImplementation(function(this: VercelAIBrain, request) { requests.push(request); runtime.assertLease(request.chatgptPlanLease!); return processNative.call(this, request) })
  await redis.set('batshit:sub_system_prompt', 'Fixture delegated identity.')
  const connection = { id: `chatgpt-plan:${row.id}`, type: 'direct', service: 'chatgpt-plan' }
  await redis.set(`model:${PRESET}`, { id: PRESET, provider: 'openai', modelId: 'fixture-model', effectiveModelId: 'fixture-model', connection, settings: {} })
  await redis.createAgent({ id: PARENT, user_id: USER, name: 'Parent', agentType: 'api', primary_model_preset_id: PRESET } as any)
  await redis.createSession({ id: SESSION, user_id: USER, title: 'Fixture delegation', agent_id: PARENT } as any)
  subagent = { id: SUB, user_id: USER, displayName: 'Plan Fixture', slug: 'plan_fixture', subagentType: 'api', primary_model_provider: 'openai', primary_model_name: 'fixture-model', primary_model_preset_id: PRESET, primary_model_connection: connection, defaultMCPGateways: [], defaultMCPToolSelections: [], defaultTools: [], provider_specific_settings: { nativeTools: { bashEnabled: false } }, skills_commands: [] }
  await redis.set(`subagent:${SUB}`, subagent)
})
afterEach(async () => { await runtime.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })
const run = (extra = {}) => executeManagedSubagent({ userId: USER, sessionId: SESSION, parentAgentId: PARENT, chatInput: 'Delegate fixture task.', subagent, ...extra } as any)
describe('ChatGPT delegated execution ownership', () => {
  it('uses the actual API Subagent runner and preserves thread history and its limited authority', async () => {
    const first = await run(); expect(first.status, first.output).toBe('completed'); expect(first.provider).toBe('chatgpt-plan')
    const second = await run({ thread: 'resume', chatInput: 'Continue fixture task.' }); expect(second.status, second.output).toBe('completed'); expect(second.thread).toBe('resumed')
    expect(JSON.stringify(bodies[1].input)).toContain('Delegate fixture task.'); expect(JSON.stringify(bodies[1].input)).toContain('Completed delegated fixture.')
    const stored = await redis.get(buildSubagentThreadKey(SESSION, 'plan_fixture')); expect(JSON.stringify(stored)).toContain('Continue fixture task.')
    requests.forEach(request => { expect(request).toMatchObject({ userId: USER, agentId: PARENT, scopeAgentId: SUB, delegatedBashEnabled: false, allowFabricControlTools: false, memoryControlsEnabled: false, dmControlsEnabled: false, scheduleControlsEnabled: false, judgeControlsEnabled: false, toolApprovalMode: 'off', selectedGateways: [], selectedCliToolIds: [], processOwner: { userId: USER, kind: 'subagent', id: SUB } }); expect(request.chatgptPlanLease).toBeDefined() })
    bodies.forEach(body => expect(body).toMatchObject({ stream: true, store: false }))
    leases.forEach(lease => expect(() => runtime.assertLease(lease)).toThrow())
  })
  it('a Worker uses the same plan lane, parent process owner, no extra PA families and no stored thread', async () => {
    const result = await run({ delegationKind: 'worker', delegationSlug: 'worker_fixture', workerRole: 'Fixture worker' })
    expect(result.status, result.output).toBe('completed'); expect(result.thread).toBeNull(); expect(result.provider).toBe('chatgpt-plan')
    expect(requests[0]).toMatchObject({ processOwner: { userId: USER, kind: 'agent', id: PARENT }, scopeAgentId: SUB, allowFabricControlTools: false, memoryControlsEnabled: false, dmControlsEnabled: false, scheduleControlsEnabled: false, judgeControlsEnabled: false })
    expect(await redis.get(buildSubagentThreadKey(SESSION, 'worker_fixture'))).toBeNull()
    leases.forEach(lease => expect(() => runtime.assertLease(lease)).toThrow())
  })
})
