import { json, error, type RequestHandler } from '@sveltejs/kit';
import { apiError } from '$lib/server/services/apiResponses'
import { ArtifactsService } from '$lib/server/artifacts/artifactsService';

export const GET: RequestHandler = async ({ locals }) => {
  // Check authentication
  if (!locals.user?.id) {
    return apiError('Unauthorized', 401)
  }

  try {
    const artifactsService = new ArtifactsService();
    const artifacts = await artifactsService.listByUser(locals.user.id);
    return json(artifacts);
  } catch (err) {
    console.error('Failed to get artifacts:', err);
    throw error(500, 'Failed to get artifacts');
  }
};

export const POST: RequestHandler = async ({ request, locals }) => {
  // Check authentication
  if (!locals.user?.id) {
    return apiError('Unauthorized', 401)
  }

  try {
    const data = await request.json();
    const artifactsService = new ArtifactsService();
    const artifact = await artifactsService.create(locals.user.id, data);
    return json(artifact);
  } catch (err) {
    console.error('Failed to create artifact:', err);

    if (err && typeof err === 'object' && 'status' in err) {
      throw err;
    }

    throw error(500, 'Failed to create artifact');
  }
};
