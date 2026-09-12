import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '$env/dynamic/private'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  AGENT_RUN_CREDENTIAL_HEADER,
  mintRunCredential,
  revokeRunCredential
} from '$lib/server/services/agentRunCredentials'

/**
 * SA-117 P1 (DL-117-03, DL-117-10) — `/api/controls/use` on the `agent` lane, through the REAL
 * resolver.
 *
 * `use-route.test.ts` and `portable.test.ts` both MOCK `resolveNativeToolUser`, which is right
 * for what they pin (what the route decides once auth has happened) and useless for what this
 * file pins: that the route refuses a request whose agent header does not validate, even when
 * the same request carries a service token that would otherwise have been accepted. So the
 * resolver here is real and only `useControl` is mocked.
 *
 * It is a route-level test on purpose. A caller does not see `resolveNativeToolUser` return
 * `null`; it sees a status code and a body, and a fall-through bug would show up as a 200.
 */

const mocks = vi.hoisted(() => ({ useControl: vi.fn() }))

vi.mock('$lib/server/services/fabricRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/fabricRegistry')>()
  return { ...actual, useControl: mocks.useControl }
})

import { POST } from './+server'

useRedisTestServer()

const SERVICE_TOKEN = 'sa117-route-instance-token-at-least-32-chars'
const USER = 'user-route'
const COOPER = 'agent-cooper'

let previousServiceToken: string | undefined

function request(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/controls/use', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
}

function serviceHeaders(): Record<string, string> {
  return { 'x-batshit-service-token': SERVICE_TOKEN, 'x-batshit-user-id': USER }
}

const OK_RESULT = {
  success: true,
  controlId: 'sys.dm.read',
  dryRun: false,
  riskLevel: 'safe',
  status: 'published',
  result: { ok: true }
}

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.useControl.mockResolvedValue(OK_RESULT)
  previousServiceToken = (env as Record<string, string | undefined>).BATSHIT_TOKEN
  ;(env as Record<string, string | undefined>).BATSHIT_TOKEN = SERVICE_TOKEN
  await redis.createAgent({
    id: COOPER,
    user_id: USER,
    displayName: 'Cooper',
    agentType: 'api',
    primary_model_provider: 'anthropic',
    primary_model_name: 'claude-sonnet-4-5'
  } as any)
})

afterEach(() => {
  if (previousServiceToken === undefined) {
    delete (env as Record<string, string | undefined>).BATSHIT_TOKEN
  } else {
    ;(env as Record<string, string | undefined>).BATSHIT_TOKEN = previousServiceToken
  }
})

async function mintRun() {
  return await mintRunCredential({
    userId: USER,
    agentId: COOPER,
    sessionId: 'sess-1',
    runtime: 'codex'
  })
}

describe('/api/controls/use on the agent lane', () => {
  it('refuses a bad agent header even beside a valid service header, and runs nothing', async () => {
    const { credentialId } = await mintRun()

    const response = await POST({
      request: request(
        { controlId: 'sys.dm.read', input: {} },
        { ...serviceHeaders(), [AGENT_RUN_CREDENTIAL_HEADER]: `${credentialId}.bsac_wrong` }
      ),
      locals: {}
    } as any)

    expect(response.status).toBe(401)
    // The whole point: no fall-through means the control never reached the registry.
    expect(mocks.useControl).not.toHaveBeenCalled()
  })

  it('refuses a revoked credential presented beside a valid service header', async () => {
    const { credentialId, token } = await mintRun()
    await revokeRunCredential(credentialId)

    const response = await POST({
      request: request(
        { controlId: 'sys.dm.read', input: {} },
        { ...serviceHeaders(), [AGENT_RUN_CREDENTIAL_HEADER]: token }
      ),
      locals: {}
    } as any)

    expect(response.status).toBe(401)
    expect(mocks.useControl).not.toHaveBeenCalled()
  })

  it('accepts a valid credential and names it on the call (DL-117-10)', async () => {
    const { credentialId, token } = await mintRun()

    const response = await POST({
      request: request(
        { controlId: 'sys.dm.read', input: {} },
        { [AGENT_RUN_CREDENTIAL_HEADER]: token }
      ),
      locals: {}
    } as any)

    expect(response.status).toBe(200)
    expect(mocks.useControl).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER,
        actorType: 'agent',
        credentialId
      })
    )
    // DL-117-01: `allowRisky` stays dead on this lane too — only a Portable Skill Token's
    // family scope is consent (SA-116 DL-116-09), and a run credential is not one.
    expect(mocks.useControl).toHaveBeenCalledWith(
      expect.objectContaining({ allowRisky: false })
    )
  })

  /* ---------------------------------------------------------------------- *
   * SA-117 P2 (DL-117-04) — binding. P1 left this line open as F-P1-3: the route
   * forwarded `credentialId` to the audit but still passed `body.agentId` as the actor.
   * ---------------------------------------------------------------------- */

  it('uses the bound agent when the body names none', async () => {
    const { token } = await mintRun()

    const response = await POST({
      request: request(
        { controlId: 'sys.dm.read', input: {} },
        { [AGENT_RUN_CREDENTIAL_HEADER]: token }
      ),
      locals: {}
    } as any)

    expect(response.status).toBe(200)
    expect(mocks.useControl).toHaveBeenCalledWith(expect.objectContaining({ agentId: COOPER }))
  })

  it('refuses a body agentId that differs: the helper cannot rename itself', async () => {
    const { token } = await mintRun()

    const response = await POST({
      request: request(
        { controlId: 'sys.dm.read', input: {}, agentId: 'agent-faye' },
        { [AGENT_RUN_CREDENTIAL_HEADER]: token }
      ),
      locals: {}
    } as any)

    expect(response.status).toBe(400)
    const payload = await response.json()
    expect(payload.error.code).toBe('AGENT_MISMATCH')
    // A mismatch is evidence of a bug or a forgery, so nothing runs.
    expect(mocks.useControl).not.toHaveBeenCalled()
  })

  it('accepts a body agentId that agrees, for a managed profile written before this story', async () => {
    const { token } = await mintRun()

    const response = await POST({
      request: request(
        { controlId: 'sys.dm.read', input: {}, agentId: COOPER },
        { [AGENT_RUN_CREDENTIAL_HEADER]: token }
      ),
      locals: {}
    } as any)

    expect(response.status).toBe(200)
    expect(mocks.useControl).toHaveBeenCalledWith(expect.objectContaining({ agentId: COOPER }))
  })

  it('uses the bound session, not a different one the body names', async () => {
    const { token } = await mintRun()

    await POST({
      request: request(
        { controlId: 'sys.dm.read', input: {}, sessionId: 'someone-elses-chat' },
        { [AGENT_RUN_CREDENTIAL_HEADER]: token }
      ),
      locals: {}
    } as any)

    // 'sess-1' is not an owned session in this fixture, so `resolveApprovalCardTarget`
    // drops it; what matters is that 'someone-elses-chat' never reached the call.
    const call = mocks.useControl.mock.calls[0]?.[0]
    expect(call.sessionId).not.toBe('someone-elses-chat')
  })

  /* ---------------------------------------------------------------------- *
   * SA-117 P2 (DL-117-10 via AMD-117-02) — the Execution Viewer's acting agent.
   * ---------------------------------------------------------------------- */

  it('returns the bound acting agent so the Execution Viewer can label the step', async () => {
    const { token } = await mintRun()

    const response = await POST({
      request: request(
        { controlId: 'sys.dm.read', input: {} },
        { [AGENT_RUN_CREDENTIAL_HEADER]: token }
      ),
      locals: {}
    } as any)

    expect(await response.json()).toMatchObject({ actingAgentId: COOPER })
  })

  it('returns NO acting agent on the service lane, rather than echoing the body claim', async () => {
    // A label sourced from the caller's own claim would read as though the server had
    // vouched for it, which is worse than no label (F-P1-2).
    const response = await POST({
      request: request({ controlId: 'sys.dm.read', input: {}, agentId: COOPER }, serviceHeaders()),
      locals: {}
    } as any)

    expect(await response.json()).not.toHaveProperty('actingAgentId')
  })

  it('forwards the delegated flag so a Worker run cannot act as an agent (F-P2-1)', async () => {
    const delegated = await mintRunCredential({
      userId: USER,
      agentId: 'subagent_cli_worker_agent_cooper_1',
      sessionId: 'sess-1',
      runtime: 'codex',
      delegated: true
    })

    await POST({
      request: request(
        { controlId: 'sys.dm.list', input: {} },
        { [AGENT_RUN_CREDENTIAL_HEADER]: delegated.token }
      ),
      locals: {}
    } as any)

    expect(mocks.useControl).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'agent',
        agentId: 'subagent_cli_worker_agent_cooper_1',
        delegatedRun: true
      })
    )
  })

  it('forwards delegatedRun as false for an ordinary primary run', async () => {
    const { token } = await mintRun()

    await POST({
      request: request(
        { controlId: 'sys.dm.list', input: {} },
        { [AGENT_RUN_CREDENTIAL_HEADER]: token }
      ),
      locals: {}
    } as any)

    expect(mocks.useControl).toHaveBeenCalledWith(
      expect.objectContaining({ delegatedRun: false })
    )
  })

  it('still names no credential on the service lane', async () => {
    const response = await POST({
      request: request({ controlId: 'sys.dm.read', input: {} }, serviceHeaders()),
      locals: {}
    } as any)

    expect(response.status).toBe(200)
    expect(mocks.useControl).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: 'service', credentialId: undefined })
    )
  })
})
