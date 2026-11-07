import { json, type RequestHandler } from '@sveltejs/kit'

import {
  getManagedCliInstallStatus,
  installManagedCli,
  isManagedCliRuntimeId,
  MANAGED_CLI_RUNTIME_IDS,
  ManagedCliOperationInProgressError,
  uninstallManagedCli,
  type ManagedCliRuntimeId
} from '$lib/server/services/managedCliInstaller'
import type { CliExecutableResolution } from '$lib/server/services/cliExecutableResolution'
import { resolveClaudeCliExecutableDetailed } from '$lib/server/services/claudeCliStatus'
import { noteClaudeCodeChanged } from '$lib/server/services/claudeCodeChanges'
import { requireAdmin, requireUser } from '$lib/server/services/routeSecurity'
import { isCliVersionOlder, probeCliVersion } from '$lib/server/services/cliVersion'
import { redis } from '$lib/server/redis'
import { CODEX_CLI_RETIRED_CODE, CODEX_CLI_RETIRED_ERROR } from '$lib/utils/cliRuntimeIdentity'

const MAX_MUTATION_BODY_BYTES = 1024
const MUTATION_RATE_LIMIT = 6
const MUTATION_RATE_WINDOW_SECONDS = 10 * 60

class CliRuntimeRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function readBoundedJson(request: Request): Promise<any> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new CliRuntimeRequestError('Content-Type must be application/json.', 415)
  }
  const declaredLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MUTATION_BODY_BYTES) {
    throw new CliRuntimeRequestError('CLI runtime request body is too large.', 413)
  }
  if (!request.body) throw new CliRuntimeRequestError('JSON body is required.', 400)

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      bytes += value.byteLength
      if (bytes > MAX_MUTATION_BODY_BYTES) {
        await reader.cancel()
        throw new CliRuntimeRequestError('CLI runtime request body is too large.', 413)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  try {
    const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
    return JSON.parse(buffer.toString('utf8'))
  } catch (error) {
    if (error instanceof CliRuntimeRequestError) throw error
    throw new CliRuntimeRequestError('Invalid JSON body.', 400)
  }
}

async function enforceMutationRateLimit(userId: string): Promise<Response | null> {
  const key = `ratelimit:cli-runtime-mutation:${userId}`
  const count = await redis.incr(key)
  if (count === 1) await redis.expire(key, MUTATION_RATE_WINDOW_SECONDS)
  if (count <= MUTATION_RATE_LIMIT) return null
  const retryAfter = Math.max(1, await redis.ttl(key))
  return json(
    { error: 'Too many managed CLI changes. Wait before trying again.' },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } },
  )
}

type CliRuntimeSummary = {
  managed: Awaited<ReturnType<typeof getManagedCliInstallStatus>>
  resolution: CliExecutableResolution & {
    found: boolean
    /** BL-268: what the found CLI reports as its version (null when it could not be read). */
    version: string | null
    /** BL-268: the found CLI is older than the version Batshit installs. */
    olderThanPinned: boolean
  }
}

async function buildRuntimeSummary(runtime: ManagedCliRuntimeId): Promise<CliRuntimeSummary> {
  const [managed, resolution] = await Promise.all([
    getManagedCliInstallStatus(runtime),
    Promise.resolve(resolveClaudeCliExecutableDetailed())
  ])
  const found = resolution.source !== 'not-found'
  // BL-268: a CLI older than the pinned one may refuse newer models on Batshit's list,
  // so Agent Settings says so beside the install button.
  const version =
    resolution.source === 'managed' && resolution.managedVersion
      ? resolution.managedVersion
      : found
        ? await probeCliVersion(resolution.executable)
        : null
  return {
    managed,
    resolution: {
      ...resolution,
      found,
      version,
      olderThanPinned: isCliVersionOlder(version, managed.pinnedVersion)
    }
  }
}

// SA-139 R4: the runtime summary only. The Primary's CLI reasoning check (`?reasoningRuntime=`)
// went with the Claude Code CLI Primary; install, reinstall and uninstall stay (the Claude plan
// connection and Claude Code CLI Subagents run this CLI).
export const GET: RequestHandler = async ({ locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  try {
    const entries = await Promise.all(
      MANAGED_CLI_RUNTIME_IDS.map(async (runtime) => [runtime, await buildRuntimeSummary(runtime)] as const)
    )
    const runtimes = Object.fromEntries(entries)
    return json({ runtimes, canManage: Boolean(user.value.is_admin) })
  } catch (error) {
    console.error('[cli-runtimes] Failed to inspect CLI runtimes:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to inspect CLI runtimes.' },
      { status: 500 }
    )
  }
}

export const POST: RequestHandler = async ({ locals, request }) => {
  const admin = requireAdmin(locals)
  if (!admin.ok) return admin.response

  let runtime: unknown
  let operation: unknown
  try {
    const payload = await readBoundedJson(request)
    runtime = payload?.runtime
    operation = payload?.operation
  } catch (error) {
    if (error instanceof CliRuntimeRequestError) {
      return json({ error: error.message }, { status: error.status })
    }
    return json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  if (runtime === 'codex') {
    return json({ error: CODEX_CLI_RETIRED_ERROR, code: CODEX_CLI_RETIRED_CODE }, { status: 409 })
  }
  if (!isManagedCliRuntimeId(runtime)) {
    return json({ error: 'Unknown CLI runtime. Expected "claude".' }, { status: 400 })
  }
  if (operation !== 'install' && operation !== 'reinstall' && operation !== 'uninstall') {
    return json({ error: 'Unsupported operation. Expected "install", "reinstall", or "uninstall".' }, { status: 400 })
  }

  try {
    const limited = await enforceMutationRateLimit(admin.value.id)
    if (limited) return limited

    try {
      if (operation === 'install' || operation === 'reinstall') {
        await installManagedCli(runtime, { force: operation === 'reinstall' })
      } else {
        await uninstallManagedCli(runtime)
      }
    } finally {
      // SA-139: the Claude plan's shared status read looks again after any attempt (a failed one may still change files).
      if (runtime === 'claude') noteClaudeCodeChanged()
    }

    const summary = await buildRuntimeSummary(runtime)
    return json({ runtime, operation, ...summary })
  } catch (error) {
    if (error instanceof ManagedCliOperationInProgressError) {
      return json(
        { error: error.message, code: error.code, operation: error.operationStatus },
        { status: 409 },
      )
    }
    console.error(`[cli-runtimes] Failed to ${operation} ${runtime}:`, error)
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : `Failed to ${operation} the ${runtime} CLI runtime.`
      },
      { status: 500 }
    )
  }
}
