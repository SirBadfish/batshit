import { describe, expect, it } from 'vitest'

import {
  countTotalTokens,
  stringifyTokenCountableMessageContent
} from '$lib/utils/tokenCounter'

describe('tokenCounter multimodal content', () => {
  it('counts structured image data URLs as image inputs instead of base64 text', () => {
    const imageDataUrl = `data:image/png;base64,${'A'.repeat(500_000)}`
    const structuredContent = [
      { type: 'text', text: 'Can you see this image?' },
      { type: 'image_url', image_url: { url: imageDataUrl } }
    ]

    const tokens = countTotalTokens([{ role: 'user', content: structuredContent }])
    const printable = stringifyTokenCountableMessageContent(structuredContent)

    expect(tokens).toBeGreaterThan(765)
    expect(tokens).toBeLessThan(1_500)
    expect(printable).toContain('Structured image input')
    expect(printable).not.toContain(imageDataUrl)
  })

  it('still counts a plain-text data URL as text', () => {
    const imageDataUrl = `data:image/png;base64,${'A'.repeat(500_000)}`

    const tokens = countTotalTokens([{ role: 'user', content: imageDataUrl }])

    expect(tokens).toBeGreaterThan(100_000)
  })
})
