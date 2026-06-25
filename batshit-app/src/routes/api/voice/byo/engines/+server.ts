import { json, type RequestHandler } from '@sveltejs/kit'

import {
  applyVoiceEnginePublicUpdates,
  listVoiceEngineSummaries,
  upsertVoiceEngineRecord,
  type VoiceEnginePublicUpdate
} from '$lib/server/services/voiceEngineRegistry'
import { cloneIconRef, isIconRef } from '$lib/icons/iconTypes'

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizePath(value: unknown, fallback: string): string {
  const candidate = normalizeOptionalString(value) ?? fallback
  return candidate.startsWith('/') ? candidate : `/${candidate}`
}

function normalizeManualEnginePayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('payload must be an object.')
  }

  const source = value as Record<string, unknown>
  const name = normalizeOptionalString(source.name)
  const baseUrl = normalizeOptionalString(source.baseUrl)
  if (!name) throw new Error('Engine name is required.')
  if (!baseUrl) throw new Error('Engine base URL is required.')

  let parsedBaseUrl: URL
  try {
    parsedBaseUrl = new URL(baseUrl)
  } catch {
    throw new Error('Engine base URL must be a valid URL.')
  }
  if (!['http:', 'https:'].includes(parsedBaseUrl.protocol)) {
    throw new Error('Engine base URL must use http or https.')
  }

  const supportsTts = source.supportsTts === true
  const supportsStt = source.supportsStt === true
  if (!supportsTts && !supportsStt) {
    throw new Error('Choose at least one capability: TTS or STT.')
  }

  const requestFormat =
    source.requestFormat === 'batshit-byo' || source.requestFormat === 'openai-compatible'
      ? source.requestFormat
      : 'openai-compatible'

  const modelId = normalizeOptionalString(source.modelId)
  const voiceId = normalizeOptionalString(source.voiceId)
  const language = normalizeOptionalString(source.language)

  const payload: Record<string, unknown> = {
    name,
    enabled: false,
    supportsTts,
    supportsStt,
    supportsClone: source.supportsClone === true,
    baseUrl: parsedBaseUrl.toString().replace(/\/+$/, ''),
    requestFormat,
    healthPath: normalizePath(source.healthPath, '/health'),
    readiness: { mode: 'health' },
    tags: ['manual', 'existing-service']
  }

  if (supportsTts) {
    payload.ttsPath = normalizePath(
      source.ttsPath,
      requestFormat === 'openai-compatible' ? '/v1/audio/speech' : '/tts'
    )
    if (modelId || voiceId) {
      payload.ttsDefaults = {
        ...(modelId ? { modelId } : {}),
        ...(voiceId ? { voiceId } : {})
      }
    }
  }

  if (supportsStt) {
    payload.sttPath = normalizePath(
      source.sttPath,
      requestFormat === 'openai-compatible' ? '/v1/audio/transcriptions' : '/stt'
    )
    if (modelId || language) {
      payload.sttDefaults = {
        ...(modelId ? { modelId } : {}),
        ...(language ? { language } : {})
      }
    }
  }

  if (isIconRef(source.iconRef)) {
    payload.iconRef = cloneIconRef(source.iconRef)
  }

  return payload
}

function normalizePublicUpdates(value: unknown): VoiceEnginePublicUpdate[] {
  if (!Array.isArray(value)) {
    throw new Error('engines must be an array.')
  }

  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Each engine update must be an object.')
    }

    const source = entry as Record<string, unknown>
    if (typeof source.id !== 'string' || source.id.trim().length === 0) {
      throw new Error('Each engine update requires an id.')
    }

    const localRuntimeSource =
      source.localRuntime && typeof source.localRuntime === 'object' && !Array.isArray(source.localRuntime)
        ? (source.localRuntime as Record<string, unknown>)
        : null
    const startupSource =
      localRuntimeSource?.startup &&
      typeof localRuntimeSource.startup === 'object' &&
      !Array.isArray(localRuntimeSource.startup)
        ? (localRuntimeSource.startup as Record<string, unknown>)
        : null

    const normalized: VoiceEnginePublicUpdate = {
      id: source.id
    }

    if (Object.prototype.hasOwnProperty.call(source, 'enabled') && typeof source.enabled === 'boolean') {
      normalized.enabled = source.enabled
    }

    if (Object.prototype.hasOwnProperty.call(source, 'iconRef')) {
      if (source.iconRef === null || source.iconRef === undefined) {
        normalized.iconRef = null
      } else if (isIconRef(source.iconRef)) {
        normalized.iconRef = cloneIconRef(source.iconRef)
      } else {
        throw new Error('iconRef must be a valid icon picker reference.')
      }
    }

    if (Object.prototype.hasOwnProperty.call(source, 'ttsDefaults')) {
      normalized.ttsDefaults =
        source.ttsDefaults && typeof source.ttsDefaults === 'object' && !Array.isArray(source.ttsDefaults)
          ? (source.ttsDefaults as VoiceEnginePublicUpdate['ttsDefaults'])
          : undefined
    }

    if (Object.prototype.hasOwnProperty.call(source, 'sttDefaults')) {
      normalized.sttDefaults =
        source.sttDefaults && typeof source.sttDefaults === 'object' && !Array.isArray(source.sttDefaults)
          ? (source.sttDefaults as VoiceEnginePublicUpdate['sttDefaults'])
          : undefined
    }

    if (Object.prototype.hasOwnProperty.call(source, 'localRuntime')) {
      normalized.localRuntime = localRuntimeSource
        ? {
            startup:
              typeof startupSource?.autoStartOnLaunch === 'boolean'
                ? {
                    autoStartOnLaunch: startupSource.autoStartOnLaunch
                  }
                : undefined
          }
        : undefined
    }

    return normalized
  })
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const engines = await listVoiceEngineSummaries(locals.user.id)
    return json({ engines })
  } catch (error) {
    console.error('[voice/byo/engines] Failed to load BYO engines:', error)
    return json({ error: 'Failed to load BYO engines' }, { status: 500 })
  }
}

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const data = await request.json()
    if (typeof data?.engineId !== 'string' || data.engineId.trim().length === 0) {
      throw new Error('engineId is required.')
    }
    const payload = normalizeManualEnginePayload(data?.payload)
    const result = await upsertVoiceEngineRecord(locals.user.id, data.engineId, payload)
    const engines = await listVoiceEngineSummaries(locals.user.id)
    return json({ success: true, created: result.created, engine: result.summary, engines })
  } catch (error) {
    console.error('[voice/byo/engines] Failed to connect existing BYO engine:', error)
    return json(
      {
        error: error instanceof Error ? error.message : 'Failed to connect existing BYO engine'
      },
      { status: 400 }
    )
  }
}

export const PUT: RequestHandler = async ({ locals, request }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const data = await request.json()
    const engines = normalizePublicUpdates(data?.engines)
    const updated = await applyVoiceEnginePublicUpdates(locals.user.id, engines)
    return json({ success: true, engines: updated })
  } catch (error) {
    console.error('[voice/byo/engines] Failed to update BYO engines:', error)
    return json(
      {
        error: error instanceof Error ? error.message : 'Failed to update BYO engines'
      },
      { status: 400 }
    )
  }
}
