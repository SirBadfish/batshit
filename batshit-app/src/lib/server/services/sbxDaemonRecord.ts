/**
 * Docker's `sbx` daemon: the record that lets quitting stop it when Batshit's own call started it
 * (2026-09-21, BL-61).
 *
 * Most `sbx` commands start Docker's background daemon when it is not running, and say so
 * (`Starting sandboxd daemon...`). Batshit asks `sbx` for the Docker Sandbox status whenever Agent
 * Settings or Admin opens, so it started the daemon even for someone who never ran a sandbox, and
 * nothing ever stopped it (macOS 27 then showed Batshit as "Running in Background" after quit).
 * When a call's output says it started the daemon, this writes which Batshit ran it, when the call
 * began and ended, and the `sbx` it ran. The Mac runtime supervisor and the native launcher read
 * that record at shutdown and stop the daemon only if it is the one that call started and no
 * sandbox runs: `batshit-mac/scripts/sbx-daemon-stop.mjs`, which this file twins for the record's
 * shape. A daemon the user started is never recorded, so Batshit never stops it.
 */

import { randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { resolveVoiceRuntimeLaunchOwner } from '$lib/server/services/voiceRuntimeLaunchRecords'

export const SBX_DAEMON_RECORD_NAME = '.batshit-sbx-daemon-launch.json'
const SBX_DAEMON_STATE_DIR_ENV_VAR = 'BATSHIT_SBX_DAEMON_STATE_DIR'
// `~/.batshit/runtime/sbx-daemon`, kept out of source text so deploy tracing never walks `~/.batshit`.
const SBX_DAEMON_STATE_DIR_FALLBACK_SEGMENTS_BASE64 = 'WyIuYmF0c2hpdCIsInJ1bnRpbWUiLCJzYngtZGFlbW9uIl0='

const DAEMON_STARTED_LINE = /^Starting sandboxd daemon/i

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? ''
}

/**
 * Did this `sbx` call start the daemon? sbx says so on the first line of its own output (stderr on
 * a Mac, stdout on Windows), before anything a sandboxed command prints, so a command that prints
 * the same words does not count. Twin of `sbxCallStartedDaemon` in `sbx-daemon-stop.mjs`.
 */
export function sbxCallStartedDaemon(stderr: string, stdout: string): boolean {
  return DAEMON_STARTED_LINE.test(firstLine(stderr)) || DAEMON_STARTED_LINE.test(firstLine(stdout))
}

/**
 * The `sbx` this process's PATH finds, as PATH names it (`/opt/homebrew/bin/sbx`, not the Homebrew
 * folder behind it, so the record survives an upgrade), or null. The shutdown runs that one: a
 * packaged app's supervisor has a shorter PATH than the app.
 */
async function findSbxOnPath(): Promise<string | null> {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, 'sbx')
    try {
      await access(candidate, fsConstants.X_OK)
      if ((await stat(candidate)).isFile()) return candidate
    } catch {
      // Not here.
    }
  }
  return null
}

/** `BATSHIT_SBX_DAEMON_STATE_DIR`, else `~/.batshit/runtime/sbx-daemon`: the supervisor reads the same folder. */
export function resolveSbxDaemonStateDir(): string {
  const configured = process.env[SBX_DAEMON_STATE_DIR_ENV_VAR]
  if (typeof configured === 'string' && configured.trim()) {
    const value = configured.trim()
    if (value === '~') return os.homedir()
    return path.resolve(value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value)
  }
  const segments = JSON.parse(
    Buffer.from(SBX_DAEMON_STATE_DIR_FALLBACK_SEGMENTS_BASE64, 'base64').toString('utf8')
  ) as string[]
  return path.resolve(os.homedir(), ...segments)
}

/**
 * Record that a call which ran from `callStartedAt` to `callEndedAt` (epoch ms) started the
 * daemon, as this Batshit (`BATSHIT_VOICE_RUNTIME_OWNER`, the identity its launcher gave it).
 * Replaced whole (temp file, then rename), so a shutdown never reads half a record.
 */
export async function recordSbxDaemonStart(callStartedAt: number, callEndedAt: number): Promise<void> {
  const stateDir = resolveSbxDaemonStateDir()
  const launchedBy = resolveVoiceRuntimeLaunchOwner()
  const sbxPath = await findSbxOnPath()
  const record = {
    ...(launchedBy ? { launchedBy } : {}),
    callStartedAt: new Date(callStartedAt).toISOString(),
    callEndedAt: new Date(callEndedAt).toISOString(),
    ...(sbxPath ? { sbxPath } : {})
  }
  await mkdir(stateDir, { recursive: true })
  const recordPath = path.join(stateDir, SBX_DAEMON_RECORD_NAME)
  const temp = path.join(stateDir, `${SBX_DAEMON_RECORD_NAME}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    await rename(temp, recordPath)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}
