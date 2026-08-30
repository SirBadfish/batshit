import { json, type RequestHandler } from '@sveltejs/kit'
import { apiFailure } from '$lib/server/services/apiResponses'
import { fetchCompatibilityMatrix } from '$lib/server/services/compatibilityMatrix'
import { redis } from '$lib/server/redis'
import {
  loadN8nCompatibilitySnapshot,
  loadN8nCompatibilitySyncStatus
} from '$lib/server/services/n8nParameterCompatibility'
import { isWorkflowBackedSubagentType } from '$lib/utils/subagentType'

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) {
    return apiFailure('Unauthorized', 401)
  }

  try {
    const [matrix, localN8nSnapshot, n8nSyncStatus, subagentIds] = await Promise.all([
      fetchCompatibilityMatrix(),
      loadN8nCompatibilitySnapshot(),
      loadN8nCompatibilitySyncStatus(),
      redis.sMembers(`user:${locals.user.id}:subagents`)
    ])
    let hasN8nWorkflowSubagents = false
    for (const id of subagentIds) {
      const raw = await redis.json.get(`subagent:${id}`, '$')
      const subagent = Array.isArray(raw) ? raw[0] : raw
      if (subagent && isWorkflowBackedSubagentType(subagent.subagentType)) {
        hasN8nWorkflowSubagents = true
        break
      }
    }
    return json({
      data: matrix,
      n8n: {
        hasWorkflowSubagents: hasN8nWorkflowSubagents,
        localSnapshotAvailable: Boolean(localN8nSnapshot?.entries?.length),
        fetchedAt: localN8nSnapshot?.fetchedAt ?? null,
        syncStatus: n8nSyncStatus
      },
      success: true
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load compatibility matrix'
    return json({ error: message, success: false }, { status: 500 })
  }
}
