import { describe, expect, it } from 'vitest'
import { parseMessageContent } from './messageFormatter'
import { isOpenableFailedImageUrl, isUnsupportedImageScheme } from './imageUrlSafety'

const baseUrl = 'http://127.0.0.1:18947/chat'

describe('ImageRenderer URL safety', () => {
  it.each(['&#9;', '&#10;', '&#13;', '&#x09;', '&Tab;'])('rejects a script scheme after Cheerio decodes %s', (entity) => {
    const segments = parseMessageContent(
      `<image src="java${entity}script:document.body.textContent=1" alt="probe" />`,
      'assistant'
    )
    const src = segments.find((segment) => segment.type === 'image')?.src
    expect(src).toBeTruthy()
    expect(new URL(src!, baseUrl).protocol).toBe('javascript:')
    expect(isUnsupportedImageScheme(src, baseUrl)).toBe(true)
    expect(isOpenableFailedImageUrl(src, baseUrl)).toBe(false)
  })

  it.each([
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', '\tjavascript:alert(1)',
    'java\nscript:alert(1)', 'data:text/html,<script>alert(1)</script>',
    'file:///tmp/image.png', 'mailto:someone@example.com', 'http://[invalid'
  ])('does not open an unsafe or malformed URL: %s', (src) => {
    expect(isOpenableFailedImageUrl(src, baseUrl)).toBe(false)
  })

  it.each([
    'https://images.example.org/image.png', 'http://images.example.org/image.png',
    './image.png', '/uploads/images/image.png', '//images.example.org/image.png',
    'blob:http://127.0.0.1:18947/1234'
  ])('allows normal image-link navigation: %s', (src) => {
    expect(isUnsupportedImageScheme(src, baseUrl)).toBe(false)
    expect(isOpenableFailedImageUrl(src, baseUrl)).toBe(true)
  })

  it.each(['/Users/fixture/photo.png', '/tmp/photo.png', 'C:\\photo.png', '\\\\server\\share\\photo.png'])
    ('keeps local filesystem paths out of the image and link paths: %s', (src) => {
      expect(isUnsupportedImageScheme(src, baseUrl)).toBe(true)
      expect(isOpenableFailedImageUrl(src, baseUrl)).toBe(false)
    })

  it('keeps data-image display supported without offering a data-URL navigation link', () => {
    const src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
    expect(isUnsupportedImageScheme(src, baseUrl)).toBe(false)
    expect(isOpenableFailedImageUrl(src, baseUrl)).toBe(false)
  })
})
