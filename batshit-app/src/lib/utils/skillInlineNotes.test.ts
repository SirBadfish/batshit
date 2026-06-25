import { describe, expect, it } from 'vitest'
import { formatSkillInlineDisplayName, stripSkillInlineMetadata } from './skillInlineNotes'

describe('skillInlineNotes', () => {
  it('strips hidden skill id metadata from invocation notes', () => {
    expect(stripSkillInlineMetadata('TTS/STT Engine Installer | skillId=voice-engine-installer')).toBe(
      'TTS/STT Engine Installer'
    )
  })

  it('keeps display names readable without destroying acronyms', () => {
    expect(formatSkillInlineDisplayName('TTS/STT Engine Installer | skillId=voice-engine-installer')).toBe(
      'TTS/STT Engine Installer'
    )
  })

  it('humanizes slug-only skill names', () => {
    expect(formatSkillInlineDisplayName('voice-engine-installer')).toBe('Voice Engine Installer')
    expect(formatSkillInlineDisplayName('tts/stt-engine-installer')).toBe('TTS/STT Engine Installer')
  })
})
