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

import {
  createLiveKitVoiceSession,
  getLiveKitVoiceSetupHint,
  normalizeLiveKitServerUrl,
  resolveLiveKitVoiceRuntimeConfigForUser,
  resolveLiveKitVoiceRuntimeConfig,
  sanitizeLiveKitName
} from '../services/liveKitVoiceRuntime'

describe('liveKitVoiceRuntime', () => {
  beforeEach(() => {
    mocks.retrieve.mockReset()
    mocks.retrieve.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('normalizes LiveKit server URLs for browser room connections', () => {
    expect(normalizeLiveKitServerUrl('http://localhost:7880/')).toBe('ws://localhost:7880')
    expect(normalizeLiveKitServerUrl('https://voice.example.com/')).toBe('wss://voice.example.com')
    expect(normalizeLiveKitServerUrl('wss://voice.example.com/livekit/')).toBe(
      'wss://voice.example.com/livekit'
    )
  })

  it('fails loudly when LiveKit env is not configured', () => {
    expect(() => resolveLiveKitVoiceRuntimeConfig({})).toThrow('LiveKit URL not configured.')
    expect(() =>
      resolveLiveKitVoiceRuntimeConfig({
        LIVEKIT_URL: 'ws://localhost:7880'
      })
    ).toThrow('LiveKit API key and API secret are required.')
  })

  it('clamps token TTL and never invents dev credentials', () => {
    const config = resolveLiveKitVoiceRuntimeConfig({
      LIVEKIT_URL: 'ws://localhost:7880',
      LIVEKIT_API_KEY: 'devkey',
      LIVEKIT_API_SECRET: 'secret',
      LIVEKIT_TOKEN_TTL_SEC: '999999',
      LIVEKIT_VOICE_AGENT_NAME: 'Batshit LiveKit Agent',
      LIVEKIT_VOICE_AUTO_DISPATCH_AGENT: 'yes'
    })

    expect(config).toMatchObject({
      serverUrl: 'ws://localhost:7880',
      dispatchServerUrl: 'ws://localhost:7880',
      apiKey: 'devkey',
      apiSecret: 'secret',
      tokenTtlSec: 3600,
      selfHosted: true,
      agentName: 'batshit-livekit-agent',
      autoDispatchAgent: true
    })
  })

  it('prefers LiveKit credentials saved in API Keys before env fallback values', async () => {
    vi.stubEnv('LIVEKIT_URL', 'ws://env-livekit.example.com')
    vi.stubEnv('LIVEKIT_API_KEY', 'env-key')
    vi.stubEnv('LIVEKIT_API_SECRET', 'env-secret')

    mocks.retrieve.mockImplementation(async (service: string) => {
      const values: Record<string, string> = {
        livekit_url: 'https://saved-livekit.example.com',
        livekit_api_key: 'saved-key',
        livekit_api_secret: 'saved-secret'
      }
      return values[service] ?? null
    })

    const config = await resolveLiveKitVoiceRuntimeConfigForUser('user-1')

    expect(config).toMatchObject({
      serverUrl: 'wss://saved-livekit.example.com',
      dispatchServerUrl: 'wss://saved-livekit.example.com',
      apiKey: 'saved-key',
      apiSecret: 'saved-secret'
    })
  })

  it('uses a container-reachable LiveKit URL for Docker-side agent dispatch', async () => {
    const dispatchFactory = vi.fn(async () => ({
      id: 'dispatch-1'
    }))
    const session = await createLiveKitVoiceSession(
      'user-1',
      {
        agentDispatch: {
          enabled: true,
          required: true
        }
      },
      {
        env: {
          BATSHIT_CONTAINERIZED: '1',
          LIVEKIT_URL: 'ws://localhost:7880',
          LIVEKIT_INTERNAL_URL: 'ws://livekit:7880',
          LIVEKIT_API_KEY: 'devkey',
          LIVEKIT_API_SECRET: 'secret',
          LIVEKIT_VOICE_AGENT_NAME: 'batshit-livekit-agent'
        },
        tokenFactory: vi.fn(async () => 'signed-token'),
        dispatchFactory
      }
    )

    expect(session.serverUrl).toBe('ws://localhost:7880')
    expect(dispatchFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: 'ws://livekit:7880'
      })
    )
  })

  it('defaults required local dispatch to the managed Batshit LiveKit agent name', async () => {
    const dispatchFactory = vi.fn(async () => ({
      id: 'dispatch-1'
    }))
    const session = await createLiveKitVoiceSession(
      'user-1',
      {
        agentDispatch: {
          enabled: true,
          required: true
        }
      },
      {
        env: {
          LIVEKIT_URL: 'ws://localhost:7880',
          LIVEKIT_API_KEY: 'devkey',
          LIVEKIT_API_SECRET: 'secret'
        },
        tokenFactory: vi.fn(async () => 'signed-token'),
        dispatchFactory
      }
    )

    expect(dispatchFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'batshit-livekit-agent'
      })
    )
    expect(session.agentDispatch).toMatchObject({
      requested: true,
      required: true,
      agentName: 'batshit-livekit-agent',
      dispatchId: 'dispatch-1'
    })
  })

  it('sanitizes room and participant identifiers into simple LiveKit-safe names', () => {
    expect(sanitizeLiveKitName(' Session:Josh ❤️ / Room ', 'fallback')).toBe('session-josh-room')
    expect(sanitizeLiveKitName('', 'fallback')).toBe('fallback')
  })

  it('creates a Batshit-owned LiveKit room token without leaking the API secret', async () => {
    const tokenFactory = vi.fn(async () => 'signed-token')
    const session = await createLiveKitVoiceSession(
      'user-1',
      {
        sessionId: 'session:1',
        agentId: 'agent-1',
        participantName: 'Josh',
        metadata: {
          test: true,
          skipped: undefined
        }
      },
      {
        env: {
          LIVEKIT_URL: 'https://voice.example.com',
          LIVEKIT_API_KEY: 'lk-key',
          LIVEKIT_API_SECRET: 'lk-secret',
          LIVEKIT_TOKEN_TTL_SEC: '120'
        },
        now: new Date('2026-05-17T12:00:00.000Z'),
        nonce: 'nonce-1',
        tokenFactory
      }
    )

    expect(session).toMatchObject({
      runtime: 'livekit',
      transport: 'webrtc',
      mode: 'room-token',
      serverUrl: 'wss://voice.example.com',
      roomName: 'batshit-voice-session-1-nonce-1',
      participantIdentity: 'batshit-user-user-1-nonce-1',
      participantName: 'Josh',
      token: 'signed-token',
      expiresInSec: 120,
      selfHosted: true
    })
    expect(tokenFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'lk-key',
        apiSecret: 'lk-secret',
        identity: 'batshit-user-user-1-nonce-1',
        name: 'Josh',
        ttlSec: 120,
        grant: expect.objectContaining({
          roomJoin: true,
          room: 'batshit-voice-session-1-nonce-1',
          canPublish: true,
          canSubscribe: true,
          canPublishData: true
        })
      })
    )

    const tokenInput = tokenFactory.mock.calls[0][0]
    expect(tokenInput.metadata).toContain('"runtime":"livekit"')
    expect(tokenInput.metadata).not.toContain('lk-secret')
  })

  it('does not let client metadata overwrite Batshit-owned LiveKit metadata', async () => {
    const tokenFactory = vi.fn(async () => 'signed-token')
    await createLiveKitVoiceSession(
      'real-user',
      {
        sessionId: 'real-session',
        agentId: 'real-agent',
        groupId: 'real-group',
        metadata: {
          runtime: 'fake-runtime',
          transport: 'fake-transport',
          userId: 'spoofed-user',
          sessionId: 'spoofed-session',
          agentId: 'spoofed-agent',
          groupId: 'spoofed-group',
          createdAt: 'spoofed-date',
          safeCustomFlag: true
        }
      },
      {
        env: {
          LIVEKIT_URL: 'ws://localhost:7880',
          LIVEKIT_API_KEY: 'devkey',
          LIVEKIT_API_SECRET: 'secret'
        },
        now: new Date('2026-05-17T12:00:00.000Z'),
        nonce: 'nonce-1',
        tokenFactory
      }
    )

    const metadata = JSON.parse(tokenFactory.mock.calls[0][0].metadata)
    expect(metadata).toMatchObject({
      runtime: 'livekit',
      transport: 'webrtc',
      userId: 'real-user',
      sessionId: 'real-session',
      agentId: 'real-agent',
      groupId: 'real-group',
      createdAt: '2026-05-17T12:00:00.000Z',
      safeCustomFlag: true
    })
  })

  it('dispatches the configured LiveKit agent into the room when requested', async () => {
    const tokenFactory = vi.fn(async () => 'signed-token')
    const dispatchFactory = vi.fn(async () => ({
      id: 'dispatch-1'
    }))
    const session = await createLiveKitVoiceSession(
      'user-1',
      {
        sessionId: 'session-1',
        agentId: 'agent-1',
        agentDispatch: {
          enabled: true,
          required: true,
          metadata: {
            reason: 'manual-test'
          }
        }
      },
      {
        env: {
          LIVEKIT_URL: 'ws://localhost:7880',
          LIVEKIT_API_KEY: 'devkey',
          LIVEKIT_API_SECRET: 'secret',
          LIVEKIT_VOICE_AGENT_NAME: 'Batshit LiveKit Agent'
        },
        now: new Date('2026-05-18T12:00:00.000Z'),
        nonce: 'nonce-1',
        tokenFactory,
        dispatchFactory
      }
    )

    expect(dispatchFactory).toHaveBeenCalledWith({
      serverUrl: 'ws://localhost:7880',
      apiKey: 'devkey',
      apiSecret: 'secret',
      roomName: 'batshit-voice-session-1-nonce-1',
      agentName: 'batshit-livekit-agent',
      metadata: expect.any(String)
    })
    expect(session.agentDispatch).toMatchObject({
      requested: true,
      required: true,
      agentName: 'batshit-livekit-agent',
      dispatchId: 'dispatch-1'
    })

    const metadata = JSON.parse(dispatchFactory.mock.calls[0][0].metadata)
    expect(metadata).toMatchObject({
      runtime: 'livekit',
      transport: 'webrtc',
      userId: 'user-1',
      roomName: 'batshit-voice-session-1-nonce-1',
      sessionId: 'session-1',
      agentId: 'agent-1',
      createdAt: '2026-05-18T12:00:00.000Z',
      reason: 'manual-test'
    })
  })

  it('does not let agent dispatch metadata overwrite Batshit-owned dispatch fields', async () => {
    const dispatchFactory = vi.fn(async () => ({
      id: 'dispatch-1'
    }))
    await createLiveKitVoiceSession(
      'real-user',
      {
        sessionId: 'real-session',
        agentDispatch: {
          enabled: true,
          required: true,
          metadata: {
            runtime: 'fake-runtime',
            transport: 'fake-transport',
            userId: 'spoofed-user',
            roomName: 'spoofed-room',
            sessionId: 'spoofed-session',
            createdAt: 'spoofed-date',
            safeCustomFlag: true
          }
        }
      },
      {
        env: {
          LIVEKIT_URL: 'ws://localhost:7880',
          LIVEKIT_API_KEY: 'devkey',
          LIVEKIT_API_SECRET: 'secret',
          LIVEKIT_VOICE_AGENT_NAME: 'batshit-livekit-agent'
        },
        now: new Date('2026-05-18T12:00:00.000Z'),
        nonce: 'nonce-1',
        tokenFactory: vi.fn(async () => 'signed-token'),
        dispatchFactory
      }
    )

    const metadata = JSON.parse(dispatchFactory.mock.calls[0][0].metadata)
    expect(metadata).toMatchObject({
      runtime: 'livekit',
      transport: 'webrtc',
      userId: 'real-user',
      roomName: 'batshit-voice-real-session-nonce-1',
      sessionId: 'real-session',
      createdAt: '2026-05-18T12:00:00.000Z',
      safeCustomFlag: true
    })
  })

  it('fails loudly when required agent dispatch explicitly clears the agent name', async () => {
    await expect(
      createLiveKitVoiceSession(
        'user-1',
        {
          agentDispatch: {
            enabled: true,
            required: true,
            agentName: ''
          }
        },
        {
          env: {
            LIVEKIT_URL: 'ws://localhost:7880',
            LIVEKIT_API_KEY: 'devkey',
            LIVEKIT_API_SECRET: 'secret'
          },
          tokenFactory: vi.fn(async () => 'signed-token')
        }
      )
    ).rejects.toThrow('Set LIVEKIT_VOICE_AGENT_NAME or LIVEKIT_AGENT_NAME.')
  })

  it('provides a setup hint for missing required sidecar agent names', () => {
    expect(
      getLiveKitVoiceSetupHint(
        new Error('LiveKit agent dispatch requested, but no LiveKit agent name is configured.')
      )
    ).toContain('LIVEKIT_VOICE_AGENT_NAME')
  })
})
