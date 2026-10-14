import { afterEach, describe, expect, it, vi } from 'vitest'
import { createModelPresetAutosave } from './modelPresetAutosave'

afterEach(() => vi.useRealTimers())

describe('preset autosave ordering', () => {
  it('coalesces pending drafts and prevents out-of-order writes even across preset selections', async () => {
    vi.useFakeTimers()
    const releases: (() => void)[] = []
    const saved: string[] = []
    const queue = createModelPresetAutosave({
      delay: 600,
      save: async draft => { saved.push(draft.signature); await new Promise<void>(resolve => releases.push(resolve)) },
      settled: vi.fn()
    })
    queue.schedule({ id: 'a', signature: 'first', selection: 1 })
    await vi.advanceTimersByTimeAsync(600)
    queue.schedule({ id: 'a', signature: 'partial', selection: 1 })
    queue.schedule({ id: 'a', signature: 'latest', selection: 1 })
    queue.schedule({ id: 'b', signature: 'other preset', selection: 2 })
    await vi.advanceTimersByTimeAsync(600)
    expect(saved).toEqual(['first'])
    releases.shift()!()
    await vi.advanceTimersByTimeAsync(0)
    expect(saved).toEqual(['first', 'latest'])
    releases.shift()!()
    await vi.advanceTimersByTimeAsync(0)
    expect(saved).toEqual(['first', 'latest', 'other preset'])
    releases.shift()!()
    await vi.advanceTimersByTimeAsync(0)
    expect(queue.hasWork('a')).toBe(false)
    queue.dispose()
  })

  it('cancels a superseded numeric draft but finishes completed edits on unmount', async () => {
    vi.useFakeTimers()
    const save = vi.fn(async () => {})
    const queue = createModelPresetAutosave({ delay: 600, save, settled: vi.fn() })
    queue.schedule({ id: 'a', signature: 'old', selection: 1 })
    queue.cancelPending('a')
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).not.toHaveBeenCalled()
    queue.schedule({ id: 'a', signature: 'closed', selection: 1 })
    queue.dispose()
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).toHaveBeenCalledWith({ id: 'a', signature: 'closed', selection: 1 })
  })
})
