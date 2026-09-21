import { describe, expect, it, vi } from 'vitest'
import {
  applyJevJuicePostTurnRecords,
  forgetJevJuicePostTurnRecords,
  getJevJuicePostTurnRecord,
  refreshJevJuicePostTurnRecords
} from '../jevJuicePostTurn.svelte'

/**
 * SA-120 P6 — the chat page's copy of the after-reply records. The server owns them; this
 * store only mirrors one chat at a time, drops what it cannot read, and never lets a failed
 * read disturb what is on screen.
 */

const RECORD = {
  messageId: 'msg_1',
  sessionId: 'sess_1',
  agentId: 'agent_1',
  at: '2026-09-17T08:00:00.000Z',
  findings: [{ id: 'claimed_action', lane: 'reply_check', source: 'inferred', probability: 0.91 }],
  notes: [],
  toldAgent: false
}

function answering(status: number, payload: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(payload), { status })) as unknown as typeof fetch
}

describe('jevJuicePostTurn store', () => {
  it('reads one chat\'s records from the server and hands a chip its own', async () => {
    const fetcher = answering(200, { records: { msg_1: RECORD } })
    await refreshJevJuicePostTurnRecords('sess_1', fetcher)
    expect(fetcher).toHaveBeenCalledWith('/api/jev-juice/post-turn?sessionId=sess_1')
    expect(getJevJuicePostTurnRecord('sess_1', 'msg_1')).toEqual(RECORD)
    expect(getJevJuicePostTurnRecord('sess_1', 'msg_2')).toBeNull()
    expect(getJevJuicePostTurnRecord('sess_other', 'msg_1')).toBeNull()
    expect(getJevJuicePostTurnRecord(null, 'msg_1')).toBeNull()
  })

  it('replaces a chat\'s records whole, so a deleted reply\'s record goes away on the next read', () => {
    applyJevJuicePostTurnRecords('sess_2', { msg_a: { ...RECORD, messageId: 'msg_a' }, msg_b: { ...RECORD, messageId: 'msg_b' } })
    applyJevJuicePostTurnRecords('sess_2', { msg_b: { ...RECORD, messageId: 'msg_b' } })
    expect(getJevJuicePostTurnRecord('sess_2', 'msg_a')).toBeNull()
    expect(getJevJuicePostTurnRecord('sess_2', 'msg_b')?.messageId).toBe('msg_b')
  })

  it('drops what it cannot read, and an entry filed under the wrong message', () => {
    applyJevJuicePostTurnRecords('sess_3', {
      msg_bad: { messageId: 'msg_bad', findings: [{ id: 'made_up' }] },
      msg_wrong: RECORD,
      msg_ok: { ...RECORD, messageId: 'msg_ok' }
    })
    expect(getJevJuicePostTurnRecord('sess_3', 'msg_bad')).toBeNull()
    expect(getJevJuicePostTurnRecord('sess_3', 'msg_wrong')).toBeNull()
    expect(getJevJuicePostTurnRecord('sess_3', 'msg_ok')).not.toBeNull()
  })

  it('leaves what is on screen alone when a read fails, and says nothing about a chat that is gone', async () => {
    applyJevJuicePostTurnRecords('sess_4', { msg_1: RECORD })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await refreshJevJuicePostTurnRecords('sess_4', answering(500, { error: 'nope' }))
    await refreshJevJuicePostTurnRecords('sess_4', vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch)
    expect(getJevJuicePostTurnRecord('sess_4', 'msg_1')).toEqual(RECORD)
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockClear()
    await refreshJevJuicePostTurnRecords('sess_4', answering(404, { error: 'Session not found' }))
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('forgets a chat that was deleted', () => {
    applyJevJuicePostTurnRecords('sess_5', { msg_1: RECORD })
    forgetJevJuicePostTurnRecords('sess_5')
    expect(getJevJuicePostTurnRecord('sess_5', 'msg_1')).toBeNull()
  })
})
