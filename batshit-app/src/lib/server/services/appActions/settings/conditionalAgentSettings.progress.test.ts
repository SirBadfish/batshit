import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdmittedAgentSettingsExecutors, type ConditionalSettingsStore } from './conditionalAgentSettings'
import { createSettingsOperationRegistry } from './operationRegistry'
import type { SettingsOwnerContext } from '$lib/appActions/settings/validation'

afterEach(() => vi.useRealTimers())
describe('conditional Settings known-save progress', () => {
  it.each(['readback', 'write'] as const)('retains known settlement when the actual owner %s crosses the operation deadline, without replay', async phase => {
    vi.useFakeTimers()
    const raw = (value: unknown) => JSON.stringify([value])
    const snapshot = { raw: [raw('a'), raw('owner'), raw('api'), raw('Before'), ...Array(8).fill('[]')] }
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let afterWrite = false
    const store: ConditionalSettingsStore = {
      async read() { if (afterWrite && phase === 'readback') await held; return { raw: [...snapshot.raw] } },
      write: vi.fn(async () => { if (phase === 'write') await held; snapshot.raw[3] = raw('After'); afterWrite = true; return 'OK' })
    }
    const owner = createAdmittedAgentSettingsExecutors(store, context => context.check())
    const signal = new AbortController().signal
    const ownerContext: SettingsOwnerContext = { actor: { kind: 'portable', userId: 'owner' }, signal, check() {} }
    const current = await owner.readIdentity({ subjectAgentId: 'a' }, ownerContext)
    const registry = createSettingsOperationRegistry()
    const actor = { userId: 'owner', kind: 'portable' as const, id: 'token', generation: 1, label: 'Outside helper' }
    const subject = { kind: 'primary' as const, id: 'a' }
    const operation = registry.capture({ actor, permission: 'allow', requestId: `${registry.boot}:held-readback`,
      input: { changes: { displayName: 'After' } }, preimages: { revision: current.revision },
      preview: { semanticId: 'agent.identity', targets: [{ subject, label: 'Before', changes: [{ field: 'displayName', label: 'Display Name', before: 'Before', after: 'After' }] }], excluded: [], effects: ['Updates Display Name.'] },
      async refresh() {},
      async execute(execution) {
        execution.targetStarted(subject)
        const result = await owner.updateIdentity({ subjectAgentId: 'a', expectedRevision: current.revision, changes: { displayName: 'After' } }, {
          ...ownerContext, signal: execution.signal, deadlineAt: execution.deadlineAt,
          onSaved() { execution.recordOutcome({ subject, status: 'applied', saved: 'saved', readback: 'unavailable', visible: 'unknown', reason: 'saved_readback_pending' }) }
        } as SettingsOwnerContext & { onSaved(): void })
        return [{ subject, status: 'applied', saved: result.saved, readback: result.readback, visible: result.visible }]
      }
    })
    const pending = registry.portableExecute(operation.operationId, actor)
    try {
      await vi.advanceTimersByTimeAsync(30_001)
      expect(await pending).toMatchObject({ status: 'unknown_outcome', outcomes: [
        phase === 'readback' ? { subject, status: 'applied', saved: 'saved', readback: 'unavailable', reason: 'saved_readback_pending' } :
          { subject, status: 'unknown', saved: 'unknown', reason: 'target_execution_pending' }
      ] })
      expect(store.write).toHaveBeenCalledOnce()
      await registry.portableExecute(operation.operationId, actor)
      expect(store.write).toHaveBeenCalledOnce()
    } finally { release() }
    await vi.advanceTimersByTimeAsync(0)
    expect(registry.outcome(operation.operationId, actor)).toMatchObject({ status: 'completed', outcomes: [
      { subject, saved: 'saved', readback: 'verified' }
    ] })
    expect(store.write).toHaveBeenCalledOnce()
  })
})
