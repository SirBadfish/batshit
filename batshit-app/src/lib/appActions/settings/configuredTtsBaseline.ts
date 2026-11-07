import { CONFIGURED_TTS_FIELDS, validTtsId, type ConfiguredTtsSelection } from './configuredTtsPreferences'
import { normalizeVoiceTtsConfig } from '$lib/utils/voiceSchema'
export const CONFIGURED_TTS_REVISION_HEADER = 'X-Batshit-TTS-Selection-Revision'
export type ConfiguredTtsBaseline = Readonly<{ id: string; token: string; selection: ConfiguredTtsSelection }>
export const isConfiguredTtsRevision = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
export function captureConfiguredTtsBaseline(row: Record<string, unknown>, header: unknown): ConfiguredTtsBaseline | null {
  if (!isConfiguredTtsRevision(header) || typeof row.id !== 'string' || !row.id || row.agentType !== 'api') return null
  const profile = row.voice_profile
  if (profile != null && (typeof profile !== 'object' || Array.isArray(profile))) return null
  const tts = profile && typeof profile === 'object' ? (profile as Record<string, unknown>).tts : undefined
  if (tts != null && (typeof tts !== 'object' || Array.isArray(tts))) return null
  const root = profile as Record<string, unknown> | null | undefined
  const active = (tts ?? { providerId: root?.provider, modelId: root?.model, voiceId: root?.voiceId, profileId: root?.profileId }) as Record<string, unknown>
  const fish = active.providerOptions && typeof active.providerOptions === 'object' && !Array.isArray(active.providerOptions)
    ? (active.providerOptions as Record<string, unknown>).fish : undefined
  const reference = fish && typeof fish === 'object' && !Array.isArray(fish) ? (fish as Record<string, unknown>).reference_id : undefined
  if (['providerId', 'provider', 'modelId', 'model', 'voiceId', 'profileId'].some(field => active[field] != null &&
    (typeof active[field] !== 'string' || new TextEncoder().encode(active[field] as string).length > 256 || /[\u0000-\u001f\u007f]/.test(active[field] as string))) ||
    reference != null && (typeof reference !== 'string' || new TextEncoder().encode(reference).length > 256 || /[\u0000-\u001f\u007f]/.test(reference))) return null
  const normalized = normalizeVoiceTtsConfig({ providerId: active.providerId ?? active.provider, modelId: active.modelId ?? active.model,
    voiceId: active.voiceId, profileId: active.profileId, ...(reference === undefined ? {} : { providerOptions: { fish: { reference_id: reference } } }) })
  const selection = Object.fromEntries(CONFIGURED_TTS_FIELDS.map(field => [field, normalized?.[field] ?? null])) as ConfiguredTtsSelection
  if (Object.values(selection).some(value => value !== null && !validTtsId(value))) return null
  return Object.freeze({ id: row.id, token: header, selection: Object.freeze(selection) })
}
