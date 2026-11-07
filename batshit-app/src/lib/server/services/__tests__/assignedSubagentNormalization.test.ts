import { describe, expect, it } from 'vitest'

import { normalizeAssignedSubagent } from '../assignedSubagentNormalization'

describe('normalizeAssignedSubagent', () => {
  it('preserves native CLI settings needed by managed CLI subagents', () => {
    const normalized = normalizeAssignedSubagent({
      id: 'claude_cli_subagent',
      displayName: 'Claude CLI Subagent',
      subagentType: 'cli',
      primary_model_provider: 'claude-cli',
      primary_model_name: 'claude-cli',
      timeout_seconds: 240,
      provider_specific_settings: {
        claude_model: 'claude-sonnet-4-5',
      },
      claude_settings: {
        model: 'claude-sonnet-4-5',
        permissionMode: 'bypassPermissions',
      },
      defaultMCPGateways: ['gw-1'],
      defaultMCPToolSelections: ['tool-a'],
      defaultTools: ['cli-tool-1'],
    })

    expect(normalized.subagentType).toBe('cli')
    expect(normalized.claude_settings).toMatchObject({
      model: 'claude-sonnet-4-5',
      permissionMode: 'bypassPermissions',
    })
    expect(normalized.provider_specific_settings).toMatchObject({
      claude_model: 'claude-sonnet-4-5',
    })
    expect(normalized.timeout_seconds).toBe(240)
    expect(normalized.settings.timeout_seconds).toBe(240)
    expect(normalized.settings.claude_settings).toMatchObject({
      model: 'claude-sonnet-4-5',
    })
  })

  it('keeps the preset and connection an API Subagent runs through (BL-266)', () => {
    const connection = { id: 'direct:google', type: 'direct', service: 'google', useDeveloperPrefix: false }
    const normalized = normalizeAssignedSubagent({
      id: 'gemini_helper',
      displayName: 'Gemini Helper',
      subagentType: 'api',
      primary_model_provider: 'google',
      primary_model_name: 'gemini-3.5-flash',
      primary_model_preset_id: 'gemini_3_flash_google_gemini_3_flash_direct_google',
      primary_model_connection: connection,
    })

    // Live, the send path handed the runner this normalized copy, and without these two fields
    // every Subagent with its own model was refused as if its model had no preset.
    expect(normalized.primary_model_preset_id).toBe('gemini_3_flash_google_gemini_3_flash_direct_google')
    expect(normalized.primary_model_connection).toEqual(connection)
  })
})
