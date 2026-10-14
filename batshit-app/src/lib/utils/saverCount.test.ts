import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createSaverCount } from './saverCount'

function deferred<T = void>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

describe('createSaverCount (Agent Settings: one saver queued or on its way)', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('is at rest before any save', () => {
		const saver = createSaverCount(() => {})
		expect(saver.busy()).toBe(false)
		expect(saver.inFlight()).toBe(false)
	})

	it('is busy while one run is on its way and at rest after it lands', async () => {
		const settled = vi.fn()
		const saver = createSaverCount(settled)
		const hold = deferred<string>()

		const result = saver.run(() => hold.promise)
		expect(saver.busy()).toBe(true)
		expect(saver.inFlight()).toBe(true)
		expect(settled).not.toHaveBeenCalled()

		hold.resolve('landed')
		await expect(result).resolves.toBe('landed')
		await Promise.resolve()

		expect(saver.busy()).toBe(false)
		expect(saver.inFlight()).toBe(false)
		expect(settled).toHaveBeenCalledTimes(1)
	})

	it('counts a failed run as settled, and the caller still gets the failure', async () => {
		const settled = vi.fn()
		const saver = createSaverCount(settled)
		const hold = deferred()

		const result = saver.run(() => hold.promise)
		expect(saver.busy()).toBe(true)
		expect(saver.inFlight()).toBe(true)

		hold.reject(new Error('refused'))
		await expect(result).rejects.toThrow('refused')
		await Promise.resolve()

		expect(saver.busy()).toBe(false)
		expect(saver.inFlight()).toBe(false)
		expect(settled).toHaveBeenCalledTimes(1)
	})

	it('counts a save that throws before it returns a promise as settled', () => {
		const settled = vi.fn()
		const saver = createSaverCount(settled)

		expect(() =>
			saver.run(() => {
				throw new Error('threw')
			})
		).toThrow('threw')

		expect(saver.busy()).toBe(false)
		expect(saver.inFlight()).toBe(false)
		expect(settled).toHaveBeenCalledTimes(1)
	})

	it('stays busy until every overlapping run has settled, and reports each settle', async () => {
		const settled = vi.fn()
		const saver = createSaverCount(settled)
		const first = deferred()
		const second = deferred()

		void saver.run(() => first.promise)
		void saver.run(() => second.promise)
		expect(saver.busy()).toBe(true)
		expect(saver.inFlight()).toBe(true)

		first.resolve()
		await first.promise
		await Promise.resolve()
		expect(saver.busy()).toBe(true)
		expect(saver.inFlight()).toBe(true)
		expect(settled).toHaveBeenCalledTimes(1)

		second.resolve()
		await second.promise
		await Promise.resolve()
		expect(saver.busy()).toBe(false)
		expect(saver.inFlight()).toBe(false)
		expect(settled).toHaveBeenCalledTimes(2)
	})

	it('counts a debounced save as busy from the call, through its timer, until it settles', async () => {
		const settled = vi.fn()
		const saver = createSaverCount(settled)
		const hold = deferred()
		const save = vi.fn((_value: string) => hold.promise)
		const debounced = saver.debounce(save, 500)

		debounced('a')
		expect(saver.busy()).toBe(true)
		expect(saver.inFlight()).toBe(false)
		expect(save).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(499)
		expect(saver.busy()).toBe(true)
		expect(saver.inFlight()).toBe(false)
		expect(save).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(1)
		expect(save).toHaveBeenCalledTimes(1)
		expect(save).toHaveBeenCalledWith('a')
		expect(saver.busy()).toBe(true)
		expect(saver.inFlight()).toBe(true)

		hold.resolve()
		await vi.advanceTimersByTimeAsync(0)
		expect(saver.busy()).toBe(false)
		expect(saver.inFlight()).toBe(false)
		expect(settled).toHaveBeenCalledTimes(1)
	})

	it('a newer debounced call replaces the queued one and only the last is saved', async () => {
		const saver = createSaverCount(() => {})
		const save = vi.fn(async (_value: string) => {})
		const debounced = saver.debounce(save, 500)

		debounced('a')
		await vi.advanceTimersByTimeAsync(300)
		debounced('b')
		expect(saver.busy()).toBe(true)
		await vi.advanceTimersByTimeAsync(499)
		expect(save).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(1)
		expect(save).toHaveBeenCalledTimes(1)
		expect(save).toHaveBeenCalledWith('b')
		expect(saver.busy()).toBe(false)
	})

	it('a failed debounced save settles the count', async () => {
		const settled = vi.fn()
		const saver = createSaverCount(settled)
		const debounced = saver.debounce(async () => {
			throw new Error('refused')
		}, 100)

		debounced()
		await vi.advanceTimersByTimeAsync(100)
		expect(saver.busy()).toBe(false)
		expect(settled).toHaveBeenCalledTimes(1)
	})

	it('two savers count independently', async () => {
		const settledA = vi.fn()
		const settledB = vi.fn()
		const a = createSaverCount(settledA)
		const b = createSaverCount(settledB)
		const hold = deferred()

		void a.run(() => hold.promise)
		expect(a.busy()).toBe(true)
		expect(b.busy()).toBe(false)

		b.debounce(async () => {}, 100)()
		expect(b.busy()).toBe(true)
		expect(a.busy()).toBe(true)

		await vi.advanceTimersByTimeAsync(100)
		expect(b.busy()).toBe(false)
		expect(a.busy()).toBe(true)
		expect(settledB).toHaveBeenCalledTimes(1)
		expect(settledA).not.toHaveBeenCalled()

		hold.resolve()
		await vi.advanceTimersByTimeAsync(0)
		expect(a.busy()).toBe(false)
		expect(settledA).toHaveBeenCalledTimes(1)
	})
})
