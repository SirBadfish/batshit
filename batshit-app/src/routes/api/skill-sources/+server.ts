import { json, type RequestHandler } from '@sveltejs/kit'

import {
  listSkillSources,
  scanSkillSource,
  upsertSkillSource
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

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const skillSources = await listSkillSources(locals.user.id)
    return json({ skillSources })
  } catch (error) {
    console.error('[skill-sources] Failed to list skill sources:', error)
    return json({ error: 'Failed to list skill sources' }, { status: 500 })
  }
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const rootPath = typeof body.rootPath === 'string' ? body.rootPath.trim() : ''
    if (!rootPath) {
      return json({ error: 'Folder path is required.' }, { status: 400 })
    }

    const source = await upsertSkillSource({
      userId: locals.user.id,
      id: typeof body.id === 'string' ? body.id : undefined,
      label: typeof body.label === 'string' ? body.label : undefined,
      rootPath,
      scope: body.scope === 'project' ? 'project' : 'global',
      trustLevel: body.trustLevel === 'trusted' ? 'trusted' : 'untrusted',
      enabledForAllAgents: body.enabledForAllAgents === true,
      enabledAgentIds: Array.isArray(body.enabledAgentIds) ? body.enabledAgentIds.map(String) : undefined,
      projectPath: typeof body.projectPath === 'string' ? body.projectPath : undefined
    })

    const shouldScan = body.scan !== false
    if (!shouldScan) {
      return json({ skillSource: source })
    }

    const scan = await scanSkillSource({
      userId: locals.user.id,
      sourceId: source.id,
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
    console.error('[skill-sources] Failed to create/scan skill source:', error)
    const response = toErrorResponse(error)
    return json({ error: response.message }, { status: response.status })
  }
}

