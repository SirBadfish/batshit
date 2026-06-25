import type { User, Session } from '$lib/services/auth.server'

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			user: User | null
			session: Session | null
		}
		interface PageData {
			user: User | null
			userSettings?: any
			internalDevPanelEnabled?: boolean
		}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
