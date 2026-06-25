import type { ModelConnectionInfo } from '$lib/types/savedModels'
import type { CatalogConnectionOption, CatalogModelIdVariant } from '$lib/types/modelCatalog'
import {
  isCatalogVariantCompatibleForConnection,
  resolveConnectionServiceFromId
} from '$lib/utils/modelConnections'

export type ResolvedModelIds = {
  providerId: string
  developerId: string
  modelId: string
  effectiveModelId: string
}

type CatalogConnectionContext = Pick<
  CatalogConnectionOption,
  'id' | 'transport' | 'service' | 'providers'
>

function normalize(value?: string | null) {
  return value?.trim() ?? ''
}

function splitDeveloperModel(value: string): { developerId: string; modelId: string } | null {
  const trimmed = value.trim()
  if (!trimmed.includes('/')) return null
  const [developerId, ...rest] = trimmed.split('/')
  const modelId = rest.join('/').trim()
  if (!developerId.trim() || !modelId) return null
  return { developerId: developerId.trim(), modelId }
}

const DIRECT_OWNER_PREFIX_SERVICES = new Set([
  'fal',
  'replicate',
  'deepinfra',
  'togetherai',
  'fireworks',
  'baseten',
  'cerebras'
])
const LOCAL_PREFIX_SERVICES = new Set([
  'ollama',
  'dmr',
  'lmstudio',
  'llama-cpp',
  'vllm'
])
const N8N_DIRECT_PROVIDER_MAP: Record<string, string[]> = {
  'azure-openai': ['openai'],
  'aws-bedrock': ['anthropic', 'meta', 'meta-llama', 'mistral', 'cohere', 'ai21'],
  'google-vertex': ['google'],
  'direct:huggingface': ['huggingface']
}

function inferCatalogConnectionContext(
  connectionId: string
): CatalogConnectionContext | null {
  const normalized = connectionId.trim()
  if (!normalized) return null

  if (normalized === 'openrouter') {
    return {
      id: normalized,
      transport: 'openrouter',
      service: 'openrouter'
    }
  }

  if (normalized === 'vercel-gateway') {
    return {
      id: normalized,
      transport: 'vercel-gateway',
      service: 'vercel'
    }
  }

  if (normalized.startsWith('direct:')) {
    const service = resolveConnectionServiceFromId(normalized) ?? undefined
    return {
      id: normalized,
      transport: 'direct',
      service,
      providers: service ? [service] : undefined
    }
  }

  const mappedProviders = N8N_DIRECT_PROVIDER_MAP[normalized]
  return {
    id: normalized,
    transport: 'direct',
    service: normalized,
    providers: mappedProviders
  }
}

export function resolveModelIds({
  developerId: rawDeveloperId,
  modelId: rawModelId,
  connection
}: {
  developerId?: string | null
  modelId?: string | null
  connection?: ModelConnectionInfo | null
}): ResolvedModelIds | null {
  let developerId = normalize(rawDeveloperId)
  let modelId = normalize(rawModelId)

  if (!developerId && !modelId) return null

  const transport = connection?.type ?? null
  const service = normalize(connection?.service ?? null)
  const serviceLower = service.toLowerCase()
  const isFalDirect = transport === 'direct' && service.toLowerCase() === 'fal'

  if (isFalDirect) {
    if (developerId.toLowerCase() === 'fal-ai') {
      developerId = ''
    }
    if (modelId.toLowerCase().startsWith('fal-ai/')) {
      modelId = modelId.slice('fal-ai/'.length)
    }
  }

  const shouldParseDeveloperModel = !(
    transport === 'direct' &&
    ((serviceLower.startsWith('custom_') && !connection?.useDeveloperPrefix) ||
      (serviceLower === 'fal' && developerId && developerId.toLowerCase() !== serviceLower))
  )
  const parsed = shouldParseDeveloperModel && modelId ? splitDeveloperModel(modelId) : null
  if (parsed) {
    const isRouterTransport = transport === 'openrouter' || transport === 'vercel-gateway'
    const shouldOverrideDeveloper =
      !developerId ||
      (transport === 'direct' && serviceLower && developerId.toLowerCase() === serviceLower) ||
      (isRouterTransport && serviceLower && developerId.toLowerCase() === serviceLower)

    if (shouldOverrideDeveloper) {
      developerId = parsed.developerId
    }
    modelId = parsed.modelId
  }

  const providerId =
    transport === 'openrouter'
      ? 'openrouter'
      : transport === 'vercel-gateway'
        ? 'vercel-gateway'
        : transport === 'direct'
          ? service || developerId
          : developerId

  if (!developerId || !modelId) {
    return null
  }

  const hasParsedDeveloper = Boolean(parsed?.developerId)
  const shouldPrefixGroq = transport === 'direct' && serviceLower === 'groq' && developerId.toLowerCase() !== 'groq'
  const shouldPrefixOwner =
    transport === 'direct' &&
    (shouldPrefixGroq ||
      DIRECT_OWNER_PREFIX_SERVICES.has(serviceLower) ||
      (LOCAL_PREFIX_SERVICES.has(serviceLower) && hasParsedDeveloper) ||
      (connection?.useDeveloperPrefix && serviceLower.startsWith('custom_')))
  let effectiveModelId =
    providerId === 'openrouter' || providerId === 'vercel-gateway' || shouldPrefixOwner
      ? `${developerId}/${modelId}`
      : modelId

  if (isFalDirect) {
    effectiveModelId = `fal-ai/${developerId}/${modelId}`
  }

  return { providerId, developerId, modelId, effectiveModelId }
}

export function resolveCatalogIds({
  connectionId,
  connection,
  developerId,
  modelId,
  idVariants
}: {
  connectionId?: string | null
  connection?: CatalogConnectionContext | null
  developerId?: string | null
  modelId?: string | null
  idVariants?: Record<string, CatalogModelIdVariant> | null
}): { developerId: string; modelId: string; effectiveModelId: string; source?: string } | null {
  const baseDeveloper = normalize(developerId)
  const baseModel = normalize(modelId)
  if (!baseDeveloper || !baseModel) return null

  const selectedConnectionId = normalize(connectionId || connection?.id || null)
  const connectionContext = connection ?? inferCatalogConnectionContext(selectedConnectionId)
  const variant = selectedConnectionId && idVariants ? idVariants[selectedConnectionId] : undefined
  if (variant && isCatalogVariantCompatibleForConnection(variant, connectionContext)) {
    return {
      developerId: variant.developerId,
      modelId: variant.modelId,
      effectiveModelId: variant.effectiveId,
      source: variant.source
    }
  }

  const directService = selectedConnectionId.startsWith('direct:')
    ? (resolveConnectionServiceFromId(selectedConnectionId) ?? '').toLowerCase()
    : ''
  const shouldPrefixGroq = directService === 'groq' && baseDeveloper.toLowerCase() !== 'groq'
  const shouldPrefixOwner = Boolean(
    shouldPrefixGroq || (directService && DIRECT_OWNER_PREFIX_SERVICES.has(directService))
  )
  let effectiveModelId =
    selectedConnectionId === 'openrouter' ||
    selectedConnectionId === 'vercel-gateway' ||
    shouldPrefixOwner
      ? `${baseDeveloper}/${baseModel}`
      : baseModel

  if (selectedConnectionId === 'direct:fal') {
    effectiveModelId = `fal-ai/${baseDeveloper}/${baseModel}`
  }

  return { developerId: baseDeveloper, modelId: baseModel, effectiveModelId }
}
