import { describe, expect, it } from 'vitest'

import {
  getSubagentTimeoutValidationError,
  normalizeSubagentTimeoutSeconds,
} from '../subagentTimeout'

describe('subagent timeout validation', () => {
  it('accepts blank for the type default and the inclusive 10 to 600 second range', () => {
    expect(normalizeSubagentTimeoutSeconds('')).toBeUndefined()
    expect(normalizeSubagentTimeoutSeconds(null)).toBeUndefined()
    expect(normalizeSubagentTimeoutSeconds('10')).toBe(10)
    expect(normalizeSubagentTimeoutSeconds(600)).toBe(600)
  })

  it('rejects fractional, non-numeric, and out-of-range values', () => {
    for (const value of [9, 601, 10.5, 'slow']) {
      expect(normalizeSubagentTimeoutSeconds(value)).toBeUndefined()
      expect(getSubagentTimeoutValidationError(value)).toContain('whole number from 10 to 600')
    }
  })
})
