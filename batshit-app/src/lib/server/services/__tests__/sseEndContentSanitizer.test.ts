import { describe, expect, it } from 'vitest'
import { sanitizeAssistantContent } from '../sseEndContentSanitizer'
import { unclosedReferenceReplies } from '$lib/test-utils/unclosedReferenceReplies'

/**
 * The reply end's text sanitizer. Since BL-775 its output is the stored reply for EVERY reply (the
 * finalize saves the rebuild of the stream's record), watched or not, so it may only remove what
 * Batshit itself put in the text.
 *
 * Until BL-775 it also cut a reply that had tool artifacts at its first line starting `Tool:` or
 * `Intermediate steps:`, removed every line starting `AI:`, and removed a trailing JSON block with
 * a tool-looking key (`toolName`, `error`, ...). Those four cuts came in with SA-Code-02 (Oct 2025)
 * for the n8n Primary agent, whose LangChain output echoed its own trace after the answer. That
 * lane is retired (SA-106): no managed lane (API, Codex, Claude) writes such a trace, so every one
 * of those cuts could only take an agent's own words.
 */
describe('sanitizeAssistantContent', () => {
  const tool = true

  it('stores a reply with a line that starts `Tool:` whole', () => {
    const reply = 'I checked two things.\nTool: bash ran fine.\nThen I wrote the summary.'
    expect(sanitizeAssistantContent(reply, tool)).toBe(reply)
  })

  it('stores a reply with a line that starts `Intermediate steps:` whole', () => {
    const reply = 'The plan.\nIntermediate steps: read, edit, test.\nAll done.'
    expect(sanitizeAssistantContent(reply, tool)).toBe(reply)
  })

  it('keeps every line that starts `AI:`', () => {
    const reply = 'Transcript:\nUser: hi\nAI: hello\nUser: bye'
    expect(sanitizeAssistantContent(reply, tool)).toBe(reply)
  })

  it('keeps a trailing JSON example, whatever its keys', () => {
    const reply = 'The error looks like this:\n{"error":"not found","toolName":"read_file"}'
    expect(sanitizeAssistantContent(reply, tool)).toBe(reply)
  })

  it('still removes the loading placeholders Batshit put in, collapses blank lines, and trims', () => {
    expect(sanitizeAssistantContent('  Done.{{TOOL_LOADING_PLACEHOLDER:t1}}\n\n\n\nNext.  ', tool)).toBe('Done.\n\nNext.')
    expect(sanitizeAssistantContent('Done.\n\n\n\nNext.', false)).toBe('Done.\n\nNext.')
    expect(sanitizeAssistantContent('', tool)).toBe('')
  })

  it('reads a reply of openers that never close in one scan (BL-707)', () => {
    for (const text of Object.values(unclosedReferenceReplies('toolLoadingPlaceholder'))) {
      const started = performance.now()
      sanitizeAssistantContent(text, tool)
      expect(performance.now() - started).toBeLessThan(500)
    }
  })
})
