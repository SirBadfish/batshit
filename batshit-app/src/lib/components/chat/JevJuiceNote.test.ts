import { render, screen } from '@testing-library/svelte'
import { describe, expect, it } from 'vitest'
import JevJuiceNote from './JevJuiceNote.svelte'
import { jevJuiceGapDetail, jevJuiceGapText, readJevJuiceGaps, readJevJuiceNotes } from '$lib/utils/jevJuice'

/** SA-120 P0 — the inline miss note (DL-120-02): a quiet chip with the reason in its tooltip. */

describe('JevJuiceNote', () => {
  it('renders one chip per note with the feature label and the reason as a tooltip', async () => {
    render(JevJuiceNote, {
      props: {
        notes: [
          { feature: 'connection_test', status: 'unavailable', reason: 'deadline', at: '2026-09-16T12:00:00.000Z' }
        ]
      }
    })
    const chip = await screen.findByTestId('jev-juice-note')
    expect(chip.textContent).toContain('Jev Juice: Connection test skipped')
    expect(chip.getAttribute('title')).toBe('TypeSafe did not answer in time. The message was sent without it.')
  })
})

describe('readJevJuiceNotes', () => {
  it('ignores messages without notes and malformed entries', () => {
    expect(readJevJuiceNotes(undefined)).toEqual([])
    expect(readJevJuiceNotes({ jevJuice: { notes: 'x' } })).toEqual([])
    expect(readJevJuiceNotes({ jevJuice: { notes: [{ feature: 'a', status: 'ok' }, { feature: 'b', status: 'error', reason: 'network', at: 't' }] } })).toEqual([
      { feature: 'b', status: 'error', reason: 'network', at: 't' }
    ])
  })
})

describe('gap chips (SA-120 P1)', () => {
  const gap = { id: 'native:web_search', kind: 'native' as const, label: 'Web Search', agentId: 'agent_1', agentName: 'Faye', probability: 0.8, at: 't' }

  it('reads gaps defensively and words the chip as a gap, never as access', () => {
    expect(readJevJuiceGaps({ jevJuice: { notes: [], gaps: [gap, { label: 1 }] } })).toEqual([gap])
    expect(readJevJuiceGaps({ jevJuice: { notes: [] } })).toEqual([])
    expect(jevJuiceGapText(gap)).toBe('Might need Web Search (off for Faye)')
    expect(jevJuiceGapDetail(gap)).toContain('turned off for Faye')
    expect(jevJuiceGapDetail(gap)).not.toMatch(/enable|turn on/i)
  })
})
