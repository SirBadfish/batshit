import { describe, expect, it } from 'vitest'

import { normalizeAssignedSubagent } from '../assignedSubagentNormalization'

describe('normalizeAssignedSubagent', () => {
  it('preserves native CLI settings needed by managed CLI subagents', () => {
    const normalized = normalizeAssignedSubagent({
      id: 'codex_cli_subagent',
      displayName: 'Codex CLI Subagent',
      subagentType: 'cli',
      primary_model_provider: 'openai-codex',
      primary_model_name: 'codex-cli',
      timeout_seconds: 240,
      provider_specific_settings: {
        codex_model: 'gpt-5.4',
      },
      codex_settings: {
        model: 'gpt-5.4',
        permissionMode: 'agent_full',
      },
      claude_settings: null,
      defaultMCPGateways: ['gw-1'],
      defaultMCPToolSelections: ['tool-a'],
      defaultTools: ['cli-tool-1'],
    })

    expect(normalized.subagentType).toBe('cli')
    expect(normalized.codex_settings).toMatchObject({
      model: 'gpt-5.4',
      permissionMode: 'agent_full',
    })
    expect(normalized.provider_specific_settings).toMatchObject({
      codex_model: 'gpt-5.4',
    })
    expect(normalized.timeout_seconds).toBe(240)
    expect(normalized.settings.timeout_seconds).toBe(240)
    expect(normalized.settings.codex_settings).toMatchObject({
      model: 'gpt-5.4',
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
