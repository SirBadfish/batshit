import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DatabaseService } from '$lib/services/databaseRedis.server'
import {
  DEFAULT_ZIP_AGENT_CONTROL_ENABLED,
  resolveGlobalZipAgentControlPermission,
  resolveZipAgentControlPermission,
  ZIP_AGENT_CONTROL_EXPERIMENT_FIELD
} from '$lib/utils/zipAgentControlPermission'

/**
 * BL-231: one default for "may the agent zip and unzip itself", and it is OFF.
 *
 * SA-129 DL-06 (BL-1484): the permission is parked. It is ON only when the explicit experiment key
 * `zip_agent_control_experiment` is exactly `true` (the agent's own key over the global one), and
 * no Settings surface reads or writes it. The older `zip_agent_control_enabled` and
 * `zip_control_mode` values are ignored everywhere: Josh's Mac app stored `true` globally and on
 * three agents (most likely the BL-231 first-save bug), and those must read OFF with no reset and no
 * Redis write.
 */
describe('zip agent control permission (BL-231, BL-1484)', () => {
  it('is OFF when nothing is saved', () => {
    expect(DEFAULT_ZIP_AGENT_CONTROL_ENABLED).toBe(false)
    expect(ZIP_AGENT_CONTROL_EXPERIMENT_FIELD).toBe('zip_agent_control_experiment')
    expect(resolveGlobalZipAgentControlPermission(undefined)).toBe(false)
    expect(resolveGlobalZipAgentControlPermission({})).toBe(false)
    expect(resolveZipAgentControlPermission({}, {})).toBe(false)
    expect(resolveZipAgentControlPermission(null, null)).toBe(false)
  })

  it('ignores the legacy keys at both levels: a stored true reads OFF', () => {
    expect(resolveGlobalZipAgentControlPermission({ zip_agent_control_enabled: true })).toBe(false)
    expect(resolveGlobalZipAgentControlPermission({ zip_control_mode: 'agent' })).toBe(false)
    const legacyGlobal = { zip_agent_control_enabled: true, zip_control_mode: 'agent' }
    expect(resolveZipAgentControlPermission({ zip_agent_control_enabled: true }, legacyGlobal)).toBe(false)
    expect(resolveZipAgentControlPermission({ zip_control_mode: 'agent' }, legacyGlobal)).toBe(false)
    expect(resolveZipAgentControlPermission({}, legacyGlobal)).toBe(false)
  })

  it('is ON only when the experiment key is exactly true', () => {
    expect(resolveGlobalZipAgentControlPermission({ zip_agent_control_experiment: true })).toBe(true)
    for (const value of ['true', 1, 'yes', null, undefined, {}]) {
      expect(resolveGlobalZipAgentControlPermission({ zip_agent_control_experiment: value }), String(value)).toBe(false)
    }
  })

  it("lets an agent's experiment key override the global one either way", () => {
    const globalOn = { zip_agent_control_experiment: true }
    const globalOff = { zip_agent_control_experiment: false }
    expect(resolveZipAgentControlPermission({ zip_agent_control_experiment: false }, globalOn)).toBe(false)
    expect(resolveZipAgentControlPermission({ zip_agent_control_experiment: true }, globalOff)).toBe(true)
    expect(resolveZipAgentControlPermission({ zip_agent_control_experiment: true }, {})).toBe(true)
    expect(resolveZipAgentControlPermission({}, globalOn)).toBe(true)
    expect(resolveZipAgentControlPermission({ zip_agent_control_experiment: null }, globalOn)).toBe(true)
    // A legacy agent value never overrides the experiment key.
    expect(resolveZipAgentControlPermission({ zip_agent_control_enabled: false }, globalOn)).toBe(true)
  })

  it('is the rule the compiler uses', () => {
    const compiler = new DatabaseService() as any
    const agents = [
      {},
      { zip_agent_control_experiment: true },
      { zip_agent_control_experiment: false },
      { zip_agent_control_enabled: true },
      { zip_control_mode: 'agent' },
      { zip_agent_control_experiment: null }
    ]
    const globals = [
      undefined,
      {},
      { zip_agent_control_experiment: true },
      { zip_agent_control_experiment: false },
      { zip_agent_control_enabled: true },
      { zip_control_mode: 'agent' }
    ]
    for (const agent of agents) {
      for (const global of globals) {
        expect(compiler.resolveZipControlPermission(agent, global), JSON.stringify({ agent, global })).toBe(
          resolveZipAgentControlPermission(agent, global)
        )
      }
    }
    expect(compiler.resolveZipControlPermission({}, undefined)).toBe(false)
    // Josh's stored shape (2026-10-12): the legacy key true globally and on the agent.
    expect(compiler.resolveZipControlPermission({ zip_agent_control_enabled: true }, { zip_agent_control_enabled: true })).toBe(false)
  })

  // SA-129 P2 (DL-08): the SERVER applies a reply's zip-control block now, at its reply end, and
  // asks the same rule; the chat page applies nothing and keeps no copy of the rule.
  it('is the rule the reply-end step uses, and the chat page has none', () => {
    const step = readFileSync(path.resolve('src/lib/server/services/replyControlFinalize.ts'), 'utf8')
    expect(step).toContain('if (resolveZipAgentControlPermission(input.agent, input.globalZipSettings)) {')
    const page = readFileSync(path.resolve('src/routes/+page.svelte'), 'utf8')
    expect(page).not.toContain('resolveZipControlPermission')
    expect(page).not.toContain('resolveZipAgentControlPermission')
    expect(page).not.toContain("agent?.zip_control_mode === 'agent'")
  })

  // SA-129 DL-06 (BL-1484): the parked permission has no control on any Settings surface.
  it('is offered by no Settings surface', () => {
    const surfaces = [
      'src/lib/components/mcps/GlobalZipControlStrip.svelte',
      'src/lib/components/mcps/GlobalToolGrid.svelte',
      'src/lib/components/mcps/MCPsDropdown.svelte',
      'src/lib/components/settings/agent/AgentMcpDefaultsCard.svelte',
      'src/lib/components/settings/panels/AgentSettingsPanel.svelte'
    ]
    for (const surface of surfaces) {
      const source = readFileSync(path.resolve(surface), 'utf8')
      expect(source, surface).not.toContain('Zip Control Permissions')
      expect(source, surface).not.toContain('onZipAgentControlChange')
      expect(source, surface).not.toContain('onZipControlPermissionChange')
      expect(source, surface).not.toContain('zip_agent_control_experiment')
      expect(source, surface).not.toContain('zip_agent_control_enabled')
    }
  })
})
