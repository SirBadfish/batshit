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

import { redis } from '$lib/server/redis'
import { syncManagedCliSubagentProfile } from '../cliSubagentProfileSync'

// BL-753: the sync writes only while the Subagent's record exists, so each test's is stored.
async function storeSubagents(...ids: string[]) {
  for (const id of ids) await redis.json.set(`subagent:${id}`, '$', { id, user_id: 'user-1' })
}

describe('syncManagedCliSubagentProfile', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await storeSubagents('codex_cli_subagent', 'claude_cli_subagent')
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
      written: true,
    })
  })
})

describe('syncManagedCliSubagentProfile provider settings (BL-81 review)', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await storeSubagents('zb_sync')
    profileSyncMocks.prepareManagedCodexSubagentProfile.mockResolvedValue({
      profileId: 'batshit_agent_subagent_cli_zb_sync',
      managedConfigHome: '/tmp/codex-home',
      gatewayToolMap: {},
      resolvedGateways: [],
    })
    profileSyncMocks.prepareManagedClaudeSubagentProfile.mockResolvedValue({
      profileId: 'batshit_agent_subagent_cli_zb_sync',
      gatewayToolMap: {},
      resolvedGateways: [],
    })
  })

  // The save-time sync writes the same profile the runner writes before each run, so it must
  // hand the profile the CLI settings (Fetch Zip and Batshit Tools off, SA-064), never the
  // Subagent record's raw toggles, or the file on disk offers what the server refuses.
  const rawToggles = {
    nativeTools: { fetchZipEnabled: true, batshitToolsEnabled: true, bashEnabled: true },
  }

  it.each([
    ['codex', 'openai-codex', 'codex-cli', 'prepareManagedCodexSubagentProfile'],
    ['claude', 'anthropic-claude-cli', 'claude-cli', 'prepareManagedClaudeSubagentProfile'],
  ] as const)('passes the CLI profile settings, not the raw toggles, on %s', async (_lane, provider, model, prepare) => {
    await syncManagedCliSubagentProfile('user-1', {
      id: 'zb_sync',
      user_id: 'user-1',
      displayName: 'ZB Sync',
      subagentType: 'cli',
      primary_model_provider: provider,
      primary_model_name: model,
      provider_specific_settings: rawToggles,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as any)

    const call = profileSyncMocks[prepare].mock.calls[0]?.[0]
    expect(call?.providerSettings?.nativeTools?.fetchZipEnabled).toBe(false)
    expect(call?.providerSettings?.nativeTools?.batshitToolsEnabled).toBe(false)
    expect(call?.providerSettings?.nativeTools?.bashEnabled).toBe(true)
    expect(rawToggles.nativeTools.fetchZipEnabled).toBe(true)
  })
})
