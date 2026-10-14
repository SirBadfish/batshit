import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '$env/dynamic/private'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  AGENT_RUN_CREDENTIAL_HEADER,
  mintRunCredential
} from '$lib/server/services/agentRunCredentials'

/**
 * BL-81 — `/api/controls/find` on the `agent` lane, through the REAL resolver and REAL minted
 * credentials, with only `findControls` mocked.
 *
 * What this pins is what the route asks the registry to show. For a Subagent or Worker run it
 * must be exactly what `/api/controls/use` will run for it, or the run is shown one set of
 * controls and allowed another: only the controls its credential carries (the ones its DCM
 * offered it), with artifact allowlists judged by its scope id (the Subagent's record id,
 * which Settings -> Agents -> Access writes into an artifact's allowlist and which the run's
 * own DCM lists controls for), not by the per-run runtime id its credential authenticated.
 */

const mocks = vi.hoisted(() => ({ findControls: vi.fn() }))

vi.mock('$lib/server/services/fabricRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/fabricRegistry')>()
  return { ...actual, findControls: mocks.findControls }
})

import { POST } from './+server'

useRedisTestServer()

const SERVICE_TOKEN = 'test-service-token-0123456789abcdef0123456789abcdef'
const USER = 'user-find-route'
const COOPER = 'agent-cooper'
const RUNTIME = 'subagent_cli_research_bot'
const SCOPE = 'research_bot'

let previousServiceToken: string | undefined

function request(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/controls/find', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
}

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.findControls.mockResolvedValue({ results: [], totalMatches: 0 })
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
  await redis.json.set(`subagent:${SCOPE}`, '$', {
    id: SCOPE,
    user_id: USER,
    displayName: 'Research Bot'
  } as never)
})

afterEach(() => {
  if (previousServiceToken === undefined) {
    delete (env as Record<string, string | undefined>).BATSHIT_TOKEN
  } else {
    ;(env as Record<string, string | undefined>).BATSHIT_TOKEN = previousServiceToken
  }
})

async function find(body: Record<string, unknown>, headers: Record<string, string>) {
  return await POST({ request: request(body, headers), locals: {} } as any)
}

describe('BL-81 — /api/controls/find shows what /api/controls/use runs', () => {
  it('asks the registry for a delegated run’s list only, seen for its scope id', async () => {
    const { token } = await mintRunCredential({
      userId: USER,
      agentId: RUNTIME,
      sessionId: 'sess-1',
      runtime: 'codex',
      delegated: true,
      scopeAgentId: SCOPE,
      allowedControlIds: ['sys.zip.fetch', 'use.artifact.*']
    })

    const response = await find(
      { query: 'artifact', allowedControlIds: ['use.artifact.*'] },
      { [AGENT_RUN_CREDENTIAL_HEADER]: token }
    )

    expect(response.status).toBe(200)
    expect(mocks.findControls).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER,
        agentId: SCOPE,
        allowedControlIds: ['use.artifact.*'],
        delegatedRun: true,
        delegatedAllowedControlIds: ['sys.zip.fetch', 'use.artifact.*']
      })
    )
  })

  it('shows nothing to a delegated credential minted before BL-81, which carries no list', async () => {
    const { token, credentialId } = await mintRunCredential({
      userId: USER,
      agentId: RUNTIME,
      sessionId: 'sess-1',
      runtime: 'codex',
      delegated: true,
      scopeAgentId: SCOPE,
      allowedControlIds: ['use.artifact.*']
    })
    const key = `agent_run_credential:${credentialId}`
    const { allowedControlIds: _dropped, ...before } = (await redis.json.get(key)) as Record<string, unknown>
    await redis.json.set(key, '$', before as never)

    await find({ query: 'artifact' }, { [AGENT_RUN_CREDENTIAL_HEADER]: token })

    expect(mocks.findControls).toHaveBeenCalledWith(
      expect.objectContaining({ delegatedRun: true, delegatedAllowedControlIds: [] })
    )
  })

  it('asks for a primary run’s own agent, unchanged', async () => {
    const { token } = await mintRunCredential({
      userId: USER,
      agentId: COOPER,
      sessionId: 'sess-1',
      runtime: 'codex'
    })

    await find({ query: 'artifact' }, { [AGENT_RUN_CREDENTIAL_HEADER]: token })

    expect(mocks.findControls).toHaveBeenCalledWith(expect.objectContaining({ agentId: COOPER }))
    // A primary run's own settings govern, as before: no delegated list at all.
    expect(mocks.findControls.mock.calls[0]?.[0].delegatedRun).toBeUndefined()
    expect(mocks.findControls.mock.calls[0]?.[0].delegatedAllowedControlIds).toBeUndefined()
  })

  it('leaves the service lane’s body agent id alone', async () => {
    await find(
      { query: 'artifact', agentId: COOPER },
      { 'x-batshit-service-token': SERVICE_TOKEN, 'x-batshit-user-id': USER }
    )

    expect(mocks.findControls).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, agentId: COOPER })
    )
    expect(mocks.findControls.mock.calls[0]?.[0].delegatedAllowedControlIds).toBeUndefined()
  })

  it('still refuses a delegated run that names an agent in the body, the scope id included', async () => {
    // The scope id is not a second identity to claim: the credential authenticated the run, and
    // this lane takes no agent id from the body at all.
    const { token } = await mintRunCredential({
      userId: USER,
      agentId: RUNTIME,
      sessionId: 'sess-1',
      runtime: 'codex',
      delegated: true,
      scopeAgentId: SCOPE,
      allowedControlIds: ['use.artifact.*']
    })

    const response = await find(
      { query: 'artifact', agentId: SCOPE },
      { [AGENT_RUN_CREDENTIAL_HEADER]: token }
    )

    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('AGENT_MISMATCH')
    expect(mocks.findControls).not.toHaveBeenCalled()
  })
})
