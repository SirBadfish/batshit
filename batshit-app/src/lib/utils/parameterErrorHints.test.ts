import { describe, expect, it } from 'vitest'

import { parseParameterError } from './parameterErrorHints'

describe('parseParameterError', () => {
  it('ignores generic n8n connection and workflow failures', () => {
    expect(parseParameterError('n8n is not running or connected.')).toBeNull()
    expect(parseParameterError('Webhook failed: 503')).toBeNull()
    expect(parseParameterError('Service unavailable - try again later')).toBeNull()
  })

  it('parses explicit provider parameter failures', () => {
    expect(parseParameterError('Unsupported parameter: temperature')).toMatchObject({
      parameter: 'temperature'
    })

    expect(parseParameterError('This parameter was rejected for openai (gpt-5.5).')).toEqual({
      message: 'This parameter was rejected for openai (gpt-5.5).',
      parameter: undefined,
      constraint: undefined
    })
  })
})
