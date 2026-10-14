import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isSilentAutoCompactNoCandidates } from '../compactNoCandidates'

/**
 * BL-755: nothing left to compact (400 `no_compaction_candidates`) is not an error. An Auto
 * Compact the user never pressed says nothing at all; a pressed Compact still hears about it.
 */
describe('an Auto Compact meeting no_compaction_candidates', () => {
  const noCandidates = { error: 'server words', code: 'no_compaction_candidates' }

  it('is silent only for Auto Compact, at 400, with that exact code', () => {
    expect(isSilentAutoCompactNoCandidates('auto', 400, noCandidates)).toBe(true)
  })

  it('a pressed Compact still hears about it', () => {
    expect(isSilentAutoCompactNoCandidates('manual', 400, noCandidates)).toBe(false)
  })

  it('any other status or code is not this', () => {
    expect(isSilentAutoCompactNoCandidates('auto', 409, noCandidates)).toBe(false)
    expect(isSilentAutoCompactNoCandidates('auto', 400, { code: 'ended_early' })).toBe(false)
    expect(isSilentAutoCompactNoCandidates('auto', 400, null)).toBe(false)
  })

  describe('the chat page wires it (source pins, from the line start)', () => {
    const page = readFileSync(path.resolve('src/routes/+page.svelte'), 'utf8')

    it('both Compact requests silence it for Auto Compact before their generic throw', () => {
      const calls = page.split(
        '\n        if (isSilentAutoCompactNoCandidates(mode, response.status, '
      ).length - 1
      expect(calls).toBe(2)
    })
  })
})
