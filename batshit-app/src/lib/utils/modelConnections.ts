import type {
  CatalogConnectionOption,
  CatalogModel,
  CatalogModelIdVariant
} from '$lib/types/modelCatalog'
import type { SavedModel, ModelConnectionInfo } from '$lib/types/savedModels'

export function resolveConnectionServiceFromId(
  connectionId?: string | null
): string | undefined {
  if (!connectionId) return undefined
  if (connectionId === 'vercel-gateway') return 'vercel'
  if (connectionId === 'openrouter') return 'openrouter'
  if (connectionId.startsWith('direct:')) {
    const [, service] = connectionId.split(':')
    return service || undefined
  }
  return connectionId
}

const DIRECT_MULTI_DEVELOPER_SERVICES = new Set([
  'groq',
  'fal',
  'replicate',
  'deepinfra',
  'togetherai',
  'fireworks',
  'baseten',
  'cerebras',
  'ollama',
  'dmr',
  'lmstudio',
  'llama-cpp',
  'vllm'
])

function normalizeConnectionValue(value?: string | null): string {
  return value?.trim().toLowerCase() ?? ''
}

function getNormalizedConnectionProviders(
  connection: Pick<CatalogConnectionOption, 'providers'>
): Set<string> {
  return new Set((connection.providers ?? []).map((provider) => normalizeConnectionValue(provider)).filter(Boolean))
}

function getConnectionService(
  connection: Pick<CatalogConnectionOption, 'id' | 'service'>
): string {
  return normalizeConnectionValue(connection.service ?? resolveConnectionServiceFromId(connection.id))
}

type ConnectionCompatibilityContext = Pick<
  CatalogConnectionOption,
  'id' | 'transport' | 'service' | 'providers'
>

export function isDirectDeveloperCompatible(
  developerId: string | undefined | null,
  connection: ConnectionCompatibilityContext
): boolean {
  if (connection.transport !== 'direct') return true

  const normalizedDeveloper = normalizeConnectionValue(developerId)
  if (!normalizedDeveloper) return false

  const providers = getNormalizedConnectionProviders(connection)
  if (providers.has(normalizedDeveloper)) {
    return true
  }

  const service = getConnectionService(connection)
  if (service.startsWith('custom_')) {
    return true
  }

  if (DIRECT_MULTI_DEVELOPER_SERVICES.has(service)) {
    return true
  }

  if (!providers.size && service) {
    return normalizedDeveloper === service
  }

  return false
}

export function isCatalogVariantCompatibleForConnection(
  variant: CatalogModelIdVariant | null | undefined,
  connection: ConnectionCompatibilityContext | null
): boolean {
  if (!variant) return false
  if (!connection) return true
  if (connection.transport !== 'direct') return true
  return isDirectDeveloperCompatible(variant.developerId, connection)
}

function resolveModelTransport(model: CatalogModel): 'vercel-gateway' | 'openrouter' | 'local' {
  if (model.transport) {
    return model.transport === 'direct' ? 'local' : model.transport
  }
  if (model.connectionId === 'openrouter') return 'openrouter'
  if (model.connectionId?.startsWith('direct:')) return 'local'
  if (model.source === 'openrouter') return 'openrouter'
  return 'vercel-gateway'
}

export function isModelAllowedForConnection(
  model: CatalogModel,
  connection: CatalogConnectionOption | null
): boolean {
  if (!connection) return true
  const transport = resolveModelTransport(model)

  const selectedVariant = model.idVariants?.[connection.id]
  if (selectedVariant) {
    return isCatalogVariantCompatibleForConnection(selectedVariant, connection)
  }

  const explicitConnectionMatch =
    (model.connectionId && connection.id === model.connectionId) ||
    Boolean(model.availableConnections?.includes(connection.id))

  if (explicitConnectionMatch) {
    if (connection.transport === 'direct') {
      return isDirectDeveloperCompatible(model.provider, connection)
    }
    return true
  }

  switch (connection.transport) {
    case 'vercel-gateway':
      return transport === 'vercel-gateway'
    case 'openrouter':
      return transport === 'openrouter'
    case 'direct':
      // For direct connections, allow provider-based filtering to keep the UX usable even when the
      // catalog doesn't provide explicit availability metadata for the selected provider.
      if (connection.providers && connection.providers.length) {
        const providers = getNormalizedConnectionProviders(connection)
        return providers.has(normalizeConnectionValue(model.provider))
      }
      return transport !== 'openrouter'
    default:
      return true
  }
}

export function autoSelectConnectionForModel(
  connectionOptions: CatalogConnectionOption[],
  model: CatalogModel
): CatalogConnectionOption | null {
  if (!connectionOptions.length) return null

  const readyOptions = connectionOptions.filter((option) => option.status === 'ready')
  const pool = readyOptions.length ? readyOptions : connectionOptions

  if (model.connectionId) {
    const directMatch = pool.find((option) => option.id === model.connectionId)
    if (directMatch) {
      return directMatch
    }
  }

  const modelTransport = resolveModelTransport(model)
  const transportHint =
    modelTransport === 'openrouter'
      ? 'openrouter'
      : modelTransport === 'vercel-gateway'
        ? 'vercel-gateway'
        : 'direct'

  const isDirect = (option: CatalogConnectionOption) =>
    option.transport === 'direct' && option.providers?.includes(model.provider)

  const providerDirect = pool.find(isDirect)
  if (providerDirect) {
    return providerDirect
  }

  let match: CatalogConnectionOption | undefined
  if (transportHint === 'direct') {
    match = pool.find(isDirect)
  } else {
    match = pool.find((option) => option.transport === transportHint)
  }

  if (!match && transportHint !== 'direct') {
    match = pool.find(isDirect)
  }

  return match ?? pool[0] ?? null
}

export function resolveSavedModelConnection(model: SavedModel): ModelConnectionInfo {
  if (model.connection) {
    return {
      ...model.connection,
      service: model.connection.service ?? resolveConnectionServiceFromId(model.connection.id)
    }
  }

  if (model.isVercelImport) {
    return { type: 'vercel-gateway', service: 'vercel' }
  }

  return {
    type: 'direct',
    service: model.provider
  }
}

export function getSavedModelBadgeProvider(model: SavedModel): string {
  const connection = resolveSavedModelConnection(model)
  if (connection.service) {
    return connection.service
  }

  if (connection.type === 'vercel-gateway') {
    return 'vercel'
  }

  if (connection.type === 'openrouter') {
    return 'openrouter'
  }

  return model.provider
}
