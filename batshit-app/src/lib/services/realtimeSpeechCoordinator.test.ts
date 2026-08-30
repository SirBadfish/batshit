import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildRealtimeSpeechChunkId,
  RealtimeSpeechCoordinator,
  type RealtimeSpeechMetadata
} from '$lib/services/realtimeSpeechCoordinator'
import type { VoiceConfig } from '$lib/services/voice'
import { extractSpeakableText } from '$lib/utils/speakableText'

describe('RealtimeSpeechCoordinator', () => {
  let currentSessionId: string | null
  let dispatchGoonSpeechMessage: ReturnType<typeof vi.fn>
  let speak: ReturnType<typeof vi.fn>
  let stopAll: ReturnType<typeof vi.fn>
  let coordinator: RealtimeSpeechCoordinator

  const fishVoice: VoiceConfig = {
    provider: 'fish',
    voiceId: 'voice-1'
  }

  const batchVoice: VoiceConfig = {
    provider: 'openai',
    voiceId: 'alloy'
  }

  function createCoordinator(overrides: Partial<ConstructorParameters<typeof RealtimeSpeechCoordinator>[0]> = {}) {
    dispatchGoonSpeechMessage = vi.fn()
    speak = vi.fn()
    stopAll = vi.fn()
    coordinator = new RealtimeSpeechCoordinator({
      latencyFlushMs: 25,
      forceMinSpeakableChars: 32,
      getCurrentSessionId: () => currentSessionId,
      isSpeechRequested: (metadata) => Boolean(metadata?.tts),
      resolveVoiceConfig: (metadata: RealtimeSpeechMetadata) =>
        metadata.provider === 'openai' ? batchVoice : fishVoice,
      usesRealtimeTts: (voice?: VoiceConfig) => voice?.provider === 'fish',
      willSpeakText: (text) => text.trim().length > 0,
      speak,
      dispatchGoonSpeechMessage,
      stopAll,
      ...overrides
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    currentSessionId = 'session-1'
    createCoordinator()
  })

  afterEach(() => {
    coordinator.cancel()
    vi.useRealTimers()
  })

  it('builds stable chunk ids under the final message id', () => {
    expect(buildRealtimeSpeechChunkId('message-1', 3)).toBe('message-1:realtime-tts:3')
  })

  it('speaks stable realtime chunks with the correct message, agent, and voice', () => {
    coordinator.append('message-1', 'agent-1', { tts: true }, 'First sentence is ready. ')

    expect(dispatchGoonSpeechMessage).toHaveBeenCalledWith(
      'message-1:realtime-tts:0',
      'agent-1',
      'First sentence is ready.',
      true
    )
    expect(speak).toHaveBeenCalledWith('First sentence is ready.', {
      voice: fishVoice,
      agentId: 'agent-1',
      messageId: 'message-1:realtime-tts:0',
      manual: true
    })
  })

  it('keeps separate agent speaker routing for interleaved messages', async () => {
    coordinator.append('message-a', 'agent-a', { tts: true }, 'Agent A is ready. ')
    coordinator.append('message-b', 'agent-b', { tts: true }, 'Agent B is ready. ')

    await expect(coordinator.finish('message-a', 'agent-a', { tts: true })).resolves.toBe(true)
    await expect(coordinator.finish('message-b', 'agent-b', { tts: true })).resolves.toBe(true)

    expect(speak).toHaveBeenNthCalledWith(1, 'Agent A is ready.', {
      voice: fishVoice,
      agentId: 'agent-a',
      messageId: 'message-a:realtime-tts:0',
      manual: true
    })
    expect(speak).toHaveBeenNthCalledWith(2, 'Agent B is ready.', {
      voice: fishVoice,
      agentId: 'agent-b',
      messageId: 'message-b:realtime-tts:0',
      manual: true
    })
  })

  it('force-flushes stable buffered text after the latency timer', () => {
    coordinator.append(
      'message-1',
      'agent-1',
      { tts: true },
      'This buffered realtime clause is stable enough to speak before punctuation'
    )

    expect(speak).not.toHaveBeenCalled()
    vi.advanceTimersByTime(25)

    expect(speak).toHaveBeenCalledWith(
      'This buffered realtime clause is stable enough to speak before punctuation',
      expect.objectContaining({
        messageId: 'message-1:realtime-tts:0',
        agentId: 'agent-1'
      })
    )
  })

  it('does not speak stale buffered text after the user switches sessions', () => {
    coordinator.append(
      'message-1',
      'agent-1',
      { tts: true },
      'This buffered realtime clause is stable enough to speak before punctuation'
    )
    currentSessionId = 'session-2'

    vi.advanceTimersByTime(25)

    expect(speak).not.toHaveBeenCalled()
    expect(coordinator.size).toBe(0)
  })

  it('returns false and cancels stale sessions at finalization', async () => {
    coordinator.append('message-1', 'agent-1', { tts: true }, 'Final text waits')
    currentSessionId = 'session-2'

    await expect(coordinator.finish('message-1', 'agent-1', { tts: true })).resolves.toBe(false)

    expect(speak).not.toHaveBeenCalled()
    expect(coordinator.size).toBe(0)
  })

  it('does not claim realtime handling for non-realtime voice configs', async () => {
    coordinator.append('message-1', 'agent-1', { tts: true, provider: 'openai' }, 'Batch only. ')

    await expect(
      coordinator.finish('message-1', 'agent-1', { tts: true, provider: 'openai' })
    ).resolves.toBe(false)
    expect(speak).not.toHaveBeenCalled()
  })

  it('cancels pending text and stops playback through the shared stop path', () => {
    coordinator.append('message-1', 'agent-1', { tts: true }, 'Waiting on realtime text')

    coordinator.stopPlayback('message-1')
    vi.advanceTimersByTime(25)

    expect(speak).not.toHaveBeenCalled()
    expect(stopAll).toHaveBeenCalled()
    expect(coordinator.size).toBe(0)
  })

  it('does not speak Tool Results Summary tails during realtime TTS', async () => {
    coordinator.append(
      'message-1',
      'agent-1',
      { tts: true },
      [
        'Here is the useful answer.',
        '',
        'Tool Results Summary',
        'voice_test: This note should stay visible, not spoken.'
      ].join('\n')
    )

    await expect(coordinator.finish('message-1', 'agent-1', { tts: true })).resolves.toBe(true)

    expect(speak).toHaveBeenCalledTimes(1)
    expect(speak).toHaveBeenCalledWith('Here is the useful answer.', {
      voice: fishVoice,
      agentId: 'agent-1',
      messageId: 'message-1:realtime-tts:0',
      manual: true
    })
  })

  it('does not speak batshit zip-control payloads during realtime TTS', async () => {
    coordinator.append(
      'message-1',
      'agent-1',
      { tts: true },
      'Normal reply before notes. <batshit-zip-control>{"toolResultsSummary":[{"toolName":"voice_test","summary":"Visible UI note, not spoken"}]}</batshit-zip-control>'
    )

    await expect(coordinator.finish('message-1', 'agent-1', { tts: true })).resolves.toBe(true)

    expect(speak).toHaveBeenCalledTimes(1)
    expect(speak).toHaveBeenCalledWith('Normal reply before notes.', {
      voice: fishVoice,
      agentId: 'agent-1',
      messageId: 'message-1:realtime-tts:0',
      manual: true
    })
  })

  it('does not speak tool-notes payloads during realtime TTS (SA-104 P1 tag)', async () => {
    coordinator.append(
      'message-1',
      'agent-1',
      { tts: true },
      'Reply before notes. <batshit-tool-notes>{"notes":[{"toolName":"voice_test","summary":"Visible UI note, not spoken"}]}</batshit-tool-notes>'
    )

    await expect(coordinator.finish('message-1', 'agent-1', { tts: true })).resolves.toBe(true)

    expect(speak).toHaveBeenCalledTimes(1)
    expect(speak).toHaveBeenCalledWith('Reply before notes.', {
      voice: fishVoice,
      agentId: 'agent-1',
      messageId: 'message-1:realtime-tts:0',
      manual: true
    })
  })

  it('withholds a tool-notes block split across streaming chunks', async () => {
    coordinator.append('message-1', 'agent-1', { tts: true }, 'Spoken part. <batshit-tool-no')
    coordinator.append(
      'message-1',
      'agent-1',
      { tts: true },
      'tes>{"notes":[{"summary":"chunk-split note"}]}</batshit-tool-notes> After.'
    )

    await expect(coordinator.finish('message-1', 'agent-1', { tts: true })).resolves.toBe(true)

    const spokenTexts = speak.mock.calls.map((call) => call[0] as string)
    expect(spokenTexts.join(' ')).not.toContain('chunk-split note')
    expect(spokenTexts.join(' ')).toContain('Spoken part.')
    expect(spokenTexts.join(' ')).toContain('After.')
  })

  it('does not speak an inline memory save, including chunk-split delivery (SA-104 P3 tag)', async () => {
    coordinator.append('message-1', 'agent-1', { tts: true }, 'I will remember that. <batshit-mem')
    coordinator.append(
      'message-1',
      'agent-1',
      { tts: true },
      'ory>{"lane":"ltm","content":"spoken-leak canary fact"}</batshit-memory> Anything else?'
    )

    await expect(coordinator.finish('message-1', 'agent-1', { tts: true })).resolves.toBe(true)

    const spokenTexts = speak.mock.calls.map((call) => call[0] as string)
    expect(spokenTexts.join(' ')).not.toContain('spoken-leak canary fact')
    expect(spokenTexts.join(' ')).toContain('I will remember that.')
    expect(spokenTexts.join(' ')).toContain('Anything else?')
  })

  it('does not speak group or cue control payloads during realtime TTS', async () => {
    coordinator.append(
      'message-1',
      'agent-1',
      { tts: true },
      [
        '<batshit-group>{"mode":"responding"}</batshit-group>',
        '<batshit-cue>{"goon_mood":"joy"}</batshit-cue>',
        'Normal spoken reply.'
      ].join('\n')
    )

    await expect(coordinator.finish('message-1', 'agent-1', { tts: true })).resolves.toBe(true)

    expect(speak).toHaveBeenCalledTimes(1)
    expect(speak).toHaveBeenCalledWith('Normal spoken reply.', {
      voice: fishVoice,
      agentId: 'agent-1',
      messageId: 'message-1:realtime-tts:0',
      manual: true
    })
  })

  it('does not schedule realtime TTS for all-italic narration when italics are silent', async () => {
    createCoordinator({
      resolveSpeakableTextOptions: () => ({ italicBehavior: 'silent' }),
      willSpeakText: (text) =>
        extractSpeakableText(text, { italicBehavior: 'silent' }).trim().length > 0
    })

    coordinator.append('message-1', 'agent-1', { tts: true }, '*She looks away.*')

    await expect(coordinator.finish('message-1', 'agent-1', { tts: true })).resolves.toBe(false)

    expect(dispatchGoonSpeechMessage).not.toHaveBeenCalled()
    expect(speak).not.toHaveBeenCalled()
  })

  it('keeps silent italic narration visible while routing the spoken part to realtime TTS', async () => {
    createCoordinator({
      resolveSpeakableTextOptions: () => ({ italicBehavior: 'silent' }),
      willSpeakText: (text) =>
        extractSpeakableText(text, { italicBehavior: 'silent' }).trim().length > 0
    })

    coordinator.append('message-1', 'agent-1', { tts: true }, '*She looks away.* Hello there. ')

    expect(dispatchGoonSpeechMessage).toHaveBeenCalledWith(
      'message-1:realtime-tts:0',
      'agent-1',
      '*She looks away.* Hello there.',
      true
    )
    expect(speak).toHaveBeenCalledWith('*She looks away.* Hello there.', {
      voice: fishVoice,
      agentId: 'agent-1',
      messageId: 'message-1:realtime-tts:0',
      manual: true
    })
  })

  it('passes the agent id to realtime speech policy checks', () => {
    const willSpeakText = vi.fn(() => false)
    createCoordinator({ willSpeakText })

    coordinator.append('message-1', 'agent-1', { tts: true }, 'First sentence is ready. ')

    expect(willSpeakText).toHaveBeenCalledWith('First sentence is ready.', {
      manual: true,
      agentId: 'agent-1'
    })
    expect(speak).not.toHaveBeenCalled()
  })

  it('keeps mid-message cue controls available to the Goon Dock while speaking clean text', () => {
    coordinator.append('message-1', 'agent-1', { tts: true }, 'First sentence is ready. ')
    coordinator.append(
      'message-1',
      'agent-1',
      { tts: true },
      '<batshit-cue>{"goon_mood":"joy"}</batshit-cue> Second sentence is ready. '
    )

    expect(dispatchGoonSpeechMessage).toHaveBeenNthCalledWith(
      1,
      'message-1:realtime-tts:0',
      'agent-1',
      'First sentence is ready.',
      true
    )
    expect(dispatchGoonSpeechMessage).toHaveBeenNthCalledWith(
      2,
      'message-1:realtime-tts:1',
      'agent-1',
      '<batshit-cue>{"goon_mood":"joy"}</batshit-cue>\nSecond sentence is ready.',
      true
    )
    expect(speak).toHaveBeenNthCalledWith(2, 'Second sentence is ready.', {
      voice: fishVoice,
      agentId: 'agent-1',
      messageId: 'message-1:realtime-tts:1',
      manual: true
    })
  })

  it('keeps cue controls when the control tag is split across stream chunks', () => {
    coordinator.append('message-1', 'agent-1', { tts: true }, '<batshit-cue>{"goon_')
    coordinator.append(
      'message-1',
      'agent-1',
      { tts: true },
      'mood":"joy"}</batshit-cue> Next sentence is ready. '
    )

    expect(dispatchGoonSpeechMessage).toHaveBeenCalledWith(
      'message-1:realtime-tts:0',
      'agent-1',
      '<batshit-cue>{"goon_mood":"joy"}</batshit-cue>\nNext sentence is ready.',
      true
    )
    expect(speak).toHaveBeenCalledWith('Next sentence is ready.', {
      voice: fishVoice,
      agentId: 'agent-1',
      messageId: 'message-1:realtime-tts:0',
      manual: true
    })
  })

  it('dispatches trailing cue controls even when there is no following spoken chunk', async () => {
    coordinator.append('message-1', 'agent-1', { tts: true }, 'First sentence is ready. ')
    coordinator.append(
      'message-1',
      'agent-1',
      { tts: true },
      '<batshit-cue>{"goon_mood":"joy"}</batshit-cue>'
    )

    await expect(coordinator.finish('message-1', 'agent-1', { tts: true })).resolves.toBe(true)

    expect(dispatchGoonSpeechMessage).toHaveBeenLastCalledWith(
      'message-1:realtime-tts:control:0',
      'agent-1',
      '<batshit-cue>{"goon_mood":"joy"}</batshit-cue>',
      false
    )
  })

  it('resumes realtime TTS after a complete batshit zip-control block', async () => {
    coordinator.append(
      'message-1',
      'agent-1',
      { tts: true },
      [
        'Normal reply before notes.',
        '<batshit-zip-control>{"toolResultsSummary":[{"toolName":"voice_test","summary":"Visible UI note, not spoken"}]}</batshit-zip-control>',
        'There you go! This part should still be spoken.'
      ].join('\n')
    )

    await expect(coordinator.finish('message-1', 'agent-1', { tts: true })).resolves.toBe(true)

    expect(speak).toHaveBeenCalledTimes(1)
    expect(speak).toHaveBeenCalledWith(
      'Normal reply before notes.\n\nThere you go! This part should still be spoken.',
      {
        voice: fishVoice,
        agentId: 'agent-1',
        messageId: 'message-1:realtime-tts:0',
        manual: true
      }
    )
  })

  it('resumes realtime TTS after a split batshit zip-control block', async () => {
    coordinator.append(
      'message-1',
      'agent-1',
      { tts: true },
      'First sentence. <batshit-zip-control>{"toolResultsSummary":['
    )
    coordinator.append(
      'message-1',
      'agent-1',
      { tts: true },
      '{"toolName":"voice_test","summary":"Visible UI note, not spoken"}]}</batshit-zip-control>\nSecond sentence.'
    )

    await expect(coordinator.finish('message-1', 'agent-1', { tts: true })).resolves.toBe(true)

    expect(speak).toHaveBeenNthCalledWith(1, 'First sentence.', {
      voice: fishVoice,
      agentId: 'agent-1',
      messageId: 'message-1:realtime-tts:0',
      manual: true
    })
    expect(speak).toHaveBeenNthCalledWith(2, 'Second sentence.', {
      voice: fishVoice,
      agentId: 'agent-1',
      messageId: 'message-1:realtime-tts:1',
      manual: true
    })
  })
})
