import { describe, expect, it } from 'vitest'

import { normalizeToolArgs, parseJsonLike } from '../sseToolNormalization'

describe('sseToolNormalization', () => {
  it('parses nested JSON-looking strings without touching plain text', () => {
    expect(parseJsonLike('{"path":"/tmp/file.txt"}')).toEqual({ path: '/tmp/file.txt' })
    expect(parseJsonLike('"[1,2]"')).toEqual([1, 2])
    expect(parseJsonLike('not json')).toBe('not json')
  })

  it('normalizes SSE subagent args and send-routed prompt args through one helper', () => {
    const normalized = normalizeToolArgs({
      toolInput: {
        file_path: '/workspace/demo.txt',
        subagent: {
          id: 'researcher',
          displayName: 'Researcher'
        },
        chatInput: JSON.stringify({
          messages: [{ content: [{ text: 'Find the launch notes' }] }]
        })
      }
    })

    expect(normalized.filePath).toBe('/workspace/demo.txt')
    expect(normalized.subagentId).toBe('researcher')
    expect(normalized.subagentName).toBe('Researcher')
    expect(normalized.Prompt__User_Message_).toBe('Find the launch notes')
  })

  // Bug sweep (2026-09-18): `Prompt__User_Message_` is n8n's Subagent message field, and every reader
  // (the zip step, the source detector, the reply sanitizer, the client hydration and renderer) takes
  // it for a subagent call. A tool's own `prompt` argument is not that: inventing the field from it
  // filed Claude Code's WebFetch, CronCreate, and Agent helper (real inputs below) as Subagent cards.
  it.each([
    ['WebFetch', { url: 'https://www.example.com/listing', prompt: 'Return the address and the price.' }],
    ['CronCreate', { cron: '*/15 * * * *', recurring: true, prompt: 'Run one polling cycle.' }],
    ['Agent', { description: 'Find the tests', subagent_type: 'Explore', prompt: 'Find every test file.' }]
  ])("never invents a subagent message from %s's own prompt", (_tool, input) => {
    const normalized = normalizeToolArgs(input)

    expect(normalized).toEqual(input)
    expect(normalized).not.toHaveProperty('Prompt__User_Message_')
  })

  it("keeps a subagent's own message: its chatInput, or n8n's field as sent", () => {
    // The API lane's and the CLI bridge's subagent tools both take `{ chatInput, thread }`.
    expect(normalizeToolArgs({ chatInput: 'Summarize the notes', thread: 'fresh' }).Prompt__User_Message_).toBe(
      'Summarize the notes'
    )
    expect(normalizeToolArgs({ Prompt__User_Message_: 'Check the workspace.' })).toEqual({
      Prompt__User_Message_: 'Check the workspace.'
    })
  })
})
