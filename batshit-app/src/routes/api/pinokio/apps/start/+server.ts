import { json, type RequestHandler } from '@sveltejs/kit'
import { requireUser } from '$lib/server/services/routeSecurity'
import { loadPinokioArtifactForUser } from '$lib/server/artifacts/pinokioArtifactAccess'
import { previewPinokioAppStart, startPinokioApp, type PinokioOutcome } from '$lib/server/services/pinokioService'
import { forgetPinokioAppEndpoint } from '$lib/server/services/pinokioAppEndpoint'

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

function refuseNonSessionCaller(request: Request, url: URL): Response | null {
  if (request.headers.get('authorization') || request.headers.get('x-batshit-token')) {
    return json({ success: false, error: 'Only the signed-in Batshit page can start a Pinokio app here.' }, { status: 403 })
  }
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== url.origin) {
    return json({ success: false, error: 'Cross-site requests cannot start a Pinokio app.' }, { status: 403 })
  }
  return null
}

function failure(outcome: Exclude<PinokioOutcome<unknown>, { ok: true }>): Response {
  const status = outcome.kind === 'unavailable' ? 503 : outcome.kind === 'not_found' ? 404 : outcome.kind === 'refused' ? 400 : 502
  return json({ success: false, error: outcome.message, kind: outcome.kind, reason: outcome.reason ?? null }, { status })
}

export const GET: RequestHandler = async ({ locals, request, url }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  const refused = refuseNonSessionCaller(request, url)
  if (refused) return refused
  const access = await loadPinokioArtifactForUser(url.searchParams.get('artifactId'), user.value.id)
  if (!access.ok) return json({ success: false, error: access.message, code: access.code }, { status: access.status })
  const preview = await previewPinokioAppStart({ appId: access.binding.appId })
  if (!preview.ok) return failure(preview)
  return json({ success: true, artifactName: access.artifact.name, ...preview.value })
}

export const POST: RequestHandler = async ({ locals, request, url }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  const refused = refuseNonSessionCaller(request, url)
  if (refused) return refused
  if (!(request.headers.get('content-type') || '').includes('application/json')) {
    return json({ success: false, error: 'Send JSON.' }, { status: 415 })
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const access = await loadPinokioArtifactForUser(typeof body?.artifactId === 'string' ? body.artifactId : null, user.value.id)
  if (!access.ok) return json({ success: false, error: access.message, code: access.code }, { status: access.status })
  const alsoStarts = Array.isArray(body?.alsoStarts)
    ? body.alsoStarts.filter((entry): entry is string => typeof entry === 'string')
    : []

  const appId = access.binding.appId
  console.info(`[pinokio] panel start of ${appId} for artifact ${access.artifact.id} (the user confirmed it in Batshit)`)
  const result = await startPinokioApp({ appId, alsoStarts })
  if (!result.ok) {
    console.warn(`[pinokio] panel start of ${appId} failed: ${result.message}`)
    return failure(result)
  }
  forgetPinokioAppEndpoint(appId)
  console.info(`[pinokio] panel start of ${appId}: ${result.value.ready ? 'ready' : result.value.state} after ${result.value.waitedMs} ms`)
  return json({ success: true, ...result.value })
}
