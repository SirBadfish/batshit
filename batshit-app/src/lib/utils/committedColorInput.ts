export type CommittedColorInputOptions = {
  value: string
  disabled?: boolean
  /** The edited state or item identity, so even a reset to the same color cancels a pending drag. */
  resetKey?: unknown
  onCommit: (color: string) => void
}

const COLOR_SETTLE_MS = 250

/** Keep native picker feedback immediate while expensive material updates wait for a settled color. */
export function committedColorInput(node: HTMLInputElement, initial: CommittedColorInputOptions) {
  let options = initial
  let externalValue = initial.value.toLowerCase()
  let committedValue = externalValue
  let awaitingAcknowledgement: string | null = null
  let pendingValue: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  function cancel() {
    clearTimeout(timer)
    timer = undefined
    pendingValue = null
  }

  function flush() {
    const color = pendingValue
    cancel()
    if (options.disabled || node.disabled || color === null || node.value !== color || color === committedValue) return
    committedValue = color
    awaitingAcknowledgement = color
    options.onCommit(color)
  }

  function queue() {
    cancel()
    if (options.disabled || node.disabled) return
    pendingValue = node.value
    timer = setTimeout(flush, COLOR_SETTLE_MS)
  }

  function change() {
    queue()
    flush()
  }

  node.addEventListener('input', queue)
  node.addEventListener('change', change)
  node.addEventListener('blur', flush)

  return {
    update(next: CommittedColorInputOptions) {
      const nextValue = next.value.toLowerCase()
      const acknowledgesCommit = nextValue === awaitingAcknowledgement
      if (!next.disabled && acknowledgesCommit) {
        awaitingAcknowledgement = null
        // A completed async preview can arrive after the next drag started. Preserve
        // that newer choice and its timer even if Svelte just wrote the older value.
        if (pendingValue !== null) node.value = pendingValue
      } else if (next.disabled || nextValue !== externalValue || next.resetKey !== options.resetKey) {
        cancel()
        awaitingAcknowledgement = null
        committedValue = nextValue
        node.value = next.value
      }
      externalValue = nextValue
      options = next
    },
    destroy() {
      cancel()
      node.removeEventListener('input', queue)
      node.removeEventListener('change', change)
      node.removeEventListener('blur', flush)
    }
  }
}
