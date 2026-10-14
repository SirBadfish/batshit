import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { authService, resolveSessionCookieName } from '$lib/services/auth.server'
import { cancelChatgptPlanSignIn } from '$lib/server/services/chatgptPlanHost'

export const POST: RequestHandler = async ({ cookies }) => {
	const sessionCookieName = resolveSessionCookieName()
	const token = cookies.get(sessionCookieName)
	
	if (token) {
		const session = await authService.getSession(token)
		// OAuth cancellation is best effort after its controller is aborted. A
		// custody failure must never prevent the user's Redis session deletion.
		if (session) { try { cancelChatgptPlanSignIn(session.user_id) } catch { /* The user is still signed out below. */ } }
		// Delete session from Redis
		await authService.deleteSession(token)
		
		// Delete cookie
		cookies.delete(sessionCookieName, { path: '/' })
	}
	
	return json({ success: true })
}
