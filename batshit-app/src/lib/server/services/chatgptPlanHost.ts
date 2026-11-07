import { env } from '$env/dynamic/private'
import { authService } from '$lib/services/auth.server'
import { ChatgptPlanVault, ChatgptPlanError } from './chatgptPlanVault'
import { ChatgptPlanOAuth } from './chatgptPlanOAuth'
import { ChatgptPlanRuntime } from './chatgptPlanRuntime'
import { registerRuntimeShutdownTask } from './runtimeShutdown'
import type { ChatgptPlanAccountSummary } from '$lib/utils/chatgptPlanConnection'
import { chatgptPlanDeployment } from './macCustodyPaths'

export function chatgptPlanEligibility(environment: Record<string, string | undefined> = env, platform = process.platform) {
  const deployment = chatgptPlanDeployment(environment, platform)
  if (!deployment) return { eligible: false as const, message: 'ChatGPT sign-in requires the local Mac app, supported local Mac or Windows WSL Pinokio, or local Docker with matching loopback configuration.' }
  return { eligible: true as const, ...deployment }
}
type HostGlobal = typeof globalThis & { __batshitChatgptPlanRuntime?: ChatgptPlanRuntime; __batshitChatgptPlanDeployment?: string }
const host = globalThis as HostGlobal
export function getChatgptPlanRuntime(): ChatgptPlanRuntime {
  const eligibility = chatgptPlanEligibility()
  if (!eligibility.eligible) throw new ChatgptPlanError('runtime_ineligible', eligibility.message)
  const descriptor = JSON.stringify(eligibility)
  if (host.__batshitChatgptPlanRuntime) {
    if (host.__batshitChatgptPlanDeployment !== descriptor) throw new ChatgptPlanError('runtime_configuration_changed', 'ChatGPT runtime configuration changed. Restart this Batshit instance before connecting.')
    return host.__batshitChatgptPlanRuntime
  }
  try {
    const vault = new ChatgptPlanVault(eligibility.custodyRoot, eligibility.mode === 'docker-local' ? { privateKeyFile: true } : env.ENCRYPTION_KEY ?? '')
    const oauth = new ChatgptPlanOAuth(vault, async (token, userId) => {
      const session = await authService.getSession(token)
      return Boolean(session && session.user_id === userId && Number.isFinite(Date.parse(session.expires_at)) && Date.parse(session.expires_at) > Date.now())
    }, fetch, eligibility.callbackMode === 'app-port' ? eligibility.callbackOrigin! : undefined)
    const runtime = new ChatgptPlanRuntime(vault, oauth)
    host.__batshitChatgptPlanRuntime = runtime
    host.__batshitChatgptPlanDeployment = descriptor
    registerRuntimeShutdownTask('chatgpt-plan', () => runtime.close())
    return runtime
  } catch (error) {
    if (error instanceof ChatgptPlanError) throw error
    throw new ChatgptPlanError('vault_unavailable', 'ChatGPT credential storage could not open. Existing credentials were kept; repair this instance before retrying.')
  }
}
export function chatgptPlanAccounts(userId: string): ChatgptPlanAccountSummary[] {
  if (!chatgptPlanEligibility().eligible) return []
  return getChatgptPlanRuntime().vault.list(userId).map(({ id, email, state, revocationStatus }) => ({ id, email, state, revocationStatus }))
}
export function cancelChatgptPlanSignIn(userId: string) { host.__batshitChatgptPlanRuntime?.oauth.cancel(userId) }

/** No getter/factory here: unsolicited callbacks must never initialize custody. */
export function receiveChatgptPlanCallback(request: Request): Response {
  const eligibility = chatgptPlanEligibility()
  if (!eligibility.eligible || eligibility.callbackMode !== 'app-port' || !host.__batshitChatgptPlanRuntime ||
      host.__batshitChatgptPlanDeployment !== JSON.stringify(eligibility)) return refusedChatgptPlanCallback()
  return host.__batshitChatgptPlanRuntime.oauth.receiveAppCallback(request)
}

export function refusedChatgptPlanCallback(): Response {
  return new Response('This callback is not a pending Batshit sign-in.', { status: 400, headers: {
    'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff'
  } })
}

// This gate is for browser connection management only. Native-tool, service,
// n8n and model-provided identity never substitutes for a signed-in session.
export function assertChatgptPlanManagement(request: Request, locals: App.Locals) {
  const eligibility = chatgptPlanEligibility()
  if (!eligibility.eligible) throw new ChatgptPlanError('runtime_ineligible', eligibility.message)
  if (!locals.user?.id || !locals.session?.token || locals.session.user_id !== locals.user.id || Date.parse(locals.session.expires_at) <= Date.now() || !Number.isFinite(Date.parse(locals.session.expires_at))) throw new ChatgptPlanError('session_required', 'Sign in to Batshit before managing ChatGPT.')
  if (new URL(request.url).origin !== eligibility.origin || request.headers.get('Origin') !== eligibility.origin) throw new ChatgptPlanError('origin_required', 'Manage ChatGPT from this Batshit instance\'s configured local URL.')
  return { userId: locals.user.id, sessionToken: locals.session.token }
}
