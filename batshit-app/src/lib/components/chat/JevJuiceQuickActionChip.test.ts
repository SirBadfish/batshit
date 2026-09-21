import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/svelte'
import JevJuiceQuickActionChip from './JevJuiceQuickActionChip.svelte'
import { QUICK_ACTION_MARK_DETAIL_TEXT } from '$lib/utils/jevJuiceQuickActions'

/**
 * SA-120 P9 — the mark under a spoken user message Batshit acted on: what was done, by Jev,
 * with its confidence, and whether anything went to the agent (DL-120-15: the user always sees it).
 */

describe('JevJuiceQuickActionChip', () => {
  it('says what Batshit did with the confidence word, and on click who got the turn', async () => {
    render(JevJuiceQuickActionChip, {
      props: { mark: { id: 'open_goon_dock', tab: null, confidence: 0.98, onlyThis: true, snapshotId: 'qa_1', at: '' }, agentName: 'Faye' }
    })
    const chip = screen.getByTestId('jev-juice-quick-action')
    expect(chip.getAttribute('data-action-id')).toBe('open_goon_dock')
    expect(chip.textContent).toContain('Quick action by Jev: opened the Goon Dock (98% confidence)')
    await fireEvent.click(screen.getByRole('button', { name: 'Show what this quick action did' }))
    expect((await screen.findByTestId('jev-juice-quick-action-routing')).textContent).toBe('Nothing was sent to Faye.')
    expect(screen.getByText(QUICK_ACTION_MARK_DETAIL_TEXT)).toBeTruthy()
  })

  it('says the rest went to the agent for a mixed turn, naming the tab that opened', async () => {
    render(JevJuiceQuickActionChip, {
      props: { mark: { id: 'open_settings', tab: 'voice', confidence: 0.92, onlyThis: false, snapshotId: null, at: '' }, agentName: 'Opie' }
    })
    expect(screen.getByTestId('jev-juice-quick-action').textContent).toContain('opened Settings (Voice) (92% confidence)')
    await fireEvent.click(screen.getByRole('button', { name: 'Show what this quick action did' }))
    expect((await screen.findByTestId('jev-juice-quick-action-routing')).textContent).toBe('The rest went to Opie.')
  })
})
