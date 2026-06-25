import { describe, expect, it } from 'vitest'
import { selectFinishZipInput } from '$lib/server/services/managedStreamFinalization'

describe('managed stream finalization', () => {
  it('lets SSE-owned streamed content keep ownership of XML error zipping', () => {
    const result = selectFinishZipInput({
      streamedMessageContent: 'It failed:\n\n<error>boom</error>',
      sanitizedFinishText: 'It failed:\n\n<error>boom</error>',
      forwardedToActiveSse: true
    })

    expect(result).toEqual({
      content: 'It failed:\n\n<error>boom</error>',
      processXmlZips: false
    })
  })

  it('still zips finish-only XML when no active SSE stream saw chunks', () => {
    const result = selectFinishZipInput({
      streamedMessageContent: '',
      sanitizedFinishText: 'Output:\n\n<error>boom</error>',
      forwardedToActiveSse: true
    })

    expect(result).toEqual({
      content: 'Output:\n\n<error>boom</error>',
      processXmlZips: true
    })
  })

  it('still zips streamed XML when the SSE forward had no active browser', () => {
    const result = selectFinishZipInput({
      streamedMessageContent: 'Output:\n\n<error>boom</error>',
      sanitizedFinishText: '',
      forwardedToActiveSse: false
    })

    expect(result).toEqual({
      content: 'Output:\n\n<error>boom</error>',
      processXmlZips: true
    })
  })
})
