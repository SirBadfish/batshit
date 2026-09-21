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
  loadLocalAiModel,
  readLocalAiManagement,
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
    }
    const program = payload?.program
    if (!isManageableProgram(program)) {
      return json(
        { success: false, error: 'Batshit cannot manage models on that program.' },
        { status: 400 }
      )
    }
    const modelId = payload?.modelId?.trim()
    if (!modelId) {
      return json({ success: false, error: 'A model is required.' }, { status: 400 })
    }
    if (payload?.action !== 'load' && payload?.action !== 'unload') {
      return json({ success: false, error: 'Action must be load or unload.' }, { status: 400 })
    }

    const result =
      payload.action === 'load'
        ? await loadLocalAiModel(userId, program, modelId)
        : await unloadLocalAiModel(userId, program, modelId)

    // A refusal by the program is a real answer, not a server fault: it carries
    // a message the user can act on, so it returns 200 with success false.
    return json({ success: result.success, message: result.message, restarted: result.restarted })
  } catch (error) {
    console.error('[Local AI] Model action failed:', error)
    return json({ success: false, error: 'Model action failed' }, { status: 500 })
  }
}
