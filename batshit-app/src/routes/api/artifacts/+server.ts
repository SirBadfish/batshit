import { json, error, isHttpError, isRedirect, type RequestHandler } from '@sveltejs/kit';
import { apiError, serviceRefusalResponse } from '$lib/server/services/apiResponses'
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
    // A refusal (a structure or field-name rule, a bad preset) answers with its own status and
    // sentence; SvelteKit turned the rethrown refusal into 500 "Internal Error" (BL-89).
    const refusal = serviceRefusalResponse(err);
    if (refusal) {
      console.warn('Artifact create refused:', err instanceof Error ? err.message.split('\n')[0] : err);
      return refusal;
    }
    if (isHttpError(err) || isRedirect(err)) throw err;

    console.error('Failed to create artifact:', err);
    throw error(500, 'Failed to create artifact');
  }
};
