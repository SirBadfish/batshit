import { refreshedFileReadsUnavailableReason, type RefreshedFileReadsHost } from './liveFileReads'
import type { TypedFileToolsHost } from './typedFileToolsGrant'

/**
 * SA-137 Round 2 (R2-2): what the two Settings surfaces say about whether Refreshed File Reads can
 * run. The agent's switch asks the full rule (`refreshedFileReadsUnavailableReason`); the global
 * switch is not one agent's, so only the host (a containerized host, a platform that is not Mac or
 * Linux) can make it unavailable. A host that could not be read never locks either switch: the
 * server re-checks every turn, so the surface says it could not check and stays usable. The saved
 * value is never changed by any of this.
 */

/** The short line under the global switch while nothing else needs saying. */
export const REFRESHED_FILE_READS_GLOBAL_HINT = 'Applies to Primary Agents with the appended Zip view.'

/** Said (as a plain note) when the host could not be read. */
export const REFRESHED_FILE_READS_HOST_CHECK_FAILED = 'Could not check whether Refreshed File Reads can run here.'

/** Said (as a plain note, the switch stays usable) when the global Zip view is inline. */
export const REFRESHED_FILE_READS_GLOBAL_INLINE_NOTE = 'The global Zip view is inline; agents that use it refresh nothing.'

/**
 * The host facts alone (`/api/native-tools/sandbox/status?hostOnly=1`), for the Tools card's
 * Refreshed File Reads and Typed File Tools rules: this read starts no sandbox probe, so neither
 * waits on one (BL-2049: the full probe's `sbx` timeouts run up to 60 s). Throws when the answer is
 * not ok or carries no host facts; the caller shows that as a plain note.
 */
export async function fetchToolsHostFacts(fetchImpl: typeof fetch = fetch): Promise<TypedFileToolsHost> {
  const response = await fetchImpl('/api/native-tools/sandbox/status?hostOnly=1')
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const payload = (await response.json()) as { typedFileToolsHost?: Partial<TypedFileToolsHost> | null }
  const host = payload?.typedFileToolsHost
  if (!host || typeof host.platform !== 'string' || typeof host.containerized !== 'boolean') {
    throw new Error('The response carried no host facts')
  }
  return {
    platform: host.platform,
    containerized: host.containerized,
    linuxKernel: typeof host.linuxKernel === 'string' ? host.linuxKernel : null,
    ...(typeof host.dockerSandboxOperatorConfigured === 'boolean'
      ? { dockerSandboxOperatorConfigured: host.dockerSandboxOperatorConfigured }
      : {})
  }
}

/** A host that cannot rule anything out: used only when the real host could not be read. */
const UNKNOWN_HOST_PLACEHOLDER: RefreshedFileReadsHost = { platform: 'darwin', containerized: false }

export interface GlobalRefreshedFileReadsAvailability {
  /** Why the global switch is unavailable (host reasons only), or null. */
  unavailableReason: string | null
  /** Plain notes under the switch, in order; none means the short hint shows. */
  notes: string[]
}

export function globalRefreshedFileReadsAvailability(input: {
  zipViewMode: 'inline' | 'appended'
  host: RefreshedFileReadsHost | null
  hostCheckFailed?: boolean
}): GlobalRefreshedFileReadsAvailability {
  // An API agent on the Local machine backend with the appended view: only the host can say no.
  const unavailableReason = input.host
    ? refreshedFileReadsUnavailableReason({ primaryType: 'api', zipViewMode: 'appended', backend: 'local', host: input.host })
    : null
  const notes: string[] = []
  if (!input.host && input.hostCheckFailed) notes.push(REFRESHED_FILE_READS_HOST_CHECK_FAILED)
  // Agents set to Appended still inherit this switch, so an inline global view never locks it.
  if (input.zipViewMode === 'inline') notes.push(REFRESHED_FILE_READS_GLOBAL_INLINE_NOTE)
  return { unavailableReason, notes }
}

export interface AgentRefreshedFileReadsAvailability {
  /** Why the agent's switch is unavailable (it is disabled), or null. */
  unavailableReason: string | null
  /** A plain note that does not lock the switch (the host could not be read), or null. */
  note: string | null
  /** Draw the reason in the warning tone: someone chose the setting ON, it is unavailable, and the check is done. */
  warn: boolean
}

export function agentRefreshedFileReadsAvailability(input: {
  primaryType: string | null | undefined
  zipViewMode: 'inline' | 'appended'
  backend: unknown
  host: RefreshedFileReadsHost | null
  hostCheckFailed: boolean
  /**
   * Whether someone chose the setting ON for this agent (its own `true`, else the global `true`:
   * `liveFileReadsChosenOn`). The factory value is not a choice, so it never draws the warning (D13).
   */
  chosenOn: boolean
}): AgentRefreshedFileReadsAvailability {
  if (!input.host && input.hostCheckFailed) {
    // Only what does not need the host can still be said for certain (agent type, Zip view).
    const unavailableReason = refreshedFileReadsUnavailableReason({
      primaryType: input.primaryType,
      zipViewMode: input.zipViewMode,
      backend: 'local',
      host: UNKNOWN_HOST_PLACEHOLDER
    })
    return { unavailableReason, note: REFRESHED_FILE_READS_HOST_CHECK_FAILED, warn: input.chosenOn && unavailableReason !== null }
  }
  const unavailableReason = refreshedFileReadsUnavailableReason({
    primaryType: input.primaryType,
    zipViewMode: input.zipViewMode,
    backend: input.backend,
    host: input.host
  })
  // Still reading the host: the sentence is the plain "checking" one, never a warning.
  const checking = !input.host
  return { unavailableReason, note: null, warn: input.chosenOn && unavailableReason !== null && !checking }
}

/**
 * The inputs of the availability rule that live in an agent's own record: its type and the Bash
 * command location and permissions mode (`resolveNativeBashDcmState` reads these keys, nested in
 * `nativeTools` and at the top of the provider settings). A save that changes any of them changes
 * whether Refreshed File Reads can run, so the badges' facts are asked again.
 */
const BASH_PLACEMENT_KEYS = [
  'executionBackend', 'nativeExecutionBackend', 'bashExecutionBackend', 'nativeBashExecutionBackend',
  'bashAccessMode', 'nativeBashAccessMode', 'bashPolicyMode', 'nativeBashPolicyMode'
] as const

function pickPlacement(source: unknown): Record<string, unknown> {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {}
  const record = source as Record<string, unknown>
  const picked: Record<string, unknown> = {}
  for (const key of BASH_PLACEMENT_KEYS) if (record[key] !== undefined && record[key] !== null && record[key] !== '') picked[key] = record[key]
  return picked
}

export function refreshedFileReadsRecordInputs(agent: {
  agentType?: unknown
  provider_specific_settings?: unknown
} | null | undefined): string {
  const settings = agent?.provider_specific_settings
  const record = settings && typeof settings === 'object' && !Array.isArray(settings) ? (settings as Record<string, unknown>) : {}
  const nested = record.nativeTools && typeof record.nativeTools === 'object' ? record.nativeTools : record.batshitNativeTools
  return JSON.stringify([agent?.agentType ?? null, pickPlacement(nested), pickPlacement(record)])
}

/** Whether a save from `before` to `after` changed an input of the availability rule. */
export function refreshedFileReadsRecordInputsChanged(
  before: Parameters<typeof refreshedFileReadsRecordInputs>[0],
  after: Parameters<typeof refreshedFileReadsRecordInputs>[0]
): boolean {
  return refreshedFileReadsRecordInputs(before) !== refreshedFileReadsRecordInputs(after)
}
