import type { ClipRow, UserSettingsRow } from '$lib/types/database'
import {
  ensureManagedCloudflaredTunnel,
  getCloudflaredRuntimeStatus,
  getDefaultManagedTunnelTargetUrl
} from './cloudflaredRuntime'

type NormalizedUploadSettings = {
  strategy: 'local'
  tunnelUrl: string
  useHttps: boolean
  tunnelProvider: 'none' | 'manual' | 'cloudflared_managed'
  cloudflaredAutoStart: boolean
  cloudflaredTargetUrl: string
}

export type ScreenshotUploadConfig = {
  strategy: 'local'
  storageMode: 'local'
  tunnelUrl: string
  useHttps: boolean
  tunnelProvider: 'none' | 'manual' | 'cloudflared_managed'
  cloudflaredAutoStart: boolean
  cloudflaredTargetUrl: string
}

export type ManagedTunnelUnavailableDetails = {
  targetUrl: string
  reason: string
}

type ResolveLiveTunnelBaseOptions = {
  allowAutoStart?: boolean
  forceManagedStart?: boolean
  onManagedTunnelUnavailable?: (details: ManagedTunnelUnavailableDetails) => void
}

function normalizeRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, any>) }
    : {}
}

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

export function buildTunnelPathFromLocalUrl(localUrl?: string | null): string | null {
  const trimmed = trimString(localUrl)
  if (!trimmed) return null

  if (trimmed.startsWith('/uploads/')) {
    return trimmed
  }

  try {
    const parsed = new URL(trimmed)
    return parsed.pathname.startsWith('/uploads/') ? parsed.pathname : null
  } catch {
    return null
  }
}

export function buildTunnelUrl(baseUrl: string, tunnelPath: string): string {
  const normalizedBase = stripTrailingSlash(baseUrl.trim())
  const normalizedPath = tunnelPath.startsWith('/') ? tunnelPath : `/${tunnelPath}`
  return `${normalizedBase}${normalizedPath}`
}

export function resolveClipUploadSettings(
  settings?: UserSettingsRow | null
): NormalizedUploadSettings {
  const uiSettings = normalizeRecord(settings?.ui_settings)
  const nestedUpload = normalizeRecord(uiSettings.upload_settings)
  const legacyUpload = normalizeRecord((settings as any)?.upload_settings)
  const uploadSettings =
    Object.keys(nestedUpload).length > 0 ? nestedUpload : legacyUpload

  return {
    strategy: 'local',
    tunnelUrl: trimString(uploadSettings.tunnel_url),
    useHttps: uploadSettings.use_https === true,
    tunnelProvider:
      uploadSettings.tunnel_provider === 'cloudflared_managed'
        ? 'cloudflared_managed'
        : uploadSettings.tunnel_provider === 'none'
          ? 'none'
        : 'manual',
    cloudflaredAutoStart: uploadSettings.cloudflared_auto_start === true,
    cloudflaredTargetUrl:
      trimString(uploadSettings.cloudflared_target_url) ||
      getDefaultManagedTunnelTargetUrl()
  }
}

async function resolveManagedTunnelUrl(
  settings: NormalizedUploadSettings,
  options?: ResolveLiveTunnelBaseOptions
): Promise<string | null> {
  const runtimeStatus = await getCloudflaredRuntimeStatus()
  if (runtimeStatus?.tunnel?.publicUrl) {
    return runtimeStatus.tunnel.publicUrl
  }

  const shouldStart =
    options?.forceManagedStart === true ||
    (settings.cloudflaredAutoStart && options?.allowAutoStart === true)

  if (!shouldStart) {
    return null
  }

  const managed = await ensureManagedCloudflaredTunnel({
    targetUrl: settings.cloudflaredTargetUrl
  })

  if (managed.started && managed.status.publicUrl) {
    return managed.status.publicUrl
  }

  options?.onManagedTunnelUnavailable?.({
    targetUrl: settings.cloudflaredTargetUrl,
    reason: managed.reason || managed.status.lastError || 'unknown'
  })

  return null
}

export async function resolveLiveTunnelBaseUrl(
  settings?: UserSettingsRow | null,
  options?: ResolveLiveTunnelBaseOptions
): Promise<string | null> {
  const normalized = resolveClipUploadSettings(settings)
  if (normalized.tunnelProvider === 'none') return null

  if (normalized.tunnelProvider === 'cloudflared_managed') {
    return resolveManagedTunnelUrl(normalized, options)
  }

  const tunnelUrl = normalized.tunnelUrl
  if (!tunnelUrl) return null

  if (/^https?:\/\//i.test(tunnelUrl)) {
    return tunnelUrl
  }

  const protocol = normalized.useHttps ? 'https' : 'http'
  return `${protocol}://${tunnelUrl}`
}

export async function resolveUploadConfigForScreenshot(
  settings?: UserSettingsRow | null,
  options?: ResolveLiveTunnelBaseOptions
): Promise<ScreenshotUploadConfig | null> {
  const normalized = resolveClipUploadSettings(settings)
  if (normalized.tunnelProvider === 'none') return null

  const tunnelUrl = await resolveLiveTunnelBaseUrl(settings, {
    ...options,
    allowAutoStart: true,
    forceManagedStart:
      normalized.tunnelProvider === 'cloudflared_managed' &&
      (normalized.cloudflaredAutoStart || normalized.tunnelUrl.length === 0)
  })

  if (!tunnelUrl) return null

  return {
    strategy: 'local',
    storageMode: 'local',
    tunnelUrl,
    useHttps: /^https:\/\//i.test(tunnelUrl),
    tunnelProvider: normalized.tunnelProvider,
    cloudflaredAutoStart: normalized.cloudflaredAutoStart,
    cloudflaredTargetUrl: normalized.cloudflaredTargetUrl
  }
}

export async function resolveClipTunnelUrl(
  clip: Pick<ClipRow, 'tunnelPath' | 'localUrl' | 'displayUrl'>,
  settings?: UserSettingsRow | null,
  options?: { allowAutoStart?: boolean }
): Promise<string | null> {
  const derivedTunnelPath =
    trimString(clip.tunnelPath) ||
    buildTunnelPathFromLocalUrl(clip.localUrl) ||
    buildTunnelPathFromLocalUrl(clip.displayUrl) ||
    ''

  if (!derivedTunnelPath) {
    return null
  }

  const tunnelBaseUrl = await resolveLiveTunnelBaseUrl(settings, options)
  if (!tunnelBaseUrl) return null
  return buildTunnelUrl(tunnelBaseUrl, derivedTunnelPath)
}

export function resolveScreenshotUploadModelUrl(
  uploadedFile: Record<string, any> | null | undefined,
  uploadConfig: Pick<ScreenshotUploadConfig, 'tunnelUrl'>
): string | null {
  if (!uploadedFile || typeof uploadedFile !== 'object') return null

  const externalUrl =
    typeof uploadedFile.externalUrl === 'string' ? uploadedFile.externalUrl : null
  const uploadPath =
    typeof uploadedFile.tunnelPath === 'string'
      ? uploadedFile.tunnelPath
      : buildTunnelPathFromLocalUrl(
          uploadedFile.localUrl || uploadedFile.displayUrl || uploadedFile.url || null
        )
  const tunnelExternalUrl =
    uploadPath && uploadConfig.tunnelUrl
      ? buildTunnelUrl(uploadConfig.tunnelUrl, uploadPath)
      : null

  return tunnelExternalUrl || externalUrl || null
}
