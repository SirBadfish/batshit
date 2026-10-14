import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEntitySaverCount } from './entitySaverCount'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createEntitySaverCount', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does not report activity before a run or queued save', () => {
    const changed = vi.fn()
    const saver = createEntitySaverCount(() => {}, changed)

    expect(saver.busy()).toBe(false)
    expect(saver.busy('A')).toBe(false)
    expect(changed).not.toHaveBeenCalled()
  })

  it('keeps queued saves for different owners independent until each promise settles', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const save = vi.fn((payload: { id: string; value: string }) =>
      payload.id === 'A' ? first.promise : second.promise
    )
    const saver = createEntitySaverCount(() => {})
    const enqueue = saver.debounce(save, 25)

    enqueue({ id: 'A', value: 'from A' })
    enqueue({ id: 'B', value: 'from B' })
    expect(saver.busy('A')).toBe(true)
    expect(saver.busy('B')).toBe(true)

    await vi.advanceTimersByTimeAsync(25)
    expect(save.mock.calls.map(([payload]) => payload)).toEqual([
      { id: 'A', value: 'from A' },
      { id: 'B', value: 'from B' }
    ])

    first.resolve('A saved')
    await expect(first.promise).resolves.toBe('A saved')
    expect(saver.busy('A')).toBe(false)
    expect(saver.busy('B')).toBe(true)

    second.resolve('B saved')
    await expect(second.promise).resolves.toBe('B saved')
    expect(saver.busy()).toBe(false)
  })

  it('coalesces queued values for the same owner only', async () => {
    const save = vi.fn(async (_payload: { id: string; value: string }) => {})
    const saver = createEntitySaverCount(() => {})
    const enqueue = saver.debounce(save, 20)

    enqueue({ id: 'A', value: 'older' })
    await vi.advanceTimersByTimeAsync(10)
    enqueue({ id: 'A', value: 'latest' })
    expect(saver.busy('A')).toBe(true)

    await vi.advanceTimersByTimeAsync(20)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith({ id: 'A', value: 'latest' })
    expect(saver.busy('A')).toBe(false)
  })

  it('does not let one pending owner make another owner busy', () => {
    const saver = createEntitySaverCount(() => {})
    const enqueue = saver.debounce(async () => {}, 100)

    enqueue({ id: 'A', value: 1 })

    expect(saver.busy('A')).toBe(true)
    expect(saver.busy('B')).toBe(false)
    expect(saver.busy()).toBe(true)
  })

  it('lists queued and running owners until each owner settles', async () => {
    const running = deferred()
    const saver = createEntitySaverCount(() => {})
    const enqueue = saver.debounce(async () => {}, 20)
    enqueue({ id: 'A' })
    const runningResult = saver.run('B', () => running.promise)

    expect(saver.pendingOwners()).toEqual(['A', 'B'])
    running.resolve()
    await expect(runningResult).resolves.toBeUndefined()
    expect(saver.pendingOwners()).toEqual(['A'])

    await vi.advanceTimersByTimeAsync(20)
    expect(saver.pendingOwners()).toEqual([])
  })

  it('separates queued ownership from actual flight and keeps flight scoped to its owner', async () => {
    const aSave = deferred()
    const aRun = deferred()
    const bRun = deferred()
    const saver = createEntitySaverCount(() => {})
    const enqueue = saver.debounce((_payload: { id: string }) => aSave.promise, 20)

    enqueue({ id: 'A' })
    const bResult = saver.run('B', () => bRun.promise)
    expect(saver.busy('A')).toBe(true)
    expect(saver.inFlight('A')).toBe(false)
    expect(saver.inFlight('B')).toBe(true)
    expect(saver.inFlightOwners()).toEqual(['B'])

    await vi.advanceTimersByTimeAsync(20)
    const aResult = saver.run('A', () => aRun.promise)
    expect(saver.inFlightOwners()).toEqual(['A', 'B'])

    bRun.reject(new Error('B refused'))
    await expect(bResult).rejects.toThrow('B refused')
    expect(saver.inFlight('A')).toBe(true)
    expect(saver.inFlight('B')).toBe(false)
    expect(saver.inFlightOwners()).toEqual(['A'])

    aSave.resolve()
    await aSave.promise
    expect(saver.inFlight('A')).toBe(true)
    aRun.resolve()
    await expect(aResult).resolves.toBeUndefined()
    expect(saver.inFlightOwners()).toEqual([])
    expect(saver.pendingOwners()).toEqual([])
  })

  it('tracks overlapping runs per owner until the last owned run settles', async () => {
    const first = deferred()
    const second = deferred()
    const changed = vi.fn()
    const settledBusy: boolean[] = []
    let saver!: ReturnType<typeof createEntitySaverCount>
    saver = createEntitySaverCount(() => settledBusy.push(saver.busy('A')), changed)

    const firstResult = saver.run('A', () => first.promise)
    const secondResult = saver.run('A', () => second.promise)
    expect(firstResult).toBe(first.promise)
    expect(secondResult).toBe(second.promise)
    expect(saver.busy('A')).toBe(true)
    expect(saver.busy('B')).toBe(false)
    expect(changed).toHaveBeenCalledTimes(2)

    first.resolve()
    await expect(firstResult).resolves.toBeUndefined()
    expect(saver.busy('A')).toBe(true)

    second.resolve()
    await expect(secondResult).resolves.toBeUndefined()
    expect(saver.busy('A')).toBe(false)
    expect(settledBusy).toEqual([true, false])
    expect(changed).toHaveBeenCalledTimes(4)
  })

  it('settles rejected and synchronously thrown runs without clearing another owner', async () => {
    const rejected = deferred()
    const other = deferred()
    const settledBusy: Array<[boolean, boolean, boolean]> = []
    let saver!: ReturnType<typeof createEntitySaverCount>
    const settled = vi.fn(() => settledBusy.push([saver.busy('A'), saver.busy('B'), saver.busy('C')]))
    saver = createEntitySaverCount(settled)

    const rejectedResult = saver.run('A', () => rejected.promise)
    void saver.run('B', () => other.promise)
    rejected.reject(new Error('save refused'))
    await expect(rejectedResult).rejects.toThrow('save refused')
    expect(saver.busy('A')).toBe(false)
    expect(saver.busy('B')).toBe(true)
    expect(settled).toHaveBeenCalledTimes(1)
    expect(settledBusy).toEqual([[false, true, false]])

    expect(() => saver.run('C', () => { throw new Error('save threw') })).toThrow('save threw')
    expect(saver.busy('C')).toBe(false)
    expect(saver.busy('B')).toBe(true)
    expect(settled).toHaveBeenCalledTimes(2)
    expect(settledBusy).toEqual([[false, true, false], [false, true, false]])

    other.resolve()
    await other.promise
    expect(saver.busy()).toBe(false)
    expect(settled).toHaveBeenCalledTimes(3)
    expect(settledBusy[2]).toEqual([false, false, false])
  })

  it('cleans an idle owner before a later queue for that owner', async () => {
    const save = vi.fn(async (_payload: { id: string; value: number }) => {})
    const changed = vi.fn()
    const saver = createEntitySaverCount(() => {}, changed)
    const enqueue = saver.debounce(save, 10)

    enqueue({ id: 'A', value: 1 })
    expect(saver.busy('A')).toBe(true)
    expect(saver.pendingOwners()).toEqual(['A'])
    await vi.advanceTimersByTimeAsync(10)
    expect(save).toHaveBeenCalledTimes(1)
    expect(saver.busy('A')).toBe(false)
    expect(saver.pendingOwners()).toEqual([])

    const changeCountAfterSettle = changed.mock.calls.length
    enqueue({ id: 'A', value: 2 })
    expect(saver.busy('A')).toBe(true)
    expect(saver.pendingOwners()).toEqual(['A'])
    expect(changed.mock.calls.length).toBe(changeCountAfterSettle + 1)
    await vi.advanceTimersByTimeAsync(10)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith({ id: 'A', value: 2 })
    expect(saver.busy('A')).toBe(false)
    expect(saver.pendingOwners()).toEqual([])
  })

  it('keeps projection notifications separate from settlement notifications', async () => {
    const hold = deferred()
    const events: string[] = []
    let saver!: ReturnType<typeof createEntitySaverCount>
    saver = createEntitySaverCount(
      () => events.push(`settled:${saver.busy('A')}`),
      () => events.push(`changed:${saver.busy('A')}`)
    )
    const enqueue = saver.debounce((_payload: { id: string }) => hold.promise, 15)

    enqueue({ id: 'A' })
    expect(events).toEqual(['changed:true'])
    await vi.advanceTimersByTimeAsync(15)
    expect(events).toEqual(['changed:true', 'changed:true'])

    hold.resolve()
    await hold.promise
    await Promise.resolve()
    expect(events).toEqual(['changed:true', 'changed:true', 'changed:false', 'settled:false'])
    expect(saver.busy('A')).toBe(false)
  })
})
