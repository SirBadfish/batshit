import type { RequestHandler } from '@sveltejs/kit'
import { appActionsHumanRoute } from '$lib/server/services/appActions/settings/humanRoutes'
import { decideSettingsOperation } from '$lib/server/services/appActions/settings/managementRuntime'
export const POST: RequestHandler = event => appActionsHumanRoute(event, (userId, body) => decideSettingsOperation(userId, event.params.operationId!, body))
