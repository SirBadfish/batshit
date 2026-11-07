import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '$env/dynamic/private'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { POST as fetchZipPost } from '../../../routes/api/native-tools/fetch-zip/+server'
import { POST as analyzePost } from '../../../routes/api/artifacts/analyze/+server'
import { POST as sharePost } from '../../../routes/api/artifacts/share/+server'
import { POST as completePost } from '../../../routes/api/artifacts/complete/+server'
import { POST as webPost } from '../../../routes/api/native-tools/web-search/+server'
import { GET as sandboxGet } from '../../../routes/api/native-tools/sandbox/status/+server'
import { POST as eventPost } from '../../../routes/api/artifacts/run-event/+server'
import { GET as comfyGet } from '../../../routes/api/artifacts/comfyui/[...path]/+server'
import { POST as mcpFind } from '../../../routes/api/mcp/tools/find/+server'
import { POST as mcpUse } from '../../../routes/api/mcp/tools/execute/+server'

useRedisTestServer()
const TOKEN = 'test-service-token-delegated-routes-0123456789abcdef'
const USER = 'user-delegated-routes'
const MISSING = 'art_delegated_routes_missing'
let previous: string | undefined
beforeEach(() => { previous = (env as Record<string, string | undefined>).BATSHIT_TOKEN; (env as Record<string, string | undefined>).BATSHIT_TOKEN = TOKEN })
afterEach(() => { if (previous === undefined) delete (env as Record<string, string | undefined>).BATSHIT_TOKEN; else (env as Record<string, string | undefined>).BATSHIT_TOKEN = previous })
const routes = [
  { name: 'Fetch Zip', post: fetchZipPost, url: '/api/native-tools/fetch-zip', body: { zipId: 'zip_x', userId: USER }, serviceStatus: 403 },
  { name: 'analyze', post: analyzePost, url: '/api/artifacts/analyze', body: { url: 'not a url' }, serviceStatus: 400 },
  { name: 'share', post: sharePost, url: '/api/artifacts/share', body: { artifactId: MISSING, content: 'x', includeInChat: false }, serviceStatus: 404 },
  { name: 'complete', post: completePost, url: '/api/artifacts/complete', body: { artifactId: MISSING, prompt: 'x' }, serviceStatus: 404 }
] as const
const call = (route: typeof routes[number], retired: boolean, session: boolean) => route.post({
  request: new Request(`http://localhost${route.url}`, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-batshit-token': TOKEN, 'x-batshit-user-id': USER,
    ...(retired ? { 'x-batshit-agent-token': 'arc_old.bsac_secret' } : {})
  }, body: JSON.stringify(route.body) }),
  locals: session ? { user: { id: USER } } : {}
} as any)
async function status(route: typeof routes[number], retired: boolean, session: boolean) {
  try { return (await call(route, retired, session)).status }
  catch (error) {
    const value = (error as { status?: unknown }).status
    if (typeof value === 'number') return value
    throw error
  }
}
describe('retired credentials at direct native and artifact routes', () => {
  for (const route of routes) {
    it(`${route.name} refuses before effects even with a valid service token and session`, async () => {
      expect(await status(route, true, true)).toBe(401)
      expect(await redis.exists(`ratelimit:artifact-share:${USER}:${MISSING}`)).toBe(false)
      expect(await redis.exists(`ratelimit:artifact:${USER}:${MISSING}`)).toBe(false)
    })
    it(`${route.name} keeps its service-lane refusal or validation`, async () => {
      expect(await status(route, false, false)).toBe(route.serviceStatus)
    })
  }
  it('also refuses MCP, web search, sandbox status, Artifact events and ComfyUI before work', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected outbound request') })
    const headers = { 'content-type': 'application/json', 'x-batshit-token': TOKEN, 'x-batshit-user-id': USER, 'x-batshit-agent-token': 'arc_old.bsac_secret' }
    const locals = { user: { id: USER } }
    const web = new Request('http://localhost/api/native-tools/web-search', { method: 'POST', headers, body: JSON.stringify({ query: 'example' }) })
    const sandbox = new Request('http://localhost/api/native-tools/sandbox/status?hostOnly=1', { headers })
    const event = new Request('http://localhost/api/artifacts/run-event', { method: 'POST', headers, body: JSON.stringify({ artifactId: 'a1', runId: 'r1', eventType: 'started' }) })
    const url = new URL('http://localhost/api/artifacts/comfyui/system_stats?baseUrl=http://127.0.0.1:8188')
    const comfy = new Request(url, { headers })
    const find = new Request('http://localhost/api/mcp/tools/find', { method: 'POST', headers, body: JSON.stringify({ query: 'example', agentId: 'claimed' }) })
    const use = new Request('http://localhost/api/mcp/tools/execute', { method: 'POST', headers, body: JSON.stringify({ toolName: 'example', agentId: 'claimed' }) })
    expect((await mcpFind({ request: find, locals } as any)).status).toBe(401)
    expect((await mcpUse({ request: use, locals } as any)).status).toBe(401)
    expect((await webPost({ request: web, locals } as any)).status).toBe(401)
    expect((await sandboxGet({ request: sandbox, locals } as any)).status).toBe(401)
    expect((await eventPost({ request: event, locals } as any)).status).toBe(401)
    expect((await comfyGet({ request: comfy, locals, url, params: { path: 'system_stats' } } as any)).status).toBe(401)
    expect(network).not.toHaveBeenCalled()
    network.mockRestore()
  })

})
