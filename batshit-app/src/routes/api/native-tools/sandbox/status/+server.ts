import { json, type RequestHandler } from '@sveltejs/kit'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'
import { nativeToolService } from '$lib/server/services/nativeTools'
import { readTypedFileToolsHost } from '$lib/server/services/typedFileToolsHost.server'

export const GET: RequestHandler = async ({ request, locals }) => {
  try {
    const auth = await resolveNativeToolUser({
      request,
      localsUserId: locals.user?.id ?? null
    })

    if (!auth) {
      return json({ error: 'Unauthorized' }, { status: 401 })
    }

    const url = new URL(request.url)
    // Round 2: Settings asks only what this computer is (Refreshed File Reads availability), so
    // this mode reads the runtime facts and probes no sandbox. Authentication still runs first.
    if (url.searchParams.get('hostOnly') === '1') {
      return json({ success: true, typedFileToolsHost: readTypedFileToolsHost() })
    }
    const backend = nativeToolService.normalizeNativeExecutionBackend(
      url.searchParams.get('backend')
    )
    const status =
      backend === 'apple_container'
        ? await nativeToolService.getAppleContainerSandboxBackendStatus()
        : await nativeToolService.getSandboxBackendStatus()
    return json({
      success: true,
      ...status,
      typedFileToolsHost: readTypedFileToolsHost()
    })
  } catch (error) {
    console.error('[Native Tools] sandbox/status failed:', error)
    return json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load sandbox status.'
      },
      { status: 500 }
    )
  }
}
