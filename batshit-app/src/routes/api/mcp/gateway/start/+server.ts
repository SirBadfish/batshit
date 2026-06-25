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

    // Start the gateway
    const result = await gatewayManager.startGateway()

    if (result.success) {
      return json({
        success: true,
        message: 'Gateway started successfully',
        status: 'running'
      })
    } else {
      return json(
        {
          success: false,
          error: result.error || 'Failed to start gateway',
          lifecycleOwner: gatewayManager.getLifecycleOwner()
        },
        { status: 409 }
      )
    }
  } catch (error) {
    console.error('[/api/mcp/gateway/start] Error:', error)
    return json(
      { success: false, error: 'Failed to start gateway' },
      { status: 500 }
    )
  }
}
