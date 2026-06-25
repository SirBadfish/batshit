import type { ModelCompatibility, ModelCompatibilityLabel } from '$lib/types/savedModels'

const N8N_SUPPORTED_PROVIDERS = new Set([
  'anthropic',
  'openai',
  'google',
  'mistral',
  'groq',
  'openrouter',
  'xai',
  'deepseek',
  'perplexity',
  'meta',
  'meta-llama',
  'amazon',
  'alibaba',
  'cohere',
  'ollama'
])
export const N8N_ONLY_PROVIDER_IDS = new Set<string>([
  'azure-openai',
  'aws-bedrock',
  'google-vertex',
  'huggingface'
])
export const BATSHIT_RESTRICTED_PROVIDER_IDS = new Set<string>([
  'azure-openai',
  'aws-bedrock',
  'google-vertex',
  'huggingface'
])

function toLabel(n8n: boolean, batshit: boolean): ModelCompatibilityLabel {
  if (n8n && batshit) return 'both'
  if (n8n) return 'n8n_only'
  return 'batshit_only'
}

/**
 * Determine whether a provider can be used by n8n workflows, Batshit direct mode, or both.
 * Story 7.2 requires surfacing this to the UI so agent settings can filter correctly.
 */
export function determineModelCompatibility(provider?: string | null): ModelCompatibility {
  const normalized = provider?.toLowerCase().trim() || 'unknown'
  if (normalized.startsWith('custom_')) {
    return {
      provider: normalized,
      n8n: false,
      batshit: true,
      label: 'batshit_only',
      note: 'Custom providers run only in Batshit direct mode'
    }
  }
  const n8nSupported =
    N8N_SUPPORTED_PROVIDERS.has(normalized) || N8N_ONLY_PROVIDER_IDS.has(normalized)
  const batshitSupported = !BATSHIT_RESTRICTED_PROVIDER_IDS.has(normalized)

  let note: string | undefined
  if (!batshitSupported) {
    note = 'Provider disabled for Batshit direct agents'
  } else if (!n8nSupported) {
    note = 'Available only for Batshit direct mode (no n8n webhook support yet)'
  }

  return {
    provider: normalized,
    n8n: n8nSupported,
    batshit: batshitSupported,
    label: toLabel(n8nSupported, batshitSupported),
    note
  }
}

export function isN8NSupported(provider?: string | null): boolean {
  const normalized = provider?.toLowerCase().trim() || 'unknown'
  if (normalized.startsWith('custom_')) return false
  return N8N_SUPPORTED_PROVIDERS.has(normalized) || N8N_ONLY_PROVIDER_IDS.has(normalized)
}
