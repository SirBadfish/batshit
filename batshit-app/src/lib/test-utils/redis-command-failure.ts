/**
 * Make ONE raw Redis client command fail, on BOTH test lanes (BL-607).
 *
 * A suite that proves "a Redis error in this step is refused, never read as empty" used to
 * `vi.spyOn(redis.json, 'get')` or `vi.spyOn(redis, 'keys')`. That only works on the default
 * lane, where the fake's `redis.execute` hands the callback a client built on those same
 * methods. On the real lane (`VITEST_USE_REAL_REDIS=true`) the callback gets the node-redis
 * client, the spy is never reached, and the test fails with a success it did not expect.
 *
 * This wraps `redis.execute` by hand the way `redis-command-counter.ts` does (not with
 * `vi.spyOn`, for the reasons written there), so the client each callback receives fails the
 * first call of `command` with `error`; later calls, and every other command, go through.
 * `command` is a client method name (`keys`, `sMembers`) or one level into a namespace
 * (`json.get`).
 *
 * ```ts
 * const failure = failNextRedisCommand('keys', new Error('Socket closed unexpectedly'))
 * try { ... } finally { failure.restore() }
 * expect(failure.failed()).toBe(true)
 * ```
 */
import { redis } from '$lib/server/redis'

export function failNextRedisCommand(command: string, error: Error) {
  const [head, method] = command.includes('.') ? command.split('.', 2) : [null, command]
  let failed = false
  // The property VALUE, not a bound copy: on the default lane it is the `vi.fn` other tests
  // may assert on, and putting a different function back would break them silently.
  const original = redis.execute

  // Proxies over EMPTY targets that read from the client: node-redis's `client.json` is a
  // read-only, non-configurable property, and a Proxy on the client itself must hand it back
  // unchanged (a Proxy invariant), so it could not fail `json.get`.
  const view = (source: any, failHere: boolean): any =>
    new Proxy(Object.create(null), {
      get(_empty, property) {
        const value = Reflect.get(source, property, source)
        if (failHere && !failed && property === method && typeof value === 'function') {
          return () => {
            failed = true
            return Promise.reject(error)
          }
        }
        if (!failHere && property === head && value && typeof value === 'object') {
          return view(value, true)
        }
        return typeof value === 'function' ? value.bind(source) : value
      },
      has(_empty, property) {
        return property in source
      }
    })

  ;(redis as any).execute = async (operation: (client: any) => any) =>
    await (original as any).call(redis, async (client: any) => await operation(view(client, head === null)))

  return {
    /** Whether the command was called and failed. */
    failed: () => failed,
    restore: () => {
      ;(redis as any).execute = original
    }
  }
}
