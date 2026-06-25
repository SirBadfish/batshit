/**
 * Creates a debounced version of a function that delays its execution
 * until after `delay` milliseconds have elapsed since the last time it
 * was invoked.
 *
 * This utility is primarily used for settings auto-save flows so that
 * we avoid hammering the API while a user is still typing or toggling
 * switches. The implementation is framework agnostic and works with
 * any function signature.
 *
 * @param fn - The function to debounce.
 * @param delay - The debounce delay in milliseconds.
 * @returns A debounced function with the same parameters as `fn`.
 */
export function debounce<T extends (...args: any[]) => any>(fn: T, delay: number) {
	let timeoutId: ReturnType<typeof setTimeout> | null = null

	return (...args: Parameters<T>) => {
		if (timeoutId) {
			clearTimeout(timeoutId)
		}

		timeoutId = setTimeout(() => {
			timeoutId = null
			fn(...args)
		}, delay)
	}
}
