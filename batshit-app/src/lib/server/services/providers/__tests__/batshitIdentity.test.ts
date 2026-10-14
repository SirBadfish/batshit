/**
 * BL-684: every provider client that ProviderManager creates sends Batshit's
 * own true identity as its User-Agent. Real SDK clients, a fake fetch that
 * records the outgoing headers and never reaches a seller.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderManager } from '../index'
import { BATSHIT_USER_AGENT, withBatshitIdentity } from '../batshitIdentity'
import { BATSHIT_APP_VERSION } from '$lib/version'
import { LOCAL_AI_SERVER_DEFINITIONS } from '$lib/data/localAiServers'

vi.mock('$env/dynamic/private', () => ({ env: {} }))
// The shared setup file fakes these SDKs; this test needs the real clients.
vi.unmock('ai')
vi.unmock('@ai-sdk/anthropic')
vi.unmock('@ai-sdk/openai')
vi.unmock('@ai-sdk/google')
vi.unmock('@ai-sdk/groq')
vi.unmock('@ai-sdk/mistral')
vi.unmock('@openrouter/ai-sdk-provider')

const KEY = 'zcpausePlaceholderKey0123456789'
// validateApiKey checks these prefixes; every other seller takes KEY.
const PREFIXED: Record<string, string> = {
  anthropic: 'sk-ant-zcpause0123456789',
  openai: 'sk-zcpause0123456789',
  groq: 'gsk_zcpause0123456789',
  openrouter: 'sk-or-zcpause0123456789'
}
const PROVIDER_IDS = [
  'anthropic', 'openai', 'google', 'mistral', 'groq', 'xai', 'deepseek', 'moonshot',
  'kimi_code', 'minimax', 'minimax_token_plan', 'mimo', 'mimo_token_plan', 'qwencloud',
  'qwen_token_plan', 'alibaba', 'stepfun', 'zai', 'zai_coding', 'openrouter', 'cohere',
  'deepinfra', 'togetherai', 'fireworks', 'baseten', 'cerebras'
] as const

// Stubbed before the manager is built: the Ollama shim keeps the fetch it saw.
const seen: Array<{ url: string; userAgent: string | null }> = []
function captureFetch() {
  seen.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
    if (init?.headers) new Headers(init.headers).forEach((v, k) => headers.set(k, v))
    seen.push({ url: String(input instanceof Request ? input.url : input), userAgent: headers.get('user-agent') })
    throw new Error('zcpause: no network in this test')
  }))
  return seen
}

async function callOnce(model: any) {
  await model
    .doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
    .catch(() => undefined)
}

function buildManager() {
  const ollama = LOCAL_AI_SERVER_DEFINITIONS.find((d) => d.id === 'ollama')!
  const other = LOCAL_AI_SERVER_DEFINITIONS.find((d) => d.id !== 'ollama')!
  const local = (definition: typeof ollama) => ({
    ...definition, baseUrl: definition.defaultBaseUrl, enabled: true,
    imageTransport: definition.defaultImageTransport,
    imageBaseUrl: definition.defaultImageBaseUrl, source: 'default'
  })
  return new ProviderManager({
    apiKeys: Object.fromEntries(PROVIDER_IDS.map((id) => [id, PREFIXED[id] ?? KEY])),
    gateway: { apiKey: KEY },
    customProviders: [{ id: 'custom_zcpause', label: 'zcpause', baseUrl: 'https://custom.invalid/v1', apiKey: KEY }],
    localProviders: [local(ollama), local(other)] as any
  })
}

describe('BL-684: Batshit names itself in each provider call', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is one true identity with the app version and the site', () => {
    expect(BATSHIT_USER_AGENT).toBe(`Batshit/${BATSHIT_APP_VERSION} (+https://batshit.ai)`)
  })

  it('every registered provider client sends the Batshit User-Agent first', async () => {
    captureFetch()
    const manager = buildManager()
    const providers: Map<string, { client: (id: string) => unknown }> = (manager as any).providers
    const ids = [...providers.keys()]
    for (const id of [...PROVIDER_IDS, 'custom_zcpause', 'ollama']) expect(ids).toContain(id)

    for (const id of ids) {
      seen.length = 0
      await callOnce(providers.get(id)!.client('zcpause-model'))
      expect(seen.length, `${id} made no request`).toBeGreaterThan(0)
      for (const request of seen) {
        expect(
          (request.userAgent ?? '').startsWith(BATSHIT_USER_AGENT),
          `${id} → ${request.url}: ${request.userAgent}`
        ).toBe(true)
      }
    }
  })

  it('the AI Gateway client sends it too', async () => {
    captureFetch()
    const manager = buildManager()
    const gateway = (manager as any).gatewayClient as (id: string) => unknown
    expect(gateway).toBeTruthy()
    await callOnce(gateway('openai/zcpause-model'))
    expect(seen.length).toBeGreaterThan(0)
    for (const request of seen) expect(request.userAgent ?? '').toContain(BATSHIT_USER_AGENT)
  })

  it('a User-Agent the user set on a custom connection wins, never joined', () => {
    expect(withBatshitIdentity({ 'x-extra': '1' })).toEqual({ 'User-Agent': BATSHIT_USER_AGENT, 'x-extra': '1' })
    expect(withBatshitIdentity({ 'user-agent': 'mine/1' })).toEqual({ 'user-agent': 'mine/1' })
    expect(withBatshitIdentity(undefined)).toEqual({ 'User-Agent': BATSHIT_USER_AGENT })
  })
})
