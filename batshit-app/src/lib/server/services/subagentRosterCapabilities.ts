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
import type { AgentSlashCapability } from '$lib/server/services/slashCommandCapabilities'
import type { SubagentResolvedScope } from '$lib/server/services/subagentRuntimeScope'

/** Skills listed inline before the roster switches to a count. */
const MAX_ROSTER_SKILLS = 6
/** MCP gateways listed inline before the roster switches to a count. */
const MAX_ROSTER_GATEWAYS = 4

export type SubagentThreadState = 'none' | 'resumable'

export interface SubagentRosterCapabilityInput {
  scope: SubagentResolvedScope
  capabilities: AgentSlashCapability[]
  /** Gateway id -> display name, from the user's gateway registry (id when unknown). */
  gatewayNames: Map<string, string>
  model?: string | null
  provider?: string | null
  threadState: SubagentThreadState
}

const SUBAGENT_TYPE_LABELS: Record<string, string> = {
  'n8n-workflow': 'n8n Workflow Subagent',
  api: 'API Subagent',
  cli: 'CLI Subagent'
}

export function subagentTypeLabel(type: SubagentType | string): string {
  return SUBAGENT_TYPE_LABELS[type] ?? 'Subagent'
}

function formatModel(input: SubagentRosterCapabilityInput): string {
  const model = input.model?.trim()
  const provider = input.provider?.trim()
  if (model && provider) return `${provider}/${model}`
  if (model) return model
  // Honest absence over an invented default: an n8n Workflow Subagent's model lives in the
  // workflow, and a CLI subagent may inherit the primary's CLI model at run time.
  return 'not set here'
}

/**
 * Tool families in the shape the primary can act on. n8n Workflow Subagents are a
 * deliberate special case: their tools are wired inside the n8n workflow, so Batshit has
 * nothing truthful to enumerate and says so rather than printing an empty list.
 */
function formatToolFamilies(input: SubagentRosterCapabilityInput): string {
  if (input.scope.subagentType === 'n8n-workflow') return 'defined in n8n'

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
 * The trailing `— type; model; tools: …; skills: …; thread: …` fragment for one roster
 * line. Deterministic for a given set of records so it never churns the DCM between sends.
 */
export function buildSubagentRosterCapabilityFragment(
  input: SubagentRosterCapabilityInput
): string {
  return [
    subagentTypeLabel(input.scope.subagentType),
    `model: ${formatModel(input)}`,
    `tools: ${formatToolFamilies(input)}`,
    `skills: ${formatSkills(input.capabilities)}`,
    `thread: ${input.threadState}`
  ].join('; ')
}
