/** Process-local verification cannot survive replacement of its stored inputs.
 * No Redis keys, files, or persistent authority are created here. */
let epoch = Symbol('recipe-verification')
let restorations = 0
const publications = new Set<Promise<unknown>>()
const RESTORE_DRAIN_MS = 30_000

export class RecipeVerificationInvalidatedError extends Error {
  constructor() {
    super('Recipe verification was invalidated by backup restore. Retry the Goon update.')
  }
}

export function captureRecipeVerificationEpoch(): symbol | null {
  return restorations === 0 ? epoch : null
}

export function isRecipeVerificationEpochCurrent(value: symbol | null): value is symbol {
  return value !== null && restorations === 0 && value === epoch
}

/** Acquisition is synchronous; only the final Redis CAS belongs in this permit.
 * Restore waits for an acquired publication even if it starts before its callback. */
export function publishInRecipeVerificationEpoch<T>(value: symbol | null, publish: () => Promise<T>): Promise<T> {
  if (!isRecipeVerificationEpochCurrent(value)) {
    return Promise.reject(new RecipeVerificationInvalidatedError())
  }
  const pending = Promise.resolve().then(publish)
  publications.add(pending)
  return pending.finally(() => publications.delete(pending))
}

/** Invalidate before any restore mutation, including rollback/journal recovery.
 * A timed-out drain refuses restore; it never proceeds alongside an unsettled CAS. */
export async function withRecipeVerificationRestore<T>(restore: () => Promise<T>): Promise<T> {
  restorations++
  epoch = Symbol('recipe-verification')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.allSettled([...publications]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Backup restore is waiting for a Goon publication to finish. Retry restore.')), RESTORE_DRAIN_MS)
      })
    ])
    clearTimeout(timer)
    return await restore()
  } finally {
    clearTimeout(timer)
    restorations--
    epoch = Symbol('recipe-verification')
  }
}
