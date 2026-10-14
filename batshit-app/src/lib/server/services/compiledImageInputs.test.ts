import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { collectCompiledImageInputs } from './compiledImageInputs'

const PNG = 'data:image/png;base64,AAAA'
const PDF_URL = 'https://tunnel.example.com/uploads/documents/spec.pdf'
const VIDEO_URL = 'http://localhost:5600/uploads/videos/clip.mp4'

/**
 * BL-504: every attached Clip whose content or URL started with `http` or `data:` counted as an
 * image, so a PDF, video, or document Clip (which carries its URL as content) made a text-only
 * model refuse the send and handed a vision model a PDF URL as an image part. The compile path is
 * proven on real compiler output in compile contract S5b; this pins the rule's edges.
 */
describe('BL-504: only image Clips and compiled image parts are image inputs', () => {
  it('skips a PDF, video, document, or text Clip whatever its content looks like', () => {
    expect(
      collectCompiledImageInputs({
        clippedItems: [
          { clipId: 'a', contentType: 'document', content: PDF_URL, url: PDF_URL },
          { clipId: 'b', contentType: 'video', content: VIDEO_URL, url: VIDEO_URL },
          { clipId: 'c', contentType: 'file', content: PDF_URL },
          { clipId: 'd', contentType: 'text', content: 'data:text/plain,hi' }
        ],
        messages: []
      })
    ).toEqual([])
  })

  it('counts an image Clip (content, else its url) and every compiled image part, once each', () => {
    expect(
      collectCompiledImageInputs({
        clippedItems: [
          { clipId: 'img', contentType: 'image', content: PNG },
          { clipId: 'img-url', contentType: 'image', content: '', url: 'https://example.com/a.png' },
          { clipId: 'pdf', contentType: 'document', content: PDF_URL }
        ],
        messages: [
          { role: 'system', content: 'plain' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hi' },
              { type: 'image_url', image_url: { url: PNG } },
              { type: 'image', image: 'https://example.com/memory.png' }
            ]
          }
        ]
      })
    ).toEqual([{ url: PNG }, { url: 'https://example.com/a.png' }, { url: 'https://example.com/memory.png' }])
  })

  it('reads nothing from an absent compile', () => {
    expect(collectCompiledImageInputs(undefined)).toEqual([])
  })

  it('send-routed collects its image inputs through this rule', () => {
    const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')
    expect(source).toContain(
      '\n  const collectImages = () =>\n    collectCompiledImageInputs(formattedInput?.structuredInput)\n'
    )
  })
})
