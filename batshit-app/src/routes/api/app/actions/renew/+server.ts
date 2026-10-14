import type { RequestHandler } from '@sveltejs/kit'
import { actionTransportId, actionTransportRecord, parseDocumentIdentity } from '$lib/appActions/protocol'
import { appActionRegistry, requireAppActionSession } from '$lib/server/services/appActions/runtime'
import { appActionDocumentAuth, appActionJson, appActionRouteFailure, readAppActionBody } from '$lib/server/services/appActions/route'

export const POST: RequestHandler = async event => {
  try {
    const auth = appActionDocumentAuth(event)
    const body = actionTransportRecord(await readAppActionBody(event.request), ['registrationId', 'identity', 'challengeId', 'signature'])
    if (Object.hasOwn(body, 'challengeId')) {
      actionTransportRecord(body, ['challengeId', 'signature'])
      return appActionJson(await appActionRegistry.prove(auth, actionTransportId(body.challengeId), body.signature))
    }
    actionTransportRecord(body, ['registrationId', 'identity'])
    const identity = parseDocumentIdentity(body.identity)
    await requireAppActionSession(auth.userId, identity.expectedSessionId)
    return appActionJson(appActionRegistry.beginRenewal(auth, actionTransportId(body.registrationId), identity))
  } catch (error) { return appActionRouteFailure(error) }
}
