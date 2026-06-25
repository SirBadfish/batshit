import { json, type RequestHandler } from '@sveltejs/kit'

import {
  getManagedCliInstallStatus,
  installManagedCli,
  isManagedCliRuntimeId,
  MANAGED_CLI_RUNTIME_IDS,
  uninstallManagedCli,
  type ManagedCliRuntimeId
} from '$lib/server/services/managedCliInstaller'
import {
  resolveCodexCliExecutableDetailed,
  type CliExecutableResolution
} from '$lib/server/services/codexCliStatus'
import { resolveClaudeCliExecutableDetailed } from '$lib/server/services/claudeCliStatus'

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
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const entries = await Promise.all(
      MANAGED_CLI_RUNTIME_IDS.map(async (runtime) => [runtime, await buildRuntimeSummary(runtime)] as const)
    )
    return json({ runtimes: Object.fromEntries(entries) })
  } catch (error) {
    console.error('[cli-runtimes] Failed to inspect CLI runtimes:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to inspect CLI runtimes.' },
      { status: 500 }
    )
  }
}

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  let runtime: unknown
  let operation: unknown
  try {
    const payload = await request.json()
    runtime = payload?.runtime
    operation = payload?.operation
  } catch {
    return json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  if (!isManagedCliRuntimeId(runtime)) {
    return json({ error: 'Unknown CLI runtime. Expected "codex" or "claude".' }, { status: 400 })
  }
  if (operation !== 'install' && operation !== 'uninstall') {
    return json({ error: 'Unsupported operation. Expected "install" or "uninstall".' }, { status: 400 })
  }

  try {
    if (operation === 'install') {
      await installManagedCli(runtime)
    } else {
      await uninstallManagedCli(runtime)
    }

    const summary = await buildRuntimeSummary(runtime)
    return json({ runtime, operation, ...summary })
  } catch (error) {
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
