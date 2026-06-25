import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { authService, resolveSessionCookieName } from '$lib/services/auth.server'

export const POST: RequestHandler = async ({ cookies }) => {
	const sessionCookieName = resolveSessionCookieName()
	const token = cookies.get(sessionCookieName)
	
	if (token) {
		// Delete session from Redis
		await authService.deleteSession(token)
		
		// Delete cookie
		cookies.delete(sessionCookieName, { path: '/' })
	}
	
	return json({ success: true })
}
