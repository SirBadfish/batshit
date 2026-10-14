// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TypesafeConfig } from '$lib/types/typesafe'

/**
 * SA-120 P0 — `/api/settings/typesafe`: GET reports the config plus key presence
 * (never the value); PUT is admin-only and refuses `jev-latest` (DL-120-08).
 */

const state = vi.hoisted(() => ({
  config: { enabled: false, modelId: 'jev-1.13.0', attemptTimeoutMs: 5000, inChatWaitMs: 750, screenIncomingText: false, updatedAt: null } as TypesafeConfig,
  setCalls: [] as unknown[]
}))

vi.mock('$lib/server/services/typesafe/typesafeConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/typesafe/typesafeConfig')>()
  return {
    ...actual,
    getTypesafeConfig: vi.fn(async () => state.config),
    setTypesafeConfig: vi.fn(async (patch: Partial<TypesafeConfig>) => {
      state.setCalls.push(patch)
      state.config = { ...state.config, ...patch, updatedAt: '2026-09-16T12:00:00.000Z' }
      return state.config
    })
  }
})

vi.mock('$lib/server/services/typesafe/typesafeAvailability', () => ({
  getTypesafeKeyStatus: vi.fn(async () => ({ present: true, source: 'user' }))
}))

// SA-120 P10a: presence of every judge key, never a value.
vi.mock('$lib/server/services/typesafe/judgeProviderEndpoint', () => ({
  getJudgeKeyStatuses: vi.fn(async (_userId: string, typesafe: unknown) => ({
    typesafe,
    cloudflare_workers_ai: { present: false, source: null },
    systemone_url: { present: true, source: 'user' }
  }))
}))

import { GET, PUT } from './+server'
import { setTypesafeConfig, TypesafeConfigValidationError } from '$lib/server/services/typesafe/typesafeConfig'

const admin = { user: { id: 'josh', is_admin: true } }
const member = { user: { id: 'guest', is_admin: false } }

function putRequest(body: unknown) {
  return new Request('http://localhost/api/settings/typesafe', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

beforeEach(() => {
  state.config = { enabled: false, modelId: 'jev-1.13.0', attemptTimeoutMs: 5000, inChatWaitMs: 750, screenIncomingText: false, updatedAt: null }
  state.setCalls = []
})

describe('GET /api/settings/typesafe', () => {
  it('requires a signed-in user', async () => {
    const response = await GET({ locals: {} } as any)
    expect(response.status).toBe(401)
  })

  it('returns the config, key presence without the value, and the limits', async () => {
    const response = await GET({ locals: member } as any)
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.config).toEqual(state.config)
    expect(payload.key).toEqual({ present: true, source: 'user' })
    expect(payload.limits.pinnedModelId).toBe('jev-1.13.0')
    // SA-120 P8: the card draws the In-Chat Wait Limit's bounds from here, never from its own numbers.
    expect(payload.limits).toMatchObject({ inChatWaitMinMs: 200, inChatWaitMaxMs: 30000 })
    expect(JSON.stringify(payload)).not.toContain('apiKey')
  })
})

describe('PUT /api/settings/typesafe', () => {
  it('refuses non-admins', async () => {
    const response = await PUT({ locals: member, request: putRequest({ enabled: true }) } as any)
    expect(response.status).toBe(403)
    expect(state.setCalls).toHaveLength(0)
  })

  it('refuses jev-latest with a readable error and stores nothing', async () => {
    const response = await PUT({ locals: admin, request: putRequest({ modelId: 'jev-latest' }) } as any)
    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/pinned/)
    expect(state.setCalls).toHaveLength(0)
  })

  it('stores a valid patch and answers with the fresh record', async () => {
    const response = await PUT({
      locals: admin,
      request: putRequest({ enabled: true, modelId: 'jev-1.13.0', attemptTimeoutMs: 2500 })
    } as any)
    expect(response.status).toBe(200)
    expect(state.setCalls).toEqual([{ enabled: true, modelId: 'jev-1.13.0', attemptTimeoutMs: 2500 }])
    const payload = await response.json()
    expect(payload.config).toMatchObject({ enabled: true, attemptTimeoutMs: 2500 })
  })

  it('SA-120 P8 (LS-059): stores the In-Chat Wait Limit for an admin and refuses an out-of-range one by its label', async () => {
    const stored = await PUT({ locals: admin, request: putRequest({ inChatWaitMs: 5000 }) } as any)
    expect(stored.status).toBe(200)
    expect(state.setCalls).toEqual([{ inChatWaitMs: 5000 }])
    expect((await stored.json()).config.inChatWaitMs).toBe(5000)

    state.setCalls = []
    const low = await PUT({ locals: admin, request: putRequest({ inChatWaitMs: 199 }) } as any)
    expect(low.status).toBe(400)
    expect((await low.json()).error).toBe('"In-Chat Wait Limit" must be a whole number of milliseconds from 200 to 30000.')
    expect(state.setCalls).toHaveLength(0)
  })

  it('stores the P7 switch (LS-057) for an admin, refuses a non-boolean, and refuses a non-admin', async () => {
    const stored = await PUT({ locals: admin, request: putRequest({ screenIncomingText: true }) } as any)
    expect(stored.status).toBe(200)
    expect(state.setCalls).toEqual([{ screenIncomingText: true }])
    expect((await stored.json()).config.screenIncomingText).toBe(true)

    state.setCalls = []
    const typo = await PUT({ locals: admin, request: putRequest({ screenIncomingText: 'on' }) } as any)
    expect(typo.status).toBe(400)
    expect((await typo.json()).error).toBe('"Screen Incoming Text" must be true or false.')
    const guest = await PUT({ locals: member, request: putRequest({ screenIncomingText: true }) } as any)
    expect(guest.status).toBe(403)
    expect(state.setCalls).toHaveLength(0)
  })
})

describe('SA-120 P10a: judges through /api/settings/typesafe', () => {
  const OLLAMA = { id: 'ollama-pc', kind: 'ollama', label: 'Ollama on the PC', baseUrl: 'http://192.168.1.20:11434', modelId: 'clef-flash' }

  it('GET reports every judge key by presence only', async () => {
    const payload = await (await GET({ locals: member } as any)).json()
    expect(payload.keys).toEqual({
      typesafe: { present: true, source: 'user' },
      cloudflare_workers_ai: { present: false, source: null },
      systemone_url: { present: true, source: 'user' }
    })
    expect(payload.limits.maxJudgeProviders).toBe(16)
  })

  it('stores the judges, the default, and the per-feature choices for an admin, normalized', async () => {
    const response = await PUT({
      locals: admin,
      request: putRequest({
        providers: [{ ...OLLAMA, baseUrl: 'http://192.168.1.20:11434/', label: ' Ollama on the PC ' }],
        defaultProviderId: 'ollama-pc',
        laneProviders: { untrusted_text: 'typesafe', reply_check: null }
      })
    } as any)
    expect(response.status).toBe(200)
    expect(state.setCalls).toEqual([{ providers: [OLLAMA], defaultProviderId: 'ollama-pc', laneProviders: { untrusted_text: 'typesafe' } }])
    expect((await response.json()).keys.systemone_url).toEqual({ present: true, source: 'user' })
  })

  it.each([
    [{ providers: 'nope' }, '`providers` must be a list.'],
    [{ providers: [{ ...OLLAMA, kind: 'lmstudio' }] }, /must be Ollama, Cloudflare Workers AI, or a System One URL/],
    [{ providers: [{ ...OLLAMA, baseUrl: 'file:///etc/passwd' }] }, /http or https URL/],
    [{ providers: [{ ...OLLAMA, baseUrl: 'http://josh:secret@192.168.1.20:11434' }] }, /without a user name/],
    [{ providers: [{ id: 'cf', kind: 'cloudflare', label: 'CF', accountId: 'x', modelId: 'clef' }] }, /32 letters and digits/],
    [{ providers: [{ id: 'cf', kind: 'cloudflare', label: 'CF', accountId: '0123456789abcdef0123456789abcdef', modelId: 'llama' }] }, /clef or clef-flash/],
    [{ providers: [{ ...OLLAMA, modelId: 'clef flash!' }] }, /Ollama model name/],
    [{ providers: [{ ...OLLAMA, sendsKey: true }] }, /only a System One URL judge/],
    [{ providers: [OLLAMA, OLLAMA] }, 'Two judges share the id ollama-pc.'],
    [{ providers: [{ ...OLLAMA, id: 'typesafe' }] }, /id Batshit cannot use/],
    [{ defaultProviderId: 7 }, /`defaultProviderId` must name a judge/],
    [{ laneProviders: { connection_test: 'typesafe' } }, /not a Judge Juice feature/],
    [{ laneProviders: { smart_zip: { id: 'x' } } }, /is not a judge id/]
  ])('refuses %j with a readable error and stores nothing', async (body, error) => {
    const response = await PUT({ locals: admin, request: putRequest(body) } as any)
    expect(response.status).toBe(400)
    const message = (await response.json()).error as string
    if (typeof error === 'string') expect(message).toBe(error)
    else expect(message).toMatch(error)
    expect(state.setCalls).toHaveLength(0)
  })

  it('a refused merge (a choice naming no judge) is a 400; a storage failure is a 500', async () => {
    vi.mocked(setTypesafeConfig).mockRejectedValueOnce(new TypesafeConfigValidationError('These choices name a judge that is not in the list: default.'))
    const refused = await PUT({ locals: admin, request: putRequest({ providers: [] }) } as any)
    expect(refused.status).toBe(400)
    expect((await refused.json()).error).toMatch(/not in the list: default/)

    vi.mocked(setTypesafeConfig).mockRejectedValueOnce(new Error('connection lost'))
    const broken = await PUT({ locals: admin, request: putRequest({ enabled: true }) } as any)
    expect(broken.status).toBe(500)
  })

  it('refuses a non-admin before reading any judge field', async () => {
    const response = await PUT({ locals: member, request: putRequest({ providers: [OLLAMA], defaultProviderId: 'ollama-pc' }) } as any)
    expect(response.status).toBe(403)
    expect(state.setCalls).toHaveLength(0)
  })
})
