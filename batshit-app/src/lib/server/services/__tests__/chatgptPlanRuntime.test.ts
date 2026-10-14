// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('ai')
vi.unmock('@ai-sdk/openai')
import { streamText, tool, jsonSchema, isStepCount } from 'ai'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ChatgptPlanVault, type PlanTokens } from '../chatgptPlanVault'
import { ChatgptPlanOAuth } from '../chatgptPlanOAuth'
import { ChatgptPlanRuntime, PLAN_AGENT, PLAN_CATALOG, PLAN_COMPACT, assertPlanWireBody } from '../chatgptPlanRuntime'

const identity = { userId: 'fixture_user', issuer: 'https://auth.openai.com', subject: 'Subject-A', clientId: 'oaiapp_Fixture', email: 'fixture@example.invalid' }
const credentials: PlanTokens = { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', idToken: 'fixture-id', scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'], expiresAt: Date.now() + 3_600_000 }
const usage = { input_tokens: 20, output_tokens: 5, total_tokens: 25, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }
const created = { type: 'response.created', response: { id: 'resp_fixture', created_at: 1790000000, model: 'fixture-model' } }
const textEvents = [created,
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_fixture' } },
  { type: 'response.output_text.delta', item_id: 'msg_fixture', output_index: 0, delta: 'fixture reply' },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_fixture' } }]
const complete = { type: 'response.completed', response: { usage } }
function sse(events: unknown[]) { return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }) }
function outward(value: unknown) { return JSON.stringify(value, (_key, item) => item instanceof Error ? Object.fromEntries(Object.getOwnPropertyNames(item).map(key => [key, (item as any)[key]])) : item) }
const cleanup: (() => void)[] = []
function setup(http: typeof fetch, expired = false) {
  const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sa130-runtime-')))
  const vault = new ChatgptPlanVault(folder, 'synthetic-instance-key-for-sa130-tests-only')
  cleanup.push(() => { vault.close(); rmSync(folder, { recursive: true, force: true }) })
  const row = vault.connect(identity, { ...credentials, expiresAt: expired ? 1 : credentials.expiresAt }, vault.beginAuthorization(identity.userId))
  const oauth = new ChatgptPlanOAuth(vault, async () => true, http)
  const runtime = new ChatgptPlanRuntime(vault, oauth, http)
  const lease = runtime.acquire(identity.userId, row.id, PLAN_AGENT)
  cleanup.push(() => { lease.release(); oauth.close() })
  return { folder, vault, row, oauth, runtime, lease }
}
afterEach(() => { for (const work of cleanup.splice(0).reverse()) work(); vi.restoreAllMocks() })
const messages = [{ role: 'system' as const, content: 'Canonical fixture identity' }, { role: 'user' as const, content: 'Full fixture prior history and current turn' }]
const options = { messages, allowSystemInMessages: true, maxRetries: 0, providerOptions: { openai: { store: false, systemMessageMode: 'developer' } }, onError: () => {} }

describe('ChatGPT plan real SDK wire and request ownership', () => {
  it('redacts malformed catalog bodies and failed cancellation diagnostics', async () => {
    const f = setup(vi.fn(async () => new Response('RAW_SECRET_SENTINEL')) as typeof fetch)
    await expect(f.runtime.models(f.lease)).rejects.toMatchObject({ code: 'catalog_invalid' })
    const errorResponse = new Response(new ReadableStream({ cancel() { throw new Error('RAW_SECRET_SENTINEL') } }), { status: 429 })
    const g = setup(vi.fn(async () => errorResponse) as typeof fetch)
    await expect(g.runtime.models(g.lease)).rejects.toMatchObject({ code: 'usage_limit' })
  })
  it('keeps documented usage-limit guidance through the actual SDK startup boundary', async () => {
    const { runtime, lease } = setup(vi.fn(async () => new Response('RAW_SECRET_SENTINEL', { status: 429 })) as typeof fetch)
    const result = streamText({ ...options, model: runtime.model(lease, 'fixture-model') })
    const parts = []; let failure: unknown
    try { for await (const part of result.stream) parts.push(part) } catch (error) { failure = error }
    expect(outward({ parts, failure })).not.toContain('RAW_SECRET_SENTINEL')
    expect(outward({ parts, failure })).toContain('https://chatgpt.com/settings/usage')
  })
  it('streams actual SDK namespace tools and full tool-result history with plan-only authorization', async () => {
    const item = { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'echo', namespace: 'batshit', arguments: '{"value":"hello"}', status: 'completed' }
    const events = [[created,
      { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } },
      { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments },
      { type: 'response.output_item.done', output_index: 0, item }, complete], [...textEvents, complete]]
    const requests: Record<string, any>[] = []
    const http = vi.fn(async (_url, init) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-access')
      const body = JSON.parse(String(init?.body)); requests.push(body)
      return sse(events.shift()!)
    }) as typeof fetch
    const { runtime, lease } = setup(http)
    const echo = tool({ description: 'Fixture echo', inputSchema: jsonSchema<{ value: string }>({ type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }),
      providerOptions: { openai: { namespace: { name: 'batshit', description: 'Batshit client tools' } } }, execute: async ({ value }) => ({ echoed: value }) })
    const result = streamText({ ...options, model: runtime.model(lease, 'fixture-model'), tools: { echo }, stopWhen: isStepCount(3) })
    const parts = []; for await (const part of result.stream) parts.push(part)
    expect(await result.text).toBe('fixture reply')
    expect(parts.some(part => part.type === 'tool-result' && part.toolCallId === 'call_fixture')).toBe(true)
    expect(requests).toHaveLength(2)
    requests.forEach(body => { expect(body.store).toBe(false); expect(body.stream).toBe(true); expect(body.input[0].role).toBe('developer'); expect(body.tools[0].type).toBe('namespace'); expect(body).not.toHaveProperty('previous_response_id') })
    expect(requests[1].input).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function_call', namespace: 'batshit', call_id: 'call_fixture' }), expect.objectContaining({ type: 'function_call_output', call_id: 'call_fixture' })]))
  })
  it.each([
    ['incomplete', { type: 'response.incomplete', response: { usage, incomplete_details: { reason: 'max_output_tokens' } } }],
    ['failed', { type: 'response.failed', sequence_number: 5, response: { usage, error: { code: 'upstream', message: 'RAW_SECRET_SENTINEL' } } }],
    ['EOF', null]
  ])('preserves partial text but fails %s without response.completed', async (_name, terminal) => {
    const { runtime, lease } = setup(vi.fn(async () => sse([...textEvents, ...(terminal ? [terminal] : [])])) as typeof fetch)
    const result = streamText({ ...options, model: runtime.model(lease, 'fixture-model') })
    const parts = []; let failure: unknown
    try { for await (const part of result.stream) parts.push(part) } catch (error) { failure = error }
    expect(parts.some(part => part.type === 'text-delta')).toBe(true)
    const errors = parts.filter(part => part.type === 'error')
    expect(failure).toMatchObject({ code: 'response_incomplete' })
    expect(outward({ parts, failure })).not.toContain('RAW_SECRET_SENTINEL')
    expect(parts.some(part => part.type === 'finish' && part.finishReason === 'stop')).toBe(false)
  })
  it('sanitizes actual SDK startup failure including all raw parts and nested causes', async () => {
    const { runtime, lease } = setup(vi.fn(async () => sse([{ type: 'response.failed', sequence_number: 0, response: { usage, error: { code: 'upstream', message: 'RAW_SECRET_SENTINEL' } } }])) as typeof fetch)
    const result = streamText({ ...options, model: runtime.model(lease, 'fixture-model') })
    const parts = []; let failure: unknown
    try { for await (const part of result.stream) parts.push(part) } catch (error) { failure = error }
    expect(outward({ parts, failure })).not.toContain('RAW_SECRET_SENTINEL')
    expect(parts.some(part => part.type === 'error') || failure).toBeTruthy()
  })
  it('revokes a replacement when credential persistence throws', async () => {
    const { runtime, lease, oauth, vault } = setup(vi.fn() as typeof fetch, true)
    vi.spyOn(oauth, 'refresh').mockResolvedValue({ ...credentials, refreshToken: 'ROTATED_PERSISTENCE_FIXTURE' })
    vi.spyOn(vault, 'finishRefresh').mockImplementation(() => { throw new Error('RAW_SECRET_SENTINEL') })
    const revoke = vi.spyOn(oauth, 'revoke').mockResolvedValue(false)
    let failure: unknown
    try { await runtime.models(lease) } catch (error) { failure = error }
    expect(revoke).toHaveBeenCalledWith(expect.anything(), 'ROTATED_PERSISTENCE_FIXTURE')
    expect(outward(failure)).not.toContain('RAW_SECRET_SENTINEL')
    expect(failure).toMatchObject({ cleanupConfirmed: false })
  })
  it('refuses non-stream generation, incompatible controls, hosted tools and unadmitted consumers before HTTP', async () => {
    const http = vi.fn() as typeof fetch; const { runtime, lease, row } = setup(http)
    expect(() => assertPlanWireBody({ stream: true, store: false, max_output_tokens: 42 })).toThrow(/max_output_tokens/)
    expect(() => assertPlanWireBody({ stream: true, store: false, tools: [{ type: 'web_search' }] })).toThrow(/hosted tools/)
    await expect(runtime.model(lease, 'fixture-model').doGenerate({ prompt: [] })).rejects.toThrow(/streaming/)
    expect(() => runtime.acquire(identity.userId, row.id, 'agent' as any)).toThrow(/cannot use/)
    const catalog = runtime.acquire(identity.userId, row.id, PLAN_CATALOG)
    expect(() => runtime.model(catalog, 'fixture-model')).toThrow(/does not authorize inference/); catalog.release()
    expect(http).not.toHaveBeenCalled()
  })
  it('serializes rotating refresh while Stop forbids one caller late start without discarding replacement', async () => {
    const http = vi.fn(async () => Response.json({ models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }] })) as typeof fetch
    const { runtime, lease, oauth, vault, row } = setup(http, true)
    let finish!: (value: PlanTokens) => void
    const refresh = vi.spyOn(oauth, 'refresh').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const stop = new AbortController(); const stopped = runtime.acquire(identity.userId, row.id, PLAN_COMPACT, stop.signal)
    const a = runtime.models(stopped); const b = runtime.models(lease)
    stop.abort(); finish({ ...credentials, accessToken: 'rotated-access', refreshToken: 'rotated-refresh' })
    await expect(a).rejects.toThrow(/stopped/); expect(await b).toHaveLength(1)
    expect(refresh).toHaveBeenCalledTimes(1); expect(http).toHaveBeenCalledTimes(1)
    expect(vault.tokens(identity.userId, row.id, vault.binding(row)).refreshToken).toBe('rotated-refresh')
    stopped.release()
  })
  it('disconnect fences admission first, waits the actual lease, and revokes a late rotated token', async () => {
    const http = vi.fn() as typeof fetch; const { runtime, lease, oauth, vault, row } = setup(http, true)
    let finish!: (value: PlanTokens) => void
    vi.spyOn(oauth, 'refresh').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const revoke = vi.spyOn(oauth, 'revoke').mockResolvedValue(true)
    const request = runtime.models(lease)
    const disconnect = runtime.disconnect(identity.userId, row.id)
    expect(vault.get(identity.userId, row.id).state).toBe('disconnected')
    expect(() => runtime.acquire(identity.userId, row.id, PLAN_AGENT)).toThrow(/reconnect/)
    finish({ ...credentials, refreshToken: 'late-rotated-refresh' })
    await expect(request).rejects.toThrow(/changed during renewal/)
    expect(http).not.toHaveBeenCalled()
    lease.release()
    expect(await disconnect).toEqual({ remoteRevocation: 'confirmed' })
    expect(revoke.mock.calls.map(call => call[1])).toEqual(['late-rotated-refresh', 'fixture-refresh'])
    expect(vault.list(identity.userId)[0].revocationStatus).toBe('confirmed')
  })
  it('blocks reconnect during disconnect and retains failed late-token cleanup across replacement and restart', async () => {
    const { runtime, lease, oauth, vault, row } = setup(vi.fn() as typeof fetch, true)
    let finish!: (value: PlanTokens) => void
    vi.spyOn(oauth, 'refresh').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    vi.spyOn(oauth, 'revoke').mockImplementation(async (_row, token) => token !== 'LATE_REJECTED_FIXTURE')
    const request = runtime.models(lease)
    const disconnected = runtime.disconnect(identity.userId, row.id)
    const pending = vault.get(identity.userId, row.id)
    expect(() => vault.connect(identity, credentials, vault.beginAuthorization(identity.userId), pending)).toThrow(/Wait for ChatGPT disconnect/)
    await expect(oauth.start(identity.userId, 'fixture-session', row.id)).rejects.toMatchObject({ code: 'disconnect_pending' })
    finish({ ...credentials, refreshToken: 'LATE_REJECTED_FIXTURE' })
    await expect(request).rejects.toThrow(/changed during renewal/)
    lease.release()
    expect(await disconnected).toEqual({ remoteRevocation: 'unconfirmed' })
    const previous = vault.get(identity.userId, row.id)
    vault.connect(identity, credentials, vault.beginAuthorization(identity.userId), previous)
    expect(vault.cleanupUnconfirmed(identity.userId)).toBe(true)
    // Re-open the actual SQLite files, not a fake record snapshot.
    const folder = (vault as any).folder as string
    vault.close()
    const next = new ChatgptPlanVault(folder, 'synthetic-instance-key-for-sa130-tests-only')
    try { expect(next.cleanupUnconfirmed(identity.userId)).toBe(true); expect(next.list(identity.userId)[0].state).toBe('ready') } finally { next.close() }
  })
})

it('serializes dispatched consent writes before invalidation, while rejecting new mutation owners (BL-1056)', async () => {
  const { runtime, vault, lease, row, oauth } = setup(vi.fn() as any)
  vi.spyOn(oauth, 'revoke').mockResolvedValue(true)
  let finish!: () => void, committed = false
  const barrier = new Promise<void>(resolve => { finish = resolve })
  const write = runtime.mutate(lease, async () => { await barrier; expect(vault.get(identity.userId, row.id).state).toBe('ready'); committed = true })
  expect(() => vault.disconnect(identity.userId, row.id)).toThrow('approval save is still finishing')
  let settled = false
  const disconnect = runtime.disconnect(identity.userId, row.id).then(result => { settled = true; return result })
  expect(lease.signal.aborted).toBe(true)
  await expect(runtime.mutate(lease, async () => { throw new Error('must not run') })).rejects.toMatchObject({ code: 'request_stopped' })
  expect(() => runtime.acquire(identity.userId, row.id, PLAN_AGENT)).toThrow('disconnecting')
  expect(vault.get(identity.userId, row.id).state).toBe('ready'); expect(settled).toBe(false)
  finish(); await write; expect(committed).toBe(true)
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(vault.get(identity.userId, row.id).state).toBe('disconnected'); expect(settled).toBe(false)
  lease.release(); expect(await disconnect).toEqual({ remoteRevocation: 'confirmed' })
})

it('renewal failure blocks new mutation owners and waits for a dispatched save before invalidation (BL-1056)', async () => {
  const { runtime, vault, lease, row, oauth } = setup(vi.fn() as any, true)
  vi.spyOn(oauth, 'refresh').mockRejectedValue(new Error('synthetic renewal failure'))
  let finish!: () => void
  const barrier = new Promise<void>(resolve => { finish = resolve })
  const write = runtime.mutate(lease, async () => { await barrier; expect(vault.get(identity.userId, row.id).state).toBe('ready') })
  const renewing = runtime.models(lease).catch(error => error)
  await new Promise<void>(resolve => setImmediate(resolve))
  await expect(runtime.mutate(lease, async () => { throw new Error('must not run') })).rejects.toMatchObject({ code: 'reconnect_required' })
  expect(vault.get(identity.userId, row.id).state).toBe('ready')
  finish(); await write; expect(await renewing).toMatchObject({ code: 'reconnect_required' })
  expect(vault.get(identity.userId, row.id).state).toBe('reconnect')
})

it('catalog and Compact leases cannot authorize tool consent mutations', async () => {
  const { runtime, row } = setup(vi.fn() as any)
  for (const purpose of [PLAN_CATALOG, PLAN_COMPACT]) {
    const lease = runtime.acquire(identity.userId, row.id, purpose)
    try {
      const write = vi.fn(async () => {})
      await expect(runtime.mutate(lease, write)).rejects.toMatchObject({ code: 'consumer_unsupported' })
      expect(write).not.toHaveBeenCalled()
    } finally { lease.release() }
  }
})

// BL-1060: independent shutdown counterexample, extended to both renewal failures.
it.each(['rejected exchange', 'persistence failure'])('bounds the whole shutdown drain during %s and retains ownership until a later close', async failure => {
  const { folder, runtime, vault, lease, row, oauth } = setup(vi.fn() as any, true)
  if (failure === 'rejected exchange') vi.spyOn(oauth, 'refresh').mockRejectedValue(new Error('Synthetic renewal failure'))
  else {
    vi.spyOn(oauth, 'refresh').mockResolvedValue({ ...credentials, refreshToken: 'ROTATED_FIXTURE' })
    vi.spyOn(vault, 'finishRefresh').mockImplementation(() => { throw new Error('Synthetic persistence failure') })
    vi.spyOn(oauth, 'revoke').mockResolvedValue(true)
  }
  let finish!: () => void
  const barrier = new Promise<void>(resolve => { finish = resolve })
  const write = runtime.mutate(lease, async () => { await barrier })
  const renewal = runtime.models(lease).catch(error => error)
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(() => runtime.acquire(identity.userId, row.id, PLAN_AGENT)).toThrow('persistence failed')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let settled = false, failureResult: unknown
  const close = runtime.close().then(() => { settled = true }, error => { settled = true; failureResult = error })
  try {
    await vi.advanceTimersByTimeAsync(31000)
    expect(settled).toBe(true); expect(failureResult).toMatchObject({ code: 'requests_stopping' })
    expect(vault.get(identity.userId, row.id).state).toBe('ready')
    expect(vault.hasMutations(row.id)).toBe(true)
    expect(() => new ChatgptPlanVault(folder, 'synthetic-instance-key-for-sa130-tests-only')).toThrow('Another Batshit runtime owns')
    expect(() => runtime.acquire(identity.userId, row.id, PLAN_AGENT)).toThrow('stopped')
    await expect(runtime.mutate(lease, async () => {})).rejects.toMatchObject({ code: 'request_stopped' })
    finish(); await write; lease.release(); await renewal
    expect(vault.hasMutations(row.id)).toBe(false)
    await runtime.close() // A timed-out close never forfeited ownership; retry now drains and closes it.
    const reopened = new ChatgptPlanVault(folder, 'synthetic-instance-key-for-sa130-tests-only')
    expect(reopened.get(identity.userId, row.id).state).toBe('reconnect'); reopened.close()
  } finally {
    finish(); await write; lease.release(); await renewal; await close
    vi.useRealTimers()
  }
})
