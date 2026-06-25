import { describe, expect, it } from 'vitest'

import {
  buildCodexRuntimeSettings,
  getCodexConfigOverrideValidationError,
  sanitizeCodexConfigOverrides
} from '../codexSettings'

describe('codexSettings override guards', () => {
  it('drops Batshit-managed override keys and keeps the last duplicate', () => {
    const result = sanitizeCodexConfigOverrides([
      { key: 'model_context_window', value: '200000' },
      { key: 'history.persistence', value: '"none"' },
      { key: 'project_doc_max_bytes', value: '0' },
      { key: 'skills.config', value: '[]' },
      { key: 'MODEL_CONTEXT_WINDOW', value: '300000' }
    ])

    expect(result.overrides).toEqual([
      { key: 'project_doc_max_bytes', value: '0' },
      { key: 'MODEL_CONTEXT_WINDOW', value: '300000' }
    ])
    expect(result.reservedKeys).toEqual(['history.persistence', 'skills.config'])
    expect(result.duplicateKeys).toEqual(['model_context_window'])
  })

  it('sanitizes runtime settings before Codex CLI args are built', () => {
    const settings = buildCodexRuntimeSettings({
      permissionMode: 'chat',
      model: 'gpt-5.4',
      streamingEffect: true,
      search: true,
      sandbox: 'read-only',
      approval: 'never',
      addDirs: [],
      enableFeatures: [],
      disableFeatures: [],
      configOverrides: [
        { key: 'history.persistence', value: '"none"' },
        { key: 'project_doc_max_bytes', value: '0' },
        { key: 'skills.config', value: '[]' },
        { key: 'model_context_window', value: '1000000' }
      ],
      workingDirectoryMode: 'project',
      unifiedExec: true,
      historyPersistence: 'none'
    })

    expect(settings.configOverrides).toEqual([
      { key: 'project_doc_max_bytes', value: '0' },
      { key: 'model_context_window', value: '1000000' }
    ])
  })

  it('downgrades unsupported Codex flex service tier settings to standard', () => {
    const structured = buildCodexRuntimeSettings({
      permissionMode: 'chat',
      model: 'gpt-5.5',
      serviceTier: 'flex' as any,
      streamingEffect: true,
      search: true,
      sandbox: 'read-only',
      approval: 'never',
      addDirs: [],
      enableFeatures: [],
      disableFeatures: [],
      configOverrides: [],
      workingDirectoryMode: 'project',
      unifiedExec: true,
      historyPersistence: 'none'
    })
    const legacy = buildCodexRuntimeSettings({
      codex_permission_mode: 'chat',
      codex_model: 'gpt-5.5',
      codex_service_tier: 'flex'
    })

    expect(structured.serviceTier).toBe('standard')
    expect(legacy.serviceTier).toBe('standard')
  })

  it('preserves structured custom working directory settings', () => {
    const settings = buildCodexRuntimeSettings({
      permissionMode: 'chat',
      model: 'gpt-5.4',
      streamingEffect: true,
      search: true,
      sandbox: 'read-only',
      approval: 'never',
      addDirs: [],
      enableFeatures: [],
      disableFeatures: [],
      configOverrides: [],
      workingDirectoryMode: 'custom',
      customWorkingDirectory: ' /Users/example/custom-workdir ',
      unifiedExec: true,
      historyPersistence: 'none'
    })

    expect(settings.workingDirectoryMode).toBe('custom')
    expect(settings.customWorkingDirectory).toBe('/Users/example/custom-workdir')
  })

  it('preserves legacy preset custom working directory settings', () => {
    const settings = buildCodexRuntimeSettings({
      codex_permission_mode: 'chat',
      codex_model: 'gpt-5.4',
      codex_workdir_mode: 'custom',
      codex_custom_workdir: ' /Users/example/preset-workdir '
    })

    expect(settings.workingDirectoryMode).toBe('custom')
    expect(settings.customWorkingDirectory).toBe('/Users/example/preset-workdir')
  })

  it('returns a plain-English validation error for invalid override rows', () => {
    const message = getCodexConfigOverrideValidationError({
      permissionMode: 'chat',
      model: 'gpt-5.4',
      streamingEffect: true,
      search: true,
      sandbox: 'read-only',
      approval: 'never',
      addDirs: [],
      enableFeatures: [],
      disableFeatures: [],
      configOverrides: [
        { key: 'history.persistence', value: '"none"' },
        { key: 'project_doc_max_bytes', value: '0' },
        { key: 'skills.config', value: '[]' },
        { key: 'model_context_window', value: '200000' },
        { key: 'model_context_window', value: '300000' }
      ],
      workingDirectoryMode: 'project',
      unifiedExec: true,
      historyPersistence: 'none'
    })

    expect(message).toContain("can't redefine Batshit-managed settings")
    expect(message).toContain('history.persistence')
    expect(message).toContain('skills.config')
    expect(message).not.toContain('project_doc_max_bytes')
  })
})
