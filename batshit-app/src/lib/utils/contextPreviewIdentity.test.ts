import { describe, expect, it } from 'vitest'
import { buildContextPreviewIdentity } from './contextPreviewIdentity'

// SA-139 R4: the Claude Code CLI Primary's context key left with that lane; the preview identity
// is the agent, its preset and context window, the API selection and the Zip settings.
describe('preview identity', () => {
  it('invalidates preset and zip edits, and stays reusable for an equal input', () => {
    const input = { agentId: 'preview-agent', presetId: null,
      presetContextWindow: null, agentZip: { auto_zip: true }, globalZip: {} }
    const first = buildContextPreviewIdentity(input)
    expect(buildContextPreviewIdentity(structuredClone(input))).toBe(first)
    expect(buildContextPreviewIdentity({ ...input, presetId: 'another-preset' })).not.toBe(first)
    expect(buildContextPreviewIdentity({ ...input, presetContextWindow: 128_000 })).not.toBe(first)
    expect(buildContextPreviewIdentity({ ...input, agentZip: { auto_zip: false } })).not.toBe(first)
    expect(buildContextPreviewIdentity({ ...input, globalZip: { auto_zip: true } })).not.toBe(first)
  })
})

describe('API preview identity', () => {
  it('invalidates endpoint, model, requested settings and connection refresh changes', () => {
    const input = { agentId: 'api-agent',
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
