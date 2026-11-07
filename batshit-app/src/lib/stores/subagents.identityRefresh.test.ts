import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSubagentStore, refreshSubagentIdentityFromServer, refreshSubagentModelSelectionFromServer, refreshSubagentInstructionsFromServer } from './subagents.svelte'
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('Subagent identity live projection', () => {
  it('retains the cache when an issued instructions PUT answers with an invalid record and never replays it', async () => {
    const store = createSubagentStore()
    store.init('owner')
    const row = { id: 'invalid_instruction_reply', user_id: 'owner', subagentType: 'api', system_prompt: 'Before' }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ subagents: [row] })))
    await store.load()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ subagent: { ...row, id: 'another' } })))
    await expect(store.update(row.id, { system_prompt: 'Draft', expectedInstructions: { customPrompt: `sha256:${'a'.repeat(64)}` } })).rejects.toThrow('did not confirm this Subagent')
    expect(store.subagents[0]).toEqual(row)
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })
  it('does not let an older unrelated PUT response replace newer saved instructions', async () => {
    const store = createSubagentStore()
    store.init('owner')
    const row = { id: 'late_unrelated', user_id: 'owner', subagentType: 'api', displayName: 'Before', system_prompt: 'Before' }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ subagents: [row] })))
    await store.load()
    const pending: Array<(value: Response) => void> = []
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => pending.push(resolve))))
    const unrelated = store.update(row.id, { displayName: 'Renamed' })
    const instructions = store.update(row.id, { system_prompt: 'New saved text', expectedInstructions: { customPrompt: `sha256:${'a'.repeat(64)}` } })
    pending[1](Response.json({ subagent: { ...row, system_prompt: 'New saved text' } }))
    await instructions
    pending[2](Response.json({ subagent: { ...row, displayName: 'Renamed', system_prompt: 'New saved text' } }))
    await new Promise(resolve => setTimeout(resolve, 0))
    pending[0](Response.json({ subagent: { ...row, displayName: 'Renamed' } }))
    await unrelated
    expect(store.subagents[0]).toMatchObject({ displayName: 'Renamed', system_prompt: 'New saved text' })
    pending[3](Response.json({ subagent: { ...row, displayName: 'Renamed', system_prompt: 'New saved text' } }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(vi.mocked(fetch).mock.calls.filter(([, options]) => (options as RequestInit | undefined)?.method === 'PUT')).toHaveLength(2)
  })
  it('keeps a newer accepted same-value instructions record over an older read', async () => {
    const store = createSubagentStore()
    store.init('owner')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ subagents: [{ id: 'same_instructions', user_id: 'owner', subagentType: 'api', system_prompt: 'Kept' }] })))
    await store.load()
    let finish!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const read = refreshSubagentInstructionsFromServer('same_instructions')
    store.acceptServerRecord({ ...store.subagents[0], system_prompt: 'Kept' })
    finish(Response.json({ subagent: { id: 'same_instructions', user_id: 'owner', subagentType: 'api', system_prompt: 'Older remote' } }))
    await read
    expect(store.subagents[0].system_prompt).toBe('Kept')
  })
  it('reads only instructions and defers a known409 refresh until the actual PUT settles', async () => {
    const store = createSubagentStore()
    store.init('owner')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ subagents: [{ id: 'sub_instructions', user_id: 'owner', subagentType: 'api', displayName: 'Keep', system_prompt: 'Before' }] })))
    await store.load()
    const pending: Array<(value: Response) => void> = []
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => pending.push(resolve))))
    const read = refreshSubagentInstructionsFromServer('sub_instructions')
    pending[0](Response.json({ subagent: { id: 'sub_instructions', user_id: 'owner', subagentType: 'api', displayName: 'Ignored', system_prompt: null, include_global_prompt: false } }))
    await read
    expect(store.subagents[0]).toMatchObject({ displayName: 'Keep', system_prompt: null, include_global_prompt: false })
    const save = store.update('sub_instructions', { system_prompt: 'Draft', expectedInstructions: { customPrompt: `sha256:${'a'.repeat(64)}` } })
    const rejected = expect(save).rejects.toMatchObject({ status: 409 })
    await refreshSubagentInstructionsFromServer('sub_instructions')
    expect(pending).toHaveLength(2)
    pending[1](Response.json({ error: 'Changed', code: 'instructions_settings_changed' }, { status: 409 }))
    await rejected
    expect(pending).toHaveLength(3)
    pending[2](Response.json({ subagent: { id: 'sub_instructions', user_id: 'owner', subagentType: 'api', system_prompt: 'Remote' } }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(store.subagents[0]).toMatchObject({ displayName: 'Keep', system_prompt: 'Remote' })
    expect(Object.hasOwn(store.subagents[0], 'include_global_prompt')).toBe(false)
    expect(vi.mocked(fetch).mock.calls.filter(([, options]) => (options as RequestInit | undefined)?.method === 'PUT')).toHaveLength(1)
  })
  it('refreshes only the four model identities and rejects a stale model read after a local choice', async () => {
    const store = createSubagentStore()
    store.init('owner')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ subagents: [{ id: 'sub', user_id: 'owner', displayName: 'Keep', primary_model_name: 'before', provider_specific_settings: { codex_model: 'keep' } }] })))
    await store.load()
    const pending: Array<(value: Response) => void> = []
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => pending.push(resolve))))
    const fresh = refreshSubagentModelSelectionFromServer('sub')
    pending[0](Response.json({ subagent: { id: 'sub', user_id: 'owner', primary_model_name: 'fresh', displayName: 'Do not copy', provider_specific_settings: {} } }))
    await fresh
    expect(store.subagents[0]).toMatchObject({ displayName: 'Keep', primary_model_name: 'fresh', provider_specific_settings: { codex_model: 'keep' } })
    const stale = refreshSubagentModelSelectionFromServer('sub')
    store.acceptServerRecord({ ...store.subagents[0], primary_model_name: 'newer' })
    pending[1](Response.json({ subagent: { id: 'sub', user_id: 'owner', primary_model_name: 'stale' } }))
    await stale
    expect(store.subagents[0].primary_model_name).toBe('newer')
  })
  it('does not overwrite a newer accepted same-name save with an older in-flight read', async () => {
    const store = createSubagentStore()
    store.init('owner')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ subagents: [{ id: 'same', user_id: 'owner', displayName: 'Original' }] })))
    await store.load()
    let finish!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const pending = refreshSubagentIdentityFromServer('same')
    store.acceptServerRecord({ ...store.subagents[0], displayName: 'Original' })
    finish(Response.json({ subagent: { id: 'same', user_id: 'owner', displayName: 'Older read' } }))
    await pending
    expect(store.subagents[0].displayName).toBe('Original')
  })
  it('takes only the name, drops older reads and preserves a newer local save', async () => {
    const store = createSubagentStore()
    store.init('owner')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ subagents: [{ id: 'sub', user_id: 'owner', displayName: 'Before', system_prompt: 'Keep' }] })))
    await store.load()
    const pending: Array<(value: Response) => void> = []
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => pending.push(resolve))))
    const older = refreshSubagentIdentityFromServer('sub'), newer = refreshSubagentIdentityFromServer('sub')
    pending[1](Response.json({ subagent: { id: 'sub', user_id: 'owner', displayName: 'New', system_prompt: 'Do not copy' } }))
    await newer
    pending[0](Response.json({ subagent: { id: 'sub', user_id: 'owner', displayName: 'Stale' } }))
    await older
    expect(store.subagents[0]).toMatchObject({ displayName: 'New', system_prompt: 'Keep' })
    const inFlight = refreshSubagentIdentityFromServer('sub')
    store.acceptServerRecord({ ...store.subagents[0], displayName: 'Own saved name' })
    pending[2](Response.json({ subagent: { id: 'sub', user_id: 'owner', displayName: 'Older server read' } }))
    await inFlight
    expect(store.subagents[0].displayName).toBe('Own saved name')
  })
})
