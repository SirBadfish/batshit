/**
 * SA-111 P1 (DL-111-03) — the capability facts on each DCM roster line.
 *
 * Josh's ask #6: a primary agent should be able to pick the right specialist from what it
 * can do, not guess from a name. These tests pin the two things that make that useful and
 * safe: the shape is deterministic (the DCM must not churn between sends), and an unknown
 * value is stated as unknown rather than invented (SA-102's blank-is-not-zero rule).
 */

import { describe, it, expect } from 'vitest'

import {
  buildSubagentRosterCapabilityFragment,
  subagentTypeLabel,
  type SubagentRosterCapabilityInput
} from '../subagentRosterCapabilities'

function nativeToolSettings(overrides: Record<string, any> = {}) {
  return {
    fetchZipEnabled: false,
    dynamicMcpEnabled: false,
    cliToolsEnabled: false,
    artifactRuntimeEnabled: false,
    batshitToolsEnabled: false,
    webSearchEnabled: false,
    bashEnabled: false,
    agentBrowserEnabled: false,
    ...overrides
  } as any
}

function input(overrides: Partial<SubagentRosterCapabilityInput> = {}): SubagentRosterCapabilityInput {
  return {
    scope: {
      subagentType: 'api',
      nativeToolSettings: nativeToolSettings(),
      defaultMcpGateways: null,
      resolvedGateways: [],
      defaultCliToolIds: null,
      resolvedCliToolIds: [],
      defaultMcpToolSelections: null,
      dcmDisplaySettings: { version: 1, groups: {}, tools: {} },
      projectPath: null,
      ...(overrides.scope ?? {})
    } as any,
    capabilities: [],
    gatewayNames: new Map(),
    model: null,
    provider: null,
    threadState: 'none',
    ...overrides
  }
}

describe('subagent roster capability fragment', () => {
  it('names the type, model, tool families, skills, and thread state', () => {
    const fragment = buildSubagentRosterCapabilityFragment(
      input({
        scope: {
          subagentType: 'api',
          nativeToolSettings: nativeToolSettings({
            bashEnabled: true,
            webSearchEnabled: true,
            dynamicMcpEnabled: true,
            cliToolsEnabled: true,
            artifactRuntimeEnabled: true,
            agentBrowserEnabled: true
          }),
          resolvedGateways: ['gw_docker'],
          resolvedCliToolIds: ['tool_a', 'tool_b']
        } as any,
        gatewayNames: new Map([['gw_docker', 'Docker Catalog']]),
        capabilities: [
          { id: 'research', invocation: '/research', type: 'skill' } as any,
          { id: 'summarize', invocation: '/summarize', type: 'prompt' } as any
        ],
        model: 'claude-sonnet-5',
        provider: 'anthropic',
        threadState: 'resumable'
      })
    )

    expect(fragment).toBe(
      'API Subagent; model: anthropic/claude-sonnet-5; tools: Bash, Web Search, MCP (Docker Catalog), CLI tools (2), Artifacts, Agent Browser; skills: /research, /summarize; thread: resumable'
    )
  })

  it('says an n8n Workflow Subagent defines its tools in n8n', () => {
    // Batshit cannot see inside the workflow, so enumerating families would be a guess.
    const fragment = buildSubagentRosterCapabilityFragment(
      input({
        scope: {
          subagentType: 'n8n-workflow',
          nativeToolSettings: nativeToolSettings({ bashEnabled: true, dynamicMcpEnabled: true }),
          resolvedGateways: ['gw_docker']
        } as any
      })
    )

    expect(fragment).toContain('tools: defined in n8n')
    expect(fragment).not.toContain('Bash')
  })

  it('states an unknown model instead of inventing a default', () => {
    expect(buildSubagentRosterCapabilityFragment(input())).toContain('model: not set here')
    expect(buildSubagentRosterCapabilityFragment(input({ model: 'gpt-5.6' }))).toContain(
      'model: gpt-5.6'
    )
  })

  it('reports no tools and no skills honestly', () => {
    const fragment = buildSubagentRosterCapabilityFragment(input())
    expect(fragment).toContain('tools: none')
    expect(fragment).toContain('skills: none')
    expect(fragment).toContain('thread: none')
  })

  it('falls back to a gateway id when the registry has no name for it', () => {
    const fragment = buildSubagentRosterCapabilityFragment(
      input({
        scope: {
          subagentType: 'cli',
          nativeToolSettings: nativeToolSettings({ dynamicMcpEnabled: true }),
          resolvedGateways: ['gw_dangling']
        } as any
      })
    )

    expect(fragment).toContain('MCP (gw_dangling)')
  })

  it('collapses long gateway and skill lists to counts so the DCM stays bounded', () => {
    const fragment = buildSubagentRosterCapabilityFragment(
      input({
        scope: {
          subagentType: 'api',
          nativeToolSettings: nativeToolSettings({ dynamicMcpEnabled: true }),
          resolvedGateways: ['a', 'b', 'c', 'd', 'e']
        } as any,
        capabilities: Array.from({ length: 9 }, (_, index) => ({
          id: `s${index}`,
          invocation: `/skill${index}`,
          type: 'skill'
        })) as any
      })
    )

    expect(fragment).toContain('MCP (5 gateways)')
    expect(fragment).toContain('(+3 more)')
  })

  it('is deterministic for the same inputs', () => {
    const first = buildSubagentRosterCapabilityFragment(input({ model: 'x', threadState: 'resumable' }))
    const second = buildSubagentRosterCapabilityFragment(input({ model: 'x', threadState: 'resumable' }))
    expect(first).toBe(second)
  })

  it('labels every live subagent type', () => {
    expect(subagentTypeLabel('api')).toBe('API Subagent')
    expect(subagentTypeLabel('cli')).toBe('CLI Subagent')
    expect(subagentTypeLabel('n8n-workflow')).toBe('n8n Workflow Subagent')
    expect(subagentTypeLabel('n8n-subnode')).toBe('Subagent')
  })
})
