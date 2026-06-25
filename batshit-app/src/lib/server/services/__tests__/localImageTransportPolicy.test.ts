import { describe, expect, it } from 'vitest'
import {
  applyImageTransportOverrides,
  classifyLocalImageUrlRuntimeFailure,
  isLocalProviderId,
  rewriteLocalImageUrl
} from '../localImageTransportPolicy'

describe('localImageTransportPolicy', () => {
  describe('isLocalProviderId', () => {
    it('accepts known local provider ids', () => {
      expect(isLocalProviderId('ollama')).toBe(true)
      expect(isLocalProviderId('LMSTUDIO')).toBe(true)
      expect(isLocalProviderId('llama-cpp')).toBe(true)
    })

    it('rejects non-local provider ids', () => {
      expect(isLocalProviderId('openai')).toBe(false)
      expect(isLocalProviderId('anthropic')).toBe(false)
      expect(isLocalProviderId(null)).toBe(false)
    })
  })

  describe('rewriteLocalImageUrl', () => {
    it('rewrites localhost clip URLs to runtime-reachable image base URL', () => {
      const rewritten = rewriteLocalImageUrl(
        'http://localhost:5600/uploads/image.png?x=1#clip',
        'http://host.docker.internal:5600'
      )

      expect(rewritten).toBe('http://host.docker.internal:5600/uploads/image.png?x=1#clip')
    })

    it('keeps non-local non-upload URLs unchanged', () => {
      const original = 'https://example.com/assets/photo.png'
      expect(rewriteLocalImageUrl(original, 'http://host.docker.internal:5600')).toBe(original)
    })

    it('rewrites upload-path URLs even when host is not localhost', () => {
      const rewritten = rewriteLocalImageUrl(
        'http://10.0.0.22:5600/uploads/from-clip.jpg',
        'http://host.docker.internal:5600'
      )

      expect(rewritten).toBe('http://host.docker.internal:5600/uploads/from-clip.jpg')
    })
  })

  describe('classifyLocalImageUrlRuntimeFailure', () => {
    it('classifies local URL-not-supported errors with actionable guidance', () => {
      const result = classifyLocalImageUrlRuntimeFailure({
        providerId: 'ollama',
        connectionId: 'direct',
        errorMessage: 'image URLs are not currently supported, please use base64 encoded data instead'
      })

      expect(result?.code).toBe('local_image_url_unsupported')
      expect(result?.userMessage).toContain('automatic image transport')
    })

    it('classifies local runtime fetch failures as unreachable', () => {
      const result = classifyLocalImageUrlRuntimeFailure({
        providerId: 'dmr',
        errorMessage: 'error: cannot make GET request'
      })

      expect(result?.code).toBe('local_image_url_unreachable')
      expect(result?.userMessage).toContain('Image base URL')
    })

    it('uses connection hints when provider id is absent', () => {
      const result = classifyLocalImageUrlRuntimeFailure({
        connectionId: 'lmstudio-direct',
        errorMessage: "'url' field must be a base64 encoded image."
      })

      expect(result?.code).toBe('local_image_url_unsupported')
    })

    it('returns null for non-local providers', () => {
      const result = classifyLocalImageUrlRuntimeFailure({
        providerId: 'openai',
        errorMessage: 'image URLs are not currently supported'
      })

      expect(result).toBeNull()
    })
  })

  describe('applyImageTransportOverrides', () => {
    it('replaces clipped data URLs with local runtime URL and host rewrite', () => {
      const originalData = 'data:image/png;base64,AAAA'
      const result = applyImageTransportOverrides({
        transport: 'url',
        imageBaseUrl: 'http://host.docker.internal:5600',
        clippedItems: [
          {
            clipId: 'clip-1',
            contentType: 'image',
            content: originalData,
            url: 'http://localhost:5600/uploads/img.png'
          }
        ],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: originalData } }
            ]
          }
        ],
        images: [{ url: originalData }]
      })

      expect(result.messages[0].content[0].image_url.url).toBe(
        'http://host.docker.internal:5600/uploads/img.png'
      )
      expect(result.images[0].url).toBe('http://host.docker.internal:5600/uploads/img.png')
    })

    it('rewrites tunnel upload URLs to runtime base host for local execution', () => {
      const originalData = 'data:image/jpeg;base64,BBBB'
      const result = applyImageTransportOverrides({
        transport: 'url',
        imageBaseUrl: 'http://host.docker.internal:5600',
        clippedItems: [
          {
            clipId: 'clip-2',
            contentType: 'image',
            content: originalData,
            url: 'https://example-tunnel.ngrok.io/uploads/clip.jpg'
          }
        ],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', image: originalData }
            ]
          }
        ],
        images: [{ url: originalData }]
      })

      expect(result.messages[0].content[0].image).toBe(
        'http://host.docker.internal:5600/uploads/clip.jpg'
      )
      expect(result.images[0].url).toBe('http://host.docker.internal:5600/uploads/clip.jpg')
    })

    it('keeps payload unchanged in auto mode', () => {
      const messages = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }]
        }
      ]
      const images = [{ url: 'https://example.com/image.png' }]
      const result = applyImageTransportOverrides({
        transport: 'auto',
        imageBaseUrl: 'http://host.docker.internal:5600',
        clippedItems: [],
        messages,
        images
      })

      expect(result.messages).toBe(messages)
      expect(result.images).toBe(images)
    })

    it('prefers a remote tunnel URL in auto mode when requested', () => {
      const originalData = 'data:image/png;base64,CCCC'
      const result = applyImageTransportOverrides({
        transport: 'auto',
        preferRemoteUrl: true,
        clippedItems: [
          {
            clipId: 'clip-3',
            contentType: 'image',
            content: originalData,
            url: 'https://fresh-tunnel.example/uploads/img.png'
          }
        ],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: originalData } }
            ]
          }
        ],
        images: [{ url: originalData }]
      })

      expect(result.messages[0].content[0].image_url.url).toBe(
        'https://fresh-tunnel.example/uploads/img.png'
      )
      expect(result.images[0].url).toBe('https://fresh-tunnel.example/uploads/img.png')
    })

    it('does not prefer localhost URLs for remote model auto mode', () => {
      const originalData = 'data:image/png;base64,DDDD'
      const messages = [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: originalData } }
          ]
        }
      ]
      const images = [{ url: originalData }]

      const result = applyImageTransportOverrides({
        transport: 'auto',
        preferRemoteUrl: true,
        clippedItems: [
          {
            clipId: 'clip-4',
            contentType: 'image',
            content: originalData,
            url: 'http://localhost:5600/uploads/img.png'
          }
        ],
        messages,
        images
      })

      expect(result.messages).toBe(messages)
      expect(result.images).toBe(images)
    })
  })
})
