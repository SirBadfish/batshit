import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendManagedSubagentDynamicInfo,
  buildManagedSubagentDynamicInfo,
  resolveManagedSubagentScope,
} from '../subagentRuntimeScope'

const redisMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
}))

const mcpResolverMocks = vi.hoisted(() => ({
  resolveDynamicMcpGatewayScope: vi.fn(),
}))

const cliRegistryMocks = vi.hoisted(() => ({
  resolveCliToolSelectionScope: vi.fn(),
}))

const slashCapabilityMocks = vi.hoisted(() => ({
  getEnabledAgentSlashCapabilities: vi.fn(),
  buildSkillsCommandsDcmLines: vi.fn(),
}))

const dynamicMcpIndexMocks = vi.hoisted(() => ({
  buildDynamicMcpIndex: vi.fn(),
  createDefaultDcmDisplaySettings: vi.fn(() => ({ version: 1, groups: {}, tools: {} })),
  normalizeDcmDisplaySettings: vi.fn((value: any) => value ?? { version: 1, groups: {}, tools: {} }),
}))

const nativeToolMocks = vi.hoisted(() => ({
  resolveNativeToolSettings: vi.fn(),
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    getSession: redisMocks.getSession,
  },
}))

vi.mock('../mcpSelectionResolver', () => ({
  resolveDynamicMcpGatewayScope: mcpResolverMocks.resolveDynamicMcpGatewayScope,
}))

vi.mock('../cliToolRegistry', () => ({
  resolveCliToolSelectionScope: cliRegistryMocks.resolveCliToolSelectionScope,
}))

vi.mock('../slashCommandCapabilities', () => ({
  getEnabledAgentSlashCapabilities: slashCapabilityMocks.getEnabledAgentSlashCapabilities,
  buildSkillsCommandsDcmLines: slashCapabilityMocks.buildSkillsCommandsDcmLines,
}))

vi.mock('../dynamicMcpIndex', () => ({
  buildDynamicMcpIndex: dynamicMcpIndexMocks.buildDynamicMcpIndex,
  createDefaultDcmDisplaySettings: dynamicMcpIndexMocks.createDefaultDcmDisplaySettings,
  normalizeDcmDisplaySettings: dynamicMcpIndexMocks.normalizeDcmDisplaySettings,
}))

vi.mock('../nativeTools', () => ({
  resolveNativeToolSettings: nativeToolMocks.resolveNativeToolSettings,
}))

describe('subagentRuntimeScope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redisMocks.getSession.mockResolvedValue({
      metadata: {
        projectPath: '/Users/example/project-alpha',
      },
    })
    mcpResolverMocks.resolveDynamicMcpGatewayScope.mockResolvedValue({
      resolvedGateways: ['gw-subagent'],
      defaultGateways: ['gw-subagent'],
      source: 'agent',
    })
    cliRegistryMocks.resolveCliToolSelectionScope.mockResolvedValue({
      toolIds: ['cli-one'],
      source: 'agent',
    })
    dynamicMcpIndexMocks.buildDynamicMcpIndex.mockResolvedValue({
      groups: [],
      // SA-096 P4: artifact runtime context now arrives inside the capability index
      // instead of a separate subagent-owned artifact block.
      text: 'mcp_dynamic:\n- CLI Tools\n- Artifact Tools (1 tool):\n  - use.artifact.demo-tool — fields: prompt (string)',
      tokenEstimates: {},
      counts: {},
      threshold: 6,
      schemaHintCaps: {},
    })
    slashCapabilityMocks.getEnabledAgentSlashCapabilities.mockResolvedValue([
      {
        id: 'artifact-creator',
        name: 'artifact-creator',
        displayName: 'Artifact Creator',
        type: 'skill',
        invocation: '/artifact-creator',
        isSystem: true,
        skillId: 'artifact_creator',
      },
    ])
    slashCapabilityMocks.buildSkillsCommandsDcmLines.mockReturnValue([
      'skills_commands:',
      '- /artifact-creator | skill | skillId=artifact_creator',
    ])
    nativeToolMocks.resolveNativeToolSettings.mockReturnValue({
      fetchZipEnabled: true,
      dynamicMcpEnabled: true,
      cliToolsEnabled: true,
      artifactRuntimeEnabled: true,
      batshitToolsEnabled: true,
      agentBrowserEnabled: true,
    })
  })

  it('resolves subagent-owned gateway, CLI, DCM, and project scope without parent defaults', async () => {
    const subagent = {
      id: 'subagent_api',
      user_id: 'josh',
      displayName: 'API Helper',
      subagentType: 'api',
      defaultMCPGateways: ['gw-subagent'],
      defaultMCPToolSelections: ['mcp__demo__tool'],
      defaultTools: ['cli-one'],
      dcmDisplaySettings: {
        version: 1,
        groups: { demo: 'group-only' },
        tools: {},
      },
      provider_specific_settings: {
        nativeTools: {
          dynamicMcpEnabled: true,
          artifactRuntimeEnabled: true,
        },
      },
    } as any

    const result = await resolveManagedSubagentScope({
      userId: 'josh',
      subagent,
      sessionId: 'session_123',
      projectPath: null,
    })

    expect(result.resolvedGateways).toEqual(['gw-subagent'])
    expect(result.resolvedCliToolIds).toEqual(['cli-one'])
    expect(result.defaultMcpToolSelections).toEqual(['mcp__demo__tool'])
    expect(result.projectPath).toBe('/Users/example/project-alpha')
    expect(result.dcmDisplaySettings.groups).toEqual({ demo: 'group-only' })
  })

  it('builds a subagent dynamic info block with subagent-owned MCP, skills, and artifact runtime context', async () => {
    const subagent = {
      id: 'subagent_api',
      user_id: 'josh',
      displayName: 'API Helper',
      subagentType: 'api',
      defaultMCPGateways: ['gw-subagent'],
      defaultTools: ['cli-one'],
      dcmDisplaySettings: {
        version: 1,
        groups: {},
        tools: {},
      },
      provider_specific_settings: {
        nativeTools: {
          dynamicMcpEnabled: true,
          artifactRuntimeEnabled: true,
        },
      },
    } as any

    const result = await buildManagedSubagentDynamicInfo({
      userId: 'josh',
      subagent,
      sessionId: 'session_123',
      projectPath: null,
    })

    expect(result).toContain('==== DYNAMIC INFO (ephemeral - not stored) ====')
    expect(result).toContain('project_path: /Users/example/project-alpha')
    expect(result).toContain('mcp_dynamic:')
    expect(result).toContain('skills_commands:')
    expect(result).toContain('use.artifact.demo-tool')
    // SA-096 P4: the subagent lane scopes the index to its own controls and keeps the
    // Fabric control plane closed (SA-064), rather than building its own artifact block.
    expect(dynamicMcpIndexMocks.buildDynamicMcpIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        toolSelections: null,
        selectedGateways: ['gw-subagent'],
        selectedCliToolIds: ['cli-one'],
        controlAgentId: 'subagent_api',
        runtime: 'api',
        allowFabricControlTools: false,
      }),
    )
    expect(dynamicMcpIndexMocks.buildDynamicMcpIndex).not.toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'subagent_api' }),
    )
  })

  it('appends dynamic info to a compiled subagent prompt without dropping the base prompt', () => {
    const result = appendManagedSubagentDynamicInfo(
      '==== BATSHIT SUB-AGENT SYSTEM PROMPT ====\n\nBase prompt',
      '==== DYNAMIC INFO (ephemeral - not stored) ====\nproject_path: /tmp/demo',
    )

    expect(result).toContain('Base prompt')
    expect(result).toContain('==== DYNAMIC INFO (ephemeral - not stored) ====')
    expect(result).toContain('project_path: /tmp/demo')
  })
})
