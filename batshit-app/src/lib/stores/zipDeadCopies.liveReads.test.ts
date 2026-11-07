import { describe, expect, it, vi } from 'vitest'
import { getLiveReadCopyFact, refreshAllDeadCopies, refreshDeadCopies } from './zipDeadCopies.svelte'

/** SA-137 P4 review: a save re-asks every held chat; a call during a running one asks again once. */
describe('zipDeadCopies live-read facts', () => {
  const answer = (liveReads: unknown) => new Response(JSON.stringify({ deadCopies: {}, liveReads }), { status: 200 })
  const current = (promptTokens: number) => ({ state: 'current', replyId: 'r', agentId: 'a', delivery: 'issued', at: 'now', copies: { cool_tool_1_abcd: { status: 'refreshed', promptTokens } }, overflow: 0 })

  it('a call that arrives while one runs asks again once, so the newer answer wins', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetcher = vi.fn()
      .mockImplementationOnce(async () => { await gate; return answer(current(10)) })
      .mockImplementationOnce(async () => answer(current(20)))
    const first = refreshDeadCopies('chat-coalesce', fetcher as any)
    const second = refreshDeadCopies('chat-coalesce', fetcher as any)
    release()
    await Promise.all([first, second])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(getLiveReadCopyFact('chat-coalesce', 'cool_tool_1_abcd')).toMatchObject({ status: 'refreshed', promptTokens: 20 })
  })

  it('refreshAllDeadCopies re-asks every chat this page holds; an unknown state names its copies', async () => {
    await refreshDeadCopies('chat-one', (async () => answer(current(10))) as any)
    await refreshDeadCopies('chat-two', (async () => answer(null)) as any)
    const fetcher = vi.fn(async (url: string) => url.includes('chat-one')
      ? answer({ state: 'unknown', replyId: 'r', agentId: 'a', unknownReason: 'missing', copies: { cool_tool_1_abcd: { status: 'unknown' } }, overflow: 0 })
      : answer(null))
    await refreshAllDeadCopies(fetcher as any)
    const asked = fetcher.mock.calls.map(([url]) => String(url))
    expect(asked.some((url) => url.includes('chat-one'))).toBe(true)
    expect(asked.some((url) => url.includes('chat-two'))).toBe(true)
    expect(getLiveReadCopyFact('chat-one', 'cool_tool_1_abcd')).toEqual({ status: 'unknown', replyId: 'r', delivery: null })
  })

  // Round 2 (strict freshness): `strict` rides on a copy fact only from a current receipt.
  describe('the strict flag', () => {
    const receipt = (extra: Record<string, unknown>) => ({
      state: 'current', replyId: 'r', agentId: 'a', delivery: 'issued', at: 'now',
      copies: { cool_tool_1_abcd: { status: 'static', reason: 'not-readable' } }, overflow: 0, ...extra
    })

    it('a strict current receipt marks its static copy strict', async () => {
      await refreshDeadCopies('chat-strict', (async () => answer(receipt({ strict: true }))) as any)
      expect(getLiveReadCopyFact('chat-strict', 'cool_tool_1_abcd')).toEqual({
        status: 'static', reason: 'not-readable', replyId: 'r', delivery: 'issued', strict: true
      })
    })

    it('a current receipt that is not strict leaves the copy without the flag (today\'s fact)', async () => {
      await refreshDeadCopies('chat-not-strict', (async () => answer(receipt({}))) as any)
      expect(getLiveReadCopyFact('chat-not-strict', 'cool_tool_1_abcd')).toEqual({
        status: 'static', reason: 'not-readable', replyId: 'r', delivery: 'issued'
      })
      await refreshDeadCopies('chat-strict-false', (async () => answer(receipt({ strict: false }))) as any)
      expect(getLiveReadCopyFact('chat-strict-false', 'cool_tool_1_abcd')).not.toHaveProperty('strict')
    })

    it('a changed receipt gives no fact at all, strict or not', async () => {
      await refreshDeadCopies('chat-strict-changed', (async () => answer(receipt({ state: 'changed', strict: true }))) as any)
      expect(getLiveReadCopyFact('chat-strict-changed', 'cool_tool_1_abcd')).toBeNull()
    })
  })
})
