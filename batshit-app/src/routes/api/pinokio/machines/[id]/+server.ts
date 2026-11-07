import { json, type RequestHandler } from '@sveltejs/kit'
import { requireUser } from '$lib/server/services/routeSecurity'
import { PinokioMachineError, pinokioMachineService } from '$lib/server/services/pinokioMachineService'
import { pinokioMachineFailure, pinokioMachineSessionRefusal, readPinokioMachineBody } from '$lib/server/services/pinokioMachineRoutes'

export const PUT: RequestHandler = async ({ request, url, locals, params }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  const refused = pinokioMachineSessionRefusal(request, url)
  if (refused) return refused
  try {
    return json({ machine: await pinokioMachineService.update(user.value.id, params.id ?? '', await readPinokioMachineBody(request)) })
  } catch (error) {
    return pinokioMachineFailure(error)
  }
}

export const DELETE: RequestHandler = async ({ request, url, locals, params }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  const refused = pinokioMachineSessionRefusal(request, url)
  if (refused) return refused
  try {
    const body = await readPinokioMachineBody(request)
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'expectedVersion')) {
      throw new PinokioMachineError('pinokio_machine_invalid', 'Send only the connection’s expectedVersion to remove it.')
    }
    await pinokioMachineService.remove(user.value.id, params.id ?? '', (body as { expectedVersion?: unknown }).expectedVersion)
    return json({ success: true })
  } catch (error) {
    return pinokioMachineFailure(error)
  }
}
