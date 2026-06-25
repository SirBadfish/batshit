import { json, type RequestHandler } from '@sveltejs/kit'
import {
  CLOUDFLARED_ASSETS,
  getCloudflaredRuntimeStatus,
  installCloudflaredRuntime,
  uninstallCloudflaredRuntime,
  type CloudflaredInstallPlatform
} from '$lib/server/services/cloudflaredRuntime'

function isValidPlatform(value: unknown): value is CloudflaredInstallPlatform {
  return typeof value === 'string' && value in CLOUDFLARED_ASSETS
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    return json(await getCloudflaredRuntimeStatus())
  } catch (error) {
    console.error('[Native Tools] cloudflared/runtime GET failed:', error)
    return json(
      {
        error: error instanceof Error ? error.message : 'Failed to load Cloudflared runtime status.'
      },
      { status: 500 }
    )
  }
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const payload = await request.json().catch(() => ({}))
  const platform = payload?.platform
  if (!isValidPlatform(platform)) {
    return json(
      {
        error: 'Invalid platform.',
        validPlatforms: Object.keys(CLOUDFLARED_ASSETS)
      },
      { status: 400 }
    )
  }

  try {
    const status = await installCloudflaredRuntime(platform)
    return json(status, {
      status:
        status.supportLevel !== 'native-managed'
          ? 503
          : status.installed
            ? 200
            : 500
    })
  } catch (error) {
    console.error('[Native Tools] cloudflared/runtime POST failed:', error)
    return json(
      {
        error: error instanceof Error ? error.message : 'Failed to install Cloudflared runtime.'
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
    const result = await uninstallCloudflaredRuntime()
    return json(result, {
      status:
        result.status?.supportLevel !== 'native-managed'
          ? 503
          : result.uninstalled
            ? 200
            : 500
    })
  } catch (error) {
    console.error('[Native Tools] cloudflared/runtime DELETE failed:', error)
    return json(
      {
        error: error instanceof Error ? error.message : 'Failed to uninstall Cloudflared runtime.'
      },
      { status: 500 }
    )
  }
}
