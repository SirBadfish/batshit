import type { CatalogModel } from '$lib/types/modelCatalog'
import type { ModelCapabilities, ModelConnectionInfo } from '$lib/types/savedModels'

type OllamaReportedCapabilities = Pick<ModelCapabilities, 'vision' | 'reasoning'>
type OllamaPreset = {
  provider?: string | null
  modelId?: string | null
  effectiveModelId?: string | null
  connection?: ModelConnectionInfo | null
  capabilities?: ModelCapabilities | null
}

function exactOllamaTarget(preset: OllamaPreset): string | null {
  const connection = preset.connection
  if (connection?.type !== 'direct' || connection.service !== 'ollama' ||
      connection.id !== 'direct:ollama') return null
  const target = preset.effectiveModelId || preset.modelId
  if (!target) return null
  // A manual identity edit can leave the previous effective ID in the draft.
  if (preset.effectiveModelId && target !== preset.modelId &&
      target !== `${preset.provider}/${preset.modelId}`) return null
  return target
}

/**
 * Ollama 0.35.1 reports optional capabilities in /api/tags. Older versions,
 * unreadable model metadata and malformed lists provide no negative evidence.
 * Tools is deliberately excluded: that preset flag is the user's use choice.
 */
export function readOllamaModelCapabilities(payload: unknown): Map<string, OllamaReportedCapabilities> {
  const result = new Map<string, OllamaReportedCapabilities>()
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { models?: unknown }).models)) {
    return result
  }

  const seen = new Set<string>()
  for (const entry of (payload as { models: unknown[] }).models) {
    if (!entry || typeof entry !== 'object') continue
    const { name, model, capabilities } = entry as Record<string, unknown>
    const nameId = typeof name === 'string' && name.length ? name : null
    const modelId = typeof model === 'string' && model.length ? model : null
    const id = modelId ?? nameId
    if (!id) continue
    // Contradictory identities or duplicate rows cannot vouch for this target.
    const identities = new Set([nameId, modelId].filter((value): value is string => value !== null))
    if ((name !== undefined && !nameId) || (model !== undefined && !modelId) ||
        (nameId && modelId && nameId !== modelId) || [...identities].some(value => seen.has(value))) {
      for (const value of identities) {
        result.delete(value)
        seen.add(value)
      }
      continue
    }
    seen.add(id)
    if (!Array.isArray(capabilities) || !capabilities.every(value => typeof value === 'string')) continue

    const reported: OllamaReportedCapabilities = {}
    if (capabilities.includes('vision')) reported.vision = true
    if (capabilities.includes('thinking')) reported.reasoning = true
    if (Object.keys(reported).length) result.set(id, reported)
  }
  return result
}

/** Read projection only; a catalog refresh never edits a saved preset or draft. */
export function projectOllamaPresetCapabilities(
  preset: OllamaPreset,
  catalog: readonly CatalogModel[]
): ModelCapabilities | null {
  const saved = preset.capabilities ?? null
  const target = exactOllamaTarget(preset)
  if (!target) return saved

  const matches = catalog.filter(row => row.source === 'local' && row.connectionId === 'direct:ollama' && row.name === target)
  if (matches.length !== 1) return saved

  const reported = matches[0].features
  let projected = saved
  for (const key of ['vision', 'reasoning'] as const) {
    if (saved?.[key] === undefined && reported?.[key] === true) {
      projected = { ...(projected ?? {}), [key]: true }
    }
  }
  return projected
}

/** Carry only confirmed inferred flags forward; never take back later explicit choices. */
export function acknowledgeOllamaPresetCapabilities(
  current: OllamaPreset,
  original: OllamaPreset,
  submitted: OllamaPreset,
  confirmed: OllamaPreset
): ModelCapabilities | null {
  const saved = current.capabilities ?? null
  const target = exactOllamaTarget(current)
  if (!target || [original, submitted, confirmed].some(preset => exactOllamaTarget(preset) !== target)) return saved
  let acknowledged = saved
  for (const key of ['vision', 'reasoning'] as const) {
    if (saved?.[key] === undefined && original.capabilities?.[key] === undefined &&
        submitted.capabilities?.[key] === true && confirmed.capabilities?.[key] === true) {
      acknowledged = { ...(acknowledged ?? {}), [key]: true }
    }
  }
  return acknowledged
}
