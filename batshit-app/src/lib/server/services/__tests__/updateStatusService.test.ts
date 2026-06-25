import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env as privateEnv } from '$env/dynamic/private'
import {
  compareUpdateVersions,
  getUpdateStatus,
  resetUpdateStatusCache
} from '../updateStatusService'

const privateEnvKeys = [
  'BATSHIT_APP_VERSION',
  'BATSHIT_APP_CHANNEL',
  'BATSHIT_UPDATE_CHECK_DISABLED',
  'BATSHIT_UPDATE_LATEST_VERSION',
  'BATSHIT_UPDATE_RELEASE_URL',
  'BATSHIT_UPDATE_DOWNLOAD_URL',
  'BATSHIT_UPDATE_FEED_URL'
]

let previousPrivateEnv: Record<string, string | undefined>
let previousProcessEnv: Record<string, string | undefined>

function setEnv(key: string, value: string | undefined) {
  const mutableEnv = privateEnv as Record<string, string | undefined>
  if (value === undefined) {
    delete mutableEnv[key]
    delete process.env[key]
  } else {
    mutableEnv[key] = value
    process.env[key] = value
  }
}

describe('updateStatusService', () => {
  beforeEach(() => {
    previousPrivateEnv = Object.fromEntries(
      privateEnvKeys.map((key) => [key, (privateEnv as Record<string, string | undefined>)[key]])
    )
    previousProcessEnv = Object.fromEntries(privateEnvKeys.map((key) => [key, process.env[key]]))
    for (const key of privateEnvKeys) setEnv(key, undefined)
    resetUpdateStatusCache()
  })

  afterEach(() => {
    for (const key of privateEnvKeys) {
      const privateValue = previousPrivateEnv[key]
      const processValue = previousProcessEnv[key]
      const mutableEnv = privateEnv as Record<string, string | undefined>
      if (privateValue === undefined) {
        delete mutableEnv[key]
      } else {
        mutableEnv[key] = privateValue
      }
      if (processValue === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = processValue
      }
    }
    vi.unstubAllGlobals()
    resetUpdateStatusCache()
  })

  it('compares alpha release versions with numeric prerelease ordering', () => {
    expect(compareUpdateVersions('v0.1.0-alpha.2', '0.1.0-alpha.1')).toBeGreaterThan(0)
    expect(compareUpdateVersions('v0.1.0-alpha.10', 'v0.1.0-alpha.2')).toBeGreaterThan(0)
    expect(compareUpdateVersions('v0.1.0', 'v0.1.0-alpha.99')).toBeGreaterThan(0)
    expect(compareUpdateVersions('v0.1.0-alpha.1', 'v0.1.0-alpha.1')).toBe(0)
  })

  it('reports an update from explicit launch override values', async () => {
    setEnv('BATSHIT_APP_VERSION', '0.1.0-alpha.1')
    setEnv('BATSHIT_UPDATE_LATEST_VERSION', '0.1.0-alpha.2')
    setEnv('BATSHIT_UPDATE_RELEASE_URL', 'https://github.com/SirBadfish/batshit/releases/tag/v0.1.0-alpha.2')

    const status = await getUpdateStatus({ force: true })

    expect(status.ok).toBe(true)
    expect(status.updateAvailable).toBe(true)
    expect(status.currentVersion).toBe('v0.1.0-alpha.1')
    expect(status.latestVersion).toBe('v0.1.0-alpha.2')
    expect(status.source).toBe('env-override')
    expect(status.releaseUrl).toBe('https://github.com/SirBadfish/batshit/releases/tag/v0.1.0-alpha.2')
  })

  it('reads GitHub-style release feed payloads when no override is configured', async () => {
    setEnv('BATSHIT_APP_VERSION', '0.1.0-alpha.1')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          tag_name: 'v0.1.0-alpha.3',
          html_url: 'https://github.com/SirBadfish/batshit/releases/tag/v0.1.0-alpha.3',
          assets: [
            {
              name: 'Batshit-0.1.0-macos-ReleaseSafe.dmg',
              browser_download_url: 'https://example.com/Batshit.dmg'
            }
          ]
        })
      )
    )

    const status = await getUpdateStatus({ force: true })

    expect(status.updateAvailable).toBe(true)
    expect(status.latestVersion).toBe('v0.1.0-alpha.3')
    expect(status.downloadUrl).toBe('https://example.com/Batshit.dmg')
    expect(status.source).toBe('github-release')
  })
})
