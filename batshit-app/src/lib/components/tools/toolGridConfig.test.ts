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
