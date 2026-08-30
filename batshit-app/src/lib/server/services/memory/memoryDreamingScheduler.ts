/**
 * SA-104 P7 — the scheduled/idle dreaming trigger (DL-104-15; p7 packet doc §1.3).
 *
 * One in-process interval, started from `hooks.server.ts`'s startup-integrity pass
 * (the `ensureMemoryIndexes` precedent). Native, Docker, and packaged Mac all run
 * this same SvelteKit node server, so one code path serves all three lanes. Recorded
 * limitation: the scheduler arms on the first HTTP request after boot — an instance
 * nobody opens never dreams, which is fine because dreaming maintains memory for an
 * instance being used.
 *
 * Eligibility is the pure `shouldRunScheduledDream` rule (at most one dream per idle
 * period per agent); the per-agent mutex inside `runDreamingPass` plus the sweep
 * guard here keep runs serial. Agents are enumerated without a request context via
 * the `user:*:agents` sets with raw record reads — a background lane performs no
 * canonicalization writes.
 */

import { redis } from '$lib/server/redis'
import {
  getLatestDreamRunStartedAt,
  isAgentDreaming,
  runDreamingPass,
  shouldRunScheduledDream
} from './memoryDreaming'

export const DREAMING_SCHEDULER_INTERVAL_MS = 15 * 60_000

const SCHEDULER_FLAG = Symbol.for('batshit.memoryDreamingScheduler')

let sweepInProgress = false

/** One eligibility sweep over every agent on the instance (exported for manual use). */
export async function runScheduledDreamSweep(now = new Date()): Promise<void> {
  if (sweepInProgress) return
  sweepInProgress = true
  try {
    const agentSetKeys = await redis.execute(async (client) => client.keys('user:*:agents'))
    for (const setKey of agentSetKeys) {
      const userId = setKey.slice('user:'.length, setKey.length - ':agents'.length)
      if (!userId) continue
      const agentIds = await redis.execute(async (client) => client.sMembers(setKey))
      for (const agentId of agentIds) {
        try {
          const agent = (await redis.json.get(`agent:${agentId}`)) as Record<string, any> | null
          if (!agent || isAgentDreaming(agentId)) continue
          const lastRunStartedAt = await getLatestDreamRunStartedAt(agentId)
          if (!shouldRunScheduledDream(agent, lastRunStartedAt, now)) continue
          const run = await runDreamingPass({ userId, agent, trigger: 'scheduled' })
          if (run.status === 'failed') {
            console.error(
              `[Dreaming] Scheduled pass for agent ${agentId} failed: ${run.error ?? 'unknown error'} (run ${run.id})`
            )
          }
        } catch (error) {
          // The run persists its own failure record; this catch covers pre-run errors.
          console.error(`[Dreaming] Scheduled sweep error for agent ${agentId}:`, error)
        }
      }
    }
  } finally {
    sweepInProgress = false
  }
}

/**
 * Idempotent interval start (globalThis-guarded so dev-server module reloads cannot
 * double-arm it). Never called from tests — the test lane exercises the pure
 * eligibility rule and the pass directly.
 */
export function startMemoryDreamingScheduler(): void {
  const globalState = globalThis as Record<PropertyKey, unknown>
  if (globalState[SCHEDULER_FLAG]) return
  const timer = setInterval(() => {
    void runScheduledDreamSweep().catch((error) => {
      console.error('[Dreaming] Scheduled sweep failed:', error)
    })
  }, DREAMING_SCHEDULER_INTERVAL_MS)
  // Never hold the process open for the background sweep.
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    ;(timer as NodeJS.Timeout).unref()
  }
  globalState[SCHEDULER_FLAG] = timer
}
