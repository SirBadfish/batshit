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
 * resolver here is real and only `useControl` is mocked — except in the BL-81 block, which
 * runs the real `useControl` too (with only the skill registry's disk write mocked), because
 * its claims are about what a control DOES for a delegated run.
 *
 * It is a route-level test on purpose. A caller does not see `resolveNativeToolUser` return
 * `null`; it sees a status code and a body, and a fall-through bug would show up as a 200.
 */

const mocks = vi.hoisted(() => ({
  useControl: vi.fn(),
  /** The registry's own `useControl`, for the BL-81 tests that must run the real control. */
  realUseControl: null as null | ((options: any) => Promise<any>),
  upsertSkill: vi.fn(),
  /** What the (mocked) artifacts service lists for the user; the BL-81 artifact tests fill it. */
  artifacts: [] as any[]
}))

vi.mock('$lib/server/services/fabricRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/fabricRegistry')>()
  mocks.realUseControl = actual.useControl
  return { ...actual, useControl: mocks.useControl }
})

// BL-81: the real `sys.skill.save` runs below, and the real `upsertSkill` writes the skill under
// the home folder. Everything else in the skill registry stays real.
vi.mock('$lib/server/services/skillRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/skillRegistry')>()),
  upsertSkill: (...args: any[]) => mocks.upsertSkill(...args)
}))

// BL-81: the real registry lists the user's artifacts to build its dynamic controls, and
// `ArtifactsService` reaches the Redis client through a private method the default lane's fake
// does not offer, so the listing comes from `mocks.artifacts` on both lanes (empty unless a
// test puts an artifact there).
vi.mock('$lib/server/artifacts/artifactsService', () => ({
  ArtifactsService: class {
    async listByUser() {
      return mocks.artifacts
    }
  }
}))

import { POST } from './+server'

useRedisTestServer()

const SERVICE_TOKEN = 'test-service-token-0123456789abcdef0123456789abcdef'
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

async function mintRun(overrides: Record<string, unknown> = {}) {
  return await mintRunCredential({
    userId: USER,
    agentId: COOPER,
    sessionId: 'sess-1',
    runtime: 'codex',
    ...overrides
  } as any)
}

describe('/api/controls/use on the agent lane', () => {
  it('marks only an authenticated, resolved memory control response as non-retainable', async () => {
    const { token } = await mintRun()
    mocks.useControl.mockResolvedValue({ ...OK_RESULT, controlId: 'sys.memory.search' })
    const memory = await POST({
      request: request({ controlId: 'sys.memory.search', input: { query: 'one' } },
        { [AGENT_RUN_CREDENTIAL_HEADER]: token }),
      locals: {}
    } as any)
    expect(memory.status).toBe(200)
    expect(memory.headers.get('x-batshit-memory-no-retain')).toBe('1')
    expect(memory.headers.get('x-batshit-tool-text-max-bytes')).toBe('8000')
    expect(memory.headers.get('x-batshit-tool-text-budget-source')).toBe('codex-fallback')

    const mismatched = await POST({
      request: request({ controlId: 'sys.dm.read', input: {} },
        { [AGENT_RUN_CREDENTIAL_HEADER]: token }),
      locals: {}
    } as any)
    expect(mismatched.headers.get('x-batshit-memory-no-retain')).toBeNull()

    const service = await POST({
      request: request({ controlId: 'sys.memory.search', input: { query: 'one' } }, serviceHeaders()),
      locals: {}
    } as any)
    expect(service.headers.get('x-batshit-memory-no-retain')).toBeNull()
  })

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

  it('runs Fetch Zip only with the credential snapshot, ignoring a forged body toggle', async () => {
    const disabled = await mintRun()
    const refused = await POST({
      request: request(
        { controlId: 'sys.zip.fetch', input: { zipId: 'zip_probe' }, fetchZipAllowed: true },
        { [AGENT_RUN_CREDENTIAL_HEADER]: disabled.token }
      ),
      locals: {}
    } as any)
    expect(refused.status).toBe(403)
    expect((await refused.json()).error.code).toBe('CONTROL_NOT_ALLOWED')
    expect(mocks.useControl).not.toHaveBeenCalled()

    const enabled = await mintRun({ fetchZipAllowed: true })
    mocks.useControl.mockResolvedValueOnce({ ...OK_RESULT, controlId: 'sys.zip.fetch' })
    const accepted = await POST({
      request: request(
        { controlId: 'sys.zip.fetch', input: { zipId: 'zip_probe' } },
        { [AGENT_RUN_CREDENTIAL_HEADER]: enabled.token }
      ),
      locals: {}
    } as any)
    expect(accepted.status).toBe(200)
    expect(accepted.headers.get('x-batshit-tool-page-kind')).toBe('fetch-zip')
    expect(mocks.useControl).toHaveBeenCalledWith(
      expect.objectContaining({ controlId: 'sys.zip.fetch', agentId: COOPER })
    )
  })

  it('cannot mint Fetch Zip authority onto a managed CLI Worker', async () => {
    const workerOptions = {
      userId: USER,
      agentId: 'subagent_cli_worker_agent_cooper_1',
      sessionId: 'sess-1',
      runtime: 'codex' as const,
      delegated: true,
      scopeAgentId: 'worker_cooper_1',
      allowedControlIds: ['sys.zip.fetch']
    }
    await expect(mintRunCredential({
      ...workerOptions,
      fetchZipAllowed: true
    })).rejects.toThrow(/cannot be granted Fetch Zip/)

    const worker = await mintRunCredential(workerOptions)
    const response = await POST({
      request: request(
        { controlId: 'sys.zip.fetch', input: { zipId: 'zip_probe' }, fetchZipAllowed: true },
        { [AGENT_RUN_CREDENTIAL_HEADER]: worker.token }
      ),
      locals: {}
    } as any)
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe('CONTROL_NOT_ALLOWED')
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
      delegated: true,
      scopeAgentId: 'worker_cooper_1',
      allowedControlIds: []
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

/* -------------------------------------------------------------------------- *
 * BL-81 — a delegated run may use exactly what its DCM index offers it, and nothing more.
 *
 * A Subagent or Worker run on a managed CLI lane holds a credential naming its per-run runtime
 * id (`agentId`), the Subagent whose artifact allowlists apply (`scopeAgentId`, BL-75), and the
 * control ids its DCM index offered it (`allowedControlIds`). Before BL-81 this route checked
 * none of that, so a Subagent could call any Fabric control, `sys.skill.save` included (it made
 * a skill on for its runtime id: nobody), although SA-064 keeps the Fabric control plane
 * primary-only.
 *
 * Every credential here is minted for real. Where the claim is about what the control DOES,
 * the real `useControl` runs behind the real resolver; only the disk write is mocked.
 * -------------------------------------------------------------------------- */

describe('BL-81 — a delegated run on /api/controls/use', () => {
  const RUNTIME = 'subagent_cli_research_bot'
  const SCOPE = 'research_bot'
  const OFFERED = ['sys.zip.fetch', 'use.artifact.*']

  async function mintDelegated(allowedControlIds: string[] = OFFERED) {
    await redis.json.set(`subagent:${SCOPE}`, '$', {
      id: SCOPE,
      user_id: USER,
      displayName: 'Research Bot'
    } as never)
    return await mintRunCredential({
      userId: USER,
      agentId: RUNTIME,
      sessionId: 'sess-1',
      runtime: 'codex',
      delegated: true,
      scopeAgentId: SCOPE,
      allowedControlIds
    })
  }

  function useTheRealRegistry() {
    mocks.useControl.mockImplementation((options: any) => mocks.realUseControl!(options))
  }

  async function call(
    controlId: string,
    input: Record<string, unknown>,
    token: string,
    extra: Record<string, unknown> = {}
  ) {
    return await POST({
      request: request({ controlId, input, ...extra }, { [AGENT_RUN_CREDENTIAL_HEADER]: token }),
      locals: {}
    } as any)
  }

  /** A published, run-only artifact whose Agent Use list names `allowlist`. */
  async function publishRunOnlyArtifact(allowlist: string[]) {
    const artifact = {
      id: 'artifact_zbcontrols',
      user_id: USER,
      name: 'zbcontrols Artifact',
      slug: 'zbcontrols-artifact',
      mode: 'published',
      zone: 'panel',
      agent_use_enabled: true,
      agent_allowlist: allowlist,
      metadata: { run_only: true },
      created_at: '2026-09-22T00:00:00.000Z',
      updated_at: '2026-09-22T00:00:00.000Z'
    }
    await redis.json.set(`artifact:${artifact.id}`, '$', artifact as never)
    mocks.artifacts.splice(0, mocks.artifacts.length, artifact)
  }

  beforeEach(() => {
    mocks.artifacts.length = 0
  })

  it('hands useControl the run, its Subagent, and the list its credential carries', async () => {
    const { token, credentialId } = await mintDelegated()

    const response = await call('use.artifact.example', {}, token)

    expect(mocks.useControl).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'agent',
        credentialId,
        // Who authenticated: the run. The identity gate, the risk gate, the handler, the audit
        // and the step label all keep this per-run id.
        agentId: RUNTIME,
        // Whose artifact allowlists apply: the Subagent.
        scopeAgentId: SCOPE,
        delegatedRun: true,
        // What it may use: exactly what its DCM offered it, off the credential.
        delegatedAllowedControlIds: OFFERED
      })
    )
    // The Execution Viewer label shows only when it differs from the chat's agent, so it keeps
    // the per-run id: a Subagent id can equal a primary's.
    expect(await response.json()).toMatchObject({ actingAgentId: RUNTIME })
  })

  it('hands a primary run, and the service lane, no list at all', async () => {
    const { token } = await mintRun()
    await call('sys.skill.save', {}, token)
    expect(mocks.useControl.mock.calls[0]?.[0]).toMatchObject({ agentId: COOPER, delegatedRun: false })
    expect(mocks.useControl.mock.calls[0]?.[0].delegatedAllowedControlIds).toBeUndefined()
    expect(mocks.useControl.mock.calls[0]?.[0].scopeAgentId).toBeUndefined()

    await POST({
      request: request({ controlId: 'sys.skill.save', input: {}, agentId: COOPER }, serviceHeaders()),
      locals: {}
    } as any)
    expect(mocks.useControl.mock.calls[1]?.[0]).toMatchObject({ actorType: 'service', agentId: COOPER })
    expect(mocks.useControl.mock.calls[1]?.[0].delegatedAllowedControlIds).toBeUndefined()
  })

  it('refuses a Subagent sys.skill.save and sys.skill.import, and keeps AGENT_IDENTITY_REQUIRED first for the DM family', async () => {
    useTheRealRegistry()
    // The worst case for the DM half: a primary agent stored at the SAME id as the Subagent
    // (both ids are `sanitizeId(displayName)`), with Agent DMs on.
    await redis.createAgent({
      id: SCOPE,
      user_id: USER,
      displayName: 'Research Bot',
      agentType: 'api',
      primary_model_provider: 'anthropic',
      primary_model_name: 'claude-sonnet-4-5',
      dms_enabled: true
    } as any)
    const { token } = await mintDelegated()

    const save = await call(
      'sys.skill.save',
      { commandName: 'zbcontrols-probe', skill: { markdown: '# Probe' } },
      token
    )
    expect(save.status).toBe(403)
    expect((await save.json()).error).toMatchObject({
      code: 'CONTROL_NOT_ALLOWED',
      message: expect.stringContaining('Subagent or Worker')
    })
    expect(mocks.upsertSkill).not.toHaveBeenCalled()
    expect(await redis.json.get(`slash_command:${USER}:zbcontrols_probe`)).toBeNull()

    const imported = await call('sys.skill.import', { source: 'https://github.com/example/skills' }, token)
    expect(imported.status).toBe(403)
    expect((await imported.json()).error.code).toBe('CONTROL_NOT_ALLOWED')

    const dm = await call('sys.dm.list', {}, token)
    expect(dm.status).toBe(403)
    expect((await dm.json()).error).toMatchObject({
      code: 'AGENT_IDENTITY_REQUIRED',
      message: expect.stringContaining('Subagent or Worker')
    })

    // The audit keeps both answers: who authenticated (the run) and whose allowlists applied.
    const audits = await Promise.all(
      (await redis.keys(`control_audit:${USER}:*`)).map((key) => redis.json.get(key))
    )
    const byControl = (controlId: string) => audits.find((entry: any) => entry?.controlId === controlId)
    expect(byControl('sys.skill.save')).toMatchObject({
      actorType: 'agent',
      agentId: RUNTIME,
      scopeAgentId: SCOPE,
      credentialId: expect.stringMatching(/^arc_/),
      success: false,
      errorCode: 'CONTROL_NOT_ALLOWED'
    })
    expect(byControl('sys.dm.list')).toMatchObject({ agentId: RUNTIME, errorCode: 'AGENT_IDENTITY_REQUIRED' })
  })

  it('refuses Fetch Zip for a CLI delegated run even if its older control list offered it', async () => {
    useTheRealRegistry()
    // A dry run proves the scope decision on both lanes without the zip store (the default
    // lane's Redis fake has no `getZip`); the unit suite runs the real handler.
    const dryRun = { dryRun: true }

    const offered = await mintDelegated(OFFERED)
    const allowed = await call('sys.zip.fetch', { zipId: 'zip_missing' }, offered.token, dryRun)
    expect(allowed.status).toBe(403)
    expect((await allowed.json()).error.code).toBe('CONTROL_NOT_ALLOWED')

    const artifactsOnly = await mintDelegated(['use.artifact.*'])
    const refused = await call('sys.zip.fetch', { zipId: 'zip_missing' }, artifactsOnly.token, dryRun)
    expect(refused.status).toBe(403)
    expect((await refused.json()).error.code).toBe('CONTROL_NOT_ALLOWED')
  })

  it('uses an artifact allowlisted for its Subagent, and not one allowlisted for someone else', async () => {
    useTheRealRegistry()
    const { token } = await mintDelegated()
    const dryRun = { dryRun: true }

    await publishRunOnlyArtifact([SCOPE])
    const allowed = await call('use.artifact.zbcontrols-artifact', {}, token, dryRun)
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toMatchObject({ success: true, controlId: 'use.artifact.zbcontrols-artifact' })

    await publishRunOnlyArtifact([COOPER])
    const refused = await call('use.artifact.zbcontrols-artifact', {}, token, dryRun)
    expect(refused.status).toBe(403)
    expect((await refused.json()).error.code).toBe('CONTROL_NOT_ALLOWED')
  })

  it('allows nothing on a delegated credential minted before BL-81', async () => {
    useTheRealRegistry()
    const { token, credentialId } = await mintDelegated(OFFERED)
    // Rewrite the record in the shape every delegated credential had before this change.
    const key = `agent_run_credential:${credentialId}`
    const { allowedControlIds: _dropped, ...before } = (await redis.json.get(key)) as Record<string, unknown>
    await redis.json.set(key, '$', before as never)

    const response = await call('sys.zip.fetch', { zipId: 'zip_missing' }, token, { dryRun: true })
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe('CONTROL_NOT_ALLOWED')
  })

  it('leaves a primary run\'s own sys.skill.save exactly as it was', async () => {
    useTheRealRegistry()
    const { token } = await mintRun()
    mocks.upsertSkill.mockResolvedValueOnce({
      id: 'cooper_probe',
      name: 'cooper_probe',
      displayName: 'cooper_probe',
      description: '',
      standards_status: 'valid',
      trust_level: 'trusted',
      dependencies: [],
      metadata: {},
      allowed_tools: []
    })

    const saved = await call('sys.skill.save', { commandName: 'cooper-probe', skill: { markdown: '# Mine' } }, token)

    expect(saved.status).toBe(200)
    expect(await redis.json.get(`slash_command:${USER}:cooper_probe`)).toMatchObject({
      enabled_agent_ids: [COOPER]
    })
  })
})
