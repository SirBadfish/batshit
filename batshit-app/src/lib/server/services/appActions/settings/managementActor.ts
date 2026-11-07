import { requireAppActionTopology } from '../runtime'
import {
  AppActionsManagementRefusal, policyContainsSubject, readNativePolicyAuthority, readPortableAppActionsAuthority
} from './authority'
import type { SettingsSubjectRef } from '$lib/appActions/settings/reportContract'
import type { SettingsManagementContext, SettingsManagementAdmission } from '../managementTypes'
export type { SettingsManagementContext, SettingsManagementAdmission } from '../managementTypes'

export const SETTINGS_MANAGEMENT_CONTROL_IDS = Object.freeze({
  nativeReport: 'sys.app_settings.native.report', nativeChange: 'sys.app_settings.native.change',
  portableReport: 'sys.app_settings.portable.report', portableChange: 'sys.app_settings.portable.change'
})
/** Native Settings authority belongs only to a live in-process Primary reply. */
export function nativeSettingsSignal(context: SettingsManagementContext): AbortSignal {
  if (context.delegatedRun || !context.agentId || !context.sessionId || context.actorType !== 'in-process') {
    throw new AppActionsManagementRefusal('NATIVE_ACTOR_REQUIRED', 'App Actions management requires a running Primary Agent.')
  }
  const signal = context.abortSignal
  if (!(signal instanceof AbortSignal) || signal.aborted) throw new AppActionsManagementRefusal('CONTROL_CANCELLATION_REQUIRED', 'This exact reply has ended or stopped.')
  return signal
}
export async function admitSettingsManagementActor(context: SettingsManagementContext, lane: 'native' | 'portable'): Promise<SettingsManagementAdmission> {
  requireAppActionTopology()
  if (lane === 'native') {
    const signal = nativeSettingsSignal(context)
    const current = await readNativePolicyAuthority(context.userId, context.agentId!)
    nativeSettingsSignal(context)
    if (!current.record?.policy.enabled) throw new AppActionsManagementRefusal('APP_ACTIONS_DISABLED', 'The user has not enabled this App Actions scope.')
    return { actor: { userId: context.userId, kind: 'native', id: context.agentId!, generation: current.record.generation,
      label: 'Primary Agent', sessionId: context.sessionId! }, policy: current.record.policy, fence: current.fence, signal }
  }
  if (context.actorType !== 'portable-skill' || context.agentId || context.delegatedRun || !context.portableSettingsActor) {
    throw new AppActionsManagementRefusal('PORTABLE_ACTOR_REQUIRED', 'This operation requires the scoped token holder, without an acting agent identity.')
  }
  const { tokenId, authorityGeneration } = context.portableSettingsActor
  const current = await readPortableAppActionsAuthority(context.userId, tokenId)
  if (current.generation !== authorityGeneration || !current.grant) throw new AppActionsManagementRefusal('AUTHORITY_CHANGED', 'The token authority changed after this request authenticated.')
  return { actor: { userId: context.userId, kind: 'portable', id: tokenId, generation: current.generation, label: current.label },
    policy: current.grant.policy, fence: current.fence, expiresAt: Date.parse(current.grant.expiresAt) }
}
export function sameSettingsAuthority(left: SettingsManagementAdmission, right: SettingsManagementAdmission): boolean {
  return left.actor.userId === right.actor.userId && left.actor.id === right.actor.id && left.actor.kind === right.actor.kind &&
    left.actor.generation === right.actor.generation && left.fence.key === right.fence.key && JSON.stringify(left.fence.paths) === JSON.stringify(right.fence.paths) &&
    JSON.stringify(left.fence.lifecycle) === JSON.stringify(right.fence.lifecycle)
}
export function requireSettingsSubjectAdmission(admission: SettingsManagementAdmission, subject: SettingsSubjectRef): void {
  if (!policyContainsSubject(admission.policy, subject, admission.actor.kind === 'native' ? admission.actor.id : undefined)) {
    throw new AppActionsManagementRefusal('SUBJECT_NOT_GRANTED', 'That subject is outside the user-granted App Actions scope.')
  }
}
export async function refreshSettingsOperationAuthority(admission: SettingsManagementAdmission) {
  const current = admission.actor.kind === 'native'
    ? await readNativePolicyAuthority(admission.actor.userId, admission.actor.id).then(value => ({ actor: { ...admission.actor, generation: value.record?.generation ?? 0 },
      policy: value.record?.policy, fence: value.fence }))
    : await readPortableAppActionsAuthority(admission.actor.userId, admission.actor.id).then(value => ({ actor: { ...admission.actor, generation: value.generation },
      policy: value.grant?.policy, fence: value.fence }))
  if (!current.policy || !sameSettingsAuthority(admission, current as SettingsManagementAdmission)) throw new AppActionsManagementRefusal('AUTHORITY_CHANGED', 'The captured user authority changed; this operation cannot proceed.', 409)
}
