import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { gatewayManager } from '$lib/server/services/dockerGatewayManager'
import { requireAdmin } from '$lib/server/services/routeSecurity'

export const POST: RequestHandler = async ({ locals }) => {
  const admin = requireAdmin(locals)
  if (!admin.ok) return admin.response

  const result = await gatewayManager.startGateway()
  if (result.success) {
    return json({
      success: true,
      message: 'Docker MCP Gateway started successfully'
    })
  }

  return json(
    {
      success: false,
      message: result.error ?? 'Failed to start Docker MCP Gateway',
      lifecycleOwner: gatewayManager.getLifecycleOwner()
    },
    { status: 409 }
  )
}
