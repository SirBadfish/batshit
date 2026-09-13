/**
 * Count the Redis commands a piece of code actually issues — on BOTH test lanes.
 *
 * SA-118 P1 (DL-118-01) needs one claim that no behavioural assertion can make: the
 * schedule sweep must not run `KEYS` when nothing can be due. "It returned nothing" is
 * true both when it walked and found nothing and when it did not walk at all, and those
 * are the two cases the fix is about.
 *
 * **It does not use `vi.spyOn`.** Under the default lane `$lib/server/redis` is already a
 * mock built in `vitest-setup.ts`, so spying on it replaces a mock with a mock and a
 * global `restoreMocks`/`mockReset` can take the fake's implementation away with it —
 * every later Redis call then quietly returns `undefined` and the failure shows up in
 * whatever test runs next. Swapping the method by hand and putting the original back in a
 * `finally` is visible, local, and lane-agnostic: under `VITEST_USE_REAL_REDIS=true` the
 * same wrapper counts commands against the real client.
 *
 * The count is of commands issued through `redis.execute`, which is how every raw
 * node-redis call in `batshit-app` reaches a client.
 */
import { redis } from '$lib/server/redis'

export interface RedisCommandCounts {
  /** Per command name, e.g. `keys`, `sMembers`, `zRem`. Absent means never called. */
  commands: Record<string, number>
  /** How many times `redis.execute` itself was entered. */
  executes: number
}

/**
 * Run `body`, counting the raw client commands it issues.
 *
 * ```ts
 * const { result, counts } = await countRedisCommands(() => listDueSchedules(now))
 * expect(counts.commands.keys ?? 0).toBe(0)
 * ```
 */
export async function countRedisCommands<T>(
  body: () => Promise<T>
): Promise<{ result: T; counts: RedisCommandCounts }> {
  const counts: RedisCommandCounts = { commands: {}, executes: 0 }
  // The property VALUE, not a bound copy: on the default lane it is the `vi.fn` other
  // tests may assert on, and putting a different function back would break them silently.
  const original = redis.execute

  ;(redis as any).execute = async (operation: (client: any) => any) => {
    counts.executes += 1
    return await (original as any).call(redis, async (client: any) => {
      const counting = new Proxy(client, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver)
          if (typeof value !== 'function') return value
          const name = String(property)
          return (...args: unknown[]) => {
            counts.commands[name] = (counts.commands[name] ?? 0) + 1
            return value.apply(target, args)
          }
        }
      })
      return await operation(counting)
    })
  }

  try {
    const result = await body()
    return { result, counts }
  } finally {
    ;(redis as any).execute = original
  }
}
