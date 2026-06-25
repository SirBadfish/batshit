import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { apiKeyService } from '$lib/services/apiKey.server';

// POST: Test/validate an API key
export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const userId = locals.user?.id;

    if (!userId) {
      return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { service, apiKey } = await request.json();

    if (!service || !apiKey) {
      return json({
        success: false,
        error: 'Service and API key are required'
      }, { status: 400 });
    }

    // Validate with rate limiting
    const validationResult = await apiKeyService.validateWithRateLimit(service, apiKey, userId);

    if (!validationResult.valid) {
      // Check if it's rate limiting
      if (validationResult.retryAfter !== undefined) {
        return json({
          success: false,
          error: validationResult.error,
          retryAfter: validationResult.retryAfter
        }, { status: 429 }); // Too Many Requests
      }

      return json({
        success: false,
        error: validationResult.error || 'Invalid API key format'
      }, { status: 400 });
    }

    const testResult = await apiKeyService.testApiKey(service, apiKey);

    if (!testResult.success) {
      return json({
        success: false,
        error: testResult.error || 'API key validation failed'
      }, { status: 400 });
    }

    return json({
      success: true,
      formatValid: testResult.formatValid,
      verified: testResult.verified,
      message: testResult.message || 'API key format looks valid. Provider connectivity was not checked.'
    });
  } catch (error: any) {
    console.error('Failed to test API key:', error);
    return json({
      success: false,
      error: error.message || 'Failed to test API key'
    }, { status: 500 });
  }
};
