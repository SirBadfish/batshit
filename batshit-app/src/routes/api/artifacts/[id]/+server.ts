import { json, error, isHttpError, isRedirect, type RequestHandler } from '@sveltejs/kit';
import { apiError, serviceRefusalResponse } from '$lib/server/services/apiResponses'
import { ArtifactsService } from '$lib/server/artifacts/artifactsService';
import {
  isOpaqueArtifactRuntimeRequest,
  requireArtifactRuntimeClaims,
  resolveArtifactRuntimeClaims
} from '$lib/server/services/artifactRuntimeAuth'

export const GET: RequestHandler = async ({ params, locals, request }) => {
  const { id } = params;
  
  if (!id) {
    throw error(400, 'Artifact ID is required');
  }
  
  const runtimeClaims = isOpaqueArtifactRuntimeRequest(request)
    ? await requireArtifactRuntimeClaims(request, id)
    : await resolveArtifactRuntimeClaims(request, id)
  const userId = runtimeClaims?.userId ?? locals.user?.id

  // Check authentication
  if (!userId) {
    return apiError('Unauthorized', 401)
  }
  
  try {
    const artifactsService = new ArtifactsService();
    const artifact = await artifactsService.getAccessible(id, userId);

    if (!artifact) {
      throw error(404, 'Artifact not found or access denied');
    }

    return json(artifact);
    
  } catch (err) {
    // A refusal (not found, access denied, a structure or field-name rule) answers with its own
    // status and sentence; SvelteKit turned the rethrown refusal into 500 "Internal Error" (BL-89).
    const refusal = serviceRefusalResponse(err);
    if (refusal) {
      console.warn('Artifact get refused:', err instanceof Error ? err.message.split('\n')[0] : err);
      return refusal;
    }
    if (isHttpError(err) || isRedirect(err)) throw err;

    console.error('Failed to get artifact:', err);
    throw error(500, 'Failed to get artifact');
  }
};

export const PUT: RequestHandler = async ({ params, request, locals }) => {
  const { id } = params;
  
  if (!id) {
    throw error(400, 'Artifact ID is required');
  }
  
  // Check authentication
  if (!locals.user?.id) {
    return apiError('Unauthorized', 401)
  }
  
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return apiError('An artifact update must be a JSON object.', 400)
    }
    // BL-546: a content save names the version its edit was made on; the service refuses it
    // (409 ARTIFACT_VERSION_CONFLICT) when the stored version is another one.
    const { baseVersion, ...updates } = body as Record<string, unknown>;
    if (baseVersion !== undefined && !(Number.isInteger(baseVersion) && (baseVersion as number) >= 0)) {
      return apiError('baseVersion must be a whole number (the artifact version the edit was made on).', 400)
    }
    const artifactsService = new ArtifactsService();
    const updatedArtifact = await artifactsService.update(
      id,
      locals.user.id,
      updates,
      baseVersion === undefined ? {} : { expectedVersion: baseVersion as number }
    );
    return json(updatedArtifact);
    
  } catch (err) {
    // A refusal (not found, access denied, a structure or field-name rule) answers with its own
    // status and sentence; SvelteKit turned the rethrown refusal into 500 "Internal Error" (BL-89).
    const refusal = serviceRefusalResponse(err);
    if (refusal) {
      console.warn('Artifact update refused:', err instanceof Error ? err.message.split('\n')[0] : err);
      return refusal;
    }
    if (isHttpError(err) || isRedirect(err)) throw err;

    console.error('Failed to update artifact:', err);
    throw error(500, 'Failed to update artifact');
  }
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const { id } = params;
  
  if (!id) {
    throw error(400, 'Artifact ID is required');
  }
  
  // Check authentication
  if (!locals.user?.id) {
    return apiError('Unauthorized', 401)
  }
  
  try {
    const artifactsService = new ArtifactsService();
    await artifactsService.delete(id, locals.user.id);
    return json({ success: true });
    
  } catch (err) {
    // A refusal (not found, access denied, a structure or field-name rule) answers with its own
    // status and sentence; SvelteKit turned the rethrown refusal into 500 "Internal Error" (BL-89).
    const refusal = serviceRefusalResponse(err);
    if (refusal) {
      console.warn('Artifact delete refused:', err instanceof Error ? err.message.split('\n')[0] : err);
      return refusal;
    }
    if (isHttpError(err) || isRedirect(err)) throw err;

    console.error('Failed to delete artifact:', err);
    throw error(500, 'Failed to delete artifact');
  }
};
