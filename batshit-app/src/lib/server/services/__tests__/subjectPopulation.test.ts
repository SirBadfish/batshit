import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

async function fresh() {
  vi.resetModules()
  vi.stubEnv('BATSHIT_AGENT_RUNTIME_ROOT', path.join(os.tmpdir(), `c3-population-${randomUUID()}`))
  return { life: await import('../appActions/settings/lifecycle'), owner: await import('../subjectPopulation') }
}
afterEach(() => vi.unstubAllEnvs())
const subject = { userId: 'owner', subjectId: 'a', expectedCatalogueRevision: null }

describe('actual subject-population replacement owner custody', () => {
  it('refuses outside an admitted exact replacement before any Redis work', async () => {
    const { owner } = await fresh()
    const client = { eval: vi.fn() }
    await expect(owner.deleteSubagentPopulation(client, subject)).rejects.toThrow('not admitted')
    await expect(owner.createSubjectPopulation(client, { ...subject, kind: 'primary', mode: 'replace-owned', record: { id: 'a', user_id: 'owner' } })).rejects.toThrow('not admitted')
    expect(client.eval).not.toHaveBeenCalled()
  })
  it('keeps explicit modes and fixed record/index/revision keys in one physical mutation after the captured raw read', async () => {
    const { life, owner } = await fresh()
    const before = '[{"id":"a","user_id":"owner","keep":true}]'
    const client = { eval: vi.fn(async (_script: string, command: { keys: string[]; arguments: string[] }) =>
      command.keys.length === 1 ? ['OK', before] : 'REPLACED') }
    await expect(life.withSettingsRecordReplacement('agent:a', () => owner.createSubjectPopulation(client,
      { ...subject, kind: 'primary', mode: 'replace-owned', record: { id: 'a', user_id: 'owner' } }))).resolves.toMatchObject({ status: 'REPLACED' })
    expect(client.eval).toHaveBeenCalledTimes(3)
    const mutation = client.eval.mock.calls[2][1]
    expect(mutation.keys).toEqual(['agent:a', 'user:owner:agents', 'slash_command_revision:owner', 'subagent:a'])
    expect(mutation.arguments[0]).toBe(before)
    expect(mutation.arguments[4]).toBe('replace-owned')
    expect(mutation.arguments[5]).toMatch(/^[a-f0-9]{64}$/)
  })
  it('retains the existing creation owner rule without importing the App Actions selector length cap', async () => {
    const { life, owner } = await fresh()
    const id = 'long_'.repeat(30)
    const client = { eval: vi.fn(async (_script: string, command: { keys: string[]; arguments: string[] }) => command.keys.length === 1 ? ['OK', ''] : 'CREATED') }
    await expect(life.withSettingsRecordReplacement(`agent:${id}`, () => owner.createSubjectPopulation(client,
      { userId: 'owner', subjectId: id, kind: 'primary', mode: 'create', record: { id, user_id: 'owner' } }))).resolves.toMatchObject({ status: 'CREATED' })
    expect(client.eval.mock.calls[2][1].keys[0]).toBe(`agent:${id}`)
  })
  it('keeps deletion-only legacy identities exact without relaxing creation or touching a normalized alias', async () => {
    const { life, owner } = await fresh()
    const client = { eval: vi.fn(async (_script: string, command: { keys: string[]; arguments: string[] }) => command.keys.length === 1
      ? ['OK', '[{"id":"odd.id","user_id":"owner"}]'] : 'DELETED') }
    await expect(life.withSettingsRecordReplacement('subagent:odd.id', () => owner.deleteSubagentPopulation(client,
      { userId: 'owner', subjectId: 'odd.id', expectedCatalogueRevision: null }))).resolves.toBe('DELETED')
    expect(client.eval.mock.calls[2][1]).toMatchObject({ keys: ['subagent:odd.id', 'user:owner:subagents', 'slash_command_revision:owner'], arguments: ['odd.id', 'owner', expect.any(String), ''] })
    client.eval.mockClear()
    await expect(owner.createSubjectPopulation(client, { userId: 'owner', subjectId: 'odd.id', kind: 'subagent', mode: 'create', record: { id: 'odd.id', user_id: 'owner' } })).rejects.toThrow('Invalid subject identity')
    expect(client.eval).not.toHaveBeenCalled()
  })
  it('releases known preflight refusal and read failure without certifying a save or blocking later replacement', async () => {
    const { life, owner } = await fresh()
    for (const failRead of [false, true]) {
      const client = { eval: vi.fn(async (_script: string, command: { keys: string[] }) => {
        if (command.keys.length === 1) { if (failRead) throw new Error('read unavailable'); return ['OK', ''] }
        return 'CONFLICT'
      }) }
      await expect(life.withSettingsRecordReplacement('subagent:a', () => owner.createSubjectPopulation(client,
        { ...subject, kind: 'subagent', mode: 'create', record: { id: 'a', user_id: 'owner' } }))).rejects.toMatchObject({ uncertain: false })
      await expect(life.withSettingsRecordReplacement('subagent:a', async () => 'next')).resolves.toBe('next')
    }
  })
  it.each(['create', 'delete-subagent', 'delete-primary', 'partial-delete'] as const)('holds %s uncertainty through actual replacement and restore owners without replay', async kind => {
    const { life, owner } = await fresh()
    let mutations = 0
    const client = { eval: vi.fn(async (_script: string, command: { keys: string[] }) => {
      if (command.keys.length === 1) return ['OK', kind === 'create' ? '' : '[{"id":"a","user_id":"owner"}]']
      mutations++
      if (kind === 'partial-delete') return 'PARTIAL'
      throw new Error('reply lost after issue')
    }) }
    const key = kind === 'create' || kind === 'delete-primary' ? 'agent:a' : 'subagent:a'
    const effect = () => kind === 'create' ? owner.createSubjectPopulation(client,
      { ...subject, kind: 'primary', mode: 'replace-owned', record: { id: 'a', user_id: 'owner' } }) :
      kind === 'delete-primary' ? owner.deletePrimaryPopulation(client, subject) : owner.deleteSubagentPopulation(client, subject)
    await expect(life.withSettingsRecordReplacement(key, effect)).rejects.toMatchObject({ uncertain: true, status: 503, code: 'SUBJECT_POPULATION_UNCONFIRMED' })
    await expect(life.withSettingsRecordReplacement(key, effect)).rejects.toThrow('unknown')
    await expect(life.withSettingsRestoreFence(async () => 'restore')).rejects.toThrow('unknown')
    expect(mutations).toBe(1)
  })
  it('holds an inserted Subagent behind its canonical shared deletion resource before population EVAL', async () => {
    const { life, owner } = await fresh()
    const { withProfileFolderTurn } = await import('../agentProfileFolderQueue')
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
    const folder = withProfileFolderTurn('batshit_agent_subagent_cli_shared', async () => { entered(); await held })
    await started
    let mutations = 0
    const client = { eval: vi.fn(async (_script: string, command: { keys: string[] }) => {
      if (command.keys.length === 1) return ['OK', '']
      mutations++; return 'CREATED'
    }) }
    const pending = life.withSettingsRecordReplacement('subagent:a', () => owner.createSubjectPopulation(client,
      { ...subject, kind: 'subagent', mode: 'create', record: { id: 'a', user_id: 'owner', slug: 'shared' } } as any))
    try { await vi.waitFor(() => expect(client.eval).toHaveBeenCalledOnce()); expect(mutations).toBe(0) }
    finally { release() }
    await folder
    await expect(pending).resolves.toMatchObject({ status: 'CREATED' })
    expect(mutations).toBe(1)
  })
  it('queues unissued creation without mutation/reference leases, permits referenced-preset replacement and then refuses its original stale reference', async () => {
    const { life, owner } = await fresh()
    const { withProfileFolderTurn } = await import('../agentProfileFolderQueue')
    const referenceOwner = await import('../modelPresetReferenceGuard'), presets = await import('../modelPresetSelectionOwner')
    const mutationLease = vi.spyOn(life, 'acquireSettingsReplacementMutation')
    const referenceLease = vi.spyOn(referenceOwner, 'admitPresetReferences')
    const storage = vi.spyOn(presets, 'readModelPresetStorage').mockResolvedValue({ present: true, raw: '[{"id":"referenced"}]', preset: { id: 'referenced' } } as never)
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
    const folder = withProfileFolderTurn('batshit_agent_queued_population', async () => { entered(); await held })
    await started
    const client = { eval: vi.fn(async (_script: string, command: { keys: string[] }) => command.keys.length === 1 ? ['OK', ''] : 'CREATED') }
    const pending = life.withSettingsRecordReplacement('agent:queued_population', () => owner.createSubjectPopulation(client,
      { userId: 'owner', subjectId: 'queued_population', kind: 'primary', mode: 'create', record: { id: 'queued_population', user_id: 'owner',
        primary_model_preset_id: 'referenced', claude_settings: { permissionMode: 'default' } } } as any))
    const rejected = expect(pending).rejects.toBeInstanceOf(life.SettingsLifecycleRefusal)
    try {
      try {
        await vi.waitFor(() => expect(client.eval).toHaveBeenCalledOnce())
        expect(mutationLease).not.toHaveBeenCalled()
        expect(referenceLease).not.toHaveBeenCalled()
        expect(storage).not.toHaveBeenCalled()
        await expect(life.withSettingsRecordReplacement('model:referenced', async () => 'replacement settled')).resolves.toBe('replacement settled')
        expect(client.eval).toHaveBeenCalledOnce()
      } finally { release() }
      await folder; await rejected
      expect(client.eval.mock.calls.every(([, command]) => command.keys.length === 1)).toBe(true)
      expect(storage).not.toHaveBeenCalled()
      await expect(life.withSettingsRecordReplacement('agent:queued_population', async () => 'target custody released')).resolves.toBe('target custody released')
    } finally {
      release(); await Promise.allSettled([folder, pending, rejected])
      mutationLease.mockRestore(); referenceLease.mockRestore(); storage.mockRestore()
    }
  })
  it.each(['primary', 'subagent'] as const)('queues %s deletion without a mutation lease and refuses a changed original raw record before issue', async kind => {
    const { life, owner } = await fresh()
    const { withProfileFolderTurn } = await import('../agentProfileFolderQueue')
    const key = `${kind === 'primary' ? 'agent' : 'subagent'}:queued_delete`
    const profile = kind === 'primary' ? 'batshit_agent_queued_delete' : 'batshit_agent_subagent_cli_queued_delete'
    const mutationLease = vi.spyOn(life, 'acquireSettingsReplacementMutation')
    let current = '[{"id":"queued_delete","user_id":"owner"}]'
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
    const folder = withProfileFolderTurn(profile, async () => { entered(); await held })
    await started
    const client = { eval: vi.fn(async (_script: string, command: { keys: string[] }) => command.keys.length === 1 ? ['OK', current] : 'DELETED') }
    const pending = life.withSettingsRecordReplacement(key, () => kind === 'primary'
      ? owner.deletePrimaryPopulation(client, { userId: 'owner', subjectId: 'queued_delete', expectedCatalogueRevision: null })
      : owner.deleteSubagentPopulation(client, { userId: 'owner', subjectId: 'queued_delete', expectedCatalogueRevision: null }))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'SUBJECT_POPULATION_CONFLICT', uncertain: false })
    try {
      try {
        await vi.waitFor(() => expect(client.eval).toHaveBeenCalledOnce())
        expect(mutationLease).not.toHaveBeenCalled()
        current = '[{"id":"queued_delete","user_id":"owner","changed":true}]'
      } finally { release() }
      await folder; await rejected; expect(mutationLease).not.toHaveBeenCalled(); expect(client.eval.mock.calls.every(([, command]) => command.keys.length === 1)).toBe(true)
    } finally { release(); await Promise.allSettled([folder, pending, rejected]); mutationLease.mockRestore() }
  })
})
