import { redirect } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'
import { readClaudeContextEnvironment } from '$lib/utils/cliContextWindow'

export const load: PageServerLoad = async ({ locals, url }) => {
  // Redirect to login if not authenticated
  if (!locals.user) {
    throw redirect(303, `/login?returnUrl=${encodeURIComponent(url.pathname)}`)
  }
  
  return { claudeContextEnvironment: readClaudeContextEnvironment() }
}
