/**
 * "Stop with Batshit", carried to the processes that actually do the stopping.
 *
 * The Mac runtime supervisor and the native launcher both stop detached local
 * voice runtimes, and neither of them can read Redis. What they CAN read is the
 * launch record every detached spawn already writes under
 * `~/.batshit/runtime/voice-engines/<engineId>/.batshit-local-runtime-launch.json`
 * (see `voiceRuntimeLaunchRecords.ts`). So the user's choice travels in that
 * record: written at spawn, and rewritten here the moment the toggle changes,
 * because a quit one second after a save must honor the new choice rather than
 * the one the engine was started with.
 *
 * Absent means STOP. The packaged Mac app has always stopped every recorded
 * local runtime on quit; a record written before this setting existed must keep
 * behaving exactly the way it does today.
 */

import {
  attachLocalRuntimeLaunchRecord,
  setLocalRuntimeStopChoice
} from '$lib/server/services/voiceRuntimeLaunchRecords'
import { logger } from '$lib/utils/logger'

/**
 * Rewrite one engine's saved stop preference in every record it has: its
 * current one, any launch moved aside for a newer one, and an attach record for
 * a runtime it shares with another engine. The switch covers every copy of the
 * engine Batshit is running.
 *
 * With `endpoint`, an engine that has no live record but uses a runtime another
 * engine's launch started gets an attach record carrying this choice, so the
 * shared runtime keeps running at quit when this engine says so.
 *
 * Returns whether anything was written. No record is NOT an error: an engine
 * that Batshit never launched and that shares nothing has nothing to stop, and
 * the preference will be written by its next spawn.
 */
export async function syncLocalRuntimeStopPreference(
  engineId: string,
  stopOnShutdown: boolean,
  options: { endpoint?: string | null } = {}
): Promise<boolean> {
  let changed = false
  let live = false
  try {
    // Under the engine folder's lock, so a toggle save racing a launch never writes the old
    // record back over the new one (review of 22aa935de).
    ;({ changed, live } = await setLocalRuntimeStopChoice(engineId, stopOnShutdown))
  } catch (error) {
    logger.warn('[voice-runtime] failed to update the saved stop preference', { engineId, error })
  }

  if (options.endpoint && !live) {
    try {
      changed =
        (await attachLocalRuntimeLaunchRecord({
          engineId,
          endpoint: options.endpoint,
          stopOnShutdown
        })) || changed
    } catch (error) {
      logger.warn('[voice-runtime] failed to record a shared runtime choice', { engineId, error })
    }
  }
  return changed
}
