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
  getRecentMessages: vi.fn(),
  generateMessageId: vi.fn(),
  exists: vi.fn(),
  advanceZipCountdowns: vi.fn(),
  publishUserEvent: vi.fn()
}))

vi.mock('$lib/server/services/zipHolds', () => ({
  advanceZipCountdowns: mocks.advanceZipCountdowns
}))

vi.mock('$lib/server/ssePublisher', () => ({
  publishUserEvent: mocks.publishUserEvent
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
    getMessages: mocks.getMessages,
    getRecentMessages: mocks.getRecentMessages,
    exists: mocks.exists
  }
}))

vi.mock('$lib/utils/messageId', () => ({
  generateMessageId: mocks.generateMessageId
}))

import { POST } from './+server'
import {
  __resetDeletedMessagesForTests,
  noteMessageDeleted
} from '$lib/server/services/deletedMessageRegistry'

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
    __resetDeletedMessagesForTests()
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
    mocks.getRecentMessages.mockResolvedValue([
      {
        id: 'msg-1',
        role: 'user',
        content: 'Hello'
      }
    ])
    mocks.generateMessageId.mockResolvedValue('msg-livekit-1')
    mocks.exists.mockResolvedValue(false)
    mocks.advanceZipCountdowns.mockResolvedValue({ counted: [], ended: [] })
    mocks.publishUserEvent.mockResolvedValue(undefined)
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

  // SA-129 P2b (BL-356, Faye's decision 2026-09-27): a realtime voice turn counts toward every
  // "Hold for N messages" like a typed one: one count for the user's words, one for the reply.
  describe('the hold countdown (BL-356)', () => {
    for (const [kind, role] of [
      ['speech_to_speech_user_transcript', 'user'],
      ['speech_to_speech_assistant_message', 'assistant']
    ] as const) {
      it(`counts a new speech-to-speech ${role} message once, and tells the tabs when a hold changed`, async () => {
        mocks.advanceZipCountdowns.mockResolvedValue({ counted: ['zip_temp'], ended: [] })
        const response = await POST({
          request: buildRequest(buildPayload({ kind, transcript: 'Words.', messageId: 'msg_20260927-050000_0007' })),
          fetch: buildEventFetch()
        } as any)
        expect(response.status).toBe(200)
        expect(mocks.advanceZipCountdowns).toHaveBeenCalledTimes(1)
        expect(mocks.advanceZipCountdowns).toHaveBeenCalledWith('session-1')
        expect(mocks.publishUserEvent).toHaveBeenCalledWith('user-1', expect.objectContaining({ type: 'zip_state_changed', sessionId: 'session-1', source: 'countdown' }))
      })
    }

    it('never counts a message it already saved (a repeated post of the same id)', async () => {
      mocks.exists.mockResolvedValue(true)
      await POST({
        request: buildRequest(buildPayload({ kind: 'speech_to_speech_user_transcript', transcript: 'Again, longer.', messageId: 'msg_20260927-050000_0007' })),
        fetch: buildEventFetch()
      } as any)
      expect(mocks.saveMessage).toHaveBeenCalledTimes(1)
      expect(mocks.advanceZipCountdowns).not.toHaveBeenCalled()
    })

    it('tells no tab when nothing counted', async () => {
      await POST({
        request: buildRequest(buildPayload({ kind: 'speech_to_speech_user_transcript', transcript: 'Hi.' })),
        fetch: buildEventFetch()
      } as any)
      expect(mocks.advanceZipCountdowns).toHaveBeenCalledTimes(1)
      expect(mocks.publishUserEvent).not.toHaveBeenCalled()
    })

    it('leaves the bridge turn to send-routed, which counts it (no second count here)', async () => {
      await POST({ request: buildRequest(buildPayload({ transcript: 'Typed by voice.' })), fetch: buildEventFetch() } as any)
      expect(mocks.advanceZipCountdowns).not.toHaveBeenCalled()
    })
  })

  /**
   * BL-776: the route saves a voice reply itself, and `saveMessage` puts a missing id back on the
   * chat's list. So it writes a reply only when the reply is not stored yet, and it refuses an id
   * the user deleted, which a late post would otherwise bring back. The user's own transcript keeps
   * updating under its id (the sidecar sends a longer one each time), unless it was deleted.
   */
  describe('a stored or deleted message (BL-776)', () => {
    it('does not write a voice reply that is already stored', async () => {
      mocks.exists.mockResolvedValue(true)
      const eventFetch = buildEventFetch()
      const response = await POST({
        request: buildRequest(buildPayload({ kind: 'speech_to_speech_assistant_message', transcript: 'Again.', messageId: 'msg_20260928-050000_0001' })),
        fetch: eventFetch
      } as any)
      expect(response.status).toBe(200)
      expect(mocks.saveMessage).not.toHaveBeenCalled()
      expect(mocks.advanceZipCountdowns).not.toHaveBeenCalled()
    })

    for (const [kind, role] of [
      ['speech_to_speech_user_transcript', 'user'],
      ['speech_to_speech_assistant_message', 'assistant']
    ] as const) {
      it(`refuses ${role === 'user' ? 'a user' : 'an assistant'} message the user deleted, and tells no tab`, async () => {
        noteMessageDeleted('session-1', 'msg_20260928-050000_0002')
        const eventFetch = buildEventFetch()
        const response = await POST({
          request: buildRequest(buildPayload({ kind, transcript: 'Late words.', messageId: 'msg_20260928-050000_0002' })),
          fetch: eventFetch
        } as any)
        expect(response.status).toBe(409)
        await expect(response.json()).resolves.toMatchObject({ success: false, code: 'message_deleted' })
        expect(mocks.saveMessage).not.toHaveBeenCalled()
        expect(mocks.advanceZipCountdowns).not.toHaveBeenCalled()
        expect(eventFetch).not.toHaveBeenCalled()
      })
    }

    it('still saves a message of another chat with the same id', async () => {
      noteMessageDeleted('session-other', 'msg_20260928-050000_0003')
      const response = await POST({
        request: buildRequest(buildPayload({ kind: 'speech_to_speech_user_transcript', transcript: 'Hi.', messageId: 'msg_20260928-050000_0003' })),
        fetch: buildEventFetch()
      } as any)
      expect(response.status).toBe(200)
      expect(mocks.saveMessage).toHaveBeenCalledTimes(1)
    })
  })
})
