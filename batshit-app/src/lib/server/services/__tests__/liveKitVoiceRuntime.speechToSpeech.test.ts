import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  retrieve: vi.fn(),
  getAgents: vi.fn(),
  getRecentMessages: vi.fn(),
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
    getRecentMessages: mocks.getRecentMessages,
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
  dispatchFactory: vi.fn(async () => ({ id: 'dispatch-1' })),
  admitAgentDispatch: async () => null
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
    mocks.getRecentMessages.mockReset()
    mocks.getUserSettings.mockReset()
    mocks.buildFormattedChatInput.mockReset()
    liveKitTestOptions.tokenFactory.mockClear()
    liveKitTestOptions.dispatchFactory.mockClear()
    mocks.retrieve.mockResolvedValue('saved-xai-key')
    mocks.getRecentMessages.mockResolvedValue([])
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
    mocks.getRecentMessages.mockResolvedValue([
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
              '<conversation>',
              '<user time="May 15, 2026 at 12:00 PM">',
              'Earlier chat context',
              '</user>',
              '</conversation>',
              '',
              '<note time="12:30 PM">',
              'LiveKit true speech-to-speech voice session started.',
              '</note>',
              '',
              '<dynamic_info>',
              'Goon Dock is available.',
              '</dynamic_info>'
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
        admitAgentDispatch: async () => null,
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

/**
 * BL-467 (reworked): the earlier fix cut the ALREADY-COMPILED text by finding the first
 * `<conversation>` line — unsafe, because the system prompt comes first and is not escaped
 * (a system prompt containing such a line would be found instead of the real one), and
 * cutting after compilation breaks the compiler's own guarantees (dates, the zip index, a
 * Compact summary note as the oldest element). The real fix asks the SOLE compiler
 * (`databaseService.buildFormattedChatInput`) to compile with FEWER messages, dropped from
 * the oldest end, until the whole thing fits — so the compiler itself produces a valid
 * `<conversation>` block. This mock plays the compiler's role: it builds a `<conversation>`
 * block from whatever `messages` array it is actually called with (never a fixed string), so
 * a test can tell how many — and WHICH — messages a given call compiled.
 */
describe('createLiveKitVoiceSession speech-to-speech — dispatch metadata budget (BL-467)', () => {
  const SYSTEM_PROMPT = [
    '==== API PRIMARY SYSTEM PROMPT ====',
    'API Primary Agent base instructions.'
  ].join('\n')

  // A system prompt line starting with the compiler's own `<conversation>` tag — the exact
  // shape the old text-surgery clamp could have mistaken for the real history block, since
  // the system prompt is compiled FIRST and is not tag-escaped. The new approach never
  // inspects compiled text at all, so this must survive completely untouched regardless.
  const SYSTEM_PROMPT_WITH_DECOY = [
    SYSTEM_PROMPT,
    '<conversation>this is prompt text, not the compiler\'s history element</conversation>'
  ].join('\n')

  let currentSystemPrompt = SYSTEM_PROMPT

  beforeEach(() => {
    mocks.retrieve.mockReset()
    mocks.getAgents.mockReset()
    mocks.getRecentMessages.mockReset()
    mocks.getUserSettings.mockReset()
    mocks.buildFormattedChatInput.mockReset()
    liveKitTestOptions.tokenFactory.mockClear()
    liveKitTestOptions.dispatchFactory.mockClear()
    mocks.retrieve.mockResolvedValue(null)
    mocks.getUserSettings.mockResolvedValue(null)
    mocks.getAgents.mockResolvedValue([
      {
        id: 'agent-1',
        user_id: 'user-1',
        displayName: 'Luna',
        agentType: 'api',
        system_prompt: 'You are Luna.'
      }
    ])
    currentSystemPrompt = SYSTEM_PROMPT

    // Plays the compiler: builds `<conversation>` from the ACTUAL `messages` array this
    // call received (the second positional argument), so compiling with fewer messages
    // produces a genuinely shorter, structurally different result — never a slice of a
    // fixed string.
    mocks.buildFormattedChatInput.mockImplementation(
      async (_sessionId: string, messages: Array<{ content?: string }>) => {
        const elements = (messages ?? []).map((message, index) => {
          const tag = index % 2 === 0 ? 'user' : 'assistant'
          const label = message?.content ?? `MESSAGE-${index}`
          return `<${tag}>\n${label} ${'x'.repeat(2_500)}\n</${tag}>`
        })
        const conversation =
          elements.length > 0 ? `<conversation>\n${elements.join('\n\n')}\n</conversation>\n\n` : ''
        const content = [
          conversation,
          '<note>',
          'LiveKit true speech-to-speech voice session started.',
          '</note>',
          '',
          '<dynamic_info>',
          'DCM-MARKER: Goon Dock is available.',
          '</dynamic_info>'
        ].join('\n')
        return {
          primarySystemPrompt: currentSystemPrompt,
          structuredInput: { messages: [{ role: 'user', content }] }
        }
      }
    )
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  /** Ascending oldest-to-newest, exactly what `redis.getRecentMessages` returns (BL-398 note). */
  function seedHistory(count: number) {
    mocks.getRecentMessages.mockResolvedValue(
      Array.from({ length: count }, (_, i) => ({ id: `msg-${i}`, content: `MESSAGE-${i}` }))
    )
  }

  async function runSession(requestedInstructions?: string) {
    let dispatchInput: any
    await createLiveKitVoiceSession(
      'user-1',
      {
        sessionId: 'session-1',
        agentId: 'agent-1',
        participantName: 'Josh',
        speechToSpeech: {
          enabled: true,
          providerId: 'openai',
          ...(requestedInstructions ? { instructions: requestedInstructions } : {})
        },
        agentDispatch: { enabled: true, required: true, agentName: 'batshit-livekit-agent' }
      },
      {
        ...liveKitTestOptions,
        dispatchFactory: async (input: any) => {
          dispatchInput = input
          return { id: 'dispatch-1' }
        }
      }
    )
    return JSON.parse(dispatchInput.metadata).instructions as string
  }

  it('drops the oldest history and keeps the newest message, the DCM, and the session instructions whole', async () => {
    // 30 padded messages (~2.5KB each) comfortably exceeds the 48,000-char dispatch budget.
    seedHistory(30)

    const instructions = await runSession('SESSION-INSTRUCTIONS-MARKER: speak slowly')

    expect(instructions.length).toBeLessThanOrEqual(48_000)
    // Newest history message survives; the oldest is gone.
    expect(instructions).toContain('MESSAGE-29')
    expect(instructions).not.toContain('MESSAGE-0 ')
    // DCM and the LiveKit session instructions are never cut.
    expect(instructions).toContain('<dynamic_info>')
    expect(instructions).toContain('DCM-MARKER: Goon Dock is available.')
    expect(instructions).toContain('==== LIVEKIT SPEECH-TO-SPEECH SESSION INSTRUCTIONS ====')
    expect(instructions).toContain('SESSION-INSTRUCTIONS-MARKER: speak slowly')
    // The voice addendum (always appended last) survives too.
    expect(instructions).toContain('==== LIVEKIT TRUE SPEECH-TO-SPEECH VOICE MODE ====')
  })

  it('the first remaining message carries its own date (a real compile, not a text slice)', async () => {
    // The compiler is asked to date-stamp only the FIRST message of a day; a text-surgery
    // clamp that dropped an OLDER element without recompiling would leave the new "first"
    // message with no date. This mock date-stamps index 0 of whatever `messages` array THAT
    // call actually received, so the winning (kept) compile's date lands on its own real
    // first element — verified structurally against the final `instructions`, not against a
    // side channel, since the binary search issues several compile calls and only one wins.
    seedHistory(30)
    mocks.buildFormattedChatInput.mockImplementation(
      async (_sessionId: string, messages: Array<{ content?: string }>) => {
        const elements = (messages ?? []).map((message, index) => {
          const tag = index % 2 === 0 ? 'user' : 'assistant'
          const dateStamp = index === 0 ? ' date="2026-09-28"' : ''
          return `<${tag}${dateStamp}>\n${message?.content} ${'x'.repeat(2_500)}\n</${tag}>`
        })
        const conversation =
          elements.length > 0 ? `<conversation>\n${elements.join('\n\n')}\n</conversation>\n\n` : ''
        const content = [
          conversation,
          '<note>',
          'LiveKit true speech-to-speech voice session started.',
          '</note>',
          '',
          '<dynamic_info>DCM-MARKER</dynamic_info>'
        ].join('\n')
        return {
          primarySystemPrompt: currentSystemPrompt,
          structuredInput: { messages: [{ role: 'user', content }] }
        }
      }
    )

    const instructions = await runSession()

    // Every surviving message number, and which one is dated.
    const presentNumbers = Array.from(instructions.matchAll(/MESSAGE-(\d+)/g)).map((m) =>
      Number(m[1])
    )
    expect(presentNumbers.length).toBeGreaterThan(0)
    const oldestKept = Math.min(...presentNumbers)
    const dateMatch = instructions.match(/date="2026-09-28">\n(MESSAGE-\d+)/)
    expect(dateMatch).not.toBeNull()
    // The dated element is the OLDEST survivor, not merely SOME element index 0 was stamped
    // on — a stale/wrong slice would date a message that is not actually the kept block's
    // first (oldest) one.
    expect(dateMatch![1]).toBe(`MESSAGE-${oldestKept}`)
  })

  it('a system prompt containing a line starting with <conversation> is never cut or mistaken for history', async () => {
    seedHistory(30)
    currentSystemPrompt = SYSTEM_PROMPT_WITH_DECOY

    const instructions = await runSession('speak slowly')

    // The decoy line is compiled FIRST (system prompt, before any history), so if it survives
    // whole, nothing scanned or sliced the compiled text looking for `<conversation>`.
    expect(instructions).toContain(SYSTEM_PROMPT_WITH_DECOY)
    expect(instructions).toContain('MESSAGE-29')
  })

  it('leaves short content byte-for-byte unchanged (nothing dropped)', async () => {
    seedHistory(1)

    const instructions = await runSession('speak slowly')

    expect(instructions).toContain('MESSAGE-0')
    expect(instructions).toContain('DCM-MARKER: Goon Dock is available.')
    const expectedConversation = `<conversation>\n<user>\nMESSAGE-0 ${'x'.repeat(2_500)}\n</user>\n</conversation>\n\n`
    const expectedRuntimeContext = [
      expectedConversation,
      '<note>',
      'LiveKit true speech-to-speech voice session started.',
      '</note>',
      '',
      '<dynamic_info>',
      'DCM-MARKER: Goon Dock is available.',
      '</dynamic_info>'
    ].join('\n')
    const expected = [
      SYSTEM_PROMPT,
      '==== BATSHIT LIVE SESSION DYNAMIC CONTEXT SNAPSHOT ====\n\n' + expectedRuntimeContext,
      '==== LIVEKIT SPEECH-TO-SPEECH SESSION INSTRUCTIONS ====\n\nspeak slowly'
    ].join('\n\n')
    expect(instructions.startsWith(expected)).toBe(true)
  })

  /**
   * BL-467 review: the full history is tried FIRST, so the ordinary case (a chat short
   * enough to already fit) compiles exactly once — no wasted zero-history probe, no binary
   * search.
   */
  it('compiles exactly once when the full history already fits', async () => {
    seedHistory(3)

    await runSession('speak slowly')

    expect(mocks.buildFormattedChatInput).toHaveBeenCalledTimes(1)
  })

  /**
   * BL-467 review: the 512 KiB check must measure what LiveKit actually receives — the
   * dispatch metadata JSON (`normalizeAgentDispatchMetadata`, wrapping `instructions` plus
   * `runtime`, `roomName`, `sessionId`, and the rest), not the raw instructions string alone.
   * A system prompt alone (no history at all) big enough to exceed Batshit's own 48,000-char
   * budget, but nowhere near LiveKit's real 512 KiB limit, must still SHIP — logged loudly,
   * never silently.
   */
  it('ships with a console.error when Batshit\'s own budget is exceeded but LiveKit\'s real limit still fits', async () => {
    seedHistory(0)
    currentSystemPrompt = `${SYSTEM_PROMPT}\n${'x'.repeat(60_000)}`
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const instructions = await runSession('speak slowly')
      expect(instructions.length).toBeGreaterThan(48_000)
      expect(Buffer.byteLength(instructions, 'utf8')).toBeLessThan(512 * 1024)
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("still fits; sending as-is"),
        expect.objectContaining({ batshitBudgetChars: 48_000 })
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  /**
   * BL-467 review: crossing LiveKit's REAL 512 KiB dispatch metadata limit — not merely
   * Batshit's own 48,000-char budget — must fail the session start with a clear error
   * instead of sending something LiveKit may reject or truncate.
   */
  it('fails the session start when the real LiveKit dispatch metadata exceeds 512 KiB', async () => {
    seedHistory(0)
    currentSystemPrompt = `${SYSTEM_PROMPT}\n${'x'.repeat(600_000)}`
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(runSession('speak slowly')).rejects.toThrow(
        "too large for LiveKit's dispatch metadata limit"
      )
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("exceeds LiveKit's own dispatch metadata limit"),
        expect.objectContaining({ liveKitLimitBytes: 512 * 1024 })
      )
    } finally {
      errorSpy.mockRestore()
    }
  })
})
