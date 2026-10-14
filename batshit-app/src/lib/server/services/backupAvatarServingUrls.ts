import path from 'node:path'

const AVATAR_KEY_PREFIX = 'upload:avatars:'
const AVATAR_TYPES = new Set(['user', 'agent', 'subagent', 'group'])
const LOCAL_UPLOAD_URL_FIELDS = new Set([
  'url', 'displayUrl', 'localUrl', 'thumbnailUrl', 'avatar', 'avatar_url', 'imageUrl', 'image_url'
])

interface UploadRecord {
  key: string
  value: unknown
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function relativePathOf(value: unknown): string | null {
  if (!isObject(value) || typeof value.relativePath !== 'string') return null
  const relativePath = value.relativePath.trim().split(path.sep).join('/')
  return relativePath || null
}

/**
 * BL-1408: a serving URL is distinct from its archived file path. The existing flat avatar GET
 * first reads the flat key, then a typed key inferred from a filename with at least three `_`
 * parts. Bind exact avatar aliases only to archived records that that lookup can reach. Never
 * flatten an arbitrary path, alter the generic basename index or add a Redis alias record.
 */
export function buildAvatarServingUrlOverrides(records: readonly UploadRecord[]): ReadonlyMap<string, string> {
  const avatars: Array<{ filename: string; entityType: string | null; relativePath: string }> = []
  for (const record of records) {
    if (!record.key.startsWith(AVATAR_KEY_PREFIX)) continue
    const parts = record.key.slice(AVATAR_KEY_PREFIX.length).split(':')
    const entityType = parts.length === 2 && AVATAR_TYPES.has(parts[0]) ? parts[0] : null
    if (parts.length !== 1 && entityType === null) continue
    const filename = parts[parts.length - 1]
    if (!filename || filename === '.' || filename === '..' || /[/\\\0]/.test(filename)) continue
    const relativePath = relativePathOf(record.value)
    if (!relativePath) continue
    const allowed = relativePath === `avatars/${filename}` ||
      Array.from(AVATAR_TYPES).some((type) => relativePath === `avatars/${type}/${filename}` && (entityType === null || entityType === type))
    if (allowed) avatars.push({ filename, entityType, relativePath })
  }

  const flatKeys = new Set(avatars.filter((avatar) => avatar.entityType === null).map((avatar) => avatar.filename))
  const overrides = new Map<string, string>()
  for (const avatar of avatars) {
    const filenameParts = avatar.filename.split('_')
    if (avatar.entityType !== null && !flatKeys.has(avatar.filename) &&
      (filenameParts.length < 3 || filenameParts[0] !== avatar.entityType)) continue
    const servingPath = `/uploads/avatars/${avatar.filename}`
    overrides.set(servingPath, servingPath)
    overrides.set(`/uploads/${avatar.relativePath}`, servingPath)
  }
  return overrides
}

function uploadPathFromString(
  value: string,
  uploadRelativePathByBasename: ReadonlyMap<string, string>,
  avatarServingOverrides: ReadonlyMap<string, string>
) {
  const trimmed = value.trim()
  if (!trimmed) return null
  let pathname: string | null = null
  if (trimmed.startsWith('/uploads/')) pathname = trimmed
  else {
    try {
      const parsed = new URL(trimmed)
      pathname = parsed.pathname.startsWith('/uploads/') ? parsed.pathname : null
    } catch { pathname = null }
  }
  if (!pathname) return null
  const avatarPath = avatarServingOverrides.get(pathname)
  if (avatarPath) return avatarPath
  const indexedRelativePath = uploadRelativePathByBasename.get(path.posix.basename(pathname))
  return indexedRelativePath ? `/uploads/${indexedRelativePath}` : pathname
}

/** The existing recursive restore URL rewrite, with only the exact avatar serving override. */
export function rewriteRestoredUploadUrls(
  value: unknown,
  uploadRelativePathByBasename: ReadonlyMap<string, string>,
  avatarServingOverrides: ReadonlyMap<string, string>
): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteRestoredUploadUrls(item, uploadRelativePathByBasename, avatarServingOverrides))
  if (!isObject(value)) return value
  const next: Record<string, unknown> = Object.fromEntries(
    Object.entries(value).map(([key, raw]) => [key, rewriteRestoredUploadUrls(raw, uploadRelativePathByBasename, avatarServingOverrides)])
  )
  const explicitRelativePath = relativePathOf(next)
  const explicitPath = explicitRelativePath ? `/uploads/${explicitRelativePath}` : null
  const explicitUploadPath = explicitPath ? avatarServingOverrides.get(explicitPath) ?? explicitPath : null
  const rewritePath = (raw: unknown) => typeof raw === 'string'
    ? uploadPathFromString(raw, uploadRelativePathByBasename, avatarServingOverrides) ?? explicitUploadPath
    : explicitUploadPath
  for (const [key, raw] of Object.entries(value)) {
    if (!LOCAL_UPLOAD_URL_FIELDS.has(key) || typeof raw !== 'string') continue
    const uploadPath = rewritePath(raw)
    if (uploadPath) next[key] = uploadPath
  }
  const tunnelPath = typeof value.tunnelPath === 'string' ? value.tunnelPath : null
  const normalizedTunnelPath = tunnelPath
    ? uploadPathFromString(tunnelPath, uploadRelativePathByBasename, avatarServingOverrides)
    : explicitUploadPath
  if (normalizedTunnelPath && 'tunnelPath' in value) next.tunnelPath = normalizedTunnelPath
  return next
}
