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
 * The strictest model-visible name rule a managed CLI applied (codex-cli 0.139.0 through
 * 0.148.0, now removed) was `mcp__<server>__<tool>` with every character outside [A-Za-z0-9_]
 * turned into `_` and anything over 64 bytes renamed to a hashed code name. Helper names stay
 * inside that rule, so no CLI can rename a tool the prompt names.
 */
const MODEL_VISIBLE_TOOL_NAME_LIMIT_BYTES = 64
const modelVisibleName = (name: string) => name.replace(/[^A-Za-z0-9_]/g, '_')

describe('the managed CLI helper server name', () => {
  it('is one fixed name', () => {
    expect(CLI_HELPER_MCP_SERVER_NAME).toBe('batshit_helpers')
    expect(buildCliHelperMcpToolName('batshit_server_bash_execute')).toBe(
      'mcp__batshit_helpers__batshit_server_bash_execute'
    )
  })

  it('keeps every helper tool inside the 64-byte model-visible name rule, byte for byte', () => {
    expect(MODE4_INTERNAL_HELPER_TOOL_NAMES.length).toBeGreaterThan(0)
    for (const tool of MODE4_INTERNAL_HELPER_TOOL_NAMES) {
      const full = buildCliHelperMcpToolName(tool)
      expect(full, full).toMatch(/^[a-z0-9_]+$/)
      expect(Buffer.byteLength(full, 'utf8'), full).toBeLessThanOrEqual(
        MODEL_VISIBLE_TOOL_NAME_LIMIT_BYTES
      )
      expect(modelVisibleName(full)).toBe(full)
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
    // An old name as a CLI rewrote it, hyphens already turned into underscores.
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
