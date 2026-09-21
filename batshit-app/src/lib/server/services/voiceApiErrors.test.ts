import { describe, expect, it } from 'vitest'
import { classifyVoiceApiError } from './voiceApiErrors'

describe('classifyVoiceApiError', () => {
  it('marks missing API keys as setup errors with actionable hints', () => {
    const result = classifyVoiceApiError(new Error('OpenAI API key not configured'), 'tts')

    expect(result.status).toBe(412)
    expect(result.logLevel).toBe('warn')
    expect(result.setupHint).toContain('Settings -> API Keys')
    expect(result.setupHint).toContain('OpenAI')
  })

  it('treats missing ElevenLabs voiceId as user-fixable input', () => {
    const result = classifyVoiceApiError(
      new Error(
        'Primary TTS provider "elevenlabs" failed. Automatic fallback is disabled. ElevenLabs voiceId is required'
      ),
      'tts'
    )

    expect(result.status).toBe(400)
    expect(result.logLevel).toBe('warn')
    expect(result.setupHint).toContain('Voice Settings')
  })

  it('gives Fish realtime TTS users a voice setup hint', () => {
    const result = classifyVoiceApiError(
      new Error(
        'Fish Audio voice is required for realtime TTS. Pick a Fish voice in Voice Settings before using realtime speech.'
      ),
      'tts'
    )

    expect(result.status).toBe(400)
    expect(result.logLevel).toBe('warn')
    expect(result.setupHint).toContain('Pick a Fish voice')
    expect(result.setupHint).toContain('Voice Settings')
  })

  it('returns a provider guidance hint for unsupported STT selections', () => {
    const result = classifyVoiceApiError(new Error('Unsupported STT provider: browser'), 'stt')

    expect(result.status).toBe(400)
    expect(result.setupHint).toContain('supported STT provider')
  })

  it('treats disabled BYO engines as user-fixable setup state', () => {
    const result = classifyVoiceApiError(
      new Error(
        'Primary TTS provider "byo:disabled-tts-probe" failed. Automatic fallback is disabled. BYO provider "Disabled TTS Probe" is disabled.'
      ),
      'tts'
    )

    expect(result.status).toBe(400)
    expect(result.logLevel).toBe('warn')
    expect(result.error).toContain('disabled')
  })

  it('treats provider-specific local voice validation as user-fixable input', () => {
    const flux = classifyVoiceApiError(
      new Error('Deepgram Flux speed must use 0.05 increments.'),
      'tts'
    )
    const google = classifyVoiceApiError(
      new Error('Google Gemini 3.5 Transcribe does not accept audio type "text/plain".'),
      'stt'
    )

    expect(flux).toMatchObject({ status: 400, logLevel: 'warn' })
    expect(google).toMatchObject({ status: 400, logLevel: 'warn' })
  })

  it('maps network failures to upstream dependency errors', () => {
    const result = classifyVoiceApiError(new Error('connect ECONNREFUSED 127.0.0.1:7777'), 'tts')

    expect(result.status).toBe(502)
    expect(result.logLevel).toBe('error')
  })

  it('preserves provider quota responses as retryable rate-limit errors', () => {
    const error = Object.assign(new Error('Resource exhausted for this project.'), { status: 429 })
    const result = classifyVoiceApiError(error, 'stt')

    expect(result).toMatchObject({
      status: 429,
      logLevel: 'warn',
      error: 'Resource exhausted for this project.'
    })
    expect(result.setupHint).toContain('usage/billing')
  })

  it('falls back to generic server error handling for unknown failures', () => {
    const result = classifyVoiceApiError(new Error('Unexpected provider crash'), 'stt')

    expect(result.status).toBe(500)
    expect(result.logLevel).toBe('error')
    expect(result.error).toBe('Unexpected provider crash')
  })

  it('uses mode-specific fallback message for non-error values', () => {
    const result = classifyVoiceApiError(null, 'tts')

    expect(result.status).toBe(500)
    expect(result.error).toBe('Failed to synthesize speech')
  })
})
