import { json } from '@sveltejs/kit'
import { apiFailure } from '$lib/server/services/apiResponses'
import type { RequestHandler } from './$types'
import { gatewayManager } from '$lib/server/services/dockerGatewayManager'

export const GET: RequestHandler = async ({ locals }) => {
  try {
    // Check authentication
    if (!locals.user) {
      return apiFailure('Unauthorized', 401)
    }

    // Get gateway status
    const status = await gatewayManager.getStatus()

    return json({
      success: true,
      status,
      running: status === 'running'
    })
  } catch (error) {
    console.error('[/api/mcp/gateway/status] Error:', error)
    return json({
      success: true,
      status: 'unknown',
      running: false
    })
  }
}