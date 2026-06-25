import { describe, expect, it } from 'vitest'

import {
  MAX_ZIP_THRESHOLD,
  normalizeZipBufferInputValue,
  normalizeZipThresholdInputValue
} from '../zipBufferInput'

describe('zipBufferInput', () => {
  it('normalizes zip buffer input with caller-owned minimums', () => {
    expect(normalizeZipBufferInputValue('', 1)).toBe('')
    expect(normalizeZipBufferInputValue('not-a-number', 1)).toBe('1')
    expect(normalizeZipBufferInputValue('-5', 1)).toBe('1')
    expect(normalizeZipBufferInputValue('999', 1)).toBe('50')
  })

  it('normalizes zip threshold input with the shared max', () => {
    expect(normalizeZipThresholdInputValue('')).toBe('')
    expect(normalizeZipThresholdInputValue('not-a-number')).toBe('0')
    expect(normalizeZipThresholdInputValue('-5')).toBe('0')
    expect(normalizeZipThresholdInputValue(String(MAX_ZIP_THRESHOLD + 1))).toBe(
      String(MAX_ZIP_THRESHOLD)
    )
  })
})
