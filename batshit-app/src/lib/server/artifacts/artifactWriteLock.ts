/**
 * BL-547: writes to one artifact take turns.
 *
 * Every artifact write reads the whole `artifact:{id}` record, decides, and writes the whole
 * record back (`ArtifactsService.update`, `applyPatch`, `rollbackToVersion`, `deleteVersion`).
 * The API lane runs one step's tool calls together, so two `sys.artifact.apply_patch` calls on
 * one artifact both patched the same copy and the later write dropped the other patch, while
 * both answered success.
 *
 * `withArtifactWriteLock` runs one writer's read-decide-write for one artifact at a time, in
 * arrival order. Batshit is one app process per instance, so an in-process queue covers every
 * writer in it; the write itself is also a Redis check-and-set (`ArtifactsService`), so a writer
 * in another process is refused loudly instead of lost.
 *
 * The lock is re-entrant within one async flow: `applyPatch` holds it and calls `update`, which
 * takes it again and runs at once instead of waiting for itself. Keep the work inside it short
 * and free of anything that waits on another request (a turn, a stream, a network call).
 *
 * A leaf module: it imports nothing from Batshit. Modeled on `zipStateLock.ts`.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

const held = new AsyncLocalStorage<ReadonlySet<string>>()
const tails = new Map<string, Promise<void>>()

export async function withArtifactWriteLock<T>(artifactId: string, work: () => Promise<T>): Promise<T> {
  if (held.getStore()?.has(artifactId)) return work()

  const previous = tails.get(artifactId)
  let release!: () => void
  const mine = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous ? previous.then(() => mine) : mine
  tails.set(artifactId, tail)
  if (previous) await previous

  const inside = new Set(held.getStore() ?? [])
  inside.add(artifactId)
  try {
    return await held.run(inside, work)
  } finally {
    release()
    if (tails.get(artifactId) === tail) tails.delete(artifactId)
  }
}

/** For tests: whether any writer holds or waits for this artifact's lock. */
export function isArtifactWriteLockBusy(artifactId: string): boolean {
  return tails.has(artifactId)
}
