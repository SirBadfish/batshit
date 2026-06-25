import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { gatewayManager } from '$lib/server/services/dockerGatewayManager'
import { redis } from '$lib/server/redis'
import { requireAdmin } from '$lib/server/services/routeSecurity'

const SETTINGS_KEY = 'system:settings:docker-mcp'

const normalizePort = (value: unknown, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value)
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed
    }
  }
  return fallback
}

export const GET: RequestHandler = async ({ locals }) => {
  const admin = requireAdmin(locals)
  if (!admin.ok) return admin.response

  const stored = (await redis.get(SETTINGS_KEY)) ?? {}
  const currentPort = normalizePort((stored as any)?.port, gatewayManager.getGatewayPort())

  gatewayManager.updateSettings({ port: currentPort })
  const status = await gatewayManager.getStatus()

  return json({
    autoStart: false,
    port: currentPort,
    status,
    lifecycleOwner: gatewayManager.getLifecycleOwner(),
    lifecycleManagedExternally: true
  })
}

export const POST: RequestHandler = async ({ request, locals }) => {
  const admin = requireAdmin(locals)
  if (!admin.ok) return admin.response

  const existing = (await redis.get(SETTINGS_KEY)) ?? {}
  let payload: any = {}

  try {
    payload = await request.json()
  } catch {
    return json({ error: 'Invalid JSON payload' }, { status: 400 })
  }

  const nextPort = normalizePort(payload?.port, normalizePort((existing as any)?.port, gatewayManager.getGatewayPort()))
  const nextSettings = {
    autoStart: false,
    port: nextPort
  }

  await redis.set(SETTINGS_KEY, nextSettings)
  gatewayManager.updateSettings({ port: nextPort })
  const status = await gatewayManager.getStatus()

  return json({
    success: true,
    settings: {
      ...nextSettings,
      status
    },
    lifecycleOwner: gatewayManager.getLifecycleOwner(),
    lifecycleManagedExternally: true,
    warning: `Docker MCP Gateway lifecycle is managed by ${gatewayManager.getLifecycleOwner()}. Auto-start and API lifecycle controls are disabled.`
  })
}
