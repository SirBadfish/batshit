import { env } from '$env/dynamic/private'
import { BATSHIT_APP_CHANNEL, BATSHIT_APP_VERSION } from '$lib/version'
import type { BatshitUpdateStatus } from '$lib/types/updateStatus'

const DEFAULT_RELEASE_FEED_URL = 'https://api.github.com/repos/SirBadfish/batshit/releases/latest'
const DEFAULT_RELEASES_URL = 'https://github.com/SirBadfish/batshit/releases/latest'
const CACHE_TTL_MS = 15 * 60 * 1000

type LatestRelease = {
  version: string
  releaseUrl: string | null
  downloadUrl: string | null
  source: BatshitUpdateStatus['source']
}

type CachedUpdateStatus = {
  key: string
  expiresAt: number
  status: BatshitUpdateStatus
}

let cachedStatus: CachedUpdateStatus | null = null

function readEnv(name: string): string {
  return (env[name] ?? process.env[name] ?? '').trim()
}

function normalizeVersionForDisplay(version: string | null | undefined): string | null {
  const normalized = (version ?? '').trim()
  if (!normalized) return null
  return normalized.startsWith('v') ? normalized : `v${normalized}`
}

function parseVersion(version: string) {
  const [withoutBuild] = version.trim().replace(/^v/i, '').split('+')
  const [mainPart, prereleasePart = ''] = withoutBuild.split('-', 2)
  const main = mainPart.split('.').map((part) => {
    const parsed = Number.parseInt(part, 10)
    return Number.isFinite(parsed) ? parsed : 0
  })

  while (main.length < 3) main.push(0)

  return {
    main: main.slice(0, 3),
    prerelease: prereleasePart ? prereleasePart.split('.') : []
  }
}

function comparePrereleaseIdentifier(left: string, right: string) {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)

  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right)
  }

  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left.localeCompare(right)
}

export function compareUpdateVersions(leftVersion: string, rightVersion: string): number {
  const left = parseVersion(leftVersion)
  const right = parseVersion(rightVersion)

  for (let index = 0; index < 3; index += 1) {
    const diff = left.main[index] - right.main[index]
    if (diff !== 0) return diff
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1

  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const diff = comparePrereleaseIdentifier(leftPart, rightPart)
    if (diff !== 0) return diff
  }

  return 0
}

function getCurrentVersion() {
  return (
    readEnv('BATSHIT_APP_VERSION') ||
    readEnv('PUBLIC_BATSHIT_APP_VERSION') ||
    BATSHIT_APP_VERSION
  )
}

function getChannel() {
  return readEnv('BATSHIT_APP_CHANNEL') || BATSHIT_APP_CHANNEL
}

function getCacheKey() {
  return [
    getCurrentVersion(),
    getChannel(),
    readEnv('BATSHIT_UPDATE_CHECK_DISABLED'),
    readEnv('BATSHIT_UPDATE_LATEST_VERSION'),
    readEnv('BATSHIT_UPDATE_RELEASE_URL'),
    readEnv('BATSHIT_UPDATE_DOWNLOAD_URL'),
    readEnv('BATSHIT_UPDATE_FEED_URL')
  ].join('|')
}

async function fetchLatestFromGitHub(feedUrl: string): Promise<LatestRelease> {
  const response = await fetch(feedUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Batshit update check'
    }
  })

  if (!response.ok) {
    throw new Error(`Release feed returned ${response.status}`)
  }

  const payload = await response.json()
  const tagName = typeof payload?.tag_name === 'string' ? payload.tag_name.trim() : ''
  if (!tagName) {
    throw new Error('Release feed did not include a tag name')
  }

  const assets = Array.isArray(payload?.assets) ? payload.assets : []
  const dmgAsset = assets.find((asset: any) =>
    typeof asset?.name === 'string' && asset.name.toLowerCase().endsWith('.dmg')
  )

  return {
    version: tagName,
    releaseUrl:
      typeof payload?.html_url === 'string' && payload.html_url.trim()
        ? payload.html_url.trim()
        : DEFAULT_RELEASES_URL,
    downloadUrl:
      typeof dmgAsset?.browser_download_url === 'string' && dmgAsset.browser_download_url.trim()
        ? dmgAsset.browser_download_url.trim()
        : null,
    source: 'github-release'
  }
}

async function resolveLatestRelease(): Promise<LatestRelease> {
  const overrideVersion = readEnv('BATSHIT_UPDATE_LATEST_VERSION')
  if (overrideVersion) {
    return {
      version: overrideVersion,
      releaseUrl: readEnv('BATSHIT_UPDATE_RELEASE_URL') || DEFAULT_RELEASES_URL,
      downloadUrl: readEnv('BATSHIT_UPDATE_DOWNLOAD_URL') || null,
      source: 'env-override'
    }
  }

  const feedUrl = readEnv('BATSHIT_UPDATE_FEED_URL') || DEFAULT_RELEASE_FEED_URL
  return fetchLatestFromGitHub(feedUrl)
}

function buildStatus({
  ok,
  currentVersion,
  latest,
  error = null
}: {
  ok: boolean
  currentVersion: string
  latest: LatestRelease | null
  error?: string | null
}): BatshitUpdateStatus {
  const latestVersion = normalizeVersionForDisplay(latest?.version)
  const currentDisplayVersion = normalizeVersionForDisplay(currentVersion) ?? currentVersion
  const updateAvailable =
    Boolean(latestVersion) && compareUpdateVersions(latestVersion!, currentDisplayVersion) > 0

  return {
    ok,
    updateAvailable,
    currentVersion: currentDisplayVersion,
    latestVersion,
    channel: getChannel(),
    releaseUrl: latest?.releaseUrl ?? null,
    downloadUrl: latest?.downloadUrl ?? null,
    source: latest?.source ?? 'unavailable',
    checkedAt: new Date().toISOString(),
    message: updateAvailable
      ? 'Update available'
      : ok
        ? 'Batshit is up to date'
        : 'Update check unavailable',
    error
  }
}

export async function getUpdateStatus({ force = false } = {}): Promise<BatshitUpdateStatus> {
  const currentVersion = getCurrentVersion()
  const cacheKey = getCacheKey()
  const now = Date.now()

  if (!force && cachedStatus && cachedStatus.key === cacheKey && cachedStatus.expiresAt > now) {
    return cachedStatus.status
  }

  let status: BatshitUpdateStatus

  if (readEnv('BATSHIT_UPDATE_CHECK_DISABLED') === '1') {
    status = {
      ok: true,
      updateAvailable: false,
      currentVersion: normalizeVersionForDisplay(currentVersion) ?? currentVersion,
      latestVersion: null,
      channel: getChannel(),
      releaseUrl: null,
      downloadUrl: null,
      source: 'disabled',
      checkedAt: new Date().toISOString(),
      message: 'Update checks are disabled',
      error: null
    }
  } else {
    try {
      status = buildStatus({
        ok: true,
        currentVersion,
        latest: await resolveLatestRelease()
      })
    } catch (error) {
      status = buildStatus({
        ok: false,
        currentVersion,
        latest: null,
        error: error instanceof Error ? error.message : 'Update check failed'
      })
    }
  }

  cachedStatus = {
    key: cacheKey,
    expiresAt: now + CACHE_TTL_MS,
    status
  }

  return status
}

export function resetUpdateStatusCache() {
  cachedStatus = null
}
