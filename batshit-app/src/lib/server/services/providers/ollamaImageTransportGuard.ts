import { wrapLanguageModel } from 'ai'
import type { LanguageModelV4 } from '@ai-sdk/provider'

/**
 * Ollama's native REST API accepts base64 image data, not HTTP URLs. The installed
 * provider advertises URL support to the SDK but either serializes the URL into
 * images[] or rejects an image whose MIME type is unknown before fetch. Refuse
 * this known unsupported transport before either converter path, with actionable
 * guidance. Keep supportedUrls unchanged: emptying it would silently make the SDK
 * download a Force URL input instead. Automatic image bytes and Stop pass through.
 */
export function withOllamaImageTransportGuard(model: LanguageModelV4): LanguageModelV4 {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      transformParams: async ({ params }) => {
        for (const message of params.prompt) {
          if (message.role !== 'user') continue
          for (const part of message.content) {
            if (
              part.type === 'file' &&
              (part.mediaType === 'image' || part.mediaType.startsWith('image/')) &&
              part.data.type === 'url' &&
              /^https?:$/i.test(part.data.url.protocol)
            ) {
              throw new Error(
                'Ollama image URLs are not currently supported by the native chat API. ' +
                'Select Automatic image transport in the model preset or Settings → Local AI → Ollama.'
              )
            }
          }
        }
        return params
      }
    }
  })
}
