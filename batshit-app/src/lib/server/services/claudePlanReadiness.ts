import os from 'node:os'
import { buildClaudeLoginCommands, resolveClaudeCliExecutableDetailed } from './claudeCliStatus'
import { resolveDockerComposeWorkingDirectory } from './cliExecutableResolution'
import { resolveClaudeRunAsIdentity, type ClaudeRunAsIdentity } from './claudeRuntimeUser'
import { bindClaudePlanExecutable, checkClaudePlanExecutable, CLAUDE_PLAN_QUALIFIED_VERSIONS, ClaudePlanExecutableError, readClaudePlanAuthStatus,
  type ClaudePlanAuthStatus, type ClaudePlanExecutable, type ClaudePlanExecutableErrorCode } from './claudePlanExecutable'
import { claudePlanConfigurationReadiness, claudePlanEnabled, type ClaudePlanReadiness } from './claudePlanAdmission'
import { claudeCodeChangeCount } from './claudeCodeChanges'

/**
 * SA-139 (D1, D2): the Claude plan's readiness, from P2's checks (`claudePlanExecutable.ts`): the one
 * qualified Claude Code executable, bound as the run binds it, and `claude auth status --json` with
 * that binary showing a Claude plan sign-in (the run checks the plan again in Claude Code's
 * `initialize` answer). Admission binds with the evidence hash, as the run does; display reads bind by
 * path, identity and version only (`checkClaudePlanExecutable`), so Settings never hashes the binary. Neither makes a model call, installs, signs in or reads a credential. Kept apart from `claudePlanAdmission.ts` because
 * these readers pull in the managed CLI modules; routes and run owners import this, widely imported
 * modules do not.
 */

export type ClaudePlanStatus = ClaudePlanReadiness & { installed: boolean }

type Guidance = Pick<Extract<ClaudePlanReadiness, { state: 'unavailable' }>, 'setupCommand' | 'statusCommand' | 'setupContext' | 'setupWorkingDirectory'>

/** What one look at Claude Code found: the bound executable and its sign-in, or why binding failed. */
export type ClaudePlanProbe =
  | { bound: Pick<ClaudePlanExecutable, 'version'>; auth: ClaudePlanAuthStatus }
  | { bound: null; bindError: { code: ClaudePlanExecutableErrorCode; message: string } }

const SIGN_IN_CODES = { signed_out: 'signed_out', unreadable: 'status_unreadable' } as const
const UNREADABLE = 'Batshit could not read how Claude Code is signed in. Sign in to Claude Code with your Claude plan (`claude auth login`), then refresh.'
/**
 * The binder's own messages name the executable's path; pickers, saved presets and a refused run show
 * these plain sentences instead, both pointing at the card that installs Claude Code, and the binder's
 * message goes to the server log (debug).
 */
const NOT_INSTALLED = 'Claude Code is not installed. Install it from the Claude Plan card in Settings → API Keys, then try again.'
const EXECUTABLE_UNUSABLE = `Batshit cannot use this Claude Code: it is not the exact version Batshit was tested with (${CLAUDE_PLAN_QUALIFIED_VERSIONS.join(', ')}), or it could not run. Install or update it from the Claude Plan card in Settings → API Keys, then try again.`

/**
 * Pure: a probe as the connection's status. Only the configuration gates come after Claude Code's
 * own facts, so the card and pickers can guide setup even while runs are not available.
 */
export function projectClaudePlanProbe(probe: ClaudePlanProbe, guidance: Guidance, options: { runtimeBuilt?: boolean } = {}): ClaudePlanStatus {
  if (!probe.bound) {
    if (probe.bindError.code === 'not_found') return { state: 'unavailable', code: 'not_installed', installed: false, reason: NOT_INSTALLED, ...guidance }
    return { state: 'unavailable', code: 'executable_unusable', installed: true, reason: EXECUTABLE_UNUSABLE }
  }
  const auth = probe.auth
  if (auth.state !== 'plan') {
    // Only a sign-in that shows a Claude plan passes; any other answer refuses, one this code does not know included.
    const refused = auth.state === 'refused' ? auth : null
    const code = refused ? SIGN_IN_CODES[refused.code as keyof typeof SIGN_IN_CODES] ?? 'not_plan' : 'status_unreadable'
    return { state: 'unavailable', code, installed: true, reason: refused?.reason ?? UNREADABLE, ...guidance }
  }
  const configured = claudePlanConfigurationReadiness({ runtimeBuilt: options.runtimeBuilt })
  if (configured.state !== 'ready') return { ...configured, installed: true }
  return { state: 'ready', installed: true, version: probe.bound.version }
}

/** The existing Docker-aware `claude auth login` guidance (`buildClaudeLoginCommands`), for the resolved executable. */
function loginGuidance(resolution: ReturnType<typeof resolveClaudeCliExecutableDetailed>, runAs: ClaudeRunAsIdentity): Guidance {
  const commands = buildClaudeLoginCommands({ executablePath: resolution.source === 'managed' ? resolution.executable : null,
    runAsUser: runAs.user, runAsUid: runAs.uid, runAsGid: runAs.gid, runAsHome: runAs.home })
  const setupWorkingDirectory = commands.context === 'docker' ? resolveDockerComposeWorkingDirectory() : undefined
  return { setupCommand: commands.loginCommand, statusCommand: commands.statusCommand, setupContext: commands.context,
    ...(setupWorkingDirectory ? { setupWorkingDirectory } : {}) }
}

/**
 * One look. `evidence` binds with the hash (admission); display looks do not. `keep` is false for an
 * answer a moment later may change (a binary replaced mid-check, an unexpected failure).
 */
async function lookAtClaudeCode(evidence: boolean): Promise<{ probe: ClaudePlanProbe; guidance: Guidance; keep: boolean }> {
  let guidance: Guidance = {}
  try {
    const runAs = resolveClaudeRunAsIdentity()
    const resolution = resolveClaudeCliExecutableDetailed(process.env, runAs.home ?? os.homedir())
    guidance = loginGuidance(resolution, runAs)
    const bound = await (evidence ? bindClaudePlanExecutable : checkClaudePlanExecutable)({ resolution, runAs })
    return { probe: { bound, auth: await readClaudePlanAuthStatus(bound, runAs) }, guidance, keep: true }
  } catch (error) {
    if (error instanceof ClaudePlanExecutableError) {
      console.debug(`[claude-plan] Claude Code check refused (${error.code}): ${error.message}`)
      return { probe: { bound: null, bindError: { code: error.code, message: error.message } }, guidance, keep: error.code !== 'changed' }
    }
    // Not one of the binder's named refusals (a file read failed, say): still a refusal, never a pass.
    console.warn('[claude-plan] Claude Code check failed:', error)
    return { probe: { bound: null, bindError: { code: 'not_executable', message: 'Batshit could not check Claude Code.' } }, guidance, keep: false }
  }
}

/**
 * Admission's reader: fresh on every call, so no cached answer can admit a run. The configuration
 * gates come first, so a refused run spawns nothing.
 */
export async function readClaudePlanReadiness(options: { runtimeBuilt?: boolean } = {}): Promise<ClaudePlanReadiness> {
  const configured = claudePlanConfigurationReadiness({ runtimeBuilt: options.runtimeBuilt })
  if (configured.state !== 'ready') return configured
  const { probe, guidance } = await lookAtClaudeCode(true)
  return projectClaudePlanProbe(probe, guidance, { runtimeBuilt: true })
}

async function lookAtStatus(runtimeBuilt?: boolean): Promise<{ status: ClaudePlanStatus; keep: boolean }> {
  if (!claudePlanEnabled()) return { status: { ...claudePlanConfigurationReadiness({ enabled: false }), installed: false }, keep: true }
  const { probe, guidance, keep } = await lookAtClaudeCode(false)
  return { status: projectClaudePlanProbe(probe, guidance, { runtimeBuilt }), keep }
}

/** The display view (card, pickers, saved presets): Claude Code's facts before the build gate. Read fresh. */
export async function readClaudePlanStatus(options: { runtimeBuilt?: boolean } = {}): Promise<ClaudePlanStatus> {
  return (await lookAtStatus(options.runtimeBuilt)).status
}

/**
 * Display reads share one short-lived look (Faye S2): opening Settings asks for the model list, the
 * saved presets and the card at once, and each would otherwise start its own `auth status`. Only
 * display reads use it; admission always reads fresh. Check Again asks for a fresh look, which the
 * pickers it then refreshes (LS-007) share; a managed install, reinstall or uninstall makes the next
 * read look again (`claudeCodeChanges.ts`). A look that failed or may change a moment later is not
 * kept. The window is measured on the monotonic clock, so a wall-clock step cannot stretch it.
 */
const DISPLAY_TTL_MS = 30_000
let display: { at: number; changes: number; status: Promise<ClaudePlanStatus> } | null = null

export function readClaudePlanDisplayStatus(options: { fresh?: boolean } = {}): Promise<ClaudePlanStatus> {
  const now = performance.now()
  const changes = claudeCodeChangeCount()
  if (!options.fresh && display && display.changes === changes && now - display.at < DISPLAY_TTL_MS) return display.status
  const look = lookAtStatus()
  const entry = { at: now, changes, status: look.then(result => result.status) }
  display = entry
  const forget = () => { if (display === entry) display = null }
  look.then(result => { if (!result.keep) forget() }, forget)
  return entry.status
}

/** Exported for tests only. */
export function clearClaudePlanDisplayStatusForTests(): void {
  display = null
}
