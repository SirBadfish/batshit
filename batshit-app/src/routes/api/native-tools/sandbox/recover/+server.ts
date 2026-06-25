import { json, type RequestHandler } from '@sveltejs/kit'
import { nativeToolService } from '$lib/server/services/nativeTools'

function statusForErrorCode(code?: string): number {
  switch (code) {
    case 'INVALID_CONTEXT':
      return 400
    case 'SANDBOX_UNAVAILABLE':
    case 'BACKEND_UNAVAILABLE':
      return 503
    default:
      return 500
  }
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const payload = (await request.json().catch(() => null)) as {
    workspaceRoot?: unknown
    backend?: unknown
  } | null
  const workspaceRoot =
    typeof payload?.workspaceRoot === 'string' && payload.workspaceRoot.trim().length > 0
      ? payload.workspaceRoot.trim()
      : null
  const backend = nativeToolService.normalizeNativeExecutionBackend(payload?.backend)

  try {
    const result =
      backend === 'apple_container'
        ? await nativeToolService.recoverAppleContainerSandboxBackend({
            userId: locals.user.id,
            workspaceRoot
          })
        : await nativeToolService.recoverSandboxBackend({
            userId: locals.user.id,
            workspaceRoot
          })
    const status = result.success ? 200 : statusForErrorCode(result.error?.code)
    return json(result, { status })
  } catch (error) {
    console.error('[Native Tools] sandbox/recover failed:', error)
    const responseBackend = backend === 'apple_container' ? 'apple_container' : 'docker_sandbox'
    return json(
      {
        success: false,
        recovered: false,
        backend: responseBackend,
        sandboxName: null,
        workspaceRoot: workspaceRoot,
        workspaceSource: null,
        ...(responseBackend === 'docker_sandbox' ? { policy: 'deny' } : {}),
        status: {
          available: false,
          backend: responseBackend,
          ...(responseBackend === 'docker_sandbox' ? { policy: 'deny' } : {}),
          version: null,
          reason: 'Sandbox recovery failed.'
        },
        error: {
          code: 'BACKEND_UNAVAILABLE',
          message: error instanceof Error ? error.message : 'Sandbox recovery failed.'
        }
      },
      { status: 500 }
    )
  }
}
