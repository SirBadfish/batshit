import { describe, expect, it, vi } from 'vitest'
import type { GoonRecord } from '$lib/types/goons'
import { captureGoonCompatibilityBasis, compatibilityOwnerForBasis } from './goonCompatibilityBasis'
import { createGoonCompatibilityReportQueue } from './goonCompatibilityReportQueue'

function basis(id: string, model: string) {
  const goon = { id, user_id: 'owner', name: id, kind: 'vrm',
    files: { vrm: { url: `/uploads/${model}.vrm`, filename: `${model}.vrm` }, animations: [] },
    created_at: '2026-10-29T00:00:00Z', updated_at: '2026-10-29T00:00:00Z' } as GoonRecord
  return captureGoonCompatibilityBasis(goon, [goon], [], { eager: [], deferred: [] })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('Goon compatibility report queue', () => {
  it('serializes writes and applies only the latest still-current owner', async () => {
    const a = basis('a', 'a')
    const b = basis('b', 'b')
    const first = deferred<any>()
    const second = deferred<any>()
    let current = 'a'
    const write = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const apply = vi.fn()
    const queue = createGoonCompatibilityReportQueue({
      isCurrent: (input) => input.model.id === current, write, apply, unavailable: vi.fn()
    })
    queue.submit({ tier: 'A', issues: ['first'] }, a)
    queue.submit({ tier: 'A', issues: ['superseded'] }, a)
    current = 'b'
    queue.submit({ tier: 'B', issues: ['current'] }, b)
    expect(write).toHaveBeenCalledTimes(1)
    first.resolve({ status: 'saved', goon: { id: 'a', compatibility: { tier: 'A', owner: compatibilityOwnerForBasis(a) } } })
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    expect(apply).not.toHaveBeenCalled()
    second.resolve({ status: 'saved', goon: { id: 'b', compatibility: { tier: 'B', owner: compatibilityOwnerForBasis(b) } } })
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1))
    expect(apply.mock.calls[0][0].id).toBe('b')
    queue.dispose()
  })

  it.each(['refused', 'unknown'] as const)('does not replay a %s outcome on the same owner', async (status) => {
    const a = basis('a', 'a')
    const next = basis('a', 'new')
    const unavailable = vi.fn()
    const write = vi.fn().mockResolvedValueOnce(status === 'refused' ? { status } : { status, error: new Error('connection lost') })
      .mockResolvedValueOnce({ status: 'saved', goon: { id: 'a', compatibility: { tier: 'A', owner: compatibilityOwnerForBasis(next) } } })
    const apply = vi.fn()
    const queue = createGoonCompatibilityReportQueue({ isCurrent: () => true, write, apply, unavailable })
    queue.submit({ tier: 'A' }, a)
    await vi.waitFor(() => expect(unavailable).toHaveBeenCalledTimes(1))
    queue.submit({ tier: 'A' }, a)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(write).toHaveBeenCalledTimes(1)
    queue.submit({ tier: 'A' }, next)
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1))
    expect(write).toHaveBeenCalledTimes(2)
    queue.dispose()
  })

  it('does not apply an old engine response after the same Goon and model are reopened', async () => {
    const a = basis('a', 'a')
    const first = deferred<any>()
    const second = deferred<any>()
    let oldCurrent = true
    const write = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const apply = vi.fn()
    const queue = createGoonCompatibilityReportQueue({ isCurrent: () => true, write, apply, unavailable: vi.fn() })
    queue.submit({ tier: 'A', issues: ['old engine'] }, a, () => oldCurrent)
    oldCurrent = false
    queue.submit({ tier: 'A', issues: ['new engine'] }, a, () => true)
    first.resolve({ status: 'saved', goon: { id: 'a', compatibility: { tier: 'A', owner: compatibilityOwnerForBasis(a) } } })
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    expect(apply).not.toHaveBeenCalled()
    second.resolve({ status: 'saved', goon: { id: 'a', compatibility: { tier: 'A', owner: compatibilityOwnerForBasis(a) } } })
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1))
    queue.dispose()
  })

  it('does not issue a same-input write from a new engine after an unknown outcome', async () => {
    const a = basis('a', 'a')
    const unavailable = vi.fn()
    const write = vi.fn().mockResolvedValue({ status: 'unknown', error: new Error('connection lost') })
    const queue = createGoonCompatibilityReportQueue({ isCurrent: () => true, write, apply: vi.fn(), unavailable })
    queue.submit({ tier: 'A' }, a, () => true)
    await vi.waitFor(() => expect(unavailable).toHaveBeenCalledTimes(1))
    queue.submit({ tier: 'A' }, a, () => true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(write).toHaveBeenCalledTimes(1)
    queue.dispose()
  })
})
