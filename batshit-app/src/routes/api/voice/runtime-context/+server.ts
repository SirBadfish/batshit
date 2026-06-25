import { json, type RequestHandler } from '@sveltejs/kit'

import { redis } from '$lib/server/redis'
import { buildVoiceRuntimeGuidanceForProvider } from '$lib/server/services/voiceRuntimeGuidance'
import { resolveVoiceConfigForMetadata } from '$lib/server/services/voiceService'
import type { AgentRow } from '$lib/types/database'

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const payload = await request.json().catch(() => ({}))
    const agentId = typeof payload?.agentId === 'string' ? payload.agentId.trim() : ''
    const metadata =
      payload?.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
        ? (payload.metadata as Record<string, unknown>)
        : {}

    const ttsOn = Boolean(metadata.tts ?? false)
    const sttOn = Boolean(metadata.stt ?? false)
    const voiceMode =
      typeof metadata.voiceMode === 'string'
        ? metadata.voiceMode
        : ttsOn
          ? 'voice'
          : 'text'
    const normalizedVoiceMode = voiceMode.toLowerCase()
    const spokenReply =
      ttsOn ||
      normalizedVoiceMode === 'voice' ||
      normalizedVoiceMode === 'hybrid' ||
      normalizedVoiceMode === 'speech-to-speech'

    let provider: string | undefined
    let guidance: string[] = []
    if (spokenReply) {
      const userSettings = await redis.getUserSettings(locals.user.id)
      const agent: AgentRow | null =
        agentId.length > 0
          ? await redis.execute(async (client) => {
              const value = await client.json.get(`agent:${agentId}`)
              return value as AgentRow | null
            })
          : null

      const resolvedVoiceConfig = await resolveVoiceConfigForMetadata({
        userSettings,
        agent,
        metadata
      })

      provider = resolvedVoiceConfig.provider ?? undefined
      guidance = await buildVoiceRuntimeGuidanceForProvider(
        locals.user.id,
        provider,
        userSettings?.voice_settings
      )
    }

    const voiceState = {
      tts: ttsOn,
      stt: sttOn,
      voiceMode,
      provider,
      guidance: guidance.length > 0 ? guidance : undefined
    }

    return json({ voiceState })
  } catch (error) {
    console.error('[voice/runtime-context] Failed to resolve voice runtime context', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to resolve voice runtime context' },
      { status: 500 }
    )
  }
}
