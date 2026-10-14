import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { getInternalBatshitServerAuthHeaders, getInternalBatshitServerUrl } from './batshitServerUrls'

const MARKER_FILENAME = 'goon-asset-restore.json'
const CONTRACT = 'goon-asset-restore/v1'
let active = false

export function isGoonAssetRestoreActive() { return active }

/** This local recovery record is outside uploads and outside backup contents.
 * It must reach disk before the file service can own its no-TTL Redis fence. */
export async function readPendingGoonAssetRestore(stagingRoot: string): Promise<string | null> {
  let raw: string
  try {
    raw = await fs.readFile(path.join(stagingRoot, MARKER_FILENAME), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const marker = JSON.parse(raw)
  if (marker?.contract !== CONTRACT || typeof marker.token !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(marker.token)) {
    throw new Error('The Goon restore recovery record is invalid. Restore remains blocked.')
  }
  return marker.token
}

async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function persistToken(stagingRoot: string, token: string) {
  await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 })
  const markerPath = path.join(stagingRoot, MARKER_FILENAME)
  // Publish a complete record atomically; a crash writing the temporary file
  // cannot strand a malformed record before any server request was made.
  const temporaryPath = `${markerPath}.${token}.tmp`
  const handle = await fs.open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify({ contract: CONTRACT, token }))
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    // link() refuses to replace a recovery record owned by another operation.
    await fs.link(temporaryPath, markerPath)
    await syncDirectory(stagingRoot)
  } finally {
    await fs.rm(temporaryPath, { force: true })
  }
}

async function requestBarrier(action: 'begin' | 'end', token: string) {
  const response = await fetch(`${getInternalBatshitServerUrl()}/api/upload/asset-maintenance/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...getInternalBatshitServerAuthHeaders() },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(40_000)
  })
  const result = await response.json().catch(() => null)
  if (!response.ok || result?.success !== true || result.token !== token ||
      (action === 'begin' && result.activeOperations !== 0) ||
      !(action === 'begin' ? ['created', 'existing'] : ['released', 'absent']).includes(result.state)) {
    throw new Error(`The file service could not ${action === 'begin' ? 'pause Goon file work for' : 'release Goon file work after'} restore (${response.status}). Retry restore recovery.`)
  }
}

async function releaseBarrier(stagingRoot: string, token: string) {
  await requestBarrier('end', token)
  await fs.unlink(path.join(stagingRoot, MARKER_FILENAME))
  await syncDirectory(stagingRoot)
}

/** No journal means no file/Redis mutation remains to recover. End directly:
 * begin must never reopen a token whose earlier end response was lost. */
export async function completePendingGoonAssetRestore(stagingRoot: string) {
  if (active) throw new Error('Another backup restore is already running.')
  active = true
  try {
    const token = await readPendingGoonAssetRestore(stagingRoot)
    if (!token) return
    if ((await fs.readdir(stagingRoot)).some((name) => name.endsWith('.restore-journal.json'))) {
      throw new Error('A restore journal must finish recovery before Goon file work can resume.')
    }
    await releaseBarrier(stagingRoot, token)
  } finally {
    active = false
  }
}

/** One app and one file service own a Redis/upload root. The persistent token
 * fences file work across either process restarting. Recovery reuses it; no
 * timeout, peer disconnect, or inferred process age grants a new owner. */
export async function withGoonAssetRestoreBarrier<T>(
  stagingRoot: string,
  restore: () => Promise<T>,
  options: { recover?: boolean } = {}
): Promise<T> {
  if (active) throw new Error('Another backup restore is already running.')
  active = true
  try {
    const previousToken = await readPendingGoonAssetRestore(stagingRoot)
    if (previousToken && !options.recover) {
      throw new Error('An earlier restore must finish recovery before another restore can start.')
    }
    const token = previousToken ?? randomUUID()
    if (!previousToken) await persistToken(stagingRoot, token)
    try {
      await requestBarrier('begin', token)
      return await restore()
    } finally {
      // A failed rollback must retain the server fence until startup recovers
      // its journal. Even begin failure may have reached the server, so an
      // empty journal set still requires acknowledged end before unlinking.
      const journals = (await fs.readdir(stagingRoot)).filter((name) => name.endsWith('.restore-journal.json'))
      if (journals.length === 0) {
        await releaseBarrier(stagingRoot, token)
      }
    }
  } finally {
    active = false
  }
}
