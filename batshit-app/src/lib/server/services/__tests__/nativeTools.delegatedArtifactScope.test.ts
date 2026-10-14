import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * BL-186: an API Subagent or Worker run's artifact tools judge allowlists by the run's OWN id.
 *
 * The runner starts an API Subagent in process with `agentId` = the PARENT (the id the identity
 * gate, approvals and the audit keep) and `scopeAgentId` = the Subagent, the id its DCM index is
 * built for (`buildManagedSubagentDynamicInfo`, `controlAgentId: subagent.id`). The broker's
 * search and use judged artifact allowlists by the parent, so an artifact allowed only for the
 * Subagent was listed in its DCM and then refused, and one allowed only for the parent was
 * hidden from the DCM but ran. Drives the REAL `buildMode3NativeTools` broker against the REAL
 * `findControls` / `useControl`; only the artifact list is stubbed, the way `fabricRegistry.test.ts`
 * does it.
 */

const artifacts = vi.hoisted(() => ({ list: [] as any[] }))

vi.mock('$lib/server/artifacts/artifactsService', () => ({
  ArtifactsService: vi.fn(function MockArtifactsService(this: Record<string, unknown>) {
    Object.assign(this, {
      listByUser: vi.fn(async () => artifacts.list),
      getAccessible: vi.fn(async () => null),
      getOwned: vi.fn(async () => null)
    })
  })
}))

const { nativeToolService } = await import('../nativeTools')
const fabricRegistry = await import('../fabricRegistry')
const { redis } = await import('$lib/server/redis')

const USER = 'zbctx_user'
const PARENT = 'zbctx_parent'
const SUBAGENT = 'zbctx_research_bot'

/** A published, run-only artifact whose Agent Use list names `allowlist` ('all': every agent). */
function runOnlyArtifact(slug: string, allowlist: string[] | 'all') {
  return {
    id: `artifact_${slug.replace(/-/g, '_')}`,
    user_id: USER,
    name: `Artifact ${slug}`,
    slug,
    mode: 'published',
    zone: 'panel',
    agent_use_enabled: true,
    ...(allowlist === 'all' ? { agent_access_scope: 'all', agent_allowlist: [] } : { agent_allowlist: allowlist }),
    metadata: { run_only: true },
    created_at: '2026-09-25T00:00:00.000Z',
    updated_at: '2026-09-25T00:00:00.000Z'
  }
}

/** The broker an API run gets: artifact tools on, the delegated flags the runner passes. */
async function brokerFor(context: { agentId: string; scopeAgentId?: string }) {
  return (await brokerSetFor(context)).tools as Record<string, any>
}

async function brokerSetFor(context: { agentId: string; scopeAgentId?: string }) {
  return await nativeToolService.buildMode3NativeTools({
    userId: USER,
    sessionId: 'zbctx_session',
    agentId: context.agentId,
    ...(context.scopeAgentId ? { scopeAgentId: context.scopeAgentId } : {}),
    providerSettings: { nativeTools: { artifactRuntimeEnabled: true, batshitToolsEnabled: true } },
    toolApprovalMode: 'off',
    allowArtifactRuntimeTools: true,
    allowFabricControlTools: false,
    memoryControlsEnabled: false,
    dmControlsEnabled: false,
    scheduleControlsEnabled: false,
    judgeControlsEnabled: false
  } as any)
}

async function listedArtifactRefs(tools: Record<string, any>) {
  const found = await tools.native_batshit_tool_search.execute({ family: 'artifact', query: 'artifact', limit: 20 })
  return (found.results ?? []).map((entry: any) => entry.ref).sort()
}

async function dryRun(tools: Record<string, any>, slug: string) {
  return tools.native_batshit_tool_use.execute({ ref: `artifact:use.artifact.${slug}`, input: {}, dryRun: true })
}

beforeEach(() => {
  artifacts.list = [
    runOnlyArtifact('subagent-only', [SUBAGENT]),
    runOnlyArtifact('parent-only', [PARENT]),
    runOnlyArtifact('open-to-all', 'all')
  ]
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('an API Subagent run judges artifact allowlists by its own id (BL-186)', () => {
  it('lists and runs the artifact allowed for the Subagent, the way its DCM offers it', async () => {
    const tools = await brokerFor({ agentId: PARENT, scopeAgentId: SUBAGENT })

    expect(await listedArtifactRefs(tools)).toEqual([
      'artifact:use.artifact.open-to-all',
      'artifact:use.artifact.subagent-only'
    ])
    const allowed = await dryRun(tools, 'subagent-only')
    expect(allowed.success, JSON.stringify(allowed)).toBe(true)
  })

  it('refuses the artifact allowed only for its parent', async () => {
    const tools = await brokerFor({ agentId: PARENT, scopeAgentId: SUBAGENT })

    const refused = await dryRun(tools, 'parent-only')
    expect(refused.success).toBe(false)
    expect(JSON.stringify(refused)).not.toContain('"dryRun":true')
  })

  it('keeps the parent as the acting agent and the Subagent as the scope on the call', async () => {
    const useSpy = vi.spyOn(fabricRegistry, 'useControl')
    const tools = await brokerFor({ agentId: PARENT, scopeAgentId: SUBAGENT })

    await dryRun(tools, 'subagent-only')

    expect(useSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: PARENT,
        actorType: 'in-process',
        delegatedRun: true,
        scopeAgentId: SUBAGENT,
        delegatedAllowedControlIds: ['use.artifact.*']
      })
    )
  })

  it('changes nothing for a primary turn, which has no scope id', async () => {
    const useSpy = vi.spyOn(fabricRegistry, 'useControl')
    const tools = await brokerFor({ agentId: PARENT })

    expect(await listedArtifactRefs(tools)).toEqual([
      'artifact:use.artifact.open-to-all',
      'artifact:use.artifact.parent-only'
    ])
    expect((await dryRun(tools, 'parent-only')).success).toBe(true)
    expect((await dryRun(tools, 'subagent-only')).success).toBe(false)
    for (const [options] of useSpy.mock.calls) {
      expect(options.delegatedRun).toBeUndefined()
      expect(options.scopeAgentId).toBeUndefined()
    }
  })
})

/**
 * The dispatch route (`/api/native-tools/dispatch`) hands a delegated credential's `scopeAgentId`
 * to `useControl` beside `delegatedRun`, on both of its control doors, and the scope id never
 * leaks into a control's payload (it is broker plumbing, like `delegatedRun`).
 */
describe('the dispatch doors carry the scope id beside delegatedRun (BL-186)', () => {
  beforeEach(async () => {
    await redis.set(`agent:${PARENT}`, {
      id: PARENT,
      user_id: USER,
      provider_specific_settings: { nativeTools: { artifactRuntimeEnabled: true, batshitToolsEnabled: true } }
    })
  })

  afterEach(async () => {
    await redis.del(`agent:${PARENT}`)
  })

  const context = { session_id: 'zbctx_session', agent_id: PARENT, mode: 'mode1', actor_type: 'primary' }

  it('forwards the scope id on batshit_tool_use and artifact_use, and keeps it out of the payload', async () => {
    const useSpy = vi.spyOn(fabricRegistry, 'useControl')

    await nativeToolService.dispatchNativeAutomationPackAction({
      userId: USER,
      action: 'batshit_tool_use',
      payloadInput: { ref: 'artifact:use.artifact.subagent-only', input: { prompt: 'hi' } },
      context,
      actorType: 'agent',
      // The authenticated helper supplies the stored owner separately from audit identity.
      processOwner: { userId: USER, kind: 'subagent', id: SUBAGENT },
      delegatedRun: true,
      scopeAgentId: SUBAGENT
    })
    await nativeToolService.dispatchNativeAutomationPackAction({
      userId: USER,
      action: 'artifact_use',
      payloadInput: { control_id: 'use.artifact.subagent-only', prompt: 'hi' },
      context,
      actorType: 'agent',
      // The authenticated helper supplies the stored owner separately from audit identity.
      processOwner: { userId: USER, kind: 'subagent', id: SUBAGENT },
      delegatedRun: true,
      scopeAgentId: SUBAGENT
    })

    expect(useSpy).toHaveBeenCalledTimes(2)
    for (const [options] of useSpy.mock.calls) {
      expect(options).toMatchObject({ delegatedRun: true, scopeAgentId: SUBAGENT, agentId: PARENT })
      expect(options.input).toEqual({ prompt: 'hi' })
    }
  })

  it('never takes a scope id from the caller\'s search input', async () => {
    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: USER,
      action: 'batshit_tool_search',
      payloadInput: { family: 'artifact', query: 'artifact', controlScopeAgentId: SUBAGENT, scopeAgentId: SUBAGENT },
      context,
      actorType: 'session'
    })

    expect(result.success, JSON.stringify(result)).toBe(true)
    const refs = ((result.data as any)?.results ?? []).map((entry: any) => entry.ref).sort()
    expect(refs).toEqual(['artifact:use.artifact.open-to-all', 'artifact:use.artifact.parent-only'])
  })

  it('sends no scope id, and none in the payload, for a primary call', async () => {
    const useSpy = vi.spyOn(fabricRegistry, 'useControl')

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: USER,
      action: 'batshit_tool_use',
      payloadInput: { ref: 'artifact:use.artifact.parent-only', input: { prompt: 'hi' }, dryRun: true },
      context,
      actorType: 'session'
    })

    expect(result.success, JSON.stringify(result)).toBe(true)
    const [options] = useSpy.mock.calls[0]
    expect(options.delegatedRun).toBe(false)
    expect(options.scopeAgentId ?? null).toBeNull()
    expect(options.input).toEqual({ prompt: 'hi' })
  })
})

/**
 * Review of the batch: the SDK approval policy (`needsBrokerRiskApproval`) must judge the same
 * artifact the call will run, so a delegated run's risk profile is read by its own id too.
 * Every generated artifact tool is `safe` today, so a stand-in `resolveControlRiskProfile` plays a
 * risky artifact with the real rule's shape: visible (and so risky) only to the id it names.
 */
describe('the approval policy judges a delegated run by its own id (BL-186 review)', () => {
  function riskyFor(owner: string) {
    return vi.spyOn(fabricRegistry, 'resolveControlRiskProfile').mockImplementation(async (options: any) =>
      options.agentId === owner
        ? { controlId: options.controlId, controlTitle: 'Risky probe', riskLevel: 'confirm', scopeKey: null }
        : null
    )
  }

  it('raises the approval for a risky artifact allowed only for the Subagent', async () => {
    const spy = riskyFor(SUBAGENT)
    const { toolApprovals } = await brokerSetFor({ agentId: PARENT, scopeAgentId: SUBAGENT })

    const answer = await toolApprovals.native_batshit_tool_use({ ref: 'artifact:use.artifact.subagent-only', input: {} })

    expect(answer).toBe('user-approval')
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ agentId: SUBAGENT }))
  })

  it('raises none for one allowed only for its parent, a call the run will be refused', async () => {
    riskyFor(PARENT)
    const { toolApprovals } = await brokerSetFor({ agentId: PARENT, scopeAgentId: SUBAGENT })

    expect(await toolApprovals.native_batshit_tool_use({ ref: 'artifact:use.artifact.parent-only', input: {} })).toBeUndefined()
  })

  it('judges a primary turn by its own agent, as before', async () => {
    riskyFor(PARENT)
    const { toolApprovals } = await brokerSetFor({ agentId: PARENT })

    expect(await toolApprovals.native_batshit_tool_use({ ref: 'artifact:use.artifact.parent-only', input: {} })).toBe('user-approval')
  })
})
