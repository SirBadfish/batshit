import { findRetiredCodexModel } from '$lib/data/codex-models'
import { findRetiredClaudeCliModel } from '$lib/data/claude-cli-models'
import { redis } from '$lib/server/redis'
import { MANAGED_CLI_PINNED_VERSIONS } from '$lib/server/services/managedCliInstaller'
import { isCliVersionOlder } from '$lib/server/services/cliVersion'

/**
 * BL-158 (Josh's option A, 2026-09-26) and BL-268 — what a managed CLI run does with a saved
 * model Batshit's list no longer offers, and with a CLI older than the one Batshit installs.
 *
 * A model leaves `codex-models.ts` or `claude-cli-models.ts` while an agent or Subagent still
 * names it; the saved value stays, and every run then failed with the CLI's own raw 400. The
 * run now stops before the CLI starts, with a message that names whose setting it is and where
 * to change it. Only a model Batshit once listed counts (`CODEX_RETIRED_MODELS`,
 * `CLAUDE_CLI_RETIRED_MODELS`): an id Batshit never listed is never refused, because someone
 * may have typed it on purpose. The wider quiet mark on every dropdown is BL-328.
 */

export const CLI_MODEL_RETIRED = 'CLI_MODEL_RETIRED'

export type CliRuntimeName = 'codex' | 'claude'

export class RetiredCliModelError extends Error {
  readonly code = CLI_MODEL_RETIRED
  /** send-routed answers a thrown error's own status; 422, like a prompt that cannot be sent. */
  readonly status = 422

  constructor(
    message: string,
    readonly model: string
  ) {
    super(message)
    this.name = 'RetiredCliModelError'
  }
}

/** Whose model setting a run used: a primary agent, a Subagent (a Worker built on one), or a Worker. */
export type CliModelOwner =
  | { kind: 'agent'; name: string }
  | { kind: 'subagent'; name: string }
  | { kind: 'worker' }

export interface CliModelOwnerRequest {
  agentId?: string | null
  delegatedRun?: boolean
  scopeAgentId?: string | null
}

const RUNTIME_WORDS: Record<CliRuntimeName, { cli: string; card: string; setting: string }> = {
  codex: { cli: 'Codex', card: 'Codex CLI Defaults', setting: 'Default Codex Model' },
  claude: { cli: 'Claude', card: 'Claude Code CLI Defaults', setting: 'Default Claude Model' }
}

export function findRetiredCliModel(runtime: CliRuntimeName, model: string | null | undefined) {
  return runtime === 'codex' ? findRetiredCodexModel(model) : findRetiredClaudeCliModel(model)
}

/** The message a run with a retired model stops with. */
export function buildRetiredCliModelMessage(
  runtime: CliRuntimeName,
  retired: { value: string; label: string; leftOn: string },
  owner: CliModelOwner
): string {
  const words = RUNTIME_WORDS[runtime]
  const model = retired.label === retired.value ? retired.value : `${retired.label} (${retired.value})`
  const who =
    owner.kind === 'agent'
      ? owner.name
      : owner.kind === 'subagent'
        ? `The Subagent ${owner.name}`
        : "This Worker's agent"
  const where =
    owner.kind === 'worker'
      ? `Settings → Agents → the agent → ${words.card} → ${words.setting}`
      : `Settings → Agents → ${owner.name} → ${words.card} → ${words.setting}`
  return (
    `${who} is set to the ${words.cli} model ${model}, which Batshit's ${words.cli} list no ` +
    `longer offers (it left the list on ${retired.leftOn}), so Batshit did not start the run. ` +
    `Pick another model in ${where}.`
  )
}

async function readRecordName(key: string): Promise<string | null> {
  try {
    const record = (await redis.execute(async (client) => client.json.get(key))) as Record<
      string,
      unknown
    > | null
    for (const field of ['displayName', 'display_name', 'name']) {
      const value = record?.[field]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  } catch (error) {
    console.warn('[CliModelAvailability] Could not read the name for the model message', { key, error })
  }
  return null
}

/**
 * Whose setting the run's model came from. A delegated run (`subagentRunner.ts`) carries the
 * Subagent's record id as `scopeAgentId`, or a built-in Worker's `worker_…` id, whose model is
 * its agent's; a primary run's `agentId` is the agent itself.
 */
export async function resolveCliModelOwner(request: CliModelOwnerRequest): Promise<CliModelOwner> {
  if (request.delegatedRun === true) {
    const scopeId = typeof request.scopeAgentId === 'string' ? request.scopeAgentId.trim() : ''
    if (!scopeId || scopeId.startsWith('worker_')) return { kind: 'worker' }
    return { kind: 'subagent', name: (await readRecordName(`subagent:${scopeId}`)) ?? scopeId }
  }
  const agentId = typeof request.agentId === 'string' ? request.agentId.trim() : ''
  return { kind: 'agent', name: (agentId && (await readRecordName(`agent:${agentId}`))) || agentId || 'This agent' }
}

/**
 * Throws `RetiredCliModelError` when the run's model is one Batshit's list no longer offers.
 * Called by each bridge before anything of the run is set up, so nothing needs undoing.
 */
export async function assertCliModelStillOffered(
  runtime: CliRuntimeName,
  model: string | null | undefined,
  request: CliModelOwnerRequest
): Promise<void> {
  const retired = findRetiredCliModel(runtime, model)
  if (!retired) return
  const owner = await resolveCliModelOwner(request)
  throw new RetiredCliModelError(buildRetiredCliModelMessage(runtime, retired, owner), retired.value)
}

/* ---------------------------------------------------------------------------------------- *
 * BL-268: a Codex older than the one Batshit installs.
 * ---------------------------------------------------------------------------------------- */

const CODEX_NEWER_VERSION_REFUSAL = /requires a newer version of Codex/i

/**
 * Codex answers a model its version cannot run with a raw 400 ("The 'gpt-6-astra' model
 * requires a newer version of Codex"; measured on codex-cli 0.139.0, 2026-09-25). This adds
 * which Codex Batshit ran and how to get the one it installs. Any other error is returned as is.
 */
export function explainCodexVersionRefusal(
  error: unknown,
  cli: { version?: string | null; source?: string | null } | null | undefined
): unknown {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (!CODEX_NEWER_VERSION_REFUSAL.test(message)) return error
  const pinned = MANAGED_CLI_PINNED_VERSIONS.codex
  const found = cli?.version?.trim() || 'an unknown version'
  const where = cli?.source === 'managed' ? "Batshit's own copy" : 'the Codex found on this computer'
  const advice =
    cli?.source === 'managed'
      ? `Reinstall Batshit's Codex (${pinned}) from Settings → Agents → the agent → Basic Settings.`
      : `Install Batshit's own Codex (${pinned}) from Settings → Agents → the agent → Basic Settings, or pick another model.`
  const explained = new Error(
    `${message}\n\nBatshit ran ${where}, ${found}, which is too old for this model. ${advice}`,
    { cause: error }
  )
  return explained
}

const olderCliWarnings = new Set<string>()

/**
 * BL-268: one warning per version per process when the CLI a run uses is older than the version
 * Batshit installs (`MANAGED_CLI_PINNED_VERSIONS`): newer models on the list may be refused.
 */
export function warnIfCliOlderThanPinned(
  runtime: CliRuntimeName,
  cli: { version?: string | null; source?: string | null; executable?: string | null }
): void {
  const pinned = MANAGED_CLI_PINNED_VERSIONS[runtime]
  if (!cli.version || !isCliVersionOlder(cli.version, pinned)) return
  const key = `${runtime}:${cli.executable ?? ''}:${cli.version}`
  if (olderCliWarnings.has(key)) return
  olderCliWarnings.add(key)
  console.warn(
    `[CliModelAvailability] ${RUNTIME_WORDS[runtime].cli} ${cli.version} (${cli.source ?? 'unknown source'}) is older than ${pinned}, the version Batshit installs; newer models on the list may be refused. Install Batshit's copy in Agent Settings.`,
    { executable: cli.executable ?? null }
  )
}
