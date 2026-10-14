// @vitest-environment node
/** Real compiler, installed SDK, SSE handler and saved/reloaded replies; synthetic provider only. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.unmock('ai'); vi.unmock('@ai-sdk/openai')
const slot = vi.hoisted(() => ({ runtime: null as any }))
vi.mock('$lib/server/services/chatgptPlanHost', () => ({ getChatgptPlanRuntime: () => slot.runtime }))
vi.mock('$lib/server/services/nativeTools', async original => ({ ...(await original<Record<string, unknown>>()), nativeToolService: { cleanupExecutionSandboxesForSession: vi.fn(async () => []) } }))
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { env } from '$env/dynamic/private'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { ChatgptPlanVault } from '$lib/server/services/chatgptPlanVault'
import { ChatgptPlanOAuth } from '$lib/server/services/chatgptPlanOAuth'
import { ChatgptPlanRuntime } from '$lib/server/services/chatgptPlanRuntime'
import { VercelAIBrain } from '$lib/server/services/vercelBrain'
import { ProviderManager } from '$lib/server/services/providers'
import { createOpenAI } from '@ai-sdk/openai'
import { jsonSchema, tool } from 'ai'
import { nativeToolService } from '$lib/server/services/nativeTools'
import { __resetReplyRecordsForTests, listReplayEvents } from '$lib/server/services/replyStreamRecord'
import { __resetStreamAbortRegistryForTests } from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests } from '$lib/server/services/steerInboxRegistry'
import { POST as send } from './+server'
import { GET as openHub, PATCH as subscribe, POST as forward } from '../../sse/+server'
import { closeSseExternalSubscriber } from '$lib/server/sseExternalSubscriber'
import { registerWakeRun, __resetWakeRunRegistryForTests } from '$lib/server/services/wakeRunRegistry'
import { extractZipIdFromReference } from '$lib/utils/zipReferenceSafety'
import { GET as reload } from '../[sessionId]/+server'
import { POST as interrupt } from '../interrupt/+server'
useRedisTestServer()
const USER = 'sa130-send-user', AGENT = 'sa130-send-agent', PRESET = 'sa130-send-preset', SESSION = 'sa130-send-session', REPLY = 'sa130-send-reply'
let vault: ChatgptPlanVault, runtime: ChatgptPlanRuntime, root: string
let bodies: any[], forwards: any[], storedAtEnd: any, complete = true
let stopAfterText: (() => void) | undefined
let pendingProvider: ReadableStreamDefaultController<Uint8Array> | undefined
let providerHttp: typeof fetch, expectedBearer: string, groupReply: boolean, callTool: boolean
let toolItem: Record<string, string> | undefined
const token = 'sa130-synthetic-internal-token-0123456789'
const previousToken = (env as any).BATSHIT_TOKEN
beforeEach(async () => {
  ;(env as any).BATSHIT_TOKEN = token
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sa130-send-')))
  vault = new ChatgptPlanVault(root, 'sa130-synthetic-send-instance-key-0123456789')
  const row = vault.connect({ userId: USER, issuer: 'https://auth.openai.com', subject: 'Send-fixture', clientId: 'oaiapp_Sendfixture', email: '' }, { accessToken: 'SEND_ACCESS_SENTINEL', refreshToken: 'SEND_REFRESH_SENTINEL', idToken: 'SEND_ID_SENTINEL', scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'], expiresAt: Date.now() + 3600000 }, vault.beginAuthorization(USER))
  bodies = []; forwards = []; storedAtEnd = undefined; complete = true; stopAfterText = undefined; pendingProvider = undefined
  expectedBearer = 'Bearer SEND_ACCESS_SENTINEL'; groupReply = false; callTool = false; toolItem = undefined
  const http = vi.fn(async (_url, init) => {
    expect(new Headers(init?.headers).get('Authorization')).toBe(expectedBearer)
    bodies.push(JSON.parse(String(init?.body)))
    let events: any[] = [
      { type: 'response.created', response: { id: 'resp_fixture', created_at: 1790000000, model: 'fixture-model' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_fixture' } },
      { type: 'response.output_text.delta', item_id: 'msg_fixture', output_index: 0, delta: (groupReply ? '<batshit-group>{"mode":"responding"}</batshit-group>' : '') + 'Saved fixture reply.' },
      ...(complete ? [{ type: 'response.completed', response: { usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35 } } }] : []),
    ]
    if (callTool && bodies.length === 1) {
      const item = { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'fixture_echo', namespace: 'batshit', arguments: '{"value":"fixture"}', status: 'completed', ...toolItem }
      events = [events[0], { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } }, { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments }, { type: 'response.output_item.done', output_index: 0, item }, events.at(-1)]
    }
    const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); if (stopAfterText) { pendingProvider = controller; init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true }) } else controller.close() } })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  providerHttp = http
  runtime = new ChatgptPlanRuntime(vault, new ChatgptPlanOAuth(vault, async () => true, http), http); slot.runtime = runtime
  vi.spyOn(VercelAIBrain.prototype as any, 'buildToolsForMode3').mockResolvedValue({ tools: {}, maps: { workflowTools: new Map(), gatewayTools: new Map(), subagentTools: new Map() }, toolApprovals: {}, ephemeralImages: null })
  vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {})
  __resetReplyRecordsForTests(); __resetStreamAbortRegistryForTests(); __resetSteerInboxRegistryForTests()
  await redis.set(`model:${PRESET}`, { id: PRESET, provider: 'openai', modelId: 'fixture-model', effectiveModelId: 'fixture-model', modelName: 'Fixture', connection: { id: `chatgpt-plan:${row.id}`, type: 'direct', service: 'chatgpt-plan' }, settings: {}, pricing: {}, contextWindow: 10000 })
  await redis.createAgent({ id: AGENT, user_id: USER, name: 'Fixture', agentType: 'api', primary_model_preset_id: PRESET, memory_enabled: false, tool_approval_mode: 'all' } as any)
  await redis.createSession({ id: SESSION, user_id: USER, title: 'Synthetic plan proof', agent_id: AGENT } as any)
})
afterEach(async () => {
  await runtime.close(); rmSync(root, { recursive: true, force: true }); slot.runtime = null
  await closeSseExternalSubscriber(); __resetWakeRunRegistryForTests()
  vi.restoreAllMocks(); __resetReplyRecordsForTests(); __resetStreamAbortRegistryForTests(); __resetSteerInboxRegistryForTests()
  ;(env as any).BATSHIT_TOKEN = previousToken
})
async function stored() { return redis.execute(client => client.json.get(`message:${SESSION}:${REPLY}`)) as Promise<any> }
async function sseFetch(input: RequestInfo | URL, init?: RequestInit) {
  if (!String(input).endsWith('/api/sse')) return new Response('{}')
  const event = JSON.parse(String(init?.body)); forwards.push(event)
  if (event.type === 'end') storedAtEnd = await stored()
  const response = await forward({ request: new Request(String(input), init), locals: { user: { id: USER } } } as any)
  if (event.type === 'chunk' && event.content?.includes('Saved fixture reply.')) stopAfterText?.()
  return response
}
function run(signal?: AbortSignal, extra: Record<string, unknown> = {}) {
  return send({ request: new Request('http://127.0.0.1:45671/api/messages/send-routed', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: SESSION, agentId: AGENT, agentType: 'api', content: 'Current fixture question.', messageId: REPLY, messages: [{ id: 'prior-user', role: 'user', content: 'Earlier fixture question.' }, { id: 'prior-assistant', role: 'assistant', content: 'Earlier fixture answer.' }, { id: 'current-user', role: 'user', content: 'Current fixture question.' }], ...extra }) }), fetch: sseFetch, locals: { user: { id: USER } } } as any)
}
describe('plan ordinary API reply contract', () => {
  it.each([
    { vision: true, finished: true },
    { vision: undefined, finished: true },
    { vision: undefined, finished: true, modelId: 'gpt-6-astra' },
    { vision: true, finished: false }
  ])('compiles a stored image Clip once through the installed SDK; %j', async ({ vision, finished, modelId = 'fixture-model' }) => {
    complete = finished
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const image = `data:image/png;base64,${base64}`
    await redis.set('upload:clips:sa130-pixel.png', { mimetype: 'image/png', base64 })
    await redis.set(`clip:${USER}:sa130-image`, { id: 'sa130-image', filename: 'sa130-pixel.png', fileType: 'image', mimeType: 'image/png', localUrl: '/uploads/clips/sa130-pixel.png', externalTokens: 765, fileSize: 68 })
    await redis.set(`session:${SESSION}:clip_state`, { sessionId: SESSION, clips: [{ clipId: 'sa130-image' }] })
    const preset = await redis.get(`model:${PRESET}`) as any
    const rawPreset = { ...preset, modelId, effectiveModelId: modelId, capabilities: vision === undefined ? {} : { vision } }
    await redis.set(`model:${PRESET}`, rawPreset)
    const response = await run()
    expect(response.status, JSON.stringify(await response.json())).toBe(finished ? 200 : 502)
    expect(bodies).toHaveLength(1)
    expect(bodies[0].model).toBe(modelId)
    expect(await redis.get(`model:${PRESET}`)).toEqual(rawPreset)
    expect(bodies[0]).toMatchObject({ stream: true, store: false })
    expect(bodies[0].max_output_tokens).toBeUndefined()
    const parts = bodies[0].input.flatMap((item: any) => Array.isArray(item.content) ? item.content : [])
    const images = parts.filter((part: any) => part.type === 'input_image')
    expect(images).toHaveLength(1)
    expect(images[0].image_url).toBe(image)
    const text = parts.filter((part: any) => part.type === 'input_text').map((part: any) => part.text).join('\n')
    for (const history of ['Earlier fixture question.', 'Earlier fixture answer.', 'Current fixture question.']) expect(text).toContain(history)
    expect(text).not.toContain(base64)
    expect(text).not.toContain('data:image/')
    const saved = await stored()
    expect(saved.content).toContain('Saved fixture reply.')
    expect(saved.metadata.response_failed === true).toBe(!finished)
    expect(storedAtEnd.content).toBe(saved.content)
    expect(storedAtEnd.metadata.response_failed === true).toBe(!finished)
    const reloaded = await reload({ params: { sessionId: SESSION }, url: new URL('http://fixture/api/messages/' + SESSION), locals: { user: { id: USER } } } as any)
    const reloadReply = (await reloaded.json()).find((message: any) => message.id === REPLY)
    expect(reloadReply.content).toBe(saved.content)
    expect(reloadReply.metadata.response_failed === true).toBe(!finished)
  }, 30000)
  it.each(['fixture-model', 'gpt-6-astra'])('preserves a saved text-only restriction before image inference; model=%s', async modelId => {
    await redis.set(`clip:${USER}:sa130-image`, { id: 'sa130-image', filename: 'pixel.png', fileType: 'image', mimeType: 'image/png', localBase64: 'data:image/png;base64,aW1hZ2U=', externalTokens: 765 })
    await redis.set(`session:${SESSION}:clip_state`, { sessionId: SESSION, clips: [{ clipId: 'sa130-image' }] })
    const preset = await redis.get(`model:${PRESET}`) as any
    const rawPreset = { ...preset, modelId, effectiveModelId: modelId, capabilities: { vision: false } }
    await redis.set(`model:${PRESET}`, rawPreset)
    expect((await run()).status).toBe(422)
    expect(bodies).toHaveLength(0)
    expect(await redis.get(`model:${PRESET}`)).toEqual(rawPreset)
    expect(await stored()).toMatchObject({ status: 'error', metadata: { error_code: 'IMAGE_INPUT_UNSUPPORTED', response_failed: true, http_status: 422 } })
  }, 30000)
  it.each([true, false])('uses the real canonical compiler and saves before end; completed=%s', async finished => {
    complete = finished
    const response = await run()
    expect(response.status).toBe(finished ? 200 : 502)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ stream: true, store: false })
    expect(bodies[0].input[0].role).toBe('developer')
    const wire = JSON.stringify(bodies[0].input)
    for (const text of ['Earlier fixture question.', 'Earlier fixture answer.', 'Current fixture question.']) expect(wire).toContain(text)
    const saved = await stored()
    expect(saved.content).toContain('Saved fixture reply.')
    expect(saved.status).toBe('complete') // Finished persistence, with failure carried beside the preserved text.
    expect(saved.metadata.response_failed === true).toBe(!finished)
    expect(saved.metadata.replySavedFromOwnCopy).toBeUndefined()
    if (finished) expect(saved.metadata.providerMessageSource.planBinding).toMatch(/^[a-f0-9]{64}$/)
    expect(storedAtEnd.content).toBe(saved.content)
    const reloaded = await reload({ params: { sessionId: SESSION }, url: new URL('http://fixture/api/messages/' + SESSION), locals: { user: { id: USER } } } as any)
    expect((await reloaded.json()).find((message: any) => message.id === REPLY)).toMatchObject({ content: saved.content, status: saved.status })
    const replay = listReplayEvents(SESSION)
    expect(replay.some(event => event.type === 'chunk' && event.content.includes('Saved fixture reply.'))).toBe(true)
    const evidence = JSON.stringify({ saved, forwards, replay, executionLog: await redis.get(`session:${SESSION}:execution_log`), errors: (console.error as any).mock.calls, warnings: (console.warn as any).mock.calls })
    for (const sentinel of ['SEND_ACCESS_SENTINEL', 'SEND_REFRESH_SENTINEL', 'SEND_ID_SENTINEL']) expect(evidence).not.toContain(sentinel)
  }, 30000)
  it('Stop preserves streamed text, prevents terminal success and releases the owned request', async () => {
    complete = false
    const stop = new AbortController(); stopAfterText = () => stop.abort('fixture-user-stop')
    expect((await run(stop.signal)).status).toBe(499)
    expect(pendingProvider).toBeDefined()
    const saved = await stored(); expect(saved.content).toContain('Saved fixture reply.'); expect(saved.metadata.interrupted).toBe(true)
    expect(forwards.find(event => event.type === 'end').metadata.interrupted).toBe(true)
    const account = vault.list(USER)[0]
    vi.spyOn(runtime.oauth, 'revoke').mockResolvedValue(true)
    expect(await runtime.disconnect(USER, account.id)).toEqual({ remoteRevocation: 'confirmed' })
  }, 30000)
  it('rejects an approval from an earlier account incarnation before recording its answer or making a request', async () => {
    const row = vault.list(USER)[0]
    const connectionId = `chatgpt-plan:${row.id}`, oldBinding = vault.binding(row)
    await redis.saveMessage({ id: REPLY, session_id: SESSION, user_id: USER, agent_id: AGENT, role: 'assistant', content: 'Pending fixture approval.', metadata: { providerMessageSource: { providerId: 'openai', connectionId, modelId: 'fixture-model', planBinding: oldBinding }, toolApprovals: { mode: 'all', source: 'vercel', approvals: [{ approvalId: 'fixture-approval', status: 'pending', requestedAt: new Date().toISOString(), toolName: 'native_bash_execute', input: { command: 'synthetic-never-executed' }, source: 'vercel' }] } } } as any)
    vi.spyOn(runtime.oauth, 'revoke').mockResolvedValue(true)
    await runtime.disconnect(USER, row.id)
    vault.connect({ userId: USER, issuer: row.issuer, subject: row.subject, clientId: row.clientId, email: '' }, { accessToken: 'NEW_SEND_FIXTURE', refreshToken: 'NEW_REFRESH_FIXTURE', idToken: 'NEW_ID_FIXTURE', scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'], expiresAt: Date.now() + 3600000 }, vault.beginAuthorization(USER), vault.get(USER, row.id))
    const response = await run(undefined, { content: '', metadata: { toolApprovalMode: 'all', toolApprovalResponse: [{ type: 'tool-approval-response', approvalId: 'fixture-approval', approved: true }] } })
    expect(response.status, JSON.stringify(await response.json())).toBe(409); expect(bodies).toHaveLength(0)
    const saved = await stored()
    expect(saved.metadata.answeredApprovalIds).toBeUndefined()
    expect(saved.metadata.toolApprovals.approvals[0].status).toBe('pending')
  }, 30000)
  it('paid OpenAI also rejects premature EOF through the real saved reply handler (BL-1044)', async () => {
    complete = false; expectedBearer = 'Bearer PAID_KEY_FIXTURE'
    const model = createOpenAI({ apiKey: 'PAID_KEY_FIXTURE', fetch: providerHttp }).responses('fixture-model')
    vi.spyOn(ProviderManager, 'createForUser').mockResolvedValue({ getModel: () => model } as any)
    const preset = await redis.get(`model:${PRESET}`) as any
    await redis.set(`model:${PRESET}`, { ...preset, connection: { id: 'direct:openai', service: 'openai', type: 'direct' } })
    const response = await run(); expect(response.status).toBeGreaterThanOrEqual(400)
    expect(bodies).toHaveLength(1)
    const saved = await stored(); expect(saved.content).toContain('Saved fixture reply.')
    expect(saved.metadata.response_failed).toBe(true)
    expect(storedAtEnd.metadata.response_failed).toBe(true)
    expect(listReplayEvents(SESSION).some(event => event.type === 'end' && event.metadata?.response_failed === true)).toBe(true)
    expect(listReplayEvents(SESSION).at(-1)?.type).toBe('error')
  }, 30000)
  it.each([true, false])('Disconnect waits for actual outer cleanup, completed=%s (BL-1055)', async finished => {
    complete = finished
    let entered!: () => void, finishCleanup!: () => void
    const arrived = new Promise<void>(resolve => { entered = resolve })
    const barrier = new Promise<void>(resolve => { finishCleanup = resolve })
    ;(nativeToolService.cleanupExecutionSandboxesForSession as any).mockImplementation(async () => { if (storedAtEnd) { entered(); await barrier } return [] })
    vi.spyOn(runtime.oauth, 'revoke').mockResolvedValue(true)
    const sending = run(); await arrived
    let disconnected = false
    const disconnect = runtime.disconnect(USER, vault.list(USER)[0].id).then(result => { disconnected = true; return result })
    try {
      // Disconnect's local fence applies immediately, but the actual owner remains.
      expect(vault.list(USER)[0].state).toBe('disconnected')
      await new Promise<void>(resolve => setImmediate(resolve)); expect(disconnected).toBe(false)
      expect(storedAtEnd.content).toContain('Saved fixture reply.')
    } finally { finishCleanup() }
    expect((await sending).status).toBe(finished ? 200 : 502)
    expect(await disconnect).toEqual({ remoteRevocation: 'confirmed' }); expect(disconnected).toBe(true)
  }, 30000)
  it('group members use the same outer request owner and full canonical speaker history', async () => {
    groupReply = true
    const other = `${AGENT}-other`, group = 'sa130-send-group'
    await redis.createAgent({ id: other, user_id: USER, name: 'Other Fixture', displayName: 'Other Fixture', agentType: 'api', primary_model_preset_id: PRESET, memory_enabled: false, tool_approval_mode: 'off' } as any)
    await redis.execute(client => client.json.set(`group:${group}`, '$', { id: group, user_id: USER, name: 'Fixture Group', agent_ids: [AGENT, other], driver_mode: true, driver_agent_id: AGENT, max_followups_total: 1 }))
    await redis.execute(client => client.json.set(`session:${SESSION}`, '$.metadata', { group_chat: { group_id: group } }))
    // Default Redis fake lacks this store facade; keep group reads on its actual
    // JSON client. The real-Redis lane exercises production getGroup unchanged.
    const descriptor = Object.getOwnPropertyDescriptor(redis, 'getGroup')
    if (typeof redis.getGroup !== 'function') Object.defineProperty(redis, 'getGroup', { configurable: true, value: (id: string) => redis.execute(client => client.json.get(`group:${id}`)) })
    let response: Response
    try { response = await run() } finally { if (!descriptor && process.env.VITEST_USE_REAL_REDIS !== 'true') delete (redis as any).getGroup }
    expect(response.status, JSON.stringify(await response.json())).toBe(200)
    expect(bodies).toHaveLength(2)
    bodies.forEach(body => expect(body).toMatchObject({ stream: true, store: false }))
    expect(JSON.stringify(bodies[1].input)).toContain('Saved fixture reply.')
    vi.spyOn(runtime.oauth, 'revoke').mockResolvedValue(true)
    expect(await runtime.disconnect(USER, vault.list(USER)[0].id)).toEqual({ remoteRevocation: 'confirmed' })
  }, 30000)
  it('a real namespaced client tool loop persists its canonical tool result and completes the reply', async () => {
    callTool = true
    const execute = vi.fn(async (input: any, options: any) => { expect(options.abortSignal).toBeInstanceOf(AbortSignal); return { echoed: input.value } })
    ;(VercelAIBrain.prototype as any).buildToolsForMode3.mockResolvedValue({ tools: { fixture_echo: tool({ description: 'Synthetic echo', inputSchema: jsonSchema({ type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }), execute }) }, maps: { workflowTools: new Map(), gatewayTools: new Map(), subagentTools: new Map() }, toolApprovals: {}, ephemeralImages: null })
    const response = await run(); expect(response.status, JSON.stringify(await response.json())).toBe(200)
    expect(execute).toHaveBeenCalledTimes(1); expect(bodies).toHaveLength(2)
    expect(bodies[0].tools[0].type).toBe('namespace')
    expect(bodies[1].input).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function_call_output', call_id: 'call_fixture' })]))
    const saved = await stored(); expect(saved.content).toContain('Saved fixture reply.')
    expect(saved.intermediateSteps).toHaveLength(1)
    expect(saved.intermediateSteps[0].toolName, JSON.stringify(saved.intermediateSteps)).toBe('fixture_echo')
    expect(saved.intermediateSteps[0].toolResult, JSON.stringify(saved.intermediateSteps)).toBeDefined()
    const references = forwards.find(event => event.type === 'end').zipReferences
    expect(references).toHaveLength(1)
    const zipId = extractZipIdFromReference(references[0].reference)
    expect(zipId).toBeTruthy()
    expect(await redis.get(`zip:${zipId}`)).toBeTruthy()
  }, 30000)
  it('a server-vouched headless wake uses plan inference without browser identity', async () => {
    registerWakeRun({ sessionId: SESSION, agentId: AGENT, userId: USER, origin: { version: 1, kind: 'dm', label: 'Fixture DM', at: new Date().toISOString(), chainDepth: 1, dmId: 'fixture-dm' }, startedAt: Date.now(), controller: new AbortController(), timer: setTimeout(() => {}, 60000), assistantMessageId: REPLY } as any)
    const response = await send({ request: new Request('http://127.0.0.1:45671/api/messages/send-routed', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-batshit-service-token': token, 'x-internal-api-request': '1' }, body: JSON.stringify({ sessionId: SESSION, agentId: AGENT, userId: USER, messageId: REPLY, content: 'Fixture server-vouched wake.', messages: [{ id: 'wake-user', role: 'user', content: 'Fixture server-vouched wake.' }], metadata: { wake: { chainDepth: 1, dmId: 'fixture-dm' } } }) }), fetch: sseFetch, locals: {} } as any)
    expect(response.status, JSON.stringify(await response.json())).toBe(200); expect(bodies).toHaveLength(1)
    expect((await stored()).metadata.providerMessageSource.planBinding).toMatch(/^[a-f0-9]{64}$/)
  }, 30000)
  it.skipIf(process.env.VITEST_USE_REAL_REDIS !== 'true')('two actual live hub spectators agree with the saved completed reply', async () => {
    const readers: ReadableStreamDefaultReader<any>[] = []
    async function spectator(id: string) {
      const response = await openHub({ url: new URL('http://fixture/api/sse?scope=hub'), locals: { user: { id: USER } } } as any)
      const reader = response.body!.getReader(); readers.push(reader)
      const decoder = new TextDecoder()
      // Direct route Responses carry strings; the real HTTP adapter encodes those bytes.
      const decode = (value: unknown) => typeof value === 'string' ? value : decoder.decode(value as Uint8Array)
      const first = decode((await reader.read()).value)
      const connected = JSON.parse(first.match(/data: (.+)/)![1])
      const added = await subscribe({ request: new Request('http://fixture/api/sse', { method: 'PATCH', body: JSON.stringify({ hubId: connected.hubId, add: [{ id, scope: 'session', sessionId: SESSION }] }) }), locals: { user: { id: USER } } } as any)
      expect(added.status).toBe(200)
      const wire = (async () => { let text = ''; for (;;) { const next = await reader.read(); if (next.done) break; text += decode(next.value); if (text.includes('"type":"end"')) break } return text })()
      return { wire }
    }
    try {
      const first = await spectator('fixture-a'), second = await spectator('fixture-b')
      expect((await run()).status).toBe(200)
      const snapshots = await Promise.all([first.wire, second.wire])
      snapshots.forEach(wire => { expect(wire).toContain('Saved fixture reply.'); expect(wire).toContain('"type":"end"'); expect(wire).not.toContain('SEND_ACCESS_SENTINEL') })
      expect((await stored()).content).toContain('Saved fixture reply.')
    } finally { await Promise.all(readers.map(reader => reader.cancel())) }
  }, 30000)
})

// BL-1056: independent reviewer reproduction retained in both lanes.
it('independent race: disconnect before grant commit cannot approve the control', async () => {
  const broker = await import('$lib/server/services/brokerControlApprovals')
  const controls = await import('$lib/server/services/controlApprovals')
  const row = vault.list(USER)[0], binding = vault.binding(row)
  const approvalId = 'fixture-approval', callId = 'fixture-call'
  const input = { memory_id: 'fixture-no-execution' }
  const control = await controls.createPendingApproval({ userId: USER, agentId: AGENT, sessionId: SESSION, messageId: REPLY, controlId: 'sys.memory.delete', controlTitle: 'Delete Memory', riskLevel: 'confirm', lane: 'api', input, sdkApprovalId: approvalId, toolCallId: callId })
  const toolCall = { type: 'tool-call', toolCallId: callId, toolName: 'native_batshit_tool_use', input: { ref: 'fabric:sys.memory.delete', input } }
  const current = { id: 'current-user', session_id: SESSION, user_id: USER, role: 'user', content: 'Current fixture question.' }
  const card = { id: REPLY, session_id: SESSION, user_id: USER, agent_id: AGENT, role: 'assistant', content: 'Pending fixture approval.', metadata: {
    providerMessageSource: { providerId: 'openai', connectionId: `chatgpt-plan:${row.id}`, modelId: 'fixture-model', planBinding: binding },
    providerMessages: [{ role: 'assistant', content: [toolCall, { type: 'tool-approval-request', approvalId, toolCall }] }],
    toolApprovals: { mode: 'all', source: 'vercel', approvals: [{ approvalId, status: 'pending', requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now()+180000).toISOString(), toolName: toolCall.toolName, input: toolCall.input, toolCall, source: 'vercel', control: { approvalId: control.id, controlId: control.controlId, controlTitle: control.controlTitle, riskLevel: 'confirm', input, lane: 'api' } }] }
  } }
  await redis.saveMessage(current as any); await redis.saveMessage(card as any)
  let disconnect: Promise<unknown> | undefined, reached = false
  vi.spyOn(runtime.oauth, 'revoke').mockResolvedValue(true)
  const actual = broker.resolveApprovalResumeGrants
  vi.spyOn(broker, 'resolveApprovalResumeGrants').mockImplementation(async args => {
    reached = true
    disconnect = runtime.disconnect(USER, row.id)
    return actual(args)
  })
  const response = await run(undefined, { content: '', messages: [current, card], metadata: { toolApprovalMode: 'all', toolApprovalResponse: [{ type: 'tool-approval-response', approvalId, approved: true }] } })
  await disconnect
  expect(reached, `grant boundary not reached; status=${response.status}; body=${await response.text()}`).toBe(true)
  expect(bodies).toHaveLength(0)
  expect((await controls.getControlApproval(control.id))?.status, 'control acquired durable approval after account disconnect').toBe('pending')
}, 30000)


it('refuses an approval answer when Disconnect begins at its actual save boundary (BL-1056)', async () => {
  const answers = await import('$lib/server/services/approvalAnswerRecord')
  const row = vault.list(USER)[0], binding = vault.binding(row), approvalId = 'answer-race-fixture'
  const card = { id: REPLY, session_id: SESSION, user_id: USER, agent_id: AGENT, role: 'assistant', content: 'Pending answer.', metadata: {
    providerMessageSource: { providerId: 'openai', connectionId: `chatgpt-plan:${row.id}`, modelId: 'fixture-model', planBinding: binding },
    toolApprovals: { mode: 'all', source: 'vercel', approvals: [{ approvalId, status: 'pending', requestedAt: new Date().toISOString(), toolName: 'native_bash_execute', input: { command: 'never-executed' }, source: 'vercel' }] }
  } }
  await redis.saveMessage(card as any)
  vi.spyOn(runtime.oauth, 'revoke').mockResolvedValue(true)
  let disconnect: Promise<unknown> | undefined, reached = false
  const actual = answers.answerApprovalsOnce
  vi.spyOn(answers, 'answerApprovalsOnce').mockImplementation(options => actual({ ...options, mutate: write => {
    reached = true; disconnect = runtime.disconnect(USER, row.id)
    return options.mutate!(write)
  } }))
  const response = await run(undefined, { content: '', messages: [card], metadata: { toolApprovalMode: 'all', toolApprovalResponse: [{ type: 'tool-approval-response', approvalId, approved: true }] } })
  await disconnect
  expect(reached).toBe(true); expect(response.status).toBeGreaterThanOrEqual(400); expect(bodies).toHaveLength(0)
  const saved = await stored(); expect(saved.metadata.answeredApprovalIds).toBeUndefined()
  expect(saved.metadata.toolApprovals.approvals[0].status).toBe('pending')
}, 30000)

// SA-122 B1: the actual originating API chain into the fixed Settings owners, model-free. The
// synthetic provider chooses the call (a mocked scheduler); the send, brain, real native builder,
// SDK approval policy, consent record, interrupt route, Fabric and Settings owner are the real code.
// No real provider transport. The Settings store needs real Redis (EVAL), so the lane is real only.
describe.skipIf(process.env.VITEST_USE_REAL_REDIS !== 'true')('SA-122 B1 originating Settings boundary', () => {
  const HISTORY = [{ id: 'prior-user', role: 'user', content: 'Earlier fixture question.' }, { id: 'prior-assistant', role: 'assistant', content: 'Earlier fixture answer.' }, { id: 'current-user', role: 'user', content: 'Current fixture question.' }]
  const OWNER = { actor: { kind: 'agent' as const, userId: USER, actingAgentId: AGENT }, check() {} }
  const buildErrors = () => (console.error as any).mock.calls.filter((call: unknown[]) => String(call[0]).includes('Failed to build native tools'))
  const errors = () => JSON.stringify((console.error as any).mock.calls.map((call: unknown[]) => call.map(part => part instanceof Error ? part.message : String(part)).join(' ')).slice(0, 8))
  // The harness stubs nativeToolService (line 7) and the brain's builder (beforeEach). Only these
  // cases put the real builder and risk target back, and `finally` removes both again; the next
  // beforeEach re-stubs the builder. Every global fetch is recorded and fails the case: the provider is
  // the injected synthetic `http`, and nothing on this path may use the network.
  async function withRealBuilder(body: (fetched: string[]) => Promise<void>) {
    const native = await import('$lib/server/services/nativeTools')
    ;(VercelAIBrain.prototype as any).buildToolsForMode3.mockRestore()
    Object.assign(nativeToolService, { buildMode3NativeTools: native.buildMode3NativeTools, resolveBrokerRiskApprovalTarget: native.resolveBrokerRiskApprovalTarget })
    const realFetch = globalThis.fetch, fetched: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetched.push(input instanceof Request ? input.url : String(input))
      return new Response('{}', { status: 503 })
    }) as typeof fetch
    try { await body(fetched) } finally {
      globalThis.fetch = realFetch
      delete (nativeToolService as any).buildMode3NativeTools
      delete (nativeToolService as any).resolveBrokerRiskApprovalTarget
    }
  }
  function brokerCall(controlId: string, input: Record<string, unknown>) {
    toolItem = { name: 'native_batshit_tool_use', arguments: JSON.stringify({ ref: `fabric:${controlId}`, input }) }
    callTool = true
  }
  async function agentRecord() { return await redis.execute(client => client.json.get(`agent:${AGENT}`)) as any }
  // A-1y (LS-067/LS-068): the agent's own Settings save is announced on the user channel. A pass-through
  // spy: the real publisher still runs. Each announcement records the stored record at that moment.
  async function watchAgentSettingsAnnouncements() {
    const publisher = await import('$lib/server/ssePublisher')
    const seen: Array<{ userId: string; event: Record<string, unknown>; recordThen: any }> = []
    const actual = publisher.publishUserEvent
    vi.spyOn(publisher, 'publishUserEvent').mockImplementation(async (userId, event) => {
      if (event?.type === 'agent_settings_changed') seen.push({ userId, event, recordThen: await agentRecord() })
      return actual(userId, event)
    })
    return seen
  }
  // A-1v: the saved tool result comes first, so a call refused before the owner names its refusal.
  const evidence = (extra: Record<string, unknown>, saved: any) =>
    JSON.stringify({ ...extra, steps: saved?.intermediateSteps ?? null, errors: errors() }).slice(0, 6000)

  it('Stop through the actual interrupt route during the safe identity write: no write and no consent record', async () => {
    await withRealBuilder(async fetched => {
      const { ownAgentSettings } = await import('$lib/server/services/appActions/settings/server')
      const adapter = await import('$lib/server/services/appActions/settingsAdapter')
      const { listSessionApprovals } = await import('$lib/server/services/controlApprovals')
      await redis.execute(client => client.json.set(`agent:${AGENT}`, '$.displayName', 'Fixture Name'))
      const before = await ownAgentSettings.readIdentity({ subjectAgentId: AGENT }, OWNER), recordBefore = await agentRecord()
      brokerCall('sys.ui.settings_agent_identity_update', { subjectAgentId: AGENT, expectedRevision: before.revision, changes: { displayName: 'Stopped Name' } })
      const execute = vi.spyOn(adapter, 'executeAgentSettingsAction')
      const announced = await watchAgentSettingsAnnouncements()
      const actual = ownAgentSettings.updateIdentity
      let stopAnswer: any, ownerRefusal: any
      // Pass-through: the user's Stop reaches the live run right before the real owner runs.
      const update = vi.spyOn(ownAgentSettings, 'updateIdentity').mockImplementation(async (args, context) => {
        stopAnswer = await (await interrupt({ request: new Request('http://127.0.0.1:45671/api/messages/interrupt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: SESSION, messageId: REPLY }) }), locals: { user: { id: USER } } } as any)).json()
        try { return await actual(args, context) } catch (error) { ownerRefusal = error; throw error }
      })
      const response = await run(); const answer = await response.json(), saved = await stored()
      const why = evidence({ status: response.status, answer, stopAnswer, bodies: bodies.length }, saved)
      expect(update, why).toHaveBeenCalledTimes(1)
      expect(stopAnswer, why).toMatchObject({ success: true, activeMessageId: REPLY })
      expect(ownerRefusal?.reason, why).toBe('caller_stopped')
      expect(response.status, why).toBe(499)
      expect(JSON.stringify(bodies[0].tools)).toContain('native_batshit_tool_use')
      expect(bodies).toHaveLength(1)
      expect(execute).toHaveBeenCalledTimes(1)
      expect(execute.mock.calls[0][1]).toBe('settings.agent.identity.update')
      expect(await execute.mock.results[0].value).toEqual({ status: 'blocked', reason: 'caller_stopped' })
      // The owner's write sets displayName and updated_at together; neither moved.
      expect(await agentRecord()).toMatchObject({ displayName: 'Fixture Name', updated_at: recordBefore.updated_at })
      expect((await ownAgentSettings.readIdentity({ subjectAgentId: AGENT }, OWNER)).revision).toBe(before.revision)
      expect(await listSessionApprovals(SESSION, USER)).toEqual([])
      expect(saved.metadata.interrupted).toBe(true)
      expect(saved.metadata.toolApprovals).toBeUndefined()
      // A refused, never-sent save announces nothing (A-1y).
      expect(announced, why).toEqual([])
      expect(fetched).toEqual([]); expect(buildErrors()).toEqual([])
    })
  }, 30000)

  it('approving the confirm-risk memory update resumes, spends its consent once and saves one change', async () => {
    await withRealBuilder(async fetched => {
      const { ownAgentSettings } = await import('$lib/server/services/appActions/settings/server')
      const adapter = await import('$lib/server/services/appActions/settingsAdapter')
      const controls = await import('$lib/server/services/controlApprovals')
      const before = await ownAgentSettings.readMemory({ subjectAgentId: AGENT }, OWNER)
      const next = before.values.triggerLingerTurns === 1 ? 2 : 1
      brokerCall('sys.ui.settings_agent_memory_update', { subjectAgentId: AGENT, expectedRevision: before.revision, changes: { triggerLingerTurns: next } })
      const execute = vi.spyOn(adapter, 'executeAgentSettingsAction')
      const update = vi.spyOn(ownAgentSettings, 'updateMemory')
      const announced = await watchAgentSettingsAnnouncements()
      const first = await run(); const firstAnswer = await first.json()
      expect(first.status, JSON.stringify({ firstAnswer, errors: errors() })).toBe(200)
      expect(JSON.stringify(bodies[0].tools)).toContain('native_batshit_tool_use')
      expect(bodies).toHaveLength(1); expect(execute).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled()
      // The card is not a save: nothing is announced before the approval.
      expect(announced).toEqual([])
      const card = await stored()
      const approvals = card.metadata.toolApprovals?.approvals ?? []
      expect(approvals, JSON.stringify({ metadata: card.metadata, errors: errors() })).toHaveLength(1)
      expect(approvals[0]).toMatchObject({ status: 'pending', toolName: 'native_batshit_tool_use', control: { controlId: 'sys.ui.settings_agent_memory_update', riskLevel: 'confirm' } })
      expect(JSON.stringify(approvals[0].control.input)).toContain(before.revision)
      expect(await controls.getControlApproval(approvals[0].control.approvalId)).toMatchObject({ status: 'pending', controlId: 'sys.ui.settings_agent_memory_update', riskLevel: 'confirm', sessionId: SESSION, messageId: REPLY })
      expect((await ownAgentSettings.readMemory({ subjectAgentId: AGENT }, OWNER)).revision).toBe(before.revision)
      const second = await run(undefined, { content: '', messages: [...HISTORY, { id: REPLY, role: 'assistant', content: card.content ?? '' }], metadata: { toolApprovalMode: 'all', toolApprovalResponse: [{ type: 'tool-approval-response', approvalId: approvals[0].approvalId, approved: true }] } })
      const secondAnswer = await second.json(), resumed = await stored()
      const why = evidence({ status: second.status, secondAnswer, bodies: bodies.length }, resumed)
      expect(execute, why).toHaveBeenCalledTimes(1)
      expect(execute.mock.calls[0][1]).toBe('settings.agent.memory.update')
      expect(update, why).toHaveBeenCalledTimes(1)
      expect(second.status, why).toBe(200)
      expect(bodies).toHaveLength(2)
      expect(bodies[1].input).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function_call_output', call_id: 'call_fixture' })]))
      expect(await update.mock.results[0].value).toMatchObject({ status: 'completed', saved: 'saved', readback: 'verified' })
      expect((await ownAgentSettings.readMemory({ subjectAgentId: AGENT }, OWNER)).values.triggerLingerTurns).toBe(next)
      expect((await agentRecord()).memory_linger_turns).toBe(next)
      // A-1y: one announcement for the memory family, for this user and agent, made after the save.
      expect(announced, why).toHaveLength(1)
      expect(announced[0]).toMatchObject({ userId: USER, event: { type: 'agent_settings_changed', agentId: AGENT, family: 'memory' } })
      expect(announced[0].recordThen.memory_linger_turns).toBe(next)
      const spent = await controls.getControlApproval(approvals[0].control.approvalId)
      expect(spent).toMatchObject({ status: 'consumed' }); expect(spent?.decidedAt).toBeTruthy(); expect(spent?.consumedAt).toBeTruthy()
      expect(await controls.listSessionApprovals(SESSION, USER)).toHaveLength(1)
      expect(resumed.content).toContain('Saved fixture reply.'); expect(resumed.metadata.interrupted).toBeFalsy()
      expect(fetched).toEqual([]); expect(buildErrors()).toEqual([])
    })
  }, 30000)
})
