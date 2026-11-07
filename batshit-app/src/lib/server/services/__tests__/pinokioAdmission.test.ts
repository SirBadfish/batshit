// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __resetPinokioAdmissionForTests, fencePinokioOperations, ownPinokioOperation, pinokioBindingFingerprint, pinokioTargetFromQuery } from '../pinokioAdmission'

afterEach(() => { __resetPinokioAdmissionForTests(); vi.useRealTimers() })

describe('finite Pinokio admission and synchronous restore fencing', () => {
  it('checks supplied authority on every assert and after an awaited admission', async () => {
    let finish!: () => void
    const admit = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const operation = ownPinokioOperation({ admit })
    const pending = operation.assert()
    const hold = fencePinokioOperations()
    expect(operation.signal.aborted).toBe(true)
    expect(() => ownPinokioOperation({ admit: async () => {} })).toThrow(/paused/)
    finish()
    await expect(pending).rejects.toMatchObject({ code: 'pinokio_operation_cancelled' })
    operation.close()
    await hold.settle()
    hold.release()
  })

  it('never treats an aborted observer as settled before its owner closes it', async () => {
    vi.useFakeTimers()
    const operation = ownPinokioOperation({ admit: async () => {} })
    const hold = fencePinokioOperations()
    const waiting = hold.settle(100).catch((error) => error)
    await vi.advanceTimersByTimeAsync(100)
    expect(await waiting).toMatchObject({ code: 'pinokio_operation_unsettled' })
    operation.close()
    await expect(hold.settle()).resolves.toBeUndefined()
    hold.release()
  })

  it('pairs nested releases and never readmits old epochs after restore failure/release', async () => {
    const old = ownPinokioOperation({ admit: async () => {} })
    const first = fencePinokioOperations()
    const second = fencePinokioOperations()
    first.release(); first.release()
    expect(() => ownPinokioOperation({ admit: async () => {} })).toThrow(/paused/)
    second.release()
    await expect(old.assert()).rejects.toMatchObject({ code: 'pinokio_operation_cancelled' })
    old.close()
    const fresh = ownPinokioOperation({ admit: async () => {} })
    await expect(fresh.assert()).resolves.toBeUndefined()
    fresh.close()
  })

  it('ends one originating caller without cancelling an independent operation', async () => {
    const stop = new AbortController()
    const one = ownPinokioOperation({ signal: stop.signal, admit: async () => {} })
    const two = ownPinokioOperation({ admit: async () => {} })
    stop.abort()
    await expect(one.assert()).rejects.toMatchObject({ code: 'pinokio_operation_cancelled' })
    await expect(two.assert()).resolves.toBeUndefined()
    one.close(); two.close()
  })

  it('hashes saved binding, excluding labels, recipe, revision and unrelated artifact edits', () => {
    const artifact = { id: 'art', user_id: 'owner', brain_type: 'pinokio_app', name: 'Label', metadata: { runtime_manager: 'pinokio', source_type: 'custom', pinokio_app_id: 'one.git' } }
    const hash = pinokioBindingFingerprint(artifact)
    const edited = { ...artifact, name: 'Changed', metadata: { ...artifact.metadata, pinokio_runtime: { path: '/new' } } }
    expect(pinokioBindingFingerprint(edited)).toBe(hash)
    for (const metadata of [{ ...artifact.metadata, pinokio_app_id: 'two.git' }, { ...artifact.metadata, pinokio_machine_id: '12345678-1234-4123-8123-123456789abc' }, { ...artifact.metadata, pinokio_machine_id: null }]) {
      expect(pinokioBindingFingerprint({ ...artifact, metadata })).not.toBe(hash)
    }
    expect(pinokioBindingFingerprint({ ...artifact, user_id: 'other' })).not.toBe(hash)
  })

  it('does not turn explicit malformed target input into the omitted local lane', () => {
    expect(pinokioTargetFromQuery(new URLSearchParams())).toEqual({})
    expect(pinokioTargetFromQuery(new URLSearchParams('machineId=local&revision=0'))).toEqual({ machineId: 'local', revision: 0 })
    for (const query of ['machineId=', 'revision=1', 'machineId=local&revision=1', 'machineId=bad', 'machineId=local&revision=NaN', 'machineId=local&machineId=12345678-1234-4123-8123-123456789abc', 'machineId=local&revision=0&revision=1']) {
      expect(() => pinokioTargetFromQuery(new URLSearchParams(query))).toThrow()
    }
  })
})
