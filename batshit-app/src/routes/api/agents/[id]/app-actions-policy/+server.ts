import type { RequestHandler } from '@sveltejs/kit'
import { appActionsHumanRoute } from '$lib/server/services/appActions/settings/humanRoutes'
import { nativePolicyResponse, saveNativePolicy } from '$lib/server/services/appActions/settings/authority'
export const GET: RequestHandler = event => appActionsHumanRoute(event, userId => nativePolicyResponse(userId, event.params.id!))
export const PUT: RequestHandler = event => appActionsHumanRoute(event, (userId, body) => saveNativePolicy(userId, event.params.id!, body))
