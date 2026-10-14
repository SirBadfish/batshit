import type { GoonLipSyncSettings, VoiceSettings } from '$lib/types/voice'
import {
  MAX_GOON_LIP_SYNC_VISEME_BLEND_MS,
  MIN_GOON_LIP_SYNC_VISEME_BLEND_MS
} from '$lib/utils/goonLipSync'
import { normalizeVoiceSettings } from '$lib/utils/voiceSchema'

export interface VoiceSettingsPatch {
  goonLipSync?: GoonLipSyncSettings
}

export class VoiceSettingsWriteError extends Error {
  constructor(message: string, public status = 400) {
    super(message)
  }
}

const isObject = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function readStoredVoice(value: unknown): Record<string, any> {
  if (value == null) return {}
  if (!isObject(value)) throw new VoiceSettingsWriteError('Saved Voice settings cannot be read.', 409)
  return value
}

function readStoredLipSync(voice: Record<string, any>): Record<string, any> {
  if (voice.goonLipSync != null) {
    if (!isObject(voice.goonLipSync)) {
      throw new VoiceSettingsWriteError('Saved lip sync settings cannot be read.', 409)
    }
    return { ...voice.goonLipSync }
  }
  // Introducing a nested record must not hide the flat legacy values the reader used.
  return { ...normalizeVoiceSettings(voice).goonLipSync }
}

export function validateVoiceSettingsPatch(value: unknown): VoiceSettingsPatch {
  if (!isObject(value) || Object.keys(value).some(key => key !== 'goonLipSync')) {
    throw new VoiceSettingsWriteError('Voice settings patch must name only lip sync settings.')
  }
  if (!Object.hasOwn(value, 'goonLipSync')) return {}
  const lip = value.goonLipSync
  if (!isObject(lip) || Object.keys(lip).some(key => !['mode', 'analyzerId', 'visemeBlendMs'].includes(key))) {
    throw new VoiceSettingsWriteError('Lip sync patch contains an unsupported field.')
  }
  const hasMode = Object.hasOwn(lip, 'mode')
  const hasAnalyzer = Object.hasOwn(lip, 'analyzerId')
  if (hasMode !== hasAnalyzer) {
    throw new VoiceSettingsWriteError('Save the lip sync mode and analyzer together.')
  }
  if (hasMode && !['amplitude', 'viseme'].includes(lip.mode)) {
    throw new VoiceSettingsWriteError('Lip sync mode must be amplitude or viseme.')
  }
  if (hasAnalyzer && !['rhubarb-wasm', 'audio2face-3d'].includes(lip.analyzerId)) {
    throw new VoiceSettingsWriteError('Lip sync analyzer is not supported.')
  }
  if (Object.hasOwn(lip, 'visemeBlendMs') && (
    typeof lip.visemeBlendMs !== 'number' || !Number.isFinite(lip.visemeBlendMs) ||
    lip.visemeBlendMs < MIN_GOON_LIP_SYNC_VISEME_BLEND_MS ||
    lip.visemeBlendMs > MAX_GOON_LIP_SYNC_VISEME_BLEND_MS
  )) {
    throw new VoiceSettingsWriteError('Lip sync blend must be within the supported range.')
  }
  return { goonLipSync: { ...lip } }
}

const LEGACY_VOICE_FIELDS = [
  'voiceRuntime', 'realtimeVoiceRuntime', 'goonLipSyncMode', 'goonLipSyncAnalyzerId',
  'goonLipSyncVisemeBlendMs', 'ttsProvider', 'ttsModel', 'ttsVoiceId',
  'ttsItalicNarrationBehavior', 'italicNarrationBehavior', 'sttProvider', 'sttModel',
  'realtimeSttProvider', 'realtimeSttModel', 'realtimeSttLanguage', 'voiceModeStt',
  'voiceModeTurn', 'ttsProviderPrompts', 'enginePrompts', 'ttsProviderSettings',
  'ttsEngineDefaults', 'sttProviderSettings', 'sttEngineDefaults'
]

/** Keep raw unowned data; normalize only a submitted whole Voice block. */
export function mergeVoiceSettingsSave(
  storedValue: unknown,
  wholeVoice: unknown,
  patchValue: unknown
): Record<string, any> {
  const patch = patchValue === undefined ? undefined : validateVoiceSettingsPatch(patchValue)
  const stored = readStoredVoice(storedValue)
  let next = { ...stored }
  if (wholeVoice !== undefined) {
    if (wholeVoice !== null && !isObject(wholeVoice)) {
      throw new VoiceSettingsWriteError('Voice settings must be an object.')
    }
    const supplied = wholeVoice ?? {}
    const { byo: _clientByo, byoProviders: _clientProviders, ...client } = supplied
    const trusted = { ...client }
    for (const field of ['byo', 'byoProviders']) {
      if (Object.hasOwn(stored, field)) trusted[field] = stored[field]
    }
    const normalized = normalizeVoiceSettings(trusted)
    const { byoProviders: _normalizedProviders, ...publicVoice } = normalized
    const namesLipSync = ['goonLipSync', 'goonLipSyncMode', 'goonLipSyncAnalyzerId', 'goonLipSyncVisemeBlendMs']
      .some(field => Object.hasOwn(supplied, field))
    const retainedLipSync = readStoredLipSync(stored)
    next = { ...stored, ...publicVoice, goonLipSync: namesLipSync
      ? { ...retainedLipSync, ...normalized.goonLipSync }
      : retainedLipSync }
    for (const field of LEGACY_VOICE_FIELDS) delete next[field]
  }
  if (patch?.goonLipSync) {
    next.goonLipSync = { ...readStoredLipSync(next), ...patch.goonLipSync }
  }
  return next
}

/** A mode/analyzer selection is one choice; the blend slider has its own ownership. */
export function buildVoiceLipSyncPatch(next: VoiceSettings, baseline: VoiceSettings): VoiceSettingsPatch {
  const current = next.goonLipSync ?? {}
  const previous = baseline.goonLipSync ?? {}
  const patch: GoonLipSyncSettings = {}
  if (current.mode !== previous.mode || current.analyzerId !== previous.analyzerId) {
    patch.mode = current.mode
    patch.analyzerId = current.analyzerId
  }
  if (current.visemeBlendMs !== previous.visemeBlendMs) patch.visemeBlendMs = current.visemeBlendMs
  return Object.keys(patch).length ? { goonLipSync: patch } : {}
}
