import { fileURLToPath } from 'node:url'
import { createSettingsRedisAdmission } from '$lib/test-utils/settingsRedisAdmission'
// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AbortError } from 'redis'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { defaultAppActionsPolicy, isAppActionsNativePolicyResponse, type AppActionsPolicy } from '$lib/appActions/settings/managementContract'
import { nativePolicyResponse, saveNativePolicy, portableGrantResponse, savePortableGrant, readNativePolicyAuthority, readPortableAppActionsAuthority, SAVE_NATIVE_APP_ACTIONS_POLICY_SCRIPT } from './authority'
import { createConditionalSettingsStore, settingsFamilyRevision, CONDITIONAL_SETTINGS_WRITE_SCRIPT, type McpTargetSnapshot } from './conditionalAgentSettings'
import { createPortableSkillToken, rotatePortableSkillToken, revokePortableSkillToken, updatePortableSkillToken, validatePortableSkillToken } from '../../portableSkillTokens'
import { withSettingsRestoreFence, withSettingsRecordReplacement } from './lifecycle'
import { appActionsHumanRoute } from './humanRoutes'
import { createSettingsOperationRegistry } from './operationRegistry'
import { createSettingsManagementReports } from './managementReports'
import { createSettingsChanges } from './changeOperations'
import { registerStreamAbort, clearStreamAbort } from '../../streamAbortRegistry'
import { POST as findControlsRoute } from '../../../../../routes/api/controls/find/+server'
import { POST as useControlsRoute } from '../../../../../routes/api/controls/use/+server'
import { admittedAgentSettings, managedSettingsStore } from './managedStore'
import { readInstructionsSnapshot } from '$lib/server/instructionsGuard'
import { GET as readOperationRoute } from '../../../../../routes/api/app/settings/operations/[operationId]/+server'
import { POST as decideOperationRoute } from '../../../../../routes/api/app/settings/operations/[operationId]/decision/+server'
import { SET_SLASH_COMMAND_AGENT_ACCESS_SCRIPT, captureSlashCommandWriteBasis, saveSlashCommandRecord } from '../../slashCommandRevision'
import { newSlashCommandRevision, slashCommandRevisionKey, beginSlashCommandWrite } from '../../slashCommandRevisionProtocol'
import { DELETE_AGENT_WITH_WHITEBOARDS_SCRIPT } from '$lib/server/whiteboardScripts'
import { commandEnabledForAgent } from '../../slashCommandCapabilities'
import { mcpGatewayService } from '../../mcpGatewayService'
import { apiKeyService } from '$lib/services/apiKey.server'
import { apiKeyEncryption } from '$lib/services/encryption.server'
import { hashControlInput } from '../../controlApprovals'
import { hasSettingsStandingConsent } from './standingConsent'

// These assertions qualify real persistence/owner CAS. The topology check is isolated
// because Vitest workers are intentionally unsupported production management actors.
// This is not live route authentication, native Stop or managed-helper qualification.
vi.mock('../runtime', () => ({ requireAppActionTopology() {} }))
const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
const strictAdmission = createSettingsRedisAdmission(redis)
useRedisTestServer({ beforeCleanupAdmission: strictAdmission.beforeCleanupAdmission })
afterAll(() => strictAdmission.close())
afterAll(async () => { if (REAL) await redis.disconnect() })
const USER = 'p2_owner'
let fixtureSequence = 0
let ACTOR = 'p2_actor_0'
let TARGET = 'p2_target_0'
const CREATED = '2026-10-04T00:00:00.000Z'
const store = createConditionalSettingsStore(operation => redis.execute(operation), error => error instanceof AbortError, { captureIncarnation: true })
function policy(): AppActionsPolicy {
  return { ...defaultAppActionsPolicy(), enabled: true, scope: { mode: 'all', subjects: [], except: [] } }
}
async function configure(value = policy()) {
  const baseline = await nativePolicyResponse(USER, ACTOR)
  return saveNativePolicy(USER, ACTOR, { expectedGeneration: baseline.generation, expectedSubjectRevision: baseline.subjectRevision, policy: value })
}
async function portable(lifetimeMs = 60_000, grantPolicy = policy()) {
  const token = await createPortableSkillToken({ userId: USER, families: ['app-actions'] })
  const initial = await portableGrantResponse(USER, token.record.id)
  const saved = await savePortableGrant(USER, token.record.id, { expectedAuthorityGeneration: initial.authorityGeneration,
    grant: { policy: grantPolicy, expiresAt: new Date(Date.now() + lifetimeMs).toISOString() } })
  const validation = await validatePortableSkillToken(token.token)
  if (!validation.valid) throw new Error('fixture token did not authenticate')
  return { token, saved, context: { userId: USER, actorType: 'portable-skill',
    portableSettingsActor: { tokenId: token.record.id, authorityGeneration: saved.authorityGeneration } } }
}
/** Read only the actual finite full-report response used by the new cases. */
function mcpProofPage(value: unknown) {
  if (!value || typeof value !== 'object' || !('reportId' in value) || typeof value.reportId !== 'string' ||
    !('bootNamespace' in value) || typeof value.bootNamespace !== 'string' || !('report' in value) || !value.report ||
    typeof value.report !== 'object' || !('rows' in value.report) || !Array.isArray(value.report.rows) || value.report.rows.length !== 1) throw new Error('The actual complete report is unavailable.')
  const row = value.report.rows[0]
  if (!row || typeof row !== 'object' || typeof row.candidateId !== 'string' || typeof row.gatewayId !== 'string') throw new Error('The actual assigned source is unavailable.')
  return { reportId: value.reportId, bootNamespace: value.bootNamespace, report: { rows: [{ candidateId: row.candidateId, gatewayId: row.gatewayId }] } }
}
describe.runIf(REAL)('P2 actual Redis policy, token and typed Settings owners', () => {
  beforeEach(async () => {
    fixtureSequence++
    ACTOR = `p2_actor_${fixtureSequence}`
    TARGET = `p2_target_${fixtureSequence}`
    a6Targets = { subjects: [{ kind: 'primary', id: TARGET }] }
    a6Report = { targets: a6Targets, focus: ['agent.instructions'] }
    await redis.createAgent({ id: ACTOR, user_id: USER, agentType: 'api', displayName: 'Actor', created_at: CREATED })
    await redis.createAgent({ id: TARGET, user_id: USER, agentType: 'api', displayName: 'Target', created_at: CREATED,
      memory_linger_turns: 2, memory_lane_budgets: { on_my_mind: 100, triggers: 200, recalled: 300 } })
  })
  const mcpCandidate = { domain: 'mcp-configuration', query: { kind: 'candidate', candidate: { kind: 'http', name: 'I1 Source',
    url: 'https://i1-source.example/mcp', evidence: { kind: 'supplied', uri: 'https://i1-source.example/docs', version: '1.2.3' } } } }
  it.each([
    ['block','block','block'], ['block','ask','block'], ['block','allow','block'],
    ['ask','block','block'], ['ask','ask','ask'], ['ask','allow','ask'],
    ['allow','block','block'], ['allow','ask','ask'], ['allow','allow','allow']
  ] as const)('full API original MCP %s + explicit no-op Zip Context %s requires %s before effects', async (mcp, contextMode, expected) => {
    const p = policy(); p.ordinaryChanges = false; p.management.mcpManagement = mcp; p.protected.contextManagement = contextMode
    await configure(p)
    await redis.json.set(`agent:${ACTOR}`, '$.custom_tool_settings', [{ tool_name: 'remote_tool', auto_zip: false, sibling: 'keep' }])
    const owner = await import('../mcp/originalTask'), turns = await import('../../streamAbortRegistry')
    const runtime = await import('./managementRuntime'), http = await import('../../n8nMCPGatewayClient')
    const stop = new AbortController(), sessionId = `positive_policy_${fixtureSequence}`, replyId = `positive_policy_reply_${fixtureSequence}`
    const identity = { userId: USER, agentId: ACTOR, sessionId }
    const session = { id: sessionId, user_id: USER, agent_id: ACTOR }
    const lookup = owner.captureP5OriginalLookup({ ...identity, signal: stop.signal })
    const turn = turns.registerSessionTurn(sessionId, 'single', replyId)
    if (!lookup || !turn.ok) throw new Error('The actual API original fixture could not register.')
    const preparation = owner.prepareP5OriginalTask(lookup, { ...identity, session, agent: await redis.json.get(`agent:${ACTOR}`), turn: turn.entry })
    if (!preparation) throw new Error('The actual API original preparation is unavailable.')
    owner.recordP5ResolvedApiScope(preparation, { gateways: [], tools: [], authority: { humanSelection: true } })
    const part = owner.bindP5ApiReplyPart(preparation, { replyId, version: 0 })
    const run = owner.associateP5ApiOriginalRun(preparation, part, { ...identity, replyId, signal: stop.signal })
    if (!run) throw new Error('The actual API run is unavailable.')
    const actualContext = { ...identity, messageId: replyId, actorType: 'in-process', p5ApiRun: run, abortSignal: stop.signal }
    const commit = vi.spyOn(mcpGatewayService, 'commitPreparedGatewaySave'), setup = vi.spyOn(http.n8nMCPGatewayClient, 'listForHeldApi')
    const before = await redis.json.get(`agent:${ACTOR}`)
    const query = { domain: 'mcp-configuration', query: { kind: 'prerequisite', candidate: mcpCandidate.query.candidate,
      target: { subject: { kind: 'primary', id: ACTOR }, membership: 'enable', zip: { toolName: 'remote_tool', autoZip: false } } } }
    try {
      if (mcp === 'block') {
        // The same real report owner refuses even the candidate BEFORE a
        // complete review can be retained; no fake held report is manufactured.
        await expect(runtime.settingsManagementReports.report(actualContext, 'native', query)).rejects.toMatchObject({ code: 'MCP_MANAGEMENT_BLOCKED' })
      } else {
        const page = mcpProofPage(await runtime.settingsManagementReports.report(actualContext, 'native', query))
        const row = page.report.rows[0]
        const input = { op: 'change', requestId: `${page.bootNamespace}:full-modes`, reportId: page.reportId, semanticId: 'mcp.workflow.configure',
          changes: { source: { candidateId: row.candidateId }, target: { subject: { kind: 'primary', id: ACTOR }, gatewayId: row.gatewayId, membership: 'enable', zip: { toolName: 'remote_tool', autoZip: false } } } }
        if (expected === 'block') await expect(runtime.prepareSettingsControl(actualContext, 'sys.app_settings.native.change', input)).rejects.toMatchObject({ code: 'MCP_PREREQUISITE_BLOCKED' })
        else {
          const prepared = await runtime.prepareSettingsControl(actualContext, 'sys.app_settings.native.change', input)
          expect(prepared?.noEffect).toBe(false)
          expect(prepared?.approvalPreview?.preview.resource).toMatchObject({ variant: 'prerequisite', intent: input.changes.target,
            target: { subject: { kind: 'primary', id: ACTOR }, changes: expect.arrayContaining([{ field: 'zip.auto_zip', label: 'remote_tool: auto_zip', before: false, after: false }]) } })
          expect(!!prepared?.standingConsent).toBe(expected === 'allow')
          const operation = runtime.settingsOperationRegistry.nativeApprovalPreview(USER, ACTOR, sessionId, input.requestId)
          expect(operation?.intentDigest).toBe(prepared?.approvalPreview?.intentDigest)
          // Repeating this exact request keeps its one retained recipe/decision.
          const repeated = await runtime.prepareSettingsControl(actualContext, 'sys.app_settings.native.change', input)
          expect(repeated?.approvalPreview?.operationId).toBe(prepared?.approvalPreview?.operationId)
        }
      }
      expect(commit).not.toHaveBeenCalled(); expect(setup).not.toHaveBeenCalled()
      expect(await redis.json.get(`mcp_gateways:${USER}`)).toBeNull()
      expect(await redis.json.get(`agent:${ACTOR}`)).toEqual(before)
      expect(owner.p5ApiPreparedGatewayFrontier(preparation)).toEqual([])
    } finally {
      commit.mockRestore(); setup.mockRestore()
      await owner.sealP5OriginalPreparation(preparation); owner.retireP5OriginalPreparation(preparation)
      turns.releaseSessionTurn(sessionId, turn.entry.turnId)
    }
  })

  it.each(['same-id-replacement', 'membership-change'] as const)('refuses actual other-target %s during Zip identity resolution before any setup/effect', async race => {
    const p = policy(); p.ordinaryChanges = false; p.management.mcpManagement = 'allow'; p.protected.contextManagement = 'allow'
    await configure(p)
    const owner = await import('../mcp/originalTask'), turns = await import('../../streamAbortRegistry')
    const runtime = await import('./managementRuntime'), discovery = await import('../../mcpGatewayDiscovery'), http = await import('../../n8nMCPGatewayClient')
    const stop = new AbortController(), sessionId = `zip_identity_${fixtureSequence}`, replyId = `zip_identity_reply_${fixtureSequence}`
    const identity = { userId: USER, agentId: ACTOR, sessionId }, session = { id: sessionId, user_id: USER, agent_id: ACTOR }
    const lookup = owner.captureP5OriginalLookup({ ...identity, signal: stop.signal }), turn = turns.registerSessionTurn(sessionId, 'single', replyId)
    if (!lookup || !turn.ok) throw new Error('The actual Zip identity fixture could not register its original.')
    const preparation = owner.prepareP5OriginalTask(lookup, { ...identity, session, agent: await redis.json.get(`agent:${ACTOR}`), turn: turn.entry })
    if (!preparation) throw new Error('The actual Zip identity preparation is unavailable.')
    owner.recordP5ResolvedApiScope(preparation, { gateways: [], tools: [], authority: { humanSelection: true } })
    const part = owner.bindP5ApiReplyPart(preparation, { replyId, version: 0 })
    const run = owner.associateP5ApiOriginalRun(preparation, part, { ...identity, replyId, signal: stop.signal })
    if (!run) throw new Error('The actual Zip identity API run is unavailable.')
    const context = { ...identity, messageId: replyId, actorType: 'in-process', p5ApiRun: run, abortSignal: stop.signal }
    const targetKey = `agent:${TARGET}`, settingsKey = `user:${USER}:settings`
    const sourceBefore = await redis.json.get(`mcp_gateways:${USER}`), globalBefore = await redis.json.get(settingsKey)
    const commit = vi.spyOn(mcpGatewayService, 'commitPreparedGatewaySave'), setup = vi.spyOn(http.n8nMCPGatewayClient, 'listForHeldApi')
    const writeTarget = vi.spyOn(managedSettingsStore, 'writeMcpTarget')
    const actualRead = managedSettingsStore.readMcpTarget!.bind(managedSettingsStore), reads: McpTargetSnapshot[] = []
    const read = vi.spyOn(managedSettingsStore, 'readMcpTarget').mockImplementation(async (...args) => {
      const snapshot = await actualRead(...args); reads.push(snapshot); return snapshot
    })
    const actualIdentity = discovery.mcpGatewayDiscovery.resolveP5ZipSettingsIdentity.bind(discovery.mcpGatewayDiscovery)
    let expectedTarget: unknown, intervened = false
    const resolve = vi.spyOn(discovery.mcpGatewayDiscovery, 'resolveP5ZipSettingsIdentity').mockImplementation(async (...args) => {
      const settingsIdentity = await actualIdentity(...args) // real retained ordinary projection, no guessed/fake alias
      expect(intervened).toBe(false); intervened = true
      if (race === 'same-id-replacement') {
        const same = await redis.json.get(targetKey)
        await withSettingsRecordReplacement(targetKey, async () => { await redis.json.set(targetKey, '$', same) })
      } else await redis.json.set(targetKey, '$.defaultMCPGateways', ['outside-added-source'])
      expectedTarget = await redis.json.get(targetKey)
      return settingsIdentity
    })
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('A report race cannot contact a gateway.') })
    try {
      await expect(runtime.settingsManagementReports.report(context, 'native', { domain: 'mcp-configuration', query: { kind: 'prerequisite', candidate: mcpCandidate.query.candidate,
        target: { subject: { kind: 'primary', id: TARGET }, membership: 'enable', zip: { toolName: 'remote_tool', autoZip: false, zipThreshold: 0 } } } })).rejects.toMatchObject({
        code: race === 'same-id-replacement' ? 'SETTINGS_LIFECYCLE_CHANGED' : 'MCP_TARGET_CHANGED'
      })
      expect(resolve).toHaveBeenCalledOnce(); expect(intervened).toBe(true); expect(reads).toHaveLength(2)
      expect(reads[0].lifecycle.records.map(([key]) => key)).toEqual([targetKey])
      expect(reads[1].lifecycle.records.map(([key]) => key)).toEqual([targetKey, settingsKey].sort())
      const prefix = reads[1].raw.slice(0, reads[0].raw.length)
      if (race === 'same-id-replacement') {
        expect(prefix).toEqual(reads[0].raw) // identical raw cannot replace the original incarnation
        expect(reads[1].lifecycle.records.find(([key]) => key === targetKey)).not.toEqual(reads[0].lifecycle.records[0])
      } else {
        expect(prefix).not.toEqual(reads[0].raw)
        expect(reads[1].lifecycle.records.find(([key]) => key === targetKey)).toEqual(reads[0].lifecycle.records[0])
      }
      expect(commit).not.toHaveBeenCalled(); expect(setup).not.toHaveBeenCalled(); expect(writeTarget).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled()
      expect(await redis.json.get(`mcp_gateways:${USER}`)).toEqual(sourceBefore); expect(await redis.json.get(settingsKey)).toEqual(globalBefore)
      expect(await redis.json.get(targetKey)).toEqual(expectedTarget)
      expect(owner.p5ApiPreparedGatewayFrontier(preparation)).toEqual([])
    } finally {
      network.mockRestore(); resolve.mockRestore(); read.mockRestore(); writeTarget.mockRestore(); commit.mockRestore(); setup.mockRestore()
      await owner.sealP5OriginalPreparation(preparation); owner.retireP5OriginalPreparation(preparation)
      turns.releaseSessionTurn(sessionId, turn.entry.turnId)
    }
  })

  it.each(['source', 'reference', 'argv', 'cwd', 'incarnation', 'capacity', 'path-capacity', 'capture-unavailable', 'inline-credential', 'remove-unavailable-key'] as const)(
    'retains frozen original STDIO A %s at the real pre-C cut without source contact', async fault => {
    const p = policy(); p.ordinaryChanges = false; p.management.mcpManagement = 'allow'; p.protected.contextManagement = 'allow'
    await configure(p)
    const owner = await import('../mcp/originalTask'), turns = await import('../../streamAbortRegistry'), runtime = await import('./managementRuntime')
    const fabric = await import('../../fabricRegistry'), stdio = await import('../../stdioMCPGatewayClient'), http = await import('../../n8nMCPGatewayClient')
    const keyNames = Array.from({ length: fault === 'capacity' ? 13 : fault === 'path-capacity' ? 0 : 1 }, (_, i) => `original-a-${fixtureSequence}-${i}`)
    const cKey = `original-c-${fixtureSequence}`, sourceId = `original-a-${fixtureSequence}`
    for (const name of [...keyNames, cKey]) await apiKeyService.store(name, 'CONTROLLED_ORIGINAL_A_VALUE', USER)
    const source = { id: sourceId, slug: sourceId, name: 'Original A', type: 'stdio', enabled: true, created_at: CREATED,
      stdioConfig: { command: process.execPath, args: [fileURLToPath(import.meta.url), ...(fault === 'inline-credential' ? ['--token=CONTROLLED_INLINE_FIXTURE_VALUE'] : [])], cwdPolicy: 'none',
        envRefs: keyNames.map((savedKeyRef, i) => ({ envVar: `ORIGINAL_${i}`, savedKeyRef })), startupTimeoutMs: 1000, toolCallTimeoutMs: 15000 } }
    const sources = fault === 'path-capacity' ? Array.from({ length: 64 }, (_, index) => ({ ...source,
      id: index === 0 ? sourceId : `${sourceId}-${index}`, slug: index === 0 ? sourceId : `${sourceId}-${index}` })) : [source]
    const sourceIds = sources.map(row => row.id)
    await redis.json.set(`mcp_gateways:${USER}`, '$', { gateways: sources } as any)
    await redis.json.set(`agent:${ACTOR}`, '$.defaultMCPGateways', sourceIds)
    const sessionId = `original_a_${fixtureSequence}`, replyId = `original_a_reply_${fixtureSequence}`, stop = new AbortController()
    const identity = { userId: USER, agentId: ACTOR, sessionId }, session = { id: sessionId, user_id: USER, agent_id: ACTOR }
    const lookup = owner.captureP5OriginalLookup({ ...identity, signal: stop.signal }), turn = turns.registerSessionTurn(sessionId, 'single', replyId)
    if (!lookup || !turn.ok) throw new Error('The genuine original-A fixture could not register.')
    const preparation = owner.prepareP5OriginalTask(lookup, { ...identity, session, agent: await redis.json.get(`agent:${ACTOR}`), turn: turn.entry })
    if (!preparation) throw new Error('The genuine original-A preparation is unavailable.')
    owner.recordP5ResolvedApiScope(preparation, { gateways: sourceIds, tools: [], authority: { humanSelection: true } })
    const part = owner.bindP5ApiReplyPart(preparation, { replyId, version: 0 })
    if (fault === 'capture-unavailable') await redis.del(`api_keys:${USER}:${keyNames[0]}`)
    await owner.captureP5ApiOriginalStdioSources(preparation) // SAME production capture; no ready/source flag
    if (fault === 'inline-credential') {
      const discovery = await import('../../mcpGatewayDiscovery')
      const observation = discovery.reserveInitialStdioObservations(preparation, [sourceId]).get(sourceId)
      expect(observation).toBeDefined()
      expect(owner.readP5InitialStdioSource(preparation, observation!)).toBeUndefined() // no argv/raw/gateway snapshot retained; do not print its value
    }
    const run = owner.associateP5ApiOriginalRun(preparation, part, { ...identity, replyId, signal: stop.signal })
    if (!run) throw new Error('Read-only A capture cannot remove the ordinary initial run.')
    const context = { ...identity, messageId: replyId, actorType: 'in-process', p5ApiRun: run, abortSignal: stop.signal }
    const remove = fault === 'remove-unavailable-key'
    const targetId = fault === 'capacity' ? TARGET : ACTOR
    const page = mcpProofPage(await runtime.settingsManagementReports.report(context, 'native', { domain: 'mcp-configuration', query: {
      kind: 'prerequisite', ...(remove ? {} : { candidate: { ...mcpCandidate.query.candidate, savedKeyRef: cKey } }),
      target: { subject: { kind: 'primary', id: targetId }, ...(remove ? { gatewayId: sourceId } : {}), membership: remove ? 'disable' : 'enable' }
    } }))
    const row = page.report.rows[0]
    const input = { op: 'change', requestId: `${page.bootNamespace}:original-a-${fault}`, reportId: page.reportId, semanticId: 'mcp.workflow.configure', changes: {
      ...(remove ? {} : { source: { candidateId: row.candidateId } }), target: { subject: { kind: 'primary', id: targetId }, gatewayId: row.gatewayId, membership: remove ? 'disable' : 'enable' }
    } }
    const prepared = await runtime.prepareSettingsControl(context, 'sys.app_settings.native.change', input)
    expect(hasSettingsStandingConsent(prepared?.standingConsent, {
      userId: USER, agentId: ACTOR, controlId: 'sys.app_settings.native.change', inputHash: hashControlInput(input)
    })).toBe(true)
    if (fault === 'reference' || remove) await redis.del(`api_keys:${USER}:${keyNames[0]}`)
    if (fault === 'incarnation') {
      const same = await redis.json.get(`mcp_gateways:${USER}`)
      await withSettingsRecordReplacement(`mcp_gateways:${USER}`, async () => { await redis.json.set(`mcp_gateways:${USER}`, '$', same) })
    }
    let sourceBefore = await redis.json.get(`mcp_gateways:${USER}`)
    const actorBefore = await redis.json.get(`agent:${ACTOR}`)
    const capacityRawBefore = fault === 'capacity' ? {
      actor: await redis.json.getRaw(`agent:${ACTOR}`, '$'), target: await redis.json.getRaw(`agent:${TARGET}`, '$')
    } : undefined
    const join = vi.spyOn(mcpGatewayService, 'joinMcpPrerequisiteFences')
    const actualOriginalJoin = owner.joinP5OriginalStdioManagement
    const originalJoin = vi.spyOn(owner, 'joinP5OriginalStdioManagement')
    let driftInjections = 0
    if (fault === 'source' || fault === 'argv' || fault === 'cwd') originalJoin.mockImplementation(async (...args) => {
      if (driftInjections === 0) {
        // First configure execution join: all C-plan refreshes have finished; no C effect began.
        expect(args[2]).toBe(true); expect(args[4]).toEqual([]); expect(args[5]).toBe(1)
        driftInjections++
        if (fault === 'source') await redis.json.set(`mcp_gateways:${USER}`, '$.gateways[0].name', 'Changed A')
        if (fault === 'argv') await redis.json.set(`mcp_gateways:${USER}`, '$.gateways[0].stdioConfig.args', ['/different/entry.cjs'])
        if (fault === 'cwd') await redis.json.set(`mcp_gateways:${USER}`, '$.gateways[0].stdioConfig.cwdPolicy', 'project')
        sourceBefore = await redis.json.get(`mcp_gateways:${USER}`) // only this deliberate external mutation
      }
      return actualOriginalJoin(...args) // same actual ticket, frame, deadline and physical owner
    })
    const commit = vi.spyOn(mcpGatewayService, 'commitPreparedGatewaySave'), setup = vi.spyOn(http.n8nMCPGatewayClient, 'listForHeldApi')
    const stdioSetup = vi.spyOn(stdio.stdioMCPGatewayClient, 'listForHeldApi'), targetWrite = vi.spyOn(managedSettingsStore, 'writeMcpTarget')
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('This pre-effect A cut cannot contact any MCP source.') })
    try {
      const result: any = await fabric.useControl({ ...context, controlId: 'sys.app_settings.native.change', input })
      expect(commit).not.toHaveBeenCalled(); expect(setup).not.toHaveBeenCalled(); expect(stdioSetup).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled()
      expect(await redis.json.get(`mcp_gateways:${USER}`)).toEqual(sourceBefore)
      if (remove) {
        expect(result).toMatchObject({ success: true, result: { status: 'completed' } }); expect(targetWrite).toHaveBeenCalledOnce()
        expect((await redis.json.get(`agent:${ACTOR}`) as any).defaultMCPGateways).toEqual([])
        // Known removal is a real save; no SDK/canonical completion is forged.
        await expect(owner.takeP5ApiVerifiedContinuation(preparation)).resolves.toBeUndefined()
      } else {
        expect(result).toMatchObject({ success: true, result: { status: 'unknown_outcome', resourceOutcomes: [{ variant: 'prerequisite', saved: 'not_requested', stages: { registry: 'not_requested', verification: 'not_started' } }] } }); expect(targetWrite).not.toHaveBeenCalled()
        expect(await redis.json.get(`agent:${ACTOR}`)).toEqual(actorBefore)
        if (fault === 'source' || fault === 'argv' || fault === 'cwd') {
          expect(driftInjections).toBe(1); expect(originalJoin).toHaveBeenCalledOnce()
          await expect(originalJoin.mock.results[0].value).rejects.toEqual(new Error('The exact prerequisite observation was refused.'))
        }
        if (fault === 'capacity') {
          const reason = 'The complete original A+C cut exceeds its existing capacity.'
          const overflow = join.mock.results.findIndex(result => result.type === 'throw' && result.value instanceof Error && result.value.message === reason)
          expect(overflow).toBeGreaterThan(-1)
          const keys = new Set(join.mock.calls[overflow].flatMap(group => group.map(fence => fence.key)))
          expect(keyNames).toHaveLength(13); expect(keys.size).toBe(17)
          expect(keys).toEqual(new Set([...keyNames.map(name => apiKeyService.storedKeyName(name, USER)), apiKeyService.storedKeyName(cKey, USER),
            `mcp_gateways:${USER}`, `agent:${ACTOR}`, `agent:${TARGET}`]))
          expect(originalJoin).toHaveBeenCalledOnce()
          await expect(originalJoin.mock.results[0].value).rejects.toEqual(new Error(reason))
          expect(await redis.json.getRaw(`agent:${ACTOR}`, '$')).toBe(capacityRawBefore?.actor)
          expect(await redis.json.getRaw(`agent:${TARGET}`, '$')).toBe(capacityRawBefore?.target)
        }
        if (fault === 'path-capacity') {
          expect(sourceIds).toHaveLength(64); expect(keyNames).toHaveLength(0)
          expect(join.mock.results.some(result => result.type === 'return' && result.value.some(fence => fence.key === `mcp_gateways:${USER}` && fence.paths.length === 64))).toBe(true)
          expect(originalJoin).toHaveBeenCalledOnce()
          await expect(originalJoin.mock.results[0].value).rejects.toThrow('successor source path exceeds the existing capacity')
          // Specific reserve boundary precedes missing-producer eligibility;
          // no64-client grant, cache certificate or raw placeholder is supplied.
        }
      }
      const counts = [commit.mock.calls.length, targetWrite.mock.calls.length]
      await fabric.useControl({ ...context, controlId: 'sys.app_settings.native.change', input })
      expect([commit.mock.calls.length, targetWrite.mock.calls.length]).toEqual(counts) // SAME request, no replay
    } finally {
      originalJoin.mockRestore(); join.mockRestore(); network.mockRestore(); targetWrite.mockRestore(); stdioSetup.mockRestore(); setup.mockRestore(); commit.mockRestore()
      await owner.sealP5OriginalPreparation(preparation); owner.retireP5OriginalPreparation(preparation); turns.releaseSessionTurn(sessionId, turn.entry.turnId)
      for (const name of [...keyNames, cKey]) await redis.del(`api_keys:${USER}:${name}`)
      await redis.del(`mcp_gateways:${USER}`)
    }
  })

  it('uses the exact quoted original id and raw row for stable RedisJSON fences; absent/duplicate/malformed rows refuse', async () => {
    const owner = await import('../mcp/originalTask'), turns = await import('../../streamAbortRegistry'), discovery = await import('../../mcpGatewayDiscovery')
    const sourceId = `original-literal-${fixtureSequence}"\\].id`, key = `mcp_gateways:${USER}`
    const source = { id: sourceId, slug: `literal-${fixtureSequence}`, name: 'Literal original A', type: 'stdio', enabled: true, created_at: CREATED,
      stdioConfig: { command: process.execPath, args: [fileURLToPath(import.meta.url)], cwdPolicy: 'none', envRefs: [], startupTimeoutMs: 1000, toolCallTimeoutMs: 15000 } }
    const unrelated = { id: 'unrelated-B', slug: 'unrelated-b', name: 'Unrelated B', type: 'custom', enabled: true, url: 'https://unrelated.example/mcp', created_at: CREATED }
    await redis.json.set(key, '$', { gateways: [unrelated, source] } as any)
    const sessionId = `literal_${fixtureSequence}`, replyId = `literal_reply_${fixtureSequence}`, stop = new AbortController()
    const identity = { userId: USER, agentId: ACTOR, sessionId }, session = { id: sessionId, user_id: USER, agent_id: ACTOR }
    const lookup = owner.captureP5OriginalLookup({ ...identity, signal: stop.signal }), turn = turns.registerSessionTurn(sessionId, 'single', replyId)
    if (!lookup || !turn.ok) throw new Error('The actual literal-id fixture could not register.')
    const preparation = owner.prepareP5OriginalTask(lookup, { ...identity, session, agent: await redis.json.get(`agent:${ACTOR}`), turn: turn.entry })
    if (!preparation) throw new Error('The actual literal-id preparation is unavailable.')
    owner.recordP5ResolvedApiScope(preparation, { gateways: [sourceId], tools: [], authority: { humanSelection: true } })
    owner.bindP5ApiReplyPart(preparation, { replyId, version: 0 })
    try {
    await owner.captureP5ApiOriginalStdioSources(preparation)
    const observation = discovery.reserveInitialStdioObservations(preparation, [sourceId]).get(sourceId)
    if (!observation) throw new Error('The actual original observation is unavailable.')
    const original = owner.readP5InitialStdioSource(preparation, observation)
    if (!original) throw new Error('The actual frozen literal-id DATA is unavailable.')
    const deadline = Date.now() + 10000, before = await mcpGatewayService.readOriginalMcpStdioCut(original, deadline)
    const path = before.cut.sourceFence!.paths[0][0]
    expect(path).toBe(`$.gateways[?(@.id==${JSON.stringify(sourceId)})]`)
    expect(await redis.json.getRaw(key, path)).toBe(original.sourceRaw) // actual8.10.1 raw bytes, not JSON re-encoding
      await redis.json.set(key, '$.gateways', [source, unrelated] as any)
      expect((await mcpGatewayService.readOriginalMcpStdioCut(original, deadline)).cut.sourceRaw).toBe(original.sourceRaw)
      await redis.json.set(key, '$.gateways', [source, source] as any)
      await expect(mcpGatewayService.readOriginalMcpStdioCut(original, deadline)).rejects.toThrow()
      await redis.json.set(key, '$.gateways', [unrelated] as any)
      await expect(mcpGatewayService.readOriginalMcpStdioCut(original, deadline)).rejects.toThrow()
      await redis.json.set(key, '$.gateways', { bad: true } as any)
      await expect(mcpGatewayService.readOriginalMcpStdioCut(original, deadline)).rejects.toThrow()
      // DATA-only locator negatives never mint a client/ACK/verified plan or C effect.
      expect(discovery.readP5McpClientSettlement(observation)).toMatchObject({ constructor: 'not_started', close: 'not_started' })
    } finally {
      await owner.sealP5OriginalPreparation(preparation); owner.retireP5OriginalPreparation(preparation)
      turns.releaseSessionTurn(sessionId, turn.entry.turnId); await redis.del(key)
    }
  })

  it.each(['key-missing','key-drift','source-drift','target-env-await','successor-key-capacity'] as const)('keeps original saved STDIO %s before any source/spawn/target effect', async fault => {
    const p = policy(); p.ordinaryChanges = false; p.management.mcpManagement = 'allow'; p.protected.contextManagement = 'allow'
    await configure(p)
    const owner = await import('../mcp/originalTask'), turns = await import('../../streamAbortRegistry'), runtime = await import('./managementRuntime')
    const fabric = await import('../../fabricRegistry'), stdio = await import('../../stdioMCPGatewayClient')
    const sessionId = `stdio_cut_${fixtureSequence}`, replyId = `stdio_cut_reply_${fixtureSequence}`, stop = new AbortController()
    const identity = { userId: USER, agentId: ACTOR, sessionId }, session = { id: sessionId, user_id: USER, agent_id: ACTOR }
    const lookup = owner.captureP5OriginalLookup({ ...identity, signal: stop.signal }), turn = turns.registerSessionTurn(sessionId, 'single', replyId)
    if (!lookup || !turn.ok) throw new Error('The genuine STDIO original could not register.')
    const preparation = owner.prepareP5OriginalTask(lookup, { ...identity, session, agent: await redis.json.get(`agent:${ACTOR}`), turn: turn.entry })
    if (!preparation) throw new Error('The genuine STDIO preparation is unavailable.')
    owner.recordP5ResolvedApiScope(preparation, { gateways: [], tools: [], authority: { humanSelection: true } })
    const part = owner.bindP5ApiReplyPart(preparation, { replyId, version: 0 })
    const run = owner.associateP5ApiOriginalRun(preparation, part, { ...identity, replyId, signal: stop.signal })
    if (!run) throw new Error('The genuine STDIO run is unavailable.')
    const context = { ...identity, messageId: replyId, actorType: 'in-process', p5ApiRun: run, abortSignal: stop.signal }
    const name = `stdio-cut-${fixtureSequence}`, sourceId = `stdio-source-${fixtureSequence}`
    const names = fault === 'successor-key-capacity' ? Array.from({ length: 13 }, (_, index) => `${name}-${index}`) : [name]
    for (const ref of names) await apiKeyService.store(ref, 'CONTROLLED_STDIO_CUT_VALUE', USER)
    const source = { id: sourceId, slug: sourceId, name: 'Saved installed STDIO', type: 'stdio', enabled: false, created_at: CREATED,
      stdioConfig: { command: process.execPath, args: [fileURLToPath(import.meta.url)], cwdPolicy: 'none',
        envRefs: fault === 'successor-key-capacity' ? names.map((savedKeyRef, index) => ({ envVar: `KEY_${index}`, savedKeyRef })) : [{ envVar: 'SERVER_TOKEN', savedKeyRef: name }, { envVar: 'SECOND_TOKEN', savedKeyRef: name }], startupTimeoutMs: 1000, toolCallTimeoutMs: 1000 } }
    await redis.json.set(`mcp_gateways:${USER}`, '$', { gateways: [source] } as never)
    const commit = vi.spyOn(mcpGatewayService, 'commitPreparedGatewaySave'), list = vi.spyOn(stdio.stdioMCPGatewayClient, 'listForHeldApi')
    const originalJoin = vi.spyOn(owner, 'joinP5OriginalStdioManagement')
    const write = vi.spyOn(managedSettingsStore, 'writeMcpTarget'), actualKey = apiKeyService.withConfiguredValue.bind(apiKeyService)
    let replaced = false
    const keyUse = vi.spyOn(apiKeyService, 'withConfiguredValue').mockImplementation(async (ref, user, use) => actualKey(ref, user, async value => {
      if (fault === 'target-env-await' && !replaced) {
        replaced = true; const same = await redis.json.get(`agent:${ACTOR}`)
        await withSettingsRecordReplacement(`agent:${ACTOR}`, async () => { await redis.json.set(`agent:${ACTOR}`, '$', same) })
      }
      return use(value)
    }))
    try {
      const target = { subject: { kind: 'primary', id: fault === 'successor-key-capacity' ? TARGET : ACTOR }, gatewayId: sourceId, membership: 'enable', zip: { toolName: 'remote_tool', zipThreshold: 0, autoZip: false } }
      const page = mcpProofPage(await runtime.settingsManagementReports.report(context, 'native', { domain: 'mcp-configuration', query: { kind: 'prerequisite', target } }))
      const input = { op: 'change', requestId: `${page.bootNamespace}:stdio-${fault}`, reportId: page.reportId, semanticId: 'mcp.workflow.configure',
        changes: { source: { candidateId: page.report.rows[0].candidateId }, target } }
      const prepared = await runtime.prepareSettingsControl(context, 'sys.app_settings.native.change', input)
      expect(prepared?.approvalPreview?.preview.resource).toMatchObject({ sourceAction: 'save', before: { enabled: false }, after: { enabled: true, stdio: { envRefs: source.stdioConfig.envRefs } } })
      if (fault === 'key-missing') await redis.del(apiKeyService.storedKeyName(name, USER))
      if (fault === 'key-drift') await apiKeyService.store(name, 'CONTROLLED_CHANGED_STDIO_CUT_VALUE', USER)
      if (fault === 'source-drift') await redis.json.set(`mcp_gateways:${USER}`, '$.gateways[0].stdioConfig.args', ['/different/server.cjs'])
      if (fault === 'successor-key-capacity') {
        expect(names).toHaveLength(13); expect(target.subject.id).toBe(TARGET)
        const result = await fabric.useControl({ ...context, controlId: 'sys.app_settings.native.change', input })
        expect(result).toMatchObject({ success: true, result: { status: 'unknown_outcome', resourceOutcomes: [{ saved: 'not_requested', stages: { registry: 'not_requested', verification: 'not_started' } }] } })
        expect(originalJoin).toHaveBeenCalledOnce()
        await expect(originalJoin.mock.results[0].value).rejects.toThrow('successor source key exceeds the existing capacity')
        expect(keyUse).not.toHaveBeenCalled() // no value/launch acquisition or effect before complete successor capacity
      } else if (fault === 'target-env-await') {
        const result = await fabric.useControl({ ...context, controlId: 'sys.app_settings.native.change', input })
        expect(result).toMatchObject({ success: true, result: { status: 'unknown_outcome', resourceOutcomes: [{ variant: 'prerequisite', saved: 'not_requested', stages: { registry: 'not_requested', verification: 'not_started' } }] } })
        expect(replaced).toBe(true)
      } else if (fault === 'source-drift') await expect(runtime.prepareSettingsControl(context, 'sys.app_settings.native.change', input)).rejects.toThrow('gateway source changed')
      else await expect(runtime.prepareSettingsControl(context, 'sys.app_settings.native.change', input)).rejects.toMatchObject({ code: 'MCP_KEY_REFERENCE_CHANGED' })
      expect(commit).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
      expect((await redis.json.get(`mcp_gateways:${USER}`) as any).gateways[0].enabled).toBe(false)
      expect(owner.p5ApiPreparedGatewayFrontier(preparation)).toEqual([])
    } finally {
      originalJoin.mockRestore(); keyUse.mockRestore(); commit.mockRestore(); list.mockRestore(); write.mockRestore()
      await owner.sealP5OriginalPreparation(preparation); owner.retireP5OriginalPreparation(preparation); turns.releaseSessionTurn(sessionId, turn.entry.turnId)
      for (const ref of names) await redis.del(apiKeyService.storedKeyName(ref, USER))
      await redis.del(`mcp_gateways:${USER}`)
    }
  })

  it.each([
    ['no-key','none'], ['saved-reference','none'], ['saved-reference','get-reject'], ['saved-reference','get-pending'],
    ['saved-reference','list-failure'], ['saved-reference','close-failure'], ['saved-reference','target-readback'],
    ['saved-reference','target-key-replacement'], ['saved-reference','target-header-replacement'],
    ['saved-reference','key-header'], ['saved-reference','policy-header'], ['saved-reference','actor-header'],
    ['saved-reference','Stop-header'], ['saved-reference','deadline-header'], ['saved-reference','frame-conflict']
  ] as const)('runs genuine API Allow %s / %s through the same real source/target and actual MCP owners', async (auth, fault) => {
    const p = policy(); p.ordinaryChanges = false; p.management.mcpManagement = 'allow'; p.protected.contextManagement = 'allow'
    await configure(p)
    const targetId = fault === 'target-key-replacement' || fault === 'target-header-replacement' ? TARGET : ACTOR
    const actorId = ACTOR, sessionId = `positive_wire_${fixtureSequence}`, replyId = `positive_wire_reply_${fixtureSequence}`
    await redis.json.set(`agent:${actorId}`, '$.defaultMCPGateways', ['saved-B'])
    const session = { id: sessionId, user_id: USER, title: 'Owned MCP setup fixture', agent_id: actorId }
    await redis.createSession(session as never)
    const owner = await import('../mcp/originalTask'), turns = await import('../../streamAbortRegistry')
    const runtime = await import('./managementRuntime'), fabric = await import('../../fabricRegistry')
    const stop = new AbortController(), identity = { userId: USER, agentId: actorId, sessionId }
    const lookup = owner.captureP5OriginalLookup({ ...identity, signal: stop.signal })
    const turn = turns.registerSessionTurn(sessionId, 'single', replyId)
    if (!lookup || !turn.ok) throw new Error('The actual API setup fixture could not register.')
    const preparation = owner.prepareP5OriginalTask(lookup, { ...identity, session, agent: await redis.json.get(`agent:${actorId}`), turn: turn.entry })
    if (!preparation) throw new Error('The actual API setup preparation is unavailable.')
    owner.recordP5ResolvedApiScope(preparation, { gateways: [], tools: [], authority: { humanSelection: true } })
    const part = owner.bindP5ApiReplyPart(preparation, { replyId, version: 0 })
    const run = owner.associateP5ApiOriginalRun(preparation, part, { ...identity, replyId, signal: stop.signal })
    if (!run) throw new Error('The actual API setup run is unavailable.')
    const actualContext = { ...identity, messageId: replyId, actorType: 'in-process' as const, p5ApiRun: run, abortSignal: stop.signal }
    if (auth === 'saved-reference') await apiKeyService.store('positive-setup-fixture', 'CONTROLLED_SYNTHETIC_SETUP_VALUE', USER)
    let conflictingReference: { key: string; raw: string } | undefined
    const conflictRegistryBefore = fault === 'frame-conflict' ? await redis.json.get(`mcp_gateways:${USER}`) : undefined
    if (fault === 'frame-conflict') {
      const key = apiKeyService.storedKeyName('positive-setup-fixture', USER), original = await redis.json.get(key)
      await apiKeyService.store('positive-setup-fixture', 'CONTROLLED_CONFLICTING_FRAME_VALUE', USER)
      const other = await apiKeyService.readReferenceState('positive-setup-fixture', USER)
      conflictingReference = { key: other.key, raw: other.raw } // actual second raw observation, negative DATA only
      await redis.json.set(key, '$', original as any) // original actual C value/cut remains the real held basis
    }
    const candidate = { ...mcpCandidate.query.candidate, ...(auth === 'saved-reference' ? { savedKeyRef: 'positive-setup-fixture' } : {}) }
    const publication = await import('$lib/server/ssePublisher')
    const notices = vi.spyOn(publication, 'publishUserEvent')
    const transport = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    const actualHeaders = (transport.StreamableHTTPClientTransport.prototype as any)._commonHeaders
    const actualClose = transport.StreamableHTTPClientTransport.prototype.close
    let replaceDone = false, headerChanged = false, releaseGet: ((response: Response) => void) | undefined, restoreClock: (() => void) | undefined
    const replaceTarget = async () => {
      if (replaceDone) return
      replaceDone = true
      const same = await redis.json.get(`agent:${targetId}`)
      await withSettingsRecordReplacement(`agent:${targetId}`, async () => { await redis.json.set(`agent:${targetId}`, '$', same) })
    }
    const headers = vi.spyOn(transport.StreamableHTTPClientTransport.prototype as any, '_commonHeaders').mockImplementation(async function(this: any) {
      const answer = await actualHeaders.call(this)
      if (fault === 'target-header-replacement') await replaceTarget()
      if (!headerChanged && ['key-header','policy-header','actor-header','Stop-header','deadline-header'].includes(fault)) {
        headerChanged = true
        if (fault === 'key-header') await apiKeyService.store('positive-setup-fixture', 'CONTROLLED_CHANGED_SETUP_VALUE', USER)
        if (fault === 'policy-header') { const value = await nativePolicyResponse(USER, actorId); await saveNativePolicy(USER, actorId, { expectedGeneration: value.generation, expectedSubjectRevision: value.subjectRevision, policy: { ...value.policy, management: { ...value.policy.management, mcpManagement: 'block' } } }) }
        if (fault === 'actor-header') await redis.json.set(`agent:${actorId}`, '$.created_at', 'controlled-replacement-incarnation')
        if (fault === 'Stop-header') stop.abort(new Error('controlled Stop after actual header await'))
        if (fault === 'deadline-header') { const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 180001); restoreClock = () => clock.mockRestore() }
      }
      return answer
    })
    const close = vi.spyOn(transport.StreamableHTTPClientTransport.prototype, 'close').mockImplementation(async function(this: any) {
      await actualClose.call(this)
      if (fault === 'close-failure') throw new Error('controlled actual close acknowledgement lost')
    })
    const configured = apiKeyService.withConfiguredValue.bind(apiKeyService)
    const keyUse = vi.spyOn(apiKeyService, 'withConfiguredValue').mockImplementation(async (name, user, consume) => configured(name, user, async source => {
      if (fault === 'target-key-replacement') await replaceTarget()
      return consume(source)
    }))
    const targetRead = managedSettingsStore.readMcpTarget!.bind(managedSettingsStore)
    const readback = vi.spyOn(managedSettingsStore, 'readMcpTarget').mockImplementation(async (...args) => {
      const answer = await targetRead(...args)
      if (fault === 'target-readback' && Array.isArray(answer.row.defaultMCPGateways) && answer.row.defaultMCPGateways.some(id => id !== 'saved-B')) throw new Error('controlled post-ACK target readback failure')
      return answer
    })
    const packets: Array<{ method: string; params?: unknown }> = []
    const optionalGets: string[] = []
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url !== mcpCandidate.query.candidate.url) throw new Error('The controlled setup fixture refused unexpected network traffic.')
      if (init?.method === 'GET') {
        optionalGets.push(url)
        if (fault === 'get-reject') throw new Error('controlled optional GET response lost')
        if (fault === 'get-pending') return new Promise<Response>(resolve => { releaseGet = resolve })
        return new Response(null, { status: 405 })
      }
      if (init?.method !== 'POST') throw new Error('The controlled setup fixture refused an unexpected method.')
      expect(new Headers(init.headers).get('authorization')).toBe(auth === 'saved-reference' ? 'Bearer CONTROLLED_SYNTHETIC_SETUP_VALUE' : null)
      const body = JSON.parse(String(init.body)); packets.push({ method: body.method, params: body.params })
      if (body.method === 'tools/list' && fault === 'list-failure') return new Response('controlled list failure', { status: 503 })
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
      const result = body.method === 'initialize' ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'owned-controlled-source', version: '1' } } :
        body.method === 'tools/list' ? { tools: [{ name: 'remote_tool', description: 'Controlled tool', inputSchema: { type: 'object', properties: {} } }] } : undefined
      if (!result) throw new Error('The controlled setup fixture forbids tool execution and all unplanned RPCs.')
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } })
    })
    const actualCommit = mcpGatewayService.commitPreparedGatewaySave.bind(mcpGatewayService)
    const commit = vi.spyOn(mcpGatewayService, 'commitPreparedGatewaySave')
    if (fault === 'frame-conflict') commit.mockImplementation((plan, input) => actualCommit(plan, { ...input,
      fences: [...input.fences, { key: conflictingReference!.key, paths: [['$', conflictingReference!.raw] as const] }] }))
    const discovery = await import('../../mcpGatewayDiscovery'), httpOwner = await import('../../n8nMCPGatewayClient')
    const factory = vi.spyOn(discovery.mcpGatewayDiscovery, 'discoverForHeldMcpSetup')
    const list = vi.spyOn(httpOwner.n8nMCPGatewayClient, 'listForHeldApi')
    try {
      const page = mcpProofPage(await runtime.settingsManagementReports.report(actualContext, 'native', { domain: 'mcp-configuration', query: { kind: 'prerequisite', candidate,
        target: { subject: { kind: 'primary', id: targetId }, membership: 'enable', zip: { toolName: 'remote_tool', autoZip: false, zipThreshold: 0 } } } }))
      const row = page.report.rows[0]
      const input = { op: 'change', requestId: `${page.bootNamespace}:actual-setup`, reportId: page.reportId, semanticId: 'mcp.workflow.configure',
        changes: { source: { candidateId: row.candidateId }, target: { subject: { kind: 'primary', id: targetId }, gatewayId: row.gatewayId,
          membership: 'enable', zip: { toolName: 'remote_tool', autoZip: false, zipThreshold: 0 } } } }
      // Actual Fabric standing-consent gate and retained operation, no dummy gate.
      const result = await fabric.useControl({ ...actualContext, controlId: 'sys.app_settings.native.change', input })
      if (fault !== 'none') {
        expect(result).toMatchObject({ success: true, result: { status: 'unknown_outcome' } })
        expect(commit).toHaveBeenCalledTimes(fault === 'target-key-replacement' ? 0 : 1)
        if (fault === 'target-key-replacement' || fault === 'target-header-replacement' || fault === 'frame-conflict' || fault.endsWith('-header')) expect(packets).toEqual([])
        const sourceEvents = notices.mock.calls.filter(([, event]) => event.type === 'mcp_gateway_source_changed')
        const targetEvents = notices.mock.calls.filter(([, event]) => event.type === 'agent_settings_changed' && event.family === 'mcp-settings')
        expect(sourceEvents).toHaveLength(fault === 'target-key-replacement' || fault === 'frame-conflict' ? 0 : 1)
        expect(targetEvents).toHaveLength(fault === 'target-readback' ? 1 : 0)
        if (fault === 'frame-conflict') {
          expect(factory).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled()
          expect(await redis.json.get(`mcp_gateways:${USER}`)).toEqual(conflictRegistryBefore)
          expect(result).toMatchObject({ result: { resourceOutcomes: [{ saved: 'not_requested', stages: { registry: 'not_requested' } }] } })
        }
        expect(sourceEvents.every(([, event]) => Object.keys(event).sort().join(',') === 'gatewayId,type')).toBe(true)
        expect(targetEvents.every(([, event]) => Object.keys(event).sort().join(',') === 'agentId,family,type')).toBe(true)
        if (fault === 'get-pending') {
          const genuine = list.mock.calls[0]?.[0]
          expect(genuine).toBeDefined()
          expect(httpOwner.n8nMCPGatewayClient.readHeldApiSettlement(genuine!)).toMatchObject({ requests: 'pending' })
          releaseGet!(new Response(null, { status: 405 }))
          await expect.poll(() => httpOwner.n8nMCPGatewayClient.readHeldApiSettlement(genuine!).requests).toBe('known')
        }
        const packetCount = packets.length, getCount = optionalGets.length, listCount = list.mock.calls.length
        if (fault === 'Stop-header') await expect(owner.takeP5ApiVerifiedContinuation(preparation)).rejects.toMatchObject({ code: 'P5_ORIGINAL_BOOT_READ_REFUSED' })
        else await expect(owner.takeP5ApiVerifiedContinuation(preparation)).resolves.toBeUndefined()
        const repeated = await fabric.useControl({ ...actualContext, controlId: 'sys.app_settings.native.change', input })
        if (fault === 'policy-header') expect(repeated).toMatchObject({ success: false, controlId: 'sys.app_settings.native.change',
          error: { code: 'CONTROL_NOT_ALLOWED', message: 'This operation belongs to different authority.' } })
        else if (fault === 'Stop-header') expect(repeated).toMatchObject({ success: false, controlId: 'sys.app_settings.native.change',
          error: { code: 'CONTROL_NOT_ALLOWED', message: 'This exact reply has ended or stopped.' } })
        else expect(repeated).toMatchObject({ success: true, result: { status: 'unknown_outcome' } })
        expect(commit).toHaveBeenCalledTimes(fault === 'target-key-replacement' ? 0 : 1)
        expect(packets).toHaveLength(packetCount); expect(optionalGets).toHaveLength(getCount); expect(list).toHaveBeenCalledTimes(listCount)
        expect(notices.mock.calls.filter(([, event]) => event.type === 'mcp_gateway_source_changed')).toHaveLength(sourceEvents.length)
        expect(notices.mock.calls.filter(([, event]) => event.type === 'agent_settings_changed' && event.family === 'mcp-settings')).toHaveLength(targetEvents.length)
        expect(owner.p5ApiPreparedGatewayFrontier(preparation)).toEqual([])
        return
      }
      expect(result).toMatchObject({ success: true, result: { status: 'completed', totalTargets: 1, resourceOutcomes: [{ variant: 'prerequisite', saved: 'saved', stages: {
        registry: 'saved', keyReference: auth === 'saved-reference' ? 'verified' : 'not_requested', verification: 'verified', discoverability: 'saved', zip: 'saved', originalTaskUse: 'not_started' } }] } })
      expect(packets.map(packet => packet.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
      expect(optionalGets).toEqual([mcpCandidate.query.candidate.url])
      expect(commit).toHaveBeenCalledOnce(); expect(factory).toHaveBeenCalledOnce()
      const setupAdmission = await factory.mock.results[0].value
      await expect(httpOwner.n8nMCPGatewayClient.executeForHeldApi(setupAdmission)).rejects.toThrow('setup client cannot execute a tool')
      expect(packets).toHaveLength(3)
      const storedActor = await redis.json.get(`agent:${actorId}`)
      expect(storedActor.defaultMCPGateways).toEqual(['saved-B', row.gatewayId])
      expect(storedActor.custom_tool_settings).toContainEqual({ tool_name: 'remote_tool', auto_zip: false, zip_threshold: 0 })
      const source = (await redis.json.get(`mcp_gateways:${USER}`)).gateways.find((gateway: { id: string }) => gateway.id === row.gatewayId)
      if (auth === 'saved-reference') expect(source.authKeyName).toBe('positive-setup-fixture')
      else expect(source).not.toHaveProperty('authKeyName')
      expect(source.metadata).not.toHaveProperty('authToken')
      // No SDK consumer/finish or canonical reply was forged by this setup proof.
      await expect(owner.takeP5ApiVerifiedContinuation(preparation)).resolves.toBeUndefined()
      expect(owner.p5ApiPreparedGatewayFrontier(preparation)).toEqual([])
      const repeat = await fabric.useControl({ ...actualContext, controlId: 'sys.app_settings.native.change', input })
      expect(repeat).toMatchObject({ success: true, result: { status: 'completed' } })
      expect(commit).toHaveBeenCalledOnce(); expect(packets).toHaveLength(3)
    } finally {
      releaseGet?.(new Response(null, { status: 405 })); restoreClock?.()
      network.mockRestore(); commit.mockRestore(); factory.mockRestore(); list.mockRestore()
      notices.mockRestore(); headers.mockRestore(); close.mockRestore(); keyUse.mockRestore(); readback.mockRestore()
      await owner.sealP5OriginalPreparation(preparation); owner.retireP5OriginalPreparation(preparation)
      turns.releaseSessionTurn(sessionId, turn.entry.turnId)
    }
  })

  // SA-139 R4 removed the native credential-route lane (a non-delegated run credential came only from a CLI Primary run); its refusal is pinned below.
  it('I1 actual portable wrappers require the exact human POST and retain saved-key raw cuts without decryption', async () => {
    const permissions = policy(); permissions.ordinaryChanges = false; permissions.scope = { mode: 'selected', subjects: [], except: [] }
    const f = await portable(20 * 60_000, permissions)
    await apiKeyService.store('custom-mcp', 'I1_SYNTHETIC_SAVED_REFERENCE', USER)
    const decrypt = vi.spyOn(apiKeyEncryption, 'decrypt'), commit = vi.spyOn(mcpGatewayService, 'commitPreparedGatewaySave')
    const call = async (controlId: string, input: unknown) => {
      const response = await useControlsRoute({ request: new Request('http://localhost/api/controls/use', { method: 'POST', headers: {
        'content-type': 'application/json', 'x-batshit-portable-token': f.token.token }, body: JSON.stringify({ controlId, input }) }), locals: {} } as never)
      const body = await response.json(); expect(response.status).toBe(200); expect(body.success).toBe(true); return body.result
    }
    try {
      const page = await call('sys.app_settings.portable.report', { ...mcpCandidate, query: { ...mcpCandidate.query, candidate: { ...mcpCandidate.query.candidate, savedKeyRef: 'custom-mcp' } } })
      const input = { op: 'change', requestId: `${page.bootNamespace}:i1-portable`, reportId: page.reportId, semanticId: 'mcp.workflow.configure',
        changes: { source: { candidateId: page.report.rows[0].candidateId } } }
      const waiting = await call('sys.app_settings.portable.change', input)
      expect(waiting).toMatchObject({ status: 'awaiting_approval', totalTargets: 0, totalResources: 1 })
      const url = new URL(`http://localhost/api/app/settings/operations/${waiting.operationId}`)
      const event = { url, params: { operationId: waiting.operationId }, locals: { user: { id: USER }, session: { token: 'owned-human-fixture', user_id: USER } } }
      const human = await readOperationRoute({ ...event, request: new Request(url, { headers: { origin: url.origin } }) } as never)
      expect(human.status).toBe(200); expect(commit).not.toHaveBeenCalled()
      const decision = await decideOperationRoute({ ...event, request: new Request(`${url}/decision`, { method: 'POST', headers: {
        origin: url.origin, 'content-type': 'application/json' }, body: JSON.stringify({ intentDigest: waiting.intentDigest, decision: 'approve' }) }) } as never)
      expect(decision.status).toBe(200)
      const completed = await call('sys.app_settings.portable.change', input)
      expect(completed).toMatchObject({ status: 'completed', resourceOutcomes: [{ saved: 'saved', stages: { registry: 'saved', keyReference: 'verified', verification: 'not_started' } }] })
      expect(commit).toHaveBeenCalledOnce(); expect(decrypt).not.toHaveBeenCalled()
      expect(JSON.stringify([page, waiting, completed, await human.json()])).not.toContain('I1_SYNTHETIC_SAVED_REFERENCE')
      const repeated = await decideOperationRoute({ ...event, request: new Request(`${url}/decision`, { method: 'POST', headers: {
        origin: url.origin, 'content-type': 'application/json' }, body: JSON.stringify({ intentDigest: waiting.intentDigest, decision: 'approve' }) }) } as never)
      expect(repeated.status).toBe(409); expect(commit).toHaveBeenCalledOnce()
      const key = apiKeyService.storedKeyName('custom-mcp', USER)
      await redis.json.set(key, '$', { encrypted: null })
      expect(await apiKeyService.readReferenceState('custom-mcp', USER)).toMatchObject({ present: true, shapeValid: false, raw: '' })
      await redis.json.set(key, '$', { encrypted: 'x'.repeat(20_000), iv: 'i', authTag: 't' })
      await expect(apiKeyService.readReferenceState('custom-mcp', USER)).rejects.toThrow('reference is unavailable')
      expect(decrypt).not.toHaveBeenCalled()
    } finally { decrypt.mockRestore(); commit.mockRestore() }
  })
  it('one generation CAS wins and generic full-record authority edits cannot bypass its owner', async () => {
    const baseline = await nativePolicyResponse(USER, ACTOR)
    const request = { expectedGeneration: 0, expectedSubjectRevision: baseline.subjectRevision, policy: policy() }
    const results = await Promise.allSettled([saveNativePolicy(USER, ACTOR, request), saveNativePolicy(USER, ACTOR, request)])
    expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    await expect(redis.updateAgent(ACTOR, { app_action_policy: { generation: 99, policy: policy() } } as never)).rejects.toThrow()
    await redis.updateAgent(ACTOR, { displayName: 'Human edit' })
    expect(await nativePolicyResponse(USER, ACTOR)).toMatchObject({ generation: 1, policy: policy() })
    expect((await redis.json.get(`agent:${ACTOR}`)).displayName).toBe('Human edit')
  })
  it('actual create can preserve dates but never inherits authority or accepts a generation-zero old form', async () => {
    const baseline = await nativePolicyResponse(USER, ACTOR)
    await redis.createAgent({ id: ACTOR, user_id: USER, agentType: 'api', displayName: 'Replacement', created_at: CREATED,
      app_action_policy: { generation: 5, policy: policy() } })
    const replacement = await nativePolicyResponse(USER, ACTOR)
    expect(replacement.generation).toBe(0)
    expect((await redis.json.get(`agent:${ACTOR}`)).created_at).toBe(CREATED)
    expect(replacement.subjectRevision).not.toBe(baseline.subjectRevision)
    await expect(saveNativePolicy(USER, ACTOR, { expectedGeneration: 0, expectedSubjectRevision: baseline.subjectRevision, policy: policy() })).rejects.toMatchObject({ code: 'POLICY_CONFLICT' })
    const exact = await redis.json.get(`agent:${ACTOR}`)
    await withSettingsRestoreFence(() => redis.json.set(`agent:${ACTOR}`, '$', exact))
    await expect(saveNativePolicy(USER, ACTOR, { expectedGeneration: 0, expectedSubjectRevision: replacement.subjectRevision, policy: policy() })).rejects.toMatchObject({ code: 'POLICY_CONFLICT' })
  })
  it('checks captured authority and target preimages atomically at the actual write', async () => {
    await configure()
    const authority = await readNativePolicyAuthority(USER, ACTOR)
    const before = await store.read(TARGET)
    await configure({ ...policy(), enabled: false })
    const result = await store.write(TARGET, USER, 'identity', before, { displayName: 'Must not save' }, undefined, new AbortController().signal,
      Date.now() + 5000, { authorityFence: authority.fence })
    expect(result).toBe('AUTHORITY_CHANGED')
    expect((await redis.json.get(`agent:${TARGET}`)).displayName).toBe('Target')
  })
  it('adds only the new portable family, advances rotate/revoke authority and ignores label execution stamps', async () => {
    const created = await createPortableSkillToken({ userId: USER, families: ['voice-engines'] })
    await expect(readPortableAppActionsAuthority(USER, created.record.id)).rejects.toThrow()
    const saved = await savePortableGrant(USER, created.record.id, { expectedAuthorityGeneration: 1,
      grant: { policy: policy(), expiresAt: new Date(Date.now() + 60_000).toISOString() } })
    expect(saved.authorityGeneration).toBe(2)
    const before = await readPortableAppActionsAuthority(USER, created.record.id)
    await updatePortableSkillToken({ userId: USER, tokenId: created.record.id, label: 'Renamed only' })
    expect((await readPortableAppActionsAuthority(USER, created.record.id)).generation).toBe(2)
    const rotated = await rotatePortableSkillToken({ userId: USER, tokenId: created.record.id })
    expect((await readPortableAppActionsAuthority(USER, created.record.id)).generation).toBe(3)
    expect((await validatePortableSkillToken(created.token)).valid).toBe(false)
    const snapshot = await store.read(TARGET)
    expect(await store.write(TARGET, USER, 'identity', snapshot, { displayName: 'No stale grant' }, undefined,
      new AbortController().signal, Date.now() + 5000, { authorityFence: before.fence })).toBe('AUTHORITY_CHANGED')
    expect((await redis.json.get(`portable_skill_token:${USER}:${created.record.id}`)).families).toEqual(['voice-engines', 'app-actions'])
    await revokePortableSkillToken({ userId: USER, tokenId: created.record.id })
    expect((await validatePortableSkillToken(rotated.token)).valid).toBe(false)
    expect((await redis.json.get(`portable_skill_token:${USER}:${created.record.id}`)).authorityGeneration).toBe(4)
  })
  it('actual delete shrinks selected native and portable grants before a reused ID can inherit them', async () => {
    const selected = { ...policy(), scope: { mode: 'selected' as const, subjects: [{ kind: 'primary' as const, id: TARGET }], except: [] } }
    await configure(selected)
    const { token, saved } = await portable()
    await savePortableGrant(USER, token.record.id, { expectedAuthorityGeneration: saved.authorityGeneration,
      grant: { policy: selected, expiresAt: new Date(Date.now() + 60_000).toISOString() } })
    await redis.deleteAgent(TARGET)
    expect((await nativePolicyResponse(USER, ACTOR)).policy.scope.subjects).toEqual([])
    expect((await portableGrantResponse(USER, token.record.id)).grant?.policy.scope.subjects).toEqual([])
    await redis.createAgent({ id: TARGET, user_id: USER, agentType: 'api', displayName: 'Replacement', created_at: CREATED })
    expect((await nativePolicyResponse(USER, ACTOR)).generation).toBe(2)
  })
  it('renames the typed Subagent owner without touching its slug or other fields', async () => {
    await configure()
    await redis.json.set('subagent:p2_sub', '$', { id: 'p2_sub', user_id: USER, subagentType: 'api',
      displayName: 'Subagent', slug: 'kept_slug', created_at: CREATED, system_prompt: 'Keep this instruction.' })
    const authority = await readNativePolicyAuthority(USER, ACTOR)
    const before = await store.read('p2_sub', 'subagent')
    expect(await store.write('p2_sub', USER, 'identity', before, { displayName: 'New sub name' }, undefined,
      new AbortController().signal, Date.now() + 5000, { subjectKind: 'subagent', authorityFence: authority.fence })).toBe('OK')
    expect(await redis.json.get('subagent:p2_sub')).toMatchObject({ id: 'p2_sub', subagentType: 'api', slug: 'kept_slug', displayName: 'New sub name', system_prompt: 'Keep this instruction.' })
    const current = await store.read('p2_sub', 'subagent')
    expect(await store.write('p2_sub', USER, 'memory', current, { recalled: 0 }, undefined,
      new AbortController().signal, Date.now() + 5000, { subjectKind: 'subagent', authorityFence: authority.fence })).toBe('UNSUPPORTED_PRIMARY')
  })
  it('retained pages refresh real token authority and reject identical-data subject replacement', async () => {
    const { context } = await portable()
    const registry = createSettingsOperationRegistry()
    const reports = createSettingsManagementReports(registry.boot, store)
    const page = await reports.report(context, 'portable', { targets: { subjects: [{ kind: 'primary', id: TARGET }] } })
    const old = await redis.json.get(`agent:${TARGET}`)
    await redis.createAgent(old)
    await expect(reports.report(context, 'portable', { reportId: page.reportId })).rejects.toMatchObject({ code: 'REPORT_SUBJECT_CHANGED' })
    await rotatePortableSkillToken({ userId: USER, tokenId: context.portableSettingsActor.tokenId })
    await expect(reports.report(context, 'portable', { reportId: page.reportId })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' })
  })
  it.each(['legacy', 'disabled', 'expired'] as const)('keeps ordinary token discovery usable with %s App Actions authority and denies direct management use', async state => {
    const created = await createPortableSkillToken({ userId: USER, families: ['voice-engines'] })
    if (state === 'legacy') await redis.execute(client => client.json.del(`portable_skill_token:${USER}:${created.record.id}`, { path: '$.authorityGeneration' }))
    else {
      await savePortableGrant(USER, created.record.id, { expectedAuthorityGeneration: 1,
        grant: { policy: { ...policy(), enabled: state !== 'disabled' }, expiresAt: new Date(Date.now() + 1000).toISOString() } })
    }
    const clock = state === 'expired' ? vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000) : null
    const request = (path: string, body: unknown) => new Request(`http://localhost${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-batshit-portable-token': created.token }, body: JSON.stringify(body) })
    try {
      const response = await findControlsRoute({ request: request('/api/controls/find', { query: 'health', limit: 50 }), locals: {} } as never)
      expect(response.status).toBe(200)
      const found = await response.json()
      expect(found.results.some((row: any) => row.controlId === 'sys.voice.engine.health_check')).toBe(true)
      expect(found.results.some((row: any) => row.controlId.startsWith('sys.app_settings.'))).toBe(false)
      const denied = await useControlsRoute({ request: request('/api/controls/use', { controlId: 'sys.app_settings.portable.report', input: {} }), locals: {} } as never)
      expect((await denied.json()).success).toBe(false)
    } finally { clock?.mockRestore() }
  })
  it('refreshes expiry and revocation on every retained report read', async () => {
    const { context, token, saved } = await portable(20 * 60_000)
    const reports = createSettingsManagementReports(createSettingsOperationRegistry().boot, store)
    const page = await reports.report(context, 'portable', { targets: { subjects: [{ kind: 'primary', id: TARGET }] } })
    await savePortableGrant(USER, token.record.id, { expectedAuthorityGeneration: saved.authorityGeneration,
      grant: { policy: policy(), expiresAt: new Date(Date.now() + 1000).toISOString() } })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000)
    try { await expect(reports.report(context, 'portable', { reportId: page.reportId })).rejects.toMatchObject({ code: 'GRANT_EXPIRED_OR_DISABLED' }) }
    finally { clock.mockRestore() }
    await revokePortableSkillToken({ userId: USER, tokenId: token.record.id })
    await expect(reports.report(context, 'portable', { reportId: page.reportId })).rejects.toMatchObject({ code: 'TOKEN_NOT_ALLOWED' })
  })
  it('retains a confirmed first batch save and blocks later targets after current token revocation', async () => {
    const { context, token } = await portable()
    const registry = createSettingsOperationRegistry()
    const reports = createSettingsManagementReports(registry.boot, store)
    const changes = createSettingsChanges(registry, reports, store)
    const page = await reports.report(context, 'portable', { targets: { allAgents: true } })
    const actual = admittedAgentSettings.updateFamily
    let first = true
    const spy = vi.spyOn(admittedAgentSettings, 'updateFamily').mockImplementation(async (family, args, owner) => {
      const saved = await actual(family, args, owner)
      if (first) { first = false; await revokePortableSkillToken({ userId: USER, tokenId: token.record.id }) }
      return saved
    })
    try {
      const result = await changes.change(context, 'portable', { op: 'change', requestId: `${registry.boot}:batch-revoke`, reportId: page.reportId,
        semanticId: 'agent.identity', changes: { displayName: 'Batch name' } })
      expect(result).toMatchObject({ status: 'completed', outcomesSummary: { applied: 1, blocked: 1 } })
      expect((await redis.json.get(`agent:${ACTOR}`)).displayName).toBe('Batch name')
      expect((await redis.json.get(`agent:${TARGET}`)).displayName).toBe('Target')
      expect(spy).toHaveBeenCalledOnce()
    } finally { spy.mockRestore() }
  })
  it('releases one exact portable Ask-first operation and returns safe direct continuation after known readback', async () => {
    const { context } = await portable()
    const registry = createSettingsOperationRegistry()
    const reports = createSettingsManagementReports(registry.boot, store)
    const changes = createSettingsChanges(registry, reports, store)
    const page = await reports.report(context, 'portable', { targets: { allAgents: true, except: [{ kind: 'primary', id: ACTOR }] } })
    const input = { op: 'change', requestId: `${registry.boot}:memory`, reportId: page.reportId,
      semanticId: 'agent.memory.preferences', changes: { triggerLingerTurns: 0, recalled: 0 } }
    const waiting = await changes.change(context, 'portable', input)
    expect(waiting).toMatchObject({ code: 'user_approval_required', status: 'awaiting_approval' })
    await registry.humanReview(USER, waiting.operationId)
    expect((await redis.json.get(`agent:${TARGET}`)).memory_linger_turns).toBe(2)
    await registry.decide(USER, waiting.operationId, waiting.intentDigest, 'approve')
    const complete = await changes.change(context, 'portable', input)
    expect(complete).toMatchObject({ status: 'completed', outcomesSummary: { applied: 1 }, continuation: { manifest: { targets: 1, excluded: 1 } } })
    expect((await redis.json.get(`agent:${TARGET}`)).memory_linger_turns).toBe(0)
    expect(settingsFamilyRevision(await store.read(TARGET), 'memory')).toMatch(/^sha256:/)
    await expect(registry.decide(USER, waiting.operationId, waiting.intentDigest, 'approve')).rejects.toThrow('already')
  })
  // SA-139 R4: the managed native lane (CLI Primary run credential, managed-reply Stop) is removed.
  it('refuses a non-delegated run-credential (`agent`) actor as no native App Actions actor, even with a live reply signal', async () => {
    await configure()
    const sessionId = 'p2_managed_session', live = new AbortController()
    registerStreamAbort(sessionId, 'managed_reply', live)
    try {
      const reports = createSettingsManagementReports(createSettingsOperationRegistry().boot, store)
      const before = await redis.json.get(`agent:${TARGET}`)
      const managed = { userId: USER, agentId: ACTOR, sessionId, actorType: 'agent', abortSignal: live.signal, originatingReply: { sessionId, messageId: 'managed_reply' } }
      await expect(reports.report(managed, 'native', { targets: { subjects: [{ kind: 'primary', id: TARGET }] } })).rejects.toMatchObject({ code: 'NATIVE_ACTOR_REQUIRED' })
      expect(await redis.json.get(`agent:${TARGET}`)).toEqual(before)
    } finally { clearStreamAbort(sessionId) }
  })
  it('refuses retained snapshot values when another target is replaced during the final actor read', async () => {
    const { context, token } = await portable()
    const registry = createSettingsOperationRegistry()
    const reports = createSettingsManagementReports(registry.boot, store)
    const page = await reports.report(context, 'portable', { targets: { subjects: [{ kind: 'primary', id: TARGET }] } })
    const old = await redis.json.get(`agent:${TARGET}`)
    const client = await redis.execute(async connection => connection)
    const original = client.eval.bind(client)
    let entered!: () => void, release!: () => void
    const held = new Promise<void>(resolve => { entered = resolve })
    const continued = new Promise<void>(resolve => { release = resolve })
    let reads = 0
    const spy = vi.spyOn(client, 'eval').mockImplementation((async (script: string, options: any) => {
      const answer = await original(script, options)
      if (options.keys[0] === `portable_skill_token:${USER}:${token.record.id}` && ++reads === 2) { entered(); await continued }
      return answer
    }) as never)
    const refresh = reports.report(context, 'portable', { reportId: page.reportId })
    try {
      await held
      await redis.createAgent(old)
      release()
      await expect(refresh).rejects.toMatchObject({ code: 'REPORT_SUBJECT_CHANGED' })
    } finally { release(); spy.mockRestore(); await refresh.catch(() => {}) }
  })
  it('P3a persists independent API display leaves and restores unset factory state without a false saved-then-changed result', async () => {
    const { context } = await portable()
    const registry = createSettingsOperationRegistry(), reports = createSettingsManagementReports(registry.boot, store)
    const changes = createSettingsChanges(registry, reports, store)
    const before = await redis.json.get(`agent:${TARGET}`)
    const first = await reports.report(context, 'portable', { targets: { subjects: [{ kind: 'primary', id: TARGET }] } })
    const saved: any = await changes.change(context, 'portable', { op: 'change', requestId: `${registry.boot}:p3-display`, reportId: first.reportId,
      semanticId: 'agent.reasoning.presentation', changes: { displayReasoning: false, displayWhiteboard: true } })
    expect(saved).toMatchObject({ status: 'completed', outcomes: [{ saved: 'saved', readback: 'verified' }] })
    expect(await redis.json.get(`agent:${TARGET}`)).toMatchObject({ ...before, updated_at: expect.any(String), show_reasoning: false, show_whiteboard: true })
    const reset: any = await changes.change(context, 'portable', { op: 'change', requestId: `${registry.boot}:p3-display-reset`, reportId: saved.continuation.reportId,
      semanticId: 'agent.reasoning.presentation', changes: { displayReasoning: null, displayWhiteboard: null } })
    expect(reset).toMatchObject({ status: 'completed', outcomes: [{ saved: 'saved', readback: 'verified' }] })
    const restored = await redis.json.get(`agent:${TARGET}`)
    expect(Object.hasOwn(restored, 'show_reasoning')).toBe(false)
    expect(Object.hasOwn(restored, 'show_whiteboard')).toBe(false)
    expect(restored.memory_lane_budgets).toEqual(before.memory_lane_budgets)
    expect(await changes.change(context, 'portable', { op: 'change', requestId: `${registry.boot}:p3-display-unset`, reportId: reset.continuation.reportId,
      semanticId: 'agent.reasoning.presentation', changes: { displayReasoning: null } })).toMatchObject({ outcomesSummary: { unchanged: 1 }, outcomes: [{ saved: 'not_requested' }] })
  })
  it('P3a protects API retention with exact one-operation consent and preserves Whiteboard content', async () => {
    const { context } = await portable()
    const registry = createSettingsOperationRegistry(), reports = createSettingsManagementReports(registry.boot, store)
    const changes = createSettingsChanges(registry, reports, store)
    const board = `whiteboard:p3_retention_session:${TARGET}`
    await redis.json.set(board, '$', { schema_version: 1, agent_id: TARGET, user_id: USER, session_id: 'p3_retention_session', content: 'Keep this exact board.', version: 1, updated_at: CREATED })
    const exactBoard = await redis.json.get(board)
    const page = await reports.report(context, 'portable', { targets: { subjects: [{ kind: 'primary', id: TARGET }] } })
    const input = { op: 'change', requestId: `${registry.boot}:p3-retention`, reportId: page.reportId, semanticId: 'agent.reasoning.retention', changes: { mode: 'both', whiteboardBudgetTokens: 250 } }
    const waiting = await changes.change(context, 'portable', input)
    expect(waiting).toMatchObject({ code: 'user_approval_required', status: 'awaiting_approval' })
    expect((await redis.json.get(`agent:${TARGET}`)).api_reasoning_retention).toBeUndefined()
    const review = await registry.humanReview(USER, waiting.operationId)
    expect(review.preview.targets[0].changes).toEqual(expect.arrayContaining([
      { field: 'mode', label: 'Reasoning Retention', before: null, after: 'both' },
      { field: 'whiteboardBudgetTokens', label: 'Whiteboard Budget', before: null, after: 250 }
    ]))
    await registry.decide(USER, waiting.operationId, waiting.intentDigest, 'approve')
    const saved: any = await changes.change(context, 'portable', input)
    expect(saved).toMatchObject({ status: 'completed', outcomes: [{ saved: 'saved', readback: 'verified' }] })
    expect(await redis.json.get(`agent:${TARGET}`)).toMatchObject({ api_reasoning_retention: 'both', whiteboard_budget_tokens: 250 })
    expect(await redis.json.get(board)).toEqual(exactBoard)
    const resetInput = { ...input, requestId: `${registry.boot}:p3-retention-reset`, reportId: saved.continuation.reportId, changes: { mode: null, whiteboardBudgetTokens: null } }
    const reset = await changes.change(context, 'portable', resetInput)
    expect(reset.status).toBe('awaiting_approval')
    await registry.decide(USER, reset.operationId, reset.intentDigest, 'approve')
    expect(await changes.change(context, 'portable', resetInput)).toMatchObject({ outcomes: [{ saved: 'saved', readback: 'verified' }] })
    const restored = await redis.json.get(`agent:${TARGET}`)
    expect(Object.hasOwn(restored, 'api_reasoning_retention')).toBe(false)
    expect(Object.hasOwn(restored, 'whiteboard_budget_tokens')).toBe(false)
    expect(await redis.json.get(board)).toEqual(exactBoard)
  })
  it('P3a rejects CLI API-field effects and stale raw API preimages at the actual conditional write', async () => {
    await configure()
    const authority = await readNativePolicyAuthority(USER, ACTOR)
    let before = await store.read(TARGET)
    await redis.json.set(`agent:${TARGET}`, '$.show_reasoning', false)
    expect(await store.write(TARGET, USER, 'api-presentation', before, { displayReasoning: true }, undefined,
      new AbortController().signal, Date.now() + 5000, { authorityFence: authority.fence })).toBe('CONFLICT')
    // SA-139 R5: the lower writer refuses a retired type, so the stored leftover is written directly.
    await redis.json.set(`agent:${TARGET}`, '$.agentType', 'cli')
    before = await store.read(TARGET)
    expect(await store.write(TARGET, USER, 'api-retention', before, { mode: 'both' }, undefined,
      new AbortController().signal, Date.now() + 5000, { authorityFence: authority.fence })).toBe('UNSUPPORTED_PRIMARY')
    expect((await redis.json.get(`agent:${TARGET}`)).api_reasoning_retention).toBeUndefined()
  })
  it('P4 core binds a held access report to one complete exact operation and fresh direct continuation', async () => {
    const { context } = await portable()
    const registry = createSettingsOperationRegistry(), reports = createSettingsManagementReports(registry.boot, store)
    const changes = createSettingsChanges(registry, reports, store)
    const key = `slash_command:${USER}:p4_core_skill`
    await redis.json.set(key, '$', { id: 'p4_core_skill', user_id: USER, type: 'skill', skill_id: 'p4_core_skill', displayName: 'Existing Skill',
      enabled_agent_ids: [ACTOR], enabled_for_all_agents: false, is_active: true, can_be_invoked_in_chat: true, instructions: 'Do not read or change this body.' })
    const page = await reports.report(context, 'portable', { domain: 'skill-access', targets: { subjects: [{ kind: 'primary', id: TARGET }] }, query: { skillIds: ['p4_core_skill'] } })
    expect(JSON.stringify(page)).not.toContain('Do not read or change this body.')
    const input = { op: 'change', requestId: `${registry.boot}:p4-core`, reportId: page.reportId, semanticId: 'agent.skills.access', changes: { assignments: [{ skillId: 'p4_core_skill', enabled: true }] } }
    const waiting = await changes.change(context, 'portable', input)
    expect(waiting.status).toBe('awaiting_approval')
    const review = await registry.humanReview(USER, waiting.operationId)
    expect(review.preview).toMatchObject({ semanticId: 'agent.skills.access', targets: [{ subject: { kind: 'primary', id: TARGET }, changes: [{ field: 'p4_core_skill', before: false, after: true }] }] })
    await registry.decide(USER, waiting.operationId, waiting.intentDigest, 'approve')
    const saved: any = await changes.change(context, 'portable', input)
    expect(saved).toMatchObject({ status: 'completed', outcomes: [{ saved: 'saved', readback: 'verified' }], continuation: { manifest: { targets: 1 } } })
    expect(await redis.json.get(key)).toMatchObject({ enabled_agent_ids: [ACTOR, TARGET], instructions: 'Do not read or change this body.' })
    await changes.change(context, 'portable', input)
    expect((await redis.json.get(key)).enabled_agent_ids).toEqual([ACTOR, TARGET])
  })

  it('Primary required skill/source cleanup precedes deletion and cannot grant a recreated same-ID agent', async () => {
    const command = `slash_command:${USER}:p3_delete_skill`, legacy = `slash_command:${USER}:p3_delete_unset`
    const source = `skill_source:${USER}:p3_delete_source`, unsetSource = `skill_source:${USER}:p3_delete_unset`
    await redis.json.set(command, '$', { id: 'p3_delete_skill', user_id: USER, type: 'skill', skill_id: 'p3_delete_skill',
      enabled_agent_ids: [TARGET, ACTOR], enabled_for_all_agents: false, is_active: true, can_be_invoked_in_chat: true, extension: { keep: true } })
    await redis.json.set(legacy, '$', { id: 'p3_delete_unset', user_id: USER, type: 'skill', skill_id: 'p3_delete_unset' })
    await redis.json.set(source, '$', { id: 'p3_delete_source', user_id: USER, enabled_agent_ids: [TARGET, ACTOR], enabled_for_all_agents: false, extension: { keep: true } })
    await redis.json.set(unsetSource, '$', { id: 'p3_delete_unset', user_id: USER, extension: { absent: true } })
    await redis.deleteAgent(TARGET)
    expect(await redis.exists(`agent:${TARGET}`)).toBe(false)
    expect(await redis.json.get(command)).toMatchObject({ enabled_agent_ids: [ACTOR], extension: { keep: true } })
    expect(await redis.json.get(source)).toMatchObject({ enabled_agent_ids: [ACTOR], extension: { keep: true } })
    expect(Object.hasOwn(await redis.json.get(legacy), 'enabled_agent_ids')).toBe(false)
    expect(Object.hasOwn(await redis.json.get(unsetSource), 'enabled_agent_ids')).toBe(false)
    await redis.createAgent({ id: TARGET, user_id: USER, agentType: 'api', displayName: 'Replacement', created_at: CREATED })
    expect(commandEnabledForAgent(await redis.json.get(command), TARGET)).toBe(false)
    expect((await redis.json.get(source)).enabled_agent_ids).not.toContain(TARGET)
  })
  it('Primary known no-effect cleanup conflict retains the record/index without permanent replacement or restore custody', async () => {
    const key = `slash_command:${USER}:p3_delete_conflict`
    await redis.json.set(key, '$', { id: 'p3_delete_conflict', user_id: USER, type: 'skill', skill_id: 'p3_delete_conflict', enabled_agent_ids: [TARGET] })
    const client = await redis.execute(async current => current), actual = client.eval.bind(client)
    let intercepted = false
    const spy = vi.spyOn(client, 'eval').mockImplementation((async (script: string, options: any) => {
      if (script === SET_SLASH_COMMAND_AGENT_ACCESS_SCRIPT && !intercepted) { intercepted = true; await client.set(slashCommandRevisionKey(USER), newSlashCommandRevision()) }
      return actual(script, options)
    }) as never)
    try { await expect(redis.deleteAgent(TARGET)).rejects.toMatchObject({ code: 'SLASH_COMMAND_CONFLICT', outcome: 'not_written', status: 409 }) }
    finally { spy.mockRestore() }
    expect(intercepted).toBe(true)
    expect(await redis.exists(`agent:${TARGET}`)).toBe(true)
    expect(await redis.execute(current => current.sIsMember(`user:${USER}:agents`, TARGET))).toBe(1)
    expect((await redis.json.get(key)).enabled_agent_ids).toEqual([TARGET])
    await expect(withSettingsRecordReplacement(`agent:${TARGET}`, async () => 'available')).resolves.toBe('available')
    await expect(withSettingsRestoreFence(async () => 'available')).resolves.toBe('available')
  })
  it('Primary final catalogue CAS retains its owner when a new alias appears after complete cleanup (BL1626)', async () => {
    const commandId = 'p3_late_alias', key = `slash_command:${USER}:${commandId}`
    const client = await redis.execute(async current => current), actual = client.eval.bind(client)
    let created = false
    const spy = vi.spyOn(client, 'eval').mockImplementation((async (script: string, options: any) => {
      if (script === DELETE_AGENT_WITH_WHITEBOARDS_SCRIPT && !created) {
        created = true
        const preparation = beginSlashCommandWrite(USER)
        const basis = await captureSlashCommandWriteBasis(preparation, [commandId])
        await saveSlashCommandRecord(USER, { mode: 'create', record: { id: commandId, user_id: USER, type: 'skill', skill_id: commandId,
          name: 'Late alias', displayName: 'Late alias', enabled_agent_ids: [TARGET], enabled_for_all_agents: false, is_active: true,
          can_be_invoked_in_chat: true, created_at: CREATED, updated_at: CREATED } as never }, basis)
      }
      return actual(script, options)
    }) as never)
    try { await expect(redis.deleteAgent(TARGET)).rejects.toMatchObject({ code: 'SUBJECT_POPULATION_CONFLICT', uncertain: false, status: 409 }) }
    finally { spy.mockRestore() }
    expect(created).toBe(true)
    expect(await redis.exists(`agent:${TARGET}`)).toBe(true)
    expect((await redis.json.get(key)).enabled_agent_ids).toEqual([TARGET])
    // An explicit fresh delete can now see and remove that reference; there is no internal retry.
    await redis.deleteAgent(TARGET)
    expect(await redis.exists(`agent:${TARGET}`)).toBe(false)
    expect((await redis.json.get(key)).enabled_agent_ids).toEqual([])
  })

  it('BL1628 reports and changes long canonical IDs while preserving unavailable legacy rows/exclusions in direct continuation', async () => {
    const id = 'long_'.repeat(40), legacy = 'odd.id'
    await redis.createAgent({ id, user_id: USER, agentType: 'api', displayName: 'Long Primary', created_at: CREATED })
    await redis.json.set(`subagent:${legacy}`, '$', { id: legacy, user_id: USER, subagentType: 'api', displayName: 'Legacy', created_at: CREATED })
    await redis.execute(client => client.sAdd(`user:${USER}:subagents`, legacy))
    const native = await nativePolicyResponse(USER, id)
    expect(isAppActionsNativePolicyResponse(native)).toBe(true)
    expect(native.subjects).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: { kind: 'primary', id }, available: true }),
      expect.objectContaining({ subject: { kind: 'subagent', id: legacy }, available: false, reason: 'unsupported_subject_id' })
    ]))
    await saveNativePolicy(USER, id, { expectedGeneration: 0, expectedSubjectRevision: native.subjectRevision, policy: policy() })
    await expect(readPortableAppActionsAuthority(USER, 'x'.repeat(129))).rejects.toMatchObject({ code: 'INVALID_ID' })
    const { context } = await portable()
    const registry = createSettingsOperationRegistry(), reports = createSettingsManagementReports(registry.boot, store)
    const changes = createSettingsChanges(registry, reports, store)
    const page = await reports.report(context, 'portable', { targets: { allAgents: true, except: [{ kind: 'primary', id: ACTOR }] } })
    expect(page.report.rows).toEqual(expect.arrayContaining([expect.objectContaining({ subject: { kind: 'subagent', id: legacy }, status: 'unavailable', reason: 'unsupported_subject_id' })]))
    const result: any = await changes.change(context, 'portable', { op: 'change', requestId: `${registry.boot}:long-id`, reportId: page.reportId,
      semanticId: 'agent.identity', changes: { displayName: 'Updated canonical agents' } })
    expect(result).toMatchObject({ status: 'completed', outcomesSummary: { applied: 2, unavailable: 1 }, continuation: { manifest: { targets: 3, excluded: 1 } } })
    expect((await redis.json.get(`agent:${id}`)).displayName).toBe('Updated canonical agents')
    expect((await redis.json.get(`subagent:${legacy}`)).displayName).toBe('Legacy')
    const continued = await reports.report(context, 'portable', { reportId: result.continuation.reportId })
    expect(continued.report.rows).toEqual(expect.arrayContaining([expect.objectContaining({ subject: { kind: 'subagent', id: legacy }, status: 'unavailable', reason: 'unsupported_subject_id' })]))
    expect(continued.report.manifest).toMatchObject({ targets: 3, excluded: 1 })
  })
  // SA-139 R4 removed the CLI Primary reasoning pair (`agent.reasoning.cli`, the `cli-reasoning` family) and its P3b cases.
  it('refuses the retired CLI reasoning setting at the actual report owner and leaves a leftover CLI Primary untouched', async () => {
    const leftover = 'p3b_retired_cli'
    await redis.createAgent({ id: leftover, user_id: USER, agentType: 'cli', displayName: 'Retired CLI', show_reasoning: true, preserve_reasoning: true })
    const before = await redis.json.get(`agent:${leftover}`)
    const { context } = await portable()
    const reports = createSettingsManagementReports(createSettingsOperationRegistry().boot, store)
    await expect(reports.report(context, 'portable', { targets: { subjects: [{ kind: 'primary', id: leftover }] }, focus: ['agent.reasoning.cli'] }))
      .rejects.toThrow('unadopted_report_setting')
    expect(await redis.json.get(`agent:${leftover}`)).toEqual(before)
  })
  async function a6Fixture(mode: 'ask' | 'allow' = 'ask') {
    const grantPolicy = policy(); grantPolicy.protected.instructions = mode
    const authorized = await portable(60000, grantPolicy)
    const registry = createSettingsOperationRegistry()
    const instructionStore = { ...managedSettingsStore }
    const reports = createSettingsManagementReports(registry.boot, instructionStore)
    const changes = createSettingsChanges(registry, reports, instructionStore)
    return { ...authorized, registry, instructionStore, reports, changes }
  }
  let a6Targets: { subjects: Array<{ kind: string; id: string }> }
  let a6Report: { targets: typeof a6Targets; focus: string[] }
  async function a6Input(f: Awaited<ReturnType<typeof a6Fixture>>, replacement: Record<string, unknown>, request = 'instructions') {
    const report = await f.reports.report(f.context, 'portable', a6Report)
    return { op: 'change', requestId: `${f.registry.boot}:${request}`, reportId: report.reportId, semanticId: 'agent.instructions', changes: replacement }
  }

  it('A6 keeps default metadata private and explicit text cursors immutable, bounded and currently authorized', async () => {
    const text = 'A6_PRIVATE_TEXT_α🖤<tag>\n'.repeat(6000)
    await redis.json.set(`agent:${TARGET}`, '$.system_prompt', text)
    const f = await a6Fixture()
    const summary = await f.reports.report(f.context, 'portable', { targets: a6Targets })
    expect(Buffer.byteLength(JSON.stringify(summary), 'utf8')).toBeLessThanOrEqual(8192)
    expect(JSON.stringify(summary)).not.toMatch(/A6_PRIVATE_TEXT|promptPreimage|system_prompt/)
    let page = await f.reports.report(f.context, 'portable', { ...a6Report, detail: 'values', query: { instructionText: true } })
    const reportId = page.reportId
    let joined = '', count = 0, lastCursor: string | null = null
    await redis.json.set(`agent:${TARGET}`, '$.system_prompt', 'A newer saved value')
    while (true) {
      count++
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(24576)
      expect(JSON.stringify(page)).not.toContain('promptPreimage')
      joined += (page.report as any).text ?? ''
      lastCursor = page.report.continuation.nextCursor
      if (!lastCursor) break
      page = await f.reports.report(f.context, 'portable', { reportId, cursor: lastCursor })
    }
    expect(count).toBeGreaterThan(1); expect(joined).toBe(text)
    const current = await portableGrantResponse(USER, f.token.record.id)
    await savePortableGrant(USER, f.token.record.id, { expectedAuthorityGeneration: current.authorityGeneration, grant: null })
    await expect(f.reports.report(f.context, 'portable', { reportId })).rejects.toMatchObject({ code: 'TOKEN_NOT_ALLOWED' })
  })

  it('A6 binds a metadata ticket to exact raw text even when another equal-length prompt is saved', async () => {
    await redis.json.set(`agent:${TARGET}`, '$.system_prompt', 'first')
    const f = await a6Fixture('allow'); const input = await a6Input(f, { customPrompt: 'after' })
    await redis.json.set(`agent:${TARGET}`, '$.system_prompt', 'other')
    const result = await f.changes.change(f.context, 'portable', input)
    expect(result).toMatchObject({ status: 'completed', outcomesSummary: { conflict: 1, applied: 0 } })
    expect((await redis.json.get(`agent:${TARGET}`)).system_prompt).toBe('other')
  })

  it('A6 reviews exact deduplicated text for both live lanes and saves only the admitted fixed leaves once', async () => {
    const subjects = [{ kind: 'primary', id: TARGET }, { kind: 'subagent', id: 'a6_api' }]
    await redis.json.set(`agent:${TARGET}`, '$.system_prompt', 'before')
    // SA-139 R4/R5: a leftover CLI Primary (R4) or CLI Subagent (R5) is unavailable to Instructions and is never written.
    await redis.createAgent({ id: 'a6_cli_primary', user_id: USER, agentType: 'cli', displayName: 'CLI', created_at: CREATED, system_prompt: 'before' })
    for (const type of ['api', 'cli']) {
      const id = `a6_${type}`
      await redis.json.set(`subagent:${id}`, '$', { id, user_id: USER, subagentType: type, displayName: type, created_at: CREATED, system_prompt: 'before', sibling: { zero: 0, off: false } })
      await redis.sAdd(`user:${USER}:subagents`, id)
    }
    // SA-139 R2: a removed n8n Workflow Subagent is unavailable to Instructions and is never written.
    await redis.json.set('subagent:a6_n8n_workflow', '$', { id: 'a6_n8n_workflow', user_id: USER, subagentType: 'n8n-workflow', displayName: 'n8n-workflow', created_at: CREATED, system_prompt: 'before' })
    await redis.sAdd(`user:${USER}:subagents`, 'a6_n8n_workflow')
    const f = await a6Fixture(); const report = await f.reports.report(f.context, 'portable', { targets: { allAgents: true, except: [{ kind: 'primary', id: ACTOR }] }, focus: ['agent.instructions'] })
    const replacement = '  AFTER_<tag>🖤\n  '
    const input = { op: 'change', requestId: `${f.registry.boot}:five`, reportId: report.reportId, semanticId: 'agent.instructions', changes: { customPrompt: replacement, includeGlobalPrompt: null } }
    const waiting = await f.changes.change(f.context, 'portable', input)
    expect(waiting).toMatchObject({ status: 'awaiting_approval', code: 'user_approval_required' })
    expect(JSON.stringify(waiting)).not.toMatch(/before|AFTER_|text_0|instructionTexts/)
    const review = await f.registry.humanReview(USER, waiting.operationId)
    expect(review.preview.targets).toHaveLength(2); expect(review.preview.excluded).toEqual([{ kind: 'primary', id: ACTOR }])
    expect(review.preview.instructions!.texts.map(row => row.text)).toEqual(['before', replacement, replacement.trim()])
    expect(review.preview.instructions!.targets).toHaveLength(2)
    await f.registry.decide(USER, waiting.operationId, waiting.intentDigest, 'approve')
    const complete = await f.changes.change(f.context, 'portable', input)
    expect(complete).toMatchObject({ status: 'completed', outcomesSummary: { applied: 2, unavailable: 3 }, continuation: { manifest: { targets: 5, excluded: 1 } } })
    expect(complete.outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ subject: { kind: 'primary', id: 'a6_cli_primary' }, status: 'unavailable', saved: 'not_requested' }),
      expect.objectContaining({ subject: { kind: 'subagent', id: 'a6_cli' }, status: 'unavailable', saved: 'not_requested' })]))
    expect(JSON.stringify(complete)).not.toMatch(/before|AFTER_|text_0|promptPreimage/)
    for (const subject of subjects) {
      const saved = await redis.json.get(`${subject.kind === 'primary' ? 'agent' : 'subagent'}:${subject.id}`)
      expect(saved.system_prompt).toBe(subject.kind === 'primary' ? replacement : replacement.trim())
      expect(saved.include_global_prompt).toBeNull()
      if (subject.kind === 'subagent') expect(saved.sibling).toEqual({ zero: 0, off: false })
    }
    expect(await redis.json.get('subagent:a6_n8n_workflow')).toMatchObject({ system_prompt: 'before' })
    expect(await redis.json.get('agent:a6_cli_primary')).toMatchObject({ system_prompt: 'before' })
    expect(await redis.json.get('subagent:a6_cli')).toMatchObject({ system_prompt: 'before', sibling: { zero: 0, off: false } })
    const spy = vi.spyOn(redis, 'updateAgent')
    try { expect((await f.changes.change(f.context, 'portable', input)).operationId).toBe(complete.operationId); expect(spy).not.toHaveBeenCalled() }
    finally { spy.mockRestore() }
  })

  it('A6 inclusion-only preparation and issue ignore a changed custom prompt while custom-only ignores inclusion', async () => {
    await redis.json.set(`agent:${TARGET}`, '$.system_prompt', 'before')
    const f = await a6Fixture('allow'); const input = await a6Input(f, { includeGlobalPrompt: false })
    await redis.json.set(`agent:${TARGET}`, '$.system_prompt', 'Changed independently')
    expect(await f.changes.change(f.context, 'portable', input)).toMatchObject({ status: 'completed', outcomesSummary: { applied: 1 } })
    expect(await redis.json.get(`agent:${TARGET}`)).toMatchObject({ system_prompt: 'Changed independently', include_global_prompt: false })
    const prompt = await a6Input(f, { customPrompt: 'After independent inclusion' }, 'prompt-only')
    await redis.json.set(`agent:${TARGET}`, '$.include_global_prompt', true)
    expect(await f.changes.change(f.context, 'portable', prompt)).toMatchObject({ status: 'completed', outcomesSummary: { applied: 1 } })
    expect(await redis.json.get(`agent:${TARGET}`)).toMatchObject({ system_prompt: 'After independent inclusion', include_global_prompt: true })
  })

  it('A6 native Ask holds full user-only text and genuine Stop refuses before any write', async () => {
    await configure()
    await redis.json.set(`agent:${TARGET}`, '$.system_prompt', 'Native private before')
    const abort = new AbortController(), registry = createSettingsOperationRegistry()
    const reports = createSettingsManagementReports(registry.boot, managedSettingsStore)
    const changes = createSettingsChanges(registry, reports, managedSettingsStore)
    const context = { userId: USER, actorType: 'in-process', agentId: ACTOR, sessionId: 'a6_native_owner', abortSignal: abort.signal }
    const report = await reports.report(context, 'native', a6Report)
    const input = { op: 'change', requestId: `${registry.boot}:native`, reportId: report.reportId, semanticId: 'agent.instructions', changes: { customPrompt: 'Native after' } }
    const held = await changes.prepare(context, 'native', input)
    expect(held.operation.status).toBe('awaiting_approval')
    const review = registry.nativeApprovalPreview(USER, ACTOR, context.sessionId, input.requestId)!
    expect(review.preview.instructions!.texts.map(row => row.text)).toEqual(['Native private before', 'Native after'])
    expect(JSON.stringify(held.operation)).not.toMatch(/Native private before|Native after/)
    abort.abort()
    await expect(changes.change({ ...context, settingsNativeGate() {} }, 'native', input)).rejects.toMatchObject({ code: 'CONTROL_CANCELLATION_REQUIRED' })
    expect((await redis.json.get(`agent:${TARGET}`)).system_prompt).toBe('Native private before')
  })

  it('A6 refuses an incomplete oversized review before capture and still admits independent inclusion-only changes', async () => {
    const f = await a6Fixture('allow')
    await redis.json.set(`agent:${TARGET}`, '$.system_prompt', 'long'.repeat(20000))
    const input = await a6Input(f, { customPrompt: 'After' }, 'over-preview')
    const capture = vi.spyOn(f.registry, 'capture')
    try {
      await expect(f.changes.change(f.context, 'portable', input)).rejects.toMatchObject({ code: 'INSTRUCTIONS_PREVIEW_UNAVAILABLE', status: 409 })
      expect(capture).not.toHaveBeenCalled()
    } finally { capture.mockRestore() }
    const oversized = 'large'.repeat(60000)
    await redis.json.set(`agent:${TARGET}`, '$.system_prompt', oversized)
    const unavailable = await a6Input(f, { customPrompt: 'After' }, 'over-read')
    expect(await f.changes.change(f.context, 'portable', unavailable)).toMatchObject({ status: 'completed',
      outcomesSummary: { unavailable: 1 }, outcomes: [expect.objectContaining({ reason: 'instructions_text_too_large', saved: 'not_requested' })] })
    const include = await a6Input(f, { includeGlobalPrompt: false }, 'large-prompt-inclusion')
    expect(await f.changes.change(f.context, 'portable', include)).toMatchObject({ status: 'completed', outcomesSummary: { applied: 1 } })
    expect((await redis.json.get(`agent:${TARGET}`)).system_prompt).toBe(oversized)
  })

  it('A6 records a known save before held readback and keeps that evidence after readback failure', async () => {
    const f = await a6Fixture('allow'); const input = await a6Input(f, { customPrompt: 'Known saved' })
    const prepared = await f.changes.prepare(f.context, 'portable', input)
    let release!: () => void, entered = false
    const gate = new Promise<void>(resolve => { release = resolve })
    const spy = vi.spyOn(f.instructionStore, 'readInstructions').mockImplementation(async () => { entered = true; await gate; throw new Error('Fixture lost readback') })
    try {
      const flight = f.changes.change(f.context, 'portable', input)
      await vi.waitFor(() => expect(entered).toBe(true))
      expect(f.registry.outcome(prepared.operation.operationId, prepared.admission.actor).outcomes).toEqual([expect.objectContaining({ saved: 'saved' })])
      release()
      expect(await flight).toMatchObject({ status: 'completed', outcomesSummary: { applied: 1 }, outcomes: [expect.objectContaining({ saved: 'saved', readback: 'unavailable' })] })
    } finally { release(); spy.mockRestore() }
    expect((await redis.json.get(`agent:${TARGET}`)).system_prompt).toBe('Known saved')
  })

  it('A6 actual portable wrappers expose full text only on explicit read or authenticated human Ask review', async () => {
    await redis.json.set(`agent:${TARGET}`, '$.system_prompt', 'WRAPPER_PRIVATE_BEFORE')
    const f = await a6Fixture()
    const call = async (controlId: string, input: unknown) => {
      const response = await useControlsRoute({ request: new Request('http://localhost/api/controls/use', { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-batshit-portable-token': f.token.token }, body: JSON.stringify({ controlId, input }) }), locals: {} } as never)
      const body = await response.json(); expect(response.status).toBe(200); expect(body.success).toBe(true); return body.result
    }
    const report = await call('sys.app_settings.portable.report', a6Report)
    expect(JSON.stringify(report)).not.toContain('WRAPPER_PRIVATE_BEFORE')
    const explicit = await call('sys.app_settings.portable.report', { ...a6Report, detail: 'values', query: { instructionText: true } })
    expect(explicit.report.text).toBe('WRAPPER_PRIVATE_BEFORE')
    const input = { op: 'change', requestId: `${report.bootNamespace}:a6-wrapper`, reportId: report.reportId, semanticId: 'agent.instructions', changes: { customPrompt: 'WRAPPER_AFTER' } }
    const waiting = await call('sys.app_settings.portable.change', input)
    expect(waiting).toMatchObject({ code: 'user_approval_required', status: 'awaiting_approval' })
    expect(JSON.stringify(waiting)).not.toMatch(/WRAPPER_PRIVATE|WRAPPER_AFTER/)
    const url = new URL(`http://localhost/api/app/settings/operations/${waiting.operationId}`)
    const event = { url, params: { operationId: waiting.operationId }, locals: { user: { id: USER }, session: { token: 'owned-human-fixture', user_id: USER } } }
    const reviewResponse = await readOperationRoute({ ...event, request: new Request(url, { headers: { origin: url.origin } }) } as never)
    expect(reviewResponse.status).toBe(200)
    const review = await reviewResponse.json()
    expect(review.operation.preview.instructions.texts.map((row: any) => row.text)).toEqual(['WRAPPER_PRIVATE_BEFORE', 'WRAPPER_AFTER'])
    const decision = await decideOperationRoute({ ...event, request: new Request(`${url}/decision`, { method: 'POST', headers: { origin: url.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ intentDigest: waiting.intentDigest, decision: 'approve' }) }) } as never)
    expect(decision.status).toBe(200)
    const complete = await call('sys.app_settings.portable.change', input)
    expect(complete).toMatchObject({ status: 'completed', outcomesSummary: { applied: 1 } })
    expect(JSON.stringify(complete)).not.toMatch(/WRAPPER_PRIVATE|WRAPPER_AFTER/)
    expect((await redis.json.get(`agent:${TARGET}`)).system_prompt).toBe('WRAPPER_AFTER')
  })

  it('A6 final physical issue refuses changed authority and an expired captured deadline before any write', async () => {
    const f = await a6Fixture('allow'), input = await a6Input(f, { customPrompt: 'Must not save' }, 'last-authority')
    await f.changes.prepare(f.context, 'portable', input)
    const actualExecute = redis.execute.bind(redis)
    let changed = false
    function intercepted(client: any): any {
      return new Proxy(client, { get(object, property) {
        if (property === 'withAbortSignal') return (signal: AbortSignal) => intercepted(object.withAbortSignal(signal))
        if (property === 'eval') return async (script: string, options: any) => {
          if (!changed && script.includes('local guard = ARGV[5]') && options.keys[0] === `agent:${TARGET}`) {
            changed = true
            await object.json.set(`portable_skill_token:${USER}:${f.token.record.id}`, '$.authorityGeneration', f.saved.authorityGeneration + 1)
          }
          return object.eval(script, options)
        }
        const value = Reflect.get(object, property, object); return typeof value === 'function' ? value.bind(object) : value
      } })
    }
    const before = await redis.json.getRaw(`agent:${TARGET}`, '$')
    const spy = vi.spyOn(redis, 'execute').mockImplementation((operation: any) => actualExecute(client => operation(intercepted(client))))
    try { expect(await f.changes.change(f.context, 'portable', input)).toMatchObject({ outcomesSummary: { conflict: 1, applied: 0 } }) }
    finally { spy.mockRestore() }
    expect(changed).toBe(true); expect(await redis.json.getRaw(`agent:${TARGET}`, '$')).toBe(before)

    const next = await a6Fixture('allow'), authority = await readPortableAppActionsAuthority(USER, next.token.record.id)
    const client = await redis.execute(async connection => connection)
    const snapshot = await readInstructionsSnapshot(client, TARGET, 'agent', undefined, ['customPrompt'])
    const actualEval = client.eval.bind(client)
    let writes = 0
    const late = vi.spyOn(client, 'eval').mockImplementation((async (script: string, options: any) => {
      if (script.includes('local guard = ARGV[5]') && options.keys[0] === `agent:${TARGET}`) { writes++; await new Promise(resolve => setTimeout(resolve, 75)) }
      return actualEval(script, options)
    }) as never)
    const onSaved = vi.fn()
    try {
      await expect(redis.updateAgent(TARGET, { system_prompt: 'Past deadline' }, { expectedInstructions: snapshot.revisions,
        instructionsMutation: { target: snapshot, authority: authority.fence, deadlineAt: Date.now() + 50, check() {}, onSaved } })).rejects.toMatchObject({ code: 'instructions_settings_changed', status: 409 })
    } finally { late.mockRestore() }
    expect(writes).toBe(1); expect(onSaved).not.toHaveBeenCalled(); expect(await redis.json.getRaw(`agent:${TARGET}`, '$')).toBe(before)
    await expect(withSettingsRecordReplacement(`agent:${TARGET}`, async () => 'settled')).resolves.toBe('settled')
  })



  async function a7Fixture(mode: 'ask' | 'allow' = 'ask') {
    const grantPolicy = policy(); grantPolicy.protected.contextManagement = mode
    const authorized = await portable(60000, grantPolicy), registry = createSettingsOperationRegistry()
    const reports = createSettingsManagementReports(registry.boot, managedSettingsStore)
    const changes = createSettingsChanges(registry, reports, managedSettingsStore)
    return { ...authorized, registry, reports, changes }
  }
  async function a7Input(f: Awaited<ReturnType<typeof a7Fixture>>, replacement: Record<string, unknown>, request = 'compact', targets: any = { subjects: [{ kind: 'primary', id: TARGET }] }) {
    const report = await f.reports.report(f.context, 'portable', { targets, focus: ['agent.context.auto-compact'] })
    return { op: 'change', requestId: `${f.registry.boot}:${request}`, reportId: report.reportId, semanticId: 'agent.context.auto-compact', changes: replacement }
  }
  it('A7 portable Ask reviews exact common values/exclusions, executes only on one human decision and preserves advanced siblings', async () => {
    await redis.json.set(`agent:${TARGET}`, '$.auto_compact_settings', { mode: 'ask', triggerMode: 'smart', prompt: 'PRIVATE_ADVANCED', future: { keep: true } })
    const f = await a7Fixture(), input = await a7Input(f, { mode: 'auto', remainingTokens: null })
    const waiting = await f.changes.change(f.context, 'portable', input)
    expect(waiting).toMatchObject({ status: 'awaiting_approval', outcomesSummary: { applied: 0 } })
    expect((await redis.json.get(`agent:${TARGET}`)).auto_compact_settings.mode).toBe('ask')
    const review = await f.registry.humanReview(USER, waiting.operationId)
    expect(review.preview.targets[0]).toMatchObject({ subject: { kind: 'primary', id: TARGET }, changes: [{ field: 'mode', before: 'ask', after: 'auto' }, { field: 'remainingTokens', before: '(unset)', after: null }] })
    expect(JSON.stringify(review)).not.toContain('PRIVATE_ADVANCED')
    await f.registry.decide(USER, waiting.operationId, waiting.intentDigest, 'approve')
    const complete = await f.changes.change(f.context, 'portable', input)
    expect(complete).toMatchObject({ status: 'completed', outcomesSummary: { applied: 1 } })
    expect((await redis.json.get(`agent:${TARGET}`)).auto_compact_settings).toEqual({ mode: 'auto', triggerMode: 'smart', remainingTokens: null, prompt: 'PRIVATE_ADVANCED', future: { keep: true } })
    const spy = vi.spyOn(redis, 'updateAgent'); try { await f.changes.change(f.context, 'portable', input); expect(spy).not.toHaveBeenCalled() } finally { spy.mockRestore() }
  })
  it('A7 target accounting keeps delegated unavailable rows and inherited global races conflict without early effects', async () => {
    await redis.json.set(`subagent:a7_sub`, '$', { id: 'a7_sub', user_id: USER, subagentType: 'api', displayName: 'Sub', created_at: CREATED })
    await redis.sAdd(`user:${USER}:subagents`, 'a7_sub')
    await redis.json.set(`user:${USER}:settings`, '$', { global_auto_compact_settings: { mode: 'ask', triggerMode: 'remaining_tokens', remainingTokens: 4000, prompt: 'PRIVATE_GLOBAL' } })
    const f = await a7Fixture('allow'), input = await a7Input(f, { mode: 'auto' }, 'global-race', { subjects: [{ kind: 'primary', id: TARGET }, { kind: 'subagent', id: 'a7_sub' }] })
    await f.changes.prepare(f.context, 'portable', input)
    await redis.json.set(`user:${USER}:settings`, '$.global_auto_compact_settings.remainingTokens', 5000)
    const result = await f.changes.change(f.context, 'portable', input)
    expect(result).toMatchObject({ outcomesSummary: { conflict: 1, unavailable: 1, applied: 0 } })
    expect((await redis.json.get(`agent:${TARGET}`)).auto_compact_settings).toBeUndefined()
    expect(await redis.json.get('subagent:a7_sub')).not.toHaveProperty('auto_compact_settings')
  })
  it('A7 native default Context Ask and current Stop retain the original preview without an effect', async () => {
    await configure()
    const abort = new AbortController(), registry = createSettingsOperationRegistry(), reports = createSettingsManagementReports(registry.boot, managedSettingsStore)
    const changes = createSettingsChanges(registry, reports, managedSettingsStore)
    const context = { userId: USER, actorType: 'in-process', agentId: ACTOR, sessionId: 'a7_native_owner', abortSignal: abort.signal }
    const report = await reports.report(context, 'native', { targets: { subjects: [{ kind: 'primary', id: TARGET }] }, focus: ['agent.context.auto-compact'] })
    const input = { op: 'change', requestId: `${registry.boot}:a7-native`, reportId: report.reportId, semanticId: 'agent.context.auto-compact', changes: { mode: 'off' } }
    const held = await changes.prepare(context, 'native', input)
    expect(held.operation.status).toBe('awaiting_approval')
    expect(registry.nativeApprovalPreview(USER, ACTOR, context.sessionId, input.requestId)!.preview.targets[0].changes[0]).toMatchObject({ field: 'mode', before: '(unset)', after: 'off' })
    abort.abort()
    await expect(changes.change({ ...context, settingsNativeGate() {} }, 'native', input)).rejects.toMatchObject({ code: 'CONTROL_CANCELLATION_REQUIRED' })
    expect(await redis.json.get(`agent:${TARGET}`)).not.toHaveProperty('auto_compact_settings')
  })
  it('A8 portable default Ask holds exact enable/automatic mode changes and executes only the original ready source', async () => {
    await redis.json.set(`agent:${TARGET}`, '$.memory_window', { floor_mode: 'custom', ceiling_headroom_mode: 'custom', floor_tokens: 64000, summary_model_mode: 'current', keep: true })
    await redis.json.set('batshit:memory_config', '$', { embedding: { lane: 'api', modelId: 'configured', api: { provider: 'openai', modelName: 'embedding', dims: 384 } } })
    const { context } = await portable()
    const registry = createSettingsOperationRegistry(), reports = createSettingsManagementReports(registry.boot, store), changes = createSettingsChanges(registry, reports, store)
    const page = await reports.report(context, 'portable', { targets: { subjects: [{ kind: 'primary', id: TARGET }] }, focus: ['agent.memory.preferences'] })
    expect(JSON.stringify(page.report)).toContain('configuration-ready')
    const input = { op: 'change', requestId: `${registry.boot}:a8-ask`, reportId: page.reportId, semanticId: 'agent.memory.preferences', changes: { enabled: true, windowMode: 'auto' } }
    const waiting = await changes.change(context, 'portable', input)
    expect(waiting).toMatchObject({ status: 'awaiting_approval', code: 'user_approval_required' })
    const review = await registry.humanReview(USER, waiting.operationId)
    expect(review.preview.targets[0].changes).toEqual([
      { field: 'enabled', label: 'Memory Enabled', before: false, after: true },
      { field: 'floorMode', label: 'Memory Window Floor', before: 'custom', after: 'auto' },
      { field: 'ceilingHeadroomMode', label: 'Memory Window Headroom', before: 'custom', after: 'auto' }
    ])
    expect((await redis.json.get(`agent:${TARGET}`)).memory_window.floor_mode).toBe('custom')
    await registry.decide(USER, waiting.operationId, waiting.intentDigest, 'approve')
    expect(await changes.change(context, 'portable', input)).toMatchObject({ status: 'completed', outcomesSummary: { applied: 1 } })
    expect(await redis.json.get(`agent:${TARGET}`)).toMatchObject({ memory_enabled: true, memory_window: { floor_mode: 'auto', ceiling_headroom_mode: 'auto', floor_tokens: 64000, summary_model_mode: 'current', keep: true } })
  })

  it('A8 native default Memory Ask binds expanded modes, initial unavailable rows and the original configuration through review', async () => {
    await configure()
    await redis.json.set(`agent:${TARGET}`, '$.memory_window', { floor_mode: 'custom', ceiling_headroom_mode: 'auto' })
    await redis.json.set('batshit:memory_config', '$', { embedding: { lane: 'api', modelId: 'configured', api: { provider: 'openai', modelName: 'embedding', dims: 384 } } })
    const stopped = new AbortController(), context = { userId: USER, agentId: ACTOR, sessionId: 'a8_native', actorType: 'in-process', abortSignal: stopped.signal }
    const registry = createSettingsOperationRegistry(), reports = createSettingsManagementReports(registry.boot, store), changes = createSettingsChanges(registry, reports, store)
    const page = await reports.report(context, 'native', { targets: { subjects: [{ kind: 'primary', id: TARGET }, { kind: 'group', id: 'a8_group' }] }, focus: ['agent.memory.preferences'] })
    const input = { op: 'change', requestId: `${registry.boot}:a8-native`, reportId: page.reportId, semanticId: 'agent.memory.preferences', changes: { enabled: true, windowMode: 'auto' } }
    const prepared = await changes.prepare(context, 'native', input)
    expect(prepared.operation.status).toBe('awaiting_approval')
    const review = registry.nativeApprovalPreview(USER, ACTOR, context.sessionId, input.requestId)!
    expect(review.preview.targets[0].changes).toHaveLength(3)
    expect(review.initialOutcomes).toMatchObject([{ subject: { kind: 'group', id: 'a8_group' }, status: 'unavailable', saved: 'not_requested' }])
    await redis.json.set('batshit:memory_config', '$.embedding.api.modelName', 'changed')
    await expect(changes.prepare(context, 'native', input)).rejects.toMatchObject({ code: 'MEMORY_SOURCE_CHANGED' })
    expect((await redis.json.get(`agent:${TARGET}`)).memory_enabled).not.toBe(true)
    expect((await redis.json.get(`agent:${TARGET}`)).memory_window.floor_mode).toBe('custom')
    stopped.abort()
    await expect(changes.prepare(context, 'native', input)).rejects.toThrow()
  })


  it('A10 ordinary portable selection expands one owned profile, preserves raw siblings and never replays', async () => {
    const voice = { tts: { providerId: 'google', voiceId: 'Kore', style: { future: true } }, stt: { providerId: 'browser', future: [0] }, voiceSessionRuntime: 'direct', future: { keep: true } }
    await redis.json.set(`agent:${TARGET}`, '$.voice_profile', voice)
    await redis.createVoiceProfile({ id: 'a10_management_profile', user_id: USER, name: 'Saved browser', provider: 'browser', voiceId: 'system', created_at: CREATED, updated_at: CREATED })
    const { context } = await portable(), registry = createSettingsOperationRegistry()
    const reports = createSettingsManagementReports(registry.boot, managedSettingsStore), changes = createSettingsChanges(registry, reports, managedSettingsStore)
    const page = await reports.report(context, 'portable', { targets: { subjects: [{ kind: 'primary', id: TARGET }] }, focus: ['agent.voice.tts-selection'] })
    const input = { op: 'change', requestId: `${registry.boot}:a10-profile`, reportId: page.reportId, semanticId: 'agent.voice.tts-selection', changes: { selection: 'profile', profileId: 'a10_management_profile' } }
    const prepared = await changes.prepare(context, 'portable', input)
    expect(prepared.operation.status).toBe('ready')
    const review = await registry.humanReview(USER, prepared.operation.operationId)
    expect(review.preview.targets[0].changes.map(change => change.field)).toEqual(['providerId', 'modelId', 'voiceId', 'profileId'])
    expect(await changes.change(context, 'portable', input)).toMatchObject({ status: 'completed', outcomesSummary: { applied: 1 }, outcomes: [{ saved: 'saved', readback: 'verified', visible: 'unknown' }] })
    expect((await redis.json.get(`agent:${TARGET}`)).voice_profile).toEqual({ ...voice, tts: { ...voice.tts, providerId: 'browser', voiceId: 'system', profileId: 'a10_management_profile' } })
    const spy = vi.spyOn(redis, 'updateAgent')
    try { await changes.change(context, 'portable', input); expect(spy).not.toHaveBeenCalled() } finally { spy.mockRestore() }
  })
  it('A10 ordinary Block leaves report metadata available and refuses the selection before writes', async () => {
    const { context } = await portable(60000, { ...policy(), ordinaryChanges: false }), registry = createSettingsOperationRegistry()
    const reports = createSettingsManagementReports(registry.boot, managedSettingsStore), changes = createSettingsChanges(registry, reports, managedSettingsStore)
    const page = await reports.report(context, 'portable', { targets: { subjects: [{ kind: 'primary', id: TARGET }] }, focus: ['agent.voice.tts-selection'] })
    const spy = vi.spyOn(redis, 'updateAgent')
    try {
      await expect(changes.change(context, 'portable', { op: 'change', requestId: `${registry.boot}:a10-block`, reportId: page.reportId, semanticId: 'agent.voice.tts-selection', changes: { selection: 'provider', providerId: 'browser', modelId: null, voiceId: null } })).rejects.toMatchObject({ code: 'SETTINGS_CHANGE_BLOCKED' })
      expect(spy).not.toHaveBeenCalled()
    } finally { spy.mockRestore() }
  })
  it('A10 original native Stop retires a prepared ordinary selection without a write', async () => {
    await configure()
    const stopped = new AbortController(), context = { userId: USER, agentId: ACTOR, sessionId: 'a10_native', actorType: 'in-process', abortSignal: stopped.signal }
    const registry = createSettingsOperationRegistry(), reports = createSettingsManagementReports(registry.boot, managedSettingsStore), changes = createSettingsChanges(registry, reports, managedSettingsStore)
    const page = await reports.report(context, 'native', { targets: { subjects: [{ kind: 'primary', id: TARGET }] }, focus: ['agent.voice.tts-selection'] })
    const input = { op: 'change', requestId: `${registry.boot}:a10-stop`, reportId: page.reportId, semanticId: 'agent.voice.tts-selection', changes: { selection: 'provider', providerId: 'browser', modelId: null, voiceId: null } }
    expect((await changes.prepare(context, 'native', input)).operation.status).toBe('ready')
    stopped.abort()
    await expect(changes.change({ ...context, settingsNativeGate() {} }, 'native', input)).rejects.toThrow()
    expect((await redis.json.get(`agent:${TARGET}`)).voice_profile).toBeUndefined()
  })



  // These six cases intentionally retain real process-local unknown custody until
  // worker retirement. Fresh records prove each own-key available→held transition;
  // later global restore rejections observe the accumulated common refusal.
  // Every positive global restore case MUST remain above this final cohort.
  it('keeps an ambiguous authority command explicitly unknown after readback and holds replacement', async () => {
    await expect(withSettingsRecordReplacement(`agent:${ACTOR}`, async () => 'fixture-key-available')).resolves.toBe('fixture-key-available')
    const baseline = await nativePolicyResponse(USER, ACTOR)
    const client = await redis.execute(async connection => connection)
    const original = client.eval.bind(client)
    const spy = vi.spyOn(client, 'eval').mockImplementation(((script: string, options: any) =>
      script === SAVE_NATIVE_APP_ACTIONS_POLICY_SCRIPT ? Promise.reject(new Error('uncertain transport after issue')) : original(script, options)) as never)
    try {
      const url = new URL(`http://localhost/api/agents/${ACTOR}/app-actions-policy`)
      const response = await appActionsHumanRoute({ url, request: new Request(url, { method: 'PUT',
        headers: { origin: url.origin, 'content-type': 'application/json' }, body: JSON.stringify({ expectedGeneration: 0, expectedSubjectRevision: baseline.subjectRevision, policy: policy() }) }),
        locals: { user: { id: USER }, session: { token: 'test-human-session', user_id: USER } } as App.Locals }, (userId, body) => saveNativePolicy(userId, ACTOR, body))
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ success: false, code: 'AUTHORITY_SAVE_UNCONFIRMED' })
    } finally { spy.mockRestore() }
    expect((await nativePolicyResponse(USER, ACTOR)).generation).toBe(0)
    await expect(withSettingsRecordReplacement(`agent:${ACTOR}`, async () => {})).rejects.toThrow('unknown outcome')
  })
  it('Primary issued unknown cleanup retains its owner and exact replacement/restore hold without replay', async () => {
    await expect(withSettingsRecordReplacement(`agent:${TARGET}`, async () => 'fixture-key-available')).resolves.toBe('fixture-key-available')
    const key = `slash_command:${USER}:p3_delete_unknown`
    await redis.json.set(key, '$', { id: 'p3_delete_unknown', user_id: USER, type: 'skill', skill_id: 'p3_delete_unknown', enabled_agent_ids: [TARGET] })
    const client = await redis.execute(async current => current), actual = client.eval.bind(client)
    let issued = 0
    const spy = vi.spyOn(client, 'eval').mockImplementation((async (script: string, options: any) => {
      if (script === SET_SLASH_COMMAND_AGENT_ACCESS_SCRIPT) { issued++; await actual(script, options); throw new Error('Fixture lost the issued cleanup reply') }
      return actual(script, options)
    }) as never)
    try { await expect(redis.deleteAgent(TARGET)).rejects.toMatchObject({ code: 'SLASH_COMMAND_UNCONFIRMED', outcome: 'unknown', status: 503 }) }
    finally { spy.mockRestore() }
    expect(issued).toBe(1)
    expect(await redis.exists(`agent:${TARGET}`)).toBe(true)
    expect((await redis.json.get(key)).enabled_agent_ids).toEqual([])
    await expect(redis.createAgent({ id: TARGET, user_id: USER, agentType: 'api' })).rejects.toThrow('unknown')
    await expect(withSettingsRestoreFence(async () => 'must not run')).rejects.toThrow('unknown')
    expect(issued).toBe(1)
  })
  it('A6 actual issued answer loss retains custody and blocks remaining targets without replay', async () => {
    await expect(withSettingsRecordReplacement(`agent:${TARGET}`, async () => 'fixture-key-available')).resolves.toBe('fixture-key-available')
    const nextId = 'a6_unknown_next'
    await redis.json.set(`subagent:${nextId}`, '$', { id: nextId, user_id: USER, subagentType: 'api', displayName: 'Next', created_at: CREATED })
    await redis.sAdd(`user:${USER}:subagents`, nextId)
    const f = await a6Fixture('allow')
    const report = await f.reports.report(f.context, 'portable', { targets: { subjects: [{ kind: 'primary', id: TARGET }, { kind: 'subagent', id: nextId }] }, focus: ['agent.instructions'] })
    const input = { op: 'change', requestId: `${f.registry.boot}:unknown-instructions`, reportId: report.reportId, semanticId: 'agent.instructions', changes: { customPrompt: 'ISSUED_UNKNOWN' } }
    let issued = 0
    const actualExecute = redis.execute.bind(redis)
    function intercepted(client: any): any {
      return new Proxy(client, { get(object, property) {
        if (property === 'withAbortSignal') return (signal: AbortSignal) => intercepted(object.withAbortSignal(signal))
        if (property === 'eval') return async (script: string, options: any) => {
          const result = await object.eval(script, options)
          if (script.includes('local guard = ARGV[5]') && options.keys[0] === `agent:${TARGET}`) { issued++; throw new Error('Fixture lost issued instruction reply') }
          return result
        }
        const value = Reflect.get(object, property, object); return typeof value === 'function' ? value.bind(object) : value
      } })
    }
    const spy = vi.spyOn(redis, 'execute').mockImplementation((operation: any) => actualExecute(client => operation(intercepted(client))))
    try {
      const result = await f.changes.change(f.context, 'portable', input)
      expect(result).toMatchObject({ outcomesSummary: { unknown: 1, blocked: 1 } })
      expect(issued).toBe(1)
      expect((await redis.json.get(`agent:${TARGET}`)).system_prompt).toBe('ISSUED_UNKNOWN')
      expect(await redis.json.get(`subagent:${nextId}`)).not.toHaveProperty('system_prompt')
      await f.changes.change(f.context, 'portable', input); expect(issued).toBe(1)
      await expect(withSettingsRecordReplacement(`agent:${TARGET}`, async () => 'must-not-replace')).rejects.toThrow('unknown')
      await expect(withSettingsRestoreFence(async () => 'must-not-restore')).rejects.toThrow('unknown')
    } finally { spy.mockRestore() }
  })
  it('A8 issued answer loss retains exact custody, preserves known physical effects and blocks replay or following targets', async () => {
    await expect(withSettingsRecordReplacement(`agent:${TARGET}`, async () => 'fixture-key-available')).resolves.toBe('fixture-key-available')
    const next = 'p2_zz_a8_next'
    await redis.createAgent({ id: next, user_id: USER, agentType: 'api', displayName: 'Next', created_at: CREATED })
    for (const id of [TARGET, next]) await redis.json.set(`agent:${id}`, '$.memory_window', { floor_mode: 'custom', ceiling_headroom_mode: 'custom', floor_tokens: 64000 })
    await redis.json.set('batshit:memory_config', '$', { embedding: { lane: 'api', modelId: 'configured', api: { provider: 'openai', modelName: 'embedding', dims: 384 } } })
    const grantPolicy = policy(); grantPolicy.protected.memorySettings = 'allow'
    const { context } = await portable(60000, grantPolicy), registry = createSettingsOperationRegistry()
    const reports = createSettingsManagementReports(registry.boot, store), changes = createSettingsChanges(registry, reports, store)
    const page = await reports.report(context, 'portable', { targets: { subjects: [{ kind: 'primary', id: TARGET }, { kind: 'primary', id: next }] }, focus: ['agent.memory.preferences'] })
    const input = { op: 'change', requestId: `${registry.boot}:a8-unknown`, reportId: page.reportId, semanticId: 'agent.memory.preferences', changes: { enabled: true, windowMode: 'auto' } }
    let issued = 0
    const actualExecute = redis.execute.bind(redis)
    function intercepted(client: any): any {
      return new Proxy(client, { get(object, property) {
        if (property === 'withAbortSignal') return (signal: AbortSignal) => intercepted(object.withAbortSignal(signal))
        if (property === 'eval') return async (script: string, options: any) => {
          const answer = await object.eval(script, options)
          if (script === CONDITIONAL_SETTINGS_WRITE_SCRIPT && options.keys[0] === `agent:${TARGET}`) { issued++; throw new Error('Fixture lost issued Memory reply') }
          return answer
        }
        const value = Reflect.get(object, property, object); return typeof value === 'function' ? value.bind(object) : value
      } })
    }
    const spy = vi.spyOn(redis, 'execute').mockImplementation((operation: any) => actualExecute(client => operation(intercepted(client))))
    try {
      expect(await changes.change(context, 'portable', input)).toMatchObject({ outcomesSummary: { unknown: 1, blocked: 1 } })
      expect(issued).toBe(1)
      expect(await redis.json.get(`agent:${TARGET}`)).toMatchObject({ memory_enabled: true, memory_window: { floor_mode: 'auto', floor_tokens: 64000 } })
      expect(await redis.json.get(`agent:${next}`)).toMatchObject({ memory_window: { floor_mode: 'custom' } })
      expect((await redis.json.get(`agent:${next}`)).memory_enabled).not.toBe(true)
      await changes.change(context, 'portable', input); expect(issued).toBe(1)
      await expect(withSettingsRecordReplacement(`agent:${TARGET}`, async () => 'must-not-replace')).rejects.toThrow('unknown')
      await expect(withSettingsRestoreFence(async () => 'must-not-restore')).rejects.toThrow('unknown')
    } finally { spy.mockRestore() }
  })
  it('A10 issued answer loss retains exact custody and blocks following targets without replay', async () => {
    await expect(withSettingsRecordReplacement(`agent:${TARGET}`, async () => 'fixture-key-available')).resolves.toBe('fixture-key-available')
    const next = 'p2_zz_a10_next'
    await redis.createAgent({ id: next, user_id: USER, agentType: 'api', displayName: 'Next', created_at: CREATED })
    const { context } = await portable(), registry = createSettingsOperationRegistry()
    const reports = createSettingsManagementReports(registry.boot, managedSettingsStore), changes = createSettingsChanges(registry, reports, managedSettingsStore)
    const page = await reports.report(context, 'portable', { targets: { subjects: [{ kind: 'primary', id: TARGET }, { kind: 'primary', id: next }] }, focus: ['agent.voice.tts-selection'] })
    const input = { op: 'change', requestId: `${registry.boot}:a10-unknown`, reportId: page.reportId, semanticId: 'agent.voice.tts-selection', changes: { selection: 'provider', providerId: 'browser', modelId: null, voiceId: null } }
    let issued = 0
    const actualExecute = redis.execute.bind(redis)
    function intercepted(client: any): any {
      return new Proxy(client, { get(object, property) {
        if (property === 'withAbortSignal') return (signal: AbortSignal) => intercepted(object.withAbortSignal(signal))
        if (property === 'eval') return async (script: string, options: any) => {
          const result = await object.eval(script, options)
          if (script.includes('local guard = ARGV[5]') && options.keys[0] === `agent:${TARGET}`) { issued++; throw new Error('Fixture lost issued TTS selection reply') }
          return result
        }
        const value = Reflect.get(object, property, object); return typeof value === 'function' ? value.bind(object) : value
      } })
    }
    const spy = vi.spyOn(redis, 'execute').mockImplementation((operation: any) => actualExecute(client => operation(intercepted(client))))
    try {
      expect(await changes.change(context, 'portable', input)).toMatchObject({ outcomesSummary: { unknown: 1, blocked: 1 } })
      expect(issued).toBe(1)
      expect((await redis.json.get(`agent:${TARGET}`)).voice_profile.tts.providerId).toBe('browser')
      expect((await redis.json.get(`agent:${next}`)).voice_profile).toBeUndefined()
      await changes.change(context, 'portable', input); expect(issued).toBe(1)
      await expect(withSettingsRecordReplacement(`agent:${TARGET}`, async () => 'must-not-replace')).rejects.toThrow('unknown')
      await expect(withSettingsRestoreFence(async () => 'must-not-restore')).rejects.toThrow('unknown')
    } finally { spy.mockRestore() }
  })
  it('A7 issued answer loss retains exact custody and blocks following targets without replay', async () => {
    await expect(withSettingsRecordReplacement(`agent:${TARGET}`, async () => 'fixture-key-available')).resolves.toBe('fixture-key-available')
    const next = 'p2_zz_a7_next'; await redis.createAgent({ id: next, user_id: USER, agentType: 'api', displayName: 'Next', created_at: CREATED })
    const f = await a7Fixture('allow'), input = await a7Input(f, { mode: 'off' }, 'a7-unknown', { subjects: [{ kind: 'primary', id: TARGET }, { kind: 'primary', id: next }] })
    let issued = 0
    const actualExecute = redis.execute.bind(redis)
    function intercepted(client: any): any {
      return new Proxy(client, { get(object, property) {
        if (property === 'withAbortSignal') return (signal: AbortSignal) => intercepted(object.withAbortSignal(signal))
        if (property === 'eval') return async (script: string, options: any) => { const result = await object.eval(script, options); if (script.includes('local guard = ARGV[5]') && options.keys[0] === `agent:${TARGET}`) { issued++; throw new Error('Fixture lost issued Auto Compact reply') } return result }
        const value = Reflect.get(object, property, object); return typeof value === 'function' ? value.bind(object) : value
      } })
    }
    const spy = vi.spyOn(redis, 'execute').mockImplementation((operation: any) => actualExecute(client => operation(intercepted(client))))
    try {
      const result = await f.changes.change(f.context, 'portable', input)
      expect(result).toMatchObject({ outcomesSummary: { unknown: 1, blocked: 1 } }); expect(issued).toBe(1)
      expect((await redis.json.get(`agent:${TARGET}`)).auto_compact_settings.mode).toBe('off'); expect(await redis.json.get(`agent:${next}`)).not.toHaveProperty('auto_compact_settings')
      await f.changes.change(f.context, 'portable', input); expect(issued).toBe(1)
      await expect(withSettingsRecordReplacement(`agent:${TARGET}`, async () => 'must-not-replace')).rejects.toThrow('unknown')
      await expect(withSettingsRestoreFence(async () => 'must-not-restore')).rejects.toThrow('unknown')
    } finally { spy.mockRestore() }
  })
})
