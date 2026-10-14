// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('ai')
vi.unmock('@ai-sdk/openai')
const slot = vi.hoisted(() => ({ runtime: null as any, preset: null as any, paidCalls: 0 }))
vi.mock('$lib/server/services/chatgptPlanHost', () => ({ getChatgptPlanRuntime: () => slot.runtime }))
vi.mock('$lib/server/services/providers', () => {
  const factory = () => ({ getModel: () => { slot.paidCalls++; throw new Error('Paid provider must not be used') }, listAvailableModels: () => [] })
  const ProviderManager = vi.fn(function(this: any) { Object.assign(this, factory()) })
  ;(ProviderManager as any).createForUser = vi.fn(async () => factory())
  return { ProviderManager, resolveProviderAccess: vi.fn().mockResolvedValue({ apiKeys: {} }) }
})
vi.mock('$lib/server/redis', () => ({ redis: { get: vi.fn(async () => slot.preset), getUserSettings: vi.fn(async () => null) } }))
import { tool, jsonSchema } from 'ai'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ChatgptPlanVault } from '../chatgptPlanVault'
import { ChatgptPlanOAuth } from '../chatgptPlanOAuth'
import { ChatgptPlanRuntime, PLAN_AGENT, type PlanLease } from '../chatgptPlanRuntime'
import { VercelAIBrain } from '../vercelBrain'
import { generateModelSummary } from '../summaryGeneration'
import { assertPlanApprovalSource } from '../approvalResumeReplay'

const cleanup: (() => void)[] = []
afterEach(() => { for (const release of cleanup.splice(0).reverse()) release(); vi.restoreAllMocks(); slot.preset = null; slot.paidCalls = 0 })
const usage = { input_tokens: 30, output_tokens: 5, total_tokens: 35, input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 0 } }
const created = { type: 'response.created', response: { id: 'resp_fixture', created_at: 1790000000, model: 'fixture-model' } }
const completed = { type: 'response.completed', response: { usage } }
const answer = [created, { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_fixture' } }, { type: 'response.output_text.delta', item_id: 'msg_fixture', output_index: 0, delta: 'Completed fixture answer.' }, { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_fixture' } }, completed]
function setup(events: unknown[][] = [answer]) {
  const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sa130-inference-')))
  const vault = new ChatgptPlanVault(folder, 'synthetic-sa130-inference-instance-key')
  const row = vault.connect({ userId: 'fixture-user', issuer: 'https://auth.openai.com', subject: 'Fixture-subject', clientId: 'oaiapp_Fixture', email: '' }, { accessToken: 'FIXTURE_ACCESS', refreshToken: 'FIXTURE_REFRESH', idToken: 'FIXTURE_ID', scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'], expiresAt: Date.now() + 3600000 }, vault.beginAuthorization('fixture-user'))
  const bodies: Record<string, any>[] = []
  const http = vi.fn(async (_url, init) => {
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer FIXTURE_ACCESS')
    const body = JSON.parse(String(init?.body)); bodies.push(body)
    return new Response(events.shift()!.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  const oauth = new ChatgptPlanOAuth(vault, async () => true, http)
  const runtime = new ChatgptPlanRuntime(vault, oauth, http); slot.runtime = runtime
  const lease = runtime.acquire('fixture-user', row.id, PLAN_AGENT)
  cleanup.push(() => { lease.release(); oauth.close(); vault.close(); rmSync(folder, { recursive: true, force: true }) })
  const connection = { id: `chatgpt-plan:${row.id}`, type: 'direct' as const, service: 'chatgpt-plan' }
  slot.preset = { id: 'fixture-preset', provider: 'openai', modelId: 'fixture-model', effectiveModelId: 'fixture-model', connection, settings: {} }
  return { runtime, vault, row, lease, connection, bodies, http }
}
function request(f: ReturnType<typeof setup>) { return { model: 'fixture-model', connection: f.connection, chatgptPlanLease: f.lease, userId: 'fixture-user', sessionId: 'fixture-session', messages: [{ role: 'system' as const, content: 'Fixture canonical identity' }, { role: 'user' as const, content: '<conversation>prior fixture turn</conversation><current_message>current fixture turn</current_message>' }], providerSettings: {}, maxToolRounds: 3 } }

describe('installed SDK through production plan callsites', () => {
  it.each(['stream', 'delegated'])('runs %s brain namespace tools with full history and no paid provider', async lane => {
    const item = { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'work', namespace: 'batshit', arguments: '{"value":"fixture"}', status: 'completed' }
    const f = setup([[created, { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } }, { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments }, { type: 'response.output_item.done', output_index: 0, item }, completed], answer])
    const work = vi.fn(async (input, options) => { expect(options.abortSignal).toBeInstanceOf(AbortSignal); return { echoed: input.value } })
    const brain = new VercelAIBrain()
    vi.spyOn(brain as any, 'buildToolsForMode3').mockResolvedValue({ tools: { work: tool({ description: 'Fixture', inputSchema: jsonSchema({ type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }), execute: work }) }, maps: { workflowTools: new Map(), gatewayTools: new Map(), subagentTools: new Map() }, toolApprovals: {}, ephemeralImages: null })
    if (lane === 'stream') {
      const result = await brain.streamNativeMode(request(f)); for await (const _part of result.stream) { /* Drain the real loop. */ }
      expect(await result.text).toBe('Completed fixture answer.')
    } else expect((await brain.processNativeMode(request(f))).content).toBe('Completed fixture answer.')
    expect(work).toHaveBeenCalledTimes(1); expect(f.bodies).toHaveLength(2)
    f.bodies.forEach(body => { expect(body.stream).toBe(true); expect(body.store).toBe(false); expect(body.input[0].role).toBe('developer'); expect(body.tools[0].type).toBe('namespace'); expect(body).not.toHaveProperty('max_output_tokens'); expect(body).not.toHaveProperty('prompt_cache_retention') })
    expect(f.bodies[1].input).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function_call_output', call_id: 'call_fixture' })]))
    expect(slot.paidCalls).toBe(0)
  })
  it('Compact streams with an owned lease through caller writes and refuses hidden summary consumers', async () => {
    const f = setup(); let retained: PlanLease | undefined
    const params = { userId: 'fixture-user', agent: { id: 'fixture-agent', agentType: 'api', primary_model_preset_id: 'fixture-preset' } as any, choice: { modelMode: 'current' as const, modelPresetId: null }, prompt: 'Complete fixture history to summarize', summaryHardMaxTokens: 5000 }
    await expect(generateModelSummary(params)).rejects.toMatchObject({ code: 'consumer_unsupported' })
    expect(f.http).not.toHaveBeenCalled()
    const result = await generateModelSummary({ ...params, retainPlanLease: lease => { retained = lease } })
    expect(result.summary).toBe('Completed fixture answer.'); expect(retained).toBeDefined()
    f.runtime.assertLease(retained!) // The route still owns it after generation.
    retained!.release()
    expect(() => f.runtime.assertLease(retained!)).toThrow(/stopped/)
    expect(f.bodies[0]).toMatchObject({ stream: true, store: false }); expect(f.bodies[0]).not.toHaveProperty('max_output_tokens')
    expect(slot.paidCalls).toBe(0)
  })
  it('requires exact saved approval binding, refuses missing/changed/paid provenance', () => {
    const f = setup(), source = { connectionId: f.connection.id, planBinding: f.lease.binding }
    const record = { metadata: { providerMessageSource: source } }
    expect(() => assertPlanApprovalSource(record, source)).not.toThrow()
    for (const expected of [{ connectionId: f.connection.id }, { ...source, planBinding: 'b'.repeat(64) }, { ...source, connectionId: f.connection.id.toUpperCase() }, { connectionId: 'direct:openai' }]) expect(() => assertPlanApprovalSource(record, expected)).toThrow(/different ChatGPT/)
    expect(() => assertPlanApprovalSource({ metadata: {} }, source)).toThrow(/different ChatGPT/)
  })
})
