import { json } from '@sveltejs/kit'
import { PinokioMachineError } from './pinokioMachineService'

/** Connection settings belong to the signed-in page, never an agent/runtime/service credential. */
export function pinokioMachineSessionRefusal(request: Request, url: URL): Response | null {
  const nonSessionHeaders = ['authorization', 'x-batshit-token', 'x-batshit-service-token', 'x-batshit-agent-token', 'x-batshit-portable-token']
  if (nonSessionHeaders.some((header) => request.headers.has(header))) {
    return json({ success: false, code: 'pinokio_machine_session_required', error: 'Only the signed-in Batshit page can change or read Pinokio connections here.' }, { status: 403 })
  }
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== url.origin) {
    return json({ success: false, code: 'pinokio_machine_origin_refused', error: 'Cross-site requests cannot access Pinokio connections.' }, { status: 403 })
  }
  return null
}

export async function readPinokioMachineBody(request: Request): Promise<unknown> {
  if (!(request.headers.get('content-type') || '').toLowerCase().includes('application/json')) {
    throw new PinokioMachineError('pinokio_machine_json_required', 'Send the Pinokio connection as JSON.', 415)
  }
  try {
    return await request.json()
  } catch {
    throw new PinokioMachineError('pinokio_machine_invalid', 'Send a valid Pinokio connection JSON object.')
  }
}

export function pinokioMachineFailure(error: unknown): Response {
  if (error instanceof PinokioMachineError) {
    return json({ success: false, code: error.code, error: error.message }, { status: error.status })
  }
  console.error('[pinokio] Connection settings operation failed.')
  return json({ success: false, code: 'pinokio_machine_storage_failed', error: 'Batshit could not confirm the Pinokio connection operation. Reload the saved connections before trying again.' }, { status: 500 })
}
