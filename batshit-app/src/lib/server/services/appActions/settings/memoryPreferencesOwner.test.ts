import { describe, expect, it, vi } from 'vitest'
import { createAdmittedAgentSettingsExecutors, SETTINGS_SNAPSHOT_PATHS, type ConditionalSettingsStore } from './conditionalAgentSettings'
import { readMemoryEnableReadiness } from '../../memory/memoryEnableReadiness'
import type { SettingsOwnerContext } from '$lib/appActions/settings/validation'

const raw = (value: unknown) => value === undefined ? '[]' : JSON.stringify([value])
async function fixture(enabled = false, ready = false) {
  const record: Record<string, any> = { id: 'memory_owner', user_id: 'owner', agentType: 'api', memory_enabled: enabled,
    memory_window: { floor_mode: 'custom', ceiling_headroom_mode: 'auto', floor_tokens: 54321, summary_model_mode: 'current' }, memory_lane_budgets: { recalled: 300 } }
  const readiness = await readMemoryEnableReadiness({ async eval() { return ['OK', `memory-enable-v1:${'a'.repeat(40)}`, ready ? 'api' : 'builtin', ready ? '' : 'builtin:embeddinggemma-300m'] } })
  const store: ConditionalSettingsStore = {
    readMemoryReadiness: vi.fn(async () => readiness),
    async read() { return { raw: SETTINGS_SNAPSHOT_PATHS.map(path => raw(path.slice(2).split('.').reduce((value, key) => value?.[key], record))), memoryWindowParents: ['object', ''] } },
    write: vi.fn(async (_id, _user, _family, _before, changes, _admit, _signal, _deadline, context) => {
      context?.memoryEnableSource?.check()
      if ('enabled' in changes) record.memory_enabled = changes.enabled
      if ('windowMode' in changes) { record.memory_window.floor_mode = 'auto'; record.memory_window.ceiling_headroom_mode = 'auto' }
      if ('recalled' in changes) record.memory_lane_budgets.recalled = changes.recalled
      return 'OK'
    })
  }
  const owner = createAdmittedAgentSettingsExecutors(store, context => context.check())
  const context: SettingsOwnerContext = { actor: { kind: 'portable', userId: 'owner' }, signal: new AbortController().signal, check() {} }
  const read = await owner.readMemory({ subjectAgentId: 'memory_owner' }, context)
  expect(read.values).not.toHaveProperty('root')
  expect(JSON.stringify(read.values)).not.toContain('$.')
  return { owner, store, context, record, args: (changes: unknown) => ({ subjectAgentId: 'memory_owner', expectedRevision: read.revision, changes }) }
}
describe('ready-only Memory gate at the existing conditional owner', () => {
  it('refuses the complete mixed target before its first effect when enablement is unprepared', async () => {
    const f = await fixture()
    expect(await f.owner.previewMemory(f.args({ enabled: true, windowMode: 'auto', recalled: 0 }), f.context)).toMatchObject({ status: 'blocked', reason: 'builtin-model-preparation-required' })
    expect(await f.owner.updateMemory(f.args({ enabled: true, windowMode: 'auto', recalled: 0 }), f.context)).toMatchObject({ saved: 'not_requested', status: 'blocked' })
    expect(f.store.write).not.toHaveBeenCalled()
    expect(f.record).toMatchObject({ memory_enabled: false, memory_window: { floor_mode: 'custom' }, memory_lane_budgets: { recalled: 300 } })
  })
  it('carries a ready transition into the final owner and verifies its actual effect', async () => {
    const f = await fixture(false, true)
    const result = await f.owner.updateMemory(f.args({ enabled: true, windowMode: 'auto' }), f.context)
    expect(result).toMatchObject({ saved: 'saved', readback: 'verified', inverseUnavailable: 'previous_window_modes_require_human' })
    expect(f.store.write).toHaveBeenCalledOnce()
    expect(vi.mocked(f.store.write).mock.calls[0][8]?.memoryEnableSource?.source).toMatch(/^memory-enable-v1:/)
    expect(f.record.memory_window).toMatchObject({ floor_mode: 'auto', ceiling_headroom_mode: 'auto', floor_tokens: 54321, summary_model_mode: 'current' })
  })
  it.each([{ enabled: false }, { windowMode: 'auto' }, { recalled: 0 }])('does not consult readiness for independent %j', async changes => {
    const f = await fixture(true)
    expect(await f.owner.updateMemory(f.args(changes), f.context)).toMatchObject({ saved: 'saved' })
    expect(f.store.readMemoryReadiness).not.toHaveBeenCalled()
  })
  it('keeps already-enabled true and already-automatic window as no-ops without a readiness gate', async () => {
    const f = await fixture(true)
    expect(await f.owner.updateMemory(f.args({ enabled: true }), f.context)).toMatchObject({ status: 'no_op' })
    expect(f.store.write).not.toHaveBeenCalled()
    expect(f.store.readMemoryReadiness).not.toHaveBeenCalled()
  })
  it('allows disable with a malformed window without normalizing or writing that window', async () => {
    const f = await fixture(true)
    f.record.memory_window.floor_mode = { bad: 'preserve' }
    const current = await f.owner.readMemory({ subjectAgentId: 'memory_owner' }, f.context)
    expect(current.values.floorMode).toBe('unknown')
    expect(await f.owner.updateMemory({ subjectAgentId: 'memory_owner', expectedRevision: current.revision, changes: { enabled: false } }, f.context)).toMatchObject({ saved: 'saved' })
    expect(f.record.memory_window.floor_mode).toEqual({ bad: 'preserve' })
  })
})
