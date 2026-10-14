import type { RequestHandler } from '@sveltejs/kit'
import { actionTransportRecord } from '$lib/appActions/protocol'
import { appActionRegistry } from '$lib/server/services/appActions/runtime'
import { appActionDocumentAuth, appActionJson, appActionRouteFailure, readAppActionBody } from '$lib/server/services/appActions/route'

export const POST: RequestHandler = async event => {
  try {
    const auth = appActionDocumentAuth(event)
    const body = actionTransportRecord(await readAppActionBody(event.request), ['command', 'receipt', 'signature'])
    return appActionJson(await appActionRegistry.acceptReceipt(auth, body.command, body.receipt, body.signature))
  } catch (error) { return appActionRouteFailure(error) }
}
