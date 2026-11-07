import { render, screen } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'

// BL-696: how often the page reads a streaming reply for control blocks. Every read is counted
// through the registry's one scanner.
const scans: Array<{ final: boolean; text: string }> = []
vi.mock('$lib/utils/controlTags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/controlTags')>()
  return {
    ...actual,
    findControlBlocks: (text: string, options: { final: boolean }) => {
      scans.push({ final: options.final, text })
      return actual.findControlBlocks(text, options)
    }
  }
})

import MessageContent from './MessageContent.svelte'

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
const props = { role: 'assistant', sessionId: 's1', messageId: 'm1', messageIndex: 0, totalMessages: 1, metadata: {} }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MessageContent: one control scan per streamed chunk (BL-696)', () => {
  it('reads each chunk of a streaming reply once, and still shows the mention and hides the block', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })))
    const base =
      'Hello there. The <batshit-memory> tag is named here. <batshit-tool-notes>{"notes":[]}</batshit-tool-notes> More words'
    const rendered = render(MessageContent, { ...props, isStreaming: true, content: base })
    await settle()
    for (let chunk = 1; chunk <= 3; chunk += 1) {
      scans.length = 0
      await rendered.rerender({ ...props, isStreaming: true, content: `${base} chunk${chunk}` })
      await settle()
      expect(scans).toHaveLength(1)
      expect(scans[0].final).toBe(false)
    }
    const text = document.body.textContent ?? ''
    expect(text).toContain('The <batshit-memory> tag is named here.')
    expect(text).toContain('More words chunk3')
    expect(text).not.toContain('batshit-tool-notes')
  })

  it('still reads a finished reply for its cue note and its blocks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })))
    render(MessageContent, {
      ...props,
      isStreaming: false,
      content: '<batshit-cue>{"goon_mood":"happy"}</batshit-cue> Hi. <batshit-memory>{"content":"x"}</batshit-memory>'
    })
    await settle()
    expect(screen.getByText('Mood: happy')).toBeInTheDocument()
    const text = document.body.textContent ?? ''
    expect(text).toContain('Hi.')
    expect(text).not.toContain('batshit-memory')
  })
})
