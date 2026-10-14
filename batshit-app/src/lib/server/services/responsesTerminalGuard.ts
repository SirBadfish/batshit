import type { LanguageModelV4 } from '@ai-sdk/provider'

/**
 * BL-1044: the installed Responses adapter emits a healthy finish on bare EOF.
 * Paid Responses may legitimately finish incomplete (an explicit output cap),
 * but they must have received a terminal event. Plan inference has its stricter
 * response.completed guard in the credential-owning runtime.
 */
export function guardResponsesTerminal(model: LanguageModelV4): LanguageModelV4 {
  if (model.provider !== 'openai.responses') return model
  return {
    specificationVersion: 'v4', provider: model.provider, modelId: model.modelId, supportedUrls: model.supportedUrls,
    doGenerate: options => model.doGenerate(options),
    doStream: async options => {
      const result = await model.doStream({ ...options, includeRawChunks: true })
      let terminal = false
      const requireTerminal = () => { if (!terminal) throw new Error('OpenAI ended without a terminal response event. Partial text was preserved; this reply did not complete.') }
      const stream = result.stream.pipeThrough(new TransformStream({
        transform(part, controller) {
          if (part.type === 'raw') {
            const type = (part.rawValue as { type?: string })?.type
            if (type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete') terminal = true
            if (!options.includeRawChunks) return
          }
          if (part.type === 'finish') requireTerminal()
          controller.enqueue(part)
        },
        flush: requireTerminal,
      }))
      return { ...result, stream }
    },
  }
}
