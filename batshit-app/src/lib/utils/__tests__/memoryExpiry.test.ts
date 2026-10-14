import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  dateInputToExpiry,
  expiresAtUpdate,
  expiryToDateInput,
  normalizeEventAtInput,
  normalizeExpiryInput
} from '../memoryExpiry'

/**
 * BL-437: the Memory Panel's date picker and a memory's stored expiry instant. Runs in a
 * fixed zone west of UTC (Pacific, with its daylight-saving changes) so a UTC reading of a
 * calendar day would land on the wrong local day and fail here.
 */

const PREVIOUS_TZ = process.env.TZ

beforeAll(() => {
  process.env.TZ = 'America/Los_Angeles'
})

afterAll(() => {
  if (PREVIOUS_TZ === undefined) delete process.env.TZ
  else process.env.TZ = PREVIOUS_TZ
})

describe('memory expiry date conversion (BL-437)', () => {
  it('runs in Pacific time', () => {
    expect(new Date('2026-10-01T12:00:00.000Z').getTimezoneOffset()).toBe(420)
    expect(new Date('2026-12-01T12:00:00.000Z').getTimezoneOffset()).toBe(480)
  })

  it('shows the local day a stored instant falls on, not the UTC date part', () => {
    expect(expiryToDateInput('2026-10-02T05:30:00.000Z')).toBe('2026-10-01')
    expect(expiryToDateInput('2026-10-01T23:00:00-07:00')).toBe('2026-10-01')
    expect(expiryToDateInput('2026-10-01T07:00:00.000Z')).toBe('2026-10-01')
    expect(expiryToDateInput(undefined)).toBe('')
    expect(expiryToDateInput(null)).toBe('')
    expect(expiryToDateInput('')).toBe('')
    expect(expiryToDateInput('not a date')).toBe('')
  })

  it('a picked day expires at the end of that local day, daylight-saving days included', () => {
    expect(dateInputToExpiry('2026-10-01')).toBe('2026-10-02T06:59:59.999Z')
    // Nov 1, 2026 has 25 hours in Pacific time (clocks fall back): the end is 11:59 PM PST.
    expect(dateInputToExpiry('2026-11-01')).toBe('2026-11-02T07:59:59.999Z')
    // Mar 8, 2026 has 23 hours (clocks spring forward): the end is 11:59 PM PDT.
    expect(dateInputToExpiry('2026-03-08')).toBe('2026-03-09T06:59:59.999Z')
    for (const day of ['2026-10-01', '2026-11-01', '2026-03-08', '2026-12-31']) {
      expect(expiryToDateInput(dateInputToExpiry(day))).toBe(day)
    }
  })

  it('refuses a value that is not a real calendar day, loudly', () => {
    expect(() => dateInputToExpiry('2026-02-31')).toThrow(/not a real calendar day/)
    expect(() => dateInputToExpiry('Oct 1')).toThrow(/YYYY-MM-DD/)
  })

  it('an incoming expiry: a bare day is the end of that local day, a timestamp stays as given (BL-785)', () => {
    expect(normalizeExpiryInput('2026-10-01')).toBe('2026-10-02T06:59:59.999Z')
    expect(normalizeExpiryInput(' 2026-11-01 ')).toBe('2026-11-02T07:59:59.999Z')
    expect(normalizeExpiryInput('2026-10-01T23:00:00-07:00')).toBe('2026-10-01T23:00:00-07:00')
    expect(normalizeExpiryInput('2026-10-02T05:30:00.000Z')).toBe('2026-10-02T05:30:00.000Z')
    expect(normalizeExpiryInput('soon')).toBe('soon')
    expect(() => normalizeExpiryInput('2026-02-31')).toThrow(/not a real calendar day/)
  })

  it('an incoming event day: a bare day is the START of that local day, a timestamp stays as given (BL-817)', () => {
    // Pacific is west of UTC: a UTC reading of "2026-10-01" (07:00Z is midnight PDT) would be the
    // evening of Sept 30 here, the wrong day on the "Happened" line and in a search for Oct 1.
    expect(normalizeEventAtInput('2026-10-01')).toBe('2026-10-01T07:00:00.000Z')
    expect(normalizeEventAtInput(' 2026-12-01 ')).toBe('2026-12-01T08:00:00.000Z')
    // Nov 1, 2026 has 25 hours (clocks fall back at 2 AM); its start is still midnight PDT.
    expect(normalizeEventAtInput('2026-11-01')).toBe('2026-11-01T07:00:00.000Z')
    // Mar 8, 2026 has 23 hours (clocks spring forward at 2 AM); its start is midnight PST.
    expect(normalizeEventAtInput('2026-03-08')).toBe('2026-03-08T08:00:00.000Z')
    for (const day of ['2026-10-01', '2026-11-01', '2026-03-08', '2026-12-31']) {
      expect(expiryToDateInput(normalizeEventAtInput(day))).toBe(day)
    }
    expect(normalizeEventAtInput('2026-10-01T23:00:00-07:00')).toBe('2026-10-01T23:00:00-07:00')
    expect(normalizeEventAtInput('2026-10-02T05:30:00.000Z')).toBe('2026-10-02T05:30:00.000Z')
    expect(normalizeEventAtInput('soon')).toBe('soon')
    expect(() => normalizeEventAtInput('2026-02-31')).toThrow(/event date .* not a real calendar day/)
  })

  it('a save carries expires_at only when the field changed', () => {
    expect(expiresAtUpdate('2026-10-01', '2026-10-01')).toEqual({})
    expect(expiresAtUpdate('', '')).toEqual({})
    expect(expiresAtUpdate('', '2026-10-01')).toEqual({ expires_at: null })
    expect(expiresAtUpdate('2026-10-03', '2026-10-01')).toEqual({
      expires_at: '2026-10-04T06:59:59.999Z'
    })
    expect(expiresAtUpdate('2026-10-03', '')).toEqual({ expires_at: '2026-10-04T06:59:59.999Z' })
  })
})

describe('memory expiry through a repeated final hour (BL-1237)', () => {
  function inSantiago(check: () => void) {
    const previous = process.env.TZ
    process.env.TZ = 'America/Santiago'
    try {
      expect(new Date('2026-04-05T02:30:00.000Z').getTimezoneOffset()).toBe(180)
      expect(new Date('2026-04-05T03:30:00.000Z').getTimezoneOffset()).toBe(240)
      check()
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
  }

  it('a picked day includes both occurrences of its final hour', () => {
    inSantiago(() => {
      const expiry = dateInputToExpiry('2026-04-04')
      expect(expiry).toBe('2026-04-05T03:59:59.999Z')
      expect(expiryToDateInput(expiry)).toBe('2026-04-04')
    })
  })

  it('an agent bare day uses the final boundary, preserving timestamps and event starts', () => {
    inSantiago(() => {
      expect(normalizeExpiryInput('2026-04-04T23:59:59.999-03:00')).toBe(
        '2026-04-04T23:59:59.999-03:00'
      )
      expect(normalizeEventAtInput('2026-04-04')).toBe('2026-04-04T03:00:00.000Z')
      expect(() => normalizeExpiryInput('2026-02-31')).toThrow(/not a real calendar day/)
      expect(normalizeExpiryInput(' 2026-04-04 ')).toBe('2026-04-05T03:59:59.999Z')
    })
  })

  it('an untouched old expiry stays omitted; a newly picked day uses the final boundary', () => {
    inSantiago(() => {
      const oldDay = expiryToDateInput('2026-04-05T02:59:59.999Z')
      expect(oldDay).toBe('2026-04-04')
      expect(expiresAtUpdate(oldDay, oldDay)).toEqual({})
      expect(expiresAtUpdate('', oldDay)).toEqual({ expires_at: null })
      expect(expiresAtUpdate('2026-04-04', '')).toEqual({
        expires_at: '2026-04-05T03:59:59.999Z'
      })
    })
  })
})
