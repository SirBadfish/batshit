import { describe, expect, it } from 'vitest'
import {
  CLI_HELPER_MCP_SERVER_NAME,
  buildCliHelperMcpToolName,
  isCliHelperMcpServerName
} from '../cliHelperToolNames'
import { MODE4_INTERNAL_HELPER_TOOL_NAMES } from '$lib/server/services/mode4InternalTools'

/**
 * BL-5 — every helper tool keeps its own name on every CLI.
 *
 * codex-cli 0.139.0 through 0.148.0 show the model `mcp__<server>__<tool>` with every
 * character outside [A-Za-z0-9_] turned into `_`, and rename anything over 64 bytes to a
 * hashed code name (`codex-rs/codex-mcp/src/tools.rs`, `MAX_TOOL_NAME_LENGTH`). So the name
 * Batshit builds must survive that rewrite unchanged, or the prompt names a tool the model
 * cannot find.
 */
const CODEX_0_139_TOOL_NAME_LIMIT_BYTES = 64
const codexModelVisibleName = (name: string) => name.replace(/[^A-Za-z0-9_]/g, '_')

describe('the managed CLI helper server name', () => {
  it('is one fixed name', () => {
    expect(CLI_HELPER_MCP_SERVER_NAME).toBe('batshit_helpers')
    expect(buildCliHelperMcpToolName('batshit_server_bash_execute')).toBe(
      'mcp__batshit_helpers__batshit_server_bash_execute'
    )
  })

  it('keeps every helper tool inside Codex 0.139 naming, byte for byte', () => {
    expect(MODE4_INTERNAL_HELPER_TOOL_NAMES.length).toBeGreaterThan(0)
    for (const tool of MODE4_INTERNAL_HELPER_TOOL_NAMES) {
      const full = buildCliHelperMcpToolName(tool)
      expect(full, full).toMatch(/^[a-z0-9_]+$/)
      expect(Buffer.byteLength(full, 'utf8'), full).toBeLessThanOrEqual(
        CODEX_0_139_TOOL_NAME_LIMIT_BYTES
      )
      expect(codexModelVisibleName(full)).toBe(full)
    }
  })

  it('leaves the longest helper, the Agent Browser finder, 9 bytes to spare', () => {
    const longest = [...MODE4_INTERNAL_HELPER_TOOL_NAMES]
      .map(buildCliHelperMcpToolName)
      .sort((a, b) => b.length - a.length)[0]
    expect(longest).toBe('mcp__batshit_helpers__batshit_server_agent_browser_find')
    expect(Buffer.byteLength(longest, 'utf8')).toBe(55)
  })
})

describe('isCliHelperMcpServerName', () => {
  it('recognizes the helper server under its name', () => {
    expect(isCliHelperMcpServerName('batshit_helpers')).toBe(true)
    expect(isCliHelperMcpServerName(' Batshit_Helpers ')).toBe(true)
  })

  it('still recognizes the per-agent names stored chats carry', () => {
    expect(isCliHelperMcpServerName('batshit_gateway_cody-mode4-controls')).toBe(true)
    expect(isCliHelperMcpServerName('batshit_gateway_jev_p4_codex-mode4-controls')).toBe(true)
    expect(isCliHelperMcpServerName('agent-123-mode4-controls')).toBe(true)
    // Codex's own spelling of an old name, hyphens already turned into underscores.
    expect(isCliHelperMcpServerName('batshit_gateway_cody_mode4_controls')).toBe(true)
  })

  it('is no other managed server', () => {
    expect(isCliHelperMcpServerName('batshit_gateway_cody-subagents')).toBe(false)
    expect(isCliHelperMcpServerName('batshit_gateway_zbcodex-s_70d44f')).toBe(false)
    expect(isCliHelperMcpServerName('batshit_gateway_claude-approvals')).toBe(false)
    expect(isCliHelperMcpServerName('batshit_gateway_main_gateway')).toBe(false)
    expect(isCliHelperMcpServerName('batshit_helpers_extra')).toBe(false)
    expect(isCliHelperMcpServerName('')).toBe(false)
    expect(isCliHelperMcpServerName(null)).toBe(false)
    expect(isCliHelperMcpServerName(undefined)).toBe(false)
  })
})
