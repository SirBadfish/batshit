import { json, type RequestHandler } from '@sveltejs/kit'
import { requireAdmin, requireUser } from '$lib/server/services/routeSecurity'
import {
  getTypesafeConfig,
  setTypesafeConfig,
  validateTypesafeConfigInput
} from '$lib/server/services/typesafe/typesafeConfig'
import { getTypesafeKeyStatus } from '$lib/server/services/typesafe/typesafeAvailability'
import {
  TYPESAFE_ATTEMPT_TIMEOUT_MAX_MS,
  TYPESAFE_ATTEMPT_TIMEOUT_MIN_MS,
  TYPESAFE_IN_CHAT_WAIT_MAX_MS,
  TYPESAFE_IN_CHAT_WAIT_MIN_MS,
  TYPESAFE_PINNED_MODEL_ID
} from '$lib/server/services/typesafe/typesafe.constants'

/**
 * SA-120 P0 — the instance-level Jev Juice configuration (`batshit:typesafe_config`)
 * behind the Settings → Admin → Jev Juice card. The key itself is a normal
 * Settings → API Keys row (`typesafe`); this route only reports whether one exists.
 */
export const GET: RequestHandler = async ({ locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  try {
    const [config, key] = await Promise.all([getTypesafeConfig(), getTypesafeKeyStatus(user.value.id)])
    return json({
      config,
      key,
      limits: {
        pinnedModelId: TYPESAFE_PINNED_MODEL_ID,
        attemptTimeoutMinMs: TYPESAFE_ATTEMPT_TIMEOUT_MIN_MS,
        attemptTimeoutMaxMs: TYPESAFE_ATTEMPT_TIMEOUT_MAX_MS,
        inChatWaitMinMs: TYPESAFE_IN_CHAT_WAIT_MIN_MS,
        inChatWaitMaxMs: TYPESAFE_IN_CHAT_WAIT_MAX_MS
      }
    })
  } catch (error) {
    console.error('[Jev Juice Config] Load failed:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to load Jev Juice settings' },
      { status: 500 }
    )
  }
}

export const PUT: RequestHandler = async ({ locals, request }) => {
  const user = requireAdmin(locals)
  if (!user.ok) return user.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const validation = validateTypesafeConfigInput(body)
  if (!validation.ok) return json({ error: validation.error }, { status: 400 })

  try {
    const config = await setTypesafeConfig(validation.value)
    const key = await getTypesafeKeyStatus(user.value.id)
    return json({ config, key })
  } catch (error) {
    console.error('[Jev Juice Config] Save failed:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to save Jev Juice settings' },
      { status: 400 }
    )
  }
}
