import { vi } from 'vitest'
import { redis } from '$lib/server/redis'

/**
 * Makes every Redis write that touches a matching key fail with `Redis connection lost`, on both
 * test lanes, until the returned function is called.
 *
 * A write is failed where it would reach Redis: a facade write (`redis.set`, `del`, `sAdd`, `sRem`)
 * throws before it runs, and a MULTI whose queued commands touch the key throws at `exec`, before
 * anything in it is sent, as a lost connection leaves a MULTI (nothing in it applied). So one
 * injection says the same thing about four separate writes (the first ones land, the rest do not)
 * and about one MULTI (none of them lands), which is what a test of an atomic write must tell apart
 * (BL-537).
 *
 * On the fake lane the facade methods are `vi.fn`s, so the original implementation is read off the
 * mock before spying (spying replaces it; calling the spy from inside would recurse).
 */
export function failRedisWritesTouching(shouldFail: (key: string) => boolean): () => void {
  const error = () => new Error('Redis connection lost')
  const restores: Array<() => void> = []

  for (const method of ['set', 'del', 'sAdd', 'sRem'] as const) {
    const current = (redis as any)[method]
    const original = current.getMockImplementation?.() ?? current.bind(redis)
    const spy = vi.spyOn(redis as any, method).mockImplementation(async (key: any, ...rest: any[]) => {
      if (typeof key === 'string' && shouldFail(key)) throw error()
      return original(key, ...rest)
    })
    restores.push(() => spy.mockRestore())
  }

  // A plain wrapper, not a Proxy of the MULTI: node-redis defines `json` on it as a read-only,
  // non-configurable property, and a Proxy must then hand back that very object.
  const wrapMulti = (multi: any) => {
    const touched: string[] = []
    const record = (target: any, fn: (...args: any[]) => any) => (key: any, ...rest: any[]) => {
      if (typeof key === 'string') touched.push(key)
      fn.call(target, key, ...rest)
      return wrapper
    }
    const own: Record<string, any> = {
      exec: async (...args: any[]) => {
        if (touched.some(shouldFail)) throw error()
        return multi.exec(...args)
      },
      json: new Proxy(
        {},
        {
          get(_json, jsonProp) {
            const fn = multi.json?.[jsonProp]
            return typeof fn === 'function' ? record(multi.json, fn) : fn
          }
        }
      )
    }
    const wrapper: any = new Proxy(own, {
      get(target, prop) {
        if (typeof prop === 'string' && prop in target) return target[prop]
        const fn = multi[prop]
        return typeof fn === 'function' ? record(multi, fn) : fn
      }
    })
    return wrapper
  }

  const currentExecute = (redis as any).execute
  const originalExecute = currentExecute.getMockImplementation?.() ?? currentExecute.bind(redis)
  const executeSpy = vi.spyOn(redis as any, 'execute').mockImplementation(async (operation: any) =>
    originalExecute(async (client: any) =>
      operation(
        new Proxy(client, {
          get(target, prop) {
            if (prop === 'multi') return () => wrapMulti(target.multi())
            const value = Reflect.get(target, prop)
            // A read-only, non-configurable property must be handed back as it is (Proxy rule).
            const descriptor = Reflect.getOwnPropertyDescriptor(target, prop)
            if (descriptor && !descriptor.configurable && !descriptor.writable) return value
            return typeof value === 'function' ? value.bind(target) : value
          }
        })
      )
    )
  )
  restores.push(() => executeSpy.mockRestore())

  return () => {
    while (restores.length > 0) restores.pop()!()
  }
}
