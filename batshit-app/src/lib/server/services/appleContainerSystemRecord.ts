/**
 * Apple's container system: the record that lets quitting stop it when Batshit's own call started it
 * (2026-09-22, BL-62 part 2).
 *
 * The first sandboxed command starts Apple's container system when it is stopped
 * (`startAppleContainerSystem` in appleContainerSandbox.ts, inside the sandbox lifecycle gate), and
 * nothing stopped it again, so `container-apiserver` and its vmnet plugins ran until logout. That
 * start writes which Batshit ran it, when the call began and ended, and the `container` it ran. The
 * Mac runtime supervisor and the native launcher read the record at shutdown and stop the system only
 * if the registration running then is the one that call made and no container runs:
 * `batshit-mac/scripts/apple-container-system-stop.mjs`, which this file twins for the record's
 * shape. A system the user started is never recorded, so Batshit never stops it.
 */

import { randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { resolveVoiceRuntimeLaunchOwner, withLocalRuntimeRecordLock } from '$lib/server/services/voiceRuntimeLaunchRecords'

export const APPLE_CONTAINER_SYSTEM_RECORD_NAME = '.batshit-apple-container-system.json'
const APPLE_CONTAINER_STATE_DIR_ENV_VAR = 'BATSHIT_APPLE_CONTAINER_STATE_DIR'
// `~/.batshit/runtime/apple-container`, kept out of source text so deploy tracing never walks `~/.batshit`.
const APPLE_CONTAINER_STATE_DIR_FALLBACK_SEGMENTS_BASE64 = 'WyIuYmF0c2hpdCIsInJ1bnRpbWUiLCJhcHBsZS1jb250YWluZXIiXQ=='

/** `BATSHIT_APPLE_CONTAINER_STATE_DIR`, else `~/.batshit/runtime/apple-container`: the stoppers read the same folder. */
export function resolveAppleContainerStateDir(): string {
  const configured = process.env[APPLE_CONTAINER_STATE_DIR_ENV_VAR]
  if (typeof configured === 'string' && configured.trim()) {
    const value = configured.trim()
    if (value === '~') return os.homedir()
    return path.resolve(value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value)
  }
  const segments = JSON.parse(
    Buffer.from(APPLE_CONTAINER_STATE_DIR_FALLBACK_SEGMENTS_BASE64, 'base64').toString('utf8')
  ) as string[]
  return path.resolve(os.homedir(), ...segments)
}

/**
 * The `container` this process's PATH finds, as PATH names it, or null. The shutdown runs that one
 * first: a packaged app's supervisor has a different PATH from the app.
 */
async function findContainerOnPath(): Promise<string | null> {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, 'container')
    try {
      await access(candidate, fsConstants.X_OK)
      if ((await stat(candidate)).isFile()) return candidate
    } catch {
      // Not here.
    }
  }
  return null
}

/**
 * Record that a `container system start` which ran from `callStartedAt` to `callEndedAt` (epoch ms)
 * started the system, as this Batshit (`BATSHIT_VOICE_RUNTIME_OWNER`, the identity its launcher
 * gave it). Replaced whole (temp file, then rename), so a shutdown never reads half a record.
 */
export async function recordAppleContainerSystemStart(callStartedAt: number, callEndedAt: number): Promise<void> {
  const stateDir = resolveAppleContainerStateDir()
  const launchedBy = resolveVoiceRuntimeLaunchOwner()
  const containerPath = await findContainerOnPath()
  const record = {
    ...(launchedBy ? { launchedBy } : {}),
    callStartedAt: new Date(callStartedAt).toISOString(),
    callEndedAt: new Date(callEndedAt).toISOString(),
    ...(containerPath ? { containerPath } : {})
  }
  await mkdir(stateDir, { recursive: true })
  const recordPath = path.join(stateDir, APPLE_CONTAINER_SYSTEM_RECORD_NAME)
  const temp = path.join(
    stateDir,
    `${APPLE_CONTAINER_SYSTEM_RECORD_NAME}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  )
  // Under the folder's record lock (the voice launch records' own), so a stopper never decides on
  // one generation of this record and acts on another (BL-1257).
  await withLocalRuntimeRecordLock(stateDir, async () => {
    try {
      await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      await rename(temp, recordPath)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  })
}
