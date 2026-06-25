import { json, type RequestHandler } from '@sveltejs/kit'
import { apiFailure } from '$lib/server/services/apiResponses'

import {
  internalServiceHeaders,
  isTrustedInternalRequest
} from '$lib/server/services/internalRequestAuth'
import {
  abortGroupChat,
  abortStream
} from '$lib/server/services/streamAbortRegistry'
import { redis } from '$lib/server/redis'
import type { ChatMessage } from '$lib/types/database'
import { generateMessageId } from '$lib/utils/messageId'

type LiveKitTurnPayload = {
  kind?:
    | 'final_transcript'
    | 'speech_started'
    | 'speech_to_speech_user_transcript'
    | 'speech_to_speech_assistant_message'
    | 'speech_to_speech_goon_cue'
  userId?: string | null
  sessionId?: string | null
  agentId?: string | null
  transcript?: string | null
  messageId?: string | null
  roomName?: string | null
  participantIdentity?: string | null
  participantName?: string | null
  agentType?: string | null
  providerId?: string | null
  modelId?: string | null
  voiceId?: string | null
  metadata?: Record<string, unknown> | null
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function safeMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
}

function normalizeKind(value: LiveKitTurnPayload['kind']) {
  if (
    value === 'speech_started' ||
    value === 'speech_to_speech_user_transcript' ||
    value === 'speech_to_speech_assistant_message' ||
    value === 'speech_to_speech_goon_cue'
  ) {
    return value
  }
  return 'final_transcript'
}

async function forwardSse(
  eventFetch: typeof fetch,
  request: Request,
  sessionId: string,
  data: Record<string, unknown>
) {
  const response = await eventFetch(new URL('/api/sse', request.url), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...internalServiceHeaders()
    },
    body: JSON.stringify({
      sessionId,
      data
    })
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    console.warn('[voice/livekit/turn] SSE forward failed', {
      sessionId,
      status: response.status,
      body
    })
  }
}

async function createMessageId(sessionId: string): Promise<string> {
  const messageId = await generateMessageId(sessionId)
  if (!messageId) {
    throw new Error('Failed to generate message ID')
  }
  return messageId
}

function cleanTrustedMessageId(value: unknown): string | null {
  const messageId = cleanString(value)
  if (!messageId || messageId.length > 160) return null
  return /^[a-zA-Z0-9._:-]+$/.test(messageId) ? messageId : null
}

function cleanGoonCueName(value: unknown): string | null {
  const cueName = cleanString(value)
  if (!cueName || cueName.length > 80) return null
  return /^[a-zA-Z0-9 _-]+$/.test(cueName) ? cueName.replace(/\s+/g, ' ') : null
}

function buildGoonCueContent(cueName: string): string {
  return `<batshit-cue>${JSON.stringify({ goon_cue: cueName })}</batshit-cue>`
}

export const POST: RequestHandler = async ({ request, fetch: eventFetch }) => {
  if (!isTrustedInternalRequest(request)) {
    return apiFailure('Unauthorized', 401)
  }

  const payload = (await request.json().catch(() => null)) as LiveKitTurnPayload | null
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return json({ success: false, error: 'Invalid LiveKit turn payload' }, { status: 400 })
  }

  const userId = cleanString(payload.userId)
  const sessionId = cleanString(payload.sessionId)
  const agentId = cleanString(payload.agentId)
  const roomName = cleanString(payload.roomName)
  const participantIdentity = cleanString(payload.participantIdentity)
  const participantName = cleanString(payload.participantName)
  const kind = normalizeKind(payload.kind)

  if (!userId || !sessionId || !agentId) {
    return json(
      { success: false, error: 'userId, sessionId, and agentId are required' },
      { status: 400 }
    )
  }

  const session = await redis.getSession(sessionId)
  if (!session || session.user_id !== userId) {
    return json({ success: false, error: 'Session not found or unauthorized' }, { status: 404 })
  }

  const agents = await redis.getAgents(userId)
  const agent = agents.find((candidate) => candidate.id === agentId)
  if (!agent || agent.user_id !== userId) {
    return json({ success: false, error: 'Agent not found or unauthorized' }, { status: 404 })
  }

  if (kind === 'speech_started') {
    const aborted = abortStream(sessionId, 'livekit_user_speech_started')
    const abortedGroup = abortGroupChat(sessionId, 'livekit_user_speech_started')
    await forwardSse(eventFetch, request, sessionId, {
      type: 'voice_interruption',
      reason: 'livekit_user_speech_started',
      agentId,
      roomName,
      participantIdentity
    })

    return json({
      success: true,
      kind,
      interrupted: aborted.ok || abortedGroup.ok,
      messageId: aborted.messageId ?? null
    })
  }

  if (kind === 'speech_to_speech_goon_cue') {
    const metadata = safeMetadata(payload.metadata)
    const cueName =
      cleanGoonCueName(metadata.cueName) ||
      cleanGoonCueName(metadata.goonCue) ||
      cleanGoonCueName(payload.transcript)

    if (!cueName) {
      return json({ success: false, error: 'Valid Goon cue name is required' }, { status: 400 })
    }

    const messageId =
      cleanTrustedMessageId(payload.messageId) || `livekit-goon-cue-${Date.now()}`
    const providerId = cleanString(payload.providerId)
    const modelId = cleanString(payload.modelId)
    const voiceId = cleanString(payload.voiceId)
    const content = buildGoonCueContent(cueName)

    await forwardSse(eventFetch, request, sessionId, {
      type: 'voice_goon_cue',
      sessionId,
      userId,
      agentId,
      messageId,
      cueName,
      content,
      roomName,
      participantIdentity,
      participantName,
      providerId: providerId || null,
      modelId: modelId || null,
      voiceId: voiceId || null,
      metadata: {
        source: 'livekit',
        mode: 'speech-to-speech',
        cueName,
        providerId: providerId || null,
        modelId: modelId || null,
        roomName,
        ...metadata
      }
    })

    return json({
      success: true,
      kind,
      messageId,
      cueName
    })
  }

  const transcript = cleanString(payload.transcript)
  if (!transcript) {
    return json({ success: false, error: 'Transcript is required' }, { status: 400 })
  }

  const now = new Date().toISOString()
  const speechToSpeechTranscript =
    kind === 'speech_to_speech_user_transcript' ||
    kind === 'speech_to_speech_assistant_message'
  let messageId = speechToSpeechTranscript ? cleanTrustedMessageId(payload.messageId) : null
  try {
    messageId ??= await createMessageId(sessionId)
  } catch (error) {
    return json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to generate message ID' },
      { status: 500 }
    )
  }

  const providerId = cleanString(payload.providerId)
  const modelId = cleanString(payload.modelId)
  const voiceId = cleanString(payload.voiceId)

  if (speechToSpeechTranscript) {
    const role = kind === 'speech_to_speech_assistant_message' ? 'assistant' : 'user'
    const metadata = {
      stt: role === 'user',
      tts: false,
      voiceMode: 'voice',
      realtime: true,
      voiceRuntime: 'livekit',
      speechToSpeech: true,
      livekit: {
        kind,
        roomName,
        participantIdentity,
        participantName
      },
      providerId: providerId || undefined,
      modelId: modelId || undefined,
      voiceId: voiceId || undefined,
      ...safeMetadata(payload.metadata)
    }

    const message: ChatMessage = {
      id: messageId,
      session_id: sessionId,
      user_id: userId,
      agent_id: agentId,
      role,
      content: transcript,
      created_at: now,
      timestamp: now,
      metadata,
      status: 'complete'
    } as ChatMessage

    await redis.saveMessage(message)
    await forwardSse(eventFetch, request, sessionId, {
      type: role === 'assistant' ? 'complete_message' : 'user_message',
      message,
      messageId,
      userId,
      agentId,
      metadata: {
        source: 'livekit',
        mode: 'speech-to-speech',
        providerId: providerId || null,
        modelId: modelId || null,
        roomName
      }
    })

    return json({
      success: true,
      kind,
      messageId,
      role
    })
  }

  const voiceMetadata = {
    stt: true,
    tts: true,
    voiceMode: 'voice',
    realtime: true,
    voiceRuntime: 'livekit',
    livekit: {
      kind: 'final_transcript',
      roomName,
      participantIdentity,
      participantName
    },
    ...safeMetadata(payload.metadata)
  }

  const userMessage: ChatMessage = {
    id: messageId,
    session_id: sessionId,
    user_id: userId,
    agent_id: agentId,
    role: 'user',
    content: transcript,
    created_at: now,
    timestamp: now,
    metadata: voiceMetadata,
    status: 'complete'
  } as ChatMessage

  await redis.saveMessage(userMessage)
  await forwardSse(eventFetch, request, sessionId, {
    type: 'user_message',
    message: userMessage,
    metadata: {
      source: 'livekit',
      roomName
    }
  })

  const messages = await redis.getMessages(sessionId, 300)
  const routeResponse = await eventFetch(new URL('/api/messages/send-routed', request.url), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...internalServiceHeaders()
    },
    body: JSON.stringify({
      content: transcript,
      sessionId,
      agentId,
      userId,
      messageId: undefined,
      messages,
      agentType: payload.agentType ?? undefined,
      metadata: voiceMetadata,
      batshitInput: {
        metadata: voiceMetadata
      }
    })
  })

  const routed = await routeResponse.json().catch(() => null)
  if (!routeResponse.ok) {
    return json(
      {
        success: false,
        error: routed?.error ?? 'Batshit turn failed',
        details: routed?.details ?? null,
        routed
      },
      { status: routeResponse.status }
    )
  }

  return json({
    success: true,
    kind,
    userMessageId: messageId,
    routed
  })
}
