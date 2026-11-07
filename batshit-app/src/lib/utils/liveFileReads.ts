/**
 * SA-137 (D13, Josh 2026-11-04): the factory value of Refreshed File Reads. ON since the SA-126
 * November round: with the BL-2730 fix it never keeps more open than the setting off, tied on Opus
 * and so is ON by Josh's rule. Every Settings surface names it ("Default (On)") from this constant.
 */
export const DEFAULT_LIVE_FILE_READS_ENABLED = true

/**
 * SA-137 (D11): whether an agent's Refreshed File Reads setting is on (the internal key stays
 * `live_file_reads`, Round 2: no data changes): its own setting, else the user's global
 * Tool Grid value, else the factory value (`DEFAULT_LIVE_FILE_READS_ENABLED`, ON). `null` on the
 * agent removes its override; an explicit `false` stays false. Every reader asks this one rule.
 */
export function resolveLiveFileReadsEnabled(
  agent: { readonly live_file_reads?: unknown } | null | undefined,
  globalZipSettings: { readonly live_file_reads?: unknown } | null | undefined
): boolean {
  if (typeof agent?.live_file_reads === 'boolean') return agent.live_file_reads
  if (typeof globalZipSettings?.live_file_reads === 'boolean') return globalZipSettings.live_file_reads
  return DEFAULT_LIVE_FILE_READS_ENABLED
}

/**
 * Whether someone chose Refreshed File Reads ON: the agent's own `true`, else the user's global
 * `true` (an agent's explicit `false` wins). The factory value is nobody's choice, so it is not one.
 * The Settings warning ("on, but it cannot run here") asks this, never the resolver: a Docker or
 * inline-view agent following the factory value gets the plain reason, not a warning (D13).
 */
export function liveFileReadsChosenOn(
  agent: { readonly live_file_reads?: unknown } | null | undefined,
  globalZipSettings: { readonly live_file_reads?: unknown } | null | undefined
): boolean {
  if (typeof agent?.live_file_reads === 'boolean') return agent.live_file_reads
  return globalZipSettings?.live_file_reads === true
}

/** The setting's name on every Settings surface (SA-137 P4a, D11; renamed in Round 2, Josh 2026-10-22). */
export const LIVE_FILE_READS_LABEL = 'Refreshed File Reads'

/** The one (i) text both Settings surfaces show for the setting (the agent's Tool Grid card and the Global Tool Grid). */
export const LIVE_FILE_READS_HELP =
  "At the start of each turn, the agent's open Read File results show the files as they are now, marked REFRESHED. A result Batshit cannot refresh stays zipped for that turn, even if it is held, so the agent never sees an old copy as current. In a group, sharing a file read also shares its refreshed contents. The chat's cards keep the original reads. It works for Primary Agents with the appended Zip view."

/** Host facts the availability rule needs (the server's own, or the sandbox-status response's). */
export interface RefreshedFileReadsHost {
  platform: string
  containerized: boolean
}

/**
 * The agent's Zip view: its own `zip_ai_view_mode`, else the user's global one, else appended (the
 * canonical compiler's rule, `DatabaseService.resolveZipAiViewMode`).
 */
export function resolveZipAiViewModeOf(
  agent: { readonly zip_ai_view_mode?: unknown } | null | undefined,
  globalZipSettings: { readonly zip_ai_view_mode?: unknown } | null | undefined
): 'inline' | 'appended' {
  const own = agent?.zip_ai_view_mode
  if (own === 'appended' || own === 'inline') return own
  return globalZipSettings?.zip_ai_view_mode === 'inline' ? 'inline' : 'appended'
}

/**
 * Round 2 (R2-2): why Refreshed File Reads cannot run for this agent now, or null when it can. One
 * rule for the route (no turn, no read, no early zip when unavailable), the compiler's guidance, the
 * zip badges' facts and both Settings surfaces (the switch shows as unavailable with this sentence;
 * the saved value is never changed). A backend qualifies when its reads see the host's workspace at
 * the same path (`liveReadBackendMountsHostWorkspace`, server).
 */
export function refreshedFileReadsUnavailableReason(input: {
  primaryType: string | null | undefined
  zipViewMode: 'inline' | 'appended'
  backend: unknown
  host: RefreshedFileReadsHost | null
}): string | null {
  // SA-139 R4: every live Primary is `api`; a leftover of a removed type never runs it.
  if (input.primaryType !== 'api') return "This agent's type was removed from Batshit, so Refreshed File Reads cannot run for it."
  if (!input.host) return 'Checking whether Refreshed File Reads can run here.'
  if (input.host.containerized) return 'Refreshed File Reads is not available in the app container yet.'
  const { platform } = input.host
  if (platform !== 'darwin' && platform !== 'linux') return 'Refreshed File Reads needs a Mac or Linux host.'
  const backendOk = input.backend === 'local' ||
    ((input.backend === 'apple_container' || input.backend === 'docker_sandbox') && platform === 'darwin')
  if (!backendOk) return 'Refreshed File Reads is not available with this Sandbox Level yet.'
  if (input.zipViewMode !== 'appended') return 'Refreshed File Reads needs the appended Zip view; this agent uses the inline view, where nothing refreshes.'
  return null
}

/**
 * Round 2: why a Read File copy was not refreshed this turn, in the words its Zip Index
 * line uses (model-facing; never a raw error or a full path the reason did not already name).
 */
export function describeNotRefreshedReason(reason: string): string {
  switch (reason) {
    case 'not-readable': return 'the file is missing or cannot be read'
    case 'not-regular-or-too-large': return 'it is no longer a regular file within the size limit'
    case 'not-bounded-text': return 'it is no longer text within the size limit'
    case 'changed-during-read': return 'it changed while Batshit read it'
    case 'deadline': return 'reading it took too long'
    case 'reader-busy': return 'the file reader was busy'
    case 'reader-unavailable': return 'the file reader was not available'
    case 'root-unavailable': return 'the project folder is not available'
    case 'root-changed': return 'it was read in another project folder, or that folder changed'
    case 'protected-root': return 'its project folder is closed to sandboxes'
    case 'reader-gone': return 'the agent that read it is gone, cannot read files now, or does not share it with you'
    case 'sharing-changed': return 'its sharing or the agent that read it changed during this turn'
    case 'other-actor': return 'it was read in another chat'
    case 'read-error': return 'reading it failed'
    case 'unsupported-platform':
    case 'backend-not-local':
    case 'source-backend-not-local': return 'it was read where Batshit cannot refresh it'
    case 'not-in-replay': return "it was not in this approval's file snapshot"
    case 'too-many-copies': return 'too many open file reads this turn'
    case 'refresh-memory': return 'too much file text this turn'
    case 'replay-capacity': return 'too much file text to keep for an approval'
    case 'emulation-failed': return 'its range no longer matches the file'
    case 'read-while-off': return 'it was read while Refreshed File Reads was off'
    case 'replay-missing': return "this approval's file snapshot was not kept"
    case 'replay-expired': return "this approval's file snapshot expired"
    case 'replay-unverifiable': return "this approval's file snapshot is from before Batshit restarted"
    case 'stopped': return 'the reply was stopped'
    case 'not-refreshable':
    default: return 'Batshit cannot refresh this kind of read'
  }
}

/** One Read File copy Refreshed File Reads zipped this turn (`compileChatHistory`). */
export interface LiveReadThisTurn {
  /** Its state id. */
  zipId: string
  /** The file as its reference names it. */
  file: string
  liveRead: { kind: 'grew'; tokens: number } | { kind: 'not-refreshed'; reason: string }
  /** Another member's name when the read is theirs. */
  readerName?: string | null
}

/** At most this many per-copy lines; the rest are counted in one line. */
export const LIVE_READ_STATE_MAX_LINES = 20

/** The part of a Zip Index line after the file: what happened and what to do. */
export function describeLiveReadThisTurn(liveRead: LiveReadThisTurn['liveRead']): string {
  if (liveRead.kind === 'grew') {
    const tokens = Math.max(0, Math.round(liveRead.tokens)).toLocaleString('en-US')
    // BL-2042: Fetch Zip returns the stored original, never this refreshed body.
    return `zipped this turn; it grew to about ${tokens} tokens. Read the current lines you need.`
  }
  return `zipped this turn; not refreshed (${describeNotRefreshedReason(liveRead.reason)}).`
}

/**
 * Round 2: the Zipped this turn lines for the Read File copies Refreshed File Reads zipped this
 * turn, that turn only (the BL-1541 pattern). A held copy is said on its hold line instead.
 */
export function buildLiveReadStateLines(copies: readonly LiveReadThisTurn[], skip: ReadonlySet<string> = new Set()): string[] {
  const listed = copies.filter((copy) => !skip.has(copy.zipId))
  // Review S5: two copies with the same file and reader name the Zip id, as hold lines do.
  const labelOf = (copy: LiveReadThisTurn) => `${copy.file}${copy.readerName ? ` (read by ${copy.readerName})` : ''}`
  const seen = new Map<string, number>()
  for (const copy of listed) seen.set(labelOf(copy), (seen.get(labelOf(copy)) ?? 0) + 1)
  const lines = listed.slice(0, LIVE_READ_STATE_MAX_LINES).map((copy) =>
    `- ${labelOf(copy)}${(seen.get(labelOf(copy)) ?? 0) > 1 ? ` | ${copy.zipId}` : ''}: ${describeLiveReadThisTurn(copy.liveRead)}`)
  const more = listed.length - LIVE_READ_STATE_MAX_LINES
  if (more > 0) lines.push(`- ${more} more Read File ${more === 1 ? 'copy' : 'copies'} zipped this turn by Refreshed File Reads.`)
  return lines
}

/**
 * Write-side check for `POST /api/user/settings`: `global_zip_settings` is saved whole, so this is
 * the only gate a mistyped value meets (the resolver above reads anything but true or false as
 * "not set"). A present `live_file_reads` must be true, false or null.
 */
export function validateLiveFileReadsGlobalField(globalZipSettings: unknown): string | null {
  if (!globalZipSettings || typeof globalZipSettings !== 'object' || Array.isArray(globalZipSettings)) return null
  if (!Object.prototype.hasOwnProperty.call(globalZipSettings, 'live_file_reads')) return null
  const value = (globalZipSettings as Record<string, unknown>).live_file_reads
  return value === null || typeof value === 'boolean' ? null : `"${LIVE_FILE_READS_LABEL}" must be true or false.`
}

/**
 * Write-side check for `PUT /api/agents/[id]`: the agent's own `live_file_reads` must be true, false
 * or null (null removes the override). A mistyped value would otherwise read as "inherit".
 */
export function validateLiveFileReadsAgentField(updates: unknown): string | null {
  return validateLiveFileReadsGlobalField(updates)
}
