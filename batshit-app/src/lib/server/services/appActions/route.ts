import { json } from '@sveltejs/kit'
import { AppActionRefusal } from '$lib/appActions/catalog'
import { requireAppActionTopology } from './runtime'
import type { DocumentAuth } from './registry'
import { requireDocumentCookiePolicy } from './policy'
export { readAppActionBody } from './body'

type RouteEvent = { request: Request; url: URL; locals: App.Locals }
/** This is a cookie-only document/developer API. Native tool identity stays on Fabric. */
export function appActionDocumentAuth({ request, url, locals }: RouteEvent): DocumentAuth {
  requireAppActionTopology()
  return requireDocumentCookiePolicy(request, url, locals)
}
export function developerAppActionScope(auth: DocumentAuth) {
  // Used only inside this process. Never returned, logged, signed, or sent on the live hub.
  return { userId: auth.userId, scopeId: `developer:${auth.authenticationSession}` }
}
export function appActionJson(value: unknown, status = 200) {
  return json(value, { status, headers: { 'Cache-Control': 'no-store' } })
}
export function appActionRouteFailure(error: unknown) {
  if (!(error instanceof AppActionRefusal)) {
    console.error('[App Actions] Transport operation failed.', error instanceof Error ? error.message : 'unknown error')
    return appActionJson({ status: 'failed', reason: 'transport_failed' }, 500)
  }
  const reason = error.reason
  const status = reason === 'authentication_required' || reason === 'credential_not_admitted' ? 401
    : ['untrusted_origin', 'session_not_owned'].includes(reason) ? 403
      : reason === 'payload_too_large' ? 413
        : ['unsupported_process_topology', 'registration_capacity', 'receipt_capacity'].includes(reason) ? 503
          : ['no_tab', 'ambiguous_target', 'stale_registration', 'wrong_process', 'stale_challenge', 'request_not_found'].includes(reason) ? 409 : 400
  return appActionJson({ status: 'blocked', reason }, status)
}
