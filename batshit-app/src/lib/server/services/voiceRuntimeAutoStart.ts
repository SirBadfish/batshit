import { URL } from 'node:url'

import type {
  LocalVoiceEngineInstallOwnership,
  VoiceEngineLocalRuntimeConfig,
  VoiceEngineRecord
} from '$lib/types/voice'
import {
  listVoiceEngineRecords,
  upsertVoiceEngineRecord
} from '$lib/server/services/voiceEngineRegistry'
import { inspectByoSpeechRuntimeForRecord } from '$lib/server/services/voiceService'
import {
  startLocalVoiceRuntime
} from '$lib/server/services/voiceLocalEngineSetup'
import {
  resolveLocalVoiceRuntimeLogPath,
  resolveManagedInstallsRoot
} from '$lib/server/services/voiceLocalRuntimePaths'
import { startHostVoiceRuntimeViaOperator } from '$lib/server/services/voiceHostOperatorRuntime'
import { autoStartLiveKitSidecarRuntime } from '$lib/server/services/liveKitSidecarRuntime'

const AUTO_START_RECENT_WINDOW_MS = 15_000
const AUTO_START_READY_TIMEOUT_MS = 45_000
const AUTO_START_POLL_INTERVAL_MS = 1_500
const SHARED_MLX_RUNTIME_COMMAND = '~/.batshit/tools/mlx-audio/.venv/bin/mlx_audio.server'

type AutoStartResultStatus =
  | 'started'
  | 'already-running'
  | 'skipped'
  | 'error'

export type VoiceRuntimeAutoStartResult = {
  kind?: 'voice-engine' | 'voice-session-runtime'
  engineId?: string
  providerId?: `byo:${string}`
  runtimeId?: string
  status: AutoStartResultStatus
  reason?: string
  pid?: number | null
}

export type VoiceRuntimeAutoStartReport = {
  userId: string
  triggeredAt: string
  skippedBecauseRecent: boolean
  results: VoiceRuntimeAutoStartResult[]
}

const inflightByUser = new Map<string, Promise<VoiceRuntimeAutoStartReport>>()
const lastRunAtByUser = new Map<string, number>()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isContainerizedRuntime(): boolean {
  return process.env.BATSHIT_CONTAINERIZED === '1' || process.env.BATSHIT_RUNTIME_ENV === 'docker'
}

function buildProviderId(engineId: string): `byo:${string}` {
  return `byo:${engineId}`
}

function isLocalhostBaseUrl(value: string | undefined): boolean {
  if (!value) return false
  try {
    const parsed = new URL(value)
    return ['127.0.0.1', 'localhost'].includes(parsed.hostname)
  } catch {
    return false
  }
}

function inferLegacyMlxPort(value: string | undefined): string | null {
  if (!value) return null
  try {
    const parsed = new URL(value)
    return parsed.port?.trim() ? parsed.port.trim() : null
  } catch {
    return null
  }
}

function canInferLegacyMlxRuntime(record: VoiceEngineRecord): boolean {
  return (
    record.requestFormat === 'openai-compatible' &&
    isLocalhostBaseUrl(record.baseUrl) &&
    record.ttsPath === '/v1/audio/speech' &&
    record.healthPath === '/v1/models' &&
    typeof record.ttsDefaults?.modelId === 'string' &&
    record.ttsDefaults.modelId.startsWith('mlx-community/')
  )
}

function buildLegacyManagedInstallMetadata(engineId: string): {
  installRoot: string
  installOwnership: LocalVoiceEngineInstallOwnership
  logPath?: string
} {
  const installRoot = `${resolveManagedInstallsRoot()}/${engineId}`
  return {
    installRoot,
    installOwnership: 'batshit-managed',
    logPath: resolveLocalVoiceRuntimeLogPath(engineId)
  }
}

async function inferEffectiveLocalRuntime(
  userId: string,
  record: VoiceEngineRecord
): Promise<VoiceEngineRecord> {
  if (record.localRuntime?.installRoot && record.localRuntime.launch?.command) {
    return record
  }

  if (!canInferLegacyMlxRuntime(record)) {
    return record
  }

  const port = inferLegacyMlxPort(record.baseUrl)
  if (!port) {
    return record
  }

  const legacyState = buildLegacyManagedInstallMetadata(record.id)
  const inferredLocalRuntime: VoiceEngineLocalRuntimeConfig = {
    ...(record.localRuntime ?? {}),
    installRoot: legacyState?.installRoot ?? `${resolveManagedInstallsRoot()}/${record.id}`,
    installOwnership: legacyState?.installOwnership ?? 'batshit-managed',
    launch: {
      command: SHARED_MLX_RUNTIME_COMMAND,
      args: ['--host', '127.0.0.1', '--port', port],
      logPath: legacyState?.logPath ?? resolveLocalVoiceRuntimeLogPath(record.id)
    },
    startup: {
      autoStartOnLaunch: record.localRuntime?.startup?.autoStartOnLaunch ?? false
    }
  }

  const persisted = await upsertVoiceEngineRecord(userId, record.id, {
    localRuntime: inferredLocalRuntime
  })

  return {
    ...record,
    localRuntime: persisted.record.localRuntime ?? inferredLocalRuntime
  }
}

async function waitForReady(record: VoiceEngineRecord): Promise<{ ready: boolean; reason?: string }> {
  const deadline = Date.now() + AUTO_START_READY_TIMEOUT_MS
  let status = await inspectByoSpeechRuntimeForRecord(record, { allowDisabled: true })

  while (!status.ready && status.state !== 'error' && Date.now() < deadline) {
    await sleep(AUTO_START_POLL_INTERVAL_MS)
    status = await inspectByoSpeechRuntimeForRecord(record, { allowDisabled: true })
  }

  return {
    ready: status.ready,
    reason: status.statusHint
  }
}

async function autoStartVoiceRuntimes(userId: string): Promise<VoiceRuntimeAutoStartReport> {
  const results: VoiceRuntimeAutoStartResult[] = []
  const records = await listVoiceEngineRecords(userId)

  for (const rawRecord of records) {
    const providerId = buildProviderId(rawRecord.id)
    const autoStartEnabled = rawRecord.localRuntime?.startup?.autoStartOnLaunch === true

    if (rawRecord.enabled === false || !autoStartEnabled) {
      continue
    }

    const record = await inferEffectiveLocalRuntime(userId, rawRecord)
    const localRuntime = record.localRuntime

    if (!localRuntime?.installRoot || !localRuntime.launch?.command) {
      results.push({
        engineId: record.id,
        providerId,
        status: 'error',
        reason:
          'Batshit does not have a saved relaunch recipe for this engine yet. Re-run speech setup once to capture it.'
      })
      continue
    }

    let currentStatus
    try {
      currentStatus = await inspectByoSpeechRuntimeForRecord(record, { allowDisabled: true })
    } catch (error) {
      results.push({
        engineId: record.id,
        providerId,
        status: 'error',
        reason: error instanceof Error ? error.message : 'Failed to inspect engine health before auto-start.'
      })
      continue
    }
    if (currentStatus.ready || currentStatus.state === 'initializing') {
      results.push({
        engineId: record.id,
        providerId,
        status: 'already-running',
        reason: currentStatus.statusHint
      })
      continue
    }

    if (currentStatus.state === 'error') {
      results.push({
        engineId: record.id,
        providerId,
        status: 'error',
        reason:
          currentStatus.statusHint ??
          'The engine is reachable but unhealthy, so Batshit refused to auto-start a second copy.'
      })
      continue
    }

    try {
      const started = isContainerizedRuntime()
        ? await startHostVoiceRuntimeViaOperator({
            engineId: record.id,
            installRoot: localRuntime.installRoot,
            installOwnership: localRuntime.installOwnership,
            launch: localRuntime.launch
          })
        : await startLocalVoiceRuntime({
            userId,
            engineId: record.id,
            installRoot: localRuntime.installRoot,
            installOwnership: localRuntime.installOwnership,
            launch: localRuntime.launch
          })

      const readiness = await waitForReady(record)
      results.push({
        engineId: record.id,
        providerId,
        status: readiness.ready ? 'started' : 'error',
        pid: started.pid,
        reason:
          readiness.ready
            ? readiness.reason
            : readiness.reason ??
              'Batshit launched the runtime, but it did not become healthy before the startup timeout.'
      })
    } catch (error) {
      results.push({
        engineId: record.id,
        providerId,
        status: 'error',
        reason: error instanceof Error ? error.message : 'Failed to auto-start the local runtime.'
      })
    }
  }

  const liveKitResult = await autoStartLiveKitSidecarRuntime(userId)
  if (liveKitResult) {
    results.push({
      kind: 'voice-session-runtime',
      runtimeId: liveKitResult.id,
      status: liveKitResult.alreadyRunning
        ? 'already-running'
        : liveKitResult.started
          ? 'started'
          : 'error',
      pid: liveKitResult.pid,
      reason: liveKitResult.statusHint
    })
  }

  return {
    userId,
    triggeredAt: new Date().toISOString(),
    skippedBecauseRecent: false,
    results
  }
}

export async function ensureVoiceRuntimesAutoStarted(
  userId: string
): Promise<VoiceRuntimeAutoStartReport> {
  const lastRunAt = lastRunAtByUser.get(userId) ?? 0
  if (Date.now() - lastRunAt < AUTO_START_RECENT_WINDOW_MS) {
    return {
      userId,
      triggeredAt: new Date().toISOString(),
      skippedBecauseRecent: true,
      results: []
    }
  }

  const existing = inflightByUser.get(userId)
  if (existing) {
    return existing
  }

  const promise = autoStartVoiceRuntimes(userId)
    .then((report) => {
      lastRunAtByUser.set(userId, Date.now())
      return report
    })
    .finally(() => {
      inflightByUser.delete(userId)
    })

  inflightByUser.set(userId, promise)
  return promise
}
