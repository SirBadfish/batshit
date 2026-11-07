import { json, type RequestHandler } from '@sveltejs/kit'
import { requireUser } from '$lib/server/services/routeSecurity'
import { searchPinokioApps } from '$lib/server/services/pinokioService'
import { pinokioMachineService, PinokioMachineError } from '$lib/server/services/pinokioMachineService'
import { pinokioTargetFromQuery, PinokioAdmissionError } from '$lib/server/services/pinokioAdmission'

/**
 * SA-072 P2: the apps installed in Pinokio on this computer, for the Artifact Power Source
 * picker's "Pinokio app" choice. Read-only (`pterm search`, local apps only); nothing starts.
 * When Pinokio is absent or closed the answer says so in the same words as Settings → Admin.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  try {
    const selection = pinokioTargetFromQuery(url.searchParams)
    const machine = selection.revision === undefined
      ? await pinokioMachineService.resolveCurrent(user.value.id, selection.machineId)
      : await pinokioMachineService.resolve(user.value.id, { machineId: selection.machineId!, revision: selection.revision })
    const scope = { machineId: machine.id, machineRevision: machine.revision, machineLabel: machine.label }
    const target = machine.kind === 'remote' ? { machineId: machine.id, revision: machine.revision } : selection
    const result = await searchPinokioApps({ ...target, userId: user.value.id, query: url.searchParams.get('q') ?? undefined })
    if (!result.ok) {
      return json({ ...scope, available: machine.kind === 'local' ? result.kind !== 'unavailable' : false, apps: [], message: result.message, reason: result.reason ?? null, code: result.code ?? result.kind })
    }
    return json({
      available: true,
      ...scope,
      apps: result.value.apps.map((app) => ({ appId: app.appId, title: app.title, state: app.state })),
      message: null
    })
  } catch (error) {
    if (error instanceof PinokioAdmissionError || error instanceof PinokioMachineError) {
      const expectedRevision = Number(url.searchParams.get('revision'))
      return json({ available: false, apps: [], code: error.code, message: error.message,
        ...(url.searchParams.has('machineId') ? { machineId: url.searchParams.get('machineId') } : {}),
        ...(url.searchParams.has('revision') && Number.isSafeInteger(expectedRevision) ? { machineRevision: expectedRevision } : {}) }, { status: error.status })
    }
    console.error('[pinokio] App list failed:', error)
    return json({ error: 'Batshit could not list the Pinokio apps.' }, { status: 500 })
  }
}
