import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { completePendingGoonAssetRestore, readPendingGoonAssetRestore, withGoonAssetRestoreBarrier } from '../goonAssetRestoreBarrier.server'

let stagingRoot: string
beforeEach(async () => {
  stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'goon-restore-barrier-'))
  vi.stubEnv('BATSHIT_TOKEN', 'goon-restore-test-service-token')
})
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await fs.rm(stagingRoot, { recursive: true, force: true })
})

function transport(handler?: (action: string, token: string) => Promise<void>) {
  const calls: { action: string; token: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const action = url.split('/').at(-1)!
    expect(['begin', 'end']).toContain(action)
    const { token } = JSON.parse(String(init.body))
    // Recovery authority is already on disk when a request may reach the server.
    expect(await readPendingGoonAssetRestore(stagingRoot)).toBe(token)
    calls.push({ action, token })
    await handler?.(action, token)
    return Response.json({ success: true, token, state: action === 'begin' ? 'created' : 'released', activeOperations: 0 })
  }))
  return calls
}

describe('Goon file-service restore coordination', () => {
  it('waits for confirmed file settlement before any restore mutation', async () => {
    let release!: () => void
    let entered!: () => void
    const began = new Promise<void>((resolve) => { entered = resolve })
    const paused = new Promise<void>((resolve) => { release = resolve })
    const calls = transport(async (action) => { if (action === 'begin') { entered(); await paused } })
    const mutate = vi.fn(async () => 'restored')
    const pending = withGoonAssetRestoreBarrier(stagingRoot, mutate)
    await began
    expect(mutate).not.toHaveBeenCalled()
    await expect(withGoonAssetRestoreBarrier(stagingRoot, mutate)).rejects.toThrow('already running')
    release()
    await expect(pending).resolves.toBe('restored')
    expect(calls.map(({ action }) => action)).toEqual(['begin', 'end'])
    expect(await readPendingGoonAssetRestore(stagingRoot)).toBeNull()
  })

  it('keeps a lost end response recoverable with the exact original token', async () => {
    const calls = transport(async (action) => { if (action === 'end') throw new Error('connection lost') })
    await expect(withGoonAssetRestoreBarrier(stagingRoot, async () => {})).rejects.toThrow('connection lost')
    const token = await readPendingGoonAssetRestore(stagingRoot)
    expect(token).toBe(calls[0].token)
    const recoverCalls = transport()
    await completePendingGoonAssetRestore(stagingRoot)
    expect(recoverCalls).toEqual([{ action: 'end', token }])
    expect(await readPendingGoonAssetRestore(stagingRoot)).toBeNull()
  })

  it('ends an uncertain begin without starting restore', async () => {
    const calls = transport(async (action) => { if (action === 'begin') throw new Error('begin response lost') })
    const mutate = vi.fn(async () => {})
    await expect(withGoonAssetRestoreBarrier(stagingRoot, mutate)).rejects.toThrow('begin response lost')
    expect(mutate).not.toHaveBeenCalled()
    expect(calls.map(({ action }) => action)).toEqual(['begin', 'end'])
    expect(await readPendingGoonAssetRestore(stagingRoot)).toBeNull()
  })

  it('retains the fence across failed rollback and releases it only after journal recovery', async () => {
    const journalPath = path.join(stagingRoot, 'interrupted.restore-journal.json')
    const calls = transport()
    await expect(withGoonAssetRestoreBarrier(stagingRoot, async () => {
      await fs.writeFile(journalPath, '{}')
      throw new Error('rollback failed')
    })).rejects.toThrow('rollback failed')
    expect(calls.map(({ action }) => action)).toEqual(['begin'])
    const token = await readPendingGoonAssetRestore(stagingRoot)
    await withGoonAssetRestoreBarrier(stagingRoot, () => fs.unlink(journalPath), { recover: true })
    expect(calls.map(({ action }) => action)).toEqual(['begin', 'begin', 'end'])
    expect(calls.every((call) => call.token === token)).toBe(true)
  })

  it('reuses a persisted token after a process restart and refuses a fresh owner', async () => {
    const token = randomUUID()
    await fs.writeFile(path.join(stagingRoot, 'goon-asset-restore.json'), JSON.stringify({ contract: 'goon-asset-restore/v1', token }))
    const calls = transport()
    await expect(withGoonAssetRestoreBarrier(stagingRoot, async () => {})).rejects.toThrow('earlier restore')
    expect(calls).toHaveLength(0)
    await completePendingGoonAssetRestore(stagingRoot)
    expect(calls.every((call) => call.token === token)).toBe(true)
  })
})
