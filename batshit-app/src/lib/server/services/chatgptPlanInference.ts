import type { ModelConnectionInfo } from '$lib/types/savedModels'
import { chatgptPlanAccountId, isChatgptPlanConnection, CHATGPT_PLAN_PARAMETERS } from '$lib/utils/chatgptPlanConnection'
import { isAgentRuntimeSettingKey } from '$lib/utils/modelSettingsMapper'
import { getChatgptPlanRuntime } from './chatgptPlanHost'
import { ChatgptPlanError } from './chatgptPlanVault'
import type { PlanLease } from './chatgptPlanRuntime'

export function isPlanSelection(connection?: ModelConnectionInfo | null) { return connection?.service === 'chatgpt-plan' || isChatgptPlanConnection(connection?.id) }

export function chatgptPlanHttpStatus(error: unknown): number | null {
  if (!(error instanceof ChatgptPlanError)) return null
  if (error.code === 'usage_limit') return 429
  if (error.code === 'request_stopped') return 499
  if (error.code === 'upstream_unavailable') return 503
  if (['inference_failed', 'response_incomplete', 'catalog_invalid'].includes(error.code)) return 502
  return 409
}

/** Imported/restored presets get the same refusal as a newly saved preset. */
export function assertPlanSettings(settings?: Record<string, unknown> | null) {
  const unsupported = Object.entries(settings ?? {}).find(([key, value]) => value !== undefined && value !== null && value !== '' && !CHATGPT_PLAN_PARAMETERS.has(key) && !isAgentRuntimeSettingKey(key))
  if (unsupported) throw new ChatgptPlanError('setting_unsupported', `ChatGPT plan does not support ${unsupported[0]}. Clear that preset setting.`)
}

export function planModelForLease(lease: PlanLease | undefined, userId: string | null | undefined, connection: ModelConnectionInfo | null | undefined, modelId: string) {
  const accountId = chatgptPlanAccountId(connection?.id)
  if (!lease || !accountId || connection?.type !== 'direct' || connection.service !== 'chatgpt-plan' || lease.userId !== userId || lease.accountId !== accountId) throw new ChatgptPlanError('consumer_unsupported', 'This feature has no server-owned ChatGPT plan request. Choose an eligible API agent or Compact.')
  return getChatgptPlanRuntime().model(lease, modelId)
}

export function planProviderOptions(options?: Record<string, Record<string, any>>) {
  for (const [provider, values] of Object.entries(options ?? {})) {
    if (provider !== 'openai' && Object.keys(values ?? {}).length) throw new ChatgptPlanError('setting_unsupported', 'This ChatGPT preset contains settings for a different provider.')
    for (const key of Object.keys(values ?? {})) if (!CHATGPT_PLAN_PARAMETERS.has(key)) throw new ChatgptPlanError('setting_unsupported', `ChatGPT plan does not support ${key}. Clear that preset setting.`)
  }
  return { openai: { ...options?.openai, store: false, systemMessageMode: 'developer' } }
}

/** Serialization changes; tool names, execution identity, approvals and results do not. */
export function planClientTools(tools: Record<string, any> | undefined, lease: PlanLease) {
  if (!tools) return tools
  return Object.fromEntries(Object.entries(tools).map(([name, definition]) => {
    if (definition.type === 'provider') throw new ChatgptPlanError('tool_unsupported', 'OpenAI hosted tools are unavailable through this ChatGPT plan connection.')
    const execute = definition.execute
    return [name, { ...definition, providerOptions: { ...definition.providerOptions, openai: { ...definition.providerOptions?.openai, namespace: { name: 'batshit', description: 'Batshit client tools' } } },
      ...(execute ? { execute: async (input: unknown, options: any) => {
        getChatgptPlanRuntime().assertLease(lease)
        return execute(input, { ...options, abortSignal: options?.abortSignal ? AbortSignal.any([lease.signal, options.abortSignal]) : lease.signal })
      } } : {}) }]
  }))
}
