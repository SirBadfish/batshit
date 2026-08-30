import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

import {
  BROKER_RUNTIMES,
  resolveBrokerFamilies,
  resolveBrokerToolToggles,
} from '$lib/utils/brokerAvailability'
import { getCompatibleSubagentTypesForPrimaryAgent } from '$lib/utils/subagentType'
import { isParameterSupportedInN8N } from '$lib/utils/parameterFilter'
import type { ParameterDefinition } from '$lib/data/parameter-schemas'

/**
 * SA-106 — the Category 2 n8n boundary.
 *
 * READ THIS BEFORE DELETING ANY `n8n` STRING.
 *
 * SA-106 retired the n8n PRIMARY AGENT TYPE. It did not retire n8n. n8n remains a
 * first-class TOOL PLATFORM: tool workflows, `n8n Workflow Subagents` (whose parent is
 * an API or CLI agent), MCP/Artifact/Upload workflows, and the Native Tools dispatch
 * surface those callers use. DL-106-01 requires that lane to stay byte-level safe.
 *
 * The problem this file exists to solve: after the retirement, several load-bearing
 * Category 2 contracts LOOK like retired-lane leftovers. SA-106's own recon map got two
 * of them wrong and its adversarial verify pass caught them — both would have shipped a
 * silent Category 2 breakage, and one of them lives on a Settings screen with no other
 * test. Every assertion below is one of those near-misses, pinned in one place with the
 * reason attached, so the next sweep hits a failing test that explains itself instead of
 * a green suite and a broken Tool Grid.
 */
describe('SA-106: n8n survives as a tool platform (Category 2)', () => {
  describe('the broker still has an n8n runtime', () => {
    it('keeps `n8n` in BROKER_RUNTIMES', () => {
      // NEAR-MISS #1. DL-106-10 originally said this union could narrow to
      // ['api','cli'] because Category 2 workflow subagents resolve to 'api'|'cli' in
      // `subagentRuntimeScope.ts`. True of the SERVER COMPILE PATH, and false overall:
      // the Subagent Settings -> Tools grid is a second, independent consumer.
      // `AgentSettingsPanel.getSubagentPresetAgentType` maps an `n8n-workflow` subagent
      // to 'n8n', `AgentMcpDefaultsCard` derives `brokerRuntime: 'n8n'` from that, and
      // feeds it BOTH to `resolveBrokerFamilies` and to the /api/mcp/tools/dcm preview.
      // Narrowing this union breaks that grid silently — it has no test of its own.
      expect(BROKER_RUNTIMES).toContain('n8n')
    })

    it('serves tool families on the n8n runtime for a Category 2 tool grid', () => {
      const toggles = resolveBrokerToolToggles({
        nativeTools: {
          dynamicMcpEnabled: true,
          cliToolsEnabled: true,
          artifactRuntimeEnabled: true,
          agentBrowserEnabled: true,
          fetchZipEnabled: true,
          batshitToolsEnabled: true,
        },
      })

      const families = resolveBrokerFamilies({ runtime: 'n8n', toggles })

      // The Tool Grid renders one row per served family. An empty result would render
      // an n8n Workflow Subagent's Tools tab as having nothing available.
      expect(families.length).toBeGreaterThan(0)
      expect(families).toContain('mcp')
    })
  })

  describe('the subagent taxonomy still pairs n8n workflows with managed parents', () => {
    it('offers `n8n-workflow` to both surviving primary-agent types', () => {
      // If this ever stops being true, n8n Workflow Subagents become uncreatable —
      // which would retire Category 2 by accident.
      expect(getCompatibleSubagentTypesForPrimaryAgent('api')).toContain('n8n-workflow')
      expect(getCompatibleSubagentTypesForPrimaryAgent('cli')).toContain('n8n-workflow')
    })
  })

  describe('n8n model-parameter warnings still resolve', () => {
    it('keeps the `n8n` matrix connection scope working', () => {
      // `MatrixConnectionId` still has an 'n8n' member and `isParameterSupportedInN8N`
      // builds a scope with it. These are the parameter warnings the subagent model
      // card shows for `n8n-workflow` subagents — a model setting that works on an API
      // agent may be ignored inside an n8n Chat Model node, and the user needs telling.
      const supported = {
        name: 'temperature',
        n8nSupported: true,
      } as unknown as ParameterDefinition
      const unsupported = {
        name: 'reasoning_effort',
        n8nSupported: false,
      } as unknown as ParameterDefinition

      expect(isParameterSupportedInN8N(supported)).toBe(true)
      expect(isParameterSupportedInN8N(unsupported)).toBe(false)
    })
  })

  describe('the official Workflow Subagent templates still speak the wire contract', () => {
    const TEMPLATE_DIR =
      '../docs/user-docs/user-templates/batshit-official-n8n-workflow-templates'
    const TEMPLATES = [
      'batshit-n8n-workflow-subagent.json',
      'batshit-docker-n8n-workflow-subagent.json',
    ]

    it("sends primary_agent_type 'n8n' with a subagent actor", () => {
      // NEAR-MISS #2. Both surviving Category 2 templates HARDCODE
      // `primary_agent_type: 'n8n'`, and `nativeTools.ts` maps that value to 'mode2'.
      // Removing 'n8n' from the dispatch context vocabulary — which reads like obvious
      // retired-lane cleanup — breaks every already-imported Workflow Subagent workflow
      // in every user's n8n instance. It costs nothing to keep: every mode3/mode4 gate
      // is already scoped to `actor_type === 'primary'`.
      for (const name of TEMPLATES) {
        const raw = readFileSync(`${TEMPLATE_DIR}/${name}`, 'utf8')
        expect(raw).toContain("primary_agent_type: 'n8n'")
        expect(raw).toContain("actor_type: 'subagent'")
        // Required for subagent actors by the dispatch context schema; a template that
        // stopped sending it would fail every native tool call with INVALID_CONTEXT.
        expect(raw).toContain('parent_agent_id')
      }
    })

    it('does not reference the retired Category 1 primary webhook path', () => {
      // A cheap guard that these two templates never drift into the retired lane.
      for (const name of TEMPLATES) {
        const raw = readFileSync(`${TEMPLATE_DIR}/${name}`, 'utf8')
        expect(raw).not.toContain('batshit_n8n_primary')
      }
    })
  })
})
