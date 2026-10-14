/**
 * SA-129 P2b (BL-352): every write to a chat's zip state takes turns.
 *
 * A chat's zip state is four key families (`unzipped:{sessionId}`, `unzipped_item:{sessionId}:*`,
 * `rezipped:{sessionId}`, `rezipped_item:{sessionId}:*`) and several writers read them, decide,
 * and write back: the user's clicks (`/api/unzipping`), an agent's holds and the countdown at a
 * reply end (`zipHolds.ts`), Judge Juice (`zipStateInferred.ts`), an Infinite Session nap
 * (`memoryGraduation.ts`), an agent's deletion (`redis.deleteAgent`), and a message's deletion
 * (`redis.deleteMessage`, BL-390). Each one reads first
 * and writes later, so a user's Release that landed in between was undone by the countdown's
 * write-back (which also left an item record with no set member), and a user's Hold could be
 * turned back into a countdown.
 *
 * `withZipStateLock` runs one writer's read-decide-write for one chat at a time, in arrival
 * order. Batshit is one app process per instance, so an in-process queue covers every writer;
 * a writer outside the app process would need a Redis-side check-and-set instead.
 *
 * The lock is re-entrant within one async flow: a writer already inside the lock for a chat runs
 * a nested call for the same chat at once instead of waiting for itself. Keep the work inside it
 * short and free of anything that waits on another request (a turn, a stream, a network call).
 *
 * A leaf module: it imports nothing from Batshit, so `redis.ts` can use it.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

const held = new AsyncLocalStorage<ReadonlySet<string>>()
const tails = new Map<string, Promise<void>>()

export async function withZipStateLock<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
  if (held.getStore()?.has(sessionId)) return work()

  const previous = tails.get(sessionId)
  let release!: () => void
  const mine = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous ? previous.then(() => mine) : mine
  tails.set(sessionId, tail)
  if (previous) await previous

  const inside = new Set(held.getStore() ?? [])
  inside.add(sessionId)
  try {
    return await held.run(inside, work)
  } finally {
    release()
    if (tails.get(sessionId) === tail) tails.delete(sessionId)
  }
}

/** For tests: whether any writer holds or waits for this chat's lock. */
export function isZipStateLockBusy(sessionId: string): boolean {
  return tails.has(sessionId)
}
