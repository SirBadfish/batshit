/**
 * BL-378 Phase 1b [C2]: the partial backup's end-state summary is one bounded header, read by ONE
 * strict parser for the browser download and the packaged Mac result alike. Anything that is not
 * exactly the shape is "unavailable": never an invented zero, never "no upload files remain
 * missing". Pure functions; nothing else runs.
 */
import { describe, expect, it } from 'vitest'

import { UPLOAD_PROBLEM_LIST_LIMIT } from '$lib/server/services/backupUploadInspection'
import {
  BACKUP_MISSING_UPLOADS_HEADER,
  BACKUP_PARTIAL_ENTRY_LIMIT,
  describeBackupExportSummary,
  encodeMissingUploadsSummary,
  parseMissingUploadsSummary,
  type BackupMissingUploadsSummary
} from './backupPartialSummary'

const PARTIAL: BackupMissingUploadsSummary = {
  completeness: 'partial',
  missingFiles: 2,
  missingRecords: 3,
  foundAgainFiles: 0,
  goneRecords: 0,
  otherRecords: 0
}

/** The exact header text with one field replaced by raw JSON text (or removed with undefined). */
function withField(field: string, json: string | undefined) {
  const parsed = JSON.parse(encodeMissingUploadsSummary(PARTIAL)) as Record<string, unknown>
  if (json === undefined) {
    delete parsed[field]
    return JSON.stringify(parsed)
  }
  parsed[field] = '__marker__'
  return JSON.stringify(parsed).replace('"__marker__"', json)
}

const UNAVAILABLE = 'Backup exported, but Batshit could not read its missing-upload summary'

describe('the missing-upload summary header (BL-378 Phase 1b [C2])', () => {
  it('is compact JSON with exactly its six keys, in one order, under its own header name', () => {
    expect(BACKUP_MISSING_UPLOADS_HEADER).toBe('X-Batshit-Backup-Missing-Uploads')
    expect(encodeMissingUploadsSummary(PARTIAL)).toBe(
      '{"completeness":"partial","missingFiles":2,"missingRecords":3,"foundAgainFiles":0,"goneRecords":0,"otherRecords":0}'
    )
    expect(parseMissingUploadsSummary(encodeMissingUploadsSummary(PARTIAL))).toEqual(PARTIAL)
    const complete = { ...PARTIAL, completeness: 'complete' as const, missingFiles: 0, missingRecords: 0, goneRecords: 4 }
    expect(parseMissingUploadsSummary(encodeMissingUploadsSummary(complete))).toEqual(complete)
  })

  it('counts are bounded by the acknowledged-entry limit, which is the upload check list limit', () => {
    expect(BACKUP_PARTIAL_ENTRY_LIMIT).toBe(UPLOAD_PROBLEM_LIST_LIMIT)
    expect(parseMissingUploadsSummary(withField('missingRecords', String(BACKUP_PARTIAL_ENTRY_LIMIT)))).toMatchObject({
      missingRecords: BACKUP_PARTIAL_ENTRY_LIMIT
    })
  })

  it('turns every malformed form into unavailable (null), never a default', () => {
    const cases: Array<[label: string, value: unknown]> = [
      ['no header', null],
      ['undefined', undefined],
      ['empty', ''],
      ['a number, not text', 3],
      ['invalid JSON', '{"completeness":"partial",'],
      ['JSON null', 'null'],
      ['a JSON array', '[]'],
      ['a JSON string', '"partial"'],
      ['an extra key', withField('extra', '1')],
      ['a missing key', withField('otherRecords', undefined)],
      ['completeness of the wrong type', withField('completeness', '1')],
      ['an unknown completeness', withField('completeness', '"full"')],
      ['a count as text', withField('missingFiles', '"2"')],
      ['a count as a boolean', withField('goneRecords', 'true')],
      ['a count as null', withField('goneRecords', 'null')],
      ['a fraction', withField('missingRecords', '3.5')],
      ['a negative', withField('otherRecords', '-1')],
      ['Infinity (1e400)', withField('missingRecords', '1e400')],
      ['a count above the bound', withField('missingRecords', String(BACKUP_PARTIAL_ENTRY_LIMIT + 1))],
      ['more files than records', withField('missingFiles', '4')],
      ['partial with nothing missing', withField('missingFiles', '0')],
      [
        'complete with something missing',
        encodeMissingUploadsSummary({ ...PARTIAL, completeness: 'complete' })
      ],
      [
        'complete that accounts for nothing',
        encodeMissingUploadsSummary({ ...PARTIAL, completeness: 'complete', missingFiles: 0, missingRecords: 0 })
      ],
      ['far too long', `${encodeMissingUploadsSummary(PARTIAL)}${' '.repeat(600)}`]
    ]
    // The extra-key case really carries seven keys.
    expect(Object.keys(JSON.parse(cases[8][1] as string))).toHaveLength(7)
    expect(Object.keys(JSON.parse(cases[9][1] as string))).toHaveLength(5)
    const answers = cases.map(([label, value]) => `${label} -> ${JSON.stringify(parseMissingUploadsSummary(value))}`)
    expect(answers).toEqual(cases.map(([label]) => `${label} -> null`))
  })
})

describe('the export sentence from the summary (BL-378 Phase 1b [B3] [C2] [C4])', () => {
  it('an unavailable summary says the backup was exported and invents nothing', () => {
    const sentence = describeBackupExportSummary(null)
    expect(sentence).toBe(
      `${UNAVAILABLE}, so it cannot say which upload files are in it. Run Check Upload Files to see which are missing now.`
    )
    expect(sentence).not.toMatch(/\d/)
    expect(sentence).not.toMatch(/remain missing|complete/i)
  })

  it('a partial backup names files first and records when they differ, then what changed since the check', () => {
    expect(describeBackupExportSummary(PARTIAL)).toBe(
      'Partial backup exported: 2 upload files (3 upload records) Batshit did not find are not in it.'
    )
    expect(describeBackupExportSummary({ ...PARTIAL, missingFiles: 1, missingRecords: 1 })).toBe(
      'Partial backup exported: 1 upload file Batshit did not find is not in it.'
    )
    expect(describeBackupExportSummary({ ...PARTIAL, foundAgainFiles: 1, goneRecords: 2 })).toBe(
      'Partial backup exported: 2 upload files (3 upload records) Batshit did not find are not in it. ' +
        'Since the check: 1 file found again, 2 records no longer exist.'
    )
  })

  it('all found again, all gone, and a mix each say only that no upload files remain missing', () => {
    const complete = { ...PARTIAL, completeness: 'complete' as const, missingFiles: 0, missingRecords: 0 }
    const allFound = describeBackupExportSummary({ ...complete, foundAgainFiles: 2 })
    expect(allFound).toBe(
      'Backup exported. The 2 upload files marked as missing were found again, so no upload files remain missing.'
    )
    const allGone = describeBackupExportSummary({ ...complete, goneRecords: 1 })
    expect(allGone).toBe(
      'Backup exported. The 1 upload record marked as missing no longer exists, so no upload files remain missing.'
    )
    // [B3]: when every entry is gone, never "found again".
    expect(allGone).not.toMatch(/found again/)
    const mix = describeBackupExportSummary({ ...complete, foundAgainFiles: 1, otherRecords: 3 })
    expect(mix).toBe('Backup exported. No upload files remain missing: 1 file found again, 3 records changed.')
    // [C4]: never a claim that the backup is a complete snapshot.
    for (const sentence of [allFound, allGone, mix]) expect(sentence).not.toMatch(/complete/i)
  })
})
