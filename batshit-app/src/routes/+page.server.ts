import { redirect } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ locals, url }) => {
  // Redirect to login if not authenticated
  if (!locals.user) {
    throw redirect(303, `/login?returnUrl=${encodeURIComponent(url.pathname)}`)
  }
  
  return {}
}