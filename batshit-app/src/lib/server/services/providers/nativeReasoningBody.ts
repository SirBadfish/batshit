import type { LanguageModelV4 } from '@ai-sdk/provider'
import { reviewedReasoningBinding } from '$lib/data/reasoning-controls'
import { ModelReasoningSettingError } from '$lib/utils/modelReasoningControls'

type Service = 'mimo' | 'qwencloud'
type ModelFactory = (fetch?: typeof globalThis.fetch) => LanguageModelV4
function fail(detail: string): never { throw new ModelReasoningSettingError(`${detail} The reasoning choice was not sent; check the model preset.`) }
const object = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value))

/** Only new typed controls create this internal marker. Legacy custom SDK options are unchanged. */
function nativeField(service: Service, modelId: string, providerOptions: Record<string, any> | undefined) {
  const marker = providerOptions?.batshit_reasoning
  if (marker === undefined) return null
  const key = service === 'mimo' ? 'mimoThinking' : 'qwenEffort'
  if (!object(marker) || Object.keys(marker).some(name => name !== key)) fail('The native reasoning control belongs to another connection or is invalid.')
  if (marker[key] === undefined) return null
  const binding = reviewedReasoningBinding({ modelId, connection: { type: 'direct', id: `direct:${service}`, service } })
  if (!binding) fail('Native reasoning controls are not verified for this exact model and installed adapter.')
  const value = marker[key]
  if (service === 'mimo') {
    if (typeof value !== 'boolean') fail('MiMo Thinking must be On or Off.')
    return { key: 'thinking' as const, value: value ? 'enabled' : 'disabled' }
  }
  if (typeof value !== 'string' || !['low', 'high', 'max'].includes(value)) fail('GLM reasoning effort must be Low, High or Max.')
  return { key: 'reasoning_effort' as const, value }
}

/**
 * Finite per-call composition for direct MiMo and Qwen Cloud. The installed SDK still owns
 * serialization, tools, headers, abort and response parsing. No marker means the old path.
 * MiMo's factory composes its existing carry fetch BEFORE this final native-body fetch.
 */
export function nativeReasoningChatModel(service: Service, modelId: string, createModel: ModelFactory): LanguageModelV4 {
  const base = createModel()
  const call = (providerOptions: Record<string, any> | undefined) => {
    const field = nativeField(service, modelId, providerOptions)
    if (!field) return { model: base, required: false, sent: () => undefined }
    let sent: Record<string, any> | undefined
    const fetch: typeof globalThis.fetch = async (input, init) => {
      let body: unknown
      try { body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined } catch { fail('The SDK request body is not valid JSON.') }
      if (!object(body) || body.model !== modelId || !Array.isArray(body.messages) || init?.method !== 'POST') {
        fail('The SDK request cannot safely accept the selected reasoning control.')
      }
      let next: Record<string, any>
      if (field.key === 'thinking') {
        if (body.thinking !== undefined && (!object(body.thinking) || body.thinking.type !== undefined && body.thinking.type !== field.value)) fail('The serialized Thinking field conflicts with the selected choice.')
        next = { ...body, thinking: { ...body.thinking, type: field.value } }
      } else {
        if (body.reasoning_effort !== undefined && body.reasoning_effort !== field.value) fail('The serialized effort field conflicts with the selected choice.')
        next = { ...body, reasoning_effort: field.value }
      }
      sent = next
      return globalThis.fetch(input, { ...init, body: JSON.stringify(next) })
    }
    return { model: createModel(fetch), required: true, sent: () => sent }
  }
  const evidence = <T extends { request?: { body?: unknown } }>(result: T, sent: unknown): T => {
    if (sent === undefined) fail('The SDK did not compose a native reasoning request.')
    return { ...result, request: { ...result.request, body: sent } }
  }
  return {
    specificationVersion: 'v4', provider: base.provider, modelId: base.modelId, supportedUrls: base.supportedUrls,
    doGenerate: async options => {
      const active = call(options.providerOptions)
      const result = await active.model.doGenerate(options)
      return !active.required ? result : evidence(result, active.sent())
    },
    doStream: async options => {
      const active = call(options.providerOptions)
      const result = await active.model.doStream(options)
      return !active.required ? result : evidence(result, active.sent())
    }
  }
}
