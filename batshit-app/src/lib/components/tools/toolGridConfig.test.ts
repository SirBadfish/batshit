import { describe, expect, it } from 'vitest'

import {
  DYNAMIC_TOOL_SEARCH_INFO_PARAGRAPHS,
  formatToolGridInheritedZipBehaviorLabel,
  formatToolGridZipBehaviorLabel,
  SHARED_NON_MCP_TOOL_GRID_CONFIG,
  SHARED_NON_MCP_TOOL_GRID_BATSHIT_ROW_IDS,
  SHARED_NON_MCP_TOOL_GRID_OTHER_ROW_IDS,
  SHARED_NON_MCP_TOOL_GRID_ROW_ORDER
} from './toolGridConfig'
import {
  ARTIFACT_TOOL_GRID_GROUP_NAME,
  ARTIFACT_TOOL_GRID_INFO_PARAGRAPHS,
  FABRIC_TOOL_GRID_GROUP_NAME,
  FABRIC_TOOL_GRID_INFO_PARAGRAPHS
} from '$lib/utils/toolGridBrokerFamilies'

describe('shared Tool Grid taxonomy', () => {
  it('keeps Batshit Tools in the product-approved order', () => {
    expect(SHARED_NON_MCP_TOOL_GRID_BATSHIT_ROW_IDS).toEqual([
      'read_file',
      'skill_read',
      'write_file',
      'edit_file',
      'search_files',
      'list_files',
      'bash',
      'web_search',
      'fetch_zip',
      'subagent',
      'tool_find',
      'artifact_find',
      'fabric_find',
      'agent_browser_actions'
    ])
    expect(SHARED_NON_MCP_TOOL_GRID_CONFIG.tool_find.label).toBe('Dynamic Tool Search')
    expect(SHARED_NON_MCP_TOOL_GRID_CONFIG.artifact_find.label).toBe('Artifact Tools')
    expect(SHARED_NON_MCP_TOOL_GRID_CONFIG.fabric_find.label).toBe('Fabric Controls')
    expect(SHARED_NON_MCP_TOOL_GRID_CONFIG.agent_browser_actions.label).toBe('Agent Browser Actions')
  })

  it('keeps Dynamic Tool Search explanation on the row instead of a separate section', () => {
    expect(SHARED_NON_MCP_TOOL_GRID_CONFIG.tool_find.infoParagraphs).toEqual(
      DYNAMIC_TOOL_SEARCH_INFO_PARAGRAPHS
    )
    expect(DYNAMIC_TOOL_SEARCH_INFO_PARAGRAPHS.join(' ')).toContain('MCP tools')
    expect(DYNAMIC_TOOL_SEARCH_INFO_PARAGRAPHS.join(' ')).toContain('saved CLI Tools')
    expect(DYNAMIC_TOOL_SEARCH_INFO_PARAGRAPHS.join(' ')).toContain('published Artifact runtime tools')
    expect(DYNAMIC_TOOL_SEARCH_INFO_PARAGRAPHS.join(' ')).toContain('Fabric controls')
    expect(DYNAMIC_TOOL_SEARCH_INFO_PARAGRAPHS.join(' ')).toContain('Agent Browser actions')
  })

  // SA-096: the Fabric and Artifact broker families are configured on these two Batshit
  // Tools rows rather than on separate top-level rows, so a family never appears twice in
  // one grid. The row label IS the family group name; if either side is renamed
  // independently the merge silently becomes two differently-named things again.
  it('hosts the broker families on their Batshit Tools rows', () => {
    expect(SHARED_NON_MCP_TOOL_GRID_CONFIG.fabric_find.label).toBe(FABRIC_TOOL_GRID_GROUP_NAME)
    expect(SHARED_NON_MCP_TOOL_GRID_CONFIG.artifact_find.label).toBe(ARTIFACT_TOOL_GRID_GROUP_NAME)
    expect(SHARED_NON_MCP_TOOL_GRID_BATSHIT_ROW_IDS).toContain('fabric_find')
    expect(SHARED_NON_MCP_TOOL_GRID_BATSHIT_ROW_IDS).toContain('artifact_find')
  })

  it('carries only the family explanation, which is true on every Tool Grid surface', () => {
    // The Group tool-sharing grid reads this same config and has no Discoverable,
    // Display Detail, or Zip columns. Surface-specific column copy therefore belongs to
    // the surface (NonMcpZipRowsSection appends it), never to the shared row config.
    expect(SHARED_NON_MCP_TOOL_GRID_CONFIG.fabric_find.infoParagraphs).toEqual(
      FABRIC_TOOL_GRID_INFO_PARAGRAPHS
    )
    expect(SHARED_NON_MCP_TOOL_GRID_CONFIG.artifact_find.infoParagraphs).toEqual(
      ARTIFACT_TOOL_GRID_INFO_PARAGRAPHS
    )

    for (const paragraphs of [FABRIC_TOOL_GRID_INFO_PARAGRAPHS, ARTIFACT_TOOL_GRID_INFO_PARAGRAPHS]) {
      const joined = paragraphs.join(' ')
      expect(joined).not.toContain('Zip Buffer')
      expect(joined).not.toContain('Discoverable')
    }
  })

  it('keeps legacy find/use rows out of the visible shared row order', () => {
    expect(SHARED_NON_MCP_TOOL_GRID_OTHER_ROW_IDS).toEqual(['all_other_tools'])
    expect(SHARED_NON_MCP_TOOL_GRID_ROW_ORDER).not.toContain('dynamic_find')
    expect(SHARED_NON_MCP_TOOL_GRID_ROW_ORDER).not.toContain('artifact_use')
    expect(SHARED_NON_MCP_TOOL_GRID_ROW_ORDER).not.toContain('fabric_use')
    expect(SHARED_NON_MCP_TOOL_GRID_ROW_ORDER).not.toContain('image')
  })

  it('keeps Skill Read at the launch default buffer of 10 messages', () => {
    expect(SHARED_NON_MCP_TOOL_GRID_CONFIG.skill_read.defaultBuffer).toBe(10)
    expect(SHARED_NON_MCP_TOOL_GRID_CONFIG.skill_read.defaultThreshold).toBe(0)
    expect(SHARED_NON_MCP_TOOL_GRID_CONFIG.skill_read.defaultAutoZip).toBe(false)
  })

  it('distinguishes global defaults from agent inheritance in zip behavior labels', () => {
    expect(formatToolGridInheritedZipBehaviorLabel(true, false)).toBe('Auto')
    expect(formatToolGridInheritedZipBehaviorLabel(false, false)).toBe('Normal')
    expect(formatToolGridInheritedZipBehaviorLabel(true, true)).toBe('Off')

    expect(formatToolGridZipBehaviorLabel('inherit', true, false, 'default')).toBe(
      'Default (Auto)'
    )
    expect(formatToolGridZipBehaviorLabel('__inherit__', false, false, 'inherit')).toBe(
      'Inherit (Normal)'
    )
    expect(formatToolGridZipBehaviorLabel('enabled', false, false, 'default')).toBe('Auto')
    expect(formatToolGridZipBehaviorLabel('disabled', true, false, 'default')).toBe('Normal')
    expect(formatToolGridZipBehaviorLabel('off', true, false, 'default')).toBe('Off')
  })
})
