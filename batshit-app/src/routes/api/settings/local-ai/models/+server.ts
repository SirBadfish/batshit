/**
 * SA-124 P8: read and change which model a local AI program has loaded.
 *
 * Server-side by design (DL-124-12): a local program may carry an encrypted API
 * key that must never reach the browser, and Docker loopback rewriting lives on
 * this side. See `localAiModelManagement.ts` for the per-program contracts.
 */

import { json } from '@sveltejs/kit'
import { apiFailure } from '$lib/server/services/apiResponses'
import type { RequestHandler } from './$types'
import {
  isManageableProgram,
  applyKoboldCppProfile,
  applyKoboldCppContext,
  enableKoboldManagedSetup,
  validKoboldContextIntent,
  validKoboldProfileExpectation,
  loadLocalAiModel,
  readLocalAiManagement,
  readLocalAiAvailability,
  unloadLocalAiModel
} from '$lib/server/services/localAiModelManagement'

export const GET: RequestHandler = async ({ url, locals }) => {
  const userId = locals.user?.id
  if (!userId) return apiFailure('Unauthorized', 401)

  const program = url.searchParams.get('program')
  if (!isManageableProgram(program)) {
    return json(
      { success: false, error: 'Batshit cannot manage models on that program.' },
      { status: 400 }
    )
  }

  try {
    if (url.searchParams.get('mode') === 'availability') {
      return json({ success: true, ...await readLocalAiAvailability(userId, program) })
    }
    return json({ success: true, state: await readLocalAiManagement(userId, program) })
  } catch (error) {
    console.error('[Local AI] Failed to read model management state:', error)
    return json({ success: false, error: 'Failed to read models' }, { status: 500 })
  }
}

export const POST: RequestHandler = async ({ request, locals }) => {
  const userId = locals.user?.id
  if (!userId) return apiFailure('Unauthorized', 401)

  try {
    const payload = (await request.json()) as {
      program?: string
      action?: string
      modelId?: string
      /** KoboldCpp only (BL-101): a saved-settings file to start the model from. */
      baseConfig?: string | null
      expectedConnectionKey?: string
      expectation?: unknown
      intent?: unknown
      registrationId?: string
    }
    const program = payload?.program
    if (!isManageableProgram(program)) {
      return json(
        { success: false, error: 'Batshit cannot manage models on that program.' },
        { status: 400 }
      )
    }
    const modelId = typeof payload?.modelId === 'string' ? payload.modelId.trim() : ''
    if (payload.action === 'enable-managed-context') {
      if (program !== 'koboldcpp' || typeof payload.registrationId !== 'string' || typeof payload.expectedConnectionKey !== 'string' || !/^[a-f0-9]{64}$/.test(payload.expectedConnectionKey)) return json({ success: false, error: 'Choose a registered local setup and refresh the saved connection.' }, { status: 400 })
      return json(await enableKoboldManagedSetup(userId, payload.registrationId, payload.expectedConnectionKey))
    }
    if (payload.action === 'apply-context') {
      if (program !== 'koboldcpp' || !validKoboldContextIntent(payload.intent)) return json({ success: false, error: 'Choose a registered model, enter valid context tokens and confirm chats are idle.' }, { status: 400 })
      return json(await applyKoboldCppContext(userId, payload.intent))
    }
    if (!modelId) {
      return json({ success: false, error: 'A model is required.' }, { status: 400 })
    }
    if (payload?.action === 'apply-profile') {
      if (program !== 'koboldcpp' || !validKoboldProfileExpectation(payload.expectation)) {
        return json({ success: false, error: 'Choose a KoboldCpp saved profile and provide the expected model/context and idle confirmation.' }, { status: 400 })
      }
      return json(await applyKoboldCppProfile(userId, modelId, payload.expectation))
    }
    if (payload?.action !== 'load' && payload?.action !== 'unload') {
      return json({ success: false, error: 'Action must be load or unload.' }, { status: 400 })
    }

    if (typeof payload.expectedConnectionKey !== 'string' || !/^[a-f0-9]{64}$/.test(payload.expectedConnectionKey)) {
      return json({ success: false, error: 'Refresh the model list before using model controls.' }, { status: 400 })
    }

    const result =
      payload.action === 'load'
        ? await loadLocalAiModel(userId, program, modelId, {
            baseConfig: typeof payload.baseConfig === 'string' ? payload.baseConfig : null,
            expectedConnectionKey: payload.expectedConnectionKey
          })
        : await unloadLocalAiModel(userId, program, modelId, payload.expectedConnectionKey)

    // A refusal by the program is a real answer, not a server fault: it carries
    // a message the user can act on, so it returns 200 with success false.
    return json({ success: result.success, message: result.message, restarted: result.restarted, pending: result.pending })
  } catch (error) {
    console.error('[Local AI] Model action failed:', error)
    return json({ success: false, error: 'Model action failed' }, { status: 500 })
  }
}
