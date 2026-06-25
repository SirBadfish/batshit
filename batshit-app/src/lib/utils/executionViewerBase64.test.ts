import { describe, expect, it } from 'vitest'

import {
  truncateExecutionViewerBase64,
  truncateExecutionViewerBase64InValue
} from './executionViewerBase64'

const rawBase64 = `iVBORw0KGgo${'AbC123+/'.repeat(18)}`

describe('executionViewerBase64', () => {
  it('truncates long data URL base64 with an explicit marker', () => {
    const token = 'A'.repeat(140)
    const input = `image=data:image/png;base64,${token}`
    const result = truncateExecutionViewerBase64(input)

    expect(result).toBe(
      `image=data:image/png;base64,AAAAAAAAAAAAAAA... [base64 truncated, 140 chars]`
    )
  })

  it('truncates long raw base64-looking tokens', () => {
    const input = `payload:${rawBase64}:done`
    const result = truncateExecutionViewerBase64(input)

    expect(result).toContain(`${rawBase64.slice(0, 15)}... [base64 truncated`)
    expect(result).toContain(`${rawBase64.length} chars`)
    expect(result).not.toContain(rawBase64.slice(32))
  })

  it('can be disabled without changing the string', () => {
    const input = `payload:${rawBase64}:done`

    expect(truncateExecutionViewerBase64(input, { enabled: false })).toBe(input)
  })

  it('leaves short base64 data and ordinary long text alone', () => {
    const input = [
      'data:image/png;base64,AAAA',
      'abcdefghijklmnopqrstuvwxyz'.repeat(8),
      'abcdef0123456789'.repeat(8)
    ].join('\n')

    expect(truncateExecutionViewerBase64(input)).toBe(input)
  })

  it('truncates nested string values without mutating the original value', () => {
    const input = {
      messages: [
        {
          type: 'image',
          image_url: {
            url: `data:image/png;base64,${'B'.repeat(128)}`
          }
        }
      ],
      raw: rawBase64
    }

    const result = truncateExecutionViewerBase64InValue(input)

    expect(result).not.toBe(input)
    expect(result.messages).not.toBe(input.messages)
    expect(result.messages[0].image_url.url).toContain('[base64 truncated, 128 chars]')
    expect(result.raw).toContain('[base64 truncated')
    expect(input.messages[0].image_url.url).toBe(`data:image/png;base64,${'B'.repeat(128)}`)
    expect(input.raw).toBe(rawBase64)
  })
})
