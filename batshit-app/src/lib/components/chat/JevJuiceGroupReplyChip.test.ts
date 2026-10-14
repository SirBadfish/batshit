import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/svelte'
import JevJuiceGroupReplyChip from './JevJuiceGroupReplyChip.svelte'
import { GROUP_REPLY_SKIPPED_DETAIL, groupReplyContentHash, readGroupReplySkipped, type GroupReplySkipped } from '$lib/utils/groupReplySkipped'
import { sanitizeFinishedReplyContent } from '$lib/utils/replyEndContent'

const content = 'Thanks, that settles it.'

const mark: GroupReplySkipped = {
  source: 'jev', messageId: 'u1', groupTurnId: 'round1', eventIndex: 1,
  snapshotId: 'gs_1', contentHash: groupReplyContentHash(content), confidence: 0.93, at: '2026-10-11T05:00:00Z'
}

describe('the saved group no-reply explanation', () => {
  it('reads the mark back from saved message metadata and explains silence without an assistant row', async () => {
    const reloaded = readGroupReplySkipped(JSON.parse(JSON.stringify({ groupReplySkipped: mark })), 'u1', content)
    expect(reloaded).toEqual(mark)
    render(JevJuiceGroupReplyChip, { props: { mark: reloaded! } })
    expect(screen.getByTestId('jev-juice-group-reply-skipped').textContent).toContain('Reply skipped by the judge (93% confidence)')
    await fireEvent.click(screen.getByRole('button', { name: 'Show why this group reply was skipped' }))
    expect(await screen.findByText(GROUP_REPLY_SKIPPED_DETAIL)).toBeTruthy()
  })

  it('keeps the content binding across the chat owner’s existing reload cleaner', () => {
    const raw = 'Thanks.\n\n\n<cool_tool/>\n<batshit-zip-control>{}</batshit-zip-control>'
    const saved = { groupReplySkipped: { ...mark, contentHash: groupReplyContentHash(raw) } }
    const display = sanitizeFinishedReplyContent(raw)
    expect(display).not.toBe(raw)
    expect(readGroupReplySkipped(saved, 'u1', raw)).not.toBeNull()
    expect(readGroupReplySkipped(saved, 'u1', display)).not.toBeNull()
    expect(readGroupReplySkipped(saved, 'u1', display + ' Please answer?')).toBeNull()
  })

  it('does not render a mark belonging to a different message or an uncertain/malformed mark', () => {
    expect(readGroupReplySkipped({ groupReplySkipped: mark }, 'u2', content)).toBeNull()
    expect(readGroupReplySkipped({ groupReplySkipped: mark }, 'u1', 'Please answer instead.')).toBeNull()
    for (const patch of [{ source: 'rules' }, { confidence: 0.5 }, { confidence: NaN }, { eventIndex: 2 }, { snapshotId: '' }, { at: 'invalid' }]) {
      expect(readGroupReplySkipped({ groupReplySkipped: { ...mark, ...patch } }, 'u1', content)).toBeNull()
    }
  })
})
