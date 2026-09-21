/**
 * SA-120 Jev Juice — the instance-level config record (`batshit:typesafe_config`).
 *
 * Read side is tolerant: a corrupt stored value falls back per field so a send can
 * never throw on config (LS-044's rule). Write side refuses invalid input loudly, so
 * a typo can never store `jev-latest` or a timeout of zero.
 */

import { redis } from '$lib/server/redis'
import type { TypesafeConfig } from '$lib/types/typesafe'
import {
  JEV_IN_CHAT_WAIT_FIELD,
  JEV_IN_CHAT_WAIT_LABEL,
  JEV_INCOMING_TEXT_SCREEN_FIELD,
  JEV_INCOMING_TEXT_SCREEN_LABEL,
  resolveJevIncomingTextScreenEnabled
} from '$lib/utils/jevJuiceControl'
import { logger } from '$lib/utils/logger'
import {
  TYPESAFE_ATTEMPT_TIMEOUT_MAX_MS,
  TYPESAFE_ATTEMPT_TIMEOUT_MIN_MS,
  TYPESAFE_CONFIG_KEY,
  TYPESAFE_DEFAULT_ATTEMPT_TIMEOUT_MS,
  TYPESAFE_DEFAULT_IN_CHAT_WAIT_MS,
  TYPESAFE_IN_CHAT_WAIT_MAX_MS,
  TYPESAFE_IN_CHAT_WAIT_MIN_MS,
  TYPESAFE_PINNED_MODEL_ID,
  TYPESAFE_PINNED_MODEL_ID_PATTERN
} from './typesafe.constants'

export const DEFAULT_TYPESAFE_CONFIG: TypesafeConfig = Object.freeze({
  enabled: false,
  modelId: TYPESAFE_PINNED_MODEL_ID,
  attemptTimeoutMs: TYPESAFE_DEFAULT_ATTEMPT_TIMEOUT_MS,
  inChatWaitMs: TYPESAFE_DEFAULT_IN_CHAT_WAIT_MS,
  screenIncomingText: false,
  updatedAt: null
})

export function isPinnedTypesafeModelId(value: unknown): value is string {
  return typeof value === 'string' && TYPESAFE_PINNED_MODEL_ID_PATTERN.test(value.trim())
}

export function isValidAttemptTimeoutMs(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= TYPESAFE_ATTEMPT_TIMEOUT_MIN_MS &&
    value <= TYPESAFE_ATTEMPT_TIMEOUT_MAX_MS
  )
}

/** A whole number of milliseconds from 200 to 30,000 (SA-120 P8); the bounds are pinned at the boundary. */
export function isValidInChatWaitMs(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= TYPESAFE_IN_CHAT_WAIT_MIN_MS &&
    value <= TYPESAFE_IN_CHAT_WAIT_MAX_MS
  )
}

/** Tolerant read: unknown or invalid stored fields read as the defaults (and say so once at debug). */
export function normalizeStoredTypesafeConfig(raw: unknown): TypesafeConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_TYPESAFE_CONFIG }
  const stored = raw as Record<string, unknown>
  const modelId = isPinnedTypesafeModelId(stored.modelId)
    ? (stored.modelId as string).trim()
    : DEFAULT_TYPESAFE_CONFIG.modelId
  const attemptTimeoutMs = isValidAttemptTimeoutMs(stored.attemptTimeoutMs)
    ? stored.attemptTimeoutMs
    : DEFAULT_TYPESAFE_CONFIG.attemptTimeoutMs
  // SA-120 P8 (LS-059): a record written before P8 has no field and reads the 750 ms the lanes always had.
  const inChatWaitMs = isValidInChatWaitMs(stored.inChatWaitMs)
    ? stored.inChatWaitMs
    : DEFAULT_TYPESAFE_CONFIG.inChatWaitMs
  if (
    modelId !== stored.modelId ||
    attemptTimeoutMs !== stored.attemptTimeoutMs ||
    (stored.inChatWaitMs !== undefined && inChatWaitMs !== stored.inChatWaitMs)
  ) {
    logger.debug('[typesafe] stored config had invalid fields; reading defaults for them', {
      modelId: stored.modelId,
      attemptTimeoutMs: stored.attemptTimeoutMs,
      inChatWaitMs: stored.inChatWaitMs
    })
  }
  return {
    enabled: stored.enabled === true,
    modelId,
    attemptTimeoutMs,
    inChatWaitMs,
    // SA-120 P7 (LS-057): only a stored `true` is ON, so a record written before P7 reads OFF.
    screenIncomingText: resolveJevIncomingTextScreenEnabled(stored),
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null
  }
}

export type TypesafeConfigPatch = Partial<
  Pick<TypesafeConfig, 'enabled' | 'modelId' | 'attemptTimeoutMs' | 'inChatWaitMs' | 'screenIncomingText'>
>

export type TypesafeConfigValidation = { ok: true; value: TypesafeConfigPatch } | { ok: false; error: string }

/** Strict write-side validation for the Settings route. Unknown fields are ignored; present fields must be valid. */
export function validateTypesafeConfigInput(body: unknown): TypesafeConfigValidation {
  if (!body || typeof body !== 'object') return { ok: false, error: 'A JSON object is required.' }
  const input = body as Record<string, unknown>
  const value: TypesafeConfigPatch = {}

  if ('enabled' in input) {
    if (typeof input.enabled !== 'boolean') return { ok: false, error: '`enabled` must be true or false.' }
    value.enabled = input.enabled
  }
  if ('modelId' in input) {
    if (!isPinnedTypesafeModelId(input.modelId)) {
      return {
        ok: false,
        error:
          '`modelId` must be a pinned Jev model id such as jev-1.13.0. `jev-latest` moves and is not allowed in product config.'
      }
    }
    value.modelId = (input.modelId as string).trim()
  }
  if ('attemptTimeoutMs' in input) {
    if (!isValidAttemptTimeoutMs(input.attemptTimeoutMs)) {
      return {
        ok: false,
        error: `\`attemptTimeoutMs\` must be a whole number from ${TYPESAFE_ATTEMPT_TIMEOUT_MIN_MS} to ${TYPESAFE_ATTEMPT_TIMEOUT_MAX_MS}.`
      }
    }
    value.attemptTimeoutMs = input.attemptTimeoutMs
  }
  if (JEV_IN_CHAT_WAIT_FIELD in input) {
    if (!isValidInChatWaitMs(input[JEV_IN_CHAT_WAIT_FIELD])) {
      return {
        ok: false,
        error: `"${JEV_IN_CHAT_WAIT_LABEL}" must be a whole number of milliseconds from ${TYPESAFE_IN_CHAT_WAIT_MIN_MS} to ${TYPESAFE_IN_CHAT_WAIT_MAX_MS}.`
      }
    }
    value.inChatWaitMs = input[JEV_IN_CHAT_WAIT_FIELD] as number
  }
  if (JEV_INCOMING_TEXT_SCREEN_FIELD in input) {
    if (typeof input[JEV_INCOMING_TEXT_SCREEN_FIELD] !== 'boolean') {
      return { ok: false, error: `"${JEV_INCOMING_TEXT_SCREEN_LABEL}" must be true or false.` }
    }
    value.screenIncomingText = input[JEV_INCOMING_TEXT_SCREEN_FIELD] as boolean
  }
  return { ok: true, value }
}

export async function getTypesafeConfig(): Promise<TypesafeConfig> {
  const stored = await redis.json.get(TYPESAFE_CONFIG_KEY)
  return normalizeStoredTypesafeConfig(stored)
}

/** Merges a validated patch over the stored record and stamps `updatedAt`. */
export async function setTypesafeConfig(patch: TypesafeConfigPatch): Promise<TypesafeConfig> {
  const validation = validateTypesafeConfigInput(patch)
  if (!validation.ok) throw new Error(validation.error)
  const current = await getTypesafeConfig()
  const next: TypesafeConfig = {
    ...current,
    ...validation.value,
    updatedAt: new Date().toISOString()
  }
  await redis.json.set(TYPESAFE_CONFIG_KEY, '$', next as never)
  return next
}
