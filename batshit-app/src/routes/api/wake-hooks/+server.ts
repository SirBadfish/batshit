import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import {
  createWakeHook,
  listWakeHooks,
  WakeHookError
} from '$lib/server/services/dm/wakeHookStore'
import { resolveAgentDmsEnabled, resolveAgentWakeEnabled } from '$lib/utils/dmControl'
import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'

/**
 * SA-113 P3 (DL-113-09) — the Admin "Wake-up webhooks" card's list and create.
 *
 * Cookie-only, like every other Admin surface. The inbound side lives at
 * `/api/wake/{hookId}` and authenticates on its own with a bearer token; these two must
 * never be confused for one another.
 */

function errorStatus(error: unknown): number {
  if (error instanceof WakeHookError) return error.status
  return 500
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/**
 * The agents a hook may point at, with the two switches that decide what a call to it
 * would actually do — so the card can say "this one would land in the inbox, not wake"
 * instead of the user finding out from a 400 later.
 */
async function listEligibleAgents(userId: string) {
  const agents = await redis.getAgents(userId)
  return agents
    .map((agent) => agent as unknown as Record<string, any>)
    .filter((agent) => {
      const type = normalizePrimaryAgentType(agent as any)
      return type === 'api' || type === 'cli'
    })
    .map((agent) => ({
      id: agent.id,
      name:
        (typeof agent.displayName === 'string' && agent.displayName.trim()) ||
        (typeof agent.name === 'string' && agent.name.trim()) ||
        agent.id,
      dms_enabled: resolveAgentDmsEnabled(agent),
      wake_enabled: resolveAgentWakeEnabled(agent)
    }))
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) {
    return json({ success: false, error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const [hooks, agents] = await Promise.all([
      listWakeHooks(locals.user.id),
      listEligibleAgents(locals.user.id)
    ])
    return json({ success: true, hooks, agents })
  } catch (error) {
    console.error('[Wake-up webhooks] Could not list hooks:', error)
    return json(
      { success: false, error: errorMessage(error, 'Could not list wake-up webhooks.') },
      { status: errorStatus(error) }
    )
  }
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) {
    return json({ success: false, error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json({ success: false, error: 'Invalid request body.' }, { status: 400 })
    }

    const result = await createWakeHook({
      userId: locals.user.id,
      agentId: body.agentId,
      name: body.name,
      deliverDefault: body.deliverDefault,
      expiresAt: body.expiresAt
    })

    // The plain token is returned exactly once, here. It is never stored and never shown
    // again, which is why the card has to make the user copy it before closing.
    return json({ success: true, token: result.token, hook: result.record })
  } catch (error) {
    if (!(error instanceof WakeHookError)) {
      console.error('[Wake-up webhooks] Could not create a hook:', error)
    }
    return json(
      { success: false, error: errorMessage(error, 'Could not create the wake-up webhook.') },
      { status: errorStatus(error) }
    )
  }
}
