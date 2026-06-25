import { describe, expect, it } from 'vitest'
import { stripLeadingSubagentZipEcho } from '$lib/utils/subagentEchoSanitizer'

describe('subagentEchoSanitizer', () => {
  it('strips a repeated raw subagent token glued onto the start of the assistant reply', () => {
    const content =
      'ORBITSubagent returned ORBIT, so I am done.\n\n{{batshit-zip:cool_tool_1:::n8n_Subagent_v3 - 1 lines}}'

    expect(stripLeadingSubagentZipEcho(content)).toBe(
      'Subagent returned ORBIT, so I am done.\n\n{{batshit-zip:cool_tool_1:::n8n_Subagent_v3 - 1 lines}}'
    )
  })

  it('strips the leaked prefix for alternate assistant wording too', () => {
    const content =
      'ORBITDone-ORBIT received from the subagent.\n\n{{batshit-zip:cool_tool_1:::n8n_Subagent_v3 - 1 lines}}'

    expect(stripLeadingSubagentZipEcho(content)).toBe(
      'Done-ORBIT received from the subagent.\n\n{{batshit-zip:cool_tool_1:::n8n_Subagent_v3 - 1 lines}}'
    )
  })

  it('leaves ordinary content unchanged when there is no subagent zip reference', () => {
    expect(stripLeadingSubagentZipEcho('ORBITSubagent returned ORBIT, so I am done.')).toBe(
      'ORBITSubagent returned ORBIT, so I am done.'
    )
  })
})
