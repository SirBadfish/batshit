import { isCanonicalAgentId } from '$lib/utils/agentId'
/** Internal P1 contracts. No route or grant is registered by importing this module. */
export const SETTINGS_SUBJECT_LIMIT = 256
export const SETTINGS_REPORT_ROW_LIMIT = 64
export const SETTINGS_REPORT_BYTE_LIMITS = Object.freeze({ summary: 8192, values: 24576, choices: 12288 })
import { SETTINGS_REPORT_IDS, type SettingsReportId } from './definitions'
export { SETTINGS_REPORT_IDS, type SettingsReportId } from './definitions'
export type SettingsReportDetail = keyof typeof SETTINGS_REPORT_BYTE_LIMITS
import type { SettingsSubjectRef } from './subjectTypes'
export type { SettingsSubjectRef, StoredSettingsSubjectKind } from './subjectTypes'
export type SettingsSubjectSelector =
  | Readonly<{ subjects: readonly SettingsSubjectRef[] }>
  | Readonly<{ allAgents: true; except: readonly SettingsSubjectRef[] }>
export type SettingsReportRequest = Readonly<{
  focus: readonly SettingsReportId[]
  detail: SettingsReportDetail
  cursor?: string
}>
export type SettingsScalarValue = string | number | boolean
export type SettingsReportValue = Readonly<{
  stored: Readonly<{ state: 'set'; value: SettingsScalarValue | null } | { state: 'unset' } | { state: 'invalid' }>
  effective: Readonly<{ state: 'known'; value: SettingsScalarValue } | { state: 'unknown'; reason: string }>
  source: 'agent' | 'global' | 'factory' | 'none'
}>
export class SettingsReportRefusal extends Error {
  constructor(readonly reason: string, readonly count?: number) {
    super(reason)
    this.name = 'SettingsReportRefusal'
  }
}
export function reportObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !keys.includes(key))) throw new SettingsReportRefusal('invalid_report_arguments')
  return value as Record<string, unknown>
}
export function settingsSubjectKey(subject: SettingsSubjectRef): string { return `${subject.kind}:${subject.id}` }
function parseSubject(value: unknown): SettingsSubjectRef {
  const record = reportObject(value, ['kind', 'id'])
  if (typeof record.kind !== 'string' || !['primary', 'subagent', 'group', 'worker'].includes(record.kind) ||
    !isCanonicalAgentId(record.id)) {
    throw new SettingsReportRefusal('invalid_report_subject')
  }
  return Object.freeze({ kind: record.kind as SettingsSubjectRef['kind'], id: record.id })
}
/** A diagnostic only. Never accepted by public selectors/policy or mutation targets. */
export function isUnsupportedSettingsSubjectRef(value: unknown): value is SettingsSubjectRef {
  try {
    const record = reportObject(value, ['kind', 'id'])
    return (record.kind === 'primary' || record.kind === 'subagent') && typeof record.id === 'string' &&
      record.id.isWellFormed() && !isCanonicalAgentId(record.id)
  } catch { return false }
}
function parseSubjects(value: unknown, allowEmpty: boolean): readonly SettingsSubjectRef[] {
  if (!Array.isArray(value) || !allowEmpty && !value.length) throw new SettingsReportRefusal('invalid_report_subjects')
  if (value.length > SETTINGS_SUBJECT_LIMIT) throw new SettingsReportRefusal('subject_limit_exceeded', value.length)
  const found = new Map<string, SettingsSubjectRef>()
  for (const item of value) {
    const subject = parseSubject(item)
    found.set(settingsSubjectKey(subject), subject)
  }
  return Object.freeze([...found.values()].sort((a, b) => settingsSubjectKey(a) < settingsSubjectKey(b) ? -1 : settingsSubjectKey(a) > settingsSubjectKey(b) ? 1 : 0))
}
export function parseSettingsSubjectSelector(value: unknown): SettingsSubjectSelector {
  const record = reportObject(value, ['subjects', 'allAgents', 'except'])
  if (Object.hasOwn(record, 'subjects') && !Object.hasOwn(record, 'allAgents') && !Object.hasOwn(record, 'except')) {
    return Object.freeze({ subjects: parseSubjects(record.subjects, false) })
  }
  if (!Object.hasOwn(record, 'subjects') && record.allAgents === true) {
    return Object.freeze({ allAgents: true as const, except: parseSubjects(record.except ?? [], true) })
  }
  throw new SettingsReportRefusal('invalid_report_selector')
}
export function parseSettingsReportRequest(value: unknown): SettingsReportRequest {
  const record = reportObject(value, ['focus', 'detail', 'cursor'])
  const detail = record.detail ?? 'summary'
  if (detail !== 'summary' && detail !== 'values' && detail !== 'choices') throw new SettingsReportRefusal('invalid_report_detail')
  const focus = record.focus ?? SETTINGS_REPORT_IDS
  if (!Array.isArray(focus) || !focus.length || focus.length > SETTINGS_REPORT_IDS.length ||
    focus.some(id => !(SETTINGS_REPORT_IDS as readonly unknown[]).includes(id))) throw new SettingsReportRefusal('unadopted_report_setting')
  if (record.cursor !== undefined && (typeof record.cursor !== 'string' || !/^(?:sr1:[a-f0-9]{64}:[0-9]{1,5}|si1:[a-f0-9]{64}:[0-9]{1,6})$/.test(record.cursor))) {
    throw new SettingsReportRefusal('invalid_report_cursor')
  }
  return Object.freeze({ focus: Object.freeze([...new Set(focus as SettingsReportId[])].sort()), detail,
    ...(record.cursor !== undefined ? { cursor: record.cursor as string } : {}) })
}
