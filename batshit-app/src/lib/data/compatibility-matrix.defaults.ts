import type { CompatibilityMatrixEntry } from '$lib/types/compatibilityMatrix'
import { getParameterSchema } from '$lib/data/parameter-schemas'

const COMMON_CHAT_PARAMETERS = [
  'temperature',
  'maxTokens',
  'topP',
  'topK',
  'presencePenalty',
  'frequencyPenalty',
  'stopSequences',
  'seed',
  'responseFormat'
]

function uniqueNames(names: string[]) {
  return Array.from(new Set(names.filter(Boolean)))
}

function allowForProvider(provider: string) {
  const schema = getParameterSchema(provider)
  return uniqueNames(schema.base.map((definition) => definition.name))
}

export const COMPATIBILITY_MATRIX_DEFAULT_ENTRIES: CompatibilityMatrixEntry[] = [
  {
    scope: { connection: 'openrouter' },
    allow: [...COMMON_CHAT_PARAMETERS]
  },
  {
    scope: { connection: 'vercel-gateway' },
    allow: [...COMMON_CHAT_PARAMETERS]
  },
  {
    scope: { connection: 'direct', provider: 'openai' },
    allow: allowForProvider('openai')
  },
  {
    scope: { connection: 'direct', provider: 'anthropic' },
    allow: allowForProvider('anthropic')
  },
  {
    scope: { connection: 'direct', provider: 'google' },
    allow: allowForProvider('google')
  }
]
