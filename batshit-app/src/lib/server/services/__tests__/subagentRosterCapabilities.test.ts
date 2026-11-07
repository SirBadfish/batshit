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
      'Subagent; model: anthropic/claude-sonnet-5; tools: Bash, Web Search, MCP (Docker Catalog), CLI tools (2), Artifacts, Agent Browser; skills: /research, /summarize; thread: resumable'
    )
  })

  // SA-139 R5 removed the CLI Subagent, and with it BL-878's "built-in CLI tools" roster line; the
  // Subagent line names its Bash and Web Search from its own toggles.
  it('keeps the Subagent line as it was, byte for byte (SA-139 R6 cut "API" from its label)', () => {
    const line = (toggles: Record<string, boolean>) =>
      buildSubagentRosterCapabilityFragment(
        input({ scope: { subagentType: 'api', nativeToolSettings: nativeToolSettings(toggles) } as any })
      )

    expect(line({ bashEnabled: true, webSearchEnabled: true })).toBe(
      'Subagent; model: not set here; tools: Bash, Web Search; skills: none; thread: none'
    )
    expect(line({ bashEnabled: false, webSearchEnabled: false })).toBe(
      'Subagent; model: not set here; tools: none; skills: none; thread: none'
    )
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
          subagentType: 'api',
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

  it('labels every Subagent by its role (SA-139 R6: one Subagent kind)', () => {
    expect(subagentTypeLabel('api')).toBe('Subagent')
    // SA-139 R2 and R5: a removed type (the n8n types, the CLI Subagent) has no live label.
    expect(subagentTypeLabel('cli')).toBe('Subagent')
    expect(subagentTypeLabel('n8n-workflow')).toBe('Subagent')
    expect(subagentTypeLabel('n8n-subnode')).toBe('Subagent')
  })

  it('delegation limits: names a set time or step limit just before the thread state, and nothing when none is set', () => {
    expect(buildSubagentRosterCapabilityFragment(input())).not.toContain('limits:')
    expect(buildSubagentRosterCapabilityFragment(input({ timeoutSeconds: 1_800 }))).toContain('; limits: 30 minutes; thread: none')
    expect(buildSubagentRosterCapabilityFragment(input({ maxToolSteps: 1 }))).toContain('; limits: 1 tool step; thread: none')
    expect(buildSubagentRosterCapabilityFragment(input({ timeoutSeconds: 86_400, maxToolSteps: 300 }))).toContain(
      '; limits: 24 hours, 300 tool steps; thread: none'
    )
    // A malformed saved value is not invented into a limit.
    expect(buildSubagentRosterCapabilityFragment(input({ timeoutSeconds: 5, maxToolSteps: 0 }))).not.toContain('limits:')
  })
})
