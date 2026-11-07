import { json, type RequestHandler } from '@sveltejs/kit'
import { requireUser } from '$lib/server/services/routeSecurity'
import { loadPinokioArtifactForUser } from '$lib/server/artifacts/pinokioArtifactAccess'
import { previewPinokioAppStart, startPinokioApp, pinokioAppIdProblem, type PinokioOutcome } from '$lib/server/services/pinokioService'
import { forgetPinokioAppEndpoint, resolvePinokioAppEndpoint } from '$lib/server/services/pinokioAppEndpoint'

import { pinokioMachineService, PinokioMachineError } from '$lib/server/services/pinokioMachineService'
import { ownPinokioOperation, pinokioBindingFingerprint, pinokioLocalPreviewFingerprint, PinokioAdmissionError } from '$lib/server/services/pinokioAdmission'
import { redis } from '$lib/server/redis'

/**
 * SA-072 P2 (DL-03, DL-10): "Start with Pinokio" from a Pinokio app artifact's panel.
 *
 * The security design, because this route makes Batshit run a program (`pterm run`):
 *
 * - The user's click is the approval. The artifact's iframe cannot call this route: it has an
 *   opaque origin, so the session cookie is not sent and the browser's CORS preflight for a
 *   JSON POST fails. The iframe only ASKS Batshit's own page (a `postMessage` the page checks
 *   against the iframe it rendered), and the page shows its own confirm dialog, naming the app
 *   and every app the start also starts, before it calls here.
 * - Signed-in session only: a service token, a run credential, or an artifact runtime token is
 *   refused, so no agent lane reaches it (agents start apps through `sys.pinokio.run` and its
 *   Approve card). A cross-site request is refused by its `Origin`.
 * - The app comes from the artifact's saved metadata, never from the request, so a button can
 *   start only the app its artifact is bound to.
 * - The start itself is `startPinokioApp`, with all six P1 run rules (installed app folder under
 *   `<home>/api/` only, never `pterm run` on a running app, the `alsoStarts` chain matched
 *   exactly, SIGKILL only, the 45 s wait). Nothing is installed, stopped, or deleted.
 *
 * GET answers what a start would do (the dialog's words); POST starts it.
 */

type NoStartEffect = 'not_sent'
function refuseNonSessionCaller(request: Request, url: URL, startEffect?: NoStartEffect): Response | null {
  if (request.headers.get('authorization') || request.headers.get('x-batshit-token')) {
    return json({ success: false, error: 'Only the signed-in Batshit page can start a Pinokio app here.', startEffect }, { status: 403 })
  }
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== url.origin) {
    return json({ success: false, error: 'Cross-site requests cannot start a Pinokio app.', startEffect }, { status: 403 })
  }
  return null
}

type MachineScope = { machineId: string; machineRevision: number; machineLabel: string }
function failure(outcome: Exclude<PinokioOutcome<unknown>, { ok: true }>, scope?: MachineScope, startEffect?: NoStartEffect): Response {
  const status = outcome.kind === 'unavailable' ? 503 : outcome.kind === 'not_found' ? 404 : outcome.kind === 'refused' ? 400 : 502
  return json({ success: false, error: outcome.message, kind: outcome.kind, reason: outcome.reason ?? null, code: outcome.code, startEffect, ...scope }, { status })
}
function knownFailure(error: unknown, scope?: MachineScope, startEffect?: NoStartEffect): Response {
  if (error instanceof PinokioMachineError || error instanceof PinokioAdmissionError) {
    return json({ success: false, code: error.code, error: error.message, startEffect, ...scope }, { status: error.status })
  }
  return json({ success: false, code: 'pinokio_start_error', error: 'Batshit could not complete this Pinokio request.', startEffect, ...scope }, { status: 502 })
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function bad(message: string): never { throw new PinokioAdmissionError('pinokio_preview_changed', message, 409) }

export const GET: RequestHandler = async ({ locals, request, url }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  const refused = refuseNonSessionCaller(request, url)
  if (refused) return refused
  let scope: MachineScope | undefined
  try {
    const artifactId = url.searchParams.get('artifactId')
    const access = await loadPinokioArtifactForUser(artifactId, user.value.id)
    if (!access.ok) return json({ success: false, error: access.message, code: access.code }, { status: access.status })
    const fingerprint = pinokioBindingFingerprint(access.artifact)
    const machine = await pinokioMachineService.resolveCurrent(user.value.id, access.binding.machineId)
    scope = { machineId: machine.id, machineRevision: machine.revision, machineLabel: machine.label }
    const target = machine.kind === 'remote' ? { userId: user.value.id, machineId: machine.id, revision: machine.revision, signal: request.signal } : {}
    const preview = await previewPinokioAppStart({ ...target, appId: access.binding.appId })
    if (!preview.ok) return failure(preview, scope)
    let endpointReady: boolean | undefined
    if (machine.kind === 'remote') {
      endpointReady = false
      if (preview.value.state === 'online') {
        const endpoint = await resolvePinokioAppEndpoint(access.binding.appId, target)
        endpointReady = endpoint.ok && endpoint.machineId === machine.id && endpoint.machineRevision === machine.revision && typeof endpoint.fetch === 'function'
      }
      await pinokioMachineService.resolve(user.value.id, { machineId: machine.id, revision: machine.revision })
    }
    const current = await loadPinokioArtifactForUser(artifactId, user.value.id)
    if (!current.ok || pinokioBindingFingerprint(current.artifact) !== fingerprint) bad('This artifact changed during preview. Read its saved binding again.')
    return json({ success: true, artifactName: access.artifact.name, ...preview.value, ...scope,
      launchFingerprint: machine.kind === 'remote' ? preview.value.launchFingerprint : pinokioLocalPreviewFingerprint(fingerprint, preview.value),
      bindingFingerprint: fingerprint, ...(endpointReady !== undefined ? { endpointReady } : {}) })
  } catch (error) { return knownFailure(error, scope) }
}

export const POST: RequestHandler = async ({ locals, request, url }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  const refused = refuseNonSessionCaller(request, url, 'not_sent')
  if (refused) return refused
  if (!(request.headers.get('content-type') || '').includes('application/json')) return json({ success: false, error: 'Send JSON.', startEffect: 'not_sent' }, { status: 415 })
  let scope: MachineScope | undefined
  // Entry into the start service is the uncertainty boundary. Neither its failure status
  // nor a later exception proves whether the local/native action was already submitted.
  let startEntered = false
  try {
    const body: unknown = await request.json().catch(() => null)
    if (!record(body)) throw new PinokioAdmissionError('pinokio_start_input', 'Send a Pinokio start JSON object.', 400)
    const access = await loadPinokioArtifactForUser(typeof body.artifactId === 'string' ? body.artifactId : null, user.value.id)
    if (!access.ok) return json({ success: false, error: access.message, code: access.code, startEffect: 'not_sent' }, { status: access.status })
    const bindingFingerprint = pinokioBindingFingerprint(access.artifact)
    const machineId = access.binding.machineId ?? 'local'
    if (body.machineId !== machineId || body.bindingFingerprint !== bindingFingerprint ||
      typeof body.launchFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(body.launchFingerprint) ||
      !Number.isSafeInteger(body.revision)) {
      bad('This start needs its current saved-binding and launch preview. Refresh the artifact and confirm its Pinokio start again.')
    }
    if (body.alsoStarts !== undefined && (!Array.isArray(body.alsoStarts) || body.alsoStarts.length > 64 || body.alsoStarts.some((id) => typeof id !== 'string' || pinokioAppIdProblem(id)))) {
      throw new PinokioAdmissionError('pinokio_start_input', 'alsoStarts must name only installed app folder IDs.', 400)
    }
    const alsoStarts = (body.alsoStarts ?? []) as string[]
    const appId = access.binding.appId
    if (machineId === 'local') {
      if (body.revision !== 0) bad('The built-in local Pinokio computer uses revision zero.')
      const current = await previewPinokioAppStart({ appId })
      if (!current.ok) return failure(current, undefined, 'not_sent')
      if (body.launchFingerprint !== pinokioLocalPreviewFingerprint(bindingFingerprint, current.value)) {
        bad('This local start’s observed requirements changed after preview. Confirm its saved binding again.')
      }
      const fresh = await loadPinokioArtifactForUser(access.artifact.id, user.value.id)
      if (!fresh.ok || pinokioBindingFingerprint(fresh.artifact) !== bindingFingerprint) bad('The saved local artifact changed while its start was being checked.')
      startEntered = true
      const result = await startPinokioApp({ appId, alsoStarts })
      if (!result.ok) return failure(result)
      forgetPinokioAppEndpoint(appId)
      return json({ success: true, ...result.value, machineId: 'local', machineRevision: 0, machineLabel: 'This computer' })
    }
    if (body.machineId !== machineId || body.bindingFingerprint !== bindingFingerprint ||
      !Number.isSafeInteger(body.revision) || !(typeof body.revision === 'number' && body.revision > 0) ||
      typeof body.launchFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(body.launchFingerprint)) {
      bad('A remote start must echo this artifact’s fresh computer revision, launch fingerprint and saved-binding preview.')
    }
    const revision = body.revision as number
    const machine = await pinokioMachineService.resolve(user.value.id, { machineId, revision })
    scope = { machineId: machine.id, machineRevision: machine.revision, machineLabel: machine.label }
    const operation = ownPinokioOperation({ signal: request.signal, admit: async () => {
      const owner = await redis.json.get(`user:${user.value.id}:data`, '$.id')
      if (!Array.isArray(owner) || owner.length !== 1 || owner[0] !== user.value.id) bad('The start’s signed-in owner is no longer available.')
      const fresh = await loadPinokioArtifactForUser(access.artifact.id, user.value.id)
      if (!fresh.ok || pinokioBindingFingerprint(fresh.artifact) !== bindingFingerprint) bad('The artifact was deleted, changed owners or rebound. No further native request was sent.')
      await pinokioMachineService.resolve(user.value.id, { machineId, revision })
    } })
    try {
      await operation.assert()
      console.info(`[pinokio] panel native start of ${appId} on saved computer ${machineId} for artifact ${access.artifact.id}`)
      startEntered = true
      const result = await startPinokioApp({ userId: user.value.id, appId, machineId, revision, alsoStarts,
        launchFingerprint: body.launchFingerprint as string, signal: operation.signal,
        admitStart: async () => { try { await operation.assert(); return true } catch { return false } } })
      if (!result.ok) return failure(result, scope)
      if (result.value.appId !== appId || result.value.machineId !== machineId || result.value.machineRevision !== revision) {
        return json({ success: false, code: 'pinokio_start_unknown', error: 'The native start response did not match the approved target. Its outcome is unknown; do not resend it.', ...scope }, { status: 502 })
      }
      forgetPinokioAppEndpoint()
      let endpointReady = false
      if (!result.value.nativeControlOutcome && !result.value.observationEnded && result.value.launchState !== 'unknown') {
        try {
          await operation.assert()
          const endpoint = await resolvePinokioAppEndpoint(appId, { userId: user.value.id, machineId, revision, signal: operation.signal, admitFetch: operation.assert })
          endpointReady = endpoint.ok && endpoint.machineId === machineId && endpoint.machineRevision === revision && typeof endpoint.fetch === 'function'
        } catch { /* The issued native outcome remains factual; lost read authority is not a new start. */ }
      }
      return json({ success: true, ...scope, ...result.value, endpointReady })
    } finally { operation.close() }
  } catch (error) { return knownFailure(error, scope, startEntered ? undefined : 'not_sent') }
}
