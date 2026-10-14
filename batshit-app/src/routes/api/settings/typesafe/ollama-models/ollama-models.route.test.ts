// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * SA-120 P10a (DL-120-18) — `POST /api/settings/typesafe/ollama-models`: the Admin card's list of an Ollama server's
 * decision models. Admin only; the address is checked like a saved judge's before the server reads anything.
 */

const listOllamaDecisionModels = vi.hoisted(() => vi.fn())
vi.mock('$lib/server/services/typesafe/ollamaDecisionModels', () => ({ listOllamaDecisionModels }))

import { POST } from './+server'

const admin = { user: { id: 'josh', is_admin: true } }
const member = { user: { id: 'guest', is_admin: false } }

function post(body: unknown) {
  return new Request('http://localhost/api/settings/typesafe/ollama-models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  listOllamaDecisionModels.mockResolvedValue({ ok: true, models: [{ name: 'clef-flash:latest', contextTokens: 16384 }], otherModelCount: 3 })
})

describe('POST /api/settings/typesafe/ollama-models', () => {
  it('lists the decision models at a normalized address for an admin', async () => {
    const response = await POST({ locals: admin, request: post({ baseUrl: 'http://192.168.1.20:11434/' }) } as any)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      baseUrl: 'http://192.168.1.20:11434',
      models: [{ name: 'clef-flash:latest', contextTokens: 16384 }],
      otherModelCount: 3
    })
    expect(listOllamaDecisionModels).toHaveBeenCalledWith('http://192.168.1.20:11434')
  })

  it('refuses a non-admin and an address it cannot use, before reading anything', async () => {
    expect((await POST({ locals: member, request: post({ baseUrl: 'http://127.0.0.1:11434' }) } as any)).status).toBe(403)
    for (const baseUrl of ['file:///etc/hosts', 'http://josh:pw@127.0.0.1:11434', 42, '']) {
      expect((await POST({ locals: admin, request: post({ baseUrl }) } as any)).status).toBe(400)
    }
    expect(listOllamaDecisionModels).not.toHaveBeenCalled()
  })

  it('passes Ollama being unreachable through as a readable 502', async () => {
    listOllamaDecisionModels.mockResolvedValueOnce({ ok: false, error: "Batshit could not read Ollama's model list at http://127.0.0.1:11434 (fetch failed)." })
    const response = await POST({ locals: admin, request: post({ baseUrl: 'http://127.0.0.1:11434' }) } as any)
    expect(response.status).toBe(502)
    expect((await response.json()).error).toMatch(/could not read Ollama's model list/)
  })
})
