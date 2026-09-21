import { describe, expect, it } from 'vitest'
import { stripLeadingSubagentEchoText } from '$lib/server/services/finalAssistantTextSanitizer'
import { normalizeToolArgs } from '$lib/server/services/sseToolNormalization'

describe('finalAssistantTextSanitizer', () => {
  it('strips a raw subagent output prefix when it is glued onto the assistant reply', () => {
    const sanitized = stripLeadingSubagentEchoText('ORBITSubagent returned ORBIT, so I am done.', [
      {
        toolName: 'n8n_Subagent_v3',
        toolArgs: {
          Prompt__User_Message_: 'Reply with only the single word ORBIT.'
        },
        toolResult: [{ output: 'ORBIT' }]
      }
    ])

    expect(sanitized).toBe('Subagent returned ORBIT, so I am done.')
  })

  it('does not strip when the assistant reply already has a normal delimiter after the echoed word', () => {
    const sanitized = stripLeadingSubagentEchoText('ORBIT is the returned word.', [
      {
        toolName: 'n8n_Subagent_v3',
        toolArgs: {
          Prompt__User_Message_: 'Reply with only the single word ORBIT.'
        },
        toolResult: [{ output: 'ORBIT' }]
      }
    ])

    expect(sanitized).toBe('ORBIT is the returned word.')
  })

  it('understands nested subagent result objects from normalized tool payloads', () => {
    const sanitized = stripLeadingSubagentEchoText('DONESubagent completed successfully.', [
      {
        toolName: 'call_subagent',
        toolProvider: 'subagent',
        toolResult: {
          output: [{ value: { output: 'DONE' } }]
        }
      }
    ])

    expect(sanitized).toBe('Subagent completed successfully.')
  })

  // Bug sweep (2026-09-18): send-routed hands this its steps with their arguments normalized, and a
  // tool's own `prompt` argument once became n8n's Subagent field there, so a WebFetch whose short
  // answer began the reply had those letters cut from the reply.
  it("never cuts a reply after a tool that only took a `prompt` of its own", () => {
    const sanitized = stripLeadingSubagentEchoText('OKay, the page lists the price.', [
      {
        toolName: 'WebFetch',
        toolProvider: 'claude',
        toolArgs: normalizeToolArgs({ url: 'https://www.example.com/listing', prompt: 'Is the page up? Say OK.' }),
        toolResult: { code: 200, codeText: 'OK', result: 'OK', url: 'https://www.example.com/listing' }
      }
    ])

    expect(sanitized).toBe('OKay, the page lists the price.')
  })
})
