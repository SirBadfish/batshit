import type {
  ArtifactModelConfig,
  ArtifactModelRole,
  ArtifactModelRoleConfig,
  ArtifactModelRoleSource
} from '$lib/types/artifacts'

const MODEL_SOURCES = new Set<ArtifactModelRoleSource>(['auto', 'preset', 'manual', 'primary', 'none'])

export function normalizeArtifactModelRoleConfig(
  role: ArtifactModelRole,
  config?: ArtifactModelRoleConfig | null
): ArtifactModelRoleConfig {
  const fallbackSource: ArtifactModelRoleSource = role === 'primary' ? 'auto' : 'primary'
  const candidate = config?.source
  const isAllowed =
    candidate &&
    MODEL_SOURCES.has(candidate) &&
    !(role === 'primary' && candidate === 'primary')
  const nextSource = isAllowed ? candidate : fallbackSource
  const presetId = config?.presetId ? String(config.presetId).trim() : null
  const modelId = config?.modelId ? String(config.modelId).trim() : null

  if (nextSource === 'none') {
    return { source: 'none', presetId: null, modelId: null }
  }
  if (nextSource === 'preset') {
    return { source: nextSource, presetId: presetId || null, modelId: null }
  }
  if (nextSource === 'manual') {
    return { source: nextSource, presetId: null, modelId: modelId || null }
  }
  return { source: nextSource, presetId: null, modelId: null }
}

export function normalizeArtifactModelConfig(
  config?: ArtifactModelConfig | null,
  legacyModelId?: string | null
): ArtifactModelConfig {
  if (config && typeof config === 'object') {
    const mode = config.mode === 'advanced' ? 'advanced' : 'basic'
    const primary = normalizeArtifactModelRoleConfig('primary', config.primary)
    if (mode === 'advanced') {
      const configRecord = config as unknown as Record<string, unknown>
      const visualConfig = configRecord.visual ?? configRecord.vision
      return {
        mode,
        primary,
        visual: normalizeArtifactModelRoleConfig('visual', visualConfig as ArtifactModelRoleConfig | null),
        audio: normalizeArtifactModelRoleConfig('audio', config.audio),
        utility: normalizeArtifactModelRoleConfig('utility', config.utility)
      }
    }
    return { mode: 'basic', primary }
  }

  const legacy = legacyModelId?.trim()
  if (legacy) {
    return {
      mode: 'basic',
      primary: { source: 'manual', modelId: legacy }
    }
  }

  return {
    mode: 'basic',
    primary: { source: 'auto', presetId: null, modelId: null }
  }
}
