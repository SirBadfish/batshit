/**
 * SA-072 P2: loads the Pinokio app artifact a request names and the app it is bound to.
 *
 * Every Pinokio route takes the app from the ARTIFACT, never from the caller: an artifact's
 * runtime token, its panel, or an agent can reach only the one app its saved metadata names
 * (`metadata.pinokio_app_id`). Owner only: calling or starting a program on this computer is
 * the owner's business even when the artifact is published.
 */

import { ArtifactsService, type ArtifactRecord } from '$lib/server/artifacts/artifactsService'
import { readPinokioArtifactBinding, type PinokioArtifactBinding } from '$lib/artifacts/pinokioArtifact'

export type PinokioArtifactAccess =
  | { ok: true; artifact: ArtifactRecord; binding: PinokioArtifactBinding }
  | { ok: false; status: number; code: string; message: string }

export async function loadPinokioArtifactForUser(
  artifactId: string | null | undefined,
  userId: string
): Promise<PinokioArtifactAccess> {
  const id = typeof artifactId === 'string' ? artifactId.trim() : ''
  if (!id) {
    return { ok: false, status: 400, code: 'artifact_required', message: 'artifactId is required.' }
  }
  const artifact = await new ArtifactsService().getAccessible(id, userId)
  if (!artifact || artifact.user_id !== userId) {
    return { ok: false, status: 404, code: 'artifact_not_found', message: 'Artifact not found.' }
  }
  const binding = readPinokioArtifactBinding(artifact)
  if (!binding) {
    return {
      ok: false,
      status: 400,
      code: 'not_a_pinokio_artifact',
      message: 'This artifact is not a Pinokio app artifact (metadata.runtime_manager "pinokio" with a pinokio_app_id).'
    }
  }
  return { ok: true, artifact, binding }
}
