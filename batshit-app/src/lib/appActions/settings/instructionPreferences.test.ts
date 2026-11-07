import { describe, expect, it } from 'vitest'
import {
  describeInstructionText, INSTRUCTION_LIMITS, normalizeInstructionsChanges,
  resolveInstructionGlobalInclusion, validateInstructionsChanges
} from './instructionPreferences'

describe('finite instruction input and metadata', () => {
  it('accepts sparse false, empty and null without filling omitted fields', () => {
    expect(validateInstructionsChanges({ includeGlobalPrompt: false })).toEqual({ includeGlobalPrompt: false })
    expect(validateInstructionsChanges({ customPrompt: '', includeGlobalPrompt: null })).toEqual({ customPrompt: '', includeGlobalPrompt: null })
    expect(Object.isFrozen(validateInstructionsChanges({ customPrompt: null }))).toBe(true)
  })
  it('rejects coercion, undefined, malformed text and every unadopted field', () => {
    for (const input of [null, [], {}, { customPrompt: 4 }, { customPrompt: undefined }, { customPrompt: 'bad\ud800' },
      { includeGlobalPrompt: 'false' }, { includeGlobalPrompt: undefined }, { system_prompt: 'raw' },
      { '$.system_prompt': 'raw' }, { globalCustomPrompt: 'global' }, { includeCoreSystemPrompt: true }, { systemPromptFile: '/path' }]) {
      expect(() => validateInstructionsChanges(input)).toThrow()
    }
  })
  it('bounds requested UTF-8 bytes without truncation or a whitespace-trim bypass', () => {
    expect(validateInstructionsChanges({ customPrompt: 'a'.repeat(16 * 1024) }).customPrompt?.length).toBe(16 * 1024)
    expect(validateInstructionsChanges({ customPrompt: '😀'.repeat(4096) }).customPrompt?.length).toBe(8192)
    for (const customPrompt of ['a'.repeat(16 * 1024 + 1), '😀'.repeat(4097), ' '.repeat(16 * 1024 + 1)]) {
      expect(() => normalizeInstructionsChanges('subagent', { customPrompt })).toThrow('16 KiB')
    }
  })
  it('keeps Primary prose exact while normalizing Subagent trim and clear intent', () => {
    expect(normalizeInstructionsChanges('primary', { customPrompt: '  Line one\nLine two  ' })).toEqual({ customPrompt: '  Line one\nLine two  ' })
    expect(normalizeInstructionsChanges('primary', { customPrompt: '   ' })).toEqual({ customPrompt: '   ' })
    expect(normalizeInstructionsChanges('subagent', { customPrompt: '  Line one\nLine two  ' })).toEqual({ customPrompt: 'Line one\nLine two' })
    for (const customPrompt of ['', '  \n\t ', null]) expect(normalizeInstructionsChanges('subagent', { customPrompt })).toEqual({ customPrompt: null })
  })
  it('uses different actual inclusion defaults without coercing malformed saved values', () => {
    for (const raw of [null, undefined]) {
      expect(resolveInstructionGlobalInclusion('primary', raw)).toBe(true)
      expect(resolveInstructionGlobalInclusion('subagent', raw)).toBe(false)
    }
    expect(resolveInstructionGlobalInclusion('primary', false)).toBe(false)
    expect(resolveInstructionGlobalInclusion('subagent', true)).toBe(true)
    for (const raw of ['false', 0, [], {}]) expect(() => resolveInstructionGlobalInclusion('primary', raw)).toThrow('Invalid saved')
  })
  it('describes text without exporting it and distinguishes null, absence and invalid storage', () => {
    expect(describeInstructionText(undefined)).toMatchObject({ stored: 'unset', representation: 'absent' })
    expect(describeInstructionText(null)).toMatchObject({ stored: 'unset', representation: 'null' })
    expect(describeInstructionText('private 😀 text')).toEqual({ stored: 'set', codeUnits: 15, utf8Bytes: 17, read: 'available' })
    expect(JSON.stringify(describeInstructionText('private 😀 text'))).not.toContain('private')
    for (const raw of [42, {}, ['text'], 'bad\ud800']) expect(describeInstructionText(raw)).toEqual({ stored: 'invalid', codeUnits: null, utf8Bytes: null, read: 'unavailable' })
  })
  it('makes oversized saved text explicitly unreadable without changing or truncating it', () => {
    const raw = 'x'.repeat(INSTRUCTION_LIMITS.readSnapshotBytes + 1)
    expect(describeInstructionText(raw)).toMatchObject({ stored: 'set', codeUnits: raw.length, utf8Bytes: null, read: 'too_large' })
    const multibyte = '😀'.repeat(INSTRUCTION_LIMITS.readSnapshotBytes / 4 + 1)
    expect(describeInstructionText(multibyte)).toMatchObject({ stored: 'set', utf8Bytes: INSTRUCTION_LIMITS.readSnapshotBytes + 4, read: 'too_large' })
    expect(raw.length).toBe(INSTRUCTION_LIMITS.readSnapshotBytes + 1)
  })
})
