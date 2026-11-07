import { json, type RequestHandler } from '@sveltejs/kit'
import { beginSlashCommandWrite, isSlashCommandMutationError } from '$lib/server/services/slashCommandRevision'
import { normalizeAccessAgentId } from '$lib/server/services/agentAccessLists'

import {
  deleteSkillSource,
  scanSkillSource
} from '$lib/server/services/skillSourceDiscovery'

function toErrorResponse(error: unknown) {
  return {
    status:
      error && typeof error === 'object' && 'status' in error
        ? Number((error as { status?: number }).status) || 500
        : 500,
    ...(isSlashCommandMutationError(error) ? { code: error.code } : {}),
    message: error instanceof Error ? error.message : 'Skill source request failed.'
  }
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const preparation = beginSlashCommandWrite(locals.user.id)
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    if (body.attachAgentId !== undefined && body.attachAgentId !== null && !normalizeAccessAgentId(body.attachAgentId)) {
      return json({ error: 'The attached agent ID is invalid.' }, { status: 400 })
    }
    const scan = await scanSkillSource({
      userId: locals.user.id,
      sourceId: params.id ?? '',
      attachAgentId: typeof body.attachAgentId === 'string' ? body.attachAgentId : undefined
    }, preparation)
    return json({
      skillSource: scan.source,
      scanned: scan.scanned,
      skills: scan.skills,
      commands: scan.commands,
      warnings: scan.warnings
    })
  } catch (error) {
    console.error('[skill-sources/:id] Failed to scan skill source:', error)
    const response = toErrorResponse(error)
    return json({ error: response.message, ...(response.code ? { code: response.code } : {}) }, { status: response.status })
  }
}

export const DELETE: RequestHandler = async ({ params, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    await deleteSkillSource(locals.user.id, params.id ?? '')
    return json({ success: true })
  } catch (error) {
    console.error('[skill-sources/:id] Failed to delete skill source:', error)
    const response = toErrorResponse(error)
    return json({ error: response.message, ...(response.code ? { code: response.code } : {}) }, { status: response.status })
  }
}

