/**
 * SA-111 P1 (DL-111-03) — the capability facts appended to each subagent's DCM roster line.
 *
 * Josh's ask #6: "the primary agent must know what each subagent can do — its skills,
 * tools, and so on — so it can pick the right specialist", without bloating the system
 * prompt. These facts are per-turn state derived from live records, so they belong in the
 * DCM where the roster already lives (FM: "SA availability is ONLY here"), not in the
 * stable-prefix system prompt.
 *
 * Everything here is derived from data the canonical compiler has already resolved for the
 * subagent's own DYNAMIC INFO block, so the roster costs no extra Redis round trips.
 *
 * Deliberate deviation from DL-111-03, recorded for P2/P4: the lock says "detail follows
 * the existing DCM display-detail setting (compact = families only; full = names)", but no
 * such setting exists. `AgentDcmDisplaySettings` holds per-group/per-tool VISIBILITY modes
 * ('group+tools+hints', 'name-only', 'hidden', …) that govern what the SUBAGENT sees in its
 * own capability index — not what the PRIMARY is told about the subagent. Reusing it here
 * would let a subagent's own display preference silently blank the roster the primary reads.
 * So the line always uses the compact shape the lock itself spells out: families, gateway
 * names, a CLI tool count, and skill invocations.
 */

import type { SubagentType } from '$lib/utils/subagentType'
import { formatDelegationDuration, normalizeSubagentTimeoutSeconds } from '$lib/utils/subagentTimeout'
import { normalizeSubagentMaxToolSteps } from '$lib/utils/subagentToolSteps'
import type { AgentSlashCapability } from '$lib/server/services/slashCommandCapabilities'
import type { SubagentResolvedScope } from '$lib/server/services/subagentRuntimeScope'

/** Skills listed inline before the roster switches to a count. */
const MAX_ROSTER_SKILLS = 6
/** MCP gateways listed inline before the roster switches to a count. */
const MAX_ROSTER_GATEWAYS = 4

export type SubagentThreadState = 'none' | 'resumable' | 'unavailable'

export interface SubagentRosterCapabilityInput {
  scope: SubagentResolvedScope
  capabilities: AgentSlashCapability[]
  /** Gateway id -> display name, from the user's gateway registry (id when unknown). */
  gatewayNames: Map<string, string>
  model?: string | null
  provider?: string | null
  threadState: SubagentThreadState
  /** The Subagent's own time limit in seconds, when it sets one (delegation limits). */
  timeoutSeconds?: unknown
  /** The Subagent's own tool-step limit, when it sets one. */
  maxToolSteps?: unknown
}

/** SA-139 R6 (D16): one Subagent kind, so the roster line names the role, never a type. */
export function subagentTypeLabel(_type: SubagentType | string): string {
  return 'Subagent'
}

function formatModel(input: SubagentRosterCapabilityInput): string {
  const model = input.model?.trim()
  const provider = input.provider?.trim()
  if (model && provider) return `${provider}/${model}`
  if (model) return model
  // Honest absence over an invented default: a subagent with no model of its own runs on the
  // primary's model at run time.
  return 'not set here'
}

/** Tool families in the shape the primary can act on. */
function formatToolFamilies(input: SubagentRosterCapabilityInput): string {
  const native = input.scope.nativeToolSettings
  const families: string[] = []

  if (native.bashEnabled) families.push('Bash')
  if (native.webSearchEnabled) families.push('Web Search')

  if (native.dynamicMcpEnabled) {
    const gateways = input.scope.resolvedGateways
    if (gateways.length === 0) {
      families.push('MCP (no gateways)')
    } else if (gateways.length <= MAX_ROSTER_GATEWAYS) {
      const names = gateways.map((id) => input.gatewayNames.get(id) ?? id)
      families.push(`MCP (${names.join(', ')})`)
    } else {
      families.push(`MCP (${gateways.length} gateways)`)
    }
  }

  if (native.cliToolsEnabled) {
    const count = input.scope.resolvedCliToolIds.length
    families.push(count === 1 ? 'CLI tools (1)' : `CLI tools (${count})`)
  }

  if (native.artifactRuntimeEnabled) families.push('Artifacts')
  if (native.agentBrowserEnabled) families.push('Agent Browser')

  return families.length > 0 ? families.join(', ') : 'none'
}

function formatSkills(capabilities: AgentSlashCapability[]): string {
  if (capabilities.length === 0) return 'none'
  const visible = capabilities.slice(0, MAX_ROSTER_SKILLS).map((entry) => entry.invocation)
  const hidden = capabilities.length - visible.length
  return hidden > 0 ? `${visible.join(', ')} (+${hidden} more)` : visible.join(', ')
}

/**
 * Delegation limits (Josh, 2026-10-24): a Subagent has no time or tool-step limit unless it
 * sets one, so its roster line names a limit only when one is set (`limits: 2 hours, 40 tool
 * steps`), and says nothing otherwise.
 */
function formatLimits(input: SubagentRosterCapabilityInput): string | null {
  const parts: string[] = []
  const seconds = normalizeSubagentTimeoutSeconds(input.timeoutSeconds)
  if (seconds !== undefined) parts.push(formatDelegationDuration(seconds))
  const steps = normalizeSubagentMaxToolSteps(input.maxToolSteps)
  if (steps !== undefined) parts.push(`${steps} tool step${steps === 1 ? '' : 's'}`)
  return parts.length > 0 ? parts.join(', ') : null
}

/**
 * The trailing `— Subagent; model; tools: …; skills: …; [limits: …;] thread: …` fragment for one
 * roster line. Deterministic for a given set of records so it never churns the DCM between
 * sends.
 */
export function buildSubagentRosterCapabilityFragment(
  input: SubagentRosterCapabilityInput,
  options: { includeThread?: boolean } = {}
): string {
  const limits = formatLimits(input)
  return [
    subagentTypeLabel(input.scope.subagentType),
    `model: ${formatModel(input)}`,
    `tools: ${formatToolFamilies(input)}`,
    `skills: ${formatSkills(input.capabilities)}`,
    ...(limits ? [`limits: ${limits}`] : []),
    ...(options.includeThread === false ? [] : [`thread: ${input.threadState}`])
  ].join('; ')
}
