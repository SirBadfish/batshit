import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetApiKeyAvailability = vi.fn()

vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: {
    getApiKeyAvailability: (...args: any[]) => mockGetApiKeyAvailability(...args)
  }
}))

import {
  buildSkillApiKeyAvailabilityLines,
  buildSkillSessionContextLines,
  isSkillInvocationMessage
} from '../skillSessionContext'

describe('skillSessionContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('detects skill invocation markers', () => {
    expect(
      isSkillInvocationMessage(
        '[Skill: TTS/STT Engine Installer | skillId=voice-engine-installer]\n\nset up chatterbox'
      )
    ).toBe(true)
    expect(isSkillInvocationMessage('just a normal message')).toBe(false)
    expect(isSkillInvocationMessage(undefined)).toBe(false)
  })

  it('formats skill API key availability lines with stable sorting', () => {
    const lines = buildSkillApiKeyAvailabilityLines({
      configured: ['openai', 'huggingface'],
      notConfigured: ['fal', 'anthropic']
    })

    expect(lines).toContain('user_api_keys_configured: huggingface, openai')
    expect(lines).toContain('user_api_keys_not_configured: anthropic, fal')
    expect(lines).toContain(
      '- If a saved external key is needed, tell the user what is available and ask before using it.'
    )
  })

  it('loads API key availability only for skill invocations', async () => {
    mockGetApiKeyAvailability.mockResolvedValue({
      configured: ['huggingface'],
      notConfigured: ['openai']
    })

    const nonSkillLines = await buildSkillSessionContextLines({
      userId: 'user-1',
      currentUserMessage: 'hello there'
    })
    expect(nonSkillLines).toEqual([])
    expect(mockGetApiKeyAvailability).not.toHaveBeenCalled()

    const skillLines = await buildSkillSessionContextLines({
      userId: 'user-1',
      currentUserMessage:
        '[Skill: TTS/STT Engine Installer | skillId=voice-engine-installer]\n\nset up chatterbox'
    })

    expect(mockGetApiKeyAvailability).toHaveBeenCalledWith('user-1')
    expect(skillLines).toContain('user_api_keys_configured: huggingface')
    expect(skillLines).toContain('user_api_keys_not_configured: openai')
  })
})
