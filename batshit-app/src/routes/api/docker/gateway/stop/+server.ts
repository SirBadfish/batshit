import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { gatewayManager } from '$lib/server/services/dockerGatewayManager'
import { requireAdmin } from '$lib/server/services/routeSecurity'

export const POST: RequestHandler = async ({ locals }) => {
  const admin = requireAdmin(locals)
  if (!admin.ok) return admin.response

  const result = gatewayManager.stopGateway()
  if (result.success) {
    return json({
      success: true,
      message: 'Docker MCP Gateway stopped'
    })
  }

  return json(
    {
      success: false,
      message: result.error ?? 'Failed to stop Docker MCP Gateway',
      lifecycleOwner: gatewayManager.getLifecycleOwner()
    },
    { status: 409 }
  )
}
