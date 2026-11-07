import { appActionDocumentAuth, appActionJson, readAppActionBody } from '../route'
import { AppActionRefusal } from '$lib/appActions/catalog'
import { SettingsReportRefusal } from '$lib/appActions/settings/reportContract'
import { AppActionsManagementRefusal } from './authority'
import { SettingsLifecycleRefusal } from './lifecycle'

type Event = { request: Request; url: URL; locals: App.Locals }
/** Cookie + same-origin only, including reads. Presented agent/service/portable headers refuse. */
export async function appActionsHumanRoute(event: Event, operation: (userId: string, body: unknown) => Promise<unknown>) {
  try {
    const auth = appActionDocumentAuth(event)
    const body = event.request.method === 'GET' ? undefined : await readAppActionBody(event.request, 131072)
    return appActionJson(await operation(auth.userId, body))
  } catch (error) {
    if (error instanceof SettingsLifecycleRefusal) return appActionJson({ success: false, code: error.code, error: error.message }, error.status)
    if (error instanceof AppActionsManagementRefusal) return appActionJson({ success: false, code: error.code, error: error.message }, error.status)
    if (error instanceof AppActionRefusal) return appActionJson({ success: false, code: error.reason, error: error.reason },
      ['authentication_required', 'credential_not_admitted'].includes(error.reason) ? 401 : error.reason === 'untrusted_origin' ? 403 : error.reason === 'payload_too_large' ? 413 : 400)
    if (error instanceof SettingsReportRefusal || error instanceof SyntaxError) return appActionJson({ success: false, code: 'INVALID_INPUT', error: 'Invalid App Actions request.' }, 400)
    console.error('[App Actions Settings] Human management request failed:', error instanceof Error ? error.message : 'unknown')
    return appActionJson({ success: false, code: 'MANAGEMENT_FAILED', error: 'The App Actions request could not be completed.' }, 500)
  }
}
