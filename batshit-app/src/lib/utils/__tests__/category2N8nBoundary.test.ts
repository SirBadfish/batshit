import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'

import {
  getCompatibleSubagentTypesForPrimaryAgent,
  isSubagentCompatibleWithPrimaryAgent,
} from '$lib/utils/subagentType'

/**
 * The n8n boundary after SA-139 R2 (Josh, 2026-10-26, decisions 4, 5 and 16).
 *
 * READ THIS BEFORE DELETING ANY `n8n` STRING.
 *
 * SA-106 retired the n8n PRIMARY agent type; SA-139 R2 retired the n8n WORKFLOW SUBAGENT type
 * (and SA-106's older subnode type with it). Neither retired n8n. n8n remains a TOOL PLATFORM:
 * workflows called as tools or through MCP, Artifact/Upload workflows, and the wake-on-schedule
 * template. These pins keep both halves honest: the removed Subagent type cannot come back as a
 * live type, and the n8n tool paths it once shared code with are still there.
 */
describe('SA-139 R2: the n8n Workflow Subagent type is retired, n8n stays a tool platform', () => {
  it('offers no n8n Subagent type to any Primary type', () => {
    // SA-139 R4/R5: the API Primary is the one live Primary and takes the one live Subagent type;
    // a leftover CLI Primary takes none.
    expect(getCompatibleSubagentTypesForPrimaryAgent('api')).toEqual(['api'])
    expect(getCompatibleSubagentTypesForPrimaryAgent('cli')).toEqual([])
    expect(isSubagentCompatibleWithPrimaryAgent('api', 'n8n-workflow')).toBe(false)
    expect(isSubagentCompatibleWithPrimaryAgent('cli', 'n8n-workflow')).toBe(false)
  })

  it('has no Workflow Subagent lane, wire payload or callback token left in the runner', () => {
    const runner = readFileSync('src/lib/server/services/subagentRunner.ts', 'utf8')
    expect(runner).not.toContain('runWorkflowBackedSubagent')
    expect(runner).not.toContain('callWorkflow')
    expect(runner).not.toContain('subagentPrompts')
    expect(runner).not.toContain('subagent_thread_id')
    expect(existsSync('src/lib/server/services/n8nCallbackTokens.ts')).toBe(false)
  })

  it('keeps the n8n tool-workflow provider on the API tool path', () => {
    // API tools now use the native broker; n8n workflow/instance gateways retain its MCP path.
    const brain = readFileSync('src/lib/server/services/vercelBrain.ts', 'utf8')
    const discovery = readFileSync('src/lib/server/services/mcpGatewayDiscovery.ts', 'utf8')
    expect(brain).toContain('nativeToolService.buildMode3NativeTools({')
    const n8n = discovery.indexOf("case 'n8n-mcp-trigger':")
    const stdio = discovery.indexOf("case 'stdio':", n8n)
    expect(n8n).toBeGreaterThan(-1)
    expect(stdio).toBeGreaterThan(n8n)
    expect(discovery.slice(n8n, stdio)).toContain("case 'n8n-instance-mcp':")
    expect(discovery.slice(n8n, stdio)).toContain('n8nMCPGatewayClient.discoverTools(')
  })
})
