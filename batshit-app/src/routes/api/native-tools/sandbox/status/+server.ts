import { json, type RequestHandler } from '@sveltejs/kit'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'
import { nativeToolService } from '$lib/server/services/nativeTools'

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
    const backend = nativeToolService.normalizeNativeExecutionBackend(
      url.searchParams.get('backend')
    )
    const status =
      backend === 'apple_container'
        ? await nativeToolService.getAppleContainerSandboxBackendStatus()
        : await nativeToolService.getSandboxBackendStatus()
    return json({
      success: true,
      ...status
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
