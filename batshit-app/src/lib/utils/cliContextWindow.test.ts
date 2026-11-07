import { describe, expect, it } from 'vitest'
import {
  cliContextSettingsKey, matchingCliContextReport, reportForCliSnapshot, resolveAgentCliModel, resolveCliContextWindow
} from './cliContextWindow'

describe('resolveCliContextWindow', () => {
  it.each([
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

  it.each(['claude', 'claude-cli', 'sonnet'])('uses the Claude CLI default when settings name no model, regardless of primary label %s', label => {
    expect(resolveAgentCliModel('claude', {
      primary_model_name: label, claude_settings: { permissionMode: 'default', model: null }
    })).toBeNull()
  })
  it('uses a reported window only for the active runtime and model', () => {
    expect(resolveCliContextWindow({
      runtime: 'claude', model: 'claude-sonnet-5-5', presetContextWindow: 100_000,
      reported: { runtime: 'claude', model: 'claude-sonnet-5-5', contextWindow: 258_400, evidence: 'runtime' }
    })).toMatchObject({ contextWindow: 258_400, source: 'runtime' })
    expect(resolveCliContextWindow({
      runtime: 'claude', model: 'claude-sonnet-5-5', presetContextWindow: 100_000,
      reported: { runtime: 'claude', model: 'claude-opus-5-5', contextWindow: 258_400, evidence: 'runtime' }
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

  it('keeps a changed model or preset window distinct from prior runtime evidence', () => {
    const base = { claude_settings: { permissionMode: 'default', model: 'claude-sonnet-5-5', configOverrides: [] } }
    const changed = { claude_settings: { ...base.claude_settings, model: 'claude-opus-5-5' } }
    expect(cliContextSettingsKey('claude', base, 100_000))
      .not.toBe(cliContextSettingsKey('claude', changed, 100_000))
    expect(cliContextSettingsKey('claude', base, 100_000))
      .not.toBe(cliContextSettingsKey('claude', base, 200_000))
  })

  it('never serializes override values or an untrusted key, so credentials never reach a snapshot', () => {
    const secret = 'SENTINEL-PRIVATE-HEADER-value-123'
    const report = {
      runtime: 'claude' as const, model: 'claude-sonnet-5-5', contextWindow: 1_000_000,
      evidence: 'runtime' as const
    }
    for (const settings of [
      { claude_settings: { permissionMode: 'default', model: 'claude-sonnet-5-5',
        configOverrides: [{ key: 'env.ANTHROPIC_CUSTOM_HEADERS', value: `Authorization: ${secret}` }] } },
      { provider_specific_settings: { claude_model: 'claude-sonnet-5-5',
        claude_config_overrides: [{ key: 'env.ANTHROPIC_CUSTOM_HEADERS', value: `Authorization: ${secret}` }] } }
    ]) {
      const serialized = JSON.stringify({ metadata: {
        cliContextWindow: reportForCliSnapshot({ ...report, settingsKey: secret }, settings)
      } })
      expect(serialized).not.toContain(secret)
      expect(serialized).not.toContain('Authorization')
      expect(JSON.parse(serialized).metadata.cliContextWindow.settingsKey).toBe(cliContextSettingsKey('claude', settings))
    }
  })

  it('Claude takes no context override: override rows never change or enter the key', () => {
    const agent = (overrides: unknown) => ({
      claude_settings: { permissionMode: 'default', model: 'claude-sonnet-5-5', configOverrides: overrides }
    })
    const key = cliContextSettingsKey('claude', agent([]))
    expect(key).not.toBeNull()
    for (const overrides of [
      [{ key: 'model_context_window', value: '128000' }],
      [{ key: 'other.setting', value: 'opaque' }],
      'malformed'
    ]) {
      expect(cliContextSettingsKey('claude', agent(overrides))).toBe(key)
    }
    expect(JSON.parse(key!).contextOverrides).toEqual([])
  })

  it('never matches missing or null keys across settings reads', () => {
    const report = {
      runtime: 'claude' as const, model: 'claude-sonnet-5-5', contextWindow: 1_000_000,
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
