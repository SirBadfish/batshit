import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAppActionsPolicy } from '$lib/appActions/settings/managementContract'
import { captureSettingsLifecycle } from './lifecycle'
import type { SettingsManagementAdmission } from './managementActor'

const boundary = vi.hoisted(() => ({ admit: vi.fn(), refresh: vi.fn(), runtime: vi.fn() }))
vi.mock('./managementActor', async original => ({
  ...await original<typeof import('./managementActor')>(),
  admitSettingsManagementActor: (...args: unknown[]) => boundary.admit(...args),
  refreshSettingsOperationAuthority: (...args: unknown[]) => boundary.refresh(...args)
}))
vi.mock('../runtimeInspection', () => ({ readRuntimeStatus: (...args: unknown[]) => boundary.runtime(...args) }))
import { executeSettingsManagement } from './managementRuntime'
import { createSettingsManagementReports } from './managementReports'
import { SETTINGS_SNAPSHOT_PATHS, type ConditionalSettingsStore } from './conditionalAgentSettings'
import { readInstructionTextSnapshot } from './instructionTextSnapshot'
import { mcpGatewayService, type PreparedGatewaySave } from '../../mcpGatewayService'
import { apiKeyService } from '$lib/services/apiKey.server'
import { createSettingsOperationRegistry } from './operationRegistry'
import { createSettingsChanges } from './changeOperations'
import { MCP_CONFIGURATION_STAGES, type McpGatewaySaveReview } from '$lib/appActions/settings/mcpConfiguration'
import { redis } from '$lib/server/redis'
import * as builtinCatalog from '$lib/server/services/builtinVoiceCatalog'
import { configuredBuiltinTtsCatalog } from '$lib/server/services/voiceService'
import { configuredTtsSnapshotFromDetail, configuredTtsStoredSelection, CONFIGURED_TTS_READ_PATHS } from '$lib/server/configuredTtsGuard'
import { resolveConfiguredTtsEffective } from './configuredTtsSources'
import { agentTypeSnapshotOf } from '$lib/test-utils/agentUpdateScriptTwin'
import { BUILTIN_VOICE_PROVIDER_IDS } from '$lib/data/builtinVoiceCatalog'
import { bundledVoiceCatalogEntries } from '$lib/utils/builtinVoiceCatalogProjection'
import { verifyBuiltinVoiceCatalog, voiceCatalogRevision } from '$lib/utils/builtinVoiceCatalog'
import type { BuiltinVoiceCatalogSnapshot, VoiceCatalogView } from '$lib/types/builtinVoiceCatalog'

// Domain wiring only: the actor owner is injected here. Actual native/portable
// authentication, raw policy CAS and runtime source projection have their owning proof.
describe('fixed runtime report domain at the existing management wrapper', () => {
  let admission: SettingsManagementAdmission
  let abort: AbortController
  beforeEach(() => {
    vi.clearAllMocks()
    abort = new AbortController()
    const policy = defaultAppActionsPolicy()
    policy.enabled = true
    policy.ordinaryChanges = false
    policy.scope = { mode: 'selected', subjects: [], except: [] }
    admission = { actor: { userId: 'owner', kind: 'native', id: 'actor', sessionId: 'chat', generation: 1, label: 'Primary' }, policy,
      fence: { key: 'agent:actor', paths: [], lifecycle: captureSettingsLifecycle(['agent:actor']) }, signal: abort.signal }
    boundary.admit.mockImplementation(async () => admission)
    boundary.refresh.mockResolvedValue(undefined)
    boundary.runtime.mockImplementation(async ctx => { await ctx.refreshAuthority(); return { version: 1, domain: 'runtime-inspection', scope: 'this-instance', rows: [] } })
  })
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
  const context = (signal: AbortSignal) => ({ userId: 'owner', agentId: 'actor', sessionId: 'chat', actorType: 'in-process', abortSignal: signal })

  async function catalogCase() {
    const subject = { kind: 'primary' as const, id: 'catalog_source_target' }, at = new Date().toISOString()
    const record = { id: subject.id, user_id: 'owner', agentType: 'api', created_at: at, voice_profile: { tts: { providerId: 'browser' } } }
    admission.policy.ordinaryChanges = true
    admission.policy.scope = { mode: 'selected', subjects: [subject], except: [] }
    async function publication(sequence: number, blocked = false): Promise<VoiceCatalogView> {
      const providers = Object.fromEntries(BUILTIN_VOICE_PROVIDER_IDS.map(id => [id, id === 'browser'
        ? { sourceStatus: 'runtime-owned', discoveryCoverage: 'not-applicable', qualificationCoverage: 'not-applicable', lastAttemptAt: at, sourceUrls: [], entries: [] }
        : { sourceStatus: 'blocked', discoveryCoverage: 'unknown', qualificationCoverage: 'pending', lastAttemptAt: at, sourceUrls: [], failure: 'incomplete', entries: bundledVoiceCatalogEntries(id) }])) as BuiltinVoiceCatalogSnapshot['providers']
      if (blocked) Object.assign(providers.openai.entries.find(entry => entry.modelId === 'gpt-4o-mini-tts')!, { admission: 'blocked', blockedReason: 'contract-changed' })
      const snapshot: BuiltinVoiceCatalogSnapshot = { schemaVersion: 1, generation: 1, sequence, revision: '0'.repeat(64), generatedAt: at, providers }
      snapshot.revision = await voiceCatalogRevision(snapshot)
      return Object.freeze({ snapshot: await verifyBuiltinVoiceCatalog(JSON.stringify(snapshot), Date.now()), source: 'retained', checkedAt: at })
    }
    let view = await publication(1)
    vi.spyOn(builtinCatalog, 'peekBuiltinVoiceCatalog').mockImplementation(() => view)
    const store = {
      async read() { return { raw: SETTINGS_SNAPSHOT_PATHS.map(path => agentTypeSnapshotOf(record, [path])), incarnationRaw: JSON.stringify([at]), lifecycle: captureSettingsLifecycle([`agent:${subject.id}`]) } },
      async readConfiguredTts() {
        const lifecycle = captureSettingsLifecycle([`agent:${subject.id}`])
        const snapshot = configuredTtsSnapshotFromDetail(subject.id, record, CONFIGURED_TTS_READ_PATHS.map(path => agentTypeSnapshotOf(record, [path])), lifecycle)
        const selection = configuredTtsStoredSelection(snapshot), globalSelection = { providerId: null, modelId: null, voiceId: null, profileId: null }
        const providers = configuredBuiltinTtsCatalog(view).map(provider => ({ ...provider, configured: provider.id === 'openai' || provider.id === 'browser' ? 'yes' : 'no', enabled: true, supportsTts: true, guards: [] }))
        const profileSource = { profiles: [], count: 0, complete: true, lifecycle: captureSettingsLifecycle([]) }
        return { snapshot, selection, globalSelection, effective: resolveConfiguredTtsEffective(selection, globalSelection, [], providers), locked: false, providers, profiles: [], choices: [], guards: [], sourceLifecycle: lifecycle,
          catalog: { voiceCatalog: view, userId: 'owner', global: { settings: {}, guards: [] }, providers, profileSource, profileCount: 0,
            registry: { engines: [], complete: true, guard: { key: 'voice_engine_registry:owner', path: '$', fingerprint: 'a'.repeat(40), byteLimit: 262144 } }, environment: 'e'.repeat(64) },
          complete: true, environment: 'e'.repeat(64), checkEnvironment() {} }
      }
    } as unknown as ConditionalSettingsStore
    const registry = createSettingsOperationRegistry(), reports = createSettingsManagementReports(registry.boot, store), changes = createSettingsChanges(registry, reports, store), ctx = context(abort.signal)
    const page = await reports.report(ctx, 'native', { targets: { subjects: [subject] }, focus: ['agent.voice.tts-selection'], detail: 'values' })
    const input = (name: string) => ({ op: 'change', requestId: `${registry.boot}:${name}`, reportId: page.reportId, semanticId: 'agent.voice.tts-selection',
      changes: { selection: 'provider', providerId: 'openai', modelId: 'gpt-4o-mini-tts', voiceId: 'alloy' } })
    return { registry, changes, ctx, input, async publish(sequence: number, blocked = false) { view = await publication(sequence, blocked) } }
  }

  it('A10 keeps an original report/operation valid across an unrelated higher catalog sequence without renewing expiry', async () => {
    const setup = await catalogCase(), writer = vi.spyOn(redis, 'updateAgent')
    await setup.publish(2)
    const prepared = await setup.changes.prepare(setup.ctx, 'native', setup.input('unchanged'))
    expect(prepared.gate).toBe(true)
    const review = setup.registry.nativeApprovalPreview('owner', 'actor', 'chat', setup.input('unchanged').requestId)!
    expect(review.preview.targets).toHaveLength(1)
    await setup.publish(3)
    expect((await setup.registry.validatePending(prepared.operation.operationId, admission.actor)).status).toBe('ready')
    expect(setup.registry.outcome(prepared.operation.operationId, admission.actor).reviewExpiresAt).toBe(review.reviewExpiresAt)
    expect(writer).not.toHaveBeenCalled()
  })

  it('A10 refuses selected catalog drift with no mutation targets, original expiry or writer replay', async () => {
    const setup = await catalogCase(), writer = vi.spyOn(redis, 'updateAgent')
    const original = await setup.changes.prepare(setup.ctx, 'native', setup.input('original'))
    const review = setup.registry.nativeApprovalPreview('owner', 'actor', 'chat', setup.input('original').requestId)!
    await setup.publish(3, true)
    await expect(setup.registry.validatePending(original.operation.operationId, admission.actor)).rejects.toThrow('tts_catalog_compatibility_unavailable')
    const refused = await setup.changes.prepare(setup.ctx, 'native', setup.input('selected-drift'))
    expect(refused.gate).toBe(false)
    expect(setup.registry.nativeApprovalPreview('owner', 'actor', 'chat', setup.input('selected-drift').requestId)!.preview.targets).toEqual([])
    expect(setup.registry.outcome(original.operation.operationId, admission.actor).reviewExpiresAt).toBe(review.reviewExpiresAt)
    expect(writer).not.toHaveBeenCalled()
  })
  it('uses instance authority independently of subject scope/ordinary changes and issues no operation', async () => {
    const result = await executeSettingsManagement(context(abort.signal), 'sys.app_settings.native.report', { domain: 'runtime-inspection' })
    expect(result).toEqual({ version: 1, domain: 'runtime-inspection', scope: 'this-instance', rows: [] })
    const adapter = boundary.runtime.mock.calls[0][0]
    expect(adapter).not.toHaveProperty('subjects')
    expect(adapter).not.toHaveProperty('execution')
    expect(adapter.deadlineAt).toBeLessThanOrEqual(Date.now() + 20_000)
    expect(boundary.refresh).toHaveBeenCalledOnce()
  })
  it.each(['blocked', 'disabled'])('refuses %s instance reads before the runtime owner', async mode => {
    if (mode === 'blocked') admission.policy.management.runtimeManagement = 'block'
    else admission.policy.enabled = false
    await expect(executeSettingsManagement(context(abort.signal), 'sys.app_settings.native.report', { domain: 'runtime-inspection' })).rejects.toMatchObject({ code: 'RUNTIME_INSPECTION_BLOCKED' })
    expect(boundary.runtime).not.toHaveBeenCalled()
  })
  it('does not emit an observed result after current authority or exact Stop changes', async () => {
    boundary.refresh.mockRejectedValueOnce(new Error('revoked'))
    await expect(executeSettingsManagement(context(abort.signal), 'sys.app_settings.native.report', { domain: 'runtime-inspection' })).rejects.toThrow('revoked')
    boundary.runtime.mockImplementationOnce(async () => { abort.abort(); return { domain: 'runtime-inspection' } })
    await expect(executeSettingsManagement(context(abort.signal), 'sys.app_settings.native.report', { domain: 'runtime-inspection' })).rejects.toMatchObject({ code: 'OPERATION_ENDED' })
  })
  it('rejects subject-bearing instance input before admission or runtime reads', async () => {
    await expect(executeSettingsManagement(context(abort.signal), 'sys.app_settings.native.report', { domain: 'runtime-inspection', targets: { subjects: [{ kind: 'primary', id: 'a' }] } })).rejects.toThrow('no subjects')
    expect(boundary.admit).not.toHaveBeenCalled()
    expect(boundary.runtime).not.toHaveBeenCalled()
  })

  it.each(['report expiry', 'native Stop', 'portable expiry'] as const)('refuses an instruction text page when %s reaches the final held-read handoff', async ending => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const subject = { kind: 'primary' as const, id: 'text_target' }, created = '2026-10-17T00:00:00.000Z'
    const record: Record<string, unknown> = { id: subject.id, user_id: 'owner', agentType: 'api', created_at: created }
    admission.policy.scope = { mode: 'selected', subjects: [subject], except: [] }
    const lane = ending === 'portable expiry' ? 'portable' : 'native'
    if (lane === 'portable') admission = { ...admission, actor: { ...admission.actor, kind: 'portable' }, expiresAt: now + 60_000 }
    const snapshot = { raw: SETTINGS_SNAPSHOT_PATHS.map(path => Object.hasOwn(record, path.slice(2)) ? JSON.stringify([record[path.slice(2)]]) : '[]'),
      incarnationRaw: JSON.stringify([created]), lifecycle: captureSettingsLifecycle([`agent:${subject.id}`]) }
    const text = 'PRIVATE🌊'.repeat(8_000)
    const reader = vi.fn(async () => ['OK', JSON.stringify([subject.id]), '["owner"]', '["api"]', JSON.stringify([created]), 'absent', '[]', 'string', Buffer.byteLength(text), JSON.stringify([text])])
    let held = false, entered = false, release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const store = { async read() { if (held) { entered = true; await gate } return snapshot },
      readInstructions: () => readInstructionTextSnapshot(subject, 'owner', reader, { includeText: true }) } as ConditionalSettingsStore
    const reports = createSettingsManagementReports('a'.repeat(24), store)
    const ctx = context(abort.signal)
    const first = await reports.report(ctx, lane, { targets: { subjects: [subject] }, focus: ['agent.instructions'], detail: 'values', query: { instructionText: true } })
    const cursor = first.report.continuation.nextCursor
    expect(cursor).toBeTruthy()
    const captured = await reports.forOperation(first.reportId, ctx, lane)
    held = true
    const flight = reports.report(ctx, lane, { reportId: first.reportId, cursor })
    await vi.waitFor(() => expect(entered).toBe(true))
    if (ending === 'native Stop') abort.abort()
    else now += ending === 'report expiry' ? 600_001 : 60_001
    release()
    await expect(flight).rejects.toMatchObject({ code: ending === 'native Stop' ? 'CONTROL_CANCELLATION_REQUIRED' : 'REPORT_EXPIRED' })
    expect(reader).toHaveBeenCalledOnce() // Current admission is refreshed; captured text is never reread.
    if (ending === 'report expiry') {
      held = false
      await expect(reports.forCapturedOperation(captured, ctx, lane)).resolves.toBe(captured)
    }
  })

  // Source/operation wiring only. This file deliberately injects actor authority;
  // genuine route/credential/native consumed-approval proof remains in the real owners.
  function mcpReview(): McpGatewaySaveReview {
    return { kind: 'mcp-configuration', planId: `mcpp_${'1'.repeat(32)}`, candidateId: `mcpc_${'2'.repeat(32)}`, mode: 'create',
      resource: { kind: 'mcp-gateway', gatewayId: 'assigned' }, before: null, after: { id: 'assigned', slug: 'source', name: 'Source', type: 'custom', enabled: true,
        url: 'https://source.example/mcp', savedKeyRef: 'custom-mcp', evidence: { kind: 'supplied', uri: 'https://source.example/docs' } }, stages: [...MCP_CONFIGURATION_STAGES] }
  }
  function mcpSources() {
    return vi.spyOn(mcpGatewayService, 'readManagementSources').mockResolvedValue([])
  }
  const candidateQuery = { domain: 'mcp-configuration', query: { kind: 'candidate', candidate: { kind: 'http', name: 'Source', url: 'https://source.example/mcp',
    savedKeyRef: 'custom-mcp', evidence: { kind: 'supplied', uri: 'https://source.example/docs' } } } }
  it('I1 resource reports use no scalar subjects, normalizing reads, credential values or startup', async () => {
    const sources = mcpSources(), get = vi.spyOn(mcpGatewayService, 'get'), list = vi.spyOn(mcpGatewayService, 'list'), retrieve = vi.spyOn(apiKeyService, 'retrieve')
    const read = vi.fn(async () => { throw new Error('A resource report must not read an agent as a stand-in') })
    const reports = createSettingsManagementReports('a'.repeat(24), { read } as unknown as ConditionalSettingsStore)
    const page = await reports.report(context(abort.signal), 'native', { domain: 'mcp-configuration' })
    expect(page).toMatchObject({ domain: 'mcp-configuration', report: { rows: [], total: 0 }, change: { permission: 'ask' } })
    expect(page.reportId).toMatch(/^asr_[a-f0-9]{24}_mcp_[a-f0-9]{32}$/)
    const held = await reports.forOperation(page.reportId, context(abort.signal), 'native')
    expect(held).not.toHaveProperty('manifest'); expect(held).not.toHaveProperty('snapshots')
    expect(read).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled(); expect(retrieve).not.toHaveBeenCalled()
    expect(sources).toHaveBeenCalled()
  })
  it('I1 Block and malformed secret-bearing candidates refuse before source/normalization work', async () => {
    const sources = mcpSources(), prepare = vi.spyOn(mcpGatewayService, 'prepareGatewaySave')
    const reports = createSettingsManagementReports('a'.repeat(24), {} as ConditionalSettingsStore)
    admission.policy.management.mcpManagement = 'block'
    await expect(reports.report(context(abort.signal), 'native', candidateQuery)).rejects.toMatchObject({ code: 'MCP_MANAGEMENT_BLOCKED' })
    expect(sources).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled()
    admission.policy.management.mcpManagement = 'ask'
    await expect(reports.report(context(abort.signal), 'native', { ...candidateQuery, query: { kind: 'candidate', candidate: { ...candidateQuery.query.candidate, url: 'https://source.example/mcp?token=private' } } })).rejects.toThrow('nonsecret MCP source candidate')
    expect(sources).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled()
  })
  it('BL1804 an existing STDIO source with secret argv creates no automatic candidate review, digest or write', async () => {
    const source = { id: 'legacy', slug: 'legacy', name: 'Legacy source', type: 'stdio', enabled: true, created_at: '2026-10-18T00:00:00.000Z' }
    mcpSources().mockResolvedValue([source])
    const gateway = { ...source, stdioConfig: { command: 'npx', args: ['--api-key=LEGACY_SECRET'], cwdPolicy: 'none' } }
    const raw = JSON.stringify([{ gateways: [gateway] }]), element = JSON.stringify([gateway])
    const read = vi.fn(async () => [raw, element, '0'])
    const execute = vi.spyOn(redis, 'execute').mockImplementation(async callback => callback({ eval: read } as never))
    const commit = vi.spyOn(mcpGatewayService, 'commitPreparedGatewaySave')
    const registry = createSettingsOperationRegistry(), capture = vi.spyOn(registry, 'capture')
    const reports = createSettingsManagementReports(registry.boot, {} as ConditionalSettingsStore), ctx = context(abort.signal)
    const details = await reports.report(ctx, 'native', { domain: 'mcp-configuration', query: { kind: 'details', gatewayId: source.id } })
    let delivered: unknown, failure: unknown
    try {
      const revision = (details.report as { rows: Array<{ revision: string }> }).rows[0].revision
      try { delivered = await reports.report(ctx, 'native', { domain: 'mcp-configuration', query: { kind: 'candidate', candidate: { kind: 'existing', gatewayId: source.id, expectedRevision: revision } } }) }
      catch (error) { failure = error }
      expect(delivered).toBeUndefined(); expect(failure).toBeInstanceOf(Error)
      expect(String(failure)).not.toContain('LEGACY_SECRET')
      expect(JSON.stringify(details)).not.toContain('LEGACY_SECRET')
      expect(capture).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled()
      expect(JSON.stringify([{ gateways: [gateway] }])).toBe(raw)
    } finally { execute.mockRestore() }
  })
  it.each([
    { name: 'native initial deadline', lane: 'native', budget: 120_000, later: false, stop: false },
    { name: 'portable initial deadline', lane: 'portable', budget: 5000, later: false, stop: false },
    { name: 'native retained deadline', lane: 'native', budget: 120_000, later: true, stop: false },
    { name: 'portable retained deadline', lane: 'portable', budget: 5000, later: true, stop: false },
    { name: 'native original Stop', lane: 'native', budget: 120_000, later: false, stop: true }
  ] as const)('BL1805 bounds the held-ticket initial change refresh and prevents late capture: $name', async scenario => {
    vi.useFakeTimers()
    if (scenario.lane === 'portable') admission = { ...admission, actor: { ...admission.actor, kind: 'portable' }, expiresAt: Date.now() + 1_800_000 }
    const sources = mcpSources(), plan = Object.freeze({}) as PreparedGatewaySave, review = mcpReview()
    vi.spyOn(mcpGatewayService, 'prepareGatewaySave').mockResolvedValue({ plan, review })
    const currentPlan = vi.spyOn(mcpGatewayService, 'assertPreparedGatewayCurrent').mockResolvedValue()
    const key = vi.spyOn(apiKeyService, 'readReferenceState').mockResolvedValue({ key: 'api_keys:owner:custom-mcp', raw: '[{"encrypted":"private-cut"}]', present: true, shapeValid: true })
    const commit = vi.spyOn(mcpGatewayService, 'commitPreparedGatewaySave')
    const registry = createSettingsOperationRegistry(), capture = vi.spyOn(registry, 'capture'), reports = createSettingsManagementReports(registry.boot, {} as ConditionalSettingsStore)
    const changes = createSettingsChanges(registry, reports, {} as ConditionalSettingsStore), original = context(abort.signal)
    const page = await reports.report(original, scenario.lane, candidateQuery)
    const ticket = await reports.forOperation(page.reportId, original, scenario.lane)
    const previousContext = ticket.context
    sources.mockClear(); currentPlan.mockClear(); key.mockClear()
    let enterInitial!: () => void, releaseInitial!: () => void, enterPlan!: () => void, releasePlan!: () => void
    const initialEntered = new Promise<void>(resolve => { enterInitial = resolve }), planEntered = new Promise<void>(resolve => { enterPlan = resolve })
    sources.mockImplementationOnce(() => new Promise(resolve => { releaseInitial = () => resolve([]); enterInitial() }))
    if (scenario.later) currentPlan.mockImplementationOnce(() => new Promise<void>(resolve => { releasePlan = resolve; enterPlan() }))
    const input = { op: 'change', requestId: `${registry.boot}:bl1805`, reportId: page.reportId, semanticId: 'mcp.workflow.configure', changes: { source: { candidateId: review.candidateId } } }
    let settled = false
    const pending = changes.prepare({ ...original }, scenario.lane, input).then(result => ({ result }), error => ({ error })).finally(() => { settled = true })
    try {
      await initialEntered
      if (scenario.later) {
        await vi.advanceTimersByTimeAsync(scenario.budget - 1000)
        releaseInitial(); await planEntered
        await vi.advanceTimersByTimeAsync(1001)
      } else if (scenario.stop) { abort.abort('original_native_stop'); await vi.advanceTimersByTimeAsync(0) }
      else await vi.advanceTimersByTimeAsync(scenario.budget + 1)
      expect(settled).toBe(true)
      expect(await pending).toMatchObject({ error: { code: 'MCP_REPORT_ENDED' } })
      expect(capture).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled()
      const actorReads = boundary.admit.mock.calls.length
      releaseInitial?.(); releasePlan?.(); await vi.advanceTimersByTimeAsync(0)
      expect(capture).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled()
      if (!scenario.later) { expect(currentPlan).not.toHaveBeenCalled(); expect(ticket.context).toBe(previousContext); expect(boundary.admit).toHaveBeenCalledTimes(actorReads) }
    } finally { releaseInitial?.(); releasePlan?.(); await vi.advanceTimersByTimeAsync(0) }
  })
  it.each([['native', 120_000], ['portable', 5000]] as const)('I1 %s report waits stay bounded at%s ms with no deferred operation or key work', async (lane, budget) => {
    vi.useFakeTimers()
    if (lane === 'portable') admission = { ...admission, actor: { ...admission.actor, kind: 'portable' }, expiresAt: Date.now() + 600_000 }
    let release!: () => void
    const sources = mcpSources().mockImplementationOnce(() => new Promise(resolve => { release = () => resolve([]) }))
    const prepare = vi.spyOn(mcpGatewayService, 'prepareGatewaySave')
    const reports = createSettingsManagementReports('a'.repeat(24), {} as ConditionalSettingsStore)
    let settled = false
    const pending = reports.report(context(abort.signal), lane, { domain: 'mcp-configuration' }).finally(() => { settled = true })
    const refused = expect(pending).rejects.toMatchObject({ code: 'MCP_REPORT_ENDED' })
    try {
      await vi.advanceTimersByTimeAsync(budget + 1)
      expect(settled).toBe(true); await refused
      expect(sources).toHaveBeenCalledOnce(); expect(prepare).not.toHaveBeenCalled()
    } finally { release?.(); await vi.advanceTimersByTimeAsync(0) }
  })
  it('I1 source pages retain one bounded snapshot and accept only its issued cursor positions', async () => {
    const sourceRows = Array.from({ length: 130 }, (_, i) => ({ id: `gateway_${i}`, slug: `gateway_${i}`, name: `Source ${i}`, type: 'custom', enabled: true, created_at: '2026-10-18T00:00:00.000Z' }))
    mcpSources().mockResolvedValue(sourceRows)
    const reports = createSettingsManagementReports('a'.repeat(24), {} as ConditionalSettingsStore), ctx = context(abort.signal)
    const first = await reports.report(ctx, 'native', { domain: 'mcp-configuration' })
    expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThanOrEqual(8192)
    const cursor = String(first.report.next), [prefix, nonce, offset] = cursor.split(':')
    expect(prefix).toBe('mcp1')
    await expect(reports.report(ctx, 'native', { reportId: first.reportId, cursor: `${prefix}:${nonce}:${Number(offset) + 1}` })).rejects.toMatchObject({ code: 'INVALID_REPORT_PAGE' })
    sourceRows.push({ id: 'outside_original', slug: 'outside_original', name: 'New source', type: 'custom', enabled: true, created_at: '2026-10-18T00:00:00.000Z' })
    const next = await reports.report(ctx, 'native', { reportId: first.reportId, cursor })
    expect(next.report.total).toBe(130)
    expect(JSON.stringify(next)).not.toContain('outside_original')
    expect(Buffer.byteLength(JSON.stringify(next), 'utf8')).toBeLessThanOrEqual(8192)
  })
  it('I1 exact portable human decision preserves the opaque plan closure, survives report expiry and spends once', async () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    admission = { ...admission, actor: { ...admission.actor, kind: 'portable' }, expiresAt: now + 30 * 60_000 }
    mcpSources()
    const plan = Object.freeze({}) as PreparedGatewaySave, review = mcpReview(), raw = '[{"encrypted":"PRIVATE_CIPHERTEXT","iv":"i","authTag":"t"}]'
    vi.spyOn(mcpGatewayService, 'prepareGatewaySave').mockResolvedValue({ plan, review })
    vi.spyOn(mcpGatewayService, 'assertPreparedGatewayCurrent').mockResolvedValue()
    const key = vi.spyOn(apiKeyService, 'readReferenceState').mockResolvedValue({ key: 'api_keys:owner:custom-mcp', raw, present: true, shapeValid: true })
    const commit = vi.spyOn(mcpGatewayService, 'commitPreparedGatewaySave').mockImplementation(async (actual, input) => {
      expect(actual).toBe(plan); input.beforeIssue(); input.onSaved()
    })
    const registry = createSettingsOperationRegistry(), reports = createSettingsManagementReports(registry.boot, {} as ConditionalSettingsStore)
    const changes = createSettingsChanges(registry, reports, {} as ConditionalSettingsStore), ctx = { userId: 'owner', actorType: 'portable-skill' }
    const page = await reports.report(ctx, 'portable', candidateQuery)
    expect(JSON.stringify(page)).not.toContain('PRIVATE_CIPHERTEXT')
    now += 9 * 60_000
    const input = { op: 'change', requestId: `${registry.boot}:i1`, reportId: page.reportId, semanticId: 'mcp.workflow.configure', changes: { source: { candidateId: review.candidateId } } }
    const waiting = await changes.change(ctx, 'portable', input)
    expect(waiting).toMatchObject({ status: 'awaiting_approval', totalTargets: 0, totalResources: 1, executionBudgetMs: 180_000 })
    expect(commit).not.toHaveBeenCalled()
    const human = await registry.humanReview('owner', waiting.operationId)
    expect(JSON.stringify(human)).not.toContain('PRIVATE_CIPHERTEXT'); expect(human.preview).toMatchObject({ targets: [], resource: review })
    now += 2 * 60_000
    await expect(reports.report(ctx, 'portable', { reportId: page.reportId })).rejects.toMatchObject({ code: 'REPORT_EXPIRED' })
    expect((await changes.prepare(ctx, 'portable', input)).operation.operationId).toBe(waiting.operationId)
    await registry.decide('owner', waiting.operationId, waiting.intentDigest, 'approve')
    const done = await changes.change(ctx, 'portable', input)
    expect(done).toMatchObject({ status: 'completed', resourceOutcomes: [{ saved: 'saved', stages: { installation: 'not_started', registry: 'saved', verification: 'not_started', originalTaskUse: 'not_started' } }] })
    expect(done).not.toHaveProperty('continuation')
    await expect(registry.decide('owner', waiting.operationId, waiting.intentDigest, 'approve')).rejects.toThrow('already')
    expect(commit).toHaveBeenCalledOnce(); expect(key).toHaveBeenCalled()
  })
})
