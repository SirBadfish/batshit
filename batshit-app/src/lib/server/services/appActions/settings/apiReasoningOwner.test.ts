import { describe, expect, it, vi } from 'vitest'
import { createAdmittedAgentSettingsExecutors, settingsFamilyRevision, type ConditionalSettingsStore } from './conditionalAgentSettings'
import type { SettingsOwnerContext } from '$lib/appActions/settings/validation'

const raw = (value: unknown) => value === undefined ? '[]' : JSON.stringify([value])
function fixture(type: 'api' | 'cli' = 'api') {
  const snapshot = { raw: ['a', 'owner', type, 'A', false, { recalled: 7 }, undefined, 2, undefined, 2, undefined, undefined,
    undefined, undefined, 'neither', 1500].map(raw) }
  const paths = { displayReasoning: 12, displayWhiteboard: 13, mode: 14, whiteboardBudgetTokens: 15 }
  const store: ConditionalSettingsStore = {
    read: vi.fn(async () => ({ raw: [...snapshot.raw] })),
    write: vi.fn(async (_id, _user, _family, _before, changes) => {
      for (const [field, value] of Object.entries(changes)) snapshot.raw[paths[field as keyof typeof paths]] = raw(value === null ? undefined : value)
      return 'OK'
    })
  }
  const context: SettingsOwnerContext = { actor: { kind: 'portable', userId: 'owner' }, signal: new AbortController().signal,
    subjectKind: 'primary', onSaved: vi.fn(), check() {} }
  return { snapshot, store, context, owner: createAdmittedAgentSettingsExecutors(store, ctx => ctx.check()) }
}

describe('fixed API preference conditional JS owner', () => {
  it('stores an explicit factory-equivalent preference, changes only requested leaves, then resets losslessly', async () => {
    const f = fixture()
    const first = await f.owner.updateFamily('api-presentation', { subjectAgentId: 'a', expectedRevision: settingsFamilyRevision(f.snapshot, 'api-presentation'), changes: { displayReasoning: true } }, f.context)
    expect(first).toMatchObject({ saved: 'saved', readback: 'verified', current: { values: { displayReasoning: true, displayWhiteboard: true }, stored: { displayReasoning: true, displayWhiteboard: null } } })
    expect(f.snapshot.raw[13]).toBe('[]')
    expect(f.snapshot.raw[14]).toBe(raw('neither'))
    expect(f.store.write).toHaveBeenCalledTimes(1)
    const second = await f.owner.updateFamily('api-presentation', { subjectAgentId: 'a', expectedRevision: first.current!.revision, changes: { displayReasoning: null } }, f.context)
    expect(second).toMatchObject({ saved: 'saved', readback: 'verified', current: { values: { displayReasoning: true }, stored: { displayReasoning: null } }, inverse: { changes: { displayReasoning: true } } })
    expect(f.snapshot.raw[12]).toBe('[]')
    expect(f.context.onSaved).toHaveBeenCalledTimes(2)
  })
  it('retains false, mode and budget while preserving unrelated Memory/display data', async () => {
    const f = fixture()
    const display = await f.owner.updateFamily('api-presentation', { subjectAgentId: 'a', expectedRevision: settingsFamilyRevision(f.snapshot, 'api-presentation'), changes: { displayWhiteboard: false } }, f.context)
    expect(display).toMatchObject({ saved: 'saved', current: { values: { displayWhiteboard: false } } })
    const result = await f.owner.updateFamily('api-retention', { subjectAgentId: 'a', expectedRevision: settingsFamilyRevision(f.snapshot, 'api-retention'), changes: { mode: 'both', whiteboardBudgetTokens: 250 } }, f.context)
    expect(result).toMatchObject({ saved: 'saved', readback: 'verified', current: { values: { mode: 'both', whiteboardBudgetTokens: 250 } } })
    expect(f.snapshot.raw[5]).toBe(raw({ recalled: 7 }))
    expect(f.snapshot.raw[13]).toBe(raw(false))
    expect(f.snapshot.raw[3]).toBe(raw('A'))
  })
  it('refuses unsupported type, foreign fields and stale revision before a write', async () => {
    // SA-139 R4: a leftover `cli` Primary is a retired type, refused by the owner check itself.
    const f = fixture('cli')
    await expect(f.owner.updateFamily('api-presentation', { subjectAgentId: 'a', expectedRevision: settingsFamilyRevision(f.snapshot, 'api-presentation'), changes: { displayReasoning: false } }, f.context)).rejects.toThrow('unsupported_primary_agent')
    const api = fixture()
    await expect(api.owner.updateFamily('api-retention', { subjectAgentId: 'a', expectedRevision: settingsFamilyRevision(api.snapshot, 'api-retention'), changes: { memory_enabled: true } }, api.context)).rejects.toThrow()
    expect(await api.owner.updateFamily('api-retention', { subjectAgentId: 'a', expectedRevision: `sha256:${'0'.repeat(64)}`, changes: { mode: 'both' } }, api.context)).toMatchObject({ reason: 'revision_conflict', saved: 'not_requested' })
    expect(f.store.write).not.toHaveBeenCalled()
    expect(api.store.write).not.toHaveBeenCalled()
  })
})
