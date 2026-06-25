import { describe, expect, it } from 'vitest'

import { buildTextTimingLipSyncAnalysis } from './lipSyncAnalyzer'

describe('lipSyncAnalyzer', () => {
  it('builds the current text-timing fallback as a shared analyzer result', () => {
    const analysis = buildTextTimingLipSyncAnalysis({
      speakableText: 'See you soon.',
      playbackRate: 1
    })

    expect(analysis.analyzerId).toBe('batshit-text-timing')
    expect(analysis.runtime).toBe('shared')
    expect(analysis.source).toBe('text-timing')
    expect(analysis.timeline?.durationMs ?? 0).toBeGreaterThan(0)
    expect(analysis.warnings).toHaveLength(0)
  })

  it('returns a warning when no speakable text exists', () => {
    const analysis = buildTextTimingLipSyncAnalysis({
      speakableText: '',
      playbackRate: 1
    })

    expect(analysis.timeline).toBeNull()
    expect(analysis.warnings[0]).toContain('No speakable text')
  })
})
