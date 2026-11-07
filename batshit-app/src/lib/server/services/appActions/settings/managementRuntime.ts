import { hashControlInput } from '$lib/server/services/controlApprovals'
import { redis } from '$lib/server/redis'
import { parseManagedSettingsChangeInput, parseManagedSettingsReportInput } from '$lib/appActions/settings/managementInput'
import { isAppActionsApprovalPreviewForControl } from '$lib/appActions/settings/managementContract'
import { SETTINGS_FABRIC_CONTROLS, parseSettingsAction, type SettingsActionId } from '$lib/appActions/settingsContract'
import { reportObject, type SettingsSubjectRef } from '$lib/appActions/settings/reportContract'
import { managedSettingsStore } from './managedStore'
import { createSettingsOperationRegistry } from './operationRegistry'
import { createSettingsManagementReports } from './managementReports'
import { createSettingsChanges } from './changeOperations'
import { AppActionsManagementRefusal, readNativePolicyAuthority, policyContainsSubject } from './authority'
import {
  admitSettingsManagementActor, nativeSettingsSignal, SETTINGS_MANAGEMENT_CONTROL_IDS, type SettingsManagementContext
} from './managementActor'
import { issueSettingsStandingConsent, type SettingsStandingConsent } from './standingConsent'
import { settingsRestoreAuthorityUncertain } from './lifecycle'
import { createManagementAdapterContext } from '../adapterContext'
import { MANAGEMENT_ADAPTER_BINDINGS } from '../managementAdapters'

export const settingsOperationRegistry = createSettingsOperationRegistry()
export const settingsManagementReports = createSettingsManagementReports(settingsOperationRegistry.boot, managedSettingsStore)
export const settingsManagementChanges = createSettingsChanges(settingsOperationRegistry, settingsManagementReports, managedSettingsStore)
export type PreparedSettingsControl = {
  controlId: string
  noEffect: boolean
  standingConsent?: SettingsStandingConsent
  authorityFence?: { key: string; paths: Array<[string, string]> }
  approvalPreview?: ReturnType<typeof settingsOperationRegistry.nativeApprovalPreview>
}
const legacyActions = new Map<string, SettingsActionId>(Object.entries(SETTINGS_FABRIC_CONTROLS).map(([action, controlId]) => [controlId, action as SettingsActionId]))
/** Input, actor, subject, category and captured preimage admission all precede a new approval. */
export async function prepareSettingsControl(context: SettingsManagementContext, controlId: string, input: unknown): Promise<PreparedSettingsControl | null> {
  if (controlId === SETTINGS_MANAGEMENT_CONTROL_IDS.nativeReport || controlId === SETTINGS_MANAGEMENT_CONTROL_IDS.portableReport) {
    parseManagedSettingsReportInput(input)
    await admitSettingsManagementActor(context, controlId === SETTINGS_MANAGEMENT_CONTROL_IDS.nativeReport ? 'native' : 'portable')
    return { controlId, noEffect: true }
  }
  if (controlId === SETTINGS_MANAGEMENT_CONTROL_IDS.nativeChange || controlId === SETTINGS_MANAGEMENT_CONTROL_IDS.portableChange) {
    const lane = controlId === SETTINGS_MANAGEMENT_CONTROL_IDS.nativeChange ? 'native' : 'portable'
    const prepared = await settingsManagementChanges.prepare(context, lane, input)
    if (lane === 'portable') return { controlId, noEffect: true } // The token's inner operation owner applies its exact scoped user-consent decision.
    const noEffect = prepared.input.op !== 'change' || !prepared.gate
    let approvalPreview: PreparedSettingsControl['approvalPreview']
    if (!noEffect && prepared.input.op === 'change') {
      approvalPreview = settingsOperationRegistry.nativeApprovalPreview(context.userId, context.agentId!, context.sessionId!, prepared.input.requestId)
      if (!approvalPreview || hashControlInput(approvalPreview.input) !== hashControlInput(input) ||
        !isAppActionsApprovalPreviewForControl(approvalPreview, { controlId, input })) throw new AppActionsManagementRefusal('TRUSTED_PREVIEW_REQUIRED', 'The exact held Settings preview is unavailable. Request a fresh operation.', 409)
    }
    const standingConsent = !noEffect && prepared.operation.status === 'ready'
      ? issueSettingsStandingConsent({ userId: context.userId, agentId: context.agentId!, controlId, inputHash: hashControlInput(input), expiresAt: Date.now() + 5000 }) : undefined
    return { controlId, noEffect, approvalPreview, standingConsent }
  }
  const action = legacyActions.get(controlId)
  if (!action || action === 'settings.inspect' || !context.agentId || context.actorType !== 'in-process') return null
  const parsed = parseSettingsAction(action, input)
  if ('subjectAgentId' in parsed && parsed.subjectAgentId !== context.agentId) throw new AppActionsManagementRefusal('OWN_AGENT_REQUIRED', 'The shipped own-agent alias cannot target another agent.')
  const row = await redis.json.get(`agent:${context.agentId}`) as Record<string, unknown> | null
  // Preserve the unconfigured legacy lane without manufacturing a grant. Its atomic
  // writer independently refuses if a policy appears before the actual save.
  if (row?.app_action_policy === undefined || row?.app_action_policy === null) return null
  const authority = await readNativePolicyAuthority(context.userId, context.agentId)
  if (!authority.record) return null // Absence preserves the shipped own-agent behavior.
  nativeSettingsSignal(context)
  if (!authority.record.policy.enabled || !policyContainsSubject(authority.record.policy, { kind: 'primary', id: context.agentId }, context.agentId)) {
    throw new AppActionsManagementRefusal('APP_ACTIONS_DISABLED', 'The user blocked this own-agent Settings alias.')
  }
  if (!action.endsWith('.update')) return { controlId, noEffect: true, authorityFence: authority.fence }
  const mode = action.includes('.memory.') ? authority.record.policy.protected.memorySettings : authority.record.policy.ordinaryChanges ? 'allow' : 'block'
  if (mode === 'block') throw new AppActionsManagementRefusal('SETTINGS_CHANGE_BLOCKED', 'The user blocked this Settings category.')
  return { controlId, noEffect: false, authorityFence: authority.fence,
    ...(mode === 'allow' ? { standingConsent: issueSettingsStandingConsent({ userId: context.userId, agentId: context.agentId, controlId,
      inputHash: hashControlInput(input), expiresAt: Date.now() + 5000 }) } : {}) }
}
export function settingsNativeApprovalPreview(userId: string, agentId: string, sessionId: string, input: unknown) {
  const parsed = parseManagedSettingsChangeInput(input)
  if (parsed.op !== 'change') return null
  const preview = settingsOperationRegistry.nativeApprovalPreview(userId, agentId, sessionId, parsed.requestId)
  if (!preview || hashControlInput(preview.input) !== hashControlInput(input) ||
    !isAppActionsApprovalPreviewForControl(preview, { controlId: SETTINGS_MANAGEMENT_CONTROL_IDS.nativeChange, input })) throw new AppActionsManagementRefusal('TRUSTED_PREVIEW_REQUIRED', 'The trusted exact Settings preview is unavailable.', 409)
  return preview
}
export async function executeSettingsManagement(context: SettingsManagementContext, controlId: string, input: unknown) {
  const lane = controlId.includes('.portable.') ? 'portable' : 'native'
  if (controlId.endsWith('.report')) {
    const args = parseManagedSettingsReportInput(input)
    if (args.domain === 'runtime-inspection') {
      const admission = await admitSettingsManagementActor(context, lane)
      const assertPermission = () => {
        if (!admission.policy.enabled || admission.policy.management.runtimeManagement === 'block') throw new AppActionsManagementRefusal('RUNTIME_INSPECTION_BLOCKED', 'The user blocked runtime management.')
      }
      const adapter = createManagementAdapterContext(admission, () => context, Math.min(Date.now() + 20_000, admission.expiresAt ?? Infinity), { assertPermission })
      adapter.assertCurrent()
      const result = await MANAGEMENT_ADAPTER_BINDINGS['runtime.inspection'].read(adapter)
      // The finite leaf refreshes actor authority then verifies source identity
      // before returning. Keep this handoff synchronous after that final check.
      adapter.assertCurrent()
      return result
    }
    return settingsManagementReports.report(context, lane, args)
  }
  return settingsManagementChanges.change(context, lane, input)
}
export async function readSettingsOperationReview(userId: string, operationId: string) {
  return { success: true as const, operation: await settingsOperationRegistry.humanReview(userId, operationId) }
}
export async function decideSettingsOperation(userId: string, operationId: string, body: unknown) {
  const input = reportObject(body, ['decision', 'intentDigest'])
  if (input.decision !== 'approve' && input.decision !== 'deny' || typeof input.intentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.intentDigest)) {
    throw new AppActionsManagementRefusal('INVALID_DECISION', 'Approve or deny the exact displayed operation.', 400)
  }
  return { success: true as const, operation: await settingsOperationRegistry.decide(userId, operationId, input.intentDigest, input.decision) }
}
/** Filter before scoring/count/limit. A claimed body agent never supplies an actor lane. */
export async function settingsControlsVisible(options: {
  userId?: string | null; agentId?: string | null; actorType?: string; delegatedRun?: boolean
  /** Server-verified typed owned Primary preview. Metadata only; execution never reads it. */
  ownedPrimaryPreview?: boolean
  portableSettingsActor?: { tokenId: string; authorityGeneration: number }
}, primarySnapshot?: { agentId: string; record: Record<string, unknown> | null }): Promise<Set<string>> {
  const result = new Set<string>()
  if (!options.userId || options.delegatedRun) return result
  // A known uncertain App Actions restore fence hides this family only; the
  // existing authenticated token's unrelated families remain independently usable.
  if (settingsRestoreAuthorityUncertain()) return result
  // SA-139 R4: a non-delegated run credential (`agent`) came only from a CLI Primary run, so
  // native discovery follows the native actor: an in-process API turn or its owned preview.
  const nativeDiscovery = options.actorType === 'in-process' ||
    options.actorType === 'session' && options.ownedPrimaryPreview === true
  if (nativeDiscovery && options.agentId) {
    const row = primarySnapshot?.agentId === options.agentId ? primarySnapshot.record
      : await redis.get(`agent:${options.agentId}`, { throwOnError: true }) as Record<string, unknown> | null
    if (row?.app_action_policy === undefined || row?.app_action_policy === null) return result
    const authority = await readNativePolicyAuthority(options.userId, options.agentId)
    if (authority.record?.policy.enabled) { result.add(SETTINGS_MANAGEMENT_CONTROL_IDS.nativeReport); result.add(SETTINGS_MANAGEMENT_CONTROL_IDS.nativeChange) }
  } else if (options.actorType === 'portable-skill' && options.portableSettingsActor) {
    const { readPortableAppActionsAuthority } = await import('./authority')
    const authority = await readPortableAppActionsAuthority(options.userId, options.portableSettingsActor.tokenId, false)
    if (authority.generation !== options.portableSettingsActor.authorityGeneration) throw new AppActionsManagementRefusal('AUTHORITY_CHANGED', 'The token authority changed during discovery.')
    // Absence/disabled/expired App Actions scope hides only its own wrappers. A valid
    // token may still use every unrelated family. Malformed/storage failures propagate.
    if (authority.hasAppActionsFamily && authority.grant?.policy.enabled && Date.parse(authority.grant.expiresAt) > Date.now()) {
      result.add(SETTINGS_MANAGEMENT_CONTROL_IDS.portableReport); result.add(SETTINGS_MANAGEMENT_CONTROL_IDS.portableChange)
    }
  }
  return result
}
