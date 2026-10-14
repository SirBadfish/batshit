import { vi } from 'vitest'
import { redis } from '$lib/server/redis'

/**
 * A browser's view of the user settings route, for component tests (BL-939). `fetch` sends
 * `/api/user/settings` to the REAL route handlers, which read and write through the REAL
 * `RedisService` (the default lane's Redis fake), so a test sees what the browser sent AND what
 * the stored settings hold after. A test can make the load fail or hold it, the two states a
 * panel must survive without writing.
 */

export type UserSettingsPost = { body: Record<string, any> }

export function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

type RouteModule = typeof import('../../routes/api/user/settings/+server')

export async function loadUserSettingsRoute(): Promise<RouteModule> {
  return import('../../routes/api/user/settings/+server')
}

type Extra = (path: string, method: string, init: RequestInit) => Response | Promise<Response> | undefined

/**
 * Installs the `fetch` stub. `posts` collects every POST body sent to the settings route, in
 * order; `reads` counts every GET that reached it (a failed or held one included). `extra`
 * answers the routes the component under test loads besides the settings (it answers
 * `undefined` for a path it does not know, which the stub turns into a loud 404).
 */
export function installUserSettingsRoutes(input: {
  userId: string
  route: RouteModule
  extra?: Extra
  /** Makes the settings GET answer this status (a failed load) instead of reading. */
  failGetsWith?: () => number | null
  /** Holds a settings GET (after it is counted, before it reads) until the promise it answers settles. */
  holdGets?: () => Promise<void> | null
}) {
  const posts: UserSettingsPost[] = []
  const counts = { reads: 0 }
  const fetchMock = vi.fn(async (request: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.split('?')[0]

    if (path === '/api/user/settings') {
      if (method === 'GET') {
        counts.reads += 1
        const gate = input.holdGets?.()
        if (gate) await gate
        const failStatus = input.failGetsWith?.() ?? null
        if (failStatus !== null) return jsonResponse({ error: 'Redis unavailable' }, failStatus)
        return (await input.route.GET({ locals: { user: { id: input.userId } } } as any)) as Response
      }
      if (method === 'POST') {
        posts.push({ body: JSON.parse(String(init.body)) })
        const routed = new Request(`http://localhost${path}`, { method, body: String(init.body) })
        return (await input.route.POST({
          request: routed,
          locals: { user: { id: input.userId } }
        } as any)) as Response
      }
    }
    const answer = await input.extra?.(path, method, init)
    if (answer) return answer
    return jsonResponse({ error: `not routed in this test: ${method} ${path}` }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { posts, counts, fetchMock }
}

/** The stored settings record, read from the store and not from anything the panel holds. */
export async function storedUserSettings(userId: string) {
  return (await redis.getUserSettings(userId)) as Record<string, any> | null
}
