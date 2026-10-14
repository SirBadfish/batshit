import type { CatalogConnectionOption, CatalogModel } from '$lib/types/modelCatalog'
import { chatgptPlanConnectionId } from '$lib/utils/chatgptPlanConnection'
import { chatgptPlanAccounts, getChatgptPlanRuntime } from './chatgptPlanHost'
import { PLAN_CATALOG } from './chatgptPlanRuntime'
import { chatgptPlanPublishedMetadata } from '$lib/data/chatgpt-plan-published-metadata'

export function chatgptPlanConnectionOptions(userId: string): CatalogConnectionOption[] {
  return chatgptPlanAccounts(userId).map(account => ({
    id: chatgptPlanConnectionId(account.id), label: `ChatGPT Plan${account.email ? ` (${account.email})` : ''}`,
    transport: 'direct', service: 'chatgpt-plan', providers: ['openai'], status: account.state === 'ready' ? 'ready' : 'locked',
    lockedReason: account.state === 'ready' ? undefined : account.state === 'identity-only' ? 'Signed in, but ChatGPT plan use was not granted. Continue with ChatGPT in API Keys.' : 'Reconnect this ChatGPT account in Settings → API Keys.',
    description: 'ChatGPT plan text inference for API agents and Compact. Account-specific models; no paid API-key fallback.',
    n8nStatus: 'locked', n8nDescription: 'ChatGPT credentials remain in the Mac app and are unavailable to n8n.'
  }))
}
export async function chatgptPlanCatalogModels(userId: string): Promise<CatalogModel[]> {
  const accounts = chatgptPlanAccounts(userId).filter(account => account.state === 'ready')
  const models: CatalogModel[] = []
  for (const account of accounts) {
    const runtime = getChatgptPlanRuntime(), lease = runtime.acquire(userId, account.id, PLAN_CATALOG)
    try {
      const connectionId = chatgptPlanConnectionId(account.id)
      for (const model of await runtime.models(lease)) {
        const publishedMetadata = chatgptPlanPublishedMetadata(model.slug)
        models.push({
        id: `${connectionId}/${model.slug}`, canonicalId: `${connectionId}/${model.slug}`, provider: 'openai', name: model.slug,
        displayName: model.displayName, source: 'chatgpt-plan', transport: 'direct', purpose: 'chat', category: 'balanced',
        connectionId, availableConnections: [connectionId], publishedMetadata,
        features: { streaming: true, tools: true, ...(publishedMetadata ? { vision: publishedMetadata.inputModalities.includes('image') } : {}) },
        idVariants: { [connectionId]: { developerId: 'openai', modelId: model.slug, effectiveId: model.slug, source: 'direct', limits: { contextWindow: null, maxOutputTokens: null } } }
        })
      }
    } finally { lease.release() }
  }
  return models
}
