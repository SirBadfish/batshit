// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { env } from '$env/dynamic/private'
import { ChatgptPlanVault } from '../chatgptPlanVault'
import { ChatgptPlanOAuth } from '../chatgptPlanOAuth'
import { ChatgptPlanRuntime } from '../chatgptPlanRuntime'
import { chatgptPlanEligibility } from '../chatgptPlanHost'
import { normaliseChatgptPlanPreset } from '../chatgptPlanPreset'
import { chatgptPlanCatalogModels, chatgptPlanConnectionOptions } from '../chatgptPlanCatalog'
import { assertPlanSettings, planModelForLease } from '../chatgptPlanInference'
import { POST } from '../../../../routes/api/settings/chatgpt-plan/+server'

const userId = 'plan-management-fixture'
const origin = 'http://127.0.0.1:45671'
let root: string, vault: ChatgptPlanVault, runtime: ChatgptPlanRuntime, accountId: string
const host = globalThis as any
const previous = { ...env }
let calls: any[]
let listed: Array<{ slug: string; display_name: string; visibility: string }>
const actualPlatform = process.platform
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
// Simulate the supported host only inside the Mac contract cases. Setup, cleanup
// and the unsupported-host checks use the worker's actual platform.
async function withMacPlatform<T>(run: () => Promise<T>): Promise<T> {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' })
  try { return await run() } finally { Object.defineProperty(process, 'platform', platformDescriptor) }
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sa130-management-')))
  Object.assign(env, { BATSHIT_RUNTIME_OWNER: 'mac-app', BATSHIT_CONTAINERIZED: '', BATSHIT_MAC_DATA_DIR: root, ORIGIN: origin, BATSHIT_FRONTEND_PORT: '45671' })
  vault = new ChatgptPlanVault(path.join(root, 'config', 'chatgpt-plan'), 'synthetic-management-instance-key-0123456789')
  const row = vault.connect({ userId, issuer: 'https://auth.openai.com', subject: 'Management-fixture', clientId: 'oaiapp_Fixture', email: 'fixture@example.invalid' }, { accessToken: 'MANAGEMENT_ACCESS_SENTINEL', refreshToken: 'MANAGEMENT_REFRESH_SENTINEL', idToken: 'MANAGEMENT_ID_SENTINEL', scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'], expiresAt: Date.now() + 3600000 }, vault.beginAuthorization(userId))
  accountId = row.id; calls = []
  listed = [{ slug: 'exact-Slug', display_name: 'Fixture model', visibility: 'list' }, { slug: 'hidden', display_name: 'Hidden', visibility: 'hidden' }]
  const http = vi.fn(async (url, init) => { calls.push([url, init]); return Response.json({ models: listed }) }) as typeof fetch
  runtime = new ChatgptPlanRuntime(vault, new ChatgptPlanOAuth(vault, async () => true, http), http)
  host.__batshitChatgptPlanRuntime = runtime
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  runtime.oauth.close(); vault.close(); delete host.__batshitChatgptPlanRuntime
  for (const key of Object.keys(env)) if (!(key in previous)) delete (env as any)[key]
  Object.assign(env, previous); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true })
})
function event(body: unknown, overrides: { origin?: string; user?: string; sessionUser?: string; expired?: boolean; noSession?: boolean; url?: string } = {}) {
  return { request: new Request(`${overrides.url ?? origin}/api/settings/chatgpt-plan`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: overrides.origin ?? origin }, body: JSON.stringify(body) }), locals: { user: { id: overrides.user ?? userId }, session: overrides.noSession ? undefined : { token: 'FIXTURE_SESSION', user_id: overrides.sessionUser ?? userId, expires_at: new Date(Date.now() + (overrides.expired ? -1000 : 3600000)).toISOString() } } } as any
}
describe('native Mac connection admission and account-scoped models', () => {
  it('refreshes owned account order/eligibility every call and supplements only exact published slugs (BL-1066)', () => withMacPlatform(async () => {
    listed = [
      { slug: 'future-unknown', display_name: 'Account name', visibility: 'list' },
      { slug: 'gpt-6-astra', display_name: 'Account Astra', visibility: 'list' },
      { slug: 'gpt-5.5', display_name: 'Hidden', visibility: 'hidden' }
    ]
    const first = await chatgptPlanCatalogModels(userId)
    expect(first.map(row => row.name)).toEqual(['future-unknown', 'gpt-6-astra'])
    expect(first[0].publishedMetadata).toBeUndefined(); expect(first[0].features?.vision).toBeUndefined()
    expect(first[1]).toMatchObject({ displayName: 'Account Astra', features: { vision: true }, publishedMetadata: { modelId: 'gpt-6-astra', verifiedAt: '2026-10-01', sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-6-astra', contextWindow: 1_050_000, maxOutputTokens: 128_000 } })
    expect(first[1].contextWindow).toBeUndefined(); expect(first[1].maxOutputTokens).toBeUndefined()
    expect(first[1].pricing).toBeUndefined()
    expect(first[1].idVariants![`chatgpt-plan:${accountId}`].limits).toEqual({ contextWindow: null, maxOutputTokens: null })
    listed = [{ slug: 'gpt-5.5', display_name: 'Fresh account name', visibility: 'list' }]
    const next = await chatgptPlanCatalogModels(userId)
    expect(next.map(row => row.name)).toEqual(['gpt-5.5']); expect(next[0].displayName).toBe('Fresh account name')
    expect(calls).toHaveLength(2); expect(calls.every(([url]) => url === 'https://api.openai.com/v1/models')).toBe(true)
    const preset = await normaliseChatgptPlanPreset({ modelId: 'gpt-5.5', provider: 'openai', connection: { id: `chatgpt-plan:${accountId}`, type: 'direct', service: 'chatgpt-plan' }, pricing: { input: 999 }, capabilities: { vision: false, image: true }, settings: {}, publishedMetadata: { contextWindow: 123 } } as any, userId)
    expect(preset.contextWindow).toBeUndefined(); expect(preset.pricing).toEqual({})
    expect(preset.capabilities).toMatchObject({ vision: false, image: false, audio: false })
    expect((await normaliseChatgptPlanPreset({ ...preset, capabilities: undefined }, userId)).capabilities?.vision).toBe(true)
    expect(preset.publishedMetadata?.contextWindow).toBe(1_050_000)
    await expect(normaliseChatgptPlanPreset({ ...preset, modelId: 'gpt-6-astra' }, userId)).rejects.toMatchObject({ code: 'model_unavailable' })
  }))
  it('requires the exact supervisor-owned Mac origin and refuses Docker, hosted and ordinary dev runtimes', async () => {
    expect(process.platform).toBe(actualPlatform)
    expect(Object.getOwnPropertyDescriptor(process, 'platform')).toEqual(platformDescriptor)
    const values = { BATSHIT_RUNTIME_OWNER: 'mac-app', BATSHIT_MAC_DATA_DIR: root, ORIGIN: origin, BATSHIT_FRONTEND_PORT: '45671' }
    expect(chatgptPlanEligibility(values, 'darwin').eligible).toBe(true)
    for (const patch of [{ BATSHIT_RUNTIME_OWNER: 'native' }, { BATSHIT_CONTAINERIZED: '1' }, { ORIGIN: 'https://app.batshit.ai' }, { ORIGIN: 'http://localhost:45671' }, { BATSHIT_FRONTEND_PORT: '45672' }, { BATSHIT_MAC_DATA_DIR: 'relative' }]) expect(chatgptPlanEligibility({ ...values, ...patch }, 'darwin').eligible).toBe(false)
    expect(chatgptPlanEligibility(values, 'linux').eligible).toBe(false)
    expect(chatgptPlanEligibility(values)).toEqual(chatgptPlanEligibility(values, actualPlatform))
    if (actualPlatform !== 'darwin') {
      const start = vi.spyOn(runtime.oauth, 'start')
      const response = await POST(event({ action: 'start' }))
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ code: 'runtime_ineligible' })
      expect(start).not.toHaveBeenCalled(); expect(calls).toHaveLength(0)
    }
  })
  it('denies missing, mismatched, expired and foreign-origin sessions before management side effects', () => withMacPlatform(async () => {
    const start = vi.spyOn(runtime.oauth, 'start').mockResolvedValue('https://auth.openai.com/authorize?fixture')
    for (const overrides of [{ noSession: true }, { sessionUser: 'another-user' }, { expired: true }, { origin: 'http://localhost:45671' }, { url: 'http://127.0.0.1:45672' }]) {
      const response = await POST(event({ action: 'start' }, overrides))
      expect(response.status).toBeGreaterThanOrEqual(400)
      const originMismatch = 'origin' in overrides || 'url' in overrides
      expect(response.status).toBe(originMismatch ? 403 : 401)
      expect(await response.json()).toMatchObject({ code: originMismatch ? 'origin_required' : 'session_required' })
    }
    expect(start).not.toHaveBeenCalled(); expect(calls).toHaveLength(0)
    expect((await POST(event({ action: 'start', accountId: {} }))).status).toBe(409)
    expect(start).not.toHaveBeenCalled()
  }))
  it('returns only public account status, without host path, binding, issued client or credentials', () => withMacPlatform(async () => {
    const response = await POST(event({ action: 'status' }))
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store')
    const value = await response.json(); const rendered = JSON.stringify(value)
    expect(value.accounts).toEqual([{ id: accountId, email: 'fixture@example.invalid', state: 'ready' }])
    for (const secret of ['MANAGEMENT_ACCESS_SENTINEL', 'MANAGEMENT_REFRESH_SENTINEL', 'MANAGEMENT_ID_SENTINEL', 'oaiapp_Fixture', root, vault.binding(vault.get(userId, accountId))]) expect(rendered).not.toContain(secret)
    expect((await POST(event({ action: 'models', accountId }, { user: 'another-user', sessionUser: 'another-user' }))).status).toBe(409)
    expect(calls).toHaveLength(0)
  }))
  it('keeps account catalog identity, exact slug and unknown limits; strips hostile paid pricing on save', () => withMacPlatform(async () => {
    const connection = { id: `chatgpt-plan:${accountId}`, type: 'direct' as const, service: 'chatgpt-plan' }
    expect(chatgptPlanConnectionOptions(userId)[0]).toMatchObject({ id: connection.id, status: 'ready', n8nStatus: 'locked' })
    const catalog = await chatgptPlanCatalogModels(userId)
    expect(catalog).toHaveLength(1); expect(catalog[0].id).toBe(`${connection.id}/exact-Slug`)
    expect(catalog[0].idVariants![connection.id].limits).toEqual({ contextWindow: null, maxOutputTokens: null })
    const preset = await normaliseChatgptPlanPreset({ modelId: 'exact-Slug', provider: 'openai', connection, pricing: { input: 999, output: 999 }, settings: { reasoningEffort: 'medium' }, catalogModelId: 'paid-catalog', contextWindow: undefined } as any, userId)
    expect(preset).toMatchObject({ modelId: 'exact-Slug', effectiveModelId: 'exact-Slug', pricing: {}, compatibility: { n8n: false } })
    expect(preset.contextWindow).toBeUndefined(); expect(preset.catalogModelId).toBeUndefined()
    await expect(normaliseChatgptPlanPreset({ ...preset, modelId: 'hidden' }, userId)).rejects.toMatchObject({ code: 'model_unavailable' })
    await expect(normaliseChatgptPlanPreset(preset, 'another-user')).rejects.toMatchObject({ code: 'account_missing' })
    expect(() => assertPlanSettings({ temperature: 0 })).toThrow(/temperature/)
    expect(() => planModelForLease(undefined, userId, connection, preset.modelId)).toThrow(/no server-owned/)
  }))
})
