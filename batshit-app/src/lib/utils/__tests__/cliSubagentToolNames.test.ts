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
 *   2. Names already inside their budget are not shortened (readable for the short ids most
 *      users have).
 *   3. The TS module and the bridge's CommonJS mirror produce identical tool names.
 *   4. BL-154: every name is made only of [A-Za-z0-9_], so Codex (which shows any other
 *      character as `_`) and Claude Code (which keeps a hyphen) show the same string.
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
  parseCliSubagentToolName,
  resolveCliSubagentToolKey,
  shortNameHash,
  shortenNameSegment,
  toCliShownMcpNameSegment
} from '../cliSubagentToolNames'

const require = createRequire(import.meta.url)
const bridge = require(
  path.resolve(process.cwd(), 'scripts/lib/cli-subagent-tool-names.cjs')
) as typeof import('../../../../scripts/lib/cli-subagent-tool-names.cjs')

describe('CLI subagent MCP tool names (SA-111 AMD-111-01)', () => {
  it('does not shorten names that already fit', () => {
    const reference = buildCliSubagentMcpToolReference(
      { id: 'cody', slug: 'cody' },
      { id: 'researcher', slug: 'researcher' }
    )

    // BL-154: `cody-subagents` became `cody_subagents`, the name Codex already showed.
    expect(reference).toEqual({
      serverName: 'batshit_gateway_cody_subagents',
      toolName: 'subagent_researcher',
      fullToolName: 'mcp__batshit_gateway_cody_subagents__subagent_researcher'
    })
    expect(reference!.fullToolName.length).toBeLessThanOrEqual(MCP_FULL_TOOL_NAME_LIMIT)
  })

  it('BL-154: gives a name Codex and Claude Code show the same way', () => {
    // Codex shows every character of an MCP name outside [A-Za-z0-9_] as `_` (measured in its
    // own request log: the server `batshit_gateway_cody-subagents` reached the model as
    // `mcp__batshit_gateway_cody_subagents`). Claude Code keeps [A-Za-z0-9_-] and replaces the
    // rest. A name made only of [A-Za-z0-9_] is left alone by both.
    const codexShows = (name: string) => name.replace(/[^A-Za-z0-9_]/g, '_')
    const claudeShows = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, '_')

    const agents = [
      { id: 'cody', slug: 'cody' },
      { id: 'agent_cli', slug: 'agent-cli' },
      { id: 'zbcli-claude-primary', slug: null },
      { id: 'x', slug: 'My Agent.v2' },
      { id: 'x', slug: '-lead' },
      { id: 'x', slug: 'a_-b' },
      { id: 'x', slug: 'my-agent-with-a-long-name' },
      { id: 'megasmoke_codex_primary', slug: 'megasmoke_codex_primary' }
    ]
    const subagents = [
      { id: 'researcher' },
      { id: 'api-subagent' },
      { id: 'zbcli-n8n-subagent-with-a-long-id' },
      { id: 'Big Papa!' }
    ]

    for (const agent of agents) {
      const workers = buildCliWorkerSpawnToolReference(agent)!
      for (const reference of [
        workers,
        ...subagents.map((subagent) => buildCliSubagentMcpToolReference(agent, subagent)!)
      ]) {
        const { serverName, toolName, fullToolName } = reference
        expect(fullToolName, fullToolName).toMatch(/^[A-Za-z0-9_]+$/)
        expect(codexShows(fullToolName)).toBe(fullToolName)
        expect(claudeShows(fullToolName)).toBe(fullToolName)
        // `mcp__<server>__<tool>` splits in exactly one place.
        expect(serverName.includes('__'), serverName).toBe(false)
        expect(toolName.includes('__'), toolName).toBe(false)
        expect(fullToolName).toBe(`mcp__${serverName}__${toolName}`)
        expect(fullToolName.length).toBeLessThanOrEqual(MCP_FULL_TOOL_NAME_LIMIT)
      }
    }
  })

  it('BL-154: changes only the names that carried a hyphen', () => {
    // A long name keeps the hash it always had (the live BSMS pair below), and a name with no
    // hyphen is untouched; only a hyphen, which Codex was already showing as `_`, changes.
    expect(buildCliSubagentMcpServerName({ id: 'megasmoke_codex_primary' })).toBe(
      'batshit_gateway_megasmoke_85f7bc'
    )
    expect(buildCliSubagentMcpServerName({ id: 'x', slug: 'my-agent-with-a-long-name' })).toBe(
      `batshit_gateway_my_agent_${shortNameHash('my-agent-with-a-long-name-subagents')}`
    )
    expect(toCliShownMcpNameSegment('batshit_gateway_cody_subagents')).toBe(
      'batshit_gateway_cody_subagents'
    )
    expect(toCliShownMcpNameSegment('-a_-b--c.d_')).toBe('a_b_c_d')
  })

  it('names a subagent tool after its normalized id, the key the profiles enable', () => {
    expect(resolveCliSubagentToolKey({ id: 'API-Subagent', slug: 'other' })).toBe('api_subagent')
    expect(resolveCliSubagentToolKey({ slug: 'Research Lead' })).toBe('research_lead')
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
    expect(reference!.fullToolName).toMatch(/^mcp__[a-z0-9_]+__[a-z0-9_]+$/)
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

  // BL-272: the event adapters read a Subagent call by this shape, never by the first
  // `subagent_` anywhere in the name.
  it('BL-272: reads a Subagent call by the managed shape on both CLIs', () => {
    const reference = buildCliSubagentMcpToolReference({ id: 'cody', slug: 'cody' }, { id: 'researcher' })!
    expect(parseCliSubagentToolName(reference.fullToolName)).toEqual({
      serverName: reference.serverName,
      toolKey: 'researcher'
    })
    expect(parseCliSubagentToolName(`mcp.${reference.serverName}.${reference.toolName}`)).toEqual({
      serverName: reference.serverName,
      toolKey: 'researcher'
    })
    // A long subagent id is shortened with a hash, and the key is the shortened one.
    const long = buildCliSubagentMcpToolReference({ id: 'cody' }, { id: 'a-very-long-subagent-identifier' })!
    expect(parseCliSubagentToolName(long.fullToolName)?.toolKey).toBe(long.toolName.slice('subagent_'.length))

    // An agent slugged `subagent`: its bridge name carries `subagent_<hash>`.
    const server = buildCliSubagentMcpServerName({ id: 'subagent', slug: 'subagent' })!
    expect(server).toMatch(/^batshit_gateway_subagent_[0-9a-f]{6}$/)
    expect(parseCliSubagentToolName(`mcp.${server}.subagent_researcher`)?.toolKey).toBe('researcher')
    expect(parseCliSubagentToolName(`mcp__${server}__subagent_researcher`)?.toolKey).toBe('researcher')
    expect(parseCliSubagentToolName(`mcp.${server}.${CLI_WORKER_SPAWN_TOOL_NAME}`)).toBeNull()
    expect(parseCliSubagentToolName(`mcp__${server}__${CLI_WORKER_SPAWN_TOOL_NAME}`)).toBeNull()

    // Not Batshit's bridge, or not a Subagent tool.
    expect(parseCliSubagentToolName('mcp.my_subagent_tools.run')).toBeNull()
    expect(parseCliSubagentToolName('mcp.other_server.subagent_x')).toBeNull()
    expect(parseCliSubagentToolName('subagent_researcher')).toBeNull()
    expect(parseCliSubagentToolName(`mcp.${server}.subagent_`)).toBeNull()
    expect(parseCliSubagentToolName('mcp.batshit_gateway_.subagent_x')).toBeNull()
    expect(parseCliSubagentToolName(null)).toBeNull()
  })
})
