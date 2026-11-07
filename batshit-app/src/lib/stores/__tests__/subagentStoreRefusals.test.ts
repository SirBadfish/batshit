import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSubagentStore, refreshSubagentProviderSettingsFromServer, refreshSubagentInstructionsFromServer } from '$lib/stores/subagents.svelte'

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
        refusal(400, 'Bad Request', 'Max tool steps must be blank (no limit) or a whole number from 1 to 10,000.')
      )
    )
    const store = createSubagentStore()
    store.init('user-1')

    await expect(store.update('helper', { max_tool_steps: 0 })).rejects.toThrow(
      'Failed to update subagent: Max tool steps must be blank (no limit) or a whole number from 1 to 10,000.'
    )
    expect(store.error).toBe(
      'Failed to update subagent: Max tool steps must be blank (no limit) or a whole number from 1 to 10,000.'
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

describe('Subagent typed-choice receipt forwarding', () => {
  const ack = { revision: `sha256:${'a'.repeat(64)}`, value: true }
  const before = { id: 'typed', user_id: 'user-1', displayName: 'Owned', subagentType: 'api', provider_specific_settings: { nativeTools: { typedFileToolsEnabled: false } } }
  const body = { expectedTypedFileTools: `sha256:${'b'.repeat(64)}`, provider_specific_settings: { nativeTools: { typedFileToolsEnabled: true } } }
  it('returns a separate saved receipt without inserting request metadata into the subject', async () => {
    const saved = { ...before, provider_specific_settings: body.provider_specific_settings }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ subagents: [before] })).mockResolvedValueOnce(Response.json({ subagent: saved, typedFileTools: ack })))
    const store = createSubagentStore(); store.init('user-1'); await store.load()
    expect((await store.update('typed', body)).typedFileTools).toEqual(ack)
    expect(store.subagents.find(row => row.id === 'typed')).toEqual(saved)
    expect(store.subagents.find(row => row.id === 'typed')).not.toHaveProperty('expectedTypedFileTools')
  })
  it('forwards a known saved receipt with unavailable followup data without inventing a record', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ subagents: [before] })).mockResolvedValueOnce(Response.json({ success: true, typedFileToolsSaved: true, typedFileTools: ack, readback: 'unavailable' })))
    const store = createSubagentStore(); store.init('user-1'); await store.load()
    expect(await store.update('typed', body)).toMatchObject({ subagent: null, typedFileTools: ack, readback: 'unavailable' })
    expect(store.subagents.find(row => row.id === 'typed')).toEqual(before)
  })
  it('retains a saved receipt on an error so its original caller can validate that receipt', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ subagents: [before] })).mockResolvedValueOnce(Response.json({ error: 'Followup unavailable', typedFileToolsSaved: true, typedFileTools: ack }, { status: 503 })))
    const store = createSubagentStore(); store.init('user-1'); await store.load()
    await expect(store.update('typed', body)).rejects.toMatchObject({ status: 503, typedFileTools: ack })
    expect(store.subagents.find(row => row.id === 'typed')).toEqual(before)
  })
})

const providerRow = (enabled: boolean) => ({ id: 'provider-child', user_id: 'provider-owner', subagentType: 'api', created_at: 'original-birth', displayName: 'Kept name', provider_specific_settings: { nativeTools: { webSearchEnabled: enabled } } })
describe('Subagent tool-setting read-only invalidation', () => {
  it('refreshes only the provider bag and preserves other fields on failed or foreign reads', async () => {
    const before = providerRow(false), next = { ...providerRow(true), displayName: 'Unrelated server name' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ subagents: [before] })).mockResolvedValueOnce(Response.json({ subagent: next }))
      .mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(Response.json({ subagent: { ...providerRow(false), user_id: 'foreign' } })))
    const store = createSubagentStore(); store.init('provider-owner'); await store.load()
    await refreshSubagentProviderSettingsFromServer(before.id)
    expect(store.subagents.find(row => row.id === before.id)).toEqual({ ...before, provider_specific_settings: next.provider_specific_settings })
    await refreshSubagentProviderSettingsFromServer(before.id); await refreshSubagentProviderSettingsFromServer(before.id)
    expect(store.subagents.find(row => row.id === before.id)?.provider_specific_settings).toEqual(next.provider_specific_settings)
  })
  it('discards an old read and drains one requested fresh read only after the own provider write settles', async () => {
    let releaseRead!: (response: Response) => void, releaseWrite!: (response: Response) => void
    const old = new Promise<Response>(resolve => { releaseRead = resolve }), write = new Promise<Response>(resolve => { releaseWrite = resolve })
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ subagents: [providerRow(false)] })).mockReturnValueOnce(old).mockReturnValueOnce(write)
      .mockResolvedValueOnce(Response.json({ subagent: providerRow(false) }))
    vi.stubGlobal('fetch', fetch)
    const store = createSubagentStore(); store.init('provider-owner'); await store.load()
    const reading = refreshSubagentProviderSettingsFromServer('provider-child')
    const writing = store.update('provider-child', { provider_specific_settings: { nativeTools: { webSearchEnabled: true } } })
    await refreshSubagentProviderSettingsFromServer('provider-child')
    expect(fetch).toHaveBeenCalledTimes(3)
    releaseRead(Response.json({ subagent: providerRow(false) })); await reading
    releaseWrite(Response.json({ subagent: providerRow(true) })); await writing
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4))
    await vi.waitFor(() => expect(store.subagents.find(row => row.id === 'provider-child')?.provider_specific_settings).toEqual(providerRow(false).provider_specific_settings))
  })
})

describe('Subagent provider refresh concurrent families and incarnation', () => {
  it('keeps a held provider event when independent instructions land first, without overwriting those instructions', async () => {
    let release!: (response: Response) => void
    const held = new Promise<Response>(resolve => { release = resolve })
    const before = { ...providerRow(false), system_prompt: 'Before' }
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ subagents: [before] })).mockReturnValueOnce(held)
      .mockResolvedValueOnce(Response.json({ subagent: { ...before, system_prompt: 'New instructions' } }))
    vi.stubGlobal('fetch', fetch)
    const store = createSubagentStore(); store.init('provider-owner'); await store.load()
    const reading = refreshSubagentProviderSettingsFromServer(before.id)
    await refreshSubagentInstructionsFromServer(before.id)
    release(Response.json({ subagent: { ...providerRow(true), system_prompt: 'Old instructions' } })); await reading
    expect(store.subagents.find(row => row.id === before.id)).toMatchObject({ system_prompt: 'New instructions', provider_specific_settings: providerRow(true).provider_specific_settings })
    expect(fetch).toHaveBeenCalledTimes(3)
  })
  it('refuses a foreign cached owner before fetching and a changed response incarnation without replacing its bag', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ subagents: [providerRow(false)] }))
      .mockResolvedValueOnce(Response.json({ subagent: { ...providerRow(true), created_at: 'new-birth' } }))
    vi.stubGlobal('fetch', fetch)
    const store = createSubagentStore(); store.init('provider-owner'); await store.load()
    store.init('other-owner'); await refreshSubagentProviderSettingsFromServer('provider-child')
    expect(fetch).toHaveBeenCalledOnce()
    store.init('provider-owner'); await refreshSubagentProviderSettingsFromServer('provider-child')
    expect(store.subagents.find(row => row.id === 'provider-child')).toEqual(providerRow(false))
  })
  it('cannot install an old incarnation response after the list installs its same-ID replacement', async () => {
    let release!: (response: Response) => void
    const held = new Promise<Response>(resolve => { release = resolve })
    const replacement = { ...providerRow(false), created_at: 'new-birth' }
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ subagents: [providerRow(false)] })).mockReturnValueOnce(held)
      .mockResolvedValueOnce(Response.json({ subagents: [replacement] }))
    vi.stubGlobal('fetch', fetch)
    const store = createSubagentStore(); store.init('provider-owner'); await store.load()
    const reading = refreshSubagentProviderSettingsFromServer('provider-child')
    await store.load(); release(Response.json({ subagent: providerRow(true) })); await reading
    expect(store.subagents.find(row => row.id === 'provider-child')).toEqual(replacement)
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})

it('retains the sole provider event across a later known-refused own attempt, without replaying the PUT', async () => {
  let release!: (response: Response) => void
  const held = new Promise<Response>(resolve => { release = resolve })
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ subagents: [providerRow(false)] })).mockReturnValueOnce(held)
    .mockResolvedValueOnce(Response.json({ error: 'Original source changed', code: 'model_selection_settings_changed' }, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ subagent: providerRow(true) }))
  vi.stubGlobal('fetch', fetch)
  const store = createSubagentStore(); store.init('provider-owner'); await store.load()
  const reading = refreshSubagentProviderSettingsFromServer('provider-child')
  await expect(store.update('provider-child', { provider_specific_settings: { nativeTools: { webSearchEnabled: false } } })).rejects.toMatchObject({ status: 409 })
  release(Response.json({ subagent: providerRow(true) })); await reading
  await vi.waitFor(() => expect(store.subagents.find(row => row.id === 'provider-child')?.provider_specific_settings).toEqual(providerRow(true).provider_specific_settings))
  expect(fetch).toHaveBeenCalledTimes(4)
  expect(fetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toHaveLength(1)
})
