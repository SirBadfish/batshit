import { json, type RequestHandler } from '@sveltejs/kit'
import { nativeToolService } from '$lib/server/services/nativeTools'

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const status = await nativeToolService.getAgentBrowserRuntimeStatus()
    return json(status)
  } catch (error) {
    console.error('[Native Tools] agent-browser/runtime GET failed:', error)
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to load Agent Browser runtime status.'
      },
      { status: 500 }
    )
  }
}

export const POST: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await nativeToolService.installAgentBrowserRuntime()
    const statusCode = result.dockerUnsupported ? 503 : result.installed ? 200 : 500
    return json(result, { status: statusCode })
  } catch (error) {
    console.error('[Native Tools] agent-browser/runtime POST failed:', error)
    return json(
      {
        installed: false,
        error: error instanceof Error ? error.message : 'Failed to install Agent Browser runtime.'
      },
      { status: 500 }
    )
  }
}

export const DELETE: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await nativeToolService.uninstallAgentBrowserRuntime()
    const statusCode = result.dockerUnsupported ? 503 : result.uninstalled ? 200 : 500
    return json(result, { status: statusCode })
  } catch (error) {
    console.error('[Native Tools] agent-browser/runtime DELETE failed:', error)
    return json(
      {
        uninstalled: false,
        error: error instanceof Error ? error.message : 'Failed to uninstall Agent Browser runtime.'
      },
      { status: 500 }
    )
  }
}
