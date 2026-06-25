import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isTrustedInternalRequest: vi.fn(),
  internalServiceHeaders: vi.fn(),
  abortStream: vi.fn(),
  abortGroupChat: vi.fn(),
  getSession: vi.fn(),
  getAgents: vi.fn(),
  saveMessage: vi.fn(),
  getMessages: vi.fn(),
  generateMessageId: vi.fn()
}))

vi.mock('$lib/server/services/internalRequestAuth', () => ({
  isTrustedInternalRequest: mocks.isTrustedInternalRequest,
  internalServiceHeaders: mocks.internalServiceHeaders
}))

vi.mock('$lib/server/services/streamAbortRegistry', () => ({
  abortStream: mocks.abortStream,
  abortGroupChat: mocks.abortGroupChat
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    getSession: mocks.getSession,
    getAgents: mocks.getAgents,
    saveMessage: mocks.saveMessage,
    getMessages: mocks.getMessages
  }
}))

vi.mock('$lib/utils/messageId', () => ({
  generateMessageId: mocks.generateMessageId
}))

import { POST } from './+server'

function buildRequest(payload: Record<string, unknown>) {
  return new Request('http://localhost/api/voice/livekit/turn', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-batshit-service-token': 'service-token'
    },
    body: JSON.stringify(payload)
  })
}

function buildPayload(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    sessionId: 'session-1',
    agentId: 'agent-1',
    roomName: 'room-1',
    participantIdentity: 'participant-1',
    participantName: 'Josh',
    ...overrides
  }
}

function buildEventFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/messages/send-routed')) {
      return new Response(JSON.stringify({ success: true, routed: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }

    return new Response(JSON.stringify({ success: true, sse: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  })
}

describe('/api/voice/livekit/turn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isTrustedInternalRequest.mockReturnValue(true)
    mocks.internalServiceHeaders.mockReturnValue({
      'x-batshit-service-token': 'service-token'
    })
    mocks.abortStream.mockReturnValue({ ok: true, messageId: 'assistant-1' })
    mocks.abortGroupChat.mockReturnValue({ ok: false })
    mocks.getSession.mockResolvedValue({
      id: 'session-1',
      user_id: 'user-1'
    })
    mocks.getAgents.mockResolvedValue([
      {
        id: 'agent-1',
        user_id: 'user-1',
        agentType: 'api',
        displayName: 'Primary'
      }
    ])
    mocks.saveMessage.mockResolvedValue(undefined)
    mocks.getMessages.mockResolvedValue([
      {
        id: 'msg-1',
        role: 'user',
        content: 'Hello'
      }
    ])
    mocks.generateMessageId.mockResolvedValue('msg-livekit-1')
  })

  it('rejects untrusted sidecar calls before loading session state', async () => {
    mocks.isTrustedInternalRequest.mockReturnValue(false)

    const response = await POST({
      request: buildRequest(buildPayload()),
      fetch: buildEventFetch()
    } as any)

    expect(response.status).toBe(401)
    expect(mocks.getSession).not.toHaveBeenCalled()
    expect(mocks.abortStream).not.toHaveBeenCalled()
  })

  it('forwards LiveKit speech-start events as Batshit interruptions', async () => {
    const eventFetch = buildEventFetch()

    const response = await POST({
      request: buildRequest(buildPayload({ kind: 'speech_started' })),
      fetch: eventFetch
    } as any)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      kind: 'speech_started',
      interrupted: true,
      messageId: 'assistant-1'
    })
    expect(mocks.abortStream).toHaveBeenCalledWith('session-1', 'livekit_user_speech_started')
    expect(mocks.abortGroupChat).toHaveBeenCalledWith(
      'session-1',
      'livekit_user_speech_started'
    )
    expect(eventFetch).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/api/sse' }),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('voice_interruption')
      })
    )
    expect(mocks.saveMessage).not.toHaveBeenCalled()
  })

  it('persists final LiveKit transcripts and routes them through the selected Batshit agent', async () => {
    const eventFetch = buildEventFetch()

    const response = await POST({
      request: buildRequest(
        buildPayload({
          kind: 'final_transcript',
          transcript: 'Can you help me test LiveKit?',
          metadata: {
            source: 'livekit-agent-sidecar',
            sidecarMode: 'batshit-bridge'
          }
        })
      ),
      fetch: eventFetch
    } as any)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      kind: 'final_transcript',
      userMessageId: 'msg-livekit-1'
    })

    expect(mocks.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'msg-livekit-1',
        session_id: 'session-1',
        user_id: 'user-1',
        agent_id: 'agent-1',
        role: 'user',
        content: 'Can you help me test LiveKit?',
        metadata: expect.objectContaining({
          stt: true,
          tts: true,
          voiceMode: 'voice',
          realtime: true,
          voiceRuntime: 'livekit',
          source: 'livekit-agent-sidecar',
          sidecarMode: 'batshit-bridge',
          livekit: expect.objectContaining({
            roomName: 'room-1',
            participantIdentity: 'participant-1',
            participantName: 'Josh'
          })
        })
      })
    )

    const sendRoutedCall = eventFetch.mock.calls.find(([input]) =>
      String(input).includes('/api/messages/send-routed')
    )
    expect(sendRoutedCall).toBeTruthy()
    expect(sendRoutedCall?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        'Content-Type': 'application/json',
        'x-batshit-service-token': 'service-token'
      })
    })
    expect(JSON.parse(String(sendRoutedCall?.[1]?.body))).toMatchObject({
      content: 'Can you help me test LiveKit?',
      sessionId: 'session-1',
      agentId: 'agent-1',
      userId: 'user-1',
      metadata: expect.objectContaining({
        voiceRuntime: 'livekit',
        realtime: true
      })
    })
  })

  it('persists speech-to-speech assistant messages without routing them back through Batshit TTS', async () => {
    const eventFetch = buildEventFetch()

    const response = await POST({
      request: buildRequest(
        buildPayload({
          kind: 'speech_to_speech_assistant_message',
          transcript: 'Hey Josh, I can hear you now.',
          providerId: 'xai',
          modelId: 'grok-voice-think-fast-1.0',
          voiceId: 'ara',
          metadata: {
            source: 'livekit-agent-sidecar',
            sidecarMode: 'speech-to-speech'
          }
        })
      ),
      fetch: eventFetch
    } as any)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      kind: 'speech_to_speech_assistant_message',
      messageId: 'msg-livekit-1',
      role: 'assistant'
    })

    expect(mocks.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'msg-livekit-1',
        role: 'assistant',
        content: 'Hey Josh, I can hear you now.',
        metadata: expect.objectContaining({
          tts: false,
          realtime: true,
          voiceRuntime: 'livekit',
          speechToSpeech: true,
          providerId: 'xai',
          modelId: 'grok-voice-think-fast-1.0',
          voiceId: 'ara',
          source: 'livekit-agent-sidecar',
          sidecarMode: 'speech-to-speech'
        })
      })
    )

    expect(eventFetch).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/api/sse' }),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('complete_message')
      })
    )
    expect(
      eventFetch.mock.calls.some(([input]) => String(input).includes('/api/messages/send-routed'))
    ).toBe(false)
  })

  it('forwards speech-to-speech Goon cues without saving chat messages', async () => {
    const eventFetch = buildEventFetch()

    const response = await POST({
      request: buildRequest(
        buildPayload({
          kind: 'speech_to_speech_goon_cue',
          messageId: 'livekit-goon-cue-1',
          transcript: 'Playful Wink',
          providerId: 'xai',
          modelId: 'grok-voice-think-fast-1.0',
          voiceId: 'ara',
          metadata: {
            source: 'livekit-function-tool',
            cueName: 'Playful Wink'
          }
        })
      ),
      fetch: eventFetch
    } as any)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      kind: 'speech_to_speech_goon_cue',
      messageId: 'livekit-goon-cue-1',
      cueName: 'Playful Wink'
    })

    expect(mocks.saveMessage).not.toHaveBeenCalled()
    expect(eventFetch).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/api/sse' }),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('voice_goon_cue')
      })
    )
    const sseCall = eventFetch.mock.calls.find(([input]) => String(input).includes('/api/sse'))
    const sseBody = JSON.parse(String(sseCall?.[1]?.body))
    expect(sseBody.data).toMatchObject({
      type: 'voice_goon_cue',
      messageId: 'livekit-goon-cue-1',
      cueName: 'Playful Wink',
      content: '<batshit-cue>{"goon_cue":"Playful Wink"}</batshit-cue>',
      providerId: 'xai',
      modelId: 'grok-voice-think-fast-1.0',
      voiceId: 'ara'
    })
    expect(
      eventFetch.mock.calls.some(([input]) => String(input).includes('/api/messages/send-routed'))
    ).toBe(false)
  })

  it('reuses sidecar supplied speech-to-speech user message ids for cumulative transcripts', async () => {
    const eventFetch = buildEventFetch()

    const response = await POST({
      request: buildRequest(
        buildPayload({
          kind: 'speech_to_speech_user_transcript',
          messageId: 'livekit-user-turn-1',
          transcript: "Yeah, I'm the dev of Batshit.",
          providerId: 'xai',
          modelId: 'grok-voice-latest',
          voiceId: 'ara',
          metadata: {
            source: 'livekit-agent-sidecar',
            sidecarMode: 'speech-to-speech',
            transcriptSequence: 1
          }
        })
      ),
      fetch: eventFetch
    } as any)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      kind: 'speech_to_speech_user_transcript',
      messageId: 'livekit-user-turn-1',
      role: 'user'
    })

    expect(mocks.generateMessageId).not.toHaveBeenCalled()
    expect(mocks.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'livekit-user-turn-1',
        role: 'user',
        content: "Yeah, I'm the dev of Batshit.",
        metadata: expect.objectContaining({
          speechToSpeech: true,
          providerId: 'xai',
          modelId: 'grok-voice-latest',
          voiceId: 'ara',
          transcriptSequence: 1
        })
      })
    )
    expect(eventFetch).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/api/sse' }),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('livekit-user-turn-1')
      })
    )
    expect(
      eventFetch.mock.calls.some(([input]) => String(input).includes('/api/messages/send-routed'))
    ).toBe(false)
  })
})
