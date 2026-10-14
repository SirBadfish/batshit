import type { SavedModel } from '$lib/types/savedModels'
import { chatgptPlanAccountId, CHATGPT_PLAN_PARAMETERS } from '$lib/utils/chatgptPlanConnection'
import { ChatgptPlanError } from './chatgptPlanVault'
import { getChatgptPlanRuntime } from './chatgptPlanHost'
import { PLAN_CATALOG } from './chatgptPlanRuntime'
import { sanitizeId } from '$lib/utils/idSanitizer'
import { withChatgptPlanPublishedMetadata } from '$lib/data/chatgpt-plan-published-metadata'

export async function normaliseChatgptPlanPreset(payload: SavedModel, userId: string): Promise<SavedModel> {
  const accountId = chatgptPlanAccountId(payload.connection?.id)
  if (!accountId || payload.connection?.type !== 'direct' || payload.connection.service !== 'chatgpt-plan') throw new ChatgptPlanError('connection_invalid', 'Choose the connected ChatGPT account again before saving.')
  if ((payload.purposeOverride && payload.purposeOverride !== 'chat') || (payload.purpose && payload.purpose !== 'chat')) throw new ChatgptPlanError('consumer_unsupported', 'ChatGPT plan presets support text agents and Compact.')
  const settings = payload.settings ?? {}
  const supplied = Object.keys(settings).find(key => !CHATGPT_PLAN_PARAMETERS.has(key) && settings[key] !== undefined && settings[key] !== null && settings[key] !== '')
  if (supplied) throw new ChatgptPlanError('setting_unsupported', `ChatGPT plan does not support ${supplied}. Clear that preset setting.`)
  const slug = payload.modelId?.trim()
  const runtime = getChatgptPlanRuntime(), lease = runtime.acquire(userId, accountId, PLAN_CATALOG)
  try {
    const entry = (await runtime.models(lease)).find(model => model.slug === slug)
    if (!entry) throw new ChatgptPlanError('model_unavailable', 'That model is not listed for this ChatGPT account. Refresh Models and choose it again.')
    const preset: SavedModel = { ...payload,
      id: payload.id?.trim() || sanitizeId(`${payload.modelName || slug}_${payload.connection.id}_${slug}`),
      modelName: payload.modelName?.trim() || entry.displayName, provider: 'openai', modelId: entry.slug, effectiveModelId: entry.slug,
      connection: { id: payload.connection.id, type: 'direct', service: 'chatgpt-plan', useDeveloperPrefix: false },
      catalogModelId: undefined, vercelSourceId: undefined, isVercelImport: false, purpose: 'chat', purposeOverride: undefined,
      pricing: {}, settings, voiceSession: undefined,
      contextWindow: typeof payload.contextWindow === 'number' && payload.contextWindow > 0 && Number.isFinite(payload.contextWindow) ? payload.contextWindow : undefined,
      compatibility: { provider: 'openai', batshit: true, n8n: false, label: 'batshit_only', note: 'Host-local ChatGPT plan; text agents and Compact only.' },
      capabilities: { ...payload.capabilities, streaming: true, tools: true, audio: false, image: false }, enrichment: undefined }
    delete preset.unavailableReason
    return withChatgptPlanPublishedMetadata(preset)
  } finally { lease.release() }
}
