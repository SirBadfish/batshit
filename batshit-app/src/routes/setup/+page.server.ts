import { redirect, fail } from '@sveltejs/kit'
import type { Actions, PageServerLoad } from './$types'
import { authService, resolveSessionCookieName, resolveSessionCookieSecure } from '$lib/services/auth.server'

export const load: PageServerLoad = async ({ locals }) => {
	// If already logged in, redirect to home
	if (locals.user) {
		throw redirect(303, '/')
	}

	// Check if users already exist
	const hasUsers = await authService.hasUsers()
	if (hasUsers) {
		throw redirect(303, '/login')
	}

	return {}
}

export const actions = {
	setup: async ({ request, cookies }) => {
		const data = await request.formData()
		const email = data.get('email') as string
		const password = data.get('password') as string
		const confirmPassword = data.get('confirmPassword') as string
		const displayName = data.get('displayName') as string

		// Validation
		if (!email || !password || !displayName) {
			return fail(400, { 
				error: 'All fields are required',
				email,
				displayName 
			})
		}

		if (password !== confirmPassword) {
			return fail(400, { 
				error: 'Passwords do not match',
				email,
				displayName 
			})
		}

		if (password.length < 10) {
			return fail(400, {
				error: 'Password must be at least 10 characters',
				email,
				displayName
			})
		}

		try {
			// Create first user as admin
			const result = await authService.createAdminUser(email, password, displayName)

			// Check for collision error
			if (!result.success || !result.user) {
				return fail(400, {
					error: result.error || 'Failed to create user',
					email,
					displayName
				})
			}

			// Auto-login the new admin
			const session = await authService.createSession(result.user)

			// Set session cookie. createSession() above is non-remember-me (24h
			// Redis TTL), so this must be a browser session cookie — a 30-day
			// maxAge would outlive the server session (G-0236 / PLD-034).
			cookies.set(resolveSessionCookieName(), session.token, {
				path: '/',
				httpOnly: true,
				secure: resolveSessionCookieSecure(),
				sameSite: 'lax',
				maxAge: undefined
			})

			// Success - redirect happens outside try-catch
		} catch (error) {
			return fail(500, {
				error: error instanceof Error ? error.message : 'Setup failed',
				email,
				displayName
			})
		}
		
		// Redirect after successful setup
		throw redirect(303, '/')
	}
} satisfies Actions
