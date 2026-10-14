import { SETTINGS_TABS, type SettingsTab } from '../catalog'
import { MEMORY_MAX_LINGER_TURNS } from '$lib/utils/memoryControl'

export type MemoryPreferenceValues = {
  onMyMind: number
  triggers: number
  recalled: number
  triggerLingerTurns: number
  recallLingerTurns: number
}
export type MemoryPreferenceChanges = Partial<MemoryPreferenceValues>
export type IdentityPreferenceValues = { displayName: string }
export type IdentityPreferenceChanges = IdentityPreferenceValues
export type SettingsFamily = 'memory' | 'identity'
export type SettingsCaller = { kind: 'agent' | 'developer'; userId: string; actingAgentId?: string }
export type SettingsOwnerContext = {
  // Supplied by the authenticated server executor, NEVER parsed from action args.
  actor: SettingsCaller
  signal?: AbortSignal
  deadlineAt?: number
  check(): void
}
export class SettingsActionRefusal extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'SettingsActionRefusal' }
}
export function refuseSettings(reason: string): never { throw new SettingsActionRefusal(reason) }
export function strictObject(value: unknown, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuseSettings('invalid_arguments')
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(record, key))) refuseSettings('invalid_arguments')
  return record
}
export function settingsSubject(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) refuseSettings('invalid_subject')
  return value
}
export function validateOwnRead(value: unknown): { subjectAgentId: string } {
  const record = strictObject(value, ['subjectAgentId'], ['subjectAgentId'])
  return { subjectAgentId: settingsSubject(record.subjectAgentId) }
}
export function validateInspection(value: unknown): { tab: SettingsTab; subjectAgentId?: string } {
  const record = strictObject(value, ['tab', 'subjectAgentId'], ['tab'])
  if (!(SETTINGS_TABS as readonly unknown[]).includes(record.tab)) refuseSettings('invalid_settings_tab')
  const tab = record.tab as SettingsTab
  if (record.subjectAgentId !== undefined && tab !== 'agents' && tab !== 'memory') refuseSettings('invalid_subject_for_tab')
  return { tab, ...(record.subjectAgentId !== undefined ? { subjectAgentId: settingsSubject(record.subjectAgentId) } : {}) }
}
export function validateMemoryChanges(value: unknown): MemoryPreferenceChanges {
  const record = strictObject(value, ['onMyMind', 'triggers', 'recalled', 'triggerLingerTurns', 'recallLingerTurns'])
  if (!Object.keys(record).length) refuseSettings('empty_changes')
  const changes: MemoryPreferenceChanges = {}
  for (const key of ['onMyMind', 'triggers', 'recalled', 'triggerLingerTurns', 'recallLingerTurns'] as const) {
    if (!Object.hasOwn(record, key)) continue
    const number = record[key]
    const max = key === 'triggerLingerTurns' || key === 'recallLingerTurns' ? MEMORY_MAX_LINGER_TURNS : 20_000
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 0 || number > max) refuseSettings(`invalid_${key}`)
    changes[key] = number
  }
  return changes
}
export function validateIdentityChanges(value: unknown): IdentityPreferenceChanges {
  const record = strictObject(value, ['displayName'], ['displayName'])
  if (typeof record.displayName !== 'string') refuseSettings('invalid_displayName')
  const displayName = record.displayName.trim()
  // Existing form requires a nonempty trimmed name; the owner planner rejects
  // lone surrogates. The 200-character catalog bound keeps receipts bounded.
  if (!displayName || displayName.length > 200 || !displayName.isWellFormed()) refuseSettings('invalid_displayName')
  return { displayName }
}
export function validateOwnUpdate(value: unknown, family: 'memory'): { subjectAgentId: string; expectedRevision: string; changes: MemoryPreferenceChanges }
export function validateOwnUpdate(value: unknown, family: 'identity'): { subjectAgentId: string; expectedRevision: string; changes: IdentityPreferenceChanges }
export function validateOwnUpdate(value: unknown, family: SettingsFamily) {
  const record = strictObject(value, ['subjectAgentId', 'expectedRevision', 'changes'], ['subjectAgentId', 'expectedRevision', 'changes'])
  if (typeof record.expectedRevision !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(record.expectedRevision)) refuseSettings('invalid_revision')
  return { subjectAgentId: settingsSubject(record.subjectAgentId), expectedRevision: record.expectedRevision,
    changes: family === 'memory' ? validateMemoryChanges(record.changes) : validateIdentityChanges(record.changes) }
}
export function requireOwnActor(context: SettingsOwnerContext, subjectAgentId: string): void {
  context.check()
  if (context.signal?.aborted || context.deadlineAt !== undefined && (!Number.isFinite(context.deadlineAt) || context.deadlineAt <= Date.now())) refuseSettings('operation_no_longer_admitted')
  if (context.actor.kind !== 'agent' || typeof context.actor.userId !== 'string' || !context.actor.userId || context.actor.actingAgentId !== subjectAgentId) refuseSettings('own_agent_required')
}
