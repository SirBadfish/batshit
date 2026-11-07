import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { zippingService } from '$lib/services/zipping'
import * as messageStore from '$lib/stores/messages.svelte'
import { describeNotRefreshedReason } from '$lib/utils/liveFileReads'
import ZipsManagerDropdown from './ZipsManagerDropdown.svelte'

afterEach(() => vi.restoreAllMocks())

describe('Zip Manager closed trigger', () => {
  it('counts stored Holds before opening or loading the zip list', async () => {
    vi.spyOn(zippingService, 'setCurrentSession').mockResolvedValue(undefined)
    vi.spyOn(zippingService, 'getAllUnzipped').mockReturnValue([
      { zipId: 'zip-one', sessionId: 'chat-test', permanent: true, unzippedAt: 1, source: 'user' },
      { zipId: 'zip-two', sessionId: 'chat-test', permanent: true, unzippedAt: 1, source: 'agent' }
    ])
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    render(ZipsManagerDropdown, { props: { sessionId: 'chat-test' } })

    await waitFor(() => expect(screen.getByTestId('manage-zips-button')).toHaveTextContent('2'))
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/api/zips/list'))).toBe(false)
  })
})

// BL-1485 (SA-129 D1, DL-07): the open Zip Manager speaks one vocabulary. The header counts every
// hold as "held" (with or without a countdown), the filters say Expanded and Compressed, and no
// header, filter or button says unzipped, zipped as a state, or countdown.
describe('Zip Manager words (BL-1485)', () => {
  it('the header, the filters and the button say expanded, compressed and held', async () => {
    const holds = [
      { zipId: 'zip-held', sessionId: 'chat-words', permanent: true, unzippedAt: 1, source: 'user' as const },
      { zipId: 'zip-countdown', sessionId: 'chat-words', permanent: false, duration: 10, messageCount: 2, unzippedAt: 1, source: 'user' as const },
      { zipId: 'zip-agent', sessionId: 'chat-words', permanent: true, unzippedAt: 1, source: 'agent' as const, agentId: 'agent-x' }
    ]
    vi.spyOn(zippingService, 'setCurrentSession').mockResolvedValue(undefined)
    vi.spyOn(zippingService, 'ensureSessionLoaded').mockResolvedValue(undefined as any)
    vi.spyOn(zippingService, 'getAllUnzipped').mockReturnValue(holds)
    vi.spyOn(zippingService, 'getUnzippedInfo').mockImplementation((id: string) => holds.find((hold) => hold.zipId === id) ?? null)
    vi.spyOn(zippingService, 'isRezipped').mockReturnValue(false)
    vi.spyOn(zippingService, 'getRezippedSource').mockReturnValue(null as any)
    const zip = (id: string, at: number) => ({
      id, type: 'cool_tool', name: 'read_file', tokens: 40, description: `read_file: ${id}.ts - 3 lines`,
      createdAt: at, source: 'tool', sessionId: 'chat-words', metadata: { toolName: 'read_file', operationKind: 'read_file' }
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = String(input)
      if (url.includes('/api/zips/list')) {
        return new Response(JSON.stringify({ zips: [zip('zip-held', 1), zip('zip-countdown', 2), zip('zip-agent', 3), zip('zip-plain', 4)] }), { status: 200 })
      }
      if (url.includes('/api/zips/dead-copies')) return new Response(JSON.stringify({ deadCopies: {} }), { status: 200 })
      return new Response('{}', { status: 200 })
    })

    render(ZipsManagerDropdown, { props: { sessionId: 'chat-words' } })
    const trigger = screen.getByTestId('manage-zips-button')
    await fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })

    const stats = await screen.findByLabelText('Zip session stats', {}, { timeout: 5_000 })
    await waitFor(() => expect(stats.textContent?.replace(/\s+/g, ' ')).toContain('3 held'))
    expect(stats.textContent).not.toMatch(/countdown|unzipped/)
    expect(stats.textContent).toMatch(/\d+ expanded/)
    const filters = screen.getByRole('tablist', { name: 'Zip item filter' })
    expect(Array.from(filters.querySelectorAll('button span')).map((span) => span.textContent)).toEqual(['Expanded', 'Compressed', 'All'])
    expect(screen.queryByText('Zip all unzipped')).toBeNull()
  }, 20_000)
})

// SA-137 P4 (D9, D10): a Read File whose newest reply showed a file snapshot is judged at the
// snapshot's size, and its row says so, like the chat badge. A static copy changes nothing.
describe('Zip Manager rows with live file reads (SA-137 P4)', () => {
  const SNAPSHOT_LINE = 'Measured from the file as it was when the newest reply started (17,000 tokens); compressed, so its text was not sent'

  async function openManager(
    sessionId: string,
    copies: Record<string, unknown>,
    options: { strict?: boolean; holds?: Array<{ zipId: string; sessionId: string; permanent: boolean; unzippedAt: number; source: 'user' | 'agent' }> } = {}
  ) {
    const holds = options.holds ?? []
    vi.spyOn(zippingService, 'setCurrentSession').mockResolvedValue(undefined)
    vi.spyOn(zippingService, 'ensureSessionLoaded').mockResolvedValue(undefined as any)
    vi.spyOn(zippingService, 'getAllUnzipped').mockReturnValue(holds)
    vi.spyOn(zippingService, 'getUnzippedInfo').mockImplementation((id: string) => holds.find((hold) => hold.zipId === id) ?? null)
    vi.spyOn(zippingService, 'isRezipped').mockReturnValue(false)
    vi.spyOn(zippingService, 'getRezippedSource').mockReturnValue(null as any)
    // The newest reply of the chat owns both reads, so the buffer keeps a small stored copy open.
    messageStore.setMessagesForSession(sessionId, [
      { id: 'msg-reads', role: 'assistant', content: 'Read two files.', agent_id: 'agent-1', session_id: sessionId } as any
    ])
    const zips = ['zip-live', 'zip-plain'].map((id, index) => ({
      id, type: 'cool_tool', name: 'read_file', tokens: 40, description: `read_file: ${id}.ts - 3 lines`,
      createdAt: index + 1, source: 'tool', sessionId, messageId: 'msg-reads', metadata: { toolName: 'read_file', operationKind: 'read_file' }
    }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = String(input)
      if (url.includes('/api/zips/list')) return new Response(JSON.stringify({ zips }), { status: 200 })
      if (url.includes('/api/zips/dead-copies')) {
        return new Response(JSON.stringify({
          deadCopies: {},
          liveReads: { state: 'current', replyId: 'reply-1', agentId: 'agent-1', delivery: 'issued', at: '2026-10-22T10:00:00.000Z', copies, overflow: 0, ...(options.strict ? { strict: true } : {}) }
        }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    render(ZipsManagerDropdown, { props: { sessionId } })
    await fireEvent.pointerDown(screen.getByTestId('manage-zips-button'), { button: 0, pointerType: 'mouse' })
    await fireEvent.click(await screen.findByRole('tab', { name: /^All/ }, { timeout: 5_000 }))
  }

  const rowTitle = (zipId: string) =>
    document.querySelector(`[data-zip-id="${zipId}"] [aria-label="Zip controls"]`)?.getAttribute('title') ?? null

  it('judges a refreshed copy at the snapshot size (compressed by size, though the stored copy is small) and says so', async () => {
    await openManager('chat-live-reads', { 'zip-live': { status: 'refreshed', promptTokens: 17_000 } })

    await waitFor(() => expect(rowTitle('zip-live')).toBe(`Compressed. ${SNAPSHOT_LINE}`))
    // The row's own token label is still the stored size, and the other small stored copy stays open.
    expect(document.querySelector('[data-zip-id="zip-live"]')?.textContent).toContain('40 tokens')
    expect(rowTitle('zip-plain')).toMatch(/^Expanded/)
    expect(rowTitle('zip-plain')).not.toContain('File snapshot')
  }, 20_000)

  it('names the snapshot size for a refreshed copy that is too large for the prompt', async () => {
    await openManager('chat-big-reads', { 'zip-live': { status: 'refreshed', promptTokens: 30_000 } })

    await waitFor(() => expect(rowTitle('zip-live')).toMatch(/^Too large for the prompt \(about 30,000 tokens\)\. The agent reads it in parts\. Measured from the file/))
    expect(document.querySelector('[data-zip-id="zip-live"]')?.textContent).toContain('40 tokens')
  }, 20_000)

  it('changes nothing for a static copy', async () => {
    await openManager('chat-static-reads', { 'zip-live': { status: 'static', reason: 'file-unreadable' } })

    await waitFor(() => expect(document.querySelector('[data-zip-id="zip-live"]')).not.toBeNull())
    expect(rowTitle('zip-live')).toMatch(/^Expanded/)
    expect(rowTitle('zip-live')).not.toContain('File snapshot')
  }, 20_000)

  // Round 2 (strict freshness): the newest reply zipped a copy it did not refresh, whatever its
  // buffer or a hold says; the row draws compressed, keeps its hold (Release stays) and says why.
  describe('a copy the newest reply did not refresh (Round 2)', () => {
    const LINE = `Not shown to the agent in the newest reply: not refreshed (${describeNotRefreshedReason('not-readable')}). Batshit tries again at the next reply.`
    const notReadable = { 'zip-live': { status: 'static', reason: 'not-readable' } }

    it('draws a strict static copy compressed though the buffer keeps it open, and the other copy stays open', async () => {
      await openManager('chat-notref', notReadable, { strict: true })

      await waitFor(() => expect(rowTitle('zip-live')).toBe(`Compressed. ${LINE}`))
      expect(document.querySelector('[data-zip-id="zip-live"]')?.classList.contains('zipped')).toBe(true)
      expect(document.querySelector('[data-zip-id="zip-live"]')?.textContent).toContain('40 tokens')
      expect(rowTitle('zip-plain')).toMatch(/^Expanded/)
      expect(rowTitle('zip-plain')).not.toContain('Not shown to the agent')
    }, 20_000)

    it('a held copy stays compressed with its hold label, and Release is still offered', async () => {
      await openManager('chat-notref-held', notReadable, {
        strict: true,
        holds: [{ zipId: 'zip-live', sessionId: 'chat-notref-held', permanent: true, unzippedAt: 1, source: 'user' }]
      })

      await waitFor(() => expect(rowTitle('zip-live')).toBe(`Compressed. Held by you. ${LINE}`))
      expect(document.querySelector('[data-zip-id="zip-live"]')?.classList.contains('zipped')).toBe(true)
      await fireEvent.mouseEnter(document.querySelector('[data-zip-id="zip-live"] [aria-label="Zip controls"]') as HTMLElement)
      expect(await screen.findByRole('button', { name: 'Release' })).toBeTruthy()
      // S2: under the user's own Hold the row never offers a new Hold, which would replace it.
      expect(screen.queryByRole('button', { name: 'Hold for 10 messages' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Hold' })).toBeNull()
    }, 20_000)

    it('under an agent\'s Hold the user may still replace it: both Holds and Release are offered', async () => {
      await openManager('chat-notref-agent-held', notReadable, {
        strict: true,
        holds: [{ zipId: 'zip-live', sessionId: 'chat-notref-agent-held', permanent: true, unzippedAt: 1, source: 'agent', agentId: 'agent-x', path: '/tmp/live.ts' } as any]
      })

      await waitFor(() => expect(rowTitle('zip-live')).toMatch(/^Compressed\. Held by /))
      await fireEvent.mouseEnter(document.querySelector('[data-zip-id="zip-live"] [aria-label="Zip controls"]') as HTMLElement)
      expect(await screen.findByRole('button', { name: 'Release' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Hold for 10 messages' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Hold' })).toBeTruthy()
    }, 20_000)

    it('is listed under Compressed, not Expanded', async () => {
      await openManager('chat-notref-filter', notReadable, { strict: true })
      await waitFor(() => expect(rowTitle('zip-live')).toBe(`Compressed. ${LINE}`))

      await fireEvent.click(screen.getByRole('tab', { name: /^Compressed/ }))
      await waitFor(() => expect(document.querySelector('[data-zip-id="zip-live"]')).not.toBeNull())
      expect(document.querySelector('[data-zip-id="zip-plain"]')).toBeNull()
      await fireEvent.click(screen.getByRole('tab', { name: /^Expanded/ }))
      await waitFor(() => expect(document.querySelector('[data-zip-id="zip-plain"]')).not.toBeNull())
      expect(document.querySelector('[data-zip-id="zip-live"]')).toBeNull()
    }, 20_000)

    it('a static copy under a receipt that is not strict is unchanged: open, no line, held stays held', async () => {
      await openManager('chat-notstrict-held', notReadable, {
        holds: [{ zipId: 'zip-live', sessionId: 'chat-notstrict-held', permanent: true, unzippedAt: 1, source: 'user' }]
      })

      await waitFor(() => expect(document.querySelector('[data-zip-id="zip-live"]')).not.toBeNull())
      expect(rowTitle('zip-live')).toBe('Held by you')
      expect(document.querySelector('[data-zip-id="zip-live"]')?.classList.contains('zipped')).toBe(false)
    }, 20_000)
  })
})
