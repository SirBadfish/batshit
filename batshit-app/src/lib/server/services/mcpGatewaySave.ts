/** Shared gateway save owners. HTTP authentication stays in routes; MCP never enters the human secret/profile branch. */
import { GatewayRegistryConflictError, mcpGatewayService, namesHumanGatewaySource, requireHumanGatewaySource, HumanGatewaySourceRequiredError, HumanGatewaySourceConflictError, HumanGatewaySourceWriteUnconfirmed, type GatewayUpdate, type PreparedGatewaySave } from './mcpGatewayService'
import { GatewayManagementWriteUnconfirmed, type GatewayRawFence } from './appActions/mcp/gatewayWriteContext'
import type { AdapterContext } from './appActions/managementTypes'
import type { McpSourceCandidate } from './appActions/mcp/sourceCandidate'
import { MCP_CONFIGURATION_STAGES, type McpConfigurationJournal, type McpResourceOutcome, type McpPrerequisiteReview } from '$lib/appActions/settings/mcpConfiguration'
import { AppActionsManagementRefusal } from './appActions/settings/authority'
import { apiKeyService } from '$lib/services/apiKey.server'
import { publishUserEvent } from '$lib/server/ssePublisher'
import { captureSettingsLifecycle, assertSettingsLifecycle } from './appActions/settings/lifecycle'
import { assertDockerMcpProfileWritable, DOCKER_PROFILE_FILE_NOT_FINISHED, getActiveDockerMcpProfile, normalizeDockerMcpProfile, runDockerMcpProfileWrite, writeDockerMcpProfileEnv } from './dockerGatewayProfileConfig'
import { redactGatewaySecretsForBrowser, presentMcpGatewayForBrowser } from './mcpGatewayRuntimePresentation'
import { moveLegacyN8nInstanceToken, N8N_INSTANCE_TOKEN_SERVICE } from './n8nInstanceCredential'
import type { MCPGateway } from '$lib/types/database'
import { planMcpTarget, type ConditionalSettingsStore, type McpTargetPostimage, type McpTargetWriteAck } from './appActions/settings/conditionalAgentSettings'
import type { P5McpClientAdmission } from './mcpGatewayDiscovery'
import { assertP5ApiManagementCurrent, notifyP5ApiManagement, type P5ApiManagement, readP5ApiManagementOwner, observeP5ApiVerifiedSourceRemoval, joinP5OriginalStdioManagement } from './appActions/mcp/originalTask'

type ApiPrerequisite = { review: McpPrerequisiteReview; plan?: PreparedGatewaySave; adapter: AdapterContext;
  store: ConditionalSettingsStore; target: McpTargetPostimage; ack?: McpTargetWriteAck; setup?: P5McpClientAdmission;
  fences: readonly GatewayRawFence[]; sourceIdentity?: import('./appActions/settings/conditionalAgentSettings').McpSourceIdentityGuard;
  complete: boolean; discovery?: typeof import('./mcpGatewayDiscovery') }
type ApiWriteObservation = { result: 'pending' | 'saved' | 'refused' | 'unknown'; prerequisite?: ApiPrerequisite }
const p5ApiWrites = new WeakMap<object, ApiWriteObservation>()
/** API private known-save observer only. It is not verification or subject completion. */
export function readP5ApiManagementWrite(ticket: P5ApiManagement): 'pending' | 'saved' | 'refused' | 'unknown' {
  return p5ApiWrites.get(ticket)?.result ?? 'pending'
}
export type HumanGatewaySaveResult = { body: Record<string, unknown>; status: number }
function response(body: Record<string, unknown>, options: { status?: number } = {}): HumanGatewaySaveResult { return { body, status: options.status ?? 200 } }

const TOKEN_NOT_CONFIRMED =
  'The gateway settings were saved, but Batshit could not confirm saving the n8n Instance MCP token. Save the token again, or save it in Settings → API Keys.'
const CREATE_AFTER_SAVE_NOT_FINISHED =
  'The gateway settings were saved, but Batshit could not finish the save.'
const CREATE_AFTER_SAVE_ALSO_NOT_FINISHED = 'Batshit also could not finish the save.'

/**
 * BL-1410 / BL-1411: a 500 after the gateway record write was confirmed says so in fields, not
 * only in its text: `gatewaySaved: true` and the id that write confirmed (the id `create` answered, never a later read). It vouches
 * for the gateway record only; the token store or the profile file the error names
 * may still be unknown. Never a 200, never retried.
 */
function savedButFailed(error: string, gatewayId: string, sourceAcknowledgement?: MCPGateway & { sourceRevision: string }) {
  return response({ error, gatewaySaved: true, gatewayId, ...(sourceAcknowledgement ? { sourceAcknowledgement } : {}) }, { status: 500 })
}

/** A failure after the stored create: what was saved, and every step that did not finish. */
function createAfterSaveError(notConfirmed: string[]) {
  return notConfirmed.length === 0
    ? CREATE_AFTER_SAVE_NOT_FINISHED
    : `${notConfirmed.join(' ')} ${CREATE_AFTER_SAVE_ALSO_NOT_FINISHED}`
}


const UPDATE_AFTER_SAVE_NOT_FINISHED = 'The gateway settings were saved, but Batshit could not read the gateway back.'
const UPDATE_AFTER_SAVE_ALSO_NOT_FINISHED = 'Batshit also could not read the gateway back.'
function updateAfterSaveError(notConfirmed: string[]) {
  return notConfirmed.length === 0 ? UPDATE_AFTER_SAVE_NOT_FINISHED : `${notConfirmed.join(' ')} ${UPDATE_AFTER_SAVE_ALSO_NOT_FINISHED}`
}

/** Same synchronous stored-metadata/profile merge for both human and prepared MCP saves. */
function dockerGatewayFields(stored: Readonly<MCPGateway>, updates: Partial<MCPGateway>, dockerProfile: string | null): Partial<MCPGateway> {
  const storedMeta = stored.metadata && typeof stored.metadata === 'object' ? stored.metadata : {}
  const updateMeta = updates.metadata && typeof updates.metadata === 'object' ? updates.metadata : {}
  const metadata = { ...storedMeta, ...updateMeta }
  const next = { ...updates }
  if (dockerProfile !== null) {
    if (storedMeta.dockerProfile !== dockerProfile) { next.discoveredTools = []; next.lastDiscovery = 0 }
    metadata.dockerProfile = dockerProfile
  }
  delete metadata.docker_profile
  return { ...next, metadata }
}

export async function prepareMcpGatewayConfiguration(userId: string, candidate: McpSourceCandidate, fullSavedStdioEnable = false) {
  if (candidate.kind === 'http') return mcpGatewayService.prepareGatewaySave(userId, { mode: 'create', gateway: {
    name: candidate.name, type: 'custom', url: candidate.url, enabled: true, discoveredTools: [],
    ...(candidate.savedKeyRef ? { authKeyName: candidate.savedKeyRef } : {}), metadata: { appActionsSource: { evidence: candidate.evidence } }
  } })
  if (candidate.kind === 'stdio') return mcpGatewayService.prepareGatewaySave(userId, { mode: 'create', gateway: {
    name: candidate.name, type: 'stdio', enabled: true, discoveredTools: [], stdioConfig: {
      command: candidate.command, args: [...candidate.args], cwdPolicy: candidate.cwdPolicy,
      ...(candidate.cwdValue ? { cwdValue: candidate.cwdValue } : {}), envRefs: candidate.envRefs.map(row => ({ ...row })),
      startupTimeoutMs: candidate.startupTimeoutMs, toolCallTimeoutMs: candidate.toolCallTimeoutMs
    }, metadata: { appActionsSource: { evidence: candidate.evidence, allowedLocations: [...candidate.allowedLocations] } }
  } })
  return mcpGatewayService.prepareGatewaySave(userId, { mode: 'update', gatewayId: candidate.gatewayId,
    updates: candidate.kind === 'docker' && candidate.profile !== undefined ? stored => {
      if (stored.type !== 'docker-catalog') throw new Error('The held source is not a Docker MCP gateway.')
      return dockerGatewayFields(stored, {}, normalizeDockerMcpProfile(candidate.profile))
    } : fullSavedStdioEnable && candidate.kind === 'existing' ? stored => stored.type === 'stdio' ? { enabled: true } : {} : {} })
}

/** Saved-reference-only branch. No token store/migration/get/list/file/profile/client call. */
export async function savePreparedMcpGateway(input: {
  plan: PreparedGatewaySave; resource: McpResourceOutcome['resource']; adapter: AdapterContext; fences: readonly GatewayRawFence[]
  hasKeyReferences: boolean; record(outcome: McpResourceOutcome): void
  p5ApiManagement?: P5ApiManagement
}): Promise<McpResourceOutcome> {
  const apiOriginal = input.p5ApiManagement
  const observed: { result: 'pending' | 'saved' | 'refused' | 'unknown' } = { result: 'pending' }
  if (apiOriginal && p5ApiWrites.has(apiOriginal)) throw new AppActionsManagementRefusal('MCP_ORIGINAL_WRITE_REPLAY', 'The original API write was already issued; reconcile its existing result.', 409)
  if (apiOriginal) p5ApiWrites.set(apiOriginal, observed)
  const note = (result: typeof observed.result) => {
    if (!apiOriginal || observed.result === 'saved') return
    observed.result = result
    notifyP5ApiManagement(apiOriginal)
  }
  const stages = Object.fromEntries(MCP_CONFIGURATION_STAGES.map(stage => [stage, 'not_started'])) as McpConfigurationJournal
  stages.keyReference = input.hasKeyReferences ? 'verified' : 'not_requested'
  const savedState: { saved: McpResourceOutcome['saved'] } = { saved: 'not_requested' }
  const emit = (status: McpResourceOutcome['status'], reason?: string): McpResourceOutcome => {
    const outcome = { resource: input.resource, status, saved: savedState.saved, stages: { ...stages }, ...(reason ? { reason } : {}) }
    input.record(outcome); return outcome
  }
  try {
    if (apiOriginal) {
      assertP5ApiManagementCurrent(apiOriginal, input.resource.gatewayId)
      await joinP5OriginalStdioManagement(apiOriginal, [], false, input.adapter.deadlineAt)
    }
    await mcpGatewayService.commitPreparedGatewaySave(input.plan, { adapter: input.adapter, fences: input.fences,
      beforeIssue() {
        if (apiOriginal) assertP5ApiManagementCurrent(apiOriginal, input.resource.gatewayId)
        stages.registry = 'issued'; savedState.saved = 'unknown'; note('unknown'); emit('unknown', 'registry_write_issued')
      },
      onSaved() {
        stages.registry = 'saved'; savedState.saved = 'saved'
        note('saved') // synchronous real commit acknowledgement, before journal/publication awaits
        emit('applied', 'gateway_saved_setup_not_started')
      } })
    return emit('applied', 'gateway_saved_setup_not_started')
  } catch (error) {
    if (error instanceof GatewayManagementWriteUnconfirmed) {
      savedState.saved = error.gatewaySaved ? 'saved' : 'unknown'; stages.registry = error.gatewaySaved ? 'saved' : 'unknown'
      note(error.gatewaySaved ? 'saved' : 'unknown')
      return emit(error.gatewaySaved ? 'applied' : 'unknown', error.gatewaySaved ? 'gateway_saved_journal_unconfirmed' : 'registry_write_unconfirmed')
    }
    if (savedState.saved === 'saved') return emit('applied', 'gateway_saved_followup_unconfirmed')
    if (error instanceof AppActionsManagementRefusal) {
      note('refused')
      savedState.saved = 'not_requested'; stages.registry = 'blocked'; return emit('conflict', 'gateway_write_refused')
    }
    // Before physical issue a failure is a refusal. Once issued, only a known script answer can settle it.
    if (stages.registry === 'issued') { note('unknown'); stages.registry = 'unknown'; return emit('unknown', 'registry_write_unconfirmed') }
    note('refused')
    stages.registry = 'blocked'; return emit('blocked', 'gateway_save_unavailable')
  }
}

/** Fixed actual Discovery producer joins a physical identity, never a result.
 * The SAME private client owner must vouch its reservation/run membership. */
export function observeP5ApiSetupClient(original: P5ApiManagement, client: P5McpClientAdmission): void {
  const fact = p5ApiWrites.get(original)?.prerequisite
  const actual = readP5ApiManagementOwner(original)
  const observed = fact?.discovery?.readP5McpClientSettlement(client)
  if (!observed || observed.setup !== original || observed.run !== actual.run) throw new Error('The actual setup client identity is unavailable.')
  if (!fact || fact.setup || actual.gatewayId !== fact.review.resource.gatewayId) throw new Error('The actual setup flight cannot be rebound.')
  fact.setup = client
}

export async function readP5ApiPrerequisiteSavedSelection(original: P5ApiManagement): Promise<readonly string[]> {
  const fact = p5ApiWrites.get(original)?.prerequisite
  readP5ApiManagementOwner(original)
  if (!fact) throw new Error('The actual target selection is unavailable.')
  const selection = fact.target.before.row.defaultMCPGateways ?? fact.target.before.row.default_mcp_gateways ?? []
  if (!Array.isArray(selection) || selection.some(id => typeof id !== 'string')) throw new Error('The actual saved target selection is unavailable.')
  return selection
}

/** Full first-cohort recipe. Source-only callers stay on the unchanged owner above. */
export async function savePreparedMcpPrerequisite(input: {
  plan?: PreparedGatewaySave; review: McpPrerequisiteReview; target: McpTargetPostimage; store: ConditionalSettingsStore;
  adapter: AdapterContext; fences: readonly GatewayRawFence[]; original: P5ApiManagement;
  record(outcome: McpResourceOutcome): void; recordTarget(outcome: import('$lib/appActions/settings/managementContract').AppActionsTargetOutcome): void
}): Promise<void> {
  const { original, review, target, adapter, store } = input
  if (p5ApiWrites.has(original) || !store.writeMcpTarget || !store.readMcpTargetResult || !store.readMcpTarget) throw new AppActionsManagementRefusal('MCP_PREREQUISITE_REPLAY', 'The actual prerequisite cannot issue again.', 409)
  const actual = readP5ApiManagementOwner(original)
  if (actual.userId !== adapter.admission.actor.userId || actual.agentId !== adapter.admission.actor.id || actual.gatewayId !== review.resource.gatewayId) throw new Error('The original prerequisite actor changed.')
  const fact: ApiPrerequisite = { review, plan: input.plan, target, adapter, store, fences: input.fences, complete: false }
  let operationFences = input.fences
  const observed: ApiWriteObservation = { result: 'pending', prerequisite: fact }
  p5ApiWrites.set(original, observed)
  const stages = Object.fromEntries(MCP_CONFIGURATION_STAGES.map(stage => [stage, 'not_started'])) as McpConfigurationJournal
  for (const stage of ['installation','dockerFile'] as const) stages[stage] = 'not_requested'
  stages.keyReference = 'not_requested'; stages.registry = 'not_requested'; stages.zip = review.intent.zip ? 'not_started' : 'not_requested'
  let targetAcknowledged = false
  let saved: McpResourceOutcome['saved'] = 'not_requested', physical = false
  const targetWrite: { saved: 'saved' | 'not_requested' | 'unknown' } = { saved: 'not_requested' }
  const check = () => { assertP5ApiManagementCurrent(original, actual.gatewayId); adapter.assertCurrent() }
  const note = (result: ApiWriteObservation['result']) => { observed.result = result; notifyP5ApiManagement(original) }
  const emit = (status: McpResourceOutcome['status'], reason: string) => input.record({ variant: 'prerequisite', resource: review.resource, status, saved, stages: { ...stages }, reason })
  let sourceSaved: 'saved' | 'not_requested' | 'unknown' = 'not_requested'
  let sourceRefreshIssued = false, targetRefreshIssued = false
  // Identity-only invalidation follows actual sent/known save truth, including
  // downstream failure. It never supplies a save base or retries the mutation.
  const announceSaves = async () => {
    if (review.sourceAction === 'save' && sourceSaved !== 'not_requested' && !sourceRefreshIssued) {
      sourceRefreshIssued = true
      await publishUserEvent(actual.userId, { type: 'mcp_gateway_source_changed', gatewayId: actual.gatewayId })
    }
    if (targetWrite.saved !== 'not_requested' && !targetRefreshIssued) {
      targetRefreshIssued = true
      await publishUserEvent(actual.userId, { type: 'agent_settings_changed', agentId: target.subject.id, family: 'mcp-settings' })
    }
  }
  const targetFences: GatewayRawFence[] = [{ key: `agent:${target.before.subjectId}`, paths: target.before.paths.map((path, index) => [path, target.before.raw[index]] as const) },
    ...(target.before.globalRaw !== undefined ? [{ key: `user:${actual.userId}:settings`, paths: [['$.global_zip_settings', target.before.globalRaw] as const] }] : [])]
  const finish = async () => {
    check()
    await adapter.refreshAuthority(); check()
    const cut = await mcpGatewayService.readMcpPrerequisiteIssueCut(actual.userId, actual.agentId, actual.gatewayId, adapter.deadlineAt,
      mcpGatewayService.joinMcpPrerequisiteFences([adapter.admission.fence], operationFences, targetFences))
    check()
    if (review.mode === 'configure') {
      if (!input.plan || cut.sourceRaw !== mcpGatewayService.readPreparedMcpSource(input.plan).raw) throw new Error('The verified source changed before target issue.')
    }
    fact.sourceIdentity = cut.sourceIdentity
    fact.ack = await store.writeMcpTarget!(target, adapter, mcpGatewayService.joinMcpPrerequisiteFences([adapter.admission.fence], operationFences, targetFences, cut.sourceFence ? [cut.sourceFence] : []), cut.sourceIdentity,
      () => { check(); physical = true; targetWrite.saved = 'unknown'; stages.discoverability = 'issued'; if (review.intent.zip) stages.zip = 'issued'; emit('unknown', 'target_write_issued') },
      (ack, state) => {
        targetAcknowledged = true; fact.ack = ack
        targetWrite.saved = state
        if (state === 'saved') saved = 'saved'
        stages.discoverability = ack ? state === 'saved' ? 'saved' : 'verified' : 'unconfirmed'
        if (review.intent.zip) stages.zip = ack ? state === 'saved' ? 'saved' : 'verified' : 'unconfirmed'
        input.recordTarget({ subject: target.subject, status: ack ? state === 'saved' ? 'applied' : 'unchanged' : 'unknown',
          saved: state, readback: ack ? 'verified' : 'unavailable', visible: 'unknown', reason: ack ? 'mcp_target_acknowledged' : 'mcp_target_postimage_unavailable' })
      }, () => { targetWrite.saved = 'not_requested'; stages.discoverability = 'blocked'; if (review.intent.zip) stages.zip = 'blocked' })
    check()
    const ack = store.readMcpTargetResult!(fact.ack)
    const readback = await store.readMcpTarget!(actual.userId, target.subject, target.settingsIdentity)
    check()
    if (JSON.stringify(ack.raw) !== JSON.stringify(readback.raw) || readback.globalRaw !== target.before.globalRaw) throw new Error('The actual target readback changed after its ACK.')
    await announceSaves(); check()
    fact.complete = true
    note('saved') // known complete no-op is settled; it is not a fabricated write
    emit(saved === 'saved' ? 'applied' : 'unchanged', 'mcp_prerequisite_completed')
  }
  try {
    if (review.mode === 'remove') {
      // Structural narrowing owns old issued work but probes no A source/key.
      await joinP5OriginalStdioManagement(original, [], false, adapter.deadlineAt)
      stages.verification = 'not_requested'; await finish(); return
    }
    if (!input.plan) throw new Error('The genuine prepared source is unavailable.')
    const originalAFences = await joinP5OriginalStdioManagement(original,
      [adapter.admission.fence, ...input.fences, ...targetFences], true, adapter.deadlineAt, [], 1)
    operationFences = mcpGatewayService.joinMcpPrerequisiteFences(input.fences, originalAFences)
    check()
    await mcpGatewayService.withPreparedMcpSourceAuth(input.plan, operationFences, async () => {
      check()
      stages.keyReference = review.after?.savedKeyRef || review.after?.stdio?.envRefs.length ? 'verified' : 'not_requested'
      const sourceFences = mcpGatewayService.joinMcpPrerequisiteFences([adapter.admission.fence], operationFences, targetFences)
      if (review.sourceAction === 'save') {
        await mcpGatewayService.commitPreparedGatewaySave(input.plan!, { adapter, fences: sourceFences, additionalLifecycle: target.before.lifecycle,
          beforeIssue() { check(); physical = true; sourceSaved = saved = 'unknown'; stages.registry = 'issued'; note('unknown'); emit('unknown', 'source_write_issued') },
          onSaved() { sourceSaved = saved = 'saved'; stages.registry = 'saved'; note('pending'); emit('unknown', 'source_saved_verification_pending') },
          onRefused() { physical = false; sourceSaved = saved = 'not_requested'; stages.registry = 'blocked'; note('refused') } })
      } else await mcpGatewayService.retainUnchangedMcpSource(input.plan!, actual.agentId, adapter, sourceFences)
      check()
      mcpGatewayService.readPreparedMcpSource(input.plan!) // actual ACK required, never a late-get substitute
      const discovery = await import('./mcpGatewayDiscovery'); check(); fact.discovery = discovery
      stages.verification = 'unconfirmed'
      emit('unknown', 'setup_verification_pending')
      fact.setup = await discovery.mcpGatewayDiscovery.discoverForHeldMcpSetup(original, { plan: input.plan!, gatewayId: actual.gatewayId, adapter, fences: sourceFences })
      check(); stages.verification = 'verified'
      await finish()
    })
  } catch (error) {
    fact.complete = false
    if (error instanceof GatewayManagementWriteUnconfirmed) {
      sourceSaved = saved = error.gatewaySaved ? 'saved' : 'unknown'; stages.registry = error.gatewaySaved ? 'saved' : 'unknown'; note(error.gatewaySaved ? 'saved' : 'unknown')
    }
    if (targetWrite.saved === 'unknown') { stages.discoverability = 'unknown'; if (review.intent.zip) stages.zip = 'unknown' }
    if (fact.setup && fact.discovery) {
      const setup = fact.discovery.readP5McpClientSettlement(fact.setup)
      if (setup.constructor === 'started') physical = true
      const known = setup.constructor === 'not_started' || setup.close === 'known' && (setup.requests === 'not_started' ||
        setup.requests === 'known' && setup.initialize === 'known' && setup.list === 'known')
      stages.verification = known ? 'blocked' : 'unconfirmed'
    } else if (stages.verification === 'unconfirmed') stages.verification = 'blocked'
    note(saved === 'unknown' || targetWrite.saved === 'unknown' || stages.verification === 'unconfirmed' ? 'unknown' : 'refused')
    try {
      if (!targetAcknowledged) input.recordTarget({ subject: target.subject, status: targetWrite.saved === 'unknown' ? 'unknown' : 'blocked', saved: targetWrite.saved,
        readback: 'not_requested', visible: 'unknown', reason: targetWrite.saved === 'unknown' ? 'mcp_target_write_unconfirmed' : 'mcp_target_not_issued' })
      emit(physical && (saved === 'unknown' || targetWrite.saved === 'unknown' || stages.verification === 'unconfirmed') ? 'unknown' : 'blocked',
        physical ? 'prerequisite_followup_unconfirmed' : 'prerequisite_refused_before_effect')
    } catch { /* journal failure cannot replace the actual effect/error identity */ }
    try { await announceSaves() } catch { /* refresh failure cannot replace the actual save/setup/callback failure */ }
    throw error // actual callback/Redis error identity is retained; no replay
  }
}

/** Current use is distinct from the one-use exact-ACK claim below. A later
 * genuine sibling addition must not invalidate still-selected C1, but THIS
 * original source/ref/authority/incarnation and requested target leaves remain. */
export async function readP5ApiVerifiedSourceUse(original: P5ApiManagement) {
  const fact = p5ApiWrites.get(original)?.prerequisite
  if (!fact?.complete || !fact.plan || !fact.ack || !fact.store.readMcpTarget || !fact.store.readMcpTargetResult) return undefined
  const actual = readP5ApiManagementOwner(original)
  const check = () => { assertP5ApiManagementCurrent(original, actual.gatewayId); fact.adapter.assertCurrent() }
  check(); await fact.adapter.refreshAuthority(); check()
  fact.store.readMcpTargetResult(fact.ack) // Same actual ACK ownership, never a posted saved flag.
  const current = await fact.store.readMcpTarget(actual.userId, fact.target.subject, fact.target.settingsIdentity); check()
  const membership = current.row.defaultMCPGateways ?? current.row.default_mcp_gateways ?? []
  if (Array.isArray(membership) && !membership.includes(actual.gatewayId)) observeP5ApiVerifiedSourceRemoval(original, fact.target.subject.id)
  if (JSON.stringify(current.lifecycle) !== JSON.stringify(fact.target.before.lifecycle) ||
    Object.keys(planMcpTarget(current, fact.review.intent, fact.target.settingsIdentity).updates).length !== 0) throw new Error('The original verified target intent or incarnation changed before use.')
  const targetFences: GatewayRawFence[] = [fact.adapter.admission.fence, ...fact.fences,
    { key: `agent:${current.subjectId}`, paths: current.paths.map((path, index) => [path, current.raw[index]] as const) },
    ...(current.globalRaw !== undefined ? [{ key: `user:${actual.userId}:settings`, paths: [['$.global_zip_settings', current.globalRaw] as const] }] : [])]
  const originalAFences = await joinP5OriginalStdioManagement(original, targetFences, true, fact.adapter.deadlineAt,
    fact.review.mode === 'remove' && fact.target.subject.id === actual.agentId ? [actual.gatewayId] : [], 0, false)
  check()
  const fences = mcpGatewayService.joinMcpPrerequisiteFences(targetFences, originalAFences)
  const cut = await mcpGatewayService.readMcpPrerequisiteIssueCut(actual.userId, actual.agentId, actual.gatewayId, fact.adapter.deadlineAt, fences); check()
  if (cut.sourceRaw !== mcpGatewayService.readPreparedMcpSource(fact.plan).raw) throw new Error('The original verified C source changed before use.')
  return Object.freeze({ plan: fact.plan, intent: fact.review.intent, settingsIdentity: fact.target.settingsIdentity,
    fences: Object.freeze(fences), deadlineAt: fact.adapter.deadlineAt })
}

/** SAME real writer/target ACK/client facts, refreshed at the outer canonical barrier.
 * Return data only; originalTask consumes the actual ticket once. */
export async function readP5ApiPrerequisiteCompletion(original: P5ApiManagement) {
  const fact = p5ApiWrites.get(original)?.prerequisite
  if (!fact?.complete || !fact.ack || !fact.sourceIdentity || !fact.store.readMcpTargetResult || !fact.store.readMcpTarget) return undefined
  const actual = readP5ApiManagementOwner(original)
  const check = () => { assertP5ApiManagementCurrent(original, actual.gatewayId); fact.adapter.assertCurrent() }
  check(); await fact.adapter.refreshAuthority(); check()
  const ack = fact.store.readMcpTargetResult(fact.ack)
  const current = await fact.store.readMcpTarget(actual.userId, fact.target.subject, fact.target.settingsIdentity); check()
  if (JSON.stringify(current.raw) !== JSON.stringify(ack.raw) || current.globalRaw !== fact.target.before.globalRaw) throw new Error('The exact prerequisite target changed before continuation.')
  const targetFences: GatewayRawFence[] = [fact.adapter.admission.fence, ...fact.fences,
    { key: `agent:${current.subjectId}`, paths: current.paths.map((path, index) => [path, ack.raw[index]] as const) },
    ...(current.globalRaw !== undefined ? [{ key: `user:${actual.userId}:settings`, paths: [['$.global_zip_settings', current.globalRaw] as const] }] : [])]
  const originalAFences = await joinP5OriginalStdioManagement(original, targetFences, true, fact.adapter.deadlineAt,
    fact.review.mode === 'remove' && fact.target.subject.id === actual.agentId ? [actual.gatewayId] : [])
  check()
  const fences = mcpGatewayService.joinMcpPrerequisiteFences(targetFences, originalAFences)
  const cut = await mcpGatewayService.readMcpPrerequisiteIssueCut(actual.userId, actual.agentId, actual.gatewayId, fact.adapter.deadlineAt, fences); check()
  if (cut.sourceIdentity.createdAt !== fact.sourceIdentity.createdAt || fact.review.mode === 'configure' &&
    (!fact.plan || cut.sourceRaw !== mcpGatewayService.readPreparedMcpSource(fact.plan).raw)) throw new Error('The exact prerequisite source changed before continuation.')
  if (fact.review.mode === 'configure') {
    if (!fact.setup) return undefined
    const discovery = await import('./mcpGatewayDiscovery'); check()
    const settled = discovery.readP5McpClientSettlement(fact.setup)
    if (settled.requests !== 'known' || settled.initialize !== 'known' || settled.list !== 'known' || settled.execute !== 'not_started' || settled.close !== 'known') return undefined
    // Recheck all raw facts after the last module await. No awaited work follows
    // this final observation before originalTask's synchronous one-use claim.
    const final = await mcpGatewayService.readMcpPrerequisiteIssueCut(actual.userId, actual.agentId, actual.gatewayId, fact.adapter.deadlineAt, fences); check()
    if (final.sourceRaw !== cut.sourceRaw || final.actorIdentityRaw !== cut.actorIdentityRaw) throw new Error('The final prerequisite observation changed.')
  }
  return Object.freeze({ intent: fact.review.intent, ...(fact.plan ? { plan: fact.plan } : {}), sourceIdentity: fact.sourceIdentity, fences: Object.freeze(fences), deadlineAt: fact.adapter.deadlineAt })
}

export async function createHumanMcpGateway(userId: string, body: Record<string, any>): Promise<HumanGatewaySaveResult> {
  // BL-1407 / BL-1386: as in PUT, every check runs before the create, and the token store and the
  // Docker profile file follow the stored create; after it, every failure is a 500 that says the
  // settings were saved and names what could not be finished. Nothing written is undone.
  let written = false
  let createdId = ''
  const notConfirmed: string[] = []
  try {

    // Validate required fields
    const requiresUrl = body.type !== 'stdio'
    if (!body.name || !body.type || (requiresUrl && !body.url)) {
      return response(
        { error: requiresUrl ? 'Missing required fields: name, type, url' : 'Missing required fields: name, type' },
        { status: 400 }
      )
    }

    let metadata = body.metadata || {}
    let sentToken = ''
    let writeProfile = false
    if (body.type === 'n8n-instance-mcp') {
      sentToken = typeof metadata?.authToken === 'string' ? metadata.authToken.trim() : ''
      // BL-1407: checked now (the "Invalid …" 400), stored only after the create.
      if (sentToken) {
        apiKeyService.buildStoredDocument('n8n_instance_mcp_token', sentToken)
      }
      if (metadata && typeof metadata === 'object') {
        const { authToken: _ignored, ...rest } = metadata
        metadata = rest
      }
    } else if (body.type === 'docker-catalog') {
      const hasProfile =
        typeof metadata?.dockerProfile === 'string' || typeof metadata?.docker_profile === 'string'
      const rawProfile =
        typeof metadata?.dockerProfile === 'string'
          ? metadata.dockerProfile
          : typeof metadata?.docker_profile === 'string'
            ? metadata.docker_profile
            : getActiveDockerMcpProfile()
      const dockerProfile = normalizeDockerMcpProfile(rawProfile)
      if (hasProfile) {
        // BL-1386: the containerized refusal before the create; the file is written after it.
        assertDockerMcpProfileWritable()
        writeProfile = true
      }
      metadata = {
        ...(metadata && typeof metadata === 'object' ? metadata : {}),
        dockerProfile
      }
      delete (metadata as Record<string, any>).docker_profile
    }

    // Create gateway with defaults
    const gateway: MCPGateway = {
      id: body.id || crypto.randomUUID(),
      name: body.name,
      type: body.type,
      ...(body.url ? { url: body.url } : {}),
      enabled: body.enabled !== undefined ? body.enabled : true,
      autoStart: body.autoStart,
      ...(body.authKeyName ? { authKeyName: body.authKeyName } : {}),
      ...(body.stdioConfig ? { stdioConfig: body.stdioConfig } : {}),
      discoveredTools: body.discoveredTools || [],
      lastDiscovery: body.lastDiscovery,
      dcmDisplayDefaults: body.dcmDisplayDefaults,
      metadata,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }

    createdId = (await mcpGatewayService.create(userId, gateway)).id
    written = true

    if (sentToken) {
      // BL-1407: an explicit save, unconditional. A failure may still have written the key, so it
      // is "not confirmed": never undone, never retried here.
      try {
        await apiKeyService.store('n8n_instance_mcp_token', sentToken, userId)
      } catch (error) {
        console.error('[API] n8n Instance MCP token store not confirmed after a stored gateway create', error)
        notConfirmed.push(TOKEN_NOT_CONFIRMED)
      }
    }
    if (writeProfile) {
      // BL-1386: as in PUT, the profile as stored when this write runs, one write at a time; a
      // failure may have written part or all of the file and is never undone or retried here.
      try {
        await runDockerMcpProfileWrite(async () => {
          const stored = await mcpGatewayService.get(userId, createdId)
          const storedProfile = stored?.type === 'docker-catalog' ? stored.metadata?.dockerProfile : undefined
          if (typeof storedProfile === 'string') await writeDockerMcpProfileEnv(storedProfile)
        })
      } catch (error) {
        console.error('[API] Docker MCP profile file not finished after a stored gateway create', error)
        notConfirmed.push(DOCKER_PROFILE_FILE_NOT_FINISHED)
      }
    }

    if (notConfirmed.length > 0) {
      return savedButFailed(notConfirmed.join(' '), createdId)
    }
    return response({ gateway: redactGatewaySecretsForBrowser(gateway) }, { status: 201 })
  } catch (error) {
    console.error('[API] Error creating gateway:', error)

    // The create is stored: neither "invalid" nor "already exists" is true.
    if (written) {
      return savedButFailed(createAfterSaveError(notConfirmed), createdId)
    }
    // Handle validation errors
    if (error instanceof Error) {
      if (error.message.includes('Invalid') || error.message.includes('already exists')) {
        return response({ error: error.message }, { status: 400 })
      }
    }

    return response(
      { error: 'Failed to create gateway' },
      { status: 500 }
    )
  }
}

export async function updateHumanMcpGateway(userId: string, id: string, updates: Record<string, any>): Promise<HumanGatewaySaveResult> {
  // BL-1371: a conflict is a 409 "nothing was saved" only before the write is stored. BL-1407 /
  // BL-1386: no part of this save and no side effect is stored before it either: every check runs
  // first, and the token store and the Docker profile file follow the stored write. So a 409, 404
  // or 400 means none of this save was stored (the earlier read may still store a normalizing
  // write of the registry, BL-1371). After the write, every failure is a 500 that says the
  // settings were saved and names what could not be finished; nothing written is undone.
  let written = false
  let sourceAcknowledgement: (MCPGateway & { sourceRevision: string }) | undefined
  const originalExpectedSource = updates.expectedGatewaySource
  updates = { ...updates }
  delete updates.expectedGatewaySource
  delete updates.sourceRevision
  const namesSource = namesHumanGatewaySource(updates)
  let sourceNotified = false
  const notifySourceChange = () => {
    if (!namesSource || sourceNotified) return
    sourceNotified = true
    void publishUserEvent(userId, { type: 'mcp_gateway_source_changed', gatewayId: id })
      .catch(() => console.warn('[API] MCP source invalidation could not be published'))
  }
  const notConfirmed: string[] = []
  try {
    const humanSource = namesSource ? (() => { requireHumanGatewaySource(originalExpectedSource); return { expectedGatewaySource: originalExpectedSource } })() : undefined
    // BL-1371: this earlier read gives only the type and the STDIO clearing below. Nothing written
    // is built from it: the n8n and Docker metadata are merged inside `update`, onto the gateway as
    // stored at its compare-and-set.
    const existing = await mcpGatewayService.get(userId, id)

    // Don't allow changing ID or created_at
    delete updates.id
    delete updates.created_at

    const gatewayType = updates.type ?? existing?.type

    if (gatewayType === 'stdio') {
      updates.url = undefined
      updates.authKeyName = undefined
    }

    // Update timestamp
    updates.updated_at = new Date().toISOString()

    let change: GatewayUpdate = updates
    let sentToken = ''
    let dockerProfile: string | null = null

    if (gatewayType === 'n8n-instance-mcp') {
      const updateMeta = (updates.metadata && typeof updates.metadata === 'object')
        ? updates.metadata
        : {}

      // BL-1397: only a token sent in this body is an explicit save of the canonical key. BL-1407:
      // it is checked now (format and injection: the "Invalid …" 400) and stored only after the
      // gateway write. With no token (or a blank one) the route stores none; the guarded move after
      // the write handles an old copy and never validates it synchronously.
      sentToken = typeof updateMeta.authToken === 'string' ? updateMeta.authToken.trim() : ''
      if (sentToken) apiKeyService.buildStoredDocument(N8N_INSTANCE_TOKEN_SERVICE, sentToken)

      // BL-1407: the gateway write keeps a stored copy. It leaves only through the guarded move,
      // which runs after this save's token store, so a store that fails after the write never
      // costs it. A blank or non-string stored value is no usable token and goes with this write.
      const { authToken: _sentToken, ...sentMeta } = updateMeta as Record<string, any>
      change = (stored) => {
        const storedMeta = (stored.metadata && typeof stored.metadata === 'object') ? stored.metadata : {}
        const metadata: Record<string, any> = { ...storedMeta, ...sentMeta }
        const storedToken = typeof storedMeta.authToken === 'string' ? storedMeta.authToken.trim() : ''
        if (!storedToken) {
          delete metadata.authToken
        }
        return { ...updates, metadata }
      }
    } else if (gatewayType === 'docker-catalog') {
      const updateMeta = (updates.metadata && typeof updates.metadata === 'object')
        ? updates.metadata
        : {}

      const hasProfileUpdate =
        Object.prototype.hasOwnProperty.call(updateMeta, 'dockerProfile') ||
        Object.prototype.hasOwnProperty.call(updateMeta, 'docker_profile')

      if (hasProfileUpdate) {
        dockerProfile = normalizeDockerMcpProfile(
          Object.prototype.hasOwnProperty.call(updateMeta, 'dockerProfile')
            ? updateMeta.dockerProfile
            : updateMeta.docker_profile
        )
        // BL-1386: the containerized refusal now, before the gateway write; the file is written
        // only after the write is stored.
        assertDockerMcpProfileWritable()
      }

      change = stored => dockerGatewayFields(stored, updates, dockerProfile)
    }

    await mcpGatewayService.update(userId, id, change, undefined, humanSource ? {
      ...humanSource,
      onSaved(ack) {
        // The exact successful CAS owner pairs the postimage and revision. No
        // later get/profile/token result is borrowed as this form's save base.
        sourceAcknowledgement = { ...presentMcpGatewayForBrowser(ack.gateway), sourceRevision: ack.sourceRevision }
        written = true
        notifySourceChange()
      }
    } : undefined)
    written = true
    // Grouping/DCM-only saves retain their ordinary path and no source token grant.
    // Source saves were already observed synchronously by the actual CAS callback.
    if (namesSource && !sourceAcknowledgement) throw new HumanGatewaySourceWriteUnconfirmed(true, new Error('The actual source ACK observer is unavailable.'))

    if (gatewayType === 'n8n-instance-mcp') {
      if (sentToken) {
        // BL-1407: an explicit save, unconditional (the last explicit save wins). A failure may
        // still have written the key (a lost answer), so it is "not confirmed": never undone and
        // never retried here. The user's next save stores it again.
        try {
          await apiKeyService.store(N8N_INSTANCE_TOKEN_SERVICE, sentToken, userId)
        } catch (error) {
          console.error('[API] n8n Instance MCP token store not confirmed after a stored gateway save', error)
          notConfirmed.push(TOKEN_NOT_CONFIRMED)
        }
      }
      // BL-1397: the guarded move runs after every stored n8n Instance save. It decides from the
      // saved key as it reads it: a readable key (the one just stored, or one saved before) retires
      // the copy; an absent key takes it. A step that keeps the copy or fails is a warning (no
      // value), never this save's error.
      try {
        const { outcome } = await moveLegacyN8nInstanceToken(userId, id)
        if (!['moved', 'retired', 'superseded', 'no_copy'].includes(outcome)) {
          console.warn(`[API] n8n Instance MCP token of gateway ${id} not moved (${outcome})`)
        }
      } catch (error) {
        console.warn('[API] n8n Instance MCP token move failed after a stored gateway save', error)
      }
    }

    if (dockerProfile !== null) {
      // BL-1386: the profile file follows the stored gateway. It is written after the stored write,
      // from the profile as stored when this write runs, one write at a time. Every save that
      // carried a profile writes, the same profile included, so the next such save repairs a
      // failed write. A failure may have written part or all of the file: never undone, never
      // retried here.
      try {
        await runDockerMcpProfileWrite(async () => {
          const stored = await mcpGatewayService.get(userId, id)
          const storedProfile = stored?.type === 'docker-catalog' ? stored.metadata?.dockerProfile : undefined
          if (typeof storedProfile === 'string') await writeDockerMcpProfileEnv(storedProfile)
        })
      } catch (error) {
        console.error('[API] Docker MCP profile file not finished after a stored gateway save', error)
        notConfirmed.push(DOCKER_PROFILE_FILE_NOT_FINISHED)
      }
    }

    // Ordinary grouping/DCM-only writes return one genuinely paired current read.
    // A source write always keeps its earlier SAME-ACK base instead.
    const readLifecycle = captureSettingsLifecycle([`mcp_gateways:${userId}`])
    const gateway = await mcpGatewayService.get(userId, id)
    assertSettingsLifecycle(readLifecycle)

    if (notConfirmed.length > 0) {
      return savedButFailed(notConfirmed.join(' '), id, sourceAcknowledgement)
    }
    return response({ gateway: gateway ? sourceAcknowledgement ?? presentMcpGatewayForBrowser(gateway, userId, readLifecycle) : gateway, ...(sourceAcknowledgement ? { sourceAcknowledgement } : {}) })
  } catch (error) {
    console.error('[API] Error updating gateway:', error)

    // The gateway write is stored: none of "nothing was saved", "not found" or "invalid" is true.
    if (error instanceof HumanGatewaySourceWriteUnconfirmed) {
      notifySourceChange() // late/unknown physical issue still invalidates; never grants readiness
      if (error.gatewaySaved) written = true
      if (!written) return response({ error: error.message, code: error.code }, { status: error.status })
    }
    if (written) {
      return savedButFailed(updateAfterSaveError(notConfirmed), id, sourceAcknowledgement)
    }
    if (error instanceof HumanGatewaySourceRequiredError || error instanceof HumanGatewaySourceConflictError) {
      return response({ error: error.message, code: error.code }, { status: error.status })
    }
    if (error instanceof GatewayRegistryConflictError) {
      return response({ error: error.message }, { status: 409 })
    }
    if (error instanceof Error) {
      if (error.message.includes('not found')) {
        return response({ error: error.message }, { status: 404 })
      }
      if (error.message.includes('Invalid')) {
        return response({ error: error.message }, { status: 400 })
      }
    }

    return response(
      { error: 'Failed to update gateway' },
      { status: 500 }
    )
  }
}
