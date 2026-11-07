import type { RequestHandler } from '@sveltejs/kit'
import { receiveChatgptPlanCallback, refusedChatgptPlanCallback } from '$lib/server/services/chatgptPlanHost'

// State/PKCE and the retained initiating session own this server-only endpoint.
// Never log the request URL, redirect query, or a raw callback exception.
export const GET: RequestHandler = ({ request }) => {
  try { return receiveChatgptPlanCallback(request) } catch { return refusedChatgptPlanCallback() }
}
