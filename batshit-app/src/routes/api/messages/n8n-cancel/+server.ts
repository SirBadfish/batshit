import { json } from '@sveltejs/kit'
import { apiFailure } from '$lib/server/services/apiResponses'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import { stopRunningN8nExecutionsForMessage } from '$lib/server/services/n8nExecutionWebhookInspector'

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return apiFailure('Unauthorized', 401)
  }

  const body = await request.json().catch(() => ({}))
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
  const messageId = typeof body?.messageId === 'string' ? body.messageId.trim() : ''
  const expectedWebhookUrl =
    typeof body?.webhookUrl === 'string' && body.webhookUrl.trim()
      ? body.webhookUrl.trim()
      : null
  const limitRaw =
    typeof body?.limit === 'number'
      ? body.limit
      : typeof body?.limit === 'string'
        ? Number.parseInt(body.limit, 10)
        : undefined

  if (!sessionId) {
    return json({ success: false, error: 'Session ID is required' }, { status: 400 })
  }

  if (!messageId) {
    return json({ success: false, error: 'Message ID is required' }, { status: 400 })
  }

  const session = await redis.getSession(sessionId)
  if (!session || session.user_id !== locals.user.id) {
    return json({ success: false, error: 'Session not found or unauthorized' }, { status: 404 })
  }

  try {
    const result = await stopRunningN8nExecutionsForMessage({
      userId: locals.user.id,
      sessionId,
      messageId,
      expectedWebhookUrl,
      limit: Number.isFinite(limitRaw) ? limitRaw : undefined
    })

    const stoppedCount = result.stoppedExecutionIds.length
    const matchedCount = result.matchedExecutionIds.length
    const attemptedStopCount = matchedCount + result.workflowFallbackExecutionIds.length
    const hasForbiddenStopFailure = result.failures.some((failure) =>
      failure.error.toLowerCase().includes('forbidden')
    )
    const reason = !result.apiConfigured
      ? 'n8n_api_not_configured'
      : stoppedCount > 0
        ? null
        : hasForbiddenStopFailure && attemptedStopCount > 0
          ? 'n8n_execution_stop_forbidden'
          : attemptedStopCount > 0
            ? 'matching_execution_stop_failed'
            : 'no_matching_running_execution'

    return json({
      success: stoppedCount > 0,
      reason,
      apiConfigured: result.apiConfigured,
      checkedCount: result.checkedExecutionIds.length,
      matchedCount,
      stoppedCount,
      stoppedExecutionIds: result.stoppedExecutionIds,
      workflowFallbackExecutionIds: result.workflowFallbackExecutionIds,
      failures: result.failures
    })
  } catch (error) {
    console.error('[n8n-cancel] Failed to stop n8n execution:', error)
    return json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stop n8n execution'
      },
      { status: 500 }
    )
  }
}
