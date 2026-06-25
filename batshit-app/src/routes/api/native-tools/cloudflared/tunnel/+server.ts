import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import {
  ensureManagedCloudflaredTunnel,
  getDefaultDockerManagedTunnelTargetUrl,
  getCloudflaredRuntimeStatus,
  getDefaultManagedTunnelTargetUrl,
  stopManagedCloudflaredTunnel,
  type CloudflaredRuntimeStatus
} from '$lib/server/services/cloudflaredRuntime'
import { controlRuntimeAddon } from '$lib/server/services/runtimeAddons'

type UploadSettingsRecord = Record<string, any>

function normalizeRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, any>) } : {}
}

function readUploadSettingsFromUserSettings(settings: any): UploadSettingsRecord {
  const uiSettings = normalizeRecord(settings?.ui_settings)
  const nested = normalizeRecord(uiSettings.upload_settings)
  if (Object.keys(nested).length > 0) {
    return nested
  }
  return normalizeRecord(settings?.upload_settings)
}

async function persistUploadSettings(userId: string, patch: UploadSettingsRecord): Promise<UploadSettingsRecord> {
  const settings = await redis.getUserSettings(userId)
  const uiSettings = normalizeRecord(settings?.ui_settings)
  const currentUpload = readUploadSettingsFromUserSettings(settings)
  const nextUpload: UploadSettingsRecord = {
    ...currentUpload,
    ...patch
  }
  const nextUiSettings = {
    ...uiSettings,
    upload_settings: nextUpload
  }
  await redis.updateUserSettings(userId, {
    ui_settings: nextUiSettings,
    upload_settings: nextUpload,
    upload_provider:
      typeof nextUpload.strategy === 'string' && nextUpload.strategy.trim().length > 0
        ? nextUpload.strategy.trim()
        : settings?.upload_provider
  })
  return nextUpload
}

function normalizeBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false
  }
  return fallback
}

function normalizeTargetUrl(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

function isDockerCloudflaredRuntime(status: CloudflaredRuntimeStatus): boolean {
  return status.supportLevel === 'docker-sidecar' || status.installScope === 'docker-sidecar'
}

function resolvePayloadTargetUrl(
  status: CloudflaredRuntimeStatus,
  uploadSettings: UploadSettingsRecord
): string {
  if (isDockerCloudflaredRuntime(status)) {
    return normalizeTargetUrl(
      status.tunnel?.targetUrl ?? status.dockerSidecar?.targetUrl,
      getDefaultDockerManagedTunnelTargetUrl()
    )
  }

  return normalizeTargetUrl(
    uploadSettings.cloudflared_target_url,
    getDefaultManagedTunnelTargetUrl()
  )
}

async function buildPayload(userId: string) {
  const settings = await redis.getUserSettings(userId)
  const uploadSettings = readUploadSettingsFromUserSettings(settings)
  const status = await getCloudflaredRuntimeStatus()
  const autoStart = normalizeBool(uploadSettings.cloudflared_auto_start, false)
  const tunnelProvider = typeof uploadSettings.tunnel_provider === 'string'
    ? uploadSettings.tunnel_provider
    : 'manual'
  const targetUrl = resolvePayloadTargetUrl(status, uploadSettings)

  return {
    ...status,
    autoStart,
    tunnelProvider,
    targetUrl
  }
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const settings = await redis.getUserSettings(locals.user.id)
    const uploadSettings = readUploadSettingsFromUserSettings(settings)
    const autoStart = normalizeBool(uploadSettings.cloudflared_auto_start, false)
    const tunnelProvider = typeof uploadSettings.tunnel_provider === 'string'
      ? uploadSettings.tunnel_provider
      : 'manual'
    const runtimeStatus = await getCloudflaredRuntimeStatus()
    const targetUrl = resolvePayloadTargetUrl(runtimeStatus, uploadSettings)

    if (tunnelProvider === 'cloudflared_managed' && autoStart) {
      if (isDockerCloudflaredRuntime(runtimeStatus) && !runtimeStatus.tunnel.running) {
        const result = await controlRuntimeAddon('cloudflared', 'start')
        if (result?.success) {
          const payload = await buildPayload(locals.user.id)
          if (payload.tunnel?.publicUrl) {
            await persistUploadSettings(locals.user.id, {
              strategy: uploadSettings.strategy || 'local',
              tunnel_provider: 'cloudflared_managed',
              cloudflared_auto_start: true,
              cloudflared_target_url: payload.targetUrl,
              tunnel_url: payload.tunnel.publicUrl,
              use_https: true
            })
          }
        }
      } else if (runtimeStatus.installed && !runtimeStatus.tunnel.running) {
        const started = await ensureManagedCloudflaredTunnel({ targetUrl })
        if (started.started && started.status.publicUrl) {
          await persistUploadSettings(locals.user.id, {
            strategy: uploadSettings.strategy || 'local',
            tunnel_provider: 'cloudflared_managed',
            cloudflared_auto_start: true,
            cloudflared_target_url: targetUrl,
            tunnel_url: started.status.publicUrl,
            use_https: true
          })
        }
      }
    }

    return json(await buildPayload(locals.user.id))
  } catch (error) {
    console.error('[Native Tools] cloudflared/tunnel GET failed:', error)
    return json(
      {
        error: error instanceof Error ? error.message : 'Failed to load managed tunnel status.'
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
  const action = typeof payload?.action === 'string' ? payload.action.trim().toLowerCase() : ''

  try {
    const settings = await redis.getUserSettings(locals.user.id)
    const uploadSettings = readUploadSettingsFromUserSettings(settings)
    const currentTarget = normalizeTargetUrl(
      uploadSettings.cloudflared_target_url,
      getDefaultManagedTunnelTargetUrl()
    )
    const runtimeStatus = await getCloudflaredRuntimeStatus()
    const dockerCloudflared = isDockerCloudflaredRuntime(runtimeStatus)
    const nextTarget = dockerCloudflared
      ? resolvePayloadTargetUrl(runtimeStatus, uploadSettings)
      : normalizeTargetUrl(payload?.targetUrl, currentTarget)

    if (action === 'start') {
      if (dockerCloudflared) {
        const result = await controlRuntimeAddon('cloudflared', 'start')
        const latestPayload = await buildPayload(locals.user.id)
        if (!result?.success || !latestPayload.tunnel?.publicUrl) {
          return json(
            {
              ...latestPayload,
              error: result?.error || 'Failed to start Docker Cloudflared sidecar.'
            },
            { status: 503 }
          )
        }

        const nextAutoStart = normalizeBool(payload?.autoStart, normalizeBool(uploadSettings.cloudflared_auto_start, false))
        await persistUploadSettings(locals.user.id, {
          strategy: uploadSettings.strategy || 'local',
          tunnel_provider: 'cloudflared_managed',
          cloudflared_auto_start: nextAutoStart,
          cloudflared_target_url: latestPayload.targetUrl,
          tunnel_url: latestPayload.tunnel.publicUrl,
          use_https: true
        })

        return json(await buildPayload(locals.user.id))
      }

      const started = await ensureManagedCloudflaredTunnel({ targetUrl: nextTarget })
      if (!started.started || !started.status.publicUrl) {
        return json(
          {
            ...(await buildPayload(locals.user.id)),
            error: started.reason || 'Failed to start managed Cloudflare tunnel.'
          },
          { status: 500 }
        )
      }

      const nextAutoStart = normalizeBool(payload?.autoStart, normalizeBool(uploadSettings.cloudflared_auto_start, false))
      await persistUploadSettings(locals.user.id, {
        strategy: uploadSettings.strategy || 'local',
        tunnel_provider: 'cloudflared_managed',
        cloudflared_auto_start: nextAutoStart,
        cloudflared_target_url: nextTarget,
        tunnel_url: started.status.publicUrl,
        use_https: true
      })

      return json(await buildPayload(locals.user.id))
    }

    if (action === 'stop') {
      if (dockerCloudflared) {
        const result = await controlRuntimeAddon('cloudflared', 'stop')
        const latestPayload = await buildPayload(locals.user.id)
        if (!result?.success) {
          return json(
            {
              ...latestPayload,
              error: result?.error || 'Failed to stop Docker Cloudflared sidecar.'
            },
            { status: 503 }
          )
        }

        await persistUploadSettings(locals.user.id, {
          strategy: uploadSettings.strategy || 'local',
          tunnel_provider: uploadSettings.tunnel_provider || 'cloudflared_managed',
          cloudflared_target_url: latestPayload.targetUrl,
          tunnel_url: '',
          use_https: true
        })
        return json(await buildPayload(locals.user.id))
      }

      const stopped = await stopManagedCloudflaredTunnel()
      if (!stopped.stopped) {
        return json(
          {
            ...(await buildPayload(locals.user.id)),
            error: stopped.reason || 'Failed to stop managed Cloudflare tunnel.'
          },
          { status: 503 }
        )
      }

      await persistUploadSettings(locals.user.id, {
        strategy: uploadSettings.strategy || 'local',
        tunnel_provider: uploadSettings.tunnel_provider || 'cloudflared_managed',
        cloudflared_target_url: nextTarget,
        tunnel_url: '',
        use_https: true
      })
      return json(await buildPayload(locals.user.id))
    }

    if (action === 'set-auto-start') {
      const enabled = normalizeBool(payload?.enabled, false)
      await persistUploadSettings(locals.user.id, {
        strategy: uploadSettings.strategy || 'local',
        tunnel_provider: uploadSettings.tunnel_provider || 'cloudflared_managed',
        cloudflared_auto_start: enabled,
        cloudflared_target_url: nextTarget
      })

      if (enabled) {
        if (dockerCloudflared) {
          await controlRuntimeAddon('cloudflared', 'start').catch((error) => {
            console.warn('[Native Tools] cloudflared/tunnel set-auto-start failed to start Docker sidecar:', error)
          })
        } else {
          await ensureManagedCloudflaredTunnel({ targetUrl: nextTarget }).catch((error) => {
            console.warn('[Native Tools] cloudflared/tunnel set-auto-start failed to start tunnel:', error)
          })
        }
        const latestPayload = await buildPayload(locals.user.id)
        if (latestPayload.tunnel?.publicUrl) {
          await persistUploadSettings(locals.user.id, {
            strategy: uploadSettings.strategy || 'local',
            tunnel_provider: uploadSettings.tunnel_provider || 'cloudflared_managed',
            cloudflared_auto_start: enabled,
            cloudflared_target_url: latestPayload.targetUrl,
            tunnel_url: latestPayload.tunnel.publicUrl,
            use_https: true
          })
        }
      }

      return json(await buildPayload(locals.user.id))
    }

    return json(
      {
        error: 'Invalid action. Use start, stop, or set-auto-start.'
      },
      { status: 400 }
    )
  } catch (error) {
    console.error('[Native Tools] cloudflared/tunnel POST failed:', error)
    return json(
      {
        error: error instanceof Error ? error.message : 'Failed to update managed tunnel state.'
      },
      { status: 500 }
    )
  }
}
