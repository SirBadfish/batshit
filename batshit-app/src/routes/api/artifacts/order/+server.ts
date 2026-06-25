import { json, error, type RequestHandler } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'
import { RedisService } from '$lib/server/redis'
import { ArtifactsService } from '$lib/server/artifacts/artifactsService'

const VALID_ZONES = new Set(['panel', 'header'])

const redis = new RedisService()
const artifactsService = new ArtifactsService()

async function getStoredOrder(userId: string, zone: string) {
  return await redis.execute(async (client) => {
    const existing = await client.json.get(`user:${userId}:artifact_order:${zone}`)
    return Array.isArray(existing) ? existing as string[] : []
  })
}

async function saveOrder(userId: string, zone: string, order: string[]) {
  await redis.execute(async (client) => {
    await client.json.set(`user:${userId}:artifact_order:${zone}`, '$', order)
  })
}

export const GET: RequestHandler = async ({ url, locals }) => {
  if (!locals.user?.id) {
    return apiError('Unauthorized', 401)
  }
  const zone = url.searchParams.get('zone') || ''
  if (!VALID_ZONES.has(zone)) {
    throw error(400, 'Invalid zone')
  }

  const userId = locals.user.id
  const stored = await getStoredOrder(userId, zone)

  // Filter to existing, live artifacts in the requested zone
  const all = await artifactsService.listByUser(userId)
  const liveInZone = all.filter((a) => a.mode === 'published' && (a.zone || null) === zone)
  const liveSet = new Set(liveInZone.map((a) => a.id))

  // Keep stored order for existing IDs only, append any new ones
  const cleaned = stored.filter((id) => liveSet.has(id))
  const remaining = liveInZone
    .map((a) => a.id)
    .filter((id) => !cleaned.includes(id))
  const finalOrder = [...cleaned, ...remaining]

  // Persist cleaned order if it changed
  if (
    finalOrder.length !== stored.length ||
    finalOrder.some((id, i) => stored[i] !== id)
  ) {
    await saveOrder(userId, zone, finalOrder)
  }

  return json({ order: finalOrder })
}

export const PUT: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return apiError('Unauthorized', 401)
  }
  const body = await request.json().catch(() => ({}))
  const zone = body.zone
  const order = body.order

  if (!VALID_ZONES.has(zone)) {
    throw error(400, 'Invalid zone')
  }
  if (!Array.isArray(order) || !order.every((id: unknown) => typeof id === 'string')) {
    throw error(400, 'Order must be an array of strings')
  }

  await saveOrder(locals.user.id, zone, order)
  return json({ success: true })
}
