import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSubagentStore } from '$lib/stores/subagents.svelte'

/**
 * 2026-09-25: a Subagent delete refuses with a reason the user can act on when batshit-server
 * cannot delete its avatar pictures (BL-139), and a create refuses a name a Primary Agent
 * already uses (BL-187). The store used to throw only the HTTP status text ("Service
 * Unavailable", "Bad Request"), which the Settings panel then showed instead of the reason.
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

function refusal(status: number, statusText: string, error: string) {
  return new Response(JSON.stringify({ error }), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' }
  })
}

describe('subagent store refusals', () => {
  it('passes a successful recovery notice through to the Settings toast', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, notice: 'Recorded programs ended.' })))
    const store = createSubagentStore()
    store.init('user-1')
    expect(await store.delete('helper')).toBe('Recorded programs ended.')
  })

  it('a delete refusal carries the server’s reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        refusal(503, 'Service Unavailable', 'batshit-server did not answer. Nothing was deleted: the Subagent is still there.')
      )
    )
    const store = createSubagentStore()
    store.init('user-1')

    await expect(store.delete('helper')).rejects.toThrow(
      'Failed to delete subagent: batshit-server did not answer. Nothing was deleted: the Subagent is still there.'
    )
  })

  it('a create refusal carries the server’s reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => refusal(400, 'Bad Request', "A Primary Agent already uses the id 'cooper'."))
    )
    const store = createSubagentStore()
    store.init('user-1')

    await expect(store.create({ displayName: 'Cooper', subagentType: 'api' } as any)).rejects.toThrow(
      "Failed to create subagent: A Primary Agent already uses the id 'cooper'."
    )
  })

  // BL-286 (2026-09-27): an update refusal (a settings autosave) carries the reason too, e.g.
  // a Codex or Claude config override the server will not accept.
  it('an update refusal carries the server’s reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        refusal(400, 'Bad Request', 'Production webhook URL is required for n8n Workflow Subagents.')
      )
    )
    const store = createSubagentStore()
    store.init('user-1')

    await expect(store.update('helper', { subagentType: 'n8n-workflow' })).rejects.toThrow(
      'Failed to update subagent: Production webhook URL is required for n8n Workflow Subagents.'
    )
    expect(store.error).toBe(
      'Failed to update subagent: Production webhook URL is required for n8n Workflow Subagents.'
    )
  })

  it('a refusal with no JSON body falls back to the status text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>oops</html>', { status: 502, statusText: 'Bad Gateway' })))
    const store = createSubagentStore()
    store.init('user-1')

    await expect(store.delete('helper')).rejects.toThrow('Failed to delete subagent: Bad Gateway')
  })

  it('a load refusal carries the server reason, clears the old list and settles loading', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ subagents: [{ id: 'helper' }] }))
      .mockResolvedValueOnce(refusal(503, 'Service Unavailable', '  Subagent records could not be read. Try again.  '))
    vi.stubGlobal('fetch', fetch)
    const store = createSubagentStore()
    store.init('user-1')
    await store.load()
    expect(store.subagents).toEqual([{ id: 'helper' }])

    await store.load()

    expect(store.error).toBe('Failed to load subagents: Subagent records could not be read. Try again.')
    expect(store.subagents).toEqual([])
    expect(store.loading).toBe(false)
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/subagents')
  })

  it('an assignment refusal throws the server reason for the existing inline save error', async () => {
    const fetch = vi.fn(async () => refusal(400, 'Bad Request', '  One of the selected Subagents no longer exists.  '))
    vi.stubGlobal('fetch', fetch)
    const store = createSubagentStore()
    store.init('user-1')

    await expect(store.updateAgentSubagents('primary', ['helper'])).rejects.toThrow(
      'Failed to update agent subagents: One of the selected Subagents no longer exists.'
    )
    expect(store.error).toBe('Failed to update agent subagents: One of the selected Subagents no longer exists.')
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/agents/primary/subagents', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subagentIds: ['helper'] })
    })
  })

  for (const body of ['<html>oops</html>', '{}', '{"error":"  "}', '{"error":42}']) {
    it(`a load refusal falls back to status text for ${body}`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 502, statusText: 'Bad Gateway' })))
      const store = createSubagentStore()
      store.init('user-1')
      await store.load()
      expect(store.error).toBe('Failed to load subagents: Bad Gateway')
      expect(store.loading).toBe(false)
    })

    it(`an assignment refusal falls back to status text for ${body}`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 502, statusText: 'Bad Gateway' })))
      const store = createSubagentStore()
      store.init('user-1')
      await expect(store.updateAgentSubagents('primary', [])).rejects.toThrow('Failed to update agent subagents: Bad Gateway')
      expect(store.error).toBe('Failed to update agent subagents: Bad Gateway')
    })
  }
})
