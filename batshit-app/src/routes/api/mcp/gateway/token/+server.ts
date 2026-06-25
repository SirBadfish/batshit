import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { requireAdmin } from '$lib/server/services/routeSecurity'
import { getDockerGatewayAuthToken } from '$lib/server/services/dockerGatewayConfig'

export const GET: RequestHandler = async ({ locals }) => {
  const admin = requireAdmin(locals)
  if (!admin.ok) return admin.response

  const token = getDockerGatewayAuthToken() || null
  return json({ token, configured: Boolean(token) })
}
