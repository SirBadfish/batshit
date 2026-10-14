import { describe, expect, it } from 'vitest'
import { buildContextPreviewIdentity } from './contextPreviewIdentity'
import { cliContextSettingsKey, reportForCliSnapshot } from './cliContextWindow'

describe('browser-only preview identity for opaque Codex overrides', () => {
  it('keeps previews reusable and detects in-place edits without making a persistent context key', () => {
    const secret = 'SENTINEL-PRIVATE-CODEX-HEADER'
    const overrides = [{ key: 'model_providers.custom.http_headers.Authorization', value: secret }]
    const agent = { id: 'preview-agent', codex_settings: { permissionMode: 'chat', model: 'gpt-6-luna', configOverrides: overrides } }
    const input = { agentId: agent.id, isCodex: true, codexContext: cliContextSettingsKey('codex', agent),
      codexModel: 'gpt-6-luna', presetId: null, presetContextWindow: null,
      claudeContext: null, codexOverrides: overrides, agentZip: {}, globalZip: {} }
    expect(input.codexContext).toBeNull()
    const first = buildContextPreviewIdentity(input)
    expect(typeof first).toBe('string')
    expect(buildContextPreviewIdentity({ ...input, codexOverrides: structuredClone(overrides) })).toBe(first)
    expect(buildContextPreviewIdentity({ ...input, codexModel: 'gpt-6-sol' })).not.toBe(first)
    expect(buildContextPreviewIdentity({ ...input, presetId: 'another-preset' })).not.toBe(first)
    expect(buildContextPreviewIdentity({ ...input, presetContextWindow: 128_000 })).not.toBe(first)
    overrides[0].value = `${secret}-changed`
    expect(buildContextPreviewIdentity(input)).not.toBe(first)
    const saved = reportForCliSnapshot({ runtime: 'codex', model: 'gpt-6-luna', contextWindow: 258_400,
      evidence: 'runtime', settingsKey: first }, agent)
    expect(saved).not.toHaveProperty('settingsKey')
    expect(JSON.stringify(saved)).not.toContain(secret)
    expect(JSON.stringify(saved)).not.toContain('Authorization')
  })

  it('also invalidates zip edits and avoids copying opaque data when a safe context key exists', () => {
    const input = { agentId: 'preview-agent', isCodex: true, codexContext: 'safe-key', claudeContext: null,
      codexOverrides: [{ key: 'opaque', value: 'SENTINEL-UNUSED' }], agentZip: { auto_zip: true }, globalZip: {} }
    const first = buildContextPreviewIdentity(input)
    expect(first).not.toContain('SENTINEL-UNUSED')
    expect(buildContextPreviewIdentity({ ...input, agentZip: { auto_zip: false } })).not.toBe(first)
  })
})


describe('API preview identity', () => {
  it('invalidates endpoint, model, requested settings and connection refresh changes', () => {
    const input = { agentId: 'api-agent', isCodex: false, codexContext: null, claudeContext: null,
      apiProvider: 'ollama', apiModelId: 'qwen:9b', apiConnection: { baseUrl: 'http://127.0.0.1:11434' },
      apiSettings: { ollamaNumCtx: 8192 }, localConnectionRevision: 0, agentZip: {}, globalZip: {} }
    const first = buildContextPreviewIdentity(input)
    expect(buildContextPreviewIdentity(structuredClone(input))).toBe(first)
    expect(buildContextPreviewIdentity({ ...input, apiProvider: 'koboldcpp' })).not.toBe(first)
    expect(buildContextPreviewIdentity({ ...input, apiModelId: 'other-model' })).not.toBe(first)
    expect(buildContextPreviewIdentity({ ...input, apiConnection: { baseUrl: 'http://127.0.0.1:11435' } })).not.toBe(first)
    input.apiSettings.ollamaNumCtx = 16384
    expect(buildContextPreviewIdentity(input)).not.toBe(first)
    expect(buildContextPreviewIdentity({ ...input, apiSettings: { ollamaNumCtx: 8192 }, localConnectionRevision: 1 })).not.toBe(first)
  })
})
