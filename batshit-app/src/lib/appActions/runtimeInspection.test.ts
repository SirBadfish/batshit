import { describe, expect, it } from 'vitest'
import {
  isRuntimeInspectionReport, normalizeRuntimeInspectionVersion, runtimePinComparison,
  RUNTIME_INSPECTION_SOURCE_IDS, type RuntimeInspectionReport
} from './runtimeInspection'

function unknownReport(): RuntimeInspectionReport {
  return { version: 1, domain: 'runtime-inspection', scope: 'this-instance', reportedAt: '2026-10-17T12:00:00.000Z',
    runtime: { mode: 'native', distribution: 'source-checkout', platform: 'darwin', architecture: 'arm64' },
    rows: RUNTIME_INSPECTION_SOURCE_IDS.map(id => ({ id, status: 'unknown', reason: 'source_pending', observedFrom: null, observedAt: null, data: null })) }
}

describe('masked runtime inspection wire contract', () => {
  it.each(['cloudflared version 2026.3.0', '1.2.3\nsecret', '1.2.3+secret', '01.2.3', '1.2', '/private/1.2.3', ' 1.2.3 ', '9999999.1.2', null, {}])(
    'does not display arbitrary version text: %j', value => expect(normalizeRuntimeInspectionVersion(value)).toBeNull()
  )
  it('compares only complete normalized release evidence', () => {
    expect(normalizeRuntimeInspectionVersion('2026.3.0')).toBe('2026.3.0')
    expect(runtimePinComparison('1.2.3', '1.2.4')).toBe('differs')
    expect(runtimePinComparison(null, '1.2.4')).toBe('unknown')
  })
  it('requires the fixed instance scope/IDs and rejects raw field expansion', () => {
    const report = unknownReport()
    expect(isRuntimeInspectionReport(report)).toBe(true)
    expect(isRuntimeInspectionReport({ ...report, userId: 'body-user' })).toBe(false)
    expect(isRuntimeInspectionReport({ ...report, scope: 'arbitrary-host' })).toBe(false)
    expect(isRuntimeInspectionReport({ ...report, rows: [...report.rows, report.rows[0]] })).toBe(false)
    expect(isRuntimeInspectionReport({ ...report, rows: report.rows.map(row => ({ ...row, command: '/secret' })) })).toBe(false)
  })
  it('never lets unknown rows inherit an older observation or payload', () => {
    const report = unknownReport()
    report.rows[0] = { ...report.rows[0], observedAt: report.reportedAt } as any
    expect(isRuntimeInspectionReport(report)).toBe(false)
    report.rows[0] = { ...report.rows[0], observedAt: null, data: { url: 'https://secret' } } as any
    expect(isRuntimeInspectionReport(report)).toBe(false)
  })
})
