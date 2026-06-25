import type {
  ModelCapabilities,
  ModelConnectionInfo,
  SavedModel,
} from '$lib/types/savedModels'

type ProviderSettings = Record<string, any> | null | undefined

export interface RuntimeModelSelectionArgs {
  preset?: SavedModel | null
  presetId?: string | null
  provider?: string | null
  modelId?: string | null
  connection?: ModelConnectionInfo | null
  contextWindow?: number | null
  capabilities?: ModelCapabilities | null
  settings?: ProviderSettings
}

export interface RuntimeModelSelection {
  preset: SavedModel | null
  presetId: string | null
  provider: string | null
  modelId: string | null
  connection: ModelConnectionInfo | null
  contextWindow: number | null
  capabilities: ModelCapabilities | null
  settings: Record<string, any> | null
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function cloneRecord(value: ProviderSettings): Record<string, any> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return { ...value }
}

export function mergePresetRuntimeSettings(
  agentSettings: ProviderSettings,
  presetSettings: ProviderSettings,
): Record<string, any> | null {
  const agentCopy = cloneRecord(agentSettings)
  const presetCopy = cloneRecord(presetSettings)
  const merged = {
    ...(agentCopy ?? {}),
    ...(presetCopy ?? {}),
  }

  return Object.keys(merged).length > 0 ? merged : null
}

export function resolveRuntimeModelSelection({
  preset = null,
  presetId = null,
  provider = null,
  modelId = null,
  connection = null,
  contextWindow = null,
  capabilities = null,
  settings = null,
}: RuntimeModelSelectionArgs): RuntimeModelSelection {
  return {
    preset,
    presetId: normalizeString(preset?.id) ?? normalizeString(presetId),
    provider: normalizeString(preset?.provider) ?? normalizeString(provider),
    modelId: normalizeString(preset?.modelId) ?? normalizeString(modelId),
    connection: preset?.connection ?? connection ?? null,
    contextWindow:
      typeof preset?.contextWindow === 'number'
        ? preset.contextWindow
        : typeof contextWindow === 'number'
          ? contextWindow
          : null,
    capabilities: preset?.capabilities ?? capabilities ?? null,
    settings: mergePresetRuntimeSettings(settings, preset?.settings ?? null),
  }
}
