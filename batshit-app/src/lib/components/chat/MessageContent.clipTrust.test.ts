import { render, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MessageContent from './MessageContent.svelte'
import { resetImageLoadConsentForTests } from '$lib/stores/imageLoadConsent.svelte'

// BL-474 review: a Clip is Batshit's own only for an address the server's Clip record gave.
// An address read from the message's own text (the old `{{batshit-clip|...}}` form) is classified
// like any other address, even when the server returned the record.
const OUTSIDE = 'https://pictures.example.org/from-text.png'

function stubServer(clipId: string, record: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('/api/session-clips/state/')) {
      return new Response(JSON.stringify({ clips: [{ clipId }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.startsWith(`/api/clips/${clipId}`)) {
      return new Response(JSON.stringify(record), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const outsideImages = () =>
  Array.from(document.querySelectorAll('img')).filter((img) => (img.getAttribute('src') || '').includes('pictures.example.org'))

beforeEach(() => resetImageLoadConsentForTests())
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('MessageContent Clip trust (BL-474)', () => {
  for (const role of ['assistant', 'user'] as const) {
    it(`does not trust an address from the message text when the record has none (${role})`, async () => {
      const clipId = 'clip_1790500000000_abcdef12_0'
      stubServer(clipId, { clipId, filename: 'from-text.png', mimeType: 'image/png' })
      const onClipsDetected = vi.fn()
      const content = `Look: {{batshit-clip:${clipId}:::from-text.png}}\n{{batshit-clip|id:${clipId}|displayUrl:${OUTSIDE}}}from-text.png{{/batshit-clip}}`
      render(MessageContent, {
        content,
        role,
        sessionId: 'session_clip_trust',
        messageId: `msg_clip_trust_${role}`,
        messageIndex: 0,
        totalMessages: 1,
        metadata: { clipIds: [clipId] },
        onClipsDetected
      })

      await waitFor(() => expect(onClipsDetected).toHaveBeenCalled())
      await new Promise((resolve) => setTimeout(resolve, 30))

      expect(outsideImages()).toHaveLength(0)
      expect(document.body.textContent).toContain('Picture from pictures.example.org')
    })
  }

  it('still draws a Clip picture whose address came from the record', async () => {
    const clipId = 'clip_1790500000001_abcdef12_0'
    const recordUrl = 'https://tunnel.example.net/uploads/images/record.png'
    stubServer(clipId, { clipId, filename: 'record.png', mimeType: 'image/png', displayUrl: recordUrl })
    const onClipsDetected = vi.fn()
    render(MessageContent, {
      content: `Look: {{batshit-clip:${clipId}:::record.png}}`,
      role: 'assistant',
      sessionId: 'session_clip_trust',
      messageId: 'msg_clip_record',
      messageIndex: 0,
      totalMessages: 1,
      metadata: { clipIds: [clipId] },
      onClipsDetected
    })

    await waitFor(() =>
      expect(Array.from(document.querySelectorAll('img')).some((img) => img.getAttribute('src') === recordUrl)).toBe(true)
    )
  })
})
