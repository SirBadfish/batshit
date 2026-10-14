import { json, type RequestHandler } from '@sveltejs/kit'
import { requireAdmin, requireUser } from '$lib/server/services/routeSecurity'
import {
  getTypesafeConfig,
  setTypesafeConfig,
  TypesafeConfigValidationError,
  validateTypesafeConfigInput
} from '$lib/server/services/typesafe/typesafeConfig'
import { getTypesafeKeyStatus } from '$lib/server/services/typesafe/typesafeAvailability'
import { getJudgeKeyStatuses } from '$lib/server/services/typesafe/judgeProviderEndpoint'
import { MAX_JUDGE_PROVIDERS } from '$lib/utils/judgeProviders'
import {
  TYPESAFE_ATTEMPT_TIMEOUT_MAX_MS,
  TYPESAFE_ATTEMPT_TIMEOUT_MIN_MS,
  TYPESAFE_IN_CHAT_WAIT_MAX_MS,
  TYPESAFE_IN_CHAT_WAIT_MIN_MS,
  TYPESAFE_PINNED_MODEL_ID
} from '$lib/server/services/typesafe/typesafe.constants'

/**
 * SA-120 P0 — the instance-level Judge Juice configuration (`batshit:typesafe_config`)
 * behind the Settings → Admin → Judge Juice card. The key itself is a normal
 * Settings → API Keys row (`typesafe`); this route only reports whether one exists.
 * SA-120 P10a (DL-120-18): the record also holds the added judges, the default judge, and
 * each feature's own judge; `keys` reports which judge keys exist (never a value).
 */
export const GET: RequestHandler = async ({ locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  try {
    const [config, key] = await Promise.all([getTypesafeConfig(), getTypesafeKeyStatus(user.value.id)])
    const keys = await getJudgeKeyStatuses(user.value.id, key)
    return json({
      config,
      key,
      keys,
      limits: {
        maxJudgeProviders: MAX_JUDGE_PROVIDERS,
        pinnedModelId: TYPESAFE_PINNED_MODEL_ID,
        attemptTimeoutMinMs: TYPESAFE_ATTEMPT_TIMEOUT_MIN_MS,
        attemptTimeoutMaxMs: TYPESAFE_ATTEMPT_TIMEOUT_MAX_MS,
        inChatWaitMinMs: TYPESAFE_IN_CHAT_WAIT_MIN_MS,
        inChatWaitMaxMs: TYPESAFE_IN_CHAT_WAIT_MAX_MS
      }
    })
  } catch (error) {
    console.error('[Judge Juice Config] Load failed:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to load Judge Juice settings' },
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
    const keys = await getJudgeKeyStatuses(user.value.id, key)
    return json({ config, key, keys })
  } catch (error) {
    // A refused merge (a choice that names a judge the list does not hold) is the caller's to fix: 400, nothing
    // written. Anything else is Batshit's failure, and the card shows it as a save error either way.
    if (error instanceof TypesafeConfigValidationError) return json({ error: error.message }, { status: 400 })
    console.error('[Judge Juice Config] Save failed:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to save Judge Juice settings' },
      { status: 500 }
    )
  }
}
