import { json, type RequestHandler } from '@sveltejs/kit'
import { requireUser } from '$lib/server/services/routeSecurity'
import { pinokioMachineService } from '$lib/server/services/pinokioMachineService'
import { pinokioMachineFailure, pinokioMachineSessionRefusal, readPinokioMachineBody } from '$lib/server/services/pinokioMachineRoutes'

export const GET: RequestHandler = async ({ request, url, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  const refused = pinokioMachineSessionRefusal(request, url)
  if (refused) return refused
  try {
    return json({ machines: await pinokioMachineService.list(user.value.id) })
  } catch (error) {
    return pinokioMachineFailure(error)
  }
}

export const POST: RequestHandler = async ({ request, url, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  const refused = pinokioMachineSessionRefusal(request, url)
  if (refused) return refused
  try {
    return json({ machine: await pinokioMachineService.create(user.value.id, await readPinokioMachineBody(request)) })
  } catch (error) {
    return pinokioMachineFailure(error)
  }
}
