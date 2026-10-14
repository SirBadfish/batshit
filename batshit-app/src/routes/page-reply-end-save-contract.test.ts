import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * BL-775, BL-776: the server owns an agent's reply. send-routed's finalize saves the reply from
 * the stream's record and only then publishes `end` with the saved bytes; `POST /api/messages`
 * refuses an assistant record from a tab. So the chat page's reply-end handlers (`end`,
 * `complete`, the Stop fallback, `complete_message`) only change what the tab shows. These pins
 * say so where it matters. Each pin is a whole line, with its indentation, so a prefix such as
 * `false && ` or a commented-out copy breaks it.
 */
const page = readFileSync('src/routes/+page.svelte', 'utf8')
const pageLines = page.split('\n')

function lineIndex(exact: string, from = 0): number {
  for (let index = from; index < pageLines.length; index += 1) {
    if (pageLines[index] === exact) return index
  }
  return -1
}

function sliceOf(startLine: string, endLine: string): { start: number; end: number; body: string } {
  const start = lineIndex(startLine)
  expect(start, `missing line: ${JSON.stringify(startLine)}`).toBeGreaterThan(-1)
  const end = lineIndex(endLine, start + 1)
  expect(end, `missing line: ${JSON.stringify(endLine)}`).toBeGreaterThan(start)
  return { start, end, body: pageLines.slice(start, end).join('\n') }
}

const stopFallback = () =>
  sliceOf(
    '  async function finalizeActiveAssistantMessageAsInterrupted(messageId: string | null) {',
    '  function resolveToolKey(data: any, messageId?: string | null) {'
  )
const endHandler = () => sliceOf("    } else if (data.type === 'end') {", "    } else if (data.type === 'complete') {")
const completeHandler = () =>
  sliceOf("    } else if (data.type === 'complete') {", "    } else if (data.type === 'stream_complete') {")

function expectLineWithin(range: { start: number; end: number }, exact: string) {
  const at = lineIndex(exact, range.start)
  expect(at, `missing line: ${JSON.stringify(exact)}`).toBeGreaterThan(-1)
  expect(at, `line outside its block: ${JSON.stringify(exact)}`).toBeLessThan(range.end)
  return at
}

describe('BL-775: the chat page saves no agent reply', () => {
  it('saves only the user’s own messages, at the two send sites', () => {
    const saves = [...page.matchAll(/\.saveMessage\(([A-Za-z]+)/g)].map((match) => match[1])
    expect(saves).toEqual(['userMessage', 'userMessage'])
    expect(page).not.toContain('saveMessageToDatabase')
  })

  it('shows end exactly as the server saved it, with none of the old edits', () => {
    const range = endHandler()
    expectLineWithin(range, "      const finalContent = typeof data.content === 'string' ? data.content : ''")
    expect(range.body).not.toContain('replaceCoolToolMarkersWithZipRefs')
    expect(range.body).not.toContain('sanitizeMessageContent')
    expect(range.body).not.toContain('metadata.zipIds =')
    expect(range.body).not.toContain('saveMessage')
  })

  it('draws the Stop fallback copy without saving it, and still takes a late end on screen (BL-361)', () => {
    const range = stopFallback()
    expectLineWithin(range, '      content: buildStopFallbackContent(existing.content),')
    expectLineWithin(range, '    savedByStopFallbackMessageIds.add(messageId)')
    expect(range.body).not.toContain('saveMessage')
    const end = endHandler()
    expectLineWithin(end, '      const lateEndAfterStopFallback = shouldAcceptLateEndAfterStopFallback({')
    expectLineWithin(end, '      const forceSpeak = !lateEndAfterStopFallback && isSpeechRequested(metadata)')
  })

  it('still waits 1.5 s for end before the Stop fallback', () => {
    expect(lineIndex('\t      await waitForStreamCompletion(previousMessageId, 1500)')).toBeGreaterThan(-1)
  })

  it('hides a copy’s control blocks at complete and saves nothing', () => {
    const range = completeHandler()
    expectLineWithin(range, '              content: stripUnfinalizedReplyControl(currentMessage.content)')
    expect(range.body).not.toContain('saveMessage')
  })

  it('shows a realtime voice reply the LiveKit route saved, and saves nothing', () => {
    const range = sliceOf("\t    } else if (data.type === 'complete_message' && data.message) {", "\t    } else if (data.type === 'start') {")
    expect(range.body).not.toContain('saveMessage')
  })

  it('keeps no dead writer: intermediate_message and the error finalize are gone', () => {
    expect(page).not.toContain("data.type === 'intermediate_message'")
    expect(page).not.toContain('finalizeActiveAssistantMessageAsError')
  })
})
