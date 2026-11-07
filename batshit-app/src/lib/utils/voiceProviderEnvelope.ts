import type { VoiceProviderSummary } from '../types/voice'

type LifecycleWarning = NonNullable<NonNullable<VoiceProviderSummary['modelCatalog']>['lifecycleWarnings']>[number]

/** One finite lifecycle shape shared by response admission and the notice formatter. */
export function isVoiceProviderLifecycleWarning(value: unknown): value is LifecycleWarning {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (['modelId','lane','release'].some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !['modelId','lane','release','shutdownAt'].includes(key)) ||
    typeof row.modelId !== 'string' || !row.modelId.length || !row.modelId.isWellFormed() || row.modelId !== row.modelId.trim() || new TextEncoder().encode(row.modelId).length > 256 || /[\u0000-\u001f\u007f]/.test(row.modelId) ||
    !['tts-batch','tts-direct-stream','stt-recorded','stt-direct-realtime'].includes(row.lane as string) ||
    !['unknown','stable','preview','deprecated'].includes(row.release as string)) return false
  if (row.shutdownAt !== undefined) {
    if (typeof row.shutdownAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(row.shutdownAt)) return false
    const parsed = Date.parse(row.shutdownAt)
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().replace('.000Z','Z') !== row.shutdownAt.replace('.000Z','Z')) return false
  }
  return row.release === 'deprecated' || typeof row.shutdownAt === 'string'
}

/** A malformed HTTP200 is never an empty successful catalog. Keep the last admitted list. */
export function readVoiceProviderEnvelope(value: unknown): VoiceProviderSummary[] {
  const rows = value && typeof value === 'object' && !Array.isArray(value) ? (value as { providers?: unknown }).providers : null
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000) throw new Error('The voice provider list could not be read. Previous choices are kept.')
  const seen = new Set<string>(), bounded = (value: unknown) => typeof value === 'string' && value.length > 0 && new TextEncoder().encode(value).length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !bounded(row.id) || !bounded(row.label) || seen.has(row.id) ||
      !['cloud', 'local', 'browser', 'byo'].includes(row.type) || !row.supports ||
      ['tts','stt','listVoices','clone','streaming','styles','emotions'].some(key => typeof row.supports[key] !== 'boolean') ||
      ['ttsModels','sttModels','realtimeSttModels'].some(key => row[key] !== undefined && (!Array.isArray(row[key]) || row[key].length > 1000 || row[key].some((id: unknown) => !bounded(id)) || new Set(row[key]).size !== row[key].length))) {
      throw new Error('The voice provider list could not be read. Previous choices are kept.')
    }
    if (row.modelCatalog !== undefined) {
      const catalog = row.modelCatalog
      if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new Error('The voice provider list could not be read. Previous choices are kept.')
      if (catalog.lifecycleWarnings !== undefined) {
        const warnings = catalog.lifecycleWarnings
        if (!Array.isArray(warnings) || warnings.length > 1000 || warnings.some(warning => !isVoiceProviderLifecycleWarning(warning)) ||
          new Set(warnings.map(warning => JSON.stringify([warning.lane, warning.modelId]))).size !== warnings.length) throw new Error('The voice provider list could not be read. Previous choices are kept.')
      }
    }
    seen.add(row.id)
  }
  return structuredClone(rows)
}
