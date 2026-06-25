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
})
