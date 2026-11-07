import { createHash } from 'node:crypto'
import { ADOPTED_SETTINGS_DEFINITIONS, assertSettingsDefinitionCoverage } from '$lib/appActions/settings/definitions'
import {
  parseSettingsReportRequest, SETTINGS_REPORT_BYTE_LIMITS, SETTINGS_REPORT_ROW_LIMIT, SETTINGS_SUBJECT_LIMIT,
  SettingsReportRefusal, type SettingsReportId
} from '$lib/appActions/settings/reportContract'
import {
  ownedSettingsRecord, requireSettingsReportContext, settingsSubjectType,
  type SettingsReportReadContext, type SettingsSubjectEntry, type SettingsSubjectManifest, type SettingsSubjectSources
} from './subjects'

import type { Fields, Group } from './scalarProjection'
import { SUBJECT_SETTINGS_BINDINGS } from '../managementAdapters'
type Row = Readonly<{ subject: SettingsSubjectEntry['subject']; status: 'available'; type: NonNullable<SettingsSubjectEntry['type']>; groups: readonly Group[] } |
  { subject: SettingsSubjectEntry['subject']; status: 'unavailable' | 'excluded'; reason: string }>
type Common = Readonly<{ id: SettingsReportId; matchingSubjects: number; fields: Fields; readiness?: Readonly<{ status: string; reason: string }> }>
type PageRow = Exclude<Row, { status: 'available' }> | Readonly<{
  subject: SettingsSubjectEntry['subject']; status: 'available'; type: NonNullable<SettingsSubjectEntry['type']>
  groups: readonly (Group | { id: SettingsReportId; common: true })[]
}>
export type SettingsReportPage = Readonly<{
  schemaVersion: 1
  basis: 'internal-read-snapshot'
  snapshotId: string
  observedAt: string
  manifest: Readonly<{ digest: string; targets: number; excluded: number; unavailable: number }>
  detail: 'summary' | 'values' | 'choices'
  change: 'not-integrated' | 'admitted'
  common: readonly Common[]
  choices?: readonly unknown[]
  rows: readonly PageRow[]
  continuation: Readonly<{ totalRows: number; returned: number; remaining: number; nextCursor: string | null }>
}>
function project(id: SettingsReportId, entry: SettingsSubjectEntry, record: Record<string, unknown>): Group {
  return SUBJECT_SETTINGS_BINDINGS[id].project(entry, record)
}
const signature = (fields: Fields) => JSON.stringify(fields)
function commonGroups(rows: readonly Row[], ids: readonly SettingsReportId[]): readonly Common[] {
  return Object.freeze(ids.flatMap(id => {
    // Equal descriptors/counts do not establish equal literal instruction text.
    if (id === 'agent.instructions') return []
    const counts = new Map<string, { fields: Fields; count: number; readiness?: Readonly<{ status: string; reason: string }> }>()
    for (const row of rows) {
      if (row.status !== 'available') continue
      const group = row.groups.find(group => group.id === id)
      if (!group || group.status !== 'available') continue
      const key = JSON.stringify([group.fields, group.readiness])
      const count = counts.get(key)
      if (count) count.count++
      else counts.set(key, { fields: group.fields, count: 1, ...(group.readiness ? { readiness: group.readiness } : {}) })
    }
    const best = [...counts.values()].sort((a, b) => b.count - a.count)[0]
    return best && best.count > 1 ? [Object.freeze({ id, matchingSubjects: best.count, fields: best.fields, ...(best.readiness ? { readiness: best.readiness } : {}) })] : []
  }))
}
export function settingsReportSerializedBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8') }

/** Internal-only foundation. The manifest is an inventory, NEVER a grant or write precondition.
 * P2 must supply genuine server admission; this module registers no control and writes nothing.
 * A retained snapshot makes pagination stable; later record edits require a new snapshot.
 */
export async function createSettingsReportSnapshot(
  manifest: SettingsSubjectManifest, input: unknown, context: SettingsReportReadContext,
  sources: Pick<SettingsSubjectSources, 'read'> & { changeAvailability?: 'admitted'; reservedBytes?: number; modelChoices?: unknown; voiceChoices?: unknown }
): Promise<{ page(cursor?: string): SettingsReportPage }> {
  requireSettingsReportContext(context)
  if (manifest.ownerUserId !== context.userId || manifest.entries.length > SETTINGS_SUBJECT_LIMIT || manifest.excluded.length > SETTINGS_SUBJECT_LIMIT) {
    throw new SettingsReportRefusal('invalid_report_manifest')
  }
  const request = parseSettingsReportRequest(input)
  if (request.cursor !== undefined) throw new SettingsReportRefusal('create_new_snapshot_without_cursor')
  assertSettingsDefinitionCoverage()
  if (sources.reservedBytes !== undefined && (!Number.isSafeInteger(sources.reservedBytes) || sources.reservedBytes < 0 || sources.reservedBytes > 2048)) throw new SettingsReportRefusal('invalid_report_budget')
  const definitions = ADOPTED_SETTINGS_DEFINITIONS.filter(definition => request.focus.includes(definition.id))
  const rows: Row[] = []
  for (const entry of manifest.entries) {
    context.check()
    if (!context.canRead(entry.subject) && entry.status === 'available') throw new SettingsReportRefusal('report_admission_changed')
    if (entry.status !== 'available') {
      rows.push(Object.freeze({ subject: entry.subject, status: 'unavailable', reason: entry.reason ?? 'subject_unavailable' }))
      continue
    }
    let record: unknown
    try { record = await sources.read(context.userId, entry.subject) }
    catch {
      context.check()
      if (!context.canRead(entry.subject)) throw new SettingsReportRefusal('report_admission_changed')
      rows.push(Object.freeze({ subject: entry.subject, status: 'unavailable', reason: 'subject_unavailable' }))
      continue
    }
    context.check()
    if (!context.canRead(entry.subject)) throw new SettingsReportRefusal('report_admission_changed')
    if (!ownedSettingsRecord(entry.subject, record, context.userId) || settingsSubjectType(entry.subject, record) !== entry.type) {
      rows.push(Object.freeze({ subject: entry.subject, status: 'unavailable', reason: 'subject_changed_since_resolution' }))
      continue
    }
    rows.push(Object.freeze({ subject: entry.subject, status: 'available', type: entry.type!,
      groups: Object.freeze(definitions.map(definition => project(definition.id, entry, record))) }))
  }
  for (const subject of manifest.excluded) rows.push(Object.freeze({ subject, status: 'excluded', reason: 'explicit_exclusion' }))
  const common = request.detail === 'choices' ? Object.freeze([]) : commonGroups(rows, request.focus)
  const observedAt = new Date().toISOString()
  const snapshotId = createHash('sha256').update(JSON.stringify({ manifest: manifest.digest, request, rows, observedAt })).digest('hex')
  const pageRows: readonly PageRow[] = Object.freeze(rows.map(row => row.status !== 'available' ? row : Object.freeze({
    ...row, groups: Object.freeze(row.groups.map(group => {
      if (group.status !== 'available') return group
      if (request.detail === 'choices') return Object.freeze({ id: group.id, status: 'available' as const, fields: Object.freeze({}) })
      return common.some(item => item.id === group.id && signature(item.fields) === signature(group.fields) && JSON.stringify(item.readiness) === JSON.stringify(group.readiness))
        ? Object.freeze({ id: group.id, common: true as const }) : group
    }))
  })))
  function page(cursor?: string): SettingsReportPage {
    requireSettingsReportContext(context)
    if (manifest.entries.some(entry => entry.status === 'available' && !context.canRead(entry.subject))) throw new SettingsReportRefusal('report_admission_changed')
    let offset = 0
    if (cursor !== undefined) {
      parseSettingsReportRequest({ ...request, cursor })
      const [, hash, position] = cursor.split(':')
      if (hash !== snapshotId) throw new SettingsReportRefusal('cursor_snapshot_mismatch')
      offset = Number(position)
      if (offset > pageRows.length) throw new SettingsReportRefusal('invalid_report_cursor')
    }
    const selected: PageRow[] = []
    function build(): SettingsReportPage {
      const end = offset + selected.length
      return Object.freeze({ schemaVersion: 1, basis: 'internal-read-snapshot', snapshotId, observedAt,
        manifest: Object.freeze({ digest: manifest.digest, targets: manifest.entries.length, excluded: manifest.excluded.length,
          unavailable: rows.filter(row => row.status === 'unavailable').length }),
        detail: request.detail, change: sources.changeAvailability ?? 'not-integrated', common,
        ...(request.detail === 'choices' ? { choices: Object.freeze(definitions.map(definition => Object.freeze({
          id: definition.id, label: definition.label, category: definition.category, subjectKinds: definition.subjectKinds,
          fields: definition.fields, change: sources.changeAvailability ?? 'not-integrated',
          ...((definition.id === 'agent.model.selection' || definition.id === 'agent.model.preset-copy') && sources.modelChoices ? { presets: sources.modelChoices } : {}),
          ...(definition.id === 'agent.voice.tts-selection' && sources.voiceChoices ? { voices: sources.voiceChoices } : {})
        }))) } : {}), rows: Object.freeze([...selected]),
        continuation: Object.freeze({ totalRows: pageRows.length, returned: selected.length, remaining: pageRows.length - end,
          nextCursor: end < pageRows.length ? `sr1:${snapshotId}:${end}` : null }) })
    }
    const byteLimit = SETTINGS_REPORT_BYTE_LIMITS[request.detail] - (sources.reservedBytes ?? 0)
    for (let index = offset; index < pageRows.length && selected.length < SETTINGS_REPORT_ROW_LIMIT; index++) {
      selected.push(pageRows[index])
      if (settingsReportSerializedBytes(build()) > byteLimit) { selected.pop(); break }
    }
    const result = build()
    if (settingsReportSerializedBytes(result) > byteLimit || !selected.length && offset < pageRows.length) throw new SettingsReportRefusal('report_row_exceeds_budget')
    return result
  }
  return Object.freeze({ page })
}
