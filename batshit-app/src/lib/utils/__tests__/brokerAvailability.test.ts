/**
 * SA-096 P5 — broker availability rules.
 *
 * These assertions pin the three runtimes' registration conditions as they exist in
 * `buildMode3NativeTools` (api), `resolveEnabledMode4InternalHelperTools` (cli), and
 * `buildNativeAutomationPackDcmLines` (n8n). All four call sites now derive their families
 * here, so a change to any registration rule must land here in the same commit.
 *
 * The registration-vs-gate cross-check that proves the api branch still matches what
 * `buildMode3NativeTools` actually registers lives in
 * `src/lib/server/services/__tests__/nativeTools.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import {
  BROKER_FABRIC_BATSHIT_TOOLS_CONTROL_IDS,
  BROKER_FABRIC_FETCH_ZIP_CONTROL_ID,
  isBrokerAvailable,
  isControlIdAllowedByList,
  resolveBrokerFabricAllowedControlIds,
  resolveBrokerFamilies,
  resolveBrokerToolToggles,
  type BrokerToolToggles
} from '$lib/utils/brokerAvailability'

const ALL_OFF: BrokerToolToggles = {
  fetchZipEnabled: false,
  dynamicMcpEnabled: false,
  cliToolsEnabled: false,
  artifactRuntimeEnabled: false,
  batshitToolsEnabled: false,
  agentBrowserEnabled: false
}

describe('resolveBrokerToolToggles', () => {
  it('defaults every broker toggle on when the agent has no native tool settings', () => {
    expect(resolveBrokerToolToggles(null)).toEqual({
      fetchZipEnabled: true,
      dynamicMcpEnabled: true,
      cliToolsEnabled: true,
      artifactRuntimeEnabled: true,
      batshitToolsEnabled: true,
      agentBrowserEnabled: true
    })
  })

  it('reads nested nativeTools settings in preference to flat provider settings', () => {
    const toggles = resolveBrokerToolToggles({
      dynamicMcpEnabled: true,
      nativeTools: { dynamicMcpEnabled: false }
    })
    expect(toggles.dynamicMcpEnabled).toBe(false)
  })

  it('accepts the legacy batshitNativeTools container', () => {
    const toggles = resolveBrokerToolToggles({
      batshitNativeTools: { fetchZipEnabled: false }
    })
    expect(toggles.fetchZipEnabled).toBe(false)
  })

  it('accepts the legacy native* aliases and string booleans', () => {
    const toggles = resolveBrokerToolToggles({
      nativeTools: { nativeCliToolsEnabled: 'off', nativeAgentBrowserEnabled: 'no' }
    })
    expect(toggles.cliToolsEnabled).toBe(false)
    expect(toggles.agentBrowserEnabled).toBe(false)
  })

  it('falls through an unparseable value to the next candidate key', () => {
    const toggles = resolveBrokerToolToggles({
      nativeTools: { dynamicMcpEnabled: 'maybe', nativeDynamicMcpEnabled: false }
    })
    expect(toggles.dynamicMcpEnabled).toBe(false)
  })

  it('inherits artifact runtime from the Batshit Tools toggle for agents saved before it existed', () => {
    const toggles = resolveBrokerToolToggles({
      nativeTools: { batshitToolsEnabled: false }
    })
    expect(toggles.artifactRuntimeEnabled).toBe(false)

    const explicit = resolveBrokerToolToggles({
      nativeTools: { batshitToolsEnabled: false, artifactRuntimeEnabled: true }
    })
    expect(explicit.artifactRuntimeEnabled).toBe(true)
  })
})

describe('resolveBrokerFamilies — api runtime', () => {
  it('mirrors buildMode3NativeTools: no agent_browser family on this lane', () => {
    const families = resolveBrokerFamilies({
      runtime: 'api',
      toggles: { ...ALL_OFF, agentBrowserEnabled: true }
    })
    expect(families).toEqual([])
  })

  it('opens the fabric family from fetch-zip alone', () => {
    const families = resolveBrokerFamilies({
      runtime: 'api',
      toggles: { ...ALL_OFF, fetchZipEnabled: true }
    })
    expect(families).toEqual(['fabric'])
  })

  it('opens the fabric family from Batshit Tools alone', () => {
    const families = resolveBrokerFamilies({
      runtime: 'api',
      toggles: { ...ALL_OFF, batshitToolsEnabled: true }
    })
    expect(families).toEqual(['fabric'])
  })

  it('withholds the fabric family from a subagent that lost Fabric control', () => {
    const families = resolveBrokerFamilies({
      runtime: 'api',
      toggles: { ...ALL_OFF, batshitToolsEnabled: true },
      allowFabricControlTools: false
    })
    expect(families).toEqual([])
  })

  it('withholds the artifact family from a subagent that lost artifact runtime', () => {
    const families = resolveBrokerFamilies({
      runtime: 'api',
      toggles: { ...ALL_OFF, artifactRuntimeEnabled: true },
      allowArtifactRuntimeTools: false
    })
    expect(families).toEqual([])
  })

  it('requires a real CLI Tool selection before opening the cli family', () => {
    const withSelection = resolveBrokerFamilies({
      runtime: 'api',
      toggles: { ...ALL_OFF, cliToolsEnabled: true },
      hasCliTools: true
    })
    expect(withSelection).toEqual(['cli'])

    const withoutSelection = resolveBrokerFamilies({
      runtime: 'api',
      toggles: { ...ALL_OFF, cliToolsEnabled: true },
      hasCliTools: false
    })
    expect(withoutSelection).toEqual([])
  })

  it('treats an unresolved CLI selection as reachable so the gate is never narrower than registration', () => {
    const families = resolveBrokerFamilies({
      runtime: 'api',
      toggles: { ...ALL_OFF, cliToolsEnabled: true }
    })
    expect(families).toEqual(['cli'])
  })
})

describe('resolveBrokerFamilies — cli runtime', () => {
  it('mirrors resolveEnabledMode4InternalHelperTools: fetch-zip is its own helper, not a broker family', () => {
    const families = resolveBrokerFamilies({
      runtime: 'cli',
      toggles: { ...ALL_OFF, fetchZipEnabled: true },
      hasCliTools: false
    })
    expect(families).toEqual([])
  })

  it('includes agent_browser on the managed CLI lane', () => {
    const families = resolveBrokerFamilies({
      runtime: 'cli',
      toggles: { ...ALL_OFF, agentBrowserEnabled: true },
      hasCliTools: false
    })
    expect(families).toEqual(['agent_browser'])
  })

  it('opens the fabric family from Batshit Tools', () => {
    const families = resolveBrokerFamilies({
      runtime: 'cli',
      toggles: { ...ALL_OFF, batshitToolsEnabled: true },
      hasCliTools: false
    })
    expect(families).toEqual(['fabric'])
  })
})

describe('resolveBrokerFamilies — n8n runtime', () => {
  it('advertises the CLI family from the toggle alone, since the pack resolves selections at call time', () => {
    const families = resolveBrokerFamilies({
      runtime: 'n8n',
      toggles: { ...ALL_OFF, cliToolsEnabled: true },
      hasCliTools: false
    })
    expect(families).toEqual(['cli'])
  })

  it('opens fabric from fetch-zip, matching the automation pack DCM', () => {
    const families = resolveBrokerFamilies({
      runtime: 'n8n',
      toggles: { ...ALL_OFF, fetchZipEnabled: true }
    })
    expect(families).toEqual(['fabric'])
  })

  it('does not open fabric from Batshit Tools alone', () => {
    const families = resolveBrokerFamilies({
      runtime: 'n8n',
      toggles: { ...ALL_OFF, batshitToolsEnabled: true }
    })
    expect(families).toEqual([])
  })

  it('lists families in the order the DCM prints them', () => {
    const families = resolveBrokerFamilies({
      runtime: 'n8n',
      toggles: {
        fetchZipEnabled: true,
        dynamicMcpEnabled: true,
        cliToolsEnabled: true,
        artifactRuntimeEnabled: true,
        batshitToolsEnabled: true,
        agentBrowserEnabled: true
      }
    })
    expect(families).toEqual(['mcp', 'cli', 'artifact', 'agent_browser', 'fabric'])
  })
})

describe('isBrokerAvailable — the SA-096 P5 regressions', () => {
  it('reports the broker available with Dynamic MCP off but Fabric live', () => {
    // The original defect: this agent gets native_batshit_tool_search registered, but the
    // compiled prompt gated its instructions on dynamicMcpEnabled and shipped none.
    const toggles = resolveBrokerToolToggles({
      nativeTools: {
        dynamicMcpEnabled: false,
        cliToolsEnabled: false,
        artifactRuntimeEnabled: false,
        fetchZipEnabled: true
      }
    })
    expect(toggles.dynamicMcpEnabled).toBe(false)
    expect(isBrokerAvailable({ runtime: 'api', toggles, hasCliTools: false })).toBe(true)
  })

  it('reports the broker unavailable when every family is off, even with Dynamic MCP on', () => {
    // The mirror defect: ~900 tokens explaining a broker that is not registered.
    const toggles: BrokerToolToggles = { ...ALL_OFF, dynamicMcpEnabled: false }
    expect(isBrokerAvailable({ runtime: 'api', toggles, hasCliTools: false })).toBe(false)
    expect(isBrokerAvailable({ runtime: 'cli', toggles, hasCliTools: false })).toBe(false)
    expect(isBrokerAvailable({ runtime: 'n8n', toggles })).toBe(false)
  })

  it('reports the broker available on every runtime for a default agent', () => {
    const toggles = resolveBrokerToolToggles({})
    expect(isBrokerAvailable({ runtime: 'api', toggles })).toBe(true)
    expect(isBrokerAvailable({ runtime: 'cli', toggles })).toBe(true)
    expect(isBrokerAvailable({ runtime: 'n8n', toggles })).toBe(true)
  })
})

/**
 * SA-096 P4 — the Fabric control-id scope. Both broker registration sites and the DCM
 * capability index read this, so the index's Fabric count is the count the agent can
 * actually reach rather than the registry's full inventory.
 */
describe('resolveBrokerFabricAllowedControlIds', () => {
  const ALL_ON = resolveBrokerToolToggles({})

  it('opens only fetch-zip when Batshit Tools is off', () => {
    const toggles: BrokerToolToggles = { ...ALL_OFF, fetchZipEnabled: true }
    expect(resolveBrokerFabricAllowedControlIds({ toggles })).toEqual([
      BROKER_FABRIC_FETCH_ZIP_CONTROL_ID
    ])
  })

  it('opens the Batshit Tools scope plus the Dynamic MCP pair for a default agent', () => {
    const allowed = resolveBrokerFabricAllowedControlIds({ toggles: ALL_ON })
    expect(allowed).toContain(BROKER_FABRIC_FETCH_ZIP_CONTROL_ID)
    expect(allowed).toContain('sys.mcp.dynamic.find')
    expect(allowed).toContain('sys.mcp.dynamic.use')
    for (const controlId of BROKER_FABRIC_BATSHIT_TOOLS_CONTROL_IDS) {
      expect(allowed).toContain(controlId)
    }
  })

  it('drops the Dynamic MCP pair when Dynamic MCP is off but keeps the rest', () => {
    const allowed = resolveBrokerFabricAllowedControlIds({
      toggles: { ...ALL_ON, dynamicMcpEnabled: false }
    })
    expect(allowed).not.toContain('sys.mcp.dynamic.find')
    expect(allowed).toContain('sys.artifact.*')
  })

  it('closes the control plane for an actor that may not use Fabric', () => {
    const allowed = resolveBrokerFabricAllowedControlIds({
      toggles: ALL_ON,
      allowFabricControlTools: false
    })
    expect(allowed).toEqual([BROKER_FABRIC_FETCH_ZIP_CONTROL_ID])
  })

  it('closes fetch-zip for an actor the automation lane does not serve it to', () => {
    const allowed = resolveBrokerFabricAllowedControlIds({
      toggles: ALL_ON,
      allowFetchZip: false,
      allowFabricControlTools: false
    })
    expect(allowed).toEqual([])
  })

  it('returns nothing when every relevant toggle is off', () => {
    expect(resolveBrokerFabricAllowedControlIds({ toggles: ALL_OFF })).toEqual([])
  })

  // SA-104 P3 — memory controls are a scoped first-party allowance (PA + memory_enabled),
  // outside the broad-control-plane gate, like sys.zip.fetch.
  describe('memory controls (SA-104 P3)', () => {
    it('never includes sys.memory.* by default (memory is opt-in)', () => {
      expect(resolveBrokerFabricAllowedControlIds({ toggles: ALL_ON })).not.toContain('sys.memory.*')
    })

    it('adds sys.memory.* for a memory-enabled primary even when the broad control plane is closed (n8n case)', () => {
      const allowed = resolveBrokerFabricAllowedControlIds({
        toggles: ALL_ON,
        allowFabricControlTools: false,
        memoryControlsEnabled: true
      })
      expect(allowed).toContain('sys.memory.*')
      expect(allowed).not.toContain('sys.artifact.*')
      expect(isControlIdAllowedByList('sys.memory.search', allowed)).toBe(true)
    })

    it('memory controls still require the Batshit Tools toggle', () => {
      const allowed = resolveBrokerFabricAllowedControlIds({
        toggles: { ...ALL_OFF, fetchZipEnabled: true },
        memoryControlsEnabled: true
      })
      expect(allowed).toEqual([BROKER_FABRIC_FETCH_ZIP_CONTROL_ID])
    })

    it('a subagent-style caller (memoryControlsEnabled false/omitted) never sees memory refs', () => {
      const allowed = resolveBrokerFabricAllowedControlIds({
        toggles: ALL_ON,
        allowFabricControlTools: false,
        memoryControlsEnabled: false
      })
      expect(isControlIdAllowedByList('sys.memory.save', allowed)).toBe(false)
    })
  })
})

describe('resolveBrokerFamilies — memory reachability (SA-104 P3)', () => {
  it('opens the fabric family on n8n for a memory-enabled primary with fetch-zip off', () => {
    const toggles: BrokerToolToggles = { ...ALL_OFF, batshitToolsEnabled: true }
    expect(resolveBrokerFamilies({ runtime: 'n8n', toggles })).toEqual([])
    expect(
      resolveBrokerFamilies({ runtime: 'n8n', toggles, memoryControlsEnabled: true })
    ).toEqual(['fabric'])
  })

  it('opens the fabric family on api for a memory-enabled agent with fetch-zip and broad Fabric off', () => {
    const toggles: BrokerToolToggles = { ...ALL_OFF, batshitToolsEnabled: true }
    expect(
      resolveBrokerFamilies({
        runtime: 'api',
        toggles,
        allowFabricControlTools: false,
        memoryControlsEnabled: true
      })
    ).toEqual(['fabric'])
  })

  it('memory alone opens nothing when Batshit Tools is off', () => {
    expect(
      resolveBrokerFamilies({ runtime: 'n8n', toggles: ALL_OFF, memoryControlsEnabled: true })
    ).toEqual([])
  })
})

describe('isControlIdAllowedByList', () => {
  it('matches exact ids and trailing wildcards', () => {
    expect(isControlIdAllowedByList('sys.zip.fetch', ['sys.zip.fetch'])).toBe(true)
    expect(isControlIdAllowedByList('sys.artifact.update', ['sys.artifact.*'])).toBe(true)
    expect(isControlIdAllowedByList('sys.voice.engine.enable', ['sys.artifact.*'])).toBe(false)
  })

  it('treats an empty or missing list as allowing nothing', () => {
    expect(isControlIdAllowedByList('sys.zip.fetch', [])).toBe(false)
    expect(isControlIdAllowedByList('sys.zip.fetch', null)).toBe(false)
  })

  it('does not let a wildcard segment escape its own prefix', () => {
    expect(isControlIdAllowedByList('artifact.abc.field.model.set', ['artifact.*'])).toBe(true)
    expect(isControlIdAllowedByList('use.artifact.demo', ['artifact.*'])).toBe(false)
  })
})
