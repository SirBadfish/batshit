// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TypesafeConfig } from '$lib/types/typesafe'

/**
 * SA-120 P10a (DL-120-18) — `POST /api/settings/typesafe/test`, the Test button beside each judge on the Admin
 * Judge Juice card: admin only, the SAVED judge by id, the key only for a kind that sends one, the fixed sample
 * question only (never chat text), and it ignores the master switch because the user clicked it.
 */

const state = vi.hoisted(() => ({
  config: {
    enabled: false,
    modelId: 'jev-1.13.0',
    attemptTimeoutMs: 5000,
    inChatWaitMs: 750,
    screenIncomingText: false,
    providers: [
      { id: 'ollama-mac', kind: 'ollama', label: 'Ollama on this Mac', baseUrl: 'http://127.0.0.1:11434', modelId: 'clef-flash' },
      { id: 'cf', kind: 'cloudflare', label: 'Cloudflare', accountId: '0123456789abcdef0123456789abcdef', modelId: 'clef' }
    ],
    defaultProviderId: 'typesafe',
    laneProviders: {},
    updatedAt: null
  } as TypesafeConfig
}))
const keys = vi.hoisted(() => ({ saved: {} as Record<string, string> }))
const testJudgeProvider = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/services/typesafe/typesafeConfig', () => ({ getTypesafeConfig: vi.fn(async () => state.config) }))
vi.mock('$lib/server/services/typesafe/typesafeAvailability', () => ({
  resolveTypesafeApiKey: vi.fn(async () => (keys.saved.typesafe ? { apiKey: keys.saved.typesafe, source: 'user' } : null))
}))
vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: { retrieve: vi.fn(async (service: string) => keys.saved[service] ?? null) }
}))
vi.mock('$lib/server/services/typesafe/typesafeKeyTest', () => ({ testJudgeProvider }))

import { POST } from './+server'

const admin = { user: { id: 'josh', is_admin: true } }
const member = { user: { id: 'guest', is_admin: false } }

function post(body: unknown) {
  return new Request('http://localhost/api/settings/typesafe/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  keys.saved = {}
  testJudgeProvider.mockResolvedValue({ ok: true, model: 'clef-flash', latencyMs: 31, message: 'Clef Flash (Ollama) answered on this computer in 31 ms.' })
})

describe('POST /api/settings/typesafe/test', () => {
  it('refuses a non-admin and a missing id', async () => {
    expect((await POST({ locals: member, request: post({ providerId: 'ollama-mac' }) } as any)).status).toBe(403)
    expect((await POST({ locals: admin, request: post({}) } as any)).status).toBe(400)
    expect(testJudgeProvider).not.toHaveBeenCalled()
  })

  it('tests a saved local judge with no key, even while Judge Juice is off', async () => {
    const response = await POST({ locals: admin, request: post({ providerId: 'ollama-mac' }) } as any)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, message: 'Clef Flash (Ollama) answered on this computer in 31 ms.' })
    expect(testJudgeProvider).toHaveBeenCalledWith(expect.objectContaining({ id: 'ollama-mac', kind: 'ollama', modelId: 'clef-flash' }), null)
  })

  it('a judge that sends a key: refused without one, tested with the saved one', async () => {
    const missing = await POST({ locals: admin, request: post({ providerId: 'cf' }) } as any)
    expect(missing.status).toBe(400)
    expect((await missing.json()).error).toBe('No Cloudflare key is saved.')
    expect(testJudgeProvider).not.toHaveBeenCalled()

    keys.saved.cloudflare_workers_ai = 'cf-token'
    await POST({ locals: admin, request: post({ providerId: 'cf' }) } as any)
    expect(testJudgeProvider).toHaveBeenCalledWith(expect.objectContaining({ id: 'cf' }), 'cf-token')

    keys.saved.typesafe = 'ts-key'
    await POST({ locals: admin, request: post({ providerId: 'typesafe' }) } as any)
    expect(testJudgeProvider).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'typesafe', modelId: 'jev-1.13.0' }), 'ts-key')
  })

  it('a judge that is not saved yet is a 404, and a failed test is a 400 that says why', async () => {
    const unsaved = await POST({ locals: admin, request: post({ providerId: 'ollama-new' }) } as any)
    expect(unsaved.status).toBe(404)
    testJudgeProvider.mockResolvedValueOnce({ ok: false, error: 'Batshit could not reach Ollama. (TypeError)', reason: 'network', detail: 'TypeError', latencyMs: 2 })
    const failed = await POST({ locals: admin, request: post({ providerId: 'ollama-mac' }) } as any)
    expect(failed.status).toBe(400)
    expect((await failed.json()).error).toBe('Batshit could not reach Ollama. (TypeError)')
  })
})
