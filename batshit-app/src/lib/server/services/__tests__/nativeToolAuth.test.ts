import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '$env/dynamic/private'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  AGENT_RUN_CREDENTIAL_HEADER,
  agentRunCredentialKey,
  getRunCredential,
  mintRunCredential,
  revokeRunCredential
} from '../agentRunCredentials'
import { resolveNativeToolUser } from '../nativeToolAuth'

/**
 * SA-117 P1 (DL-117-03) — the `agent` lane's place in the resolver's order.
 *
 * The order IS the security boundary (deep dive §6.1). Two properties are pinned here and
 * nowhere else, and both of them fail against the pre-SA-117 code:
 *
 *   1. the run credential is tried FIRST, so a caller holding both it and the instance token
 *      is served as the agent it actually is, not as an anonymous service caller; and
 *   2. a PRESENT agent header must validate or the whole request is refused — it never falls
 *      through to a weaker lane. Without that, attaching a junk agent header to a valid
 *      service-token call would be silently served as the service lane, which is the exact
 *      hole the story exists to close.
 *
 * The service, n8n-callback, and portable-skill lanes are asserted to be unchanged when no
 * agent header is present, because DL-117-03 says the rest of the chain stays byte-identical.
 */

useRedisTestServer()

const SERVICE_TOKEN = 'test-service-token-0123456789abcdef0123456789abcdef'
const USER = 'user-lane'
const COOPER = 'agent-cooper'

let previousServiceToken: string | undefined
let warnSpy: ReturnType<typeof vi.spyOn>

async function seedAgent(id: string, userId = USER) {
  await redis.createAgent({
    id,
    user_id: userId,
    displayName: 'Cooper',
    agentType: 'api',
    primary_model_provider: 'anthropic',
    primary_model_name: 'claude-sonnet-4-5'
  } as any)
}

function request(headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/controls/use', {
    method: 'POST',
    headers
  })
}

function serviceHeaders(): Record<string, string> {
  return {
    'x-batshit-service-token': SERVICE_TOKEN,
    'x-batshit-user-id': USER
  }
}

beforeEach(async () => {
  // `$env/dynamic/private` resolves to a shared mutable mock object in tests, and `redis.ts`
  // already writes `REDIS_URL` onto it the same way. Restored in `afterEach`.
  previousServiceToken = (env as Record<string, string | undefined>).BATSHIT_TOKEN
  ;(env as Record<string, string | undefined>).BATSHIT_TOKEN = SERVICE_TOKEN
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await seedAgent(COOPER)
})

afterEach(() => {
  if (previousServiceToken === undefined) {
    delete (env as Record<string, string | undefined>).BATSHIT_TOKEN
  } else {
    ;(env as Record<string, string | undefined>).BATSHIT_TOKEN = previousServiceToken
  }
  warnSpy.mockRestore()
})

async function mintRun(overrides: Record<string, unknown> = {}) {
  return await mintRunCredential({
    userId: USER,
    agentId: COOPER,
    sessionId: 'sess-1',
    runtime: 'codex',
    ...overrides
  } as any)
}

describe('the agent lane comes first', () => {
  it('resolves the bound agent and session from the credential, not the body', async () => {
    const { credentialId, token } = await mintRun()

    const auth = await resolveNativeToolUser({
      request: request({ [AGENT_RUN_CREDENTIAL_HEADER]: token }),
      // A body claim that contradicts the credential on every field. None of it is read.
      claimedUserId: 'somebody-else',
      payload: { agentId: 'agent-faye', sessionId: 'sess-99', userId: 'somebody-else' }
    })

    expect(auth).toEqual({
      userId: USER,
      auth: 'agent',
      agentId: COOPER,
      sessionId: 'sess-1',
      credentialId,
      // SA-117 P2 (F-P2-1): a primary run, so it CAN act as the agent it names.
      delegated: false
    })
  })

  it('carries the delegated marker off a Subagent or Worker credential (F-P2-1)', async () => {
    const delegated = await mintRunCredential({
      userId: USER,
      agentId: 'subagent_cli_worker_agent_cooper_1',
      sessionId: 'sess-1',
      runtime: 'codex',
      delegated: true
    })

    const auth = await resolveNativeToolUser({
      request: request({ [AGENT_RUN_CREDENTIAL_HEADER]: delegated.token })
    })

    expect(auth).toMatchObject({
      auth: 'agent',
      agentId: 'subagent_cli_worker_agent_cooper_1',
      delegated: true
    })
  })

  it('beats a valid service header presented on the same request', async () => {
    const { token } = await mintRun()

    const auth = await resolveNativeToolUser({
      request: request({ ...serviceHeaders(), [AGENT_RUN_CREDENTIAL_HEADER]: token }),
      localsUserId: USER
    })

    // Pre-SA-117 this request resolved `service` with no agent at all.
    expect(auth?.auth).toBe('agent')
    expect(auth?.agentId).toBe(COOPER)
  })

  it('records the use, so "this run did something" is true in the audit', async () => {
    const { credentialId, token } = await mintRun()

    await resolveNativeToolUser({ request: request({ [AGENT_RUN_CREDENTIAL_HEADER]: token }) })
    // The bump is deliberately not awaited by the resolver, so let its microtasks settle.
    await new Promise((resolve) => setTimeout(resolve, 5))

    const record = await getRunCredential(credentialId)
    expect(record?.useCount).toBe(1)
    expect(record?.lastUsedAt).toBeTruthy()
  })
})

describe('a present agent header must validate', () => {
  it('refuses a wrong secret even beside a valid service header', async () => {
    const { credentialId } = await mintRun()

    const auth = await resolveNativeToolUser({
      request: request({
        ...serviceHeaders(),
        [AGENT_RUN_CREDENTIAL_HEADER]: `${credentialId}.bsac_wrong`
      }),
      localsUserId: USER
    })

    expect(auth).toBeNull()
  })

  it('refuses an unknown id, a malformed presentation, and an empty header', async () => {
    for (const presented of ['arc_unknown.bsac_secret', 'nonsense', '']) {
      const auth = await resolveNativeToolUser({
        request: request({ ...serviceHeaders(), [AGENT_RUN_CREDENTIAL_HEADER]: presented }),
        localsUserId: USER
      })
      expect(auth).toBeNull()
    }
  })

  it('refuses an expired credential rather than dropping to the service lane', async () => {
    const { credentialId, token } = await mintRun()
    await redis.json.set(
      agentRunCredentialKey(credentialId),
      '$.expiresAt',
      new Date(Date.now() - 1000).toISOString() as never
    )

    const auth = await resolveNativeToolUser({
      request: request({ ...serviceHeaders(), [AGENT_RUN_CREDENTIAL_HEADER]: token }),
      localsUserId: USER
    })

    expect(auth).toBeNull()
  })

  it('refuses a revoked credential — a Stop mid-run closes the door at once', async () => {
    const { credentialId, token } = await mintRun()
    await revokeRunCredential(credentialId)

    expect(
      await resolveNativeToolUser({
        request: request({ [AGENT_RUN_CREDENTIAL_HEADER]: token }),
        localsUserId: USER
      })
    ).toBeNull()
  })

  it('refuses without falling through to the session lane either', async () => {
    // The session lane is the LAST and weakest, and a browser session is the one lane a bad
    // agent header could plausibly be attached to by accident. It must not rescue the call.
    const auth = await resolveNativeToolUser({
      request: request({ [AGENT_RUN_CREDENTIAL_HEADER]: 'arc_unknown.bsac_secret' }),
      localsUserId: USER
    })

    expect(auth).toBeNull()
  })

  it('logs why it refused and returns nothing that says which reason it was', async () => {
    const { credentialId } = await mintRun()

    for (const presented of [`${credentialId}.bsac_wrong`, 'arc_unknown.bsac_secret', 'junk']) {
      expect(
        await resolveNativeToolUser({ request: request({ [AGENT_RUN_CREDENTIAL_HEADER]: presented }) })
      ).toBeNull()
    }

    // DL-117-02's same-403 rule: the reason exists for the server log and nowhere else.
    const reasons = warnSpy.mock.calls.map((call) => String(call[0]))
    expect(reasons).toHaveLength(3)
    expect(reasons.join('\n')).toMatch(/invalid/)
    expect(reasons.join('\n')).toMatch(/malformed/)
  })
})

describe('the rest of the chain is unchanged', () => {
  it('still resolves the service lane when no agent header is present', async () => {
    const auth = await resolveNativeToolUser({ request: request(serviceHeaders()) })
    expect(auth).toEqual({ userId: USER, auth: 'service' })
  })

  it('still lower-cases the service lane’s claimed user id', async () => {
    const auth = await resolveNativeToolUser({
      request: request({ 'x-batshit-service-token': SERVICE_TOKEN, 'x-batshit-user-id': 'USER-Lane' })
    })
    expect(auth).toEqual({ userId: 'user-lane', auth: 'service' })
  })

  it('still refuses a wrong service token and still falls back to the session lane', async () => {
    expect(
      await resolveNativeToolUser({
        request: request({ 'x-batshit-service-token': 'wrong', 'x-batshit-user-id': USER })
      })
    ).toBeNull()

    expect(await resolveNativeToolUser({ request: request(), localsUserId: USER })).toEqual({
      userId: USER,
      auth: 'session'
    })
  })

  it('still returns null for a request with no credential of any kind', async () => {
    expect(await resolveNativeToolUser({ request: request() })).toBeNull()
  })
})
