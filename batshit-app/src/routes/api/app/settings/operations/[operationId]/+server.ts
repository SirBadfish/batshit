import type { RequestHandler } from '@sveltejs/kit'
import { appActionsHumanRoute } from '$lib/server/services/appActions/settings/humanRoutes'
import { readSettingsOperationReview } from '$lib/server/services/appActions/settings/managementRuntime'
export const GET: RequestHandler = event => appActionsHumanRoute(event, userId => readSettingsOperationReview(userId, event.params.operationId!))
