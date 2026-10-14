import { describe, expect, it } from 'vitest'
import {
  cliContextSettingsKey, matchingCliContextReport, reportForCliSnapshot, resolveAgentCliModel, resolveCliContextWindow
} from './cliContextWindow'

describe('resolveCliContextWindow', () => {
  it.each([
    ['codex', 'gpt-6.1-sol', 258_400],
    ['claude', 'claude-sonnet-5-5', 1_000_000],
    ['claude', 'haiku', 1_000_000],
    ['claude', 'claude-haiku-5-5', 1_000_000],
    ['claude', 'claude-haiku-4-5-20251001', 200_000]
  ] as const)('resolves the verified %s choice %s and lets runtime replace its estimate', (runtime, model, contextWindow) => {
    expect(resolveCliContextWindow({ runtime, model }))
      .toMatchObject({ contextWindow, source: 'choice' })
    expect(resolveCliContextWindow({ runtime, model, reported: {
      runtime, model, contextWindow: 123_456, evidence: 'runtime'
    } })).toMatchObject({ contextWindow: 123_456, source: 'runtime' })
  })

  it.each(['codex', 'codex-cli', 'gpt-6-sol'])('uses the Codex CLI default when settings name no model, regardless of primary label %s', label => {
    expect(resolveAgentCliModel('codex', {
      primary_model_name: label, codex_settings: { permissionMode: 'chat', model: null }
    })).toBeNull()
  })

  it.each(['claude', 'claude-cli', 'sonnet'])('uses the Claude CLI default when settings name no model, regardless of primary label %s', label => {
    expect(resolveAgentCliModel('claude', {
      primary_model_name: label, claude_settings: { permissionMode: 'default', model: null }
    })).toBeNull()
  })
  it('uses a reported window only for the active runtime and model', () => {
    expect(resolveCliContextWindow({
      runtime: 'codex', model: 'gpt-6-sol', presetContextWindow: 100_000,
      reported: { runtime: 'codex', model: 'gpt-6-sol', contextWindow: 258_400, evidence: 'runtime' }
    })).toMatchObject({ contextWindow: 258_400, source: 'runtime' })
    expect(resolveCliContextWindow({
      runtime: 'codex', model: 'gpt-6-sol', presetContextWindow: 100_000,
      reported: { runtime: 'codex', model: 'gpt-6-astra', contextWindow: 258_400, evidence: 'runtime' }
    })).toMatchObject({ contextWindow: 100_000, source: 'preset' })
  })

  it('uses positive preset values before a known choice and leaves unknown choices unknown', () => {
    expect(resolveCliContextWindow({
      runtime: 'claude', model: 'sonnet[1m]', presetContextWindow: 80_000
    })).toMatchObject({ contextWindow: 80_000, source: 'preset' })
    expect(resolveCliContextWindow({ runtime: 'claude', model: 'sonnet[1m]' }))
      .toMatchObject({ contextWindow: 1_000_000, source: 'choice' })
    expect(resolveCliContextWindow({ runtime: 'claude', model: 'unlisted-model' }))
      .toMatchObject({ contextWindow: null, source: 'unknown' })
  })

  it('caps Claude choices when 1M context is disabled without inventing a default model', () => {
    expect(resolveCliContextWindow({ runtime: 'claude', model: 'fable', disableClaude1M: true }))
      .toMatchObject({ contextWindow: 200_000, source: 'choice' })
    expect(resolveCliContextWindow({ runtime: 'claude', model: 'default', disableClaude1M: true }))
      .toMatchObject({ contextWindow: null, source: 'unknown' })
    expect(resolveCliContextWindow({ runtime: 'claude', model: 'claude-haiku-5-5', disableClaude1M: true }))
      .toMatchObject({ contextWindow: 200_000, source: 'choice' })
  })

  it('keeps a changed config distinct from prior runtime evidence', () => {
    const base = { codex_settings: { permissionMode: 'default', model: 'gpt-6-sol', configOverrides: [] } }
    const changed = { codex_settings: {
      ...base.codex_settings, configOverrides: [{ key: 'model_context_window', value: '128000' }]
    } }
    expect(cliContextSettingsKey('codex', base, 100_000))
      .not.toBe(cliContextSettingsKey('codex', changed, 100_000))
    expect(cliContextSettingsKey('codex', base, 100_000))
      .not.toBe(cliContextSettingsKey('codex', base, 200_000))
  })

  it('serializes only numeric context overrides and never credential values', () => {
    const secret = 'SENTINEL-PRIVATE-HEADER-value-123'
    const report = {
      runtime: 'codex' as const, model: 'gpt-6-sol', contextWindow: 258_400,
      evidence: 'runtime' as const
    }
    for (const settings of [
      { codex_settings: { permissionMode: 'chat', model: 'gpt-6-sol',
        configOverrides: [{ key: 'model_providers.custom.http_headers.Authorization', value: secret }] } },
      { provider_specific_settings: { codex_model: 'gpt-6-sol',
        codex_config_overrides: [{ key: 'model_providers.custom.http_headers.Authorization', value: secret }] } }
    ]) {
      expect(cliContextSettingsKey('codex', settings)).toBeNull()
      const serialized = JSON.stringify({ metadata: {
        cliContextWindow: reportForCliSnapshot({ ...report, settingsKey: secret }, settings)
      } })
      expect(serialized).not.toContain(secret)
      expect(serialized).not.toContain('Authorization')
      expect(JSON.parse(serialized).metadata.cliContextWindow).not.toHaveProperty('settingsKey')
    }
  })

  it('accepts only positive integer context overrides and invalidates numeric changes', () => {
    const agent = (overrides: unknown) => ({
      codex_settings: { permissionMode: 'chat', model: 'gpt-6-sol', configOverrides: overrides }
    })
    const first = cliContextSettingsKey('codex', agent([
      { key: 'model_context_window', value: '128000' },
      { key: 'model_auto_compact_token_limit', value: 100_000 }
    ]))
    expect(first).toContain('128000')
    expect(first).not.toContain('100_000')
    expect(first).not.toBe(cliContextSettingsKey('codex', agent([
      { key: 'model_context_window', value: '256000' },
      { key: 'model_auto_compact_token_limit', value: 100_000 }
    ])))
    expect(cliContextSettingsKey('codex', agent([]))).not.toBeNull()
    const legacy = (value: unknown) => ({ provider_specific_settings: {
      codex_model: 'gpt-6-sol', codex_config_overrides: [{ key: 'model_context_window', value }]
    } })
    expect(cliContextSettingsKey('codex', legacy('128000')))
      .not.toBe(cliContextSettingsKey('codex', legacy('256000')))
    expect(cliContextSettingsKey('codex', legacy('SENTINEL-PRIVATE-HEADER-value-123'))).toBeNull()
    for (const overrides of [
      [{ key: 'model_context_window', value: '128000; secret' }],
      [{ key: 'model_context_window', value: '0' }],
      [{ key: 'model_context_window', value: '1.5' }],
      [{ key: 'model_context_window', value: '999999999999999999999' }],
      [{ key: 'model_context_window', value: '128000' }, { key: 'model_context_window', value: '256000' }],
      [{ key: 'other.setting', value: 'opaque' }],
      [{ value: 128000 }],
      'malformed'
    ]) expect(cliContextSettingsKey('codex', agent(overrides))).toBeNull()
  })

  it('never matches missing or null keys across settings reads', () => {
    const report = {
      runtime: 'codex' as const, model: 'gpt-6-sol', contextWindow: 258_400,
      evidence: 'runtime' as const
    }
    expect(matchingCliContextReport(report, null)).toBeNull()
    expect(matchingCliContextReport({ ...report, settingsKey: '' }, '')).toBeNull()
    expect(matchingCliContextReport({ ...report, settingsKey: 'safe' }, null)).toBeNull()
    expect(matchingCliContextReport({ ...report, settingsKey: 'safe' }, 'safe')).toEqual({
      ...report, settingsKey: 'safe'
    })
  })

  it('does not mistake a resolved model name for CLI-reported window telemetry', () => {
    expect(resolveCliContextWindow({
      runtime: 'claude', model: 'sonnet',
      reported: {
        runtime: 'claude', model: 'sonnet', actualModel: 'claude-sonnet-5',
        contextWindow: 1_000_000, evidence: 'resolved'
      }
    })).toMatchObject({ contextWindow: 1_000_000, source: 'choice' })
    expect(resolveCliContextWindow({
      runtime: 'claude', model: 'sonnet',
      reported: {
        runtime: 'claude', model: 'sonnet', actualModel: 'unlisted-model',
        contextWindow: null, evidence: 'unresolved'
      }
    })).toMatchObject({ contextWindow: null, source: 'unknown' })
    expect(resolveCliContextWindow({
      runtime: 'claude', model: 'opus4.6[1m]',
      reported: {
        runtime: 'claude', model: 'opus4.6[1m]', actualModel: 'claude-opus-4-6',
        contextWindow: 1_000_000, evidence: 'resolved'
      }
    })).toMatchObject({ contextWindow: 1_000_000, source: 'choice' })
  })
})
