import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetVoiceEngineGuidanceForProviderId = vi.fn()

vi.mock('$lib/server/services/voiceEngineRegistry', () => ({
  getVoiceEngineGuidanceForProviderId: (...args: any[]) =>
    mockGetVoiceEngineGuidanceForProviderId(...args)
}))

import {
  buildVoiceRuntimeGuidanceForProvider,
  getTtsEnginePromptGuidance
} from '$lib/server/services/voiceRuntimeGuidance'

describe('voiceRuntimeGuidance', () => {
  beforeEach(() => {
    mockGetVoiceEngineGuidanceForProviderId.mockReset()
  })

  it('builds prompt guidance for built-in TTS providers', () => {
    const guidance = getTtsEnginePromptGuidance(
      {
        ttsEnginePrompts: {
          openai: {
            prompt: 'Use [whispers] only when it naturally fits.'
          }
        }
      },
      'openai'
    )

    expect(guidance).toEqual([
      'TTS engine prompt (openai): follow these engine-specific speaking instructions when writing text that will be spoken by this provider.',
      'Use [whispers] only when it naturally fits.'
    ])
  })

  it('merges BYO expression guidance with the saved TTS engine prompt', async () => {
    mockGetVoiceEngineGuidanceForProviderId.mockResolvedValue([
      'Voice engine: Kokoro (byo:kokoro)',
      'Expression support: inline_tokens'
    ])

    const guidance = await buildVoiceRuntimeGuidanceForProvider(
      'user-1',
      'byo:kokoro',
      {
        ttsEnginePrompts: {
          'byo:kokoro': {
            prompt: 'Preserve [laughs] and [sighs].'
          }
        }
      }
    )

    expect(mockGetVoiceEngineGuidanceForProviderId).toHaveBeenCalledWith('user-1', 'byo:kokoro')
    expect(guidance).toEqual([
      'Voice engine: Kokoro (byo:kokoro)',
      'Expression support: inline_tokens',
      'TTS engine prompt (byo:kokoro): follow these engine-specific speaking instructions when writing text that will be spoken by this provider.',
      'Preserve [laughs] and [sighs].'
    ])
  })

  it('does not call the BYO registry for built-in providers', async () => {
    const guidance = await buildVoiceRuntimeGuidanceForProvider(
      'user-1',
      'fish',
      {
        ttsEnginePrompts: {
          fish: {
            prompt: 'Avoid unsupported XML tags.'
          }
        }
      }
    )

    expect(mockGetVoiceEngineGuidanceForProviderId).not.toHaveBeenCalled()
    expect(guidance).toContain('Avoid unsupported XML tags.')
  })
})
