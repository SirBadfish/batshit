import { json, error, isHttpError, isRedirect, type RequestHandler } from '@sveltejs/kit'
import { apiError, serviceRefusalResponse } from '$lib/server/services/apiResponses'
import { ArtifactsService } from '$lib/server/artifacts/artifactsService'
import { isOwnAgentOrSubagent, parseAgentAccessChange } from '$lib/server/services/agentAccessLists'

/**
 * PUT /api/artifacts/[id]/agent-access: turn ONE agent or Subagent on or off for one artifact,
 * body `{ agentId, enabled }` (Settings > Agents > Access, BL-544). The id is added to or taken out
 * of `agent_allowlist` as stored at that moment (`ArtifactsService.setAgentAccess`: the artifact
 * write lock and its check-and-set write); Agent Use, the all-agents scope, and the other agents'
 * entries stay as they are. Answers the artifact as stored. Signed-in user only: this path is not
 * an artifact runtime path, so an artifact's own page cannot reach it.
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
  const { id } = params
  if (!id) {
    throw error(400, 'Artifact ID is required')
  }
  const userId = locals.user?.id
  if (!userId) {
    return apiError('Unauthorized', 401)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError('Send { agentId, enabled } as JSON.', 400)
  }
  const change = parseAgentAccessChange(body)
  if ('error' in change) {
    return apiError(change.error, 400)
  }

  try {
    if (change.enabled && !(await isOwnAgentOrSubagent(userId, change.agentId))) {
      return apiError(`There is no agent or Subagent "${change.agentId}" to turn this on for.`, 404)
    }
    const artifactsService = new ArtifactsService()
    const artifact = await artifactsService.setAgentAccess(id, userId, change.agentId, change.enabled)
    return json(artifact)
  } catch (err) {
    const refusal = serviceRefusalResponse(err)
    if (refusal) {
      console.warn('Artifact agent access change refused:', err instanceof Error ? err.message.split('\n')[0] : err)
      return refusal
    }
    if (isHttpError(err) || isRedirect(err)) throw err

    console.error('Failed to change artifact agent access:', err)
    throw error(500, 'Failed to change who may use this artifact')
  }
}
