import { executionViewerService } from '$lib/server/services/executionViewerService'
import { latestCliContextReport, type CliContextRuntime, type CliContextWindowReport } from '$lib/utils/cliContextWindow'

export const CLI_CONTEXT_READ_WARNING = 'Could not read the saved CLI context limit. The context limit is unknown for this send.'

/** Optional telemetry must not reject a send or disguise a failed read as no saved evidence. */
export async function readCliContextReport(
  sessionId: string, agentId: string, runtime: CliContextRuntime
): Promise<{ report: CliContextWindowReport | null; warning: string | null; checkedAt: number }> {
  try {
    const snapshots = await executionViewerService.getCliContextSnapshots(sessionId)
    return { report: latestCliContextReport(snapshots, agentId, runtime), warning: null, checkedAt: Date.now() }
  } catch (error) {
    console.warn('[CLI context] Could not read saved context evidence:', error)
    return { report: null, warning: CLI_CONTEXT_READ_WARNING, checkedAt: Date.now() }
  }
}
