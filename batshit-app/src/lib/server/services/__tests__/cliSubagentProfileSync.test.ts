import { beforeEach, describe, expect, it, vi } from 'vitest'

const profileSyncMocks = vi.hoisted(() => ({
  prepareManagedCodexSubagentProfile: vi.fn(),
  prepareManagedClaudeSubagentProfile: vi.fn(),
  buildAgentProfileId: vi.fn((value: string) => `batshit_agent_${value}`),
}))

vi.mock('$lib/server/services/codexProfileManager', () => ({
  prepareManagedCodexSubagentProfile:
    profileSyncMocks.prepareManagedCodexSubagentProfile,
  buildAgentProfileId: profileSyncMocks.buildAgentProfileId,
}))

vi.mock('$lib/server/services/claudeProfileManager', () => ({
  prepareManagedClaudeSubagentProfile:
    profileSyncMocks.prepareManagedClaudeSubagentProfile,
}))

import { syncManagedCliSubagentProfile } from '../cliSubagentProfileSync'

describe('syncManagedCliSubagentProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    profileSyncMocks.prepareManagedCodexSubagentProfile.mockResolvedValue({
      profileId: 'batshit_agent_subagent_cli_codex_cli_subagent',
      managedConfigHome: '/tmp/codex-home',
      gatewayToolMap: {},
      resolvedGateways: [],
    })
    profileSyncMocks.prepareManagedClaudeSubagentProfile.mockResolvedValue({
      profileId: 'batshit_agent_subagent_cli_claude_cli_subagent',
      gatewayToolMap: {},
      resolvedGateways: [],
    })
  })

  it('writes codex profiles with the native CLI model instead of the codex-cli sentinel', async () => {
    await syncManagedCliSubagentProfile('user-1', {
      id: 'codex_cli_subagent',
      user_id: 'user-1',
      displayName: 'Codex CLI Subagent',
      subagentType: 'cli',
      primary_model_provider: 'openai-codex',
      primary_model_name: 'codex-cli',
      codex_settings: {
        permissionMode: 'chat',
        includeProjectInstructions: true,
        model: 'gpt-5.4',
        streamingEffect: true,
        unifiedExec: true,
        search: true,
        sandbox: 'read-only',
        approval: 'never',
        configScope: 'managed',
        addDirs: [],
        enableFeatures: [],
        disableFeatures: [],
        configOverrides: [],
        workingDirectoryMode: 'project',
        historyPersistence: 'none',
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })

    expect(profileSyncMocks.prepareManagedCodexSubagentProfile).toHaveBeenCalled()
    expect(
      profileSyncMocks.prepareManagedCodexSubagentProfile.mock.calls[0]?.[0]?.runtimeSettings?.model,
    ).toBe('gpt-5.4')
  })

  it('creates claude managed profiles on save using claude-native settings', async () => {
    const result = await syncManagedCliSubagentProfile('user-1', {
      id: 'claude_cli_subagent',
      user_id: 'user-1',
      displayName: 'Claude CLI Subagent',
      subagentType: 'cli',
      primary_model_provider: 'anthropic-claude-cli',
      primary_model_name: 'claude-cli',
      claude_settings: {
        permissionMode: 'default',
        includeCoreSystemPrompt: false,
        includeProjectInstructions: true,
        model: 'sonnet',
        alwaysThinkingEnabled: false,
        addDirs: [],
        allowedTools: [],
        disallowedTools: [],
        configOverrides: [],
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })

    expect(profileSyncMocks.prepareManagedClaudeSubagentProfile).toHaveBeenCalled()
    expect(
      profileSyncMocks.prepareManagedClaudeSubagentProfile.mock.calls[0]?.[0]?.runtimeSettings?.model,
    ).toBe('sonnet')
    expect(result).toMatchObject({
      runtime: 'claude',
      profileId: 'batshit_agent_subagent_cli_claude_cli_subagent',
    })
  })
})
