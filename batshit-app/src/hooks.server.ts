import { type Handle } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { authService, resolveSessionCookieName } from '$lib/services/auth.server'
import { authRateLimiter, apiRateLimiter } from '$lib/middleware/rateLimiter'
import { ensureSkillFilesystemStartup } from '$lib/server/services/skillRegistry'
import { listCoreSystemPrompts } from '$lib/server/services/systemPromptRegistry'
import { isTrustedInternalRequest } from '$lib/server/services/internalRequestAuth'
import { assertApiKeyEncryptionConfigured } from '$lib/services/encryption.server'
import { isAuthRateLimitedPath, shouldApplyBroadApiRateLimit } from '$lib/middleware/rateLimitPolicy'
import { disconnectAllRedisServices } from '$lib/server/redis'
import { cleanupAllMonitoring } from '$lib/server/visualIndicatorService'
import {
  appendArtifactRuntimeCors,
  artifactRuntimeCorsHeaders,
  shouldApplyArtifactRuntimeCors
} from '$lib/server/services/artifactRuntimeAuth'
import {
  hostedVercelAppDisabledResponse,
  shouldBlockHostedVercelAppRequest
} from '$lib/server/services/hostedAppGuard'
import { applyBaselineSecurityHeaders } from '$lib/server/services/securityHeaders'
import { sequence } from '@sveltejs/kit/hooks'

let startupIntegrityInitialized = false

type BatshitRuntimeShutdownGlobal = typeof globalThis & {
  __batshitRuntimeShutdownRegistered?: boolean
  __batshitRuntimeShutdownPromise?: Promise<void> | null
}

const runtimeShutdownGlobal = globalThis as BatshitRuntimeShutdownGlobal

function registerRuntimeShutdownHandler() {
  if (runtimeShutdownGlobal.__batshitRuntimeShutdownRegistered) return
  runtimeShutdownGlobal.__batshitRuntimeShutdownRegistered = true

  process.on('sveltekit:shutdown' as any, (reason: string) => {
    runtimeShutdownGlobal.__batshitRuntimeShutdownPromise ??= closeRuntimeResources(reason)
  })
}

async function closeRuntimeResources(reason: string) {
  try {
    cleanupAllMonitoring()
  } catch (error) {
    console.error('[Shutdown] Failed to clean up visual indicator monitoring:', error)
  }

  const results = await Promise.allSettled([
    authService.disconnect(),
    disconnectAllRedisServices()
  ])

  for (const result of results) {
    if (result.status === 'rejected') {
      console.error(`[Shutdown] Failed to close app runtime resource during ${reason}:`, result.reason)
    }
  }
}

registerRuntimeShutdownHandler()

function isUnsafePlaceholderSecret(value: string): boolean {
  return value.trim().toLowerCase().startsWith('replace-with-')
}

export function assertInternalServiceTokenConfigured() {
  if (env.NODE_ENV !== 'production') return

  const token = (env.BATSHIT_TOKEN || env.MCP_GATEWAY_AUTH_TOKEN || '').trim()
  if (!token || token.length < 32 || isUnsafePlaceholderSecret(token)) {
    throw new Error(
      'BATSHIT_TOKEN must be set to a stable, non-placeholder secret of at least 32 characters before running Batshit in production.'
    )
  }
}

function ensureStartupIntegrityPass() {
  if (startupIntegrityInitialized) return
  startupIntegrityInitialized = true
  assertApiKeyEncryptionConfigured()
  assertInternalServiceTokenConfigured()
  void ensureSkillFilesystemStartup()
  void listCoreSystemPrompts().catch((error) => {
    console.error('[Startup] Failed to seed core system prompt defaults:', error)
  })
}

const hostedVercelAppGuardHandler: Handle = async ({ event, resolve }) => {
  if (shouldBlockHostedVercelAppRequest({ env, url: event.url })) {
    return hostedVercelAppDisabledResponse()
  }

  return resolve(event)
}

// Rate limiting handler
const rateLimitHandler: Handle = async ({ event, resolve }) => {
  ensureStartupIntegrityPass()
  const path = event.url.pathname;
  const rateLimitingDisabled = env.BATSHIT_DISABLE_API_RATE_LIMITS === '1'
  const isAuthenticatedUser = Boolean(event.locals.user?.id)

  if (event.request.method === 'OPTIONS' && shouldApplyArtifactRuntimeCors(event)) {
    return new Response(null, {
      status: 204,
      headers: artifactRuntimeCorsHeaders()
    })
  }

  // Apply stricter rate limiting to auth endpoints
  if (
    !rateLimitingDisabled &&
    isAuthRateLimitedPath(path, event.request.method)
  ) {
    const status = await authRateLimiter.check(event);

    if (status.limited) {
      return new Response(
        JSON.stringify({
          error: 'Too many requests. Please try again later.',
          success: false,
          code: 'RATE_LIMITED'
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );
    }
  }
  // Apply general rate limiting to all other API endpoints
  else if (
    shouldApplyBroadApiRateLimit({
      path,
      method: event.request.method,
      rateLimitingDisabled,
      isAuthenticatedUser
    })
  ) {
    // EventSource GET cannot send custom headers. Other internal bypasses must prove the service token.
    const hasInternalBypassHeader =
      event.request.headers.get('x-internal-sse-forward') === '1' ||
      event.request.headers.get('x-internal-api-request') === '1'
    const isSseStream = path === '/api/sse' && event.request.method === 'GET'
    const isTrustedInternalForward = hasInternalBypassHeader && isTrustedInternalRequest(event.request)

    if (isSseStream || isTrustedInternalForward) {
      const response = await resolve(event);
      return appendArtifactRuntimeCors(event, response)
    }

    const status = await apiRateLimiter.check(event);

    if (status.limited) {
      console.warn('[RateLimit] API limit triggered', {
        path,
        reason: status.reason
      });
      return new Response(
        JSON.stringify({
          error: 'Too many requests. Please try again later.',
          success: false,
          code: 'RATE_LIMITED'
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );
    }
  }

  // Add rate limit headers to successful responses
  const response = await resolve(event);

  return appendArtifactRuntimeCors(event, response);
};

// Session handler
const sessionHandler: Handle = async ({ event, resolve }) => {
  // Get session token from cookie
  const sessionCookieName = resolveSessionCookieName();
  const token = event.cookies.get(sessionCookieName);

  if (token) {
    try {
      const sessionData = await authService.validateSession(token);
      if (sessionData) {
        event.locals.user = sessionData.user;
        event.locals.session = sessionData.session;
      } else {
        // Invalid session, clear cookie
        event.cookies.delete(sessionCookieName, { path: '/' });
        event.locals.user = null;
        event.locals.session = null;
      }
    } catch (error) {
      console.error('Session validation error:', error);
      event.locals.user = null;
      event.locals.session = null;
    }
  } else {
    event.locals.user = null;
    event.locals.session = null;
  }

  return resolve(event)
};

// Baseline security headers on every app response (G-0235); the helper only
// fills headers the inner handlers did not set.
const securityHeadersHandler: Handle = async ({ event, resolve }) => {
  const response = await resolve(event)
  applyBaselineSecurityHeaders(response.headers)
  return response
}

// Authenticate first so broad API rate limiting only applies to unauthenticated traffic.
// Batshit is single-user-per-instance; rate-limiting logged-in app traffic can make the
// UI self-DOS during normal chat/tool/zip hydration. Sensitive routes keep route-local
// limits where needed.
export const handle = sequence(
  securityHeadersHandler,
  hostedVercelAppGuardHandler,
  sessionHandler,
  rateLimitHandler
);
