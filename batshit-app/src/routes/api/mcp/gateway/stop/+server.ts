import { json } from '@sveltejs/kit'
import { apiFailure } from '$lib/server/services/apiResponses'
import type { RequestHandler } from './$types'
import { gatewayManager } from '$lib/server/services/dockerGatewayManager'

export const POST: RequestHandler = async ({ locals }) => {
  try {
    // Check authentication
    if (!locals.user) {
      return apiFailure('Unauthorized', 401)
    }

    // Stop the gateway
    const result = gatewayManager.stopGateway()

    if (result.success) {
      return json({
        success: true,
        message: 'Gateway stopped successfully',
        status: 'stopped'
      })
    } else {
      return json(
        {
          success: false,
          error: result.error || 'Failed to stop gateway',
          lifecycleOwner: gatewayManager.getLifecycleOwner()
        },
        { status: 409 }
      )
    }
  } catch (error) {
    console.error('[/api/mcp/gateway/stop] Error:', error)
    return json(
      { success: false, error: 'Failed to stop gateway' },
      { status: 500 }
    )
  }
}
