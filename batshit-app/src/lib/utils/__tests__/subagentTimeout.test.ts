import { describe, expect, it } from 'vitest'

import {
  formatDelegationDuration,
  getSubagentTimeoutValidationError,
  MAX_SUBAGENT_TIMEOUT_SECONDS,
  normalizeSubagentTimeoutSeconds,
} from '../subagentTimeout'
import {
  getSubagentMaxToolStepsValidationError,
  normalizeSubagentMaxToolSteps,
} from '../subagentToolSteps'

describe('subagent timeout validation (delegation limits, 2026-10-24)', () => {
  it('accepts blank for no limit and the inclusive 10 second to 24 hour range', () => {
    expect(normalizeSubagentTimeoutSeconds('')).toBeUndefined()
    expect(normalizeSubagentTimeoutSeconds(null)).toBeUndefined()
    expect(getSubagentTimeoutValidationError('')).toBeNull()
    expect(normalizeSubagentTimeoutSeconds('10')).toBe(10)
    expect(normalizeSubagentTimeoutSeconds(600)).toBe(600)
    // Decision 4: no small maximum. The old 600 s ceiling is gone.
    expect(normalizeSubagentTimeoutSeconds(601)).toBe(601)
    expect(normalizeSubagentTimeoutSeconds(86_400)).toBe(86_400)
    expect(MAX_SUBAGENT_TIMEOUT_SECONDS).toBe(24 * 60 * 60)
  })

  it('rejects fractional, non-numeric, and out-of-range values', () => {
    for (const value of [9, 86_401, 10.5, 'slow']) {
      expect(normalizeSubagentTimeoutSeconds(value)).toBeUndefined()
      expect(getSubagentTimeoutValidationError(value)).toContain('whole number of seconds from 10 to 86,400 (24 hours)')
    }
  })

  it('says a set limit the way a person does', () => {
    expect(formatDelegationDuration(45)).toBe('45 seconds')
    expect(formatDelegationDuration(1)).toBe('1 second')
    expect(formatDelegationDuration(600)).toBe('10 minutes')
    expect(formatDelegationDuration(5_400)).toBe('1 hour 30 minutes')
    expect(formatDelegationDuration(7_261)).toBe('2 hours 1 minute 1 second')
    expect(formatDelegationDuration(86_400)).toBe('24 hours')
  })
})

describe('subagent tool-step limit validation (decision 3)', () => {
  it('accepts blank for no limit and whole numbers from 1 to 10,000', () => {
    expect(normalizeSubagentMaxToolSteps('')).toBeUndefined()
    expect(normalizeSubagentMaxToolSteps(undefined)).toBeUndefined()
    expect(getSubagentMaxToolStepsValidationError(null)).toBeNull()
    expect(normalizeSubagentMaxToolSteps('1')).toBe(1)
    expect(normalizeSubagentMaxToolSteps(40)).toBe(40)
    expect(normalizeSubagentMaxToolSteps(10_000)).toBe(10_000)
  })

  it('rejects zero, fractional, non-numeric, and out-of-range values', () => {
    for (const value of [0, -3, 2.5, 10_001, 'many']) {
      expect(normalizeSubagentMaxToolSteps(value)).toBeUndefined()
      expect(getSubagentMaxToolStepsValidationError(value)).toContain('whole number from 1 to 10,000')
    }
  })
})
