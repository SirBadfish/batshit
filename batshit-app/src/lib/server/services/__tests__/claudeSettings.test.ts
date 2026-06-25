import { describe, expect, it } from 'vitest'

import {
  buildClaudeRuntimeSettings,
  getClaudeConfigOverrideValidationError,
  sanitizeClaudeConfigOverrides
} from '../claudeSettings'

describe('buildClaudeRuntimeSettings core system prompt toggle', () => {
  it('replaces the built-in Claude system prompt by default', () => {
    const settings = buildClaudeRuntimeSettings({
      permissionMode: 'default',
      model: 'sonnet',
      addDirs: [],
      allowedTools: [],
      disallowedTools: []
    })

    expect(settings.includeCoreSystemPrompt).toBe(false)
    expect(settings.systemPromptMode).toBe('replace')
    expect(settings.systemPrompt).toBe('You are a helpful assistant.')
  })

  it('stops injecting the replacement prompt when the core Claude system prompt is enabled', () => {
    const settings = buildClaudeRuntimeSettings({
      permissionMode: 'default',
      includeCoreSystemPrompt: true,
      model: 'sonnet',
      addDirs: [],
      allowedTools: [],
      disallowedTools: []
    })

    expect(settings.includeCoreSystemPrompt).toBe(true)
    expect(settings.systemPromptMode).toBe('default')
    expect(settings.systemPrompt).toBeUndefined()
  })

  it('drops Batshit-managed custom config keys and keeps the last duplicate', () => {
    const result = sanitizeClaudeConfigOverrides([
      { key: 'cleanupPeriodDays', value: '30' },
      { key: 'permissions.defaultMode', value: '"plan"' },
      { key: 'CLEANUPPERIODDAYS', value: '14' }
    ])

    expect(result.overrides).toEqual([{ key: 'CLEANUPPERIODDAYS', value: '14' }])
    expect(result.reservedKeys).toEqual(['permissions.defaultMode'])
    expect(result.duplicateKeys).toEqual(['cleanupPeriodDays'])
  })

  it('sanitizes Claude runtime settings before the managed file is written', () => {
    const settings = buildClaudeRuntimeSettings({
      permissionMode: 'default',
      model: 'sonnet',
      addDirs: [],
      allowedTools: [],
      disallowedTools: [],
      configOverrides: [
        { key: 'permissions.defaultMode', value: '"plan"' },
        { key: 'cleanupPeriodDays', value: '30' }
      ]
    })

    expect(settings.configOverrides).toEqual([{ key: 'cleanupPeriodDays', value: '30' }])
  })

  it('returns a plain-English validation error for conflicting Claude custom rows', () => {
    const message = getClaudeConfigOverrideValidationError({
      permissionMode: 'default',
      model: 'sonnet',
      addDirs: [],
      allowedTools: [],
      disallowedTools: [],
      configOverrides: [
        { key: 'permissions.defaultMode', value: '"plan"' },
        { key: 'cleanupPeriodDays', value: '30' },
        { key: 'cleanupPeriodDays', value: '14' }
      ]
    })

    expect(message).toContain("can't redefine Batshit-managed settings")
    expect(message).toContain('permissions.defaultMode')
  })

  it('treats conflicting nested JSON paths as invalid', () => {
    const result = sanitizeClaudeConfigOverrides([
      { key: 'hooks.PreToolUse', value: '[]' },
      { key: 'hooks', value: 'true' }
    ])

    expect(result.overrides).toEqual([{ key: 'hooks', value: 'true' }])
    expect(result.invalidKeys).toEqual(['hooks.PreToolUse'])
  })
})
