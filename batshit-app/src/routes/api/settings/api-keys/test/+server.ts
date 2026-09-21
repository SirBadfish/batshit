import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { apiKeyService, normalizeApiKeyServiceName } from '$lib/services/apiKey.server';
import { testTypesafeKey } from '$lib/server/services/typesafe/typesafeKeyTest';

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

    // SA-120 (Josh, 2026-09-17): the TypeSafe key is the one key Batshit really tests, with one
    // fixed sample question to Jev, so the API Keys row's Test button proves the key works. It
    // lives HERE, in the route, and not in apiKeyService: the key service is reachable from the
    // Fabric risk gate's modules, and those must never be able to reach the Jev client
    // (DL-120-12, `jevNeverApproves.pinning.test.ts`).
    if (normalizeApiKeyServiceName(service) === 'typesafe') {
      const jev = await testTypesafeKey(apiKey.trim());
      if (!jev.ok) {
        return json({ success: false, error: jev.error }, { status: 400 });
      }
      return json({ success: true, formatValid: true, verified: true, message: jev.message });
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
