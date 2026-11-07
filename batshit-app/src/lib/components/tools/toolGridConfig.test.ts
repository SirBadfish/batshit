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
import { getToolSettings } from '$lib/utils/toolRenderMap'
import {
  ARTIFACT_TOOL_GRID_GROUP_NAME,
  ARTIFACT_TOOL_GRID_INFO_PARAGRAPHS,
  FABRIC_TOOL_GRID_DISPLAY_NAME,
  FABRIC_TOOL_GRID_INFO_PARAGRAPHS
} from '$lib/utils/toolGridBrokerFamilies'

describe('shared Tool Grid taxonomy', () => {
  it('keeps Batshit Tools in the product-approved order', () => {
    expect(SHARED_NON_MCP_TOOL_GRID_BATSHIT_ROW_IDS).toEqual([
      'read_file',
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
    expect(SHARED_NON_MCP_TOOL_GRID_CONFIG.fabric_find.label).toBe('Fabric & Utilities')
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
  // one grid. The row label IS the family display name; if either side is renamed
  // independently the merge silently becomes two differently-named things again.
  it('hosts the broker families on their Batshit Tools rows', () => {
    expect(SHARED_NON_MCP_TOOL_GRID_CONFIG.fabric_find.label).toBe(FABRIC_TOOL_GRID_DISPLAY_NAME)
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

  it('keeps remaining zip defaults while Skill Read is owned by the skill lifecycle', () => {
    const row = (id: keyof typeof SHARED_NON_MCP_TOOL_GRID_CONFIG) => {
      const config = SHARED_NON_MCP_TOOL_GRID_CONFIG[id]
      return [config.defaultBuffer, config.defaultThreshold, config.defaultAutoZip]
    }
    expect(row('read_file')).toEqual([2, 0, false])
    expect(SHARED_NON_MCP_TOOL_GRID_BATSHIT_ROW_IDS).not.toContain('skill_read')
    expect(row('write_file')).toEqual([2, 0, true])
    expect(row('edit_file')).toEqual([2, 0, true])
    expect(row('bash')).toEqual([1, 0, true])
    expect(row('fetch_zip')).toEqual([1, 0, true])
    expect(row('subagent')).toEqual([2, 0, false])
    for (const id of ['search_files', 'list_files', 'web_search', 'tool_find', 'artifact_find', 'artifact_use', 'fabric_find', 'fabric_use', 'agent_browser_actions', 'all_other_tools'] as const) {
      expect(row(id)).toEqual([1, 0, true])
    }
  })

  it('agrees with the runtime factory defaults for emitted tool rows (absent settings)', () => {
    // This is a permission-only family; its Read/Write/Edit children own result compression.
    expect(SHARED_NON_MCP_TOOL_GRID_CONFIG.typed_file_tools.infoParagraphs?.join(' '))
      .toContain('The separate Read, Write and Edit rows configure result compression.')
    for (const config of Object.values(SHARED_NON_MCP_TOOL_GRID_CONFIG)) {
      if (config.id === 'image' || config.id === 'all_other_tools' || config.id === 'typed_file_tools') continue
      const name = config.mode === 'custom' ? config.toolName : config.id
      expect([config.id, getToolSettings(name, {}, {})]).toEqual([config.id, {
        buffer_size: config.defaultBuffer,
        zip_threshold: config.defaultThreshold,
        auto_zip: config.defaultAutoZip,
        zip_disabled: false
      }])
    }
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
