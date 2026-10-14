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
 * Names already inside their half are not shortened, so short agent/subagent ids keep
 * readable names (`cody_subagents`, `researcher`). Since BL-154 a server name never
 * carries a hyphen (`toCliShownMcpNameSegment`), because Codex shows one as `_`.
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
 * BL-154 — the name both CLIs show. Codex shows the model every character of an MCP
 * server name outside [A-Za-z0-9_] as `_` (the server `batshit_gateway_cody-subagents`
 * reached the model as `mcp__batshit_gateway_cody_subagents`, measured in Codex's own
 * request log), while Claude Code keeps a hyphen. A name made only of [A-Za-z0-9_], with no
 * doubled or edge `_` (so `mcp__<server>__<tool>` still splits in one place), is the same
 * string on both CLIs, so it is the one the profiles register, the DCM roster prints, and
 * Claude's allow lists name.
 */
export function toCliShownMcpNameSegment(value: string): string {
  return value
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * The MCP server name Batshit registers for one CLI primary's subagent bridge. Kept in
 * this module (rather than the profile managers' generic `buildManagedGatewayId`) so the
 * 64-character bound applies to THIS server only — every other managed gateway keeps its
 * existing name.
 *
 * The segment is shortened BEFORE it is made CLI-safe, so the hash of a long name is the
 * one it always had: only a name that carried a hyphen (a name Codex was already showing
 * differently from the roster) changes.
 */
export function buildCliSubagentMcpServerName(
  agent: CliAgentToolNameRecord | null | undefined
): string | null {
  const agentId = agent?.id?.trim()
  if (!agentId) return null
  const agentSlug = agent?.slug?.trim()
  const gatewaySource = agentSlug ? `${agentSlug}-subagents` : `${agentId}-subagents`
  const segment =
    toCliShownMcpNameSegment(
      shortenNameSegment(
        sanitizeManagedGatewaySegment(gatewaySource),
        CLI_SUBAGENT_SERVER_SEGMENT_MAX
      )
    ) || 'gateway'
  return `${MANAGED_GATEWAY_PREFIX}${segment}`
}

/**
 * BL-271 — whether `name` has a shape `buildCliSubagentMcpServerName` can produce for SOME
 * agent. User gateways share the `batshit_gateway_` prefix (`buildManagedGatewayId`), so a
 * gateway slug of this shape could become an agent's Subagent bridge name, now or when that
 * agent is made later; the gateway service skips these slugs.
 *
 * The two shapes, both at most 16 characters after the prefix: a short agent name keeps
 * `<name>_subagents` (or `subagents` alone when the name has no letter or digit); a longer one
 * is `<head>_<6 hex>` (`shortenNameSegment`). Pinned against the builder by
 * `mcpGatewaySubagentBridgeName.test.ts`.
 */
export function isCliSubagentBridgeServerName(name: string | null | undefined): boolean {
  if (typeof name !== 'string' || !name.startsWith(MANAGED_GATEWAY_PREFIX)) return false
  return isCliSubagentBridgeServerSegment(name.slice(MANAGED_GATEWAY_PREFIX.length))
}

/** The same test on the part after `batshit_gateway_` (a gateway slug is exactly that part). */
export function isCliSubagentBridgeServerSegment(segment: string | null | undefined): boolean {
  if (typeof segment !== 'string') return false
  if (segment.length === 0 || segment.length > CLI_SUBAGENT_SERVER_SEGMENT_MAX) return false
  return /^(?:[a-z0-9_]+_)?subagents$/.test(segment) || /^[a-z0-9_]+_[0-9a-f]{6}$/.test(segment)
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

/**
 * The key one assigned subagent's tool is named after: its normalized id, the value the
 * profile managers enable (`agent.assignedSubagents` holds ids) and the bridge advertises.
 * A record without an id falls back to its slug.
 */
export function resolveCliSubagentToolKey(subagent: CliSubagentToolNameRecord): string {
  return subagent.id ? normalizeSubagentSlugValue(subagent.id) : resolveSubagentSlug(subagent)
}

export function buildCliSubagentMcpToolReference(
  agent: CliAgentToolNameRecord | null | undefined,
  subagent: CliSubagentToolNameRecord | null | undefined
): CliSubagentMcpToolReference | null {
  const serverName = buildCliSubagentMcpServerName(agent)
  if (!serverName || !subagent) return null

  const toolKey = resolveCliSubagentToolKey(subagent)
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

export type CliSubagentToolCall = {
  serverName: string
  /** The subagent key the tool is named after, lowercased (`researcher`, or a shortened key). */
  toolKey: string
}

const CLI_SUBAGENT_TOOL_KEY = /^[a-z0-9_-]+$/

/**
 * BL-272: the Subagent a CLI tool call names, read by the exact shape Batshit registers: the
 * server is a managed gateway (`batshit_gateway_…`) and the tool is `subagent_<key>`, in the
 * event adapters' `mcp.<server>.<tool>` form or Claude Code's own `mcp__<server>__<tool>`. Null
 * for any other tool. The adapters used to take the first `subagent_` anywhere in the name, so
 * an agent slugged `subagent`, whose bridge is `batshit_gateway_subagent_<hash>`, had the hash
 * read as its Subagent, and its `spawn_workers` read as a Subagent call.
 */
export function parseCliSubagentToolName(toolName: string | null | undefined): CliSubagentToolCall | null {
  const lower = typeof toolName === 'string' ? toolName.trim().toLowerCase() : ''
  let parts: string[]
  if (lower.startsWith('mcp__')) parts = lower.slice('mcp__'.length).split('__')
  else if (lower.startsWith('mcp.')) parts = lower.slice('mcp.'.length).split('.')
  else return null
  if (parts.length !== 2) return null
  const [serverName, tool] = parts
  if (!serverName.startsWith(MANAGED_GATEWAY_PREFIX) || serverName.length === MANAGED_GATEWAY_PREFIX.length) return null
  if (!tool.startsWith(SUBAGENT_TOOL_PREFIX)) return null
  const toolKey = tool.slice(SUBAGENT_TOOL_PREFIX.length)
  return CLI_SUBAGENT_TOOL_KEY.test(toolKey) ? { serverName, toolKey } : null
}
