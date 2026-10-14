import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildRealtimeSpeechChunkId,
  findNextHiddenControlOpener,
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

  describe('what counts as a control block (BL-442)', () => {
    const spoken = () => speak.mock.calls.map((call) => call[0] as string).join(' ')

    it('speaks the rest of a reply that names a tag in a sentence as it streams (R2, BL-473)', async () => {
      coordinator.append('message-1', 'agent-1', { tts: true }, 'I write a <batshit-memory>')
      coordinator.append('message-1', 'agent-1', { tts: true }, ' block when you ask me to remember something. Then')
      // Spoken now, not held for a closing tag until the reply ends.
      expect(spoken()).toContain('block when you ask me to remember something.')
      await coordinator.finish('message-1', 'agent-1', { tts: true })
      expect(spoken()).toContain('I write a')
    })

    it('speaks a lone < and a reply that ends in one (R4, R5, BL-477)', async () => {
      coordinator.append('message-1', 'agent-1', { tts: true }, 'If the count is <')
      coordinator.append('message-1', 'agent-1', { tts: true }, ' 5, retry the upload. And x < 5 and y > 3. The end <')
      await coordinator.finish('message-1', 'agent-1', { tts: true })
      expect(spoken()).toContain('If the count is < 5, retry the upload.')
      expect(spoken()).toContain('x < 5 and y > 3.')
      expect(spoken()).toContain('The end <')
    })

    it('reads a tag in code as code, never as a block that swallows the rest (R1)', async () => {
      coordinator.append('message-1', 'agent-1', { tts: true }, 'Example:\n```\n<batshit-memory>{"lane":"ltm"')
      coordinator.append('message-1', 'agent-1', { tts: true }, '}</batshit-memory>\n```\nThat is the syntax, and more words after.')
      coordinator.append('message-1', 'agent-1', { tts: true }, ' Then `<batshit-tool-notes>{` is how notes start, and still more. Next')
      // Spoken as it streams: the tag in inline code opened no block.
      expect(spoken()).toContain('is how notes start, and still more.')
      await coordinator.finish('message-1', 'agent-1', { tts: true })
      expect(spoken()).toContain('That is the syntax, and more words after.')
      expect(spoken()).toContain('is how notes start, and still more.')
    })

    it('speaks at the end what a tag in inline code held back when its closing backtick came later', async () => {
      coordinator.append('message-1', 'agent-1', { tts: true }, 'Then `<batshit-tool-notes>{')
      coordinator.append('message-1', 'agent-1', { tts: true }, '` is how notes start, and still more words.')
      await coordinator.finish('message-1', 'agent-1', { tts: true })
      expect(spoken()).toContain('is how notes start, and still more words.')
    })

    it('reads a chunk full of lone < in one pass', async () => {
      const chunk = `${'a < b '.repeat(40_000)}> end. <batshit-memory>{"lane":"ltm","content":"canary fact"}</batshit-memory> Done.`
      const started = performance.now()
      coordinator.append('message-1', 'agent-1', { tts: true }, chunk)
      expect(performance.now() - started).toBeLessThan(1_500)
      await coordinator.finish('message-1', 'agent-1', { tts: true })
      expect(spoken()).not.toContain('canary fact')
    })

    it('finds the opener after 300,000 lone < in one pass', () => {
      // Without the remembered `>`, every `<` searched to the far `>` (grows with the square).
      const text = `${'a < b '.repeat(300_000)}> end <batshit-memory>{"lane":"ltm"}</batshit-memory>`
      const started = performance.now()
      const opener = findNextHiddenControlOpener(text)
      expect(performance.now() - started).toBeLessThan(1_000)
      expect(opener).toMatchObject({ type: 'open', tagName: 'batshit-memory', index: text.indexOf('<batshit-memory>') })
    })

    it('at the end speaks a short held start and never part of a cut tag name (R4)', async () => {
      coordinator.append('message-1', 'agent-1', { tts: true }, 'The first answer ends in <bat')
      await coordinator.finish('message-1', 'agent-1', { tts: true })
      expect(spoken()).toContain('The first answer ends in <bat')
      speak.mockClear()
      coordinator.append('message-2', 'agent-1', { tts: true }, 'The second answer was cut <batshit-tool-no')
      await coordinator.finish('message-2', 'agent-1', { tts: true })
      expect(spoken()).toContain('The second answer was cut')
      expect(spoken()).not.toContain('batshit')
    })

    it('hides a real block that follows a block holding a lone backtick', async () => {
      coordinator.append(
        'message-1',
        'agent-1',
        { tts: true },
        'Done. <batshit-tool-notes>{"notes":[{"toolName":"bash","summary":"no rule `all\'"}]}</batshit-tool-notes> '
      )
      coordinator.append(
        'message-1',
        'agent-1',
        { tts: true },
        '<batshit-cue>{"goon_mood":"canary"}</batshit-cue> and `make` later. More words here.'
      )
      await coordinator.finish('message-1', 'agent-1', { tts: true })
      expect(spoken()).not.toContain('canary')
      expect(dispatchGoonSpeechMessage.mock.calls.map((call) => call[2]).join(' ')).toContain('canary')
    })

    it('never fires a cue example in inline code whose closing backtick arrives in the next chunk (review)', async () => {
      coordinator.append('message-1', 'agent-1', { tts: true }, 'To set a mood write `<batshit-cue>{"mood":"angry"}</batshit-cue>')
      coordinator.append('message-1', 'agent-1', { tts: true }, '` and the face changes. That is all there is to it.')
      await coordinator.finish('message-1', 'agent-1', { tts: true })
      const dispatched = dispatchGoonSpeechMessage.mock.calls.map((call) => String(call[2]))
      // A cue block handed to the Goon on its own (not inside the spoken text's inline code).
      expect(dispatched.filter((content) => /(^|\n)<batshit-cue>/.test(content))).toEqual([])
      expect(spoken()).toContain('To set a mood write')
      expect(spoken()).toContain('<batshit-cue>{"mood":"angry"}</batshit-cue>')
      expect(spoken()).toContain('and the face changes.')
    })

    it('still fires a real cue after an unmatched backtick once the paragraph ends', async () => {
      coordinator.append('message-1', 'agent-1', { tts: true }, 'A lone ` here. <batshit-cue>{"goon_mood":"happy"}</batshit-cue>')
      coordinator.append('message-1', 'agent-1', { tts: true }, ' Still talking.\n\nNew paragraph.')
      // Decided when the paragraph ended, not held to the reply's end.
      const beforeFinish = dispatchGoonSpeechMessage.mock.calls.map((call) => String(call[2])).join('\n')
      expect(beforeFinish).toContain('<batshit-cue>{"goon_mood":"happy"}</batshit-cue>')
      await coordinator.finish('message-1', 'agent-1', { tts: true })
      expect(spoken()).not.toContain('goon_mood')
    })

    it('fires a real cue held for an open backtick when the reply ends without closing it', async () => {
      coordinator.append('message-1', 'agent-1', { tts: true }, 'A lone ` here. <batshit-cue>{"goon_mood":"calm"}</batshit-cue> and the end.')
      await coordinator.finish('message-1', 'agent-1', { tts: true })
      const dispatched = dispatchGoonSpeechMessage.mock.calls.map((call) => String(call[2])).join('\n')
      expect(dispatched).toContain('<batshit-cue>{"goon_mood":"calm"}</batshit-cue>')
      expect(spoken()).not.toContain('goon_mood')
      expect(spoken()).toContain('and the end.')
    })

    it('speaks a tag name followed by words as it streams, never holding it (R4 strict)', async () => {
      coordinator.append('message-1', 'agent-1', { tts: true }, "Wrap it in a <batshit-memory tag and it's saved. ")
      coordinator.append('message-1', 'agent-1', { tts: true }, 'Then the next sentence follows here.')
      expect(spoken()).toContain("Wrap it in a <batshit-memory tag and it's saved.")
      await coordinator.finish('message-1', 'agent-1', { tts: true })
    })

    describe('a closing tag split across chunks closes the block (BL-699)', () => {
      const PAYLOADS: Record<string, string> = {
        'batshit-zip-control': '{"unzip":["tool_result_1"]}',
        'batshit-tool-notes': '{"notes":[{"toolName":"bash","summary":"secret note"}]}',
        'batshit-memory': '{"lane":"ltm","content":"secret fact"}',
        'batshit-cue': '{"mood":"happy"}',
        'batshit-group': '{"mode":"responding"}',
        // A plain tool-results section tag rides the same hold-back.
        'tool-results': 'a summary never to speak'
      }
      const cases = Object.entries(PAYLOADS).flatMap(([tag, payload]) => {
        const closing = `</${tag}>`
        return Array.from({ length: closing.length - 1 }, (_, index) => [tag, index + 1, payload] as const)
      })

      it.each(cases)('<%s>, its closing tag split after %i characters', async (tag, split, payload) => {
        const closing = `</${tag}>`
        coordinator.append('message-1', 'agent-1', { tts: true }, `A first sentence. <${tag}>${payload}${closing.slice(0, split)}`)
        coordinator.append('message-1', 'agent-1', { tts: true }, `${closing.slice(split)} And here are more words after it.`)
        await coordinator.finish('message-1', 'agent-1', { tts: true })
        expect(spoken()).toContain('And here are more words after it.')
        expect(spoken()).not.toContain(payload)
        if (tag === 'batshit-cue') {
          expect(dispatchGoonSpeechMessage.mock.calls.map((call) => String(call[2])).join('\n')).toContain(`<${tag}>${payload}</${tag}>`)
        }
      })

      it.each(cases)('<%s>, opened in an earlier chunk, its closing tag split after %i characters', async (tag, split, payload) => {
        const closing = `</${tag}>`
        coordinator.append('message-1', 'agent-1', { tts: true }, `A first sentence. <${tag}>${payload.slice(0, 3)}`)
        coordinator.append('message-1', 'agent-1', { tts: true }, `${payload.slice(3)}${closing.slice(0, split)}`)
        coordinator.append('message-1', 'agent-1', { tts: true }, `${closing.slice(split)} And here are more words after it.`)
        await coordinator.finish('message-1', 'agent-1', { tts: true })
        expect(spoken()).toContain('And here are more words after it.')
        expect(spoken()).not.toContain(payload.slice(3))
        if (tag === 'batshit-cue') {
          expect(dispatchGoonSpeechMessage.mock.calls.map((call) => String(call[2])).join('\n')).toContain(`<${tag}>${payload}</${tag}>`)
        }
      })

      it('holds only the start of a closing tag, so a long block with an early < streams in one pass', async () => {
        // Holding any tail from the last `<` would carry "a < b ..." into every later chunk and
        // search it again each time (grows with the square of the block's length).
        const started = performance.now()
        coordinator.append('message-1', 'agent-1', { tts: true }, 'Spoken. <batshit-memory>{"lane":"ltm","content":"a < b')
        for (let chunk = 0; chunk < 20000; chunk += 1) {
          coordinator.append('message-1', 'agent-1', { tts: true }, ' more payload words that go on and on and on')
        }
        coordinator.append('message-1', 'agent-1', { tts: true }, '"}</batshit-memory> Words after the block.')
        await coordinator.finish('message-1', 'agent-1', { tts: true })
        expect(performance.now() - started).toBeLessThan(1_500)
        expect(spoken()).toContain('Words after the block.')
        expect(spoken()).not.toContain('payload words')
      })

      it('the reviewer\'s input', async () => {
        coordinator.append('message-1', 'agent-1', { tts: true }, 'A sentence. <batshit-cue>{"mood":"happy"}<')
        coordinator.append('message-1', 'agent-1', { tts: true }, '/batshit-cue> And here are more words after it.')
        await coordinator.finish('message-1', 'agent-1', { tts: true })
        expect(spoken()).toContain('And here are more words after it.')
        expect(dispatchGoonSpeechMessage.mock.calls.map((call) => String(call[2])).join('\n')).toContain('<batshit-cue>{"mood":"happy"}</batshit-cue>')
      })

      it('never speaks a partial closing tag of a block still open at the end', async () => {
        coordinator.append('message-1', 'agent-1', { tts: true }, 'A sentence. <batshit-memory>{"lane":"ltm","content":"secret"}</batshit-mem')
        await coordinator.finish('message-1', 'agent-1', { tts: true })
        expect(spoken()).not.toContain('batshit')
        expect(spoken()).not.toContain('secret')
      })
    })

    it('still never speaks a real block next to them', async () => {
      coordinator.append('message-1', 'agent-1', { tts: true }, 'Noted, x < 5. <batshit-memory>{"lane":"ltm","content":"canary fact"}')
      coordinator.append('message-1', 'agent-1', { tts: true }, '</batshit-memory> Anything else?')
      await coordinator.finish('message-1', 'agent-1', { tts: true })
      expect(spoken()).not.toContain('canary fact')
      expect(spoken()).toContain('Anything else?')
    })
  })

  // BL-759: a managed lane took the end of the reply back (Codex retried a dropped answer). What
  // was handed to the voice is spoken; what still waits in the buffer is the fragment's and goes.
  describe('discardUnspoken (BL-759)', () => {
    it('drops the words not yet handed to the voice and keeps speaking the new ones', async () => {
      coordinator.append('message-1', 'agent-1', { tts: true }, 'First sentence is spoken. Half a sen')
      expect(speak).toHaveBeenCalledTimes(1)

      coordinator.discardUnspoken('message-1', 'First sentence is spoken. ')
      vi.advanceTimersByTime(100)
      coordinator.append('message-1', 'agent-1', { tts: true }, 'The retried answer. ')
      await coordinator.finish('message-1', 'agent-1', { tts: true })

      const spokenTexts = speak.mock.calls.map((call) => call[0])
      expect(spokenTexts).toEqual(['First sentence is spoken.', 'The retried answer.'])
      expect(spokenTexts.join(' ')).not.toContain('Half a sen')
    })

    it('keeps a finished message\'s last words waiting before the fragment, and drops only the fragment', async () => {
      coordinator.append('message-1', 'agent-1', { tts: true }, 'Short tail')
      coordinator.append('message-1', 'agent-1', { tts: true }, ' and a half sen')
      expect(speak).not.toHaveBeenCalled()

      coordinator.discardUnspoken('message-1', 'Short tail', ' and a half sen')
      await coordinator.finish('message-1', 'agent-1', { tts: true })

      expect(speak.mock.calls.map((call) => call[0])).toEqual(['Short tail'])
    })

    it('does nothing for a message it is not speaking', () => {
      expect(() => coordinator.discardUnspoken('message-none', 'Anything.')).not.toThrow()
      expect(coordinator.size).toBe(0)
    })
  })
})
