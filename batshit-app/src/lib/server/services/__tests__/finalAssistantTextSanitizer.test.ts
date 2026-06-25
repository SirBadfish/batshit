import { describe, expect, it } from 'vitest'
import { stripLeadingSubagentEchoText } from '$lib/server/services/finalAssistantTextSanitizer'

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
})
