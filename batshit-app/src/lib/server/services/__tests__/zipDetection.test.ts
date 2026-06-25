import { describe, expect, it } from 'vitest'
import { ZipDetectionService } from '$lib/server/services/zipDetection'

describe('zipDetection', () => {
  it('leaves XML-style code tags alone instead of creating code content zips', async () => {
    const service = new ZipDetectionService()
    const content = 'Before <code language="html">&lt;main&gt;Hi&lt;/main&gt;</code> after.'

    const result = await service.processChunk('session-code-ignored', 'message-code-ignored', content)

    expect(result.shouldStream).toBe(true)
    expect(result.content).toBe(content)
    expect(service.getMessageReferences('session-code-ignored', 'message-code-ignored')).toEqual([])
  })

  it('does not drop prose or wedge the buffer when an empty error block cannot create a zip', async () => {
    const service = new ZipDetectionService()

    const result = await service.processChunk(
      'session-empty-error',
      'message-empty-error',
      'Before <error></error> after.'
    )

    expect(result.shouldStream).toBe(true)
    expect(result.content).toBe('Before  after.')
    expect(service.getMessageReferences('session-empty-error', 'message-empty-error')).toEqual([])

    const next = await service.processChunk(
      'session-empty-error',
      'message-empty-error',
      ' Next chunk.'
    )

    expect(next).toEqual({
      shouldStream: true,
      content: ' Next chunk.'
    })
  })

  it('keeps the closing-chunk content when an open error block cannot create a zip', async () => {
    const service = new ZipDetectionService()

    const opening = await service.processChunk(
      'session-open-error',
      'message-open-error',
      'Before <error>'
    )
    expect(opening).toEqual({
      shouldStream: true,
      content: 'Before '
    })

    const closing = await service.processChunk(
      'session-open-error',
      'message-open-error',
      '</error> after.'
    )

    expect(closing).toEqual({
      shouldStream: true,
      content: ' after.'
    })
    expect(service.getMessageReferences('session-open-error', 'message-open-error')).toEqual([])
  })
})
