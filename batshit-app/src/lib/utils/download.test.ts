import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$app/environment', () => ({ browser: true }))

import { exportBackupNatively } from './download'

type TestWindow = Window & {
  zero?: {
    downloads?: {
      exportBackup?: (options: { includeSecrets: boolean }) => Promise<unknown>
    }
  }
}

describe('native backup export selection', () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, 'zero')
  })

  it('returns null when the narrow Mac export bridge is unavailable', async () => {
    await expect(exportBackupNatively(false)).resolves.toBeNull()
  })

  it('uses the direct Mac export bridge before any browser blob download', async () => {
    const exportBackup = vi.fn().mockResolvedValue({
      completed: true,
      native: true,
      canceled: false,
      path: '/tmp/batshit-backup.zip'
    })
    ;(window as TestWindow).zero = { downloads: { exportBackup } }

    await expect(exportBackupNatively(true)).resolves.toEqual({
      completed: true,
      native: true,
      canceled: false,
      path: '/tmp/batshit-backup.zip'
    })
    expect(exportBackup).toHaveBeenCalledOnce()
    expect(exportBackup).toHaveBeenCalledWith({ includeSecrets: true })
  })

  it('fails visibly if a changed preload returns an invalid result shape', async () => {
    ;(window as TestWindow).zero = {
      downloads: { exportBackup: vi.fn().mockResolvedValue({ completed: 'yes' }) }
    }

    await expect(exportBackupNatively(false)).rejects.toThrow(
      'The Mac backup export returned an invalid result.'
    )
  })
})
