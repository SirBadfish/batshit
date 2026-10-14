import { refuse } from '../../../appActions/catalog'
import type { DocumentAuth } from './registry'

/** Pure policy; the route adds topology and already-validated SvelteKit cookie locals. */
export function requireDocumentCookiePolicy(request: Request, url: URL, locals: {
  user: { id: string } | null
  session: { token: string; user_id: string } | null
}): DocumentAuth {
  if ([...request.headers.keys()].some(header => header.startsWith('x-batshit-') || header === 'authorization')) refuse('credential_not_admitted')
  if (!locals.user?.id || !locals.session?.token || locals.session.user_id !== locals.user.id) refuse('authentication_required')
  const origin = request.headers.get('origin')
  const site = request.headers.get('sec-fetch-site')
  if (origin !== null && origin !== url.origin) refuse('untrusted_origin')
  if (site !== null && site !== 'same-origin') refuse('untrusted_origin')
  if (request.method !== 'GET' && (origin !== url.origin || request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json')) refuse('untrusted_origin')
  return { userId: locals.user.id, authenticationSession: locals.session.token }
}

/** Existing self-hosted launchers are single process. Replicated/worker deployments are unsupported. */
export function processTopologyRefusal(configuration: Record<string, string | undefined>, worker: boolean): string | null {
  if (worker || (configuration.VERCEL && !['0', 'false'].includes(configuration.VERCEL)) ||
    configuration.NODE_APP_INSTANCE !== undefined || configuration.PM2_HOME !== undefined ||
    (configuration.WEB_CONCURRENCY !== undefined && configuration.WEB_CONCURRENCY !== '1') ||
    configuration.NODE_CLUSTER_SCHED_POLICY !== undefined) return 'unsupported_process_topology'
  return null
}
