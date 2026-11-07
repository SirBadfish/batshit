import { json, type RequestHandler } from '@sveltejs/kit'
import { requireUser } from '$lib/server/services/routeSecurity'
import { detectPinokio, getPinokioTargetStatus } from '$lib/server/services/pinokioService'
import { pinokioMachineService } from '$lib/server/services/pinokioMachineService'
import { pinokioTargetFromQuery, PinokioAdmissionError } from '$lib/server/services/pinokioAdmission'

/**
 * SA-072 P1: the one read-only Pinokio line in Settings → Admin → Runtimes. Detection only:
 * no setting, nothing started, and the same words `sys.pinokio.status` gives an agent.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  try {
    const selection = pinokioTargetFromQuery(url.searchParams)
    let machines: Array<{ id: string; label: string; revision: number; bindingState: string }> | null = null
    let machinesError: { code: string; message: string } | undefined
    try { machines = (await pinokioMachineService.list(user.value.id)).map(({ id, label, revision, bindingState }) => ({ id, label, revision, bindingState })) }
    catch { machinesError = { code: 'pinokio_machine_registry_unavailable', message: 'Batshit could not read the saved Pinokio computers. Retry.' } }
    if (selection.machineId !== undefined) {
      const target = await getPinokioTargetStatus({ ...selection, userId: user.value.id })
      const pinokio = target.ok ? target.value : { available: false, kind: selection.machineId === 'local' ? 'local' : 'remote', machineId: selection.machineId, machineRevision: selection.revision, code: target.code, message: target.message }
      return json({ pinokio, machines, ...(machinesError ? { machinesError } : {}) })
    }
    const pinokio = await detectPinokio({ fresh: url.searchParams.get('fresh') === '1' })
    return json({ pinokio, machines, ...(machinesError ? { machinesError } : {}) })
  } catch (error) {
    if (error instanceof PinokioAdmissionError) return json({ error: error.message, code: error.code }, { status: error.status })
    console.error('[pinokio] Status check failed:', error)
    return json({ error: 'Batshit could not check for Pinokio.' }, { status: 500 })
  }
}
