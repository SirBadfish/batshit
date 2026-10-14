/**
 * Whether one saver of a settings panel has a save queued or on its way (BL-912, BL-955): Agent
 * Settings puts a newer read of a record into a section only while that section's savers have
 * neither, so a read never replaces a form whose change is still being saved.
 *
 * `debounce` is `$lib/utils/debounce` for a save that returns its promise; the save counts as queued
 * from the call until its timer fires, then as on its way until the promise settles. `run` counts a
 * save that is not debounced (an editor sheet's Save). `settled` runs after each save has landed or
 * failed, so the panel can do what waited for it. Plain variables: nothing here is reactive.
 */
export function createSaverCount(settled: () => void) {
	let timer: ReturnType<typeof setTimeout> | null = null
	let running = 0

	function run<T>(save: () => Promise<T>): Promise<T> {
		running += 1
		const done = () => {
			running -= 1
			settled()
		}
		let result: Promise<T>
		try {
			result = save()
		} catch (error) {
			done()
			throw error
		}
		// Settles the count whatever the save does; the caller still gets the save's own rejection.
		result.then(done, done)
		return result
	}

	return {
		busy: () => timer !== null || running > 0,
		inFlight: () => running > 0,
		run,
		debounce<A extends unknown[]>(save: (...args: A) => Promise<unknown>, delay: number) {
			return (...args: A) => {
				if (timer) clearTimeout(timer)
				timer = setTimeout(() => {
					timer = null
					void run(() => save(...args))
				}, delay)
			}
		}
	}
}
