import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$app/environment', () => ({ browser: true }))

import { exportBackupNatively } from './download'

type TestWindow = Window & {
  zero?: {
    downloads?: {
      exportBackup?: (options: { includeSecrets: boolean; partial?: unknown }) => Promise<unknown>
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

  it('hands back the folders the backup could not carry, and refuses a malformed value (BL-373/BL-369)', async () => {
    const notCarried = encodeURIComponent(JSON.stringify({ count: 1, items: [{ root: 'skills', label: 'Gone', reason: 'missing' }] }))
    const exportBackup = vi.fn().mockResolvedValue({ completed: true, native: true, canceled: false, path: '/tmp/b.zip', notCarried })
    ;(window as TestWindow).zero = { downloads: { exportBackup } }
    await expect(exportBackupNatively(false)).resolves.toMatchObject({ notCarried })

    exportBackup.mockResolvedValue({ completed: true, native: true, canceled: false, notCarried: 3 })
    await expect(exportBackupNatively(false)).rejects.toThrow('The Mac backup export returned an invalid result.')
  })

  // BL-378 Phase 1b: a partial request goes through the bridge whole, and its summary comes back as
  // text. A summary that is not text never turns a written backup into a failure: it is dropped,
  // so the panel's strict parser calls it unavailable.
  it('passes a partial request through and hands back its summary; a malformed summary is dropped, not a failure', async () => {
    const partial = { acknowledged: [{ key: 'upload:images:a.png', relativePath: 'images/a.png', fingerprint: 'a'.repeat(64) }] }
    const exportBackup = vi.fn().mockResolvedValue({ completed: true, native: true, canceled: false, missingUploads: '{"x":1}' })
    ;(window as TestWindow).zero = { downloads: { exportBackup } }
    await expect(exportBackupNatively(false, partial)).resolves.toMatchObject({ completed: true, missingUploads: '{"x":1}' })
    expect(exportBackup).toHaveBeenLastCalledWith({ includeSecrets: false, partial })

    exportBackup.mockResolvedValue({ completed: true, native: true, canceled: false, missingUploads: 7 })
    const written = await exportBackupNatively(false, partial)
    expect(written).toMatchObject({ completed: true, native: true, canceled: false })
    expect(written?.missingUploads).toBeUndefined()
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
