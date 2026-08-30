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
import {
  resolveCodexCliExecutableDetailed,
  type CliExecutableResolution
} from '$lib/server/services/codexCliStatus'
import { resolveClaudeCliExecutableDetailed } from '$lib/server/services/claudeCliStatus'
import { requireAdmin, requireUser } from '$lib/server/services/routeSecurity'
import { redis } from '$lib/server/redis'

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
  resolution: CliExecutableResolution & { found: boolean }
}

function resolveRuntimeExecutable(runtime: ManagedCliRuntimeId): CliExecutableResolution {
  return runtime === 'codex'
    ? resolveCodexCliExecutableDetailed()
    : resolveClaudeCliExecutableDetailed()
}

async function buildRuntimeSummary(runtime: ManagedCliRuntimeId): Promise<CliRuntimeSummary> {
  const [managed, resolution] = await Promise.all([
    getManagedCliInstallStatus(runtime),
    Promise.resolve(resolveRuntimeExecutable(runtime))
  ])
  return {
    managed,
    resolution: { ...resolution, found: resolution.source !== 'not-found' }
  }
}

export const GET: RequestHandler = async ({ locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  try {
    const entries = await Promise.all(
      MANAGED_CLI_RUNTIME_IDS.map(async (runtime) => [runtime, await buildRuntimeSummary(runtime)] as const)
    )
    return json({ runtimes: Object.fromEntries(entries), canManage: Boolean(user.value.is_admin) })
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

  if (!isManagedCliRuntimeId(runtime)) {
    return json({ error: 'Unknown CLI runtime. Expected "codex" or "claude".' }, { status: 400 })
  }
  if (operation !== 'install' && operation !== 'reinstall' && operation !== 'uninstall') {
    return json({ error: 'Unsupported operation. Expected "install", "reinstall", or "uninstall".' }, { status: 400 })
  }

  try {
    const limited = await enforceMutationRateLimit(admin.value.id)
    if (limited) return limited

    if (operation === 'install' || operation === 'reinstall') {
      await installManagedCli(runtime, { force: operation === 'reinstall' })
    } else {
      await uninstallManagedCli(runtime)
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
