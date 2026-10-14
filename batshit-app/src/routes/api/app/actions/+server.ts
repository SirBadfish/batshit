import type { RequestHandler } from '@sveltejs/kit'
import { APP_ACTIONS_VERSION, parseActionRequest, refuse } from '$lib/appActions/catalog'
import { describeAppActionFamily, discoverAppActionFamilies } from '$lib/appActions/families'
import { inspectDeveloperSettings } from '$lib/server/services/appActions/settingsAdapter'
import { actionTransportId, actionTransportRecord, canonicalActionJson } from '$lib/appActions/protocol'
import { appActionRegistry, requireAppActionSession } from '$lib/server/services/appActions/runtime'
import { appActionDocumentAuth, appActionJson, appActionRouteFailure, developerAppActionScope, readAppActionBody } from '$lib/server/services/appActions/route'

export const GET: RequestHandler = async event => {
  try {
    const auth = appActionDocumentAuth(event)
    const requestId = event.url.searchParams.get('requestId')
    if (requestId) return appActionJson(appActionRegistry.status(developerAppActionScope(auth), requestId))
    const exactId = event.url.searchParams.get('actionId')
    const query = event.url.searchParams.get('query') ?? ''
    const limit = Number(event.url.searchParams.get('limit') ?? 5)
    const offset = Number(event.url.searchParams.get('offset') ?? 0)
    const discovery = exactId ? describeAppActionFamily('developer', exactId)
      : discoverAppActionFamilies('developer', { query, limit, offset })
    const result = { ...discovery,
      documents: appActionRegistry.listDocuments(auth.userId), processId: appActionRegistry.processId }
    canonicalActionJson(result)
    return appActionJson(result)
  } catch (error) { return appActionRouteFailure(error) }
}
export const POST: RequestHandler = async event => {
  try {
    const auth = appActionDocumentAuth(event)
    const payload = await readAppActionBody(event.request)
    if (payload && typeof payload === 'object' && (payload as { actionId?: unknown }).actionId === 'settings.inspect') {
      // One fixed, read-only developer capability. No supplied actor, risk or files.
      const body = actionTransportRecord(payload, ['actionId', 'args'])
      return appActionJson(await inspectDeveloperSettings(auth.userId, body.args, event.request.signal))
    }
    const body = actionTransportRecord(payload, ['requestId', 'actionId', 'args', 'expectedSessionId', 'targetDocumentId'])
    // The same five-action parser owns admission; no generic namespace/family escape.
    const validated = parseActionRequest({ requestId: body.requestId, actionId: body.actionId, args: body.args,
      expectedSessionId: body.expectedSessionId, documentId: 'validation', documentEpoch: 'validation',
      catalogVersion: APP_ACTIONS_VERSION, expiresAt: Date.now() + 5000 })
    await requireAppActionSession(auth.userId, validated.expectedSessionId)
    const dispatched = await appActionRegistry.dispatch(developerAppActionScope(auth), {
      requestId: validated.requestId, actionId: validated.actionId, args: validated.args,
      expectedSessionId: validated.expectedSessionId,
      ...(Object.hasOwn(body, 'targetDocumentId') ? { targetDocumentId: actionTransportId(body.targetDocumentId) } : {})
    })
    return appActionJson({ requestId: dispatched.requestId, status: 'accepted' }, 202)
  } catch (error) { return appActionRouteFailure(error) }
}
