import { materializeToolSettingsAtStartup } from '$lib/server/services/toolSettingsMigration'
import { initializeSystemSlashCommandsAtStartup } from '$lib/server/services/systemSlashCommands'
import { DEFAULT_APP_LOOK } from '$lib/appearance/appLook'
import { type Handle } from '@sveltejs/kit/hooks'
import { building, dev, version } from '$app/env'
import { env } from '$env/dynamic/private'
import { authService, resolveSessionCookieName } from '$lib/services/auth.server'
import { authRateLimiter, apiRateLimiter } from '$lib/middleware/rateLimiter'
import { ensureSkillFilesystemStartup } from '$lib/server/services/skillRegistry'
import {
  foldRetiredZipToolPrompts,
  listCoreSystemPrompts,
  removeRetiredSystemPrompts
} from '$lib/server/services/systemPromptRegistry'
import { removeRetiredSystemClips } from '$lib/server/services/retiredSystemClips'
import { removeRetiredCliCredentialIndexSets } from '$lib/server/services/agentRunCredentials'
import { removeRetiredSkillReadSettings } from '$lib/server/services/retiredSkillReadSettings'
import { removeRetiredZipControlFields } from '$lib/server/services/retiredZipControlFields'
import { describeZipDefaultsSweep, sweepOldZipDefaults } from '$lib/server/services/zipDefaultsSweep'
import { ensureMemoryIndexes } from '$lib/server/services/memory/memoryIndex'
import { startMemoryDreamingScheduler } from '$lib/server/services/memory/memoryDreamingScheduler'
import { startScheduleTicker } from '$lib/server/services/schedules/scheduleTicker'
import { ensureMemoryMediaMigration } from '$lib/server/services/memory/memoryMediaMigration'
import { isTrustedInternalRequest } from '$lib/server/services/internalRequestAuth'
import { assertApiKeyEncryptionConfigured } from '$lib/services/encryption.server'
import { isAuthRateLimitedPath, shouldApplyBroadApiRateLimit } from '$lib/middleware/rateLimitPolicy'
import { disconnectAllRedisServices } from '$lib/server/redis'
import { cleanupAllMonitoring } from '$lib/server/visualIndicatorService'
import { closeRegisteredRuntimeResources } from '$lib/server/services/runtimeShutdown'
import { registerDockerVoiceEngineShutdown } from '$lib/server/services/voiceEngineRegistry'
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
import { armClaudePlanRunLifecycle } from '$lib/server/services/claudePlanRunRegistry'
import {
  ensureBackupRestoreRecovery,
  enterBackupRestoreHttpRequest
} from '$lib/server/services/backupRestoreService'
import { sequence } from '@sveltejs/kit/hooks'
import {
  automaticBackupBuildId,
  beginAutomaticBackupStartup,
  completeAutomaticBackupStartup,
  failAutomaticBackupStartup
} from '$lib/server/services/automaticBackupStartup'

let startupIntegrityInitialized = false
let startupIntegrityPromise: Promise<void> | null = null

/**
 * BL-793: a native dev lane arms its own schedule ticker (`startScheduleTicker`) and memory
 * dreaming scheduler (`startMemoryDreamingScheduler`) on its first request, same as any other
 * lane on the same `hooks.server.ts` — because it reads and writes the SAME DB0 as every other
 * lane and Josh's packaged Mac app, a proof lane fires due schedules and dreaming passes for
 * real, beside whichever other lane already owns that data. No switch existed to stop it.
 *
 * `BATSHIT_DISABLE_SCHEDULERS=1` (the `BATSHIT_DISABLE_API_RATE_LIMITS` naming pattern) turns
 * both OFF for this process only when explicitly set; the default stays ON for every lane that
 * does not set it, including the one lane that actually owns DB0. Exported so a proof lane's
 * boot log, and this behavior, can be asserted directly without exercising the rest of
 * `ensureStartupIntegrityPass`'s startup side effects.
 */
export function armBackgroundSchedulers(currentEnv: Record<string, string | undefined> = env): void {
  if (currentEnv.BATSHIT_DISABLE_SCHEDULERS === '1') {
    console.info(
      '[Startup] BATSHIT_DISABLE_SCHEDULERS=1 — schedule ticker and memory dreaming scheduler are OFF for this process.'
    )
    return
  }
  startMemoryDreamingScheduler()
  startScheduleTicker()
}

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

// Kit imports hooks for build analysis and prerendering; those are not server
// starts and must not sweep live run folders or arm runtime shutdown effects.
if (!building) {
  registerRuntimeShutdownHandler()
  // Docker: register from server start, not the first signed-in page load (BL-19).
  registerDockerVoiceEngineShutdown()
  // SA-139 (D10): sweep crashed-run leftovers and own shutdown before any request.
  armClaudePlanRunLifecycle()
}

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

export function ensureStartupIntegrityPass() {
  if (!startupIntegrityInitialized) {
    startupIntegrityInitialized = true
    // Retain the promise before any admission work, including synchronous owner failures.
    startupIntegrityPromise = Promise.resolve().then(async () => {
      assertApiKeyEncryptionConfigured()
      assertInternalServiceTokenConfigured()
    if (isHostedVercelRegistryDeployment(env)) {
      // Registry-only deployment: no batshit-server, no uploads, read-only filesystem.
      // Backup-restore recovery and instance seeding are single-user-instance work.
      console.info(
        '[Startup] Hosted Vercel registry deployment detected; skipping single-instance startup (backup-restore recovery, skill filesystem, prompt/clip seeding).'
      )
      return
    }
    const buildId = automaticBackupBuildId(version, dev)
    const backupStartup = beginAutomaticBackupStartup(buildId)
    try {
      const recovery = ensureBackupRestoreRecovery()
      await recovery
      // Critical saved-data conversion: no request, compile or scheduler sees inherited grants.
      await materializeToolSettingsAtStartup()
      const skills = ensureSkillFilesystemStartup()
      await skills
      await initializeSystemSlashCommandsAtStartup()
      // BL-1777: before any compile and before the seed below, move the two older zip tool
      // prompts into "Tool Prompt: Zips", so an admin's edit is in place when agents compile and
      // the seed never writes the default first. A failure keeps every old record as it is
      // (the compile then reads the built default) and the next start tries again.
      const zipPrompts = foldRetiredZipToolPrompts()
      await zipPrompts.catch((error) => {
        console.error('[Startup] Failed to move the older zip tool prompts into "Tool Prompt: Zips"; the next start tries again:', error)
      })
      const promptDefaults = listCoreSystemPrompts()
      void promptDefaults.catch((error) => {
        console.error('[Startup] Failed to seed core system prompt defaults:', error)
      })
      const retiredPrompts = removeRetiredSystemPrompts()
      void retiredPrompts.catch((error) => {
        console.error('[Startup] Failed to remove retired core system prompts:', error)
      })
      // SA-139 R5: the removed CLI Subagent and Worker runs' credential index sets, which no
      // delete sweeps. Idempotent; a failure leaves them for the next start.
      void removeRetiredCliCredentialIndexSets().catch((error) => {
        console.error('[Startup] Failed to remove retired CLI credential index sets:', error)
      })
      const retiredClips = removeRetiredSystemClips()
      void retiredClips.catch((error) => {
        console.error('[Startup] Failed to remove retired system clips:', error)
      })
      // BL-1484: the parked zip control permission's two older keys are removed for real; the
      // permission reads only its hidden experiment key. Idempotent; logs only when it removed.
      const retiredZipFields = Promise.all([removeRetiredZipControlFields(), removeRetiredSkillReadSettings()])
      void retiredZipFields.catch((error) => {
        console.error('[Startup] Failed to remove retired zip control fields; the next start retries:', error)
      })
      // SA-126 shipped defaults: stored rows equal to the old factory zip rows go once per instance,
      // so existing agents and the Global Tool Grid inherit the new defaults (marker-guarded).
      const zipDefaults = sweepOldZipDefaults()
      void zipDefaults
        .then((result) => {
          if (result.rows > 0) console.info(`[Startup] ${describeZipDefaultsSweep(result)}`)
        })
        .catch((error) => {
          console.error('[Startup] The one-time sweep of old default zip rows failed; the next start retries:', error)
        })
      const memoryIndexes = ensureMemoryIndexes()
      void memoryIndexes
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
      const memoryMedia = ensureMemoryMediaMigration()
      void memoryMedia
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
      // SA-115 P1: Batshit's clock (DL-115-06). Same arming point and the same reason it
      // works with no tab open — the Mac supervisor and the Docker healthcheck both poll
      // this server forever. A due-while-off schedule is collapsed by the first sweep,
      // never fired, so nothing starts an agent turn just because Batshit booted.
      // BL-793: both are skipped, with a boot log line, when BATSHIT_DISABLE_SCHEDULERS=1.
      armBackgroundSchedulers()
      void completeAutomaticBackupStartup({
        recovery, skills, zipPrompts, promptDefaults, retiredPrompts,
        retiredClips, retiredZipFields, zipDefaults, memoryIndexes, memoryMedia
      }, {
        buildId,
        schedulersDisabled: env.BATSHIT_DISABLE_SCHEDULERS === '1',
        guard: backupStartup
      })
    } catch (error) {
      backupStartup.finish()
      throw error
    }
    })
  }
  return startupIntegrityPromise ?? Promise.resolve()
}

export const startupIntegrityHandler: Handle = async ({ event, resolve }) => {
  try {
    await ensureStartupIntegrityPass()
  } catch (error) {
    failAutomaticBackupStartup(automaticBackupBuildId(version, dev),
      'Startup recovery did not complete. Check the app logs before automatic backups can run.')
    console.error('[Startup] Saved-data startup recovery or tool settings conversion failed:', error)
    return new Response(
      JSON.stringify({
        error: 'Batshit could not safely finish saved-data startup recovery. Check the app logs before retrying.'
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

// The app's look on <html data-look> before the first frame (Josh, 2026-10-29): the root layout
// reads the user's settings and leaves the look in locals; a page with no settings read (signed
// out, or a read that failed) gets the default. app.html carries the %batshit.look% slot.
const appLookHandler: Handle = async ({ event, resolve }) =>
  resolve(event, {
    transformPageChunk: ({ html }) => html.replace('%batshit.look%', event.locals.appLook ?? DEFAULT_APP_LOOK)
  })

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
  appLookHandler,
  rateLimitHandler
);
