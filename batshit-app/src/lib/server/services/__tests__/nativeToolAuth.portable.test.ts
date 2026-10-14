import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '$env/dynamic/private'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { AGENT_RUN_CREDENTIAL_HEADER, mintRunCredential } from '../agentRunCredentials'
import {
  N8N_NATIVE_TOOL_CALLBACK_TOKEN_HEADER,
  createN8nSseCallbackToken
} from '../n8nCallbackTokens'
import {
  PORTABLE_SKILL_FAMILIES,
  PORTABLE_SKILL_TOKEN_HEADER,
  createPortableSkillToken,
  getPortableSkillAllowedControlIds,
  revokePortableSkillToken,
  rotatePortableSkillToken,
  updatePortableSkillToken,
  validatePortableSkillToken
} from '../portableSkillTokens'
import {
  PORTABLE_SKILL_SCOPED_DISCOVERY,
  PORTABLE_SKILL_SCOPED_EXECUTION,
  resolveNativeToolUser
} from '../nativeToolAuth'
import type { PortableSkillFamilyId } from '$lib/types/portableSkills'

/**
 * BL-704 — a Portable Skill Token is admitted only where a route opts in, in server code.
 *
 * Every row here runs the REAL resolver against REAL token records (`createPortableSkillToken`,
 * the in-memory RedisJSON fake on the default lane, Redis 8 DB15 on `npm run test:redis`, and
 * this file is on CI's real-Redis list). Nothing is mocked into a portable identity: the point
 * is to prove what the resolver itself admits.
 *
 * Three rules, each of which the pre-BL-704 resolver broke:
 *   1. default deny: a route that names no portable policy never sees the portable lane;
 *   2. only the two exported policy constants admit it, by identity, so nothing a caller
 *      types (a body flag, a string, a JSON copy, a spread copy) can stand in for one;
 *   3. a PRESENTED portable header (empty counts) that is invalid, revoked, unreadable or not
 *      admitted refuses the whole request; it never falls through to the signed-in session.
 */

useRedisTestServer()

const SERVICE_TOKEN = 'test-service-token-bl704-0123456789abcdef0123456789'
const USER = 'user-bl704'
const COOKIE_USER = 'user-bl704'

const ALL_FAMILIES = PORTABLE_SKILL_FAMILIES.map((family) => family.id) as PortableSkillFamilyId[]
const ALLOWED_POLICIES = [
  ['scoped discovery', PORTABLE_SKILL_SCOPED_DISCOVERY, 'scoped-discovery'],
  ['scoped execution', PORTABLE_SKILL_SCOPED_EXECUTION, 'scoped-execution']
] as const

let previousServiceToken: string | undefined
let warnSpy: ReturnType<typeof vi.spyOn>

function request(headers: Record<string, string> = {}, path = '/api/cli-tools/execute') {
  return new Request(`http://localhost${path}`, { method: 'POST', headers })
}

async function mintPortable(families: PortableSkillFamilyId[], userId = USER) {
  return await createPortableSkillToken({ userId, label: 'zcbl704 test', families })
}

beforeEach(() => {
  previousServiceToken = (env as Record<string, string | undefined>).BATSHIT_TOKEN
  ;(env as Record<string, string | undefined>).BATSHIT_TOKEN = SERVICE_TOKEN
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  // BL-787 review: this is the one fake-lane suite that reaches revokePortableSkillToken (and,
  // below, rotate/update) through the shared Redis fake, so it is the one that opts into its
  // three Lua-script twins. Real Redis needs no fake at all.
  if (process.env.VITEST_USE_REAL_REDIS !== 'true') {
    vi.stubEnv('VITEST_FAKE_PORTABLE_SKILL_TOKEN_EVAL', 'true')
  }
})

afterEach(() => {
  if (previousServiceToken === undefined) {
    delete (env as Record<string, string | undefined>).BATSHIT_TOKEN
  } else {
    ;(env as Record<string, string | undefined>).BATSHIT_TOKEN = previousServiceToken
  }
  warnSpy.mockRestore()
  vi.unstubAllEnvs()
})

describe('default deny: a route without a portable policy never admits the token', () => {
  it.each(ALL_FAMILIES)('refuses a valid %s token, with or without a signed-in cookie', async (family) => {
    const { token } = await mintPortable([family])

    expect(
      await resolveNativeToolUser({ request: request({ [PORTABLE_SKILL_TOKEN_HEADER]: token }) })
    ).toBeNull()

    // The pre-BL-704 hole: the token resolved as its owner on every route. And a signed-in
    // cookie beside a refused portable header must not rescue the call as the session lane.
    expect(
      await resolveNativeToolUser({
        request: request({ [PORTABLE_SKILL_TOKEN_HEADER]: token }),
        localsUserId: COOKIE_USER
      })
    ).toBeNull()
  })

  it('refuses a token holding every family too', async () => {
    const { token } = await mintPortable(ALL_FAMILIES)
    expect(
      await resolveNativeToolUser({
        request: request({ [PORTABLE_SKILL_TOKEN_HEADER]: token }),
        localsUserId: COOKIE_USER,
        claimedUserId: USER
      })
    ).toBeNull()
  })

  it('logs the refusal and says nothing about why to the caller', async () => {
    const { token } = await mintPortable(['artifacts'])
    await resolveNativeToolUser({ request: request({ [PORTABLE_SKILL_TOKEN_HEADER]: token }) })
    const logged = warnSpy.mock.calls.map((call) => String(call[0])).join('\n')
    expect(logged).toMatch(/Portable Skill Token/)
    expect(logged).not.toContain(token)
  })
})

describe('the two server-code policies admit the token, scoped to its families', () => {
  for (const [name, policy, kind] of ALLOWED_POLICIES) {
    it.each(ALL_FAMILIES)(`${name} admits a %s token with only that family's controls`, async (family) => {
      const { token, record } = await mintPortable([family])

      const auth = await resolveNativeToolUser({
        request: request({ [PORTABLE_SKILL_TOKEN_HEADER]: token }, '/api/controls/use'),
        // A body that claims someone else and a caller-typed list: neither is read.
        claimedUserId: 'somebody-else',
        payload: { allowedControlIds: ['sys.cli_tool.run'], portableSkillPolicy: 'scoped-execution' },
        portableSkillPolicy: policy
      })

      expect(auth).toEqual({
        userId: USER,
        auth: 'portable-skill',
        portableSkillPolicy: kind,
        portableSkillToken: expect.objectContaining({ id: record.id, families: [family] }),
        portableSkillAllowedControlIds: getPortableSkillAllowedControlIds([family])
      })
      expect(auth?.portableSkillAllowedControlIds?.length).toBeGreaterThan(0)
      expect(auth?.portableSkillToken).not.toHaveProperty('tokenHash')
    })
  }

  it('gives a multi-family token the union of its families and nothing else', async () => {
    const { token } = await mintPortable(['voice-engines', 'cli-tools'])
    const auth = await resolveNativeToolUser({
      request: request({ [PORTABLE_SKILL_TOKEN_HEADER]: token }, '/api/controls/find'),
      portableSkillPolicy: PORTABLE_SKILL_SCOPED_DISCOVERY
    })
    const expected = getPortableSkillAllowedControlIds(['voice-engines', 'cli-tools'])
    expect(auth?.portableSkillAllowedControlIds).toEqual(expected)
    expect(expected).toEqual(
      expect.arrayContaining([
        ...getPortableSkillAllowedControlIds(['voice-engines']),
        ...getPortableSkillAllowedControlIds(['cli-tools'])
      ])
    )
    expect(expected).not.toEqual(expect.arrayContaining(getPortableSkillAllowedControlIds(['artifacts'])))
  })

  it('admits by identity only: a string, a JSON copy, or a spread copy of a policy is refused', async () => {
    const { token } = await mintPortable(['artifacts'])
    const forged: unknown[] = [
      'scoped-execution',
      'scoped-discovery',
      true,
      { kind: 'scoped-execution' },
      JSON.parse(JSON.stringify(PORTABLE_SKILL_SCOPED_EXECUTION)),
      { ...PORTABLE_SKILL_SCOPED_EXECUTION },
      Object.create(PORTABLE_SKILL_SCOPED_DISCOVERY)
    ]
    for (const policy of forged) {
      expect(
        await resolveNativeToolUser({
          request: request({ [PORTABLE_SKILL_TOKEN_HEADER]: token }, '/api/controls/use'),
          localsUserId: COOKIE_USER,
          portableSkillPolicy: policy as never
        })
      ).toBeNull()
    }
  })
})

describe('a presented portable header must validate: no fallback to the session cookie', () => {
  for (const [name, policy] of ALLOWED_POLICIES) {
    it(`${name}: refuses an unknown secret, an empty header, and a blank header`, async () => {
      for (const presented of ['bspt_not_a_real_token_zcbl704', '', '   ']) {
        expect(
          await resolveNativeToolUser({
            request: request({ [PORTABLE_SKILL_TOKEN_HEADER]: presented }, '/api/controls/use'),
            localsUserId: COOKIE_USER,
            portableSkillPolicy: policy
          })
        ).toBeNull()
      }
    })

    it(`${name}: refuses a revoked token rather than serving the signed-in user`, async () => {
      const { token, record } = await mintPortable(['skills'])
      await revokePortableSkillToken({ userId: USER, tokenId: record.id })
      expect(
        await resolveNativeToolUser({
          request: request({ [PORTABLE_SKILL_TOKEN_HEADER]: token }, '/api/controls/use'),
          localsUserId: COOKIE_USER,
          portableSkillPolicy: policy
        })
      ).toBeNull()
    })
  }

  /**
   * BL-787 review item 4: no real-Redis test covered the three atomic Lua scripts. This file
   * is already on CI's real-Redis list (`useRedisTestServer()` above), so these run against
   * real Redis 8.10.1 with the JSON module on `npm run test:redis`, and against the fake
   * lane's opted-in twins otherwise.
   */
  describe('BL-787: update/rotate/revoke run for real (RedisJSON EVAL)', () => {
    it('rotate replaces the secret; the old one stops validating and the new one works', async () => {
      const { token: oldToken, record } = await mintPortable(['skills'])
      const rotated = await rotatePortableSkillToken({ userId: USER, tokenId: record.id })
      expect(rotated.record.id).toBe(record.id)
      await expect(validatePortableSkillToken(oldToken)).resolves.toMatchObject({ valid: false })
      await expect(validatePortableSkillToken(rotated.token)).resolves.toMatchObject({
        valid: true,
        userId: USER
      })
    })

    it('revoke kills the token for real', async () => {
      const { token, record } = await mintPortable(['skills'])
      const revoked = await revokePortableSkillToken({ userId: USER, tokenId: record.id })
      expect(revoked.revokedAt).not.toBeNull()
      await expect(validatePortableSkillToken(token)).resolves.toMatchObject({ valid: false })
    })

    it('update changes families without touching the secret', async () => {
      const { token, record } = await mintPortable(['skills'])
      const updated = await updatePortableSkillToken({
        userId: USER,
        tokenId: record.id,
        families: ['skills', 'cli-tools']
      })
      expect(updated.families).toEqual(['skills', 'cli-tools'])
      await expect(validatePortableSkillToken(token)).resolves.toMatchObject({ valid: true })
    })

    it('a revoke landing before rotate makes the rotate refuse, for real', async () => {
      const { record } = await mintPortable(['skills'])
      await revokePortableSkillToken({ userId: USER, tokenId: record.id })
      await expect(
        rotatePortableSkillToken({ userId: USER, tokenId: record.id })
      ).rejects.toThrow(/not found/i)
    })
  })

  it('an empty header on a route with no policy is refused too, cookie or not', async () => {
    expect(
      await resolveNativeToolUser({
        request: request({ [PORTABLE_SKILL_TOKEN_HEADER]: '' }),
        localsUserId: COOKIE_USER
      })
    ).toBeNull()
  })

  it('a token read failure refuses (it throws); it never becomes a session login', async () => {
    const { token } = await mintPortable(['artifacts'])
    const readFailure = vi
      .spyOn(redis, 'execute')
      .mockRejectedValue(new Error('zcbl704 simulated Redis read failure'))
    try {
      await expect(
        resolveNativeToolUser({
          request: request({ [PORTABLE_SKILL_TOKEN_HEADER]: token }, '/api/controls/use'),
          localsUserId: COOKIE_USER,
          portableSkillPolicy: PORTABLE_SKILL_SCOPED_EXECUTION
        })
      ).rejects.toThrow('zcbl704 simulated Redis read failure')
      expect(readFailure).toHaveBeenCalled()
    } finally {
      readFailure.mockRestore()
    }
  })
})

describe('every other lane is unchanged', () => {
  it('a signed-in cookie with no portable header is still the session lane, policy or not', async () => {
    expect(await resolveNativeToolUser({ request: request(), localsUserId: COOKIE_USER })).toEqual({
      userId: COOKIE_USER,
      auth: 'session'
    })
    expect(
      await resolveNativeToolUser({
        request: request({}, '/api/controls/use'),
        localsUserId: COOKIE_USER,
        portableSkillPolicy: PORTABLE_SKILL_SCOPED_EXECUTION
      })
    ).toEqual({ userId: COOKIE_USER, auth: 'session' })
  })

  it('the service lane keeps its place ahead of the portable check', async () => {
    const { token } = await mintPortable(['artifacts'])
    const auth = await resolveNativeToolUser({
      request: request({
        'x-batshit-service-token': SERVICE_TOKEN,
        'x-batshit-user-id': USER,
        [PORTABLE_SKILL_TOKEN_HEADER]: token
      })
    })
    expect(auth).toEqual({ userId: USER, auth: 'service' })
  })

  it('the agent lane keeps its place first', async () => {
    await redis.createAgent({
      id: 'agent-zcbl704',
      user_id: USER,
      displayName: 'zcbl704',
      agentType: 'api',
      primary_model_provider: 'anthropic',
      primary_model_name: 'claude-sonnet-4-5'
    } as any)
    const run = await mintRunCredential({
      userId: USER,
      agentId: 'agent-zcbl704',
      sessionId: 'sess-zcbl704',
      runtime: 'codex'
    } as any)
    const { token } = await mintPortable(['artifacts'])
    const auth = await resolveNativeToolUser({
      request: request({ [AGENT_RUN_CREDENTIAL_HEADER]: run.token, [PORTABLE_SKILL_TOKEN_HEADER]: token })
    })
    expect(auth?.auth).toBe('agent')
  })

  it('the n8n callback lane keeps its place ahead of the portable check', async () => {
    const callback = await createN8nSseCallbackToken({
      sessionId: 'sess-zcbl704',
      messageId: 'msg-zcbl704',
      userId: USER
    })
    const { token } = await mintPortable(['artifacts'])
    const auth = await resolveNativeToolUser({
      request: request({
        [N8N_NATIVE_TOOL_CALLBACK_TOKEN_HEADER]: callback.token,
        [PORTABLE_SKILL_TOKEN_HEADER]: token
      }),
      payload: { sessionId: 'sess-zcbl704', messageId: 'msg-zcbl704' }
    })
    expect(auth).toMatchObject({ userId: USER, auth: 'n8n-callback' })
  })

  it('still returns null for a request with no credential of any kind', async () => {
    expect(await resolveNativeToolUser({ request: request() })).toBeNull()
  })
})
