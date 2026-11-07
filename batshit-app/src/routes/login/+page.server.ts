import { redirect, fail } from '@sveltejs/kit'
import type { Actions, PageServerLoad } from './$types'
import { authService, resolveSessionCookieName, resolveSessionCookieSecure } from '$lib/services/auth.server'

export const load: PageServerLoad = async ({ locals, url }) => {
	// If already logged in, redirect to home
	if (locals.user) {
		throw redirect(303, '/')
	}

	// Check if this is the first run (no users)
	const hasUsers = await authService.hasUsers()
	if (!hasUsers) {
		throw redirect(303, '/setup')
	}

	return {
		returnUrl: url.searchParams.get('returnUrl') || '/'
	}
}

export const actions = {
	login: async ({ request, cookies, url }) => {
		const data = await request.formData()
		const email = data.get('email') as string
		const password = data.get('password') as string
		const rememberMe = data.get('remember') === 'on'

		if (!email || !password) {
			return fail(400, { 
				error: 'Email and password are required',
				email 
			})
		}

		let authenticated = false
		try {
			// Authenticate user
			const user = await authService.authenticate(email, password)
			
			if (!user) {
				return fail(401, { 
					error: 'Invalid email or password',
					email 
				})
			}

			// Create session
			authenticated = true
			const session = await authService.createSession(user, rememberMe)

			// Set session cookie
			cookies.set(resolveSessionCookieName(), session.token, {
				path: '/',
				httpOnly: true,
				secure: resolveSessionCookieSecure(),
				sameSite: 'lax',
				maxAge: rememberMe ? 30 * 24 * 60 * 60 : undefined // 30 days if remember me
			})

			const returnUrl = url.searchParams.get('returnUrl') || '/'
			throw redirect(303, returnUrl)
		} catch (error) {
			// In SvelteKit, redirect throws a special Redirect object
			if (error && typeof error === 'object' && 'status' in error && 'location' in error) {
				throw error; // Re-throw the redirect
			}
			return fail(authenticated ? 503 : 401, {
				error: authenticated
					? 'Your account was authenticated and kept, but Batshit could not finish signing you in safely. Check the app logs and repair the problem, then sign in again. Your saved access was not reset.'
					: error instanceof Error ? error.message : 'Login failed',
				email 
			})
		}
	}
} satisfies Actions
