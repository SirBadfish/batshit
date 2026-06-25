import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import type { ClipRow, UserSettingsRow } from '$lib/types/database'
import { redis } from '$lib/server/redis'
import { resolveClipTunnelUrl } from './clipUrlResolver'

type ClipUploadLocator = {
  uploadType: string
  filename: string
  path: string
  redisKey: string
}

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function isRemoteHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return false

  try {
    const parsed = new URL(value)
    const host = parsed.hostname.toLowerCase()
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '0.0.0.0' && host !== '::1'
  } catch {
    return false
  }
}

export function resolveClipUploadPath(
  clip: Pick<ClipRow, 'tunnelPath' | 'localUrl' | 'displayUrl' | 'externalUrl'>
): string | null {
  const candidates = [
    trimString(clip.tunnelPath),
    trimString(clip.localUrl),
    trimString(clip.displayUrl),
    trimString(clip.externalUrl)
  ]

  for (const candidate of candidates) {
    if (!candidate) continue
    if (candidate.startsWith('/uploads/')) return candidate

    try {
      const parsed = new URL(candidate)
      if (parsed.pathname.startsWith('/uploads/')) {
        return `${parsed.pathname}${parsed.search}${parsed.hash}`
      }
    } catch {
      // Ignore non-URL candidates.
    }
  }

  return null
}

export function resolveClipUploadLocator(
  clip: Pick<ClipRow, 'tunnelPath' | 'localUrl' | 'displayUrl' | 'externalUrl'>
): ClipUploadLocator | null {
  const path = resolveClipUploadPath(clip)
  if (!path) return null

  const pathname = path.split(/[?#]/, 1)[0] || ''
  const match = pathname.match(/^\/uploads\/([^/]+)\/(.+)$/)
  if (!match) return null

  const uploadType = decodeURIComponent(match[1] || '')
  const filename = decodeURIComponent(match[2] || '')
  if (!uploadType || !filename) return null

  return {
    uploadType,
    filename,
    path,
    redisKey: `upload:${uploadType}:${filename}`
  }
}

export async function resolveClipDataUrlFromStoredUpload(
  clip: Pick<ClipRow, 'mimeType' | 'localBase64' | 'tunnelPath' | 'localUrl' | 'displayUrl' | 'externalUrl'>
): Promise<string | null> {
  const legacyBase64 = trimString(clip.localBase64)
  if (legacyBase64) {
    return legacyBase64.startsWith('data:')
      ? legacyBase64
      : `data:${clip.mimeType || 'application/octet-stream'};base64,${legacyBase64}`
  }

  const locator = resolveClipUploadLocator(clip)
  if (!locator) return null

  const uploadRecord = await redis.get(locator.redisKey)
  if (!uploadRecord || typeof uploadRecord !== 'object') return null

  const mimeType = trimString((uploadRecord as any).mimetype) || clip.mimeType || 'application/octet-stream'
  const storedBase64 = trimString((uploadRecord as any).base64)
  if (storedBase64) {
    return `data:${mimeType};base64,${storedBase64}`
  }

  const filePath = trimString((uploadRecord as any).filePath)
  if ((uploadRecord as any).storage === 'filesystem' && filePath) {
    const bytes = await readFile(filePath)
    return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`
  }

  return null
}

export async function resolveClipPreferredUrl(
  clip: Pick<ClipRow, 'tunnelPath' | 'localUrl' | 'displayUrl' | 'externalUrl'>,
  settings?: UserSettingsRow | null,
  options?: { allowAutoStart?: boolean }
): Promise<string | null> {
  const tunnelUrl = await resolveClipTunnelUrl(clip, settings, options)
  return tunnelUrl || trimString(clip.externalUrl) || trimString(clip.localUrl) || trimString(clip.displayUrl) || null
}

export async function resolveClipPreferredRemoteUrl(
  clip: Pick<ClipRow, 'tunnelPath' | 'localUrl' | 'displayUrl' | 'externalUrl'>,
  settings?: UserSettingsRow | null,
  options?: { allowAutoStart?: boolean }
): Promise<string | null> {
  const preferredUrl = await resolveClipPreferredUrl(clip, settings, options)
  return isRemoteHttpUrl(preferredUrl) ? preferredUrl : null
}
