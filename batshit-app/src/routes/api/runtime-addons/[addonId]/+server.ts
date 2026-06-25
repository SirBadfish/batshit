import { json, type RequestHandler } from '@sveltejs/kit'
import {
  controlRuntimeAddon,
  getRuntimeAddonStatus,
  prepareRuntimeAddon,
  type RuntimeAddonOperation
} from '$lib/server/services/runtimeAddons'

function unauthorized() {
  return json({ error: 'Unauthorized' }, { status: 401 })
}

function operationFromPayload(payload: Record<string, any> | null): RuntimeAddonOperation {
  return payload?.operation === 'stop' ? 'stop' : 'start'
}

export const GET: RequestHandler = async ({ locals, params, url }) => {
  if (!locals.user?.id) return unauthorized()

  const addonId = params.addonId || ''
  const includePrepare = url.searchParams.get('prepare') === '1'
  const result = includePrepare
    ? await prepareRuntimeAddon(addonId)
    : await getRuntimeAddonStatus(addonId)

  if (!result) {
    return json({ error: `Unknown runtime add-on "${addonId}".` }, { status: 404 })
  }

  return json({ addon: result })
}

export const POST: RequestHandler = async ({ request, locals, params }) => {
  if (!locals.user?.id) return unauthorized()

  const payload = (await request.json().catch(() => null)) as Record<string, any> | null
  const operation = operationFromPayload(payload)
  const result = await controlRuntimeAddon(params.addonId || '', operation)

  if (!result) {
    return json({ error: `Unknown runtime add-on "${params.addonId || ''}".` }, { status: 404 })
  }

  return json(result, {
    status: result.success ? 200 : 503
  })
}

export const DELETE: RequestHandler = async ({ locals, params }) => {
  if (!locals.user?.id) return unauthorized()

  const result = await controlRuntimeAddon(params.addonId || '', 'stop')
  if (!result) {
    return json({ error: `Unknown runtime add-on "${params.addonId || ''}".` }, { status: 404 })
  }

  return json(result, {
    status: result.success ? 200 : 503
  })
}
