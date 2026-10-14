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

    expect(
      getModelPresetAvailability({
        model,
        agentType: 'n8n',
        connectionOptions: null
      })
    ).toMatchObject({
      disabled: true,
      disabledBecause: 'voice_session',
      reason: 'Speech-to-speech presets are for API voice agents'
    })
  })

  it('allows locked CLI presets to be selected by CLI agents while preserving setup context', () => {
    const codexOption: CatalogConnectionOption = {
      id: 'codex-cli',
      label: 'Codex CLI (GPT Plus/Pro)',
      transport: 'direct',
      service: 'openai-codex',
      providers: ['openai-codex'],
      status: 'locked',
      lockedReason: 'Codex CLI is installed but not logged in.',
      setupCommand: 'docker compose exec app codex login --device-auth'
    }

    const availability = getModelPresetAvailability({
      model: preset({
        modelName: 'Codex CLI',
        modelId: 'codex-cli',
        provider: 'openai-codex',
        connection: {
          type: 'direct',
          id: 'codex-cli',
          service: 'openai-codex'
        }
      }),
      agentType: 'cli',
      connectionOptions: [codexOption]
    })

    expect(availability.disabled).toBe(false)
    expect(availability.disabledBecause).toBeNull()
    expect(availability.reason).toBe('Codex CLI is installed but not logged in.')
    expect(availability.connectionOption).toBe(codexOption)
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

  it('still reads as the wrong type first on a CLI agent', () => {
    const availability = getModelPresetAvailability({ model: unlisted, agentType: 'cli', connectionOptions: null })
    expect(availability.disabledBecause).toBe('incompatible')
  })

  it('keeps an agent\'s saved selection (never cleared by opening Settings), like a locked connection', () => {
    const unlistedAvailability = getModelPresetAvailability({ model: unlisted, agentType: 'api', connectionOptions: null })
    expect(presetAvailabilityKeepsSelection(unlistedAvailability)).toBe(true)
    expect(
      presetAvailabilityKeepsSelection({ disabled: true, disabledBecause: 'locked', reason: 'Missing API key', connectionOption: null })
    ).toBe(true)
    expect(
      presetAvailabilityKeepsSelection(getModelPresetAvailability({ model: unlisted, agentType: 'cli', connectionOptions: null }))
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
      '\n    return presetAvailabilityKeepsSelection(\n      getModelPresetAvailability({\n        model,\n        agentType: basicForm.agentType,'
    )
    expect(panel).toContain('\n    selectedModelId = match && agentPresetShowsAsSelected(match) ? match.id : null;\n')
    expect(panel).toContain('\n    const nextId = match && agentPresetShowsAsSelected(match) ? match.id : null;\n')
    // BL-834: the Subagent's selection is display only too. Its sync used to clear the Subagent's
    // model when the preset could not be selected, and the autosave then saved the empty model.
    expect(panel).toContain(
      '\n    return presetAvailabilityKeepsSelection(\n      getModelPresetAvailability({\n        model,\n        agentType: getSubagentToolHostScope(subagentForm.subagentType),'
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
