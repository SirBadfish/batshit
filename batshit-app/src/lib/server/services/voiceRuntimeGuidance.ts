import { getVoiceEngineGuidanceForProviderId } from '$lib/server/services/voiceEngineRegistry'
import type { VoiceProviderId, VoiceSettings } from '$lib/types/voice'
import { normalizeVoiceProviderId, normalizeVoiceSettings } from '$lib/utils/voiceSchema'

export function getTtsEnginePromptGuidance(
  settingsValue: VoiceSettings | unknown,
  providerId: VoiceProviderId | string | null | undefined
): string[] {
  const normalizedProviderId = normalizeVoiceProviderId(providerId)
  if (!normalizedProviderId) return []

  const settings = normalizeVoiceSettings(settingsValue)
  const prompt = settings.ttsEnginePrompts?.[normalizedProviderId]?.prompt?.trim()
  if (!prompt) return []

  return [
    `TTS engine prompt (${normalizedProviderId}): follow these engine-specific speaking instructions when writing text that will be spoken by this provider.`,
    prompt
  ]
}

export async function buildVoiceRuntimeGuidanceForProvider(
  userId: string,
  providerId: VoiceProviderId | string | null | undefined,
  settingsValue: VoiceSettings | unknown
): Promise<string[]> {
  const normalizedProviderId = normalizeVoiceProviderId(providerId)
  if (!normalizedProviderId) return []

  const guidance = normalizedProviderId.startsWith('byo:')
    ? await getVoiceEngineGuidanceForProviderId(userId, normalizedProviderId)
    : []

  guidance.push(...getTtsEnginePromptGuidance(settingsValue, normalizedProviderId))
  return guidance
}
