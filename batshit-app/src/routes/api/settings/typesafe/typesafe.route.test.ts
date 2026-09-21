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

import { GET, PUT } from './+server'

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
