const DEFAULT_PREVIEW_TIMEOUT_MS = 15 * 60 * 1000

export type RecipePreviewAttempt = {
  readonly signal: AbortSignal
  cancel: () => void
  run: <T>(work: Promise<T>) => Promise<T>
  finish: () => void
}

/** One abort and deadline owner for the complete Settings preview attempt. */
export function createRecipePreviewAttempt(options: {
  timeoutMs?: number
  label?: string
  signal?: AbortSignal
} = {}): RecipePreviewAttempt {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PREVIEW_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError('Recipe preview timeout must be a positive, finite timer duration.')
  }
  const label = options.label ?? 'Goon'
  const controller = new AbortController()
  const signal = controller.signal
  const removeRunListeners = new Set<() => void>()
  let finished = false
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timer = null
    if (!finished && !signal.aborted) {
      controller.abort(new DOMException(
        `Building the ${label} preview took too long. Try again.`,
        'TimeoutError'
      ))
    }
  }, timeoutMs)

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  const onParentAbort = () => {
    if (finished || signal.aborted) return
    clearTimer()
    controller.abort(options.signal?.reason)
  }
  if (options.signal?.aborted) onParentAbort()
  else options.signal?.addEventListener('abort', onParentAbort, { once: true })

  return {
    signal,
    cancel() {
      if (finished || signal.aborted) return
      clearTimer()
      controller.abort(new DOMException(`The ${label} preview was canceled.`, 'AbortError'))
    },
    run<T>(work: Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        let settled = false
        const removeListener = () => {
          signal.removeEventListener('abort', onAbort)
          removeRunListeners.delete(removeListener)
        }
        const onAbort = () => {
          if (settled) return
          settled = true
          removeListener()
          reject(signal.reason)
        }
        const settle = (callback: () => void) => {
          if (settled) return
          settled = true
          removeListener()
          callback()
        }

        // Observe both outcomes even when abort wins. A late rejection must
        // never become an unhandled rejection after the preview is canceled.
        work.then(
          value => settle(() => resolve(value)),
          error => settle(() => reject(error))
        )
        if (signal.aborted) {
          onAbort()
        } else if (finished) {
          settled = true
          reject(new Error('The Recipe preview attempt has already finished.'))
        } else {
          signal.addEventListener('abort', onAbort, { once: true })
          removeRunListeners.add(removeListener)
        }
      })
    },
    finish() {
      if (finished) return
      finished = true
      clearTimer()
      options.signal?.removeEventListener('abort', onParentAbort)
      for (const removeListener of removeRunListeners) removeListener()
    }
  }
}
