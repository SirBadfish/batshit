import { json, type RequestHandler } from '@sveltejs/kit'
import { assertChatgptPlanManagement, chatgptPlanAccounts, chatgptPlanEligibility, getChatgptPlanRuntime } from '$lib/server/services/chatgptPlanHost'
import { ChatgptPlanError } from '$lib/server/services/chatgptPlanVault'
import { planDiagnostic } from '$lib/server/services/chatgptPlanOAuth'
import { PLAN_CATALOG } from '$lib/server/services/chatgptPlanRuntime'

const headers = { 'Cache-Control': 'no-store' }
// All management uses POST so browsers supply Origin even for status reads.
export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const identity = assertChatgptPlanManagement(request, locals)
    const body = await request.json()
    const runtime = getChatgptPlanRuntime()
    switch (body.action) {
      case 'status': return json({ ...chatgptPlanEligibility(), root: undefined, accounts: chatgptPlanAccounts(identity.userId), attempt: runtime.oauth.status(identity.userId) }, { headers })
      case 'start': {
        if (body.accountId !== undefined && typeof body.accountId !== 'string') throw new ChatgptPlanError('account_required', 'Select the ChatGPT account to reconnect.')
        return json({ authorizationUrl: await runtime.oauth.start(identity.userId, identity.sessionToken, body.accountId) }, { headers })
      }
      case 'cancel': runtime.oauth.cancel(identity.userId); return json({ success: true }, { headers })
      case 'disconnect': {
        if (typeof body.accountId !== 'string') throw new ChatgptPlanError('account_required', 'Select the ChatGPT account to disconnect.')
        const result = await runtime.disconnect(identity.userId, body.accountId)
        return json(result, { headers })
      }
      case 'models': {
        if (typeof body.accountId !== 'string') throw new ChatgptPlanError('account_required', 'Select a connected ChatGPT account.')
        const lease = runtime.acquire(identity.userId, body.accountId, PLAN_CATALOG)
        try { return json({ models: await runtime.models(lease) }, { headers }) } finally { lease.release() }
      }
      default: throw new ChatgptPlanError('action_invalid', 'This ChatGPT connection action is unavailable.')
    }
  } catch (error) {
    const diagnostic = planDiagnostic(error)
    return json({ error: diagnostic.message, code: diagnostic.code }, { status: diagnostic.code === 'session_required' ? 401 : diagnostic.code === 'origin_required' ? 403 : 409, headers })
  }
}
