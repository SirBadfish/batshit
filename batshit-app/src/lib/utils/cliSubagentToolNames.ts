import { normalizeSubagentSlugValue, resolveSubagentSlug } from './subagentSlug'

type CliAgentToolNameRecord = {
  id?: string | null
  slug?: string | null
}

type CliSubagentToolNameRecord = {
  slug?: string | null
  id?: string | null
  displayName?: string | null
  display_name?: string | null
  name?: string | null
  description?: string | null
}

const MANAGED_GATEWAY_PREFIX = 'batshit_gateway_'
const SUBAGENT_TOOL_PREFIX = 'subagent_'

/**
 * SA-111 P1 (AMD-111-01) — the composed MCP tool name a CLI primary actually sees is
 * `mcp__<server>__<tool>`, and OpenAI/Codex caps a function name at 64 characters. Codex
 * silently rewrites anything longer to a truncated, hash-suffixed form (observed live on
 * codex-cli 0.139.0: `mcp__batshit_gateway_megasmoke_codex_primary_suba._9de0fbd317bb`),
 * which made the DCM roster print a name that does not exist. Rather than reverse-engineer
 * an unversioned CLI's rewrite rule, Batshit keeps its own names inside the budget, so the
 * roster reference and the CLI's tool list are the same string on every lane.
 *
 * Budget, split into two INDEPENDENT halves because one server serves every subagent of an
 * agent (the server name cannot depend on which subagent is being addressed):
 *
 *   'mcp__'(5) + 'batshit_gateway_'(16) + segment + '__'(2) + 'subagent_'(9) + key <= 64
 *   => segment + key <= 32  =>  16 each.
 *
 * Names already inside their half are left EXACTLY as they were, so short agent/subagent
 * ids (`cody-subagents`, `researcher`) keep their current, readable names and no existing
 * profile churns.
 */
export const MCP_FULL_TOOL_NAME_LIMIT = 64
export const CLI_SUBAGENT_SERVER_SEGMENT_MAX = 16
export const CLI_SUBAGENT_TOOL_KEY_MAX = 16

/** Characters reserved by `shortenNameSegment` for its `_<6 hex>` disambiguator. */
const HASH_SUFFIX_LENGTH = 7

/**
 * FNV-1a 32-bit, rendered as 6 lowercase hex characters. Deliberately dependency-free and
 * pure arithmetic so the CLI bridge (`scripts/codex-subagent-mcp.cjs`, CommonJS, no
 * `$lib` imports) can mirror it byte for byte. `cliSubagentToolNames.test.ts` pins both
 * implementations against the same fixtures.
 */
export function shortNameHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return (hash >>> 8).toString(16).padStart(6, '0')
}

/**
 * Deterministic, collision-resistant shortening: keep the readable head, then append a
 * hash of the FULL original so two names sharing a prefix never collapse onto one tool.
 */
export function shortenNameSegment(value: string, max: number): string {
  if (value.length <= max) return value
  const head = value.slice(0, Math.max(1, max - HASH_SUFFIX_LENGTH)).replace(/[-_]+$/, '')
  return `${head}_${shortNameHash(value)}`
}

function sanitizeManagedGatewaySegment(value: string | null | undefined) {
  const source = (value ?? '').trim().toLowerCase()
  return (
    source
      .replace(/[^a-z0-9_-]/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^_+|_+$/g, '') || 'gateway'
  )
}

/**
 * The MCP server name Batshit registers for one CLI primary's subagent bridge. Kept in
 * this module (rather than the profile managers' generic `buildManagedGatewayId`) so the
 * 64-character bound applies to THIS server only — every other managed gateway keeps its
 * existing name.
 */
export function buildCliSubagentMcpServerName(
  agent: CliAgentToolNameRecord | null | undefined
): string | null {
  const agentId = agent?.id?.trim()
  if (!agentId) return null
  const agentSlug = agent?.slug?.trim()
  const gatewaySource = agentSlug ? `${agentSlug}-subagents` : `${agentId}-subagents`
  const segment = shortenNameSegment(
    sanitizeManagedGatewaySegment(gatewaySource),
    CLI_SUBAGENT_SERVER_SEGMENT_MAX
  )
  return `${MANAGED_GATEWAY_PREFIX}${segment}`
}

/** The MCP tool name the bridge exposes for one subagent key. */
export function buildCliSubagentMcpToolNameForKey(toolKey: string): string {
  return `${SUBAGENT_TOOL_PREFIX}${shortenNameSegment(toolKey, CLI_SUBAGENT_TOOL_KEY_MAX)}`
}

/**
 * SA-111 P4 (DL-111-09): the Workers batch tool on the same bridge. Its name is fixed, so
 * unlike a subagent key it needs no shortening — `mcp__` + `batshit_gateway_` + a 16-char
 * segment + `__` + 13 is 52 characters at worst, inside the 64-character budget.
 */
export const CLI_WORKER_SPAWN_TOOL_NAME = 'spawn_workers'

export function buildCliWorkerSpawnToolReference(
  agent: CliAgentToolNameRecord | null | undefined
): CliSubagentMcpToolReference | null {
  const serverName = buildCliSubagentMcpServerName(agent)
  if (!serverName) return null
  return {
    serverName,
    toolName: CLI_WORKER_SPAWN_TOOL_NAME,
    fullToolName: `mcp__${serverName}__${CLI_WORKER_SPAWN_TOOL_NAME}`
  }
}

export type CliSubagentMcpToolReference = {
  serverName: string
  toolName: string
  fullToolName: string
}

export function buildCliSubagentMcpToolReference(
  agent: CliAgentToolNameRecord | null | undefined,
  subagent: CliSubagentToolNameRecord | null | undefined
): CliSubagentMcpToolReference | null {
  const serverName = buildCliSubagentMcpServerName(agent)
  if (!serverName || !subagent) return null

  const toolKey = subagent.id
    ? normalizeSubagentSlugValue(subagent.id)
    : resolveSubagentSlug(subagent)
  const toolId = buildCliSubagentMcpToolNameForKey(toolKey)

  return {
    serverName,
    toolName: toolId,
    fullToolName: `mcp__${serverName}__${toolId}`
  }
}

export function buildCliSubagentMcpToolName(
  agent: CliAgentToolNameRecord | null | undefined,
  subagent: CliSubagentToolNameRecord | null | undefined
) {
  return buildCliSubagentMcpToolReference(agent, subagent)?.fullToolName ?? null
}
