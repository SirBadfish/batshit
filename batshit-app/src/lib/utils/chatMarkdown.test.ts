import { describe, expect, it } from 'vitest'
import { buildTranscriptMarkdown, renderMessageToMarkdown } from './chatMarkdown'

describe('chatMarkdown', () => {
  it('renders zips and clips into copyable markdown', async () => {
    const markdown = await renderMessageToMarkdown(
      {
        id: 'msg_1',
        role: 'assistant',
        content: [
          'Here is the snippet:',
          '{{batshit-zip:zip_terminal:::Terminal output}}',
          'And the screenshot:',
          '{{batshit-clip:clip_image:::chart.png}}',
          'And the attached notes:',
          '{{batshit-clip:clip_text:::notes.md}}'
        ].join('\n\n'),
        created_at: '2026-03-06T12:00:00.000Z',
        timestamp: '2026-03-06T12:00:00.000Z',
        agent_id: 'agent_1',
        metadata: {}
      },
      {
        resolveZip: async (zipId) =>
          zipId === 'zip_terminal'
            ? {
                id: zipId,
                type: 'terminal',
                content: 'echo batshit'
              }
            : null,
        resolveClip: async (clipId) => {
          if (clipId === 'clip_image') {
            return {
              id: clipId,
              filename: 'chart.png',
              mimeType: 'image/png',
              displayUrl: 'https://example.com/chart.png'
            }
          }

          if (clipId === 'clip_text') {
            return {
              id: clipId,
              filename: 'notes.md',
              mimeType: 'text/markdown',
              content: '# Notes\n\n- one\n- two'
            }
          }

          return null
        }
      }
    )

    expect(markdown).toContain('Here is the snippet:')
    expect(markdown).toContain('```text\necho batshit\n```')
    expect(markdown).toContain('![chart.png](<https://example.com/chart.png>)')
    expect(markdown).toContain('**Attached text: notes.md**')
    expect(markdown).toContain('```markdown\n# Notes')
  })

  it('builds a readable transcript with session metadata and speaker names', async () => {
    const transcript = await buildTranscriptMarkdown(
      {
        session: {
          id: 'session-123',
          name: 'Copy Test Chat'
        },
        messages: [
          {
            id: 'msg_user',
            role: 'user',
            content: 'Hello there',
            created_at: '2026-03-06T12:00:00.000Z',
            timestamp: '2026-03-06T12:00:00.000Z',
            metadata: {}
          },
          {
            id: 'msg_assistant',
            role: 'assistant',
            content: '```ts\nconst answer = 42\n```',
            created_at: '2026-03-06T12:01:00.000Z',
            timestamp: '2026-03-06T12:01:00.000Z',
            agent_id: 'agent_1',
            metadata: {}
          }
        ],
        agentsById: {
          agent_1: 'Raya'
        },
        userLabel: 'Josh'
      },
      {
        resolveZip: async () => null,
        resolveClip: async () => null
      }
    )

    expect(transcript).toContain('# Copy Test Chat')
    expect(transcript).toContain('Session ID: `session-123`')
    expect(transcript).toContain('## Josh')
    expect(transcript).toContain('## Raya')
    expect(transcript).toContain('Hello there')
    expect(transcript).toContain('```ts\nconst answer = 42\n```')
  })

  it('can omit detailed tool results while keeping a compact tool-call marker', async () => {
    const transcript = await buildTranscriptMarkdown(
      {
        session: {
          id: 'session-tools',
          name: 'Tool Summary Chat'
        },
        messages: [
          {
            id: 'msg_assistant',
            role: 'assistant',
            content: 'Ran a tool:\n\n{{batshit-zip:zip_tool:::Tool execution result}}',
            created_at: '2026-03-06T12:02:00.000Z',
            timestamp: '2026-03-06T12:02:00.000Z',
            agent_id: 'agent_1',
            metadata: {}
          }
        ],
        agentsById: {
          agent_1: 'Raya'
        },
        toolResultMode: 'summary'
      },
      {
        resolveZip: async (zipId) =>
          zipId === 'zip_tool'
            ? {
                id: zipId,
                type: 'cool_tool',
                content: JSON.stringify({
                  toolName: 'read_file',
                  toolResult: 'sensitive file contents'
                }),
                metadata: {
                  toolName: 'read_file'
                }
              }
            : null,
        resolveClip: async () => null
      }
    )

    expect(transcript).toContain('> Tool call: read_file (tool result omitted)')
    expect(transcript).not.toContain('sensitive file contents')
  })

  it('does not expose raw missing clip references in markdown', async () => {
    const markdown = await renderMessageToMarkdown(
      {
        id: 'msg_clip_missing',
        role: 'user',
        content: '{{batshit-clip:clip_1779416324513_missing1}}',
        created_at: '2026-03-06T12:03:00.000Z',
        timestamp: '2026-03-06T12:03:00.000Z',
        metadata: {}
      },
      {
        resolveZip: async () => null,
        resolveClip: async () => null
      }
    )

    expect(markdown).toContain('[clip reference omitted]')
    expect(markdown).not.toContain('{{batshit-clip:')
  })
})
