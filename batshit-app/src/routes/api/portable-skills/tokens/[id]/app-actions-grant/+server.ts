import type { RequestHandler } from '@sveltejs/kit'
import { appActionsHumanRoute } from '$lib/server/services/appActions/settings/humanRoutes'
import { portableGrantResponse, savePortableGrant } from '$lib/server/services/appActions/settings/authority'
export const GET: RequestHandler = event => appActionsHumanRoute(event, userId => portableGrantResponse(userId, event.params.id!))
export const PUT: RequestHandler = event => appActionsHumanRoute(event, (userId, body) => savePortableGrant(userId, event.params.id!, body))
