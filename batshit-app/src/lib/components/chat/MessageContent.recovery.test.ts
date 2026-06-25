import { render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MessageContent from './MessageContent.svelte'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('MessageContent recovery rendering', () => {
  it('settles a trusted missing clip reference without repeatedly refetching it', async () => {
    const clipId = 'clip_1779416324513_missing1'
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/session-clips/state/session_bad_clip') {
        return new Response(JSON.stringify({ clips: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === `/api/clips/${clipId}?userId=josh`) {
        return new Response(JSON.stringify({ error: 'Clip not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ error: `Unexpected URL: ${url}` }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const onClipsDetected = vi.fn()
    const content = `Attached: {{batshit-clip:${clipId}:::lost.png}}`
    const rendered = render(MessageContent, {
      content,
      role: 'user',
      sessionId: 'session_bad_clip',
      messageId: 'msg_bad_clip',
      messageIndex: 0,
      totalMessages: 1,
      metadata: { clipIds: [clipId] },
      onClipsDetected,
    })

    await waitFor(() => {
      expect(onClipsDetected).toHaveBeenCalledWith(
        expect.objectContaining({
          first: expect.arrayContaining([
            expect.objectContaining({
              clipId,
              filename: 'lost.png',
            }),
          ]),
        }),
      )
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(screen.getByText(/Attached:/)).toBeInTheDocument()
    expect(screen.getByText('lost.png')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('{{batshit-clip:')

    await rendered.rerender({
      content,
      role: 'user',
      sessionId: 'session_bad_clip',
      messageId: 'msg_bad_clip',
      messageIndex: 0,
      totalMessages: 1,
      metadata: { clipIds: [clipId] },
      onClipsDetected,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
