import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  retrieve: vi.fn(),
  getAgents: vi.fn(),
  getMessages: vi.fn(),
  getUserSettings: vi.fn(),
  buildFormattedChatInput: vi.fn()
}))

vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: {
    retrieve: mocks.retrieve
  }
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    getAgents: mocks.getAgents,
    getMessages: mocks.getMessages,
    getUserSettings: mocks.getUserSettings,
    json: {
      get: vi.fn()
    }
  }
}))

vi.mock('$lib/services/databaseRedis.server', () => ({
  databaseService: {
    buildFormattedChatInput: mocks.buildFormattedChatInput
  }
}))

import { createLiveKitVoiceSession } from '$lib/server/services/liveKitVoiceRuntime'

const liveKitTestOptions = {
  env: {
    LIVEKIT_URL: 'ws://localhost:7880',
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'secret'
  },
  tokenFactory: vi.fn(async () => 'jwt-token'),
  dispatchFactory: vi.fn(async () => ({ id: 'dispatch-1' }))
}

function createSpeechToSpeechRequest(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-1',
    agentId: 'agent-1',
    participantName: 'Josh',
    speechToSpeech: {
      enabled: true,
      providerId: 'grok',
      providerLabel: 'Grok Voice',
      adapterId: 'livekit-xai-grok-voice',
      modelId: 'grok-voice-think-fast-1.0',
      voiceId: 'ara'
    },
    agentDispatch: {
      enabled: true,
      required: true,
      agentName: 'batshit-livekit-agent'
    },
    ...overrides
  }
}

describe('createLiveKitVoiceSession speech-to-speech', () => {
  beforeEach(() => {
    mocks.retrieve.mockReset()
    mocks.getAgents.mockReset()
    mocks.getMessages.mockReset()
    mocks.getUserSettings.mockReset()
    mocks.buildFormattedChatInput.mockReset()
    liveKitTestOptions.tokenFactory.mockClear()
    liveKitTestOptions.dispatchFactory.mockClear()
    mocks.retrieve.mockResolvedValue('saved-xai-key')
    mocks.getMessages.mockResolvedValue([])
    mocks.getUserSettings.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('adds speech-to-speech provider metadata to room tokens and agent dispatch', async () => {
    mocks.retrieve.mockImplementation(async (service: string) => {
      if (service === 'livekit_url') return null
      if (service === 'livekit_api_key') return null
      if (service === 'livekit_api_secret') return null
      if (service === 'xai') return 'saved-xai-key'
      return null
    })
    mocks.getAgents.mockResolvedValue([
      {
        id: 'agent-1',
        user_id: 'user-1',
        displayName: 'Luna',
        agentType: 'api',
        system_prompt: 'You are Luna.'
      }
    ])
    mocks.getMessages.mockResolvedValue([
      {
        id: 'existing-user-message',
        role: 'user',
        content: 'Earlier chat context'
      }
    ])
    mocks.getUserSettings.mockResolvedValue({
      goons_settings: {
        dockOpen: true
      }
    })
    mocks.buildFormattedChatInput.mockResolvedValue({
      primarySystemPrompt: [
        '==== API PRIMARY SYSTEM PROMPT ====',
        'API Primary Agent base instructions with clips and Dynamic MCP.',
        '',
        '==== GLOBAL CUSTOM SYSTEM PROMPT ====',
        'Global Batshit custom prompt.',
        '',
        '==== USER SYSTEM PROMPT ====',
        'You are Luna.'
      ].join('\n'),
      structuredInput: {
        messages: [
          {
            role: 'user',
            content: [
              '==== PREVIOUS CONVERSATION ====',
              'User: Earlier chat context',
              '',
              '==== CURRENT USER MESSAGE ====',
              'LiveKit true speech-to-speech voice session started.',
              '',
              '==== DYNAMIC CURRENT MESSAGE ====',
              'Goon Dock is available.'
            ].join('\n')
          }
        ]
      }
    })

    let tokenInput: any
    let dispatchInput: any
    const session = await createLiveKitVoiceSession(
      'user-1',
      {
        sessionId: 'session-1',
        agentId: 'agent-1',
        participantName: 'Josh',
        metadata: {
          goonsEnabled: true,
          goonPresentationMode: 'desktop'
        },
        speechToSpeech: {
          enabled: true,
          providerId: 'grok',
          providerLabel: 'Grok Voice',
          adapterId: 'livekit-xai-grok-voice',
          modelId: 'grok-voice-think-fast-1.0',
          voiceId: 'ara'
        },
        agentDispatch: {
          enabled: true,
          required: true,
          agentName: 'batshit-livekit-agent',
          metadata: {
            surface: 'chat-input',
            mode: 'client-value-that-must-not-win'
          }
        }
      },
      {
        env: {
          LIVEKIT_URL: 'ws://localhost:7880',
          LIVEKIT_API_KEY: 'devkey',
          LIVEKIT_API_SECRET: 'secret'
        },
        now: new Date('2026-05-18T12:00:00.000Z'),
        nonce: 'nonce-1',
        tokenFactory: async (input) => {
          tokenInput = input
          return 'jwt-token'
        },
        dispatchFactory: async (input) => {
          dispatchInput = input
          return { id: 'dispatch-1' }
        }
      }
    )

    expect(session.agentDispatch).toMatchObject({
      requested: true,
      required: true,
      agentName: 'batshit-livekit-agent',
      dispatchId: 'dispatch-1'
    })

    expect(JSON.parse(tokenInput.metadata)).toMatchObject({
      mode: 'speech-to-speech',
      providerId: 'xai',
      modelId: 'grok-voice-think-fast-1.0',
      voiceId: 'ara',
      sessionId: 'session-1',
      agentId: 'agent-1'
    })
    const dispatchMetadata = JSON.parse(dispatchInput.metadata)
    expect(dispatchMetadata).toMatchObject({
      mode: 'speech-to-speech',
      providerId: 'xai',
      providerLabel: 'Grok Voice',
      adapterId: 'livekit-xai-grok-voice',
      modelId: 'grok-voice-think-fast-1.0',
      voiceId: 'ara',
      instructions: expect.stringContaining('==== API PRIMARY SYSTEM PROMPT ===='),
      surface: 'chat-input'
    })
    expect(dispatchMetadata.instructions).toContain('==== GLOBAL CUSTOM SYSTEM PROMPT ====')
    expect(dispatchMetadata.instructions).toContain('You are Luna.')
    expect(dispatchMetadata.instructions).toContain(
      '==== BATSHIT LIVE SESSION DYNAMIC CONTEXT SNAPSHOT ===='
    )
    expect(dispatchMetadata.instructions).toContain('Goon Dock is available.')
    expect(dispatchMetadata.instructions).toContain('Do not default to a corporate support-agent')
    expect(dispatchMetadata.instructions).toContain('==== GROK VOICE GOON CUE COMPATIBILITY ====')
    expect(dispatchMetadata.instructions).toContain('goon_emote function/tool')
    expect(dispatchMetadata.instructions).toContain('call goon_emote with name="smile"')
    expect(dispatchMetadata.instructions).toContain('<emote-wink>.</emote-wink>')
    expect(dispatchMetadata.instructions).toContain(
      'in Emoji triggers they are the value after the equals sign'
    )
    expect(dispatchMetadata.instructions).toContain(
      'markdown-style asterisk cues'
    )
    expect(mocks.retrieve).toHaveBeenCalledWith('xai', 'user-1')
    expect(mocks.buildFormattedChatInput).toHaveBeenCalledWith(
      'session-1',
      expect.arrayContaining([expect.objectContaining({ id: 'existing-user-message' })]),
      expect.objectContaining({ id: 'agent-1', agentType: 'api' }),
      expect.stringContaining('LiveKit true speech-to-speech voice session started.'),
      [],
      'user-1',
      expect.objectContaining({
        runtimeFlavor: 'vercel',
        voiceState: expect.objectContaining({
          voiceMode: 'speech-to-speech',
          provider: 'livekit'
        }),
        goonsEnabled: true,
        goonPresentationMode: 'desktop',
        goonsSettings: expect.objectContaining({
          dockOpen: true
        })
      })
    )
  })

  it('fails speech-to-speech session creation when no selected agent is provided', async () => {
    await expect(
      createLiveKitVoiceSession(
        'user-1',
        createSpeechToSpeechRequest({ agentId: '' }),
        liveKitTestOptions
      )
    ).rejects.toThrow(
      'LiveKit speech-to-speech session could not start because no selected Batshit agent was provided for prompt compilation.'
    )
    expect(liveKitTestOptions.tokenFactory).not.toHaveBeenCalled()
    expect(liveKitTestOptions.dispatchFactory).not.toHaveBeenCalled()
  })

  it('fails speech-to-speech session creation when the selected agent cannot be loaded', async () => {
    mocks.getAgents.mockResolvedValue([])

    await expect(
      createLiveKitVoiceSession(
        'user-1',
        createSpeechToSpeechRequest(),
        liveKitTestOptions
      )
    ).rejects.toThrow(
      'LiveKit speech-to-speech session could not start because Batshit could not load the selected agent prompt.'
    )
    expect(liveKitTestOptions.tokenFactory).not.toHaveBeenCalled()
    expect(liveKitTestOptions.dispatchFactory).not.toHaveBeenCalled()
  })

  it('fails speech-to-speech session creation when prompt compilation throws', async () => {
    mocks.getAgents.mockResolvedValue([
      {
        id: 'agent-1',
        user_id: 'user-1',
        displayName: 'Luna',
        agentType: 'api'
      }
    ])
    mocks.buildFormattedChatInput.mockRejectedValue(new Error('settings unavailable'))

    await expect(
      createLiveKitVoiceSession(
        'user-1',
        createSpeechToSpeechRequest(),
        liveKitTestOptions
      )
    ).rejects.toThrow(
      'LiveKit speech-to-speech session could not start because Batshit could not compile the selected agent prompt.'
    )
    expect(liveKitTestOptions.tokenFactory).not.toHaveBeenCalled()
    expect(liveKitTestOptions.dispatchFactory).not.toHaveBeenCalled()
  })

  it('fails speech-to-speech session creation when prompt compilation returns empty instructions', async () => {
    mocks.getAgents.mockResolvedValue([
      {
        id: 'agent-1',
        user_id: 'user-1',
        displayName: 'Luna',
        agentType: 'api'
      }
    ])
    mocks.buildFormattedChatInput.mockResolvedValue({
      primarySystemPrompt: '   ',
      structuredInput: {
        messages: []
      }
    })

    await expect(
      createLiveKitVoiceSession(
        'user-1',
        createSpeechToSpeechRequest(),
        liveKitTestOptions
      )
    ).rejects.toThrow(
      'LiveKit speech-to-speech session could not start because Batshit compiled empty agent instructions.'
    )
    expect(liveKitTestOptions.tokenFactory).not.toHaveBeenCalled()
    expect(liveKitTestOptions.dispatchFactory).not.toHaveBeenCalled()
  })
})
