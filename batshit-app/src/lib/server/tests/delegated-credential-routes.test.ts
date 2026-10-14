import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '$env/dynamic/private'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  AGENT_RUN_CREDENTIAL_HEADER,
  mintRunCredential
} from '$lib/server/services/agentRunCredentials'
import { nativeToolService } from '$lib/server/services/nativeTools'
import { POST as fetchZipPost } from '../../../routes/api/native-tools/fetch-zip/+server'
import { POST as analyzePost } from '../../../routes/api/artifacts/analyze/+server'
import { POST as sharePost } from '../../../routes/api/artifacts/share/+server'
import { POST as completePost } from '../../../routes/api/artifacts/complete/+server'

/**
 * BL-81 follow-up — the routes outside `/api/controls/find` and `/use` that take a run
 * credential, through the REAL resolver and REAL minted credentials.
 *
 * A CLI Subagent or Worker run's credential is in its child's environment, so the model's own
 * shell can present it anywhere. Before this, these four routes served it as the full user.
 * Delegated credentials cannot Fetch Zip (BL-494) or analyze URLs (SA-064), even if an old
 * control list names them. Artifact share and complete are also refused
 * (its allowed artifact tools reach those two through `/api/controls/use`, whose handler makes
 * the hop with the instance token). A primary run's credential, a signed-in browser, and the
 * instance token keep their artifact answers. BL-494 now reserves Fetch Zip for enabled model
 * runs only; browser and service credentials cannot use it as a read backdoor.
 */

useRedisTestServer()

const SERVICE_TOKEN = 'test-service-token-delegated-routes-0123456789abcdef'
const USER = 'user-delegated-routes'
const COOPER = 'agent-cooper'
const RUNTIME = 'subagent_cli_research_bot'
const SCOPE = 'research_bot'
const MISSING_ARTIFACT = 'art_delegated_routes_missing'

let previousServiceToken: string | undefined

type Lane = 'delegated' | 'delegated-listed' | 'primary' | 'session' | 'service'

async function laneRequest(lane: Lane, url: string, body: Record<string, unknown>, listed: string[] = []) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  let locals: Record<string, unknown> = {}
  if (lane === 'delegated' || lane === 'delegated-listed') {
    const { token } = await mintRunCredential({
      userId: USER,
      agentId: RUNTIME,
      sessionId: 'sess-1',
      runtime: 'codex',
      fetchZipAllowed: false,
      delegated: true,
      scopeAgentId: SCOPE,
      // The list a real CLI Subagent run carries, plus (for `delegated-listed`) the one control
      // that does the route's work, to show the route applies the list rather than a blanket no.
      allowedControlIds: lane === 'delegated' ? ['use.artifact.*'] : ['use.artifact.*', ...listed]
    })
    headers[AGENT_RUN_CREDENTIAL_HEADER] = token
  } else if (lane === 'primary') {
    const { token } = await mintRunCredential({ userId: USER, agentId: COOPER, sessionId: 'sess-1', runtime: 'codex', fetchZipAllowed: true })
    headers[AGENT_RUN_CREDENTIAL_HEADER] = token
  } else if (lane === 'service') {
    headers['x-batshit-token'] = SERVICE_TOKEN
    headers['x-batshit-user-id'] = USER
  } else {
    locals = { user: { id: USER } }
  }
  return {
    request: new Request(`http://localhost${url}`, { method: 'POST', headers, body: JSON.stringify(body) }),
    locals
  }
}

/** A thrown SvelteKit `error()` is an answer too; normalize both to a status and a body. */
async function answer(run: () => Promise<Response>): Promise<{ status: number; body: any }> {
  try {
    const response = await run()
    return { status: response.status, body: await response.json().catch(() => null) }
  } catch (thrown) {
    const status = (thrown as { status?: number })?.status
    if (typeof status !== 'number') throw thrown
    return { status, body: (thrown as { body?: unknown }).body ?? null }
  }
}

function expectRefused(result: { status: number; body: any }) {
  expect(result.status).toBe(403)
  expect(result.body).toMatchObject({ success: false, code: 'CONTROL_NOT_ALLOWED' })
  expect(String(result.body?.error)).toMatch(/Subagent or Worker run cannot use this route/)
}

beforeEach(async () => {
  vi.restoreAllMocks()
  previousServiceToken = (env as Record<string, string | undefined>).BATSHIT_TOKEN
  ;(env as Record<string, string | undefined>).BATSHIT_TOKEN = SERVICE_TOKEN
  await redis.createAgent({
    id: COOPER,
    user_id: USER,
    displayName: 'Cooper',
    agentType: 'cli',
    primary_model_provider: 'codex',
    primary_model_name: 'gpt-5.6'
  } as any)
  await redis.json.set(`subagent:${SCOPE}`, '$', { id: SCOPE, user_id: USER, displayName: 'Research Bot' } as never)
})

afterEach(() => {
  vi.restoreAllMocks()
  if (previousServiceToken === undefined) {
    delete (env as Record<string, string | undefined>).BATSHIT_TOKEN
  } else {
    ;(env as Record<string, string | undefined>).BATSHIT_TOKEN = previousServiceToken
  }
})

describe('BL-81 follow-up — /api/native-tools/fetch-zip applies the run’s list', () => {
  const run = async (lane: Lane) => {
    const fetchZip = vi
      .spyOn(nativeToolService, 'nativeFetchZip')
      .mockResolvedValue({ zipId: 'zip_x', found: false } as never)
    const event = await laneRequest(lane, '/api/native-tools/fetch-zip', { zipId: 'zip_x', userId: USER }, ['sys.zip.fetch'])
    const result = await answer(() => fetchZipPost(event as any))
    return { result, fetchZip }
  }

  it.each(['delegated', 'delegated-listed'] as Lane[])('refuses the %s run even if its list names Fetch Zip', async (lane) => {
    const { result, fetchZip } = await run(lane)
    expect(result.status).toBe(403)
    expect(result.body).toMatchObject({ success: false, code: 'FETCH_ZIP_UNAVAILABLE' })
    expect(fetchZip).not.toHaveBeenCalled()
  })

  it.each(['primary'] as Lane[])('serves the enabled %s model lane', async (lane) => {
    const { result, fetchZip } = await run(lane)
    expect(result.status).toBe(200)
    expect(fetchZip).toHaveBeenCalledWith(expect.objectContaining({ userId: USER, zipId: 'zip_x' }))
  })

  it.each(['session', 'service'] as Lane[])('refuses the %s lane without a verified model run', async (lane) => {
    const { result, fetchZip } = await run(lane)
    expect(result.status).toBe(403)
    expect(result.body.error).toContain('verified model run')
    expect(fetchZip).not.toHaveBeenCalled()
  })
})

describe('BL-81 follow-up — /api/artifacts/analyze applies the run’s list', () => {
  // An unparseable URL: every lane that gets past the credential check answers 400 without any
  // network, so the answer alone tells the two apart.
  const run = async (lane: Lane) =>
    answer(async () => analyzePost((await laneRequest(lane, '/api/artifacts/analyze', { url: 'not a url' }, ['sys.artifact.analyze_url'])) as any))

  it('refuses a delegated credential, whose list never holds the analyze control (SA-064)', async () => {
    expectRefused(await run('delegated'))
  })

  it.each(['delegated-listed', 'primary', 'session', 'service'] as Lane[])('serves the %s lane as before', async (lane) => {
    const result = await run(lane)
    expect(result.status).toBe(400)
  })
})

describe('BL-81 follow-up — /api/artifacts/share and /complete refuse a delegated credential', () => {
  const routes = [
    { name: 'share', post: sharePost, url: '/api/artifacts/share', body: { artifactId: MISSING_ARTIFACT, content: 'x', includeInChat: false }, rateKey: `ratelimit:artifact-share:${USER}:${MISSING_ARTIFACT}` },
    { name: 'complete', post: completePost, url: '/api/artifacts/complete', body: { artifactId: MISSING_ARTIFACT, prompt: 'x' }, rateKey: `ratelimit:artifact:${USER}:${MISSING_ARTIFACT}` }
  ] as const

  for (const route of routes) {
    it(`${route.name}: refuses every delegated credential, even one listing the artifact tools, before the rate limit`, async () => {
      for (const lane of ['delegated', 'delegated-listed'] as Lane[]) {
        const event = await laneRequest(lane, route.url, { ...route.body }, ['use.artifact.*', 'sys.zip.fetch'])
        expectRefused(await answer(() => route.post(event as any)))
      }
      expect(await redis.exists(route.rateKey)).toBe(false)
    })

    it.each(['primary', 'session', 'service'] as Lane[])(`${route.name}: serves the %s lane as before`, async (lane) => {
      const event = await laneRequest(lane, route.url, { ...route.body })
      const result = await answer(() => route.post(event as any))
      // Past the credential check: the rate limit counted it, then the artifact was not found.
      expect(result.status).toBe(404)
      expect(await redis.exists(route.rateKey)).toBe(true)
    })
  }
})
