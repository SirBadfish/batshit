/**
 * SA-111 P2 — a small in-memory stand-in for the `$lib/server/redis` wrapper, shaped for
 * the subagent runner suites.
 *
 * Why a fake and not more `vi.fn()` stubs: the runner's thread control and its in-flight
 * lock (DL-111-04, DL-111-05) are Redis SEMANTICS, not Redis calls. `SET … NX` must
 * actually refuse the second writer, `del` must actually make a resumed thread come back
 * empty, and the compare-and-delete release must actually notice a lock that changed hands.
 * A per-method stub proves none of that, and a partial mock silently omits whatever the
 * code under test reaches for next — the exact trap that hid sibling-call breakage before.
 *
 * Deliberately narrow: this covers the wrapper methods the subagent lanes use, plus the
 * raw-client surface `redis.execute(...)` reaches for. Anything else throws by name so a
 * new dependency shows up as a clear failure instead of `undefined`.
 */

type StoredValue = { value: unknown; expiresAt: number | null }

export interface SubagentRedisMock {
  /** Everything currently stored, expiry applied. Handy for asserting on keys. */
  snapshot: () => Record<string, unknown>
  /** Seed a key directly, bypassing the wrapper's type dispatch. */
  seed: (key: string, value: unknown) => void
  /** Force a key to look expired, so lock-loss paths can be exercised. */
  expireNow: (key: string) => void
  clear: () => void
  redis: Record<string, any>
}

export function createSubagentRedisMock(): SubagentRedisMock {
  const store = new Map<string, StoredValue>()

  const isLive = (entry: StoredValue | undefined): entry is StoredValue => {
    if (!entry) return false
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) return false
    return true
  }

  const read = (key: string): unknown => {
    const entry = store.get(key)
    if (!isLive(entry)) {
      store.delete(key)
      return null
    }
    return entry.value
  }

  const client = {
    async set(key: string, value: string, options?: { NX?: boolean; PX?: number }) {
      const existing = store.get(key)
      if (options?.NX && isLive(existing)) return null
      store.set(key, {
        value,
        expiresAt: options?.PX ? Date.now() + options.PX : null,
      })
      return 'OK'
    },
    async get(key: string) {
      const value = read(key)
      return typeof value === 'string' ? value : value === null ? null : String(value)
    },
    async del(key: string) {
      return store.delete(key) ? 1 : 0
    },
    async exists(key: string) {
      return read(key) === null ? 0 : 1
    },
    async expire(key: string, seconds: number) {
      const entry = store.get(key)
      if (!isLive(entry)) return false
      entry.expiresAt = Date.now() + seconds * 1000
      return true
    },
    json: {
      async get(key: string) {
        return read(key)
      },
      async set(key: string, _path: string, value: unknown) {
        store.set(key, { value, expiresAt: null })
        return 'OK'
      },
    },
  }

  const redis: Record<string, any> = {
    execute: async (operation: (c: typeof client) => Promise<unknown>) => operation(client),
    get: async (key: string) => read(key),
    set: async (key: string, value: unknown) => {
      store.set(key, { value, expiresAt: null })
    },
    del: async (key: string) => {
      store.delete(key)
    },
    exists: async (key: string) => read(key) !== null,
    expire: async (key: string, seconds: number) => client.expire(key, seconds),
    keys: async (pattern: string) => {
      const matcher = new RegExp(
        `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`
      )
      return [...store.keys()].filter((key) => matcher.test(key) && read(key) !== null)
    },
    json: client.json,
  }

  return {
    redis,
    snapshot: () =>
      Object.fromEntries(
        [...store.keys()].map((key) => [key, read(key)]).filter(([, value]) => value !== null)
      ),
    seed: (key, value) => {
      store.set(key, { value, expiresAt: null })
    },
    expireNow: (key) => {
      const entry = store.get(key)
      if (entry) entry.expiresAt = Date.now() - 1
    },
    clear: () => store.clear(),
  }
}
