import path from 'node:path'
import { env } from '$env/dynamic/private'
import { authService } from '$lib/services/auth.server'
import { ChatgptPlanVault, ChatgptPlanError } from './chatgptPlanVault'
import { ChatgptPlanOAuth } from './chatgptPlanOAuth'
import { ChatgptPlanRuntime } from './chatgptPlanRuntime'
import { registerRuntimeShutdownTask } from './runtimeShutdown'
import type { ChatgptPlanAccountSummary } from '$lib/utils/chatgptPlanConnection'

export function chatgptPlanEligibility(environment: Record<string, string | undefined> = env, platform = process.platform) {
  if (platform !== 'darwin' || environment.BATSHIT_RUNTIME_OWNER !== 'mac-app' || environment.BATSHIT_CONTAINERIZED === '1') return { eligible: false as const, message: 'ChatGPT plan connections currently require the local Batshit Mac app. Docker support is not qualified yet.' }
  const root = environment.BATSHIT_MAC_DATA_DIR
  let origin: URL
  try { origin = new URL(environment.ORIGIN ?? '') } catch { return { eligible: false as const, message: 'The Mac app local origin is unavailable. Repair its runtime configuration.' } }
  if (!root || !path.isAbsolute(root) || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash || origin.port !== environment.BATSHIT_FRONTEND_PORT) {
    return { eligible: false as const, message: 'ChatGPT sign-in requires the supervisor-owned Mac data folder and exact local app origin.' }
  }
  return { eligible: true as const, root, origin: origin.origin }
}
type HostGlobal = typeof globalThis & { __batshitChatgptPlanRuntime?: ChatgptPlanRuntime }
const host = globalThis as HostGlobal
export function getChatgptPlanRuntime(): ChatgptPlanRuntime {
  const eligibility = chatgptPlanEligibility()
  if (!eligibility.eligible) throw new ChatgptPlanError('runtime_ineligible', eligibility.message)
  if (host.__batshitChatgptPlanRuntime) return host.__batshitChatgptPlanRuntime
  try {
    const vault = new ChatgptPlanVault(path.join(eligibility.root, 'config', 'chatgpt-plan'), env.ENCRYPTION_KEY ?? '')
    const oauth = new ChatgptPlanOAuth(vault, async (token, userId) => {
      const session = await authService.getSession(token)
      return Boolean(session && session.user_id === userId && Number.isFinite(Date.parse(session.expires_at)) && Date.parse(session.expires_at) > Date.now())
    })
    const runtime = new ChatgptPlanRuntime(vault, oauth)
    host.__batshitChatgptPlanRuntime = runtime
    registerRuntimeShutdownTask('chatgpt-plan', () => runtime.close())
    return runtime
  } catch (error) {
    if (error instanceof ChatgptPlanError) throw error
    throw new ChatgptPlanError('vault_unavailable', 'ChatGPT credential storage could not open. Existing credentials were kept; repair the Mac runtime before retrying.')
  }
}
export function chatgptPlanAccounts(userId: string): ChatgptPlanAccountSummary[] {
  if (!chatgptPlanEligibility().eligible) return []
  return getChatgptPlanRuntime().vault.list(userId).map(({ id, email, state, revocationStatus }) => ({ id, email, state, revocationStatus }))
}
export function cancelChatgptPlanSignIn(userId: string) { host.__batshitChatgptPlanRuntime?.oauth.cancel(userId) }

// This gate is for browser connection management only. Native-tool, service,
// n8n and model-provided identity never substitutes for a signed-in session.
export function assertChatgptPlanManagement(request: Request, locals: App.Locals) {
  const eligibility = chatgptPlanEligibility()
  if (!eligibility.eligible) throw new ChatgptPlanError('runtime_ineligible', eligibility.message)
  if (!locals.user?.id || !locals.session?.token || locals.session.user_id !== locals.user.id || Date.parse(locals.session.expires_at) <= Date.now() || !Number.isFinite(Date.parse(locals.session.expires_at))) throw new ChatgptPlanError('session_required', 'Sign in to Batshit before managing ChatGPT.')
  if (new URL(request.url).origin !== eligibility.origin || request.headers.get('Origin') !== eligibility.origin) throw new ChatgptPlanError('origin_required', 'Manage ChatGPT from the local Batshit Mac app.')
  return { userId: locals.user.id, sessionToken: locals.session.token }
}
