import { vi } from 'vitest'
import { redis } from '$lib/server/redis'

/**
 * A browser's view of the agent route, for component tests (BL-848, BL-855). `fetch` sends
 * `/api/agents/<id>` to the REAL route handlers, which write through the REAL `redis.updateAgent`
 * (the default lane's Redis fake runs its twin), so a test sees both what the browser sent and
 * what the record holds after. The agents store is the real one.
 *
 * The test file mocks `codexProfileManager` and `claudeProfileManager` (the route syncs profiles).
 */

export type AgentPut = { body: Record<string, any> }

export function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

type RouteModule = typeof import('../../routes/api/agents/[id]/+server')

export async function loadAgentRoute(): Promise<RouteModule> {
  return import('../../routes/api/agents/[id]/+server')
}

type Extra = (path: string, method: string, init: RequestInit) => Response | Promise<Response> | undefined

/**
 * Installs the `fetch` stub. `puts` collects every PUT body sent to the agent, in order. `extra`
 * answers the routes the component under test loads besides the agent (it answers `undefined` for
 * a path it does not know, which the stub turns into a loud 404).
 */
export function installAgentRoutes(input: {
  agentId: string
  userId: string
  route: RouteModule
  extra?: Extra
  /** Makes the agent PUT answer this status (a failed save) instead of writing. */
  failPutsWith?: () => number | null
  /** Holds a PUT (after it is recorded, before it writes) until the promise it answers settles. */
  holdPuts?: () => Promise<void> | null
}) {
  const puts: AgentPut[] = []
  const fetchMock = vi.fn(async (request: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.split('?')[0]

    if (path === `/api/agents/${input.agentId}`) {
      if (method === 'PUT') {
        puts.push({ body: JSON.parse(String(init.body)) })
        const failStatus = input.failPutsWith?.() ?? null
        if (failStatus !== null) return jsonResponse({ error: 'Probe refusal' }, failStatus)
        const gate = input.holdPuts?.()
        if (gate) await gate
      }
      const routed = new Request(`http://localhost${path}`, {
        method,
        body: method === 'PUT' ? String(init.body) : undefined
      })
      const handler = method === 'PUT' ? input.route.PUT : input.route.GET
      return (await handler({
        params: { id: input.agentId },
        request: routed,
        locals: { user: { id: input.userId } }
      } as any)) as Response
    }
    const answer = await input.extra?.(path, method, init)
    if (answer) return answer
    return jsonResponse({ error: `not routed in this test: ${method} ${path}` }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { puts, fetchMock }
}

export async function storedAgent(agentId: string) {
  return (await redis.json.get(`agent:${agentId}`)) as Record<string, any>
}
