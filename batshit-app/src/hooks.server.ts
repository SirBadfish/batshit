import { type Handle } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { authService, resolveSessionCookieName } from '$lib/services/auth.server'
import { authRateLimiter, apiRateLimiter } from '$lib/middleware/rateLimiter'
import { ensureSkillFilesystemStartup } from '$lib/server/services/skillRegistry'
import {
  listCoreSystemPrompts,
  removeRetiredSystemPrompts
} from '$lib/server/services/systemPromptRegistry'
import { removeRetiredSystemClips } from '$lib/server/services/retiredSystemClips'
import { ensureMemoryIndexes } from '$lib/server/services/memory/memoryIndex'
import { startMemoryDreamingScheduler } from '$lib/server/services/memory/memoryDreamingScheduler'
import { ensureMemoryMediaMigration } from '$lib/server/services/memory/memoryMediaMigration'
import { isTrustedInternalRequest } from '$lib/server/services/internalRequestAuth'
import { assertApiKeyEncryptionConfigured } from '$lib/services/encryption.server'
import { isAuthRateLimitedPath, shouldApplyBroadApiRateLimit } from '$lib/middleware/rateLimitPolicy'
import { disconnectAllRedisServices } from '$lib/server/redis'
import { cleanupAllMonitoring } from '$lib/server/visualIndicatorService'
import { closeRegisteredRuntimeResources } from '$lib/server/services/runtimeShutdown'
import {
  appendArtifactRuntimeCors,
  artifactRuntimeCorsHeaders,
  shouldApplyArtifactRuntimeCors
} from '$lib/server/services/artifactRuntimeAuth'
import {
  hostedVercelAppDisabledResponse,
  isHostedVercelRegistryDeployment,
  shouldBlockHostedVercelAppRequest
} from '$lib/server/services/hostedAppGuard'
import { applyBaselineSecurityHeaders } from '$lib/server/services/securityHeaders'
import {
  ensureBackupRestoreRecovery,
  enterBackupRestoreHttpRequest
} from '$lib/server/services/backupRestoreService'
import { sequence } from '@sveltejs/kit/hooks'

let startupIntegrityInitialized = false
let startupIntegrityPromise: Promise<void> | null = null

type BatshitRuntimeShutdownGlobal = typeof globalThis & {
  __batshitRuntimeShutdownRegistered?: boolean
  __batshitRuntimeSigtermRegistered?: boolean
  __batshitRuntimeDrainPromise?: Promise<void> | null
  __batshitRuntimeShutdownPromise?: Promise<void> | null
}

const runtimeShutdownGlobal = globalThis as BatshitRuntimeShutdownGlobal

function registerRuntimeShutdownHandler() {
  if (runtimeShutdownGlobal.__batshitRuntimeShutdownRegistered) return
  runtimeShutdownGlobal.__batshitRuntimeShutdownRegistered = true

  process.on('sveltekit:shutdown' as any, (reason: string) => {
    runtimeShutdownGlobal.__batshitRuntimeShutdownPromise ??= closeRuntimeResources(reason)
  })

  if (!runtimeShutdownGlobal.__batshitRuntimeSigtermRegistered) {
    runtimeShutdownGlobal.__batshitRuntimeSigtermRegistered = true
    process.on('SIGTERM', () => {
      // adapter-node waits for active requests before emitting sveltekit:shutdown.
      // Close long-lived SSE streams immediately so its HTTP server can finish.
      runtimeShutdownGlobal.__batshitRuntimeDrainPromise ??=
        closeLongLivedRuntimeResources('SIGTERM')
    })
  }
}

async function closeLongLivedRuntimeResources(reason: string) {
  try {
    await closeRegisteredRuntimeResources(reason)
  } catch (error) {
    console.error(`[Shutdown] Failed to close a long-lived runtime resource during ${reason}:`, error)
  }
}

async function closeRuntimeResources(reason: string) {
  // Registered resources include the SSE visual-monitor subscriptions. Close
  // them during SIGTERM so adapter-node can finish draining HTTP. Only close
  // shared Redis clients after adapter-node emits sveltekit:shutdown; destroying
  // those clients while ordinary requests are still draining creates false
  // session-validation failures.
  runtimeShutdownGlobal.__batshitRuntimeDrainPromise ??=
    closeLongLivedRuntimeResources(reason)
  await runtimeShutdownGlobal.__batshitRuntimeDrainPromise
  const remainingResults = await Promise.allSettled([
    cleanupAllMonitoring(),
    authService.disconnect(),
    disconnectAllRedisServices()
  ])

  for (const result of remainingResults) {
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
  if (!startupIntegrityInitialized) {
    startupIntegrityInitialized = true
    assertApiKeyEncryptionConfigured()
    assertInternalServiceTokenConfigured()
    if (isHostedVercelRegistryDeployment(env)) {
      // Registry-only deployment: no batshit-server, no uploads, read-only filesystem.
      // Backup-restore recovery and instance seeding are single-user-instance work.
      console.info(
        '[Startup] Hosted Vercel registry deployment detected; skipping single-instance startup (backup-restore recovery, skill filesystem, prompt/clip seeding).'
      )
      startupIntegrityPromise = Promise.resolve()
      return startupIntegrityPromise
    }
    startupIntegrityPromise = (async () => {
      await ensureBackupRestoreRecovery()
      void ensureSkillFilesystemStartup()
      void listCoreSystemPrompts().catch((error) => {
        console.error('[Startup] Failed to seed core system prompt defaults:', error)
      })
      void removeRetiredSystemPrompts().catch((error) => {
        console.error('[Startup] Failed to remove retired core system prompts:', error)
      })
      void removeRetiredSystemClips().catch((error) => {
        console.error('[Startup] Failed to remove retired system clips:', error)
      })
      void ensureMemoryIndexes()
        .then((result) => {
          if (result.status !== 'ready') {
            console.info(
              `[Startup] Memory search indexes ${result.status} for ${result.embeddingModel} (${result.dims}d).`
            )
          }
        })
        .catch((error) => {
          // Loud by contract (DL-104-10): recall paths also hard-fail until this is fixed.
          console.error('[Startup] Memory index bootstrap failed:', error)
        })
      void ensureMemoryMediaMigration()
        .then((result) => {
          if (result.status === 'migrated' && (result.records > 0 || result.unresolved > 0)) {
            console.info(
              `[Startup] Migrated ${result.records} memory records to ${result.media} owned media files (${result.unresolved} unresolved source clips).`
            )
          }
        })
        .catch((error) => {
          console.error('[Startup] Memory-media migration failed and will retry next boot:', error)
        })
      // SA-104 P7: the between-conversation dreaming scheduler (DL-104-15). Arms on
      // the first request after boot; each pass re-checks eligibility and live turns.
      startMemoryDreamingScheduler()
    })()
  }
  return startupIntegrityPromise ?? Promise.resolve()
}

const startupIntegrityHandler: Handle = async ({ event, resolve }) => {
  try {
    await ensureStartupIntegrityPass()
  } catch (error) {
    console.error('[Startup] Backup restore recovery failed:', error)
    return new Response(
      JSON.stringify({
        error: 'Batshit could not safely recover an interrupted backup restore. Check the app logs before retrying.'
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    )
  }
  return resolve(event)
}

const backupRestoreMaintenanceHandler: Handle = async ({ event, resolve }) => {
  const releaseRequest = enterBackupRestoreHttpRequest()
  if (!releaseRequest) {
    return new Response(
      JSON.stringify({ error: 'Batshit is finishing a backup restore. Try again after the app reloads.' }),
      { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '2' } }
    )
  }
  try {
    return await resolve(event)
  } finally {
    releaseRequest()
  }
}

const hostedVercelAppGuardHandler: Handle = async ({ event, resolve }) => {
  if (shouldBlockHostedVercelAppRequest({ env, url: event.url })) {
    return hostedVercelAppDisabledResponse()
  }

  return resolve(event)
}

// Rate limiting handler
const rateLimitHandler: Handle = async ({ event, resolve }) => {
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
  startupIntegrityHandler,
  backupRestoreMaintenanceHandler,
  sessionHandler,
  rateLimitHandler
);
