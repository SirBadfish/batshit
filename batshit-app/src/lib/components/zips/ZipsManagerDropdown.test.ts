import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { zippingService } from '$lib/services/zipping'
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
