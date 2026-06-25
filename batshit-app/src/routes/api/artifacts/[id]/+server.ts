import { json, error, type RequestHandler } from '@sveltejs/kit';
import { apiError } from '$lib/server/services/apiResponses'
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
    console.error('Failed to get artifact:', err);
    
    if (err && typeof err === 'object' && 'status' in err) {
      throw err;
    }
    
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
    const updates = await request.json();
    const artifactsService = new ArtifactsService();
    const updatedArtifact = await artifactsService.update(id, locals.user.id, updates);
    return json(updatedArtifact);
    
  } catch (err) {
    console.error('Failed to update artifact:', err);
    
    if (err && typeof err === 'object' && 'status' in err) {
      throw err;
    }
    
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
    console.error('Failed to delete artifact:', err);
    
    if (err && typeof err === 'object' && 'status' in err) {
      throw err;
    }
    
    throw error(500, 'Failed to delete artifact');
  }
};
