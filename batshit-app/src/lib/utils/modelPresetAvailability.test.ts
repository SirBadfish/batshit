import { describe, expect, it } from 'vitest'
import { getModelPresetAvailability } from './modelPresetAvailability'
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
