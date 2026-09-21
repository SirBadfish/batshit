import { render, screen } from '@testing-library/svelte'
import { describe, expect, it } from 'vitest'
import JevJuicePostTurnChip from './JevJuicePostTurnChip.svelte'
import type { JevJuicePostTurnRecord } from '$lib/types/typesafe'
import {
  jevJuiceNoteDetail,
  jevJuicePostTurnChipText,
  jevJuicePostTurnFindingBasis,
  jevJuicePostTurnFindingText,
  jevJuicePostTurnToldText,
  readJevJuicePostTurnRecord
} from '$lib/utils/jevJuice'

/**
 * SA-120 P6 — the chip under a reply that the after-reply check flagged, and the plain words
 * it uses. It only says what was noticed and that the agent is told; it never claims the reply
 * was changed.
 */

function record(overrides: Partial<JevJuicePostTurnRecord> = {}): JevJuicePostTurnRecord {
  return {
    messageId: 'msg_1',
    sessionId: 'sess_1',
    agentId: 'agent_1',
    at: '2026-09-17T08:00:00.000Z',
    findings: [
      { id: 'claimed_action', lane: 'reply_check', source: 'inferred', probability: 0.91 },
      { id: 'silent_failure', lane: 'reply_check', source: 'inferred', probability: 0.97, detail: 'bash: npm run test - exit 1' },
      { id: 'repeated_opener', lane: 'style_coach', source: 'counted', detail: 'great question', count: 3, window: 6, probability: 0.89 }
    ],
    notes: [],
    toldAgent: false,
    ...overrides
  }
}

describe('JevJuicePostTurnChip', () => {
  it('draws one chip that counts each lane in plain words', async () => {
    render(JevJuicePostTurnChip, { props: { record: record() } })
    const chip = await screen.findByTestId('jev-juice-post-turn')
    expect(chip.textContent).toContain('Reply check: 2 flags · Style: 1 note')
    expect(chip.className).toContain('message-memory-chip')
    expect(chip.className).toContain('is-jev-juice')
  })

  it('draws the ordinary Jev Juice note, and no chip, when a lane could not run', async () => {
    render(JevJuicePostTurnChip, {
      props: {
        record: record({
          findings: [],
          notes: [{ feature: 'reply_check', status: 'unavailable', reason: 'master_off', at: '2026-09-17T08:00:00.000Z' }]
        })
      }
    })
    const note = await screen.findByTestId('jev-juice-note')
    expect(note.textContent).toContain('Jev Juice: Reply check skipped')
    expect(note.getAttribute('title')).toBe('Jev Juice is off in Settings → Admin. This reply was not checked.')
    expect(screen.queryByTestId('jev-juice-post-turn')).toBeNull()
  })
})

describe('the words on the chip', () => {
  it('counts each lane on its own and says nothing for an empty lane', () => {
    expect(jevJuicePostTurnChipText(record({ findings: [record().findings[0]] }))).toBe('Reply check: 1 flag')
    expect(jevJuicePostTurnChipText(record({ findings: [record().findings[2]] }))).toBe('Style: 1 note')
    expect(jevJuicePostTurnChipText(record({ findings: [] }))).toBe('')
  })

  it('describes each finding without jargon, names a failed tool, and quotes repeated words', () => {
    const [claimed, failure, opener] = record().findings
    expect(jevJuicePostTurnFindingText(claimed)).toBe('Says it did something, but no tool call matches it.')
    expect(jevJuicePostTurnFindingText(failure)).toBe('A tool failed and the reply does not say so: bash: npm run test - exit 1')
    expect(jevJuicePostTurnFindingText(opener)).toBe('Opened 3 of the last 6 replies with “great question”.')
    expect(jevJuicePostTurnFindingText({ id: 'promised_memory', lane: 'reply_check', source: 'inferred' })).toBe('Says it will remember, but nothing was saved.')
    expect(jevJuicePostTurnFindingText({ id: 'unaddressed_part', lane: 'reply_check', source: 'inferred' })).toBe('Part of your message may be unanswered.')
  })

  it('always says where a finding came from: a judgment shows its confidence with the word, a count says it was counted', () => {
    const [claimed, , opener] = record().findings
    expect(jevJuicePostTurnFindingBasis(claimed)).toBe('91% confidence')
    expect(jevJuicePostTurnFindingBasis(opener)).toBe('counted, a habit of speech (89% confidence)')
    expect(jevJuicePostTurnFindingBasis({ id: 'repeated_phrase', lane: 'style_coach', source: 'counted' })).toBe('counted')
  })

  it('says the agent is told and never that the reply was changed', () => {
    expect(jevJuicePostTurnToldText(record())).toBe('The agent is told on its next turn. The reply itself is never changed.')
    expect(jevJuicePostTurnToldText(record({ toldAgent: true }))).toBe('The agent was told on its next turn. The reply itself was never changed.')
  })

  it('keeps the send-path wording for every other lane\'s note', () => {
    expect(jevJuiceNoteDetail({ feature: 'smart_zip', status: 'unavailable', reason: 'deadline', at: 't' })).toBe(
      'TypeSafe did not answer in time. The message was sent without it.'
    )
    expect(jevJuiceNoteDetail({ feature: 'style_coach', status: 'unavailable', reason: 'deadline', at: 't' })).toBe(
      'TypeSafe did not answer in time. This reply was not checked.'
    )
  })
})

describe('readJevJuicePostTurnRecord', () => {
  it('drops unknown findings and refuses a record with nothing readable in it', () => {
    expect(readJevJuicePostTurnRecord(null)).toBeNull()
    expect(readJevJuicePostTurnRecord({ findings: record().findings })).toBeNull()
    expect(readJevJuicePostTurnRecord({ messageId: 'm', findings: [{ id: 'made_up', lane: 'reply_check', source: 'inferred' }] })).toBeNull()
    const read = readJevJuicePostTurnRecord({
      messageId: 'm',
      findings: [record().findings[0], { id: 'claimed_action', lane: 'elsewhere', source: 'inferred' }],
      toldAgent: 'yes'
    })
    expect(read?.findings).toEqual([record().findings[0]])
    expect(read?.toldAgent).toBe(false)
    expect(read?.notes).toEqual([])
  })
})
