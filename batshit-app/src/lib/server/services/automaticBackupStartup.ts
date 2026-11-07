import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { getInternalBatshitServerUrl } from './batshitServerUrls'
import { setAutomaticBackupStartup, startAutomaticBackupScheduler } from './automaticBackupService'
import type { SkillFilesystemStartupResult } from './skillRegistry'
import type { MemoryMediaMigrationResult } from './memory/memoryMediaMigration'
import { registerRuntimeShutdownTask } from './runtimeShutdown'
import type { MemoryIndexBootstrapResult } from './memory/memoryIndex'
import type { ZipDefaultsSweepResult } from './zipDefaultsSweep'

export type AutomaticBackupStartupWork = {
  recovery: Promise<unknown>
  skills: Promise<SkillFilesystemStartupResult>
  zipPrompts: Promise<unknown>
  promptDefaults: Promise<unknown>
  retiredPrompts: Promise<unknown>
  retiredClips: Promise<unknown>
  retiredZipFields: Promise<unknown>
  zipDefaults: Promise<ZipDefaultsSweepResult>
  memoryIndexes: Promise<MemoryIndexBootstrapResult>
  memoryMedia: Promise<MemoryMediaMigrationResult>
}

// Versioned data-format/startup contracts, not a fingerprint of all user data.
// Do not use this to skip a time-based backup when the data may have changed.
const DATA_GENERATION_CONTRACTS = [
  'restore-recovery/v4', 'skill-filesystem/v1', 'zip-prompt-fold/v1',
  'core-prompt-defaults/v1', 'retired-prompts/v1', 'retired-clips/v1',
  'retired-zip-fields/v1', 'zip-defaults/v1', 'memory-index/v1',
  'memory-media/v1', 'file-backed-upload/v1', 'explicit-tool-grants/v1'
] as const

export function automaticBackupBuildId(builtVersion: string, development: boolean): string {
  // Vite has no durable built artifact. Its per-start Svelte version is not an
  // update, and this lane deliberately makes no code-edit update promise.
  return development ? 'development' : `sveltekit:${builtVersion.trim()}`
}

export function failAutomaticBackupStartup(buildId: string, reason: string): void {
  setAutomaticBackupStartup({ ready: false, buildId, dataGeneration: '', error: reason })
}

export type AutomaticBackupStartupGuard = { signal: AbortSignal; finish: () => void }

/** Register before restore recovery or any other awaited startup work can begin. */
export function beginAutomaticBackupStartup(buildId: string): AutomaticBackupStartupGuard {
  const shutdown = new AbortController()
  const finish = registerRuntimeShutdownTask('automatic-backup-startup', () => shutdown.abort())
  setAutomaticBackupStartup({ ready: false, buildId, dataGeneration: '' })
  return { signal: shutdown.signal, finish }
}

/** The Mac file-service owner allows up to 15 minutes for its pre-listen migration. */
export async function waitForAutomaticBackupFileService(signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 15 * 60_000
  for (;;) {
    signal.throwIfAborted()
    const remainingBeforeProbe = deadline - Date.now()
    if (remainingBeforeProbe <= 0) {
      throw new Error('The file service did not complete healthy startup within 15 minutes. Automatic backups are unavailable.')
    }
    try {
      const response = await fetch(`${getInternalBatshitServerUrl()}/health`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(5_000, remainingBeforeProbe))]), redirect: 'error'
      })
      const health = await response.json()
      if (response.ok && health?.ok === true && health?.service === 'batshit-server' &&
        health?.checks?.http === true && health?.checks?.redis === true) return
    } catch {
      // A service that is still migrating has no listener yet. Re-probe only
      // this health edge; never re-run app migrations or invent successful state.
      signal.throwIfAborted()
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error('The file service did not complete healthy startup within 15 minutes. Automatic backups are unavailable.')
    }
    await delay(Math.min(1_000, remaining), undefined, { signal, ref: false })
  }
}

export async function completeAutomaticBackupStartup(
  work: AutomaticBackupStartupWork,
  options: { buildId: string; schedulersDisabled: boolean; guard?: AutomaticBackupStartupGuard }
): Promise<void> {
  const { buildId } = options
  const guard = options.guard ?? beginAutomaticBackupStartup(buildId)
  try {
    if (!buildId || buildId === 'sveltekit:') {
      throw new Error('The running app build could not be identified.')
    }
    const named = Object.entries(work)
    // Observe the original promises before their normal nonfatal log handlers
    // swallow a rejection. Every task settles before readiness is published.
    const settled = await Promise.allSettled(named.map(([, promise]) => promise))
    const failed = settled.flatMap((result, index) => result.status === 'rejected' ? [named[index][0]] : [])
    if (failed.length > 0) {
      throw new Error(`Startup work did not complete: ${failed.join(', ')}. Check the app logs.`)
    }
    guard.signal.throwIfAborted()
    const skills = await work.skills
    if (skills.complete !== true || skills.failed !== 0) {
      throw new Error('Skill file migration did not complete. Check the app logs before automatic backups can run.')
    }
    const memory = await work.memoryMedia
    if (!['migrated', 'already-complete'].includes(memory.status) ||
      ![memory.records, memory.media, memory.unresolved].every((value) => Number.isSafeInteger(value) && value >= 0)) {
      throw new Error('Memory image migration did not return a valid completion receipt.')
    }
    const indexes = await work.memoryIndexes
    // created/recreated both await the new indexes' health checks. A fresh
    // builtin/default instance is valid; no configured remote embedder is needed.
    if (!['ready', 'created', 'recreated'].includes(indexes.status)) {
      throw new Error('Memory indexes have not completed startup. Check the app logs before automatic backups can run.')
    }
    const zipDefaults = await work.zipDefaults
    if (!['swept', 'already-complete'].includes(zipDefaults.status)) {
      throw new Error('Stored default migration did not complete. Check the app logs before automatic backups can run.')
    }
    // batshit-server starts listening only after its persistent upload migration
    // completed without interruption. Redis-only app health cannot prove this.
    await waitForAutomaticBackupFileService(guard.signal)
    guard.signal.throwIfAborted()
    const dataGeneration = `startup-v1:${createHash('sha256').update(JSON.stringify({
      contracts: DATA_GENERATION_CONTRACTS,
      memoryMedia: { records: memory.records, media: memory.media, unresolved: memory.unresolved }
    })).digest('hex')}`
    // SA-105 DL-105-16 deliberately completes with media:[] and a provenance note
    // for unavailable sources. Retain that truth without reclassifying terminal
    // history as unfinished work or authorizing another migration attempt.
    setAutomaticBackupStartup({ ready: true, buildId, dataGeneration,
      ...(memory.unresolved > 0 ? { warning: `${memory.unresolved} memory image sources could not be copied during migration. Backups keep the saved notes; new backups cannot recover those unavailable images.` } : {}) })
    if (!options.schedulersDisabled) startAutomaticBackupScheduler()
  } catch (error) {
    const reason = guard.signal.aborted
      ? 'Batshit stopped before automatic backup startup could be verified.'
      : error instanceof Error ? error.message : 'Automatic backup startup could not be verified.'
    failAutomaticBackupStartup(buildId, reason)
    console.error('[Startup] Automatic backups are unavailable:', reason)
  } finally {
    guard.finish()
  }
}
