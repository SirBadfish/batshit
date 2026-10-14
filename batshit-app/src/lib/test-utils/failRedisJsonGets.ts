import { vi } from 'vitest'
import { redis } from '$lib/server/redis'

type Execute = (operation: (client: any) => Promise<unknown>) => Promise<unknown>

/**
 * The wrapper's own work as it was when this file loaded, so that a failed test can never leave a
 * stale spy behind it. On the default lane `redis.execute` is a mock function: `.bind` of a mock would
 * call the mock again (and loop once the mock's implementation is replaced), so its ORIGINAL
 * implementation is taken instead. On the real lane it is the class method.
 */
const pristineExecute: Execute = vi.isMockFunction(redis.execute)
  ? (vi.mocked(redis.execute).getMockImplementation() as unknown as Execute)
  : (redis.execute.bind(redis) as unknown as Execute)

/** Put `redis.execute` back to the wrapper it was before any `failRedisJsonGets` (safe to call at any time). */
export function stopFailingRedisJsonGets() {
  if (vi.isMockFunction(redis.execute)) {
    vi.mocked(redis.execute).mockImplementation(pristineExecute as never)
  }
}

/**
 * Make the REAL Redis read of some keys fail, and nothing else (BL-977).
 *
 * Wraps `redis.execute` so that `client.json.get(key)` rejects while `matches(key)` is true; every
 * other read and every write reaches the store as before. Works on the default lane's Redis fake and
 * on the real Redis lane, because it sits on the one wrapper that both lanes share. Undo it with the
 * returned `stop`, or with `stopFailingRedisJsonGets()` in an `afterEach` (`vi.restoreAllMocks()`
 * does not undo a spy on the fake's own mock function).
 */
export function failRedisJsonGets(
  matches: (key: string) => boolean,
  error: Error = new Error('Redis read failed (injected by the test)')
) {
  const execute = pristineExecute
  let failures = 0
  const spy = vi.spyOn(redis, 'execute').mockImplementation(((operation: (client: any) => Promise<unknown>) =>
    execute(async (client: any) => {
      const target = client.json
      // Empty proxy targets: the client's own properties are read-only, which a proxy may not change.
      const json = new Proxy(
        {},
        {
          get(_empty, property) {
            const value = Reflect.get(target, property)
            if (property === 'get') {
              return async (key: string, options?: unknown) => {
                if (matches(key)) {
                  failures += 1
                  throw error
                }
                return value.call(target, key, options)
              }
            }
            return typeof value === 'function' ? value.bind(target) : value
          }
        }
      )
      const wrapped = new Proxy(
        {},
        {
          get(_empty, property) {
            if (property === 'json') return json
            const value = Reflect.get(client, property)
            return typeof value === 'function' ? value.bind(client) : value
          }
        }
      )
      return operation(wrapped)
    })) as typeof redis.execute)
  return {
    /** How many reads were made to fail so far. */
    get failures() {
      return failures
    },
    stop() {
      spy.mockImplementation(pristineExecute as never)
    }
  }
}
