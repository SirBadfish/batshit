/**
 * SA-111 P1 (AMD-111-01) — the CLI subagent MCP name contract.
 *
 * P0 found live on BSMS that a Codex primary reported its Batshit subagent tool as
 * `mcp__batshit_gateway_megasmoke_codex_primary_suba._9de0fbd317bb`, not the
 * `mcp__batshit_gateway_megasmoke_codex_primary-subagents__subagent_megasmoke_codex_subagent`
 * the DCM roster printed: OpenAI caps a function name at 64 characters and Codex rewrites
 * anything longer. Batshit now keeps its own names inside that budget so the roster
 * reference, the profile's enabled-tools list, and the bridge's advertised tool are one
 * string on every lane.
 *
 * Three things are pinned here:
 *   1. The composed `mcp__<server>__<tool>` never exceeds 64 characters, including for the
 *      longest realistic agent + subagent ids.
 *   2. Names already inside their budget are left EXACTLY as they were (no churn for the
 *      short ids most users have).
 *   3. The TS module and the bridge's CommonJS mirror produce identical tool names.
 */

import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import path from 'node:path'

import {
  CLI_SUBAGENT_SERVER_SEGMENT_MAX,
  CLI_SUBAGENT_TOOL_KEY_MAX,
  CLI_WORKER_SPAWN_TOOL_NAME,
  MCP_FULL_TOOL_NAME_LIMIT,
  buildCliSubagentMcpServerName,
  buildCliSubagentMcpToolNameForKey,
  buildCliSubagentMcpToolReference,
  buildCliWorkerSpawnToolReference,
  shortNameHash,
  shortenNameSegment
} from '../cliSubagentToolNames'

const require = createRequire(import.meta.url)
const bridge = require(
  path.resolve(process.cwd(), 'scripts/lib/cli-subagent-tool-names.cjs')
) as typeof import('../../../../scripts/lib/cli-subagent-tool-names.cjs')

describe('CLI subagent MCP tool names (SA-111 AMD-111-01)', () => {
  it('leaves names that already fit exactly as they were', () => {
    const reference = buildCliSubagentMcpToolReference(
      { id: 'cody', slug: 'cody' },
      { id: 'researcher', slug: 'researcher' }
    )

    expect(reference).toEqual({
      serverName: 'batshit_gateway_cody-subagents',
      toolName: 'subagent_researcher',
      fullToolName: 'mcp__batshit_gateway_cody-subagents__subagent_researcher'
    })
    expect(reference!.fullToolName.length).toBeLessThanOrEqual(MCP_FULL_TOOL_NAME_LIMIT)
  })

  it('keeps the live BSMS pair inside the 64-character limit', () => {
    // The exact ids from the P0 live check, which composed to 89 characters before.
    const reference = buildCliSubagentMcpToolReference(
      { id: 'megasmoke_codex_primary', slug: 'megasmoke_codex_primary' },
      { id: 'megasmoke_codex_subagent', slug: 'cli_subagent' }
    )

    expect(reference!.fullToolName.length).toBeLessThanOrEqual(MCP_FULL_TOOL_NAME_LIMIT)
    expect(reference!.fullToolName).toBe(
      'mcp__batshit_gateway_megasmoke_85f7bc__subagent_megasmoke_9ccf0f'
    )
    // No `.` and no Codex hash form: this is Batshit's own deterministic name.
    expect(reference!.fullToolName).toMatch(/^mcp__[a-z0-9_-]+__[a-z0-9_-]+$/)
  })

  it('stays inside the limit for the longest realistic agent + subagent ids', () => {
    const longAgentId = 'a'.repeat(120)
    const longSubagentId = 's'.repeat(120)

    const reference = buildCliSubagentMcpToolReference(
      { id: longAgentId, slug: longAgentId },
      { id: longSubagentId, slug: longSubagentId }
    )

    expect(reference!.fullToolName.length).toBe(MCP_FULL_TOOL_NAME_LIMIT)
    expect(reference!.serverName.length).toBe(
      'batshit_gateway_'.length + CLI_SUBAGENT_SERVER_SEGMENT_MAX
    )
    expect(reference!.toolName.length).toBe('subagent_'.length + CLI_SUBAGENT_TOOL_KEY_MAX)
  })

  it('never collapses two different long names onto one tool', () => {
    const first = buildCliSubagentMcpToolNameForKey('megasmoke_codex_subagent_alpha')
    const second = buildCliSubagentMcpToolNameForKey('megasmoke_codex_subagent_beta')

    expect(first).not.toBe(second)
  })

  it('returns null without an agent id', () => {
    expect(buildCliSubagentMcpServerName(null)).toBeNull()
    expect(buildCliSubagentMcpServerName({ id: '   ' })).toBeNull()
    expect(buildCliSubagentMcpToolReference({ id: 'cody' }, null)).toBeNull()
  })

  it('shortens deterministically and never exceeds the requested budget', () => {
    expect(shortenNameSegment('short', 16)).toBe('short')
    expect(shortenNameSegment('a'.repeat(40), 16)).toHaveLength(16)
    expect(shortenNameSegment('a'.repeat(40), 16)).toBe(shortenNameSegment('a'.repeat(40), 16))
    // The head never ends on a dangling separator.
    expect(shortenNameSegment('sample_codex_primary-subagents', 16)).not.toMatch(/[-_]{2}/)
  })

  it('matches the bridge CommonJS mirror byte for byte', () => {
    const fixtures = [
      'researcher',
      'cli_subagent',
      'sample_api_subagent',
      'sample_codex_subagent',
      'megasmoke_codex_subagent',
      'a'.repeat(64),
      'x'
    ]

    for (const key of fixtures) {
      expect(bridge.buildCliSubagentMcpToolNameForKey(key)).toBe(
        buildCliSubagentMcpToolNameForKey(key)
      )
      expect(bridge.shortNameHash(key)).toBe(shortNameHash(key))
      expect(bridge.shortenNameSegment(key, 16)).toBe(shortenNameSegment(key, 16))
    }

    expect(bridge.CLI_SUBAGENT_TOOL_KEY_MAX).toBe(CLI_SUBAGENT_TOOL_KEY_MAX)
    // SA-111 P4: the Workers batch tool name is shared by the profile managers, the DCM,
    // and the bridge; a drift here silently enables one name while advertising another.
    expect(bridge.CLI_WORKER_SPAWN_TOOL_NAME).toBe(CLI_WORKER_SPAWN_TOOL_NAME)
  })

  it('SA-111 P4: the workers spawn tool stays inside the 64-character budget', () => {
    // Same rule as a subagent tool: what the roster prints has to be what Codex exposes.
    const reference = buildCliWorkerSpawnToolReference({
      id: 'megasmoke_codex_primary',
      slug: 'megasmoke_codex_primary'
    })

    expect(reference?.toolName).toBe(CLI_WORKER_SPAWN_TOOL_NAME)
    expect(reference?.fullToolName.length).toBeLessThanOrEqual(MCP_FULL_TOOL_NAME_LIMIT)
    expect(reference?.fullToolName).toBe(
      `mcp__${reference?.serverName}__${CLI_WORKER_SPAWN_TOOL_NAME}`
    )
    // A pathological agent id still cannot blow the budget, because the server segment is
    // bounded independently of the tool name.
    const long = buildCliWorkerSpawnToolReference({ id: 'x'.repeat(120), slug: 'y'.repeat(120) })
    expect(long?.fullToolName.length).toBeLessThanOrEqual(MCP_FULL_TOOL_NAME_LIMIT)

    expect(buildCliWorkerSpawnToolReference(null)).toBeNull()
  })
})
