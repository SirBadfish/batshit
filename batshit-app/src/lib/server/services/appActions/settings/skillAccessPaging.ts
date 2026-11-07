import { createHash } from 'node:crypto'
import { SETTINGS_REPORT_BYTE_LIMITS, SETTINGS_REPORT_ROW_LIMIT, type SettingsReportDetail } from '$lib/appActions/settings/reportContract'
import { AppActionsManagementRefusal } from './authority'
import type { SettingsSubjectManifest } from './subjects'
import type { SkillAccessRead } from './skillAccessReport'

/** Public pages are bounded projections; the private read handle retains the complete manifest. */
export function createSkillAccessPages(read: SkillAccessRead, manifest: SettingsSubjectManifest, detail: SettingsReportDetail) {
  const observedAt = new Date().toISOString()
  const choices = read.choices.map(choice => ({ skillId: choice.skillId, label: choice.label, aliasCount: choice.aliases.length, available: choice.available, ...(choice.reason ? { reason: choice.reason } : {}) }))
  const values = detail === 'values' ? read.rows.flatMap(row => row.aliases.length ? row.aliases.map((alias, index) => ({
    ...row, aliases: [alias], aliasPage: { index, returned: 1, total: row.aliases.length }
  })) : [{ ...row, aliasPage: { index: 0, returned: 0, total: 0 } }]) : []
  const projected = detail === 'choices' || !read.rows.length ? choices : detail === 'values' ? values : choices.map(choice => ({
    skillId: choice.skillId, label: choice.label,
    subjects: { enabled: read.rows.filter(row => row.skillId === choice.skillId && row.effective === true).length,
      disabled: read.rows.filter(row => row.skillId === choice.skillId && row.effective === false).length,
      unavailable: read.rows.filter(row => row.skillId === choice.skillId && row.effective === null).length }
  }))
  function freeze<T>(value: T): T {
    if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
    return value
  }
  const rows: readonly unknown[] = freeze(structuredClone(projected))
  const snapshotId = createHash('sha256').update(JSON.stringify([manifest.digest, observedAt, detail, rows])).digest('hex')
  function page(cursor?: string) {
    let offset = 0
    if (cursor !== undefined) {
      if (!/^sr1:[a-f0-9]{64}:[0-9]{1,5}$/.test(cursor)) throw new AppActionsManagementRefusal('INVALID_REPORT_PAGE', 'Invalid report page.', 400)
      const [, hash, raw] = cursor.split(':')
      offset = Number(raw)
      if (hash !== snapshotId || offset > rows.length) throw new AppActionsManagementRefusal('INVALID_REPORT_PAGE', 'The page does not belong to this held report.', 409)
    }
    const selected: unknown[] = []
    function build() {
      const end = offset + selected.length
      return { schemaVersion: 1 as const, basis: 'internal-read-snapshot' as const, domain: 'skill-access' as const, snapshotId, observedAt,
        manifest: { digest: manifest.digest, targets: manifest.entries.length, excluded: manifest.excluded.length,
          unavailable: manifest.entries.filter(entry => entry.status !== 'available').length },
        detail, change: 'admitted' as const, rows: [...selected],
        continuation: { totalRows: rows.length, returned: selected.length, remaining: rows.length - end,
          nextCursor: end < rows.length ? `sr1:${snapshotId}:${end}` : null } }
    }
    const limit = SETTINGS_REPORT_BYTE_LIMITS[detail] - 1024
    for (let index = offset; index < rows.length && selected.length < SETTINGS_REPORT_ROW_LIMIT; index++) {
      selected.push(rows[index])
      if (Buffer.byteLength(JSON.stringify(build()), 'utf8') > limit) { selected.pop(); break }
    }
    const result = build()
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > limit || !selected.length && offset < rows.length) {
      throw new AppActionsManagementRefusal('REPORT_BUDGET', 'A skill access row exceeds the bounded page budget. Choose fewer skill IDs.', 409)
    }
    return result
  }
  return Object.freeze({ page })
}
