/**
 * BL-941: saves a control started that have not landed yet, so a later action can wait for them.
 * The chat bar's send waits for its own pending mode saves (the page's copy takes a pick at once,
 * the server runs a send with the SAVED record as its upper bound), and a read of the record
 * that started before a save must not overwrite the copy that save changed (`generation`).
 */
export interface PendingSaves {
  /** Tracks a save until it settles (either way), and answers the same promise. */
  track<T>(save: Promise<T>): Promise<T>
  /** How many saves have been tracked so far; a read compares it before and after. */
  readonly generation: number
  /** How many tracked saves have not settled yet. */
  readonly size: number
  /** Waits until every tracked save settled (true), or the limit passed first (false). */
  settled(limitMs: number): Promise<boolean>
}

export function createPendingSaves(): PendingSaves {
  const pending = new Set<Promise<unknown>>()
  let generation = 0
  return {
    track<T>(save: Promise<T>) {
      generation += 1
      pending.add(save)
      const settle = () => {
        pending.delete(save)
      }
      save.then(settle, settle)
      return save
    },
    get generation() {
      return generation
    },
    get size() {
      return pending.size
    },
    async settled(limitMs: number) {
      const deadline = Date.now() + limitMs
      while (pending.size > 0) {
        const left = deadline - Date.now()
        if (left <= 0) return false
        let timer: ReturnType<typeof setTimeout> | undefined
        const timedOut = await Promise.race([
          Promise.allSettled([...pending]).then(() => false),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(true), left)
          })
        ])
        clearTimeout(timer)
        if (timedOut) return false
      }
      return true
    }
  }
}
