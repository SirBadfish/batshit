/**
 * SA-111 P1 (AMD-111-01) — the MCP tool name the CLI subagent bridge advertises.
 *
 * This is the CommonJS mirror of `src/lib/utils/cliSubagentToolNames.ts`. The bridge
 * (`scripts/codex-subagent-mcp.cjs`) is spawned as a standalone node process and cannot
 * import `$lib`, while the Codex/Claude profile managers and the DCM roster all need the
 * SAME string — a profile that enables `subagent_x` while the bridge advertises
 * `subagent_y` silently leaves the subagent uncallable.
 *
 * `src/lib/utils/__tests__/cliSubagentToolNames.test.ts` requires this file and pins both
 * implementations against the same fixtures. Change one, change both.
 */

const SUBAGENT_TOOL_PREFIX = 'subagent_'
const CLI_SUBAGENT_TOOL_KEY_MAX = 16
const HASH_SUFFIX_LENGTH = 7

/** FNV-1a 32-bit, low 24 bits as 6 lowercase hex characters. */
function shortNameHash(value) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return (hash >>> 8).toString(16).padStart(6, '0')
}

function shortenNameSegment(value, max) {
  if (value.length <= max) return value
  const head = value.slice(0, Math.max(1, max - HASH_SUFFIX_LENGTH)).replace(/[-_]+$/, '')
  return `${head}_${shortNameHash(value)}`
}

function buildCliSubagentMcpToolNameForKey(toolKey) {
  return `${SUBAGENT_TOOL_PREFIX}${shortenNameSegment(toolKey, CLI_SUBAGENT_TOOL_KEY_MAX)}`
}

/**
 * SA-111 P4 (DL-111-09): the Workers batch tool the same bridge advertises. Fixed name,
 * comfortably inside the 64-character budget (`mcp__` + `batshit_gateway_` + <=16 segment
 * + `__` + 13 = 52 at worst), so it needs no shortening rule of its own.
 */
const CLI_WORKER_SPAWN_TOOL_NAME = 'spawn_workers'

module.exports = {
  CLI_SUBAGENT_TOOL_KEY_MAX,
  CLI_WORKER_SPAWN_TOOL_NAME,
  buildCliSubagentMcpToolNameForKey,
  shortNameHash,
  shortenNameSegment
}
