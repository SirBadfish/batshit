import { render, screen } from '@testing-library/svelte'
import { describe, expect, it } from 'vitest'
import JevJuiceNote from './JevJuiceNote.svelte'
import { jevJuiceNoteDetail, jevJuiceNoteText, jevJuiceGapDetail, jevJuiceGapText, readJevJuiceGaps, readJevJuiceNotes } from '$lib/utils/jevJuice'

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
    expect(chip.textContent).toContain('Judge Juice: Connection test skipped')
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
    // SA-120 P10b: the gap is stored without the judge that found it, so the tooltip says "The judge", never Jev.
    expect(jevJuiceGapDetail(gap)).toBe(
      "The judge thinks this request needs Web Search, which is turned off for Faye. The agent was told. Click to open the agent's settings."
    )
  })
})

describe('SA-120 P10a: the note names the judge it could not use', () => {
  it('names who serves the judge, and says what each new reason means', () => {
    const ollama = { id: 'ollama-pc', kind: 'ollama' as const, label: 'Ollama on the PC' }
    expect(jevJuiceNoteDetail({ feature: 'smart_zip', status: 'unavailable', reason: 'deadline', at: 't', provider: ollama })).toBe(
      'Ollama did not answer in time. The message was sent without it.'
    )
    expect(jevJuiceNoteDetail({ feature: 'reply_check', status: 'unavailable', reason: 'provider_limit', at: 't', provider: ollama })).toBe(
      'The request was too large for this judge (Ollama), so Batshit did not send it. This reply was not checked.'
    )
    expect(jevJuiceNoteDetail({ feature: 'untrusted_text', status: 'unavailable', reason: 'no_provider', at: 't' })).toBe(
      'The judge chosen for this feature is missing or not set up in Settings → Admin → Judge Juice. This text was not screened.'
    )
    expect(
      jevJuiceNoteDetail({ feature: 'smart_zip', status: 'unavailable', reason: 'no_key', at: 't', provider: { id: 'cf', kind: 'cloudflare', label: 'CF' } })
    ).toBe('No Cloudflare key is saved. The message was sent without it.')
    // A note from before P10a (no provider) still names TypeSafe.
    expect(jevJuiceNoteDetail({ feature: 'smart_zip', status: 'unavailable', reason: 'network', at: 't' })).toBe(
      'Batshit could not reach TypeSafe. The message was sent without it.'
    )
  })
})

it('SA-120 P10b: a refused no-reply receipt names Jev only when TypeSafe answered', () => {
  const base = { feature: 'group_speaker', status: 'not_applied', reason: 'receipt_not_saved', at: '2026-10-12T06:00:00Z' } as const
  expect(jevJuiceNoteDetail({ ...base, provider: { id: 'typesafe', kind: 'typesafe', label: 'TypeSafe' } })).toBe(
    'Jev answered, but Batshit could not save its no-reply receipt. The usual speaker rules were used.'
  )
  expect(jevJuiceNoteDetail({ ...base, provider: { id: 'o1', kind: 'ollama', label: 'Mac Studio' } })).toBe(
    'The judge answered, but Batshit could not save its no-reply receipt. The usual speaker rules were used.'
  )
  expect(jevJuiceNoteDetail({ ...base, provider: { id: 'c1', kind: 'cloudflare', label: 'CF' } })).not.toContain('Jev')
})

it('explains a refused no-reply receipt without fabricating a Jev miss', () => {
  const note = { feature: 'group_speaker', status: 'not_applied', reason: 'receipt_not_saved', at: '2026-10-11T06:00:00Z' } as const
  render(JevJuiceNote, { props: { notes: [note] } })
  expect(jevJuiceNoteText(note)).toBe('Judge Juice: No-reply decision not applied')
  expect(jevJuiceNoteDetail(note)).toBe('Jev answered, but Batshit could not save its no-reply receipt. The usual speaker rules were used.')
  expect(screen.getByTestId('jev-juice-note').getAttribute('title')).toContain('Jev answered')
  expect(readJevJuiceNotes({ jevJuice: { notes: [note] } })).toEqual([note])
})
