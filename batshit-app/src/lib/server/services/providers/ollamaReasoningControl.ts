import type { LanguageModelV4 } from '@ai-sdk/provider'
import ollamaPackage from 'ollama-ai-provider-v2/package.json'
import { ModelReasoningSettingError } from '$lib/utils/modelReasoningControls'

type Factory = (fetch?: typeof globalThis.fetch) => LanguageModelV4
const object = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
function refuse(): never { throw new ModelReasoningSettingError('The selected Ollama Thinking choice could not be applied safely. Refresh the control before sending; your saved choice was kept.') }

/** Call-local only. Explicit default omits think AFTER the existing sampler shim. */
export function withOllamaReasoningControl(modelId: string, connectionKey: string | null, createModel: Factory): LanguageModelV4 {
  const base = createModel()
  const call = (providerOptions: Record<string, any> | undefined) => {
    const namespace = providerOptions?.batshit_reasoning
    if (namespace === undefined) return { model: base, required: false, sent: () => undefined }
    if (!object(namespace) || Object.keys(namespace).some(key => key !== 'ollama')) refuse()
    const marker = namespace.ollama
    if (!object(marker) || !connectionKey || marker.connectionKey !== connectionKey || marker.modelId !== modelId ||
      ollamaPackage.version !== '4.0.1' || marker.adapterVersion !== ollamaPackage.version ||
      typeof marker.runtimeVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(marker.runtimeVersion) ||
      !['value', 'provider-default'].includes(marker.mode) || marker.mode === 'value' && typeof marker.value !== 'boolean') refuse()
    const mode = marker.mode, value = marker.value
    let sent: Record<string, any> | undefined
    const fetch: typeof globalThis.fetch = async (input, init) => {
      let body: unknown
      try { body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined } catch { refuse() }
      if (!object(body) || body.model !== modelId || !Array.isArray(body.messages) || init?.method !== 'POST' ||
        Object.hasOwn(body, 'batshit_reasoning') || Object.hasOwn(body, 'connectionKey')) refuse()
      if (mode === 'value' && body.think !== value) refuse()
      const next = { ...body }
      if (mode === 'provider-default') delete next.think
      sent = next
      return globalThis.fetch(input, { ...init, body: JSON.stringify(next) })
    }
    return { model: createModel(fetch), required: true, sent: () => sent }
  }
  const evidence = <T extends { request?: { body?: unknown } }>(result: T, sent: unknown): T => {
    if (sent === undefined) refuse()
    return { ...result, request: { ...result.request, body: sent } }
  }
  return {
    specificationVersion: 'v4', provider: base.provider, modelId: base.modelId, supportedUrls: base.supportedUrls,
    doGenerate: async options => { const active = call(options.providerOptions); const result = await active.model.doGenerate(options); return active.required ? evidence(result, active.sent()) : result },
    doStream: async options => { const active = call(options.providerOptions); const result = await active.model.doStream(options); return active.required ? evidence(result, active.sent()) : result }
  }
}
