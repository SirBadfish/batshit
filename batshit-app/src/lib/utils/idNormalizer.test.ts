import { describe, expect, it } from 'vitest'
import { isSameId, normalizeId, parseIdParts } from './idNormalizer'

describe('normalizeId', () => {
  it('keeps a clip_<uuid> id whole when its last group is all digits (BL-780)', () => {
    const digitTail = 'clip_3f2a9c1e-4b7d-4e2a-9c3b-123456789012'
    expect(normalizeId(digitTail)).toBe(digitTail)
    expect(normalizeId(digitTail.toUpperCase())).toBe(digitTail.toUpperCase())
    expect(parseIdParts(digitTail)).toEqual({ baseId: digitTail, index: 0 })
    // Two clips that share only their first four groups stay two clips.
    expect(isSameId(digitTail, 'clip_3f2a9c1e-4b7d-4e2a-9c3b-123456789013')).toBe(false)
  })

  it('keeps a clip_<uuid> id whose last group has a letter whole', () => {
    const id = 'clip_3f2a9c1e-4b7d-4e2a-9c3b-12345678901a'
    expect(normalizeId(id)).toBe(id)
  })

  it('still strips an index after a whole uuid', () => {
    expect(normalizeId('clip_3f2a9c1e-4b7d-4e2a-9c3b-123456789012-3')).toBe('clip_3f2a9c1e-4b7d-4e2a-9c3b-123456789012')
  })

  it('still strips the index suffixes it was written for', () => {
    expect(normalizeId('sess-msg-error-2')).toBe('sess-msg-error')
    expect(normalizeId('abc-cool_tool-7')).toBe('abc-cool_tool-0')
    expect(normalizeId('clip_1790500000000_abc123_4')).toBe('clip_1790500000000_abc123')
    expect(parseIdParts('sess-msg-error-2')).toEqual({ baseId: 'sess-msg-error', index: 2 })
  })

  it('still cuts a digit-only _N tail from a zip id (Hold state is keyed on that id, BL-476)', () => {
    expect(normalizeId('cool_tool_1790500000000_48213')).toBe('cool_tool_1790500000000')
  })
})
