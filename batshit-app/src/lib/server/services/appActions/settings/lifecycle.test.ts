import { describe, expect, it, vi } from 'vitest'

async function fresh() { vi.resetModules(); return import('./lifecycle') }
describe('Settings lifecycle revisions and issued-write custody', () => {
  it('checks the exact outer replacement without registering a mutation lease or weakening its admission', async () => {
    const owner = await fresh()
    expect(() => owner.assertSettingsRecordReplacement('agent:a')).toThrow('replacement is not admitted')
    await owner.withSettingsRecordReplacement('agent:a', async () => {
      expect(owner.assertSettingsRecordReplacement('agent:a')).toBeUndefined()
      expect(() => owner.assertSettingsRecordReplacement('agent:b')).toThrow('replacement is not admitted')
      const lease = owner.acquireSettingsReplacementMutation('agent:a')
      expect(() => lease.check()).not.toThrow()
      lease.settle()
    })
    expect(() => owner.assertSettingsRecordReplacement('agent:a')).toThrow('replacement is not admitted')
    // An assertion-only caller cannot leave an invisible lease pinning later restore.
    await expect(owner.withSettingsRestoreFence(async () => 'drained')).resolves.toBe('drained')
  })
  it('invalidates an identical-data replacement independently of caller dates or policy generation', async () => {
    const owner = await fresh()
    const before = owner.captureSettingsLifecycle(['agent:a'])
    let stored = { id: 'a', created_at: 'preserved', generation: 0 }
    await owner.withSettingsRecordReplacement('agent:a', async () => { stored = { ...stored } })
    expect(stored).toEqual({ id: 'a', created_at: 'preserved', generation: 0 })
    expect(() => owner.acquireSettingsMutation(before)).toThrow('identity changed')
    expect(owner.captureSettingsLifecycle(['agent:a'])).not.toEqual(before)
  })
  it('closes new admission synchronously and waits for an already-issued write before replacement', async () => {
    const owner = await fresh()
    const before = owner.captureSettingsLifecycle(['agent:a'])
    const lease = owner.acquireSettingsMutation(before)
    const replace = vi.fn(async () => {})
    const pending = owner.withSettingsRecordReplacement('agent:a', replace)
    expect(() => owner.captureSettingsLifecycle(['agent:a'])).toThrow()
    expect(() => lease.check()).toThrow()
    await Promise.resolve()
    expect(replace).not.toHaveBeenCalled()
    lease.settle(); await pending
    expect(replace).toHaveBeenCalledOnce()
  })
  it('refuses replacement and restore when an issued write has unknown settlement', async () => {
    const owner = await fresh()
    const lease = owner.acquireSettingsMutation(owner.captureSettingsLifecycle(['agent:a']))
    lease.unknown()
    const replace = vi.fn(async () => {})
    await expect(owner.withSettingsRecordReplacement('agent:a', replace)).rejects.toThrow('unknown outcome')
    await expect(owner.withSettingsRestoreFence(replace)).rejects.toThrow('unknown outcome')
    expect(replace).not.toHaveBeenCalled()
  })
  it('restore invalidates old forms even on failure and waits for actual record owners', async () => {
    const owner = await fresh()
    const before = owner.captureSettingsLifecycle(['agent:a'])
    let finish!: () => void
    let began!: () => void
    const started = new Promise<void>(resolve => { began = resolve })
    const replacement = owner.withSettingsRecordReplacement('agent:b', () => new Promise<void>(resolve => { finish = resolve; began() }))
    await started
    const restore = vi.fn(async () => { throw new Error('rollback retained the same data') })
    const restoring = owner.withSettingsRestoreFence(restore)
    expect(() => owner.captureSettingsLifecycle(['agent:a'])).toThrow()
    expect(restore).not.toHaveBeenCalled()
    finish(); await replacement
    await expect(restoring).rejects.toThrow('rollback retained')
    expect(() => owner.acquireSettingsMutation(before)).toThrow()
  })
  it('retains an unknown restore grant fence after the attempt returns and prevents new management/replacement', async () => {
    const owner = await fresh()
    await owner.withSettingsRestoreFence(async () => { owner.acquireSettingsRestoreMutation().unknown() })
    expect(owner.settingsRestoreAuthorityUncertain()).toBe(true)
    expect(() => owner.captureSettingsLifecycle(['agent:a'])).toThrow('unknown outcome')
    await expect(owner.withSettingsRecordReplacement('agent:a', async () => {})).rejects.toThrow('unknown outcome')
  })
})
