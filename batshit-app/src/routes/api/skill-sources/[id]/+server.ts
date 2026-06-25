import { json, type RequestHandler } from '@sveltejs/kit'

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
    message: error instanceof Error ? error.message : 'Skill source request failed.'
  }
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const scan = await scanSkillSource({
      userId: locals.user.id,
      sourceId: params.id ?? '',
      attachAgentId: typeof body.attachAgentId === 'string' ? body.attachAgentId : undefined
    })
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
    return json({ error: response.message }, { status: response.status })
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
    return json({ error: 'Failed to delete skill source' }, { status: 500 })
  }
}

