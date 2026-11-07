import { isCanonicalAgentId } from '$lib/utils/agentId'
import { createHash } from 'node:crypto'
import {
  parseSettingsSubjectSelector, settingsSubjectKey, SettingsReportRefusal, SETTINGS_SUBJECT_LIMIT,
  type SettingsSubjectRef, type SettingsSubjectSelector, type StoredSettingsSubjectKind
} from '$lib/appActions/settings/reportContract'

export type SettingsSubjectEntry = Readonly<{
  subject: SettingsSubjectRef
  status: 'available' | 'unavailable'
  type?: 'api'
  label?: string
  reason?: 'not_an_agent_subject' | 'read_not_allowed' | 'subject_missing' | 'subject_unavailable' | 'subject_not_owned' | 'unsupported_subject_type' | 'unsupported_subject_id'
}>
export type SettingsSubjectManifest = Readonly<{
  ownerUserId: string
  digest: string
  entries: readonly SettingsSubjectEntry[]
  excluded: readonly SettingsSubjectRef[]
}>
export type SettingsReportReadContext = {
  userId: string
  /** Server-supplied admission, never parsed from report input. P2 supplies the real policy. */
  canRead(subject: SettingsSubjectRef): boolean
  check(): void
}
export type SettingsSubjectSources = {
  listIds(userId: string, kind: StoredSettingsSubjectKind): Promise<readonly string[]>
  read(userId: string, subject: SettingsSubjectRef): Promise<unknown>
}
export function settingsSubjectType(subject: SettingsSubjectRef, record: Record<string, unknown>): SettingsSubjectEntry['type'] | undefined {
  if (subject.kind !== 'primary' && subject.kind !== 'subagent') return undefined
  const type = subject.kind === 'primary' ? record.agentType : record.subagentType
  // Do not turn malformed/unknown/retired records into new capabilities through a normalizer's fallback.
  // SA-139 R4/R5: a Primary or Subagent is a subject only on the API lane; a leftover `cli` record of
  // either kind is retired, so it reads as `unsupported_subject_type`.
  return type === 'api' ? type : undefined
}
export function ownedSettingsRecord(subject: SettingsSubjectRef, value: unknown, userId: string): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    (value as Record<string, unknown>).id === subject.id && (value as Record<string, unknown>).user_id === userId
}
export function settingsSubjectLabel(subject: SettingsSubjectRef, displayName?: unknown): string {
  if (typeof displayName === 'string' && displayName.length <= 200 && displayName.isWellFormed()) return displayName
  if (subject.id && subject.id.length <= 200 && subject.id.isWellFormed()) return subject.id
  return subject.kind === 'primary' ? 'Primary Agent' : subject.kind === 'subagent' ? 'Subagent' : 'Unavailable subject'
}
export function requireSettingsReportContext(context: SettingsReportReadContext): void {
  if (typeof context.userId !== 'string' || !context.userId || typeof context.canRead !== 'function' || typeof context.check !== 'function') {
    throw new SettingsReportRefusal('report_admission_required')
  }
  context.check()
}
export function createSettingsSubjectResolver(sources: SettingsSubjectSources, captured?: SettingsSubjectManifest) {
  return async (input: unknown, context: SettingsReportReadContext): Promise<SettingsSubjectManifest> => {
    requireSettingsReportContext(context)
    if (captured && (captured.ownerUserId !== context.userId || captured.entries.length > SETTINGS_SUBJECT_LIMIT || captured.excluded.length > SETTINGS_SUBJECT_LIMIT)) throw new SettingsReportRefusal('invalid_report_manifest')
    const selector: SettingsSubjectSelector = captured ? { subjects: captured.entries.map(entry => entry.subject) } : parseSettingsSubjectSelector(input)
    let requested: readonly SettingsSubjectRef[]
    const excluded = captured?.excluded ?? ('except' in selector ? selector.except : [])
    if ('subjects' in selector) requested = selector.subjects
    else {
      const lists = await Promise.all((['primary', 'subagent'] as const).map(async kind => {
        const ids = await sources.listIds(context.userId, kind)
        if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id.isWellFormed())) {
          throw new SettingsReportRefusal('subject_index_unavailable')
        }
        return ids.map(id => ({ kind, id }))
      }))
      context.check()
      const unique = new Map(lists.flat().map(subject => [settingsSubjectKey(subject), Object.freeze(subject)]))
      const excludedKeys = new Set(excluded.map(settingsSubjectKey))
      const selected = [...unique.values()].filter(subject => !excludedKeys.has(settingsSubjectKey(subject)))
      requested = selected
      if (requested.length > SETTINGS_SUBJECT_LIMIT) throw new SettingsReportRefusal('subject_limit_exceeded', requested.length)
      selected.sort((a, b) => settingsSubjectKey(a) < settingsSubjectKey(b) ? -1 : settingsSubjectKey(a) > settingsSubjectKey(b) ? 1 : 0)
    }
    const entries: SettingsSubjectEntry[] = []
    for (const subject of requested) {
      context.check()
      const preserved = captured?.entries.find(entry => settingsSubjectKey(entry.subject) === settingsSubjectKey(subject) && entry.status === 'unavailable')
      if (preserved) { entries.push(preserved); continue }
      let entry: SettingsSubjectEntry
      if (!isCanonicalAgentId(subject.id)) entry = { subject, status: 'unavailable', reason: 'unsupported_subject_id' }
      else if (subject.kind === 'group' || subject.kind === 'worker') entry = { subject, status: 'unavailable', reason: 'not_an_agent_subject' }
      else if (!context.canRead(subject)) entry = { subject, status: 'unavailable', reason: 'read_not_allowed' }
      else {
        let value: unknown
        try { value = await sources.read(context.userId, subject) }
        catch { context.check(); entries.push(Object.freeze({ subject, status: 'unavailable', reason: 'subject_unavailable' })); continue }
        context.check()
        if (!context.canRead(subject)) entry = { subject, status: 'unavailable', reason: 'read_not_allowed' }
        else if (value === null) entry = { subject, status: 'unavailable', reason: 'subject_missing' }
        else if (!ownedSettingsRecord(subject, value, context.userId)) entry = { subject, status: 'unavailable', reason: 'subject_not_owned' }
        else {
          const type = settingsSubjectType(subject, value)
          const label = settingsSubjectLabel(subject, value.displayName)
          entry = type ? { subject, status: 'available', type, ...(label !== undefined ? { label } : {}) }
            : { subject, status: 'unavailable', reason: 'unsupported_subject_type' }
        }
      }
      entries.push(Object.freeze(entry))
    }
    const digest = createHash('sha256').update(JSON.stringify({ entries, excluded })).digest('hex')
    return Object.freeze({ ownerUserId: context.userId, digest, entries: Object.freeze(entries), excluded: Object.freeze([...excluded]) })
  }
}
