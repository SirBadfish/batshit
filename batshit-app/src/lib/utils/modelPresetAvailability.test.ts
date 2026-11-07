import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getModelPresetAvailability, presetAvailabilityKeepsSelection } from './modelPresetAvailability'
import type { CatalogConnectionOption } from '$lib/types/modelCatalog'
import type { SavedModel } from '$lib/types/savedModels'

function preset(overrides: Partial<SavedModel>): SavedModel {
  return {
    id: 'preset-1',
    modelName: 'Voice Preset',
    modelId: 'gpt-realtime',
    provider: 'openai',
    purpose: 'chat',
    contextWindow: 0,
    pricing: { input: 0, output: 0 },
    createdAt: '2026-05-18T00:00:00.000Z',
    updatedAt: '2026-05-18T00:00:00.000Z',
    ...overrides
  }
}

describe('getModelPresetAvailability', () => {
  it.each([
    ['replicate', 'anthropic/claude-opus-5.5', /Replicate.*text/i],
    ['mimo_token_plan', 'mimo-v2.5-pro', /retired.*V2.6/i],
    ['mimo_token_plan', 'mimo-v2.5', /retired.*V2.6/i],
    ['baseten', 'decision-models/baseten-elephant-9b-latest', /decision.*chat/i]
  ])('keeps an unavailable %s selection saved with a visible reason', (service, modelId, reason) => {
    const model = preset({ modelId, effectiveModelId: modelId, provider: 'anthropic',
      connection: { type: 'direct', id: `direct:${service}`, service } })
    const before = structuredClone(model)
    const availability = getModelPresetAvailability({ model, agentType: 'api', connectionOptions: [
      { id: `direct:${service}`, service, label: service, transport: 'direct', status: 'ready' }
    ] })
    expect(availability).toMatchObject({ disabled: true, disabledBecause: 'locked', reason: expect.stringMatching(reason) })
    expect(presetAvailabilityKeepsSelection(availability)).toBe(true)
    expect(model).toEqual(before)
  })

  it('keeps the same Claude model available through its supported gateway and current MiMo plan IDs eligible', () => {
    expect(getModelPresetAvailability({ model: preset({ modelId: 'anthropic/claude-opus-5.5',
      connection: { type: 'vercel-gateway', service: 'vercel', id: 'vercel-gateway' } }), agentType: 'api' }).disabled).toBe(false)
    expect(getModelPresetAvailability({ model: preset({ modelId: 'mimo-v2.6-pro', provider: 'xiaomi',
      connection: { type: 'direct', service: 'mimo_token_plan', id: 'direct:mimo_token_plan' } }), agentType: 'api',
      connectionOptions: [{ id: 'direct:mimo_token_plan', label: 'MiMo plan', transport: 'direct', status: 'locked', lockedReason: 'Plan paused' }]
    })).toMatchObject({ disabled: true, reason: 'Plan paused' })
  })

  it('retains a known decision selection after the saved-model reader repairs its purpose to Utility', () => {
    const model = preset({ modelId: 'decision-models/baseten-elephant-9b-latest', purpose: 'utility',
      connection: { type: 'direct', service: 'baseten', id: 'direct:baseten' } })
    const availability = getModelPresetAvailability({ model, agentType: 'api' })
    expect(availability).toMatchObject({ disabled: true, disabledBecause: 'locked', reason: expect.stringMatching(/decision.*chat/i) })
    expect(presetAvailabilityKeepsSelection(availability)).toBe(true)
    expect(getModelPresetAvailability({ model: preset({ purpose: 'visual', modelId: 'pixverse/pixverse-v6-max',
      connection: { type: 'direct', service: 'replicate' } }), agentType: 'api' }).disabledBecause).toBe('non_chat')
  })

  it('keeps planned speech-to-speech presets unavailable until their adapter is supported', () => {
    const availability = getModelPresetAvailability({
      model: preset({
        voiceSession: {
          runtime: 'livekit',
          mode: 'speech-to-speech',
          providerId: 'openai',
          supportStatus: 'planned'
        }
      }),
      agentType: 'api',
      connectionOptions: null
    })

    expect(availability.disabled).toBe(true)
    expect(availability.disabledBecause).toBe('voice_session')
    expect(availability.reason).toBe('LiveKit adapter planned')
  })

  it('only allows supported speech-to-speech presets on API agents', () => {
    const model = preset({
      voiceSession: {
        runtime: 'livekit',
        mode: 'speech-to-speech',
        providerId: 'openai',
        supportStatus: 'supported'
      }
    })

    expect(
      getModelPresetAvailability({
        model,
        agentType: 'api',
        connectionOptions: null
      }).disabled
    ).toBe(false)

    // SA-139 R5: every Batshit picker passes `api`; a server caller can still name another scope.
    expect(
      getModelPresetAvailability({
        model,
        agentType: 'cli',
        connectionOptions: null
      })
    ).toMatchObject({
      disabled: true,
      disabledBecause: 'voice_session',
      reason: 'Speech-to-speech: Primary Agents only'
    })
  })

  // SA-139 R5: the Claude Code CLI lane went with its Subagent type, so a saved Claude Code CLI
  // preset gets the Codex CLI treatment: it stays saved and readable, and no agent can use it,
  // whatever its connection's state.
  it.each([
    ['the claude-cli connection id', { provider: 'anthropic', modelId: 'opus', connection: { type: 'direct' as const, id: 'claude-cli', service: 'anthropic' } }],
    ['the anthropic-claude-cli connection service', { provider: 'anthropic', modelId: 'opus', connection: { type: 'direct' as const, id: 'saved-claude', service: 'anthropic-claude-cli' } }],
    ['the anthropic-claude-cli provider', { provider: 'anthropic-claude-cli', modelId: 'opus', connection: { type: 'direct' as const, id: 'direct:anthropic', service: 'anthropic' } }],
    ['the claude-cli model id', { provider: 'anthropic', modelId: 'claude-cli', connection: { type: 'direct' as const, id: 'direct:anthropic', service: 'anthropic' } }]
  ])('disables a saved Claude Code CLI preset named by %s for every agent type, with the removal message', (_label, fields) => {
    const claudeOption: CatalogConnectionOption = {
      id: 'claude-cli',
      label: 'Claude Code CLI (Pro/Max)',
      transport: 'direct',
      service: 'anthropic-claude-cli',
      providers: ['anthropic-claude-cli'],
      status: 'locked',
      lockedReason: 'Claude Code CLI is installed but not logged in.',
      setupCommand: 'claude auth login'
    }
    const model = preset({ modelName: 'Claude Code CLI', effectiveModelId: fields.modelId, ...fields })
    const before = structuredClone(model)
    for (const agentType of ['api', 'cli'] as const) {
      for (const connectionOptions of [null, [claudeOption], [{ ...claudeOption, status: 'ready' as const }]]) {
        const availability = getModelPresetAvailability({ model, agentType, connectionOptions })
        expect(availability).toMatchObject({
          disabled: true,
          disabledBecause: 'incompatible',
          reason: 'This preset can no longer be used'
        })
        expect(presetAvailabilityKeepsSelection(availability)).toBe(false)
      }
    }
    expect(model).toEqual(before)
  })

  // SA-139 R1: the retired Codex CLI is named by provider or connection ids only.
  it.each([
    ['the codex-cli connection', { provider: 'openai', connection: { type: 'direct' as const, id: 'codex-cli', service: 'openai' } }],
    ['the openai-codex provider', { provider: 'openai-codex', connection: { type: 'direct' as const, id: 'direct:openai', service: 'openai' } }],
    ['the openai-codex connection service', { provider: 'openai', connection: { type: 'direct' as const, id: 'saved-codex', service: 'openai-codex' } }]
  ])('disables a saved Codex CLI preset named by %s for every agent type, with the removal message', (_label, fields) => {
    const model = preset({ modelName: 'Codex CLI', modelId: 'gpt-6.1-sol', effectiveModelId: 'gpt-6.1-sol', ...fields })
    const before = structuredClone(model)
    for (const agentType of ['cli', 'api'] as const) {
      expect(getModelPresetAvailability({ model, agentType, connectionOptions: null })).toMatchObject({
        disabled: true,
        disabledBecause: 'incompatible',
        reason: 'This preset can no longer be used'
      })
    }
    expect(model).toEqual(before)
  })

  it('keeps an API preset whose OpenAI model id contains "codex" enabled for API agents', () => {
    const openaiOption: CatalogConnectionOption = {
      id: 'direct:openai',
      label: 'OpenAI',
      transport: 'direct',
      service: 'openai',
      providers: ['openai'],
      status: 'ready'
    }
    const model = preset({
      modelName: 'GPT-5 Codex',
      modelId: 'gpt-5-codex',
      effectiveModelId: 'gpt-5-codex',
      provider: 'openai',
      connection: { type: 'direct', id: 'direct:openai', service: 'openai' }
    })

    expect(getModelPresetAvailability({ model, agentType: 'api', connectionOptions: [openaiOption] })).toEqual({
      disabled: false,
      disabledBecause: null,
      reason: null,
      connectionOption: openaiOption
    })
  })

  it('still blocks ordinary locked direct providers', () => {
    const availability = getModelPresetAvailability({
      model: preset({
        modelName: 'GPT 5.4',
        modelId: 'gpt-5.4',
        provider: 'openai',
        connection: {
          type: 'direct',
          id: 'direct:openai',
          service: 'openai'
        }
      }),
      agentType: 'api',
      connectionOptions: [
        {
          id: 'direct:openai',
          label: 'OpenAI',
          transport: 'direct',
          service: 'openai',
          providers: ['openai'],
          status: 'locked',
          lockedReason: 'Add an OpenAI API key.'
        }
      ]
    })

    expect(availability).toMatchObject({
      disabled: true,
      disabledBecause: 'locked',
      reason: 'Add an OpenAI API key.'
    })
  })
})

describe('BL-517: a preset whose connection no longer lists its model', () => {
  const unlisted = preset({
    modelName: 'Old GPT',
    modelId: 'gpt-4.1-old',
    connection: { type: 'vercel-gateway', service: 'vercel' },
    isVercelImport: true,
    unavailableReason: 'Vercel AI Gateway no longer lists this model'
  })

  it('is unavailable with the reason the list load gave, in the pickers existing unavailable state', () => {
    const availability = getModelPresetAvailability({ model: unlisted, agentType: 'api', connectionOptions: null })
    expect(availability).toMatchObject({
      disabled: true,
      disabledBecause: 'unlisted',
      reason: 'Vercel AI Gateway no longer lists this model'
    })
  })

  // SA-139 R5: the wrong-type case is now a removed preset (a saved Claude Code CLI one); the
  // `cli` picker scope that refused API presets went with the Claude Code CLI Subagent.
  const unlistedRemoved = preset({
    ...unlisted,
    provider: 'anthropic-claude-cli',
    connection: { type: 'direct', id: 'claude-cli', service: 'anthropic-claude-cli' }
  })

  it('still reads as the wrong type first when the preset was removed', () => {
    const availability = getModelPresetAvailability({ model: unlistedRemoved, agentType: 'api', connectionOptions: null })
    expect(availability.disabledBecause).toBe('incompatible')
  })

  it('keeps an agent\'s saved selection (never cleared by opening Settings), like a locked connection', () => {
    const unlistedAvailability = getModelPresetAvailability({ model: unlisted, agentType: 'api', connectionOptions: null })
    expect(presetAvailabilityKeepsSelection(unlistedAvailability)).toBe(true)
    expect(
      presetAvailabilityKeepsSelection({ disabled: true, disabledBecause: 'locked', reason: 'Missing API key', connectionOption: null })
    ).toBe(true)
    expect(
      presetAvailabilityKeepsSelection(getModelPresetAvailability({ model: unlistedRemoved, agentType: 'api', connectionOptions: null }))
    ).toBe(false)
    expect(
      presetAvailabilityKeepsSelection(
        getModelPresetAvailability({ model: preset({ purpose: 'visual', modelId: 'gpt-image-2' }), agentType: 'api', connectionOptions: null })
      )
    ).toBe(false)
    expect(
      presetAvailabilityKeepsSelection(getModelPresetAvailability({ model: preset({ modelId: 'gpt-5.5' }), agentType: 'api', connectionOptions: null }))
    ).toBe(true)
  })
})

describe('BL-517: Agent Settings keeps an unlisted preset selected when it opens', () => {
  const panel = readFileSync('src/lib/components/settings/panels/AgentSettingsPanel.svelte', 'utf8')

  it('the primary and Subagent selection updates show a selection only when the shared rule says so', () => {
    // Pinned from the line start, so a `false &&` or a return to the old `!== "locked"` test breaks it.
    // BL-514: the primary's selection is display only; the form keeps the saved model (and
    // opening saves nothing), so both of its selection updates ask the shared rule.
    expect(panel).toContain(
      '\n    return presetAvailabilityKeepsSelection(\n      getModelPresetAvailability({\n        model,\n        agentType: getPrimaryToolHostScope(),'
    )
    expect(panel).toContain('\n    selectedModelId = match && agentPresetShowsAsSelected(match) ? match.id : null;\n')
    expect(panel).toContain('\n    const nextId = match && agentPresetShowsAsSelected(match) ? match.id : null;\n')
    // BL-834: the Subagent's selection is display only too. Its sync used to clear the Subagent's
    // model when the preset could not be selected, and the autosave then saved the empty model.
    expect(panel).toContain(
      '\n    return presetAvailabilityKeepsSelection(\n      getModelPresetAvailability({\n        model,\n        agentType: getSubagentToolHostScope(),'
    )
    expect(panel).toContain('\n    selectedSubagentModelId = match && subagentPresetShowsAsSelected(match) ? match.id : null;\n')
    expect(panel).toContain('\n    const nextId = match && subagentPresetShowsAsSelected(match) ? match.id : null;\n')
    const subagentSync = panel.slice(
      panel.indexOf('  function syncSelectedModelFromSubagent() {'),
      panel.indexOf('  function subagentPresetShowsAsSelected(')
    )
    expect(subagentSync).toContain('selectedSubagentModelId = match && subagentPresetShowsAsSelected(match)')
    expect(subagentSync).not.toContain('clearSubagentModelSelection')
    expect(panel).not.toContain('availability.disabledBecause !== "locked"')
  })
})
