import { json } from '@sveltejs/kit'
import { getUpdateStatus } from '$lib/server/services/updateStatusService'
import { requireUser } from '$lib/server/services/routeSecurity'

export const GET = async ({ locals, url }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  const force = url.searchParams.get('force') === '1'
  return json(await getUpdateStatus({ force }))
}
