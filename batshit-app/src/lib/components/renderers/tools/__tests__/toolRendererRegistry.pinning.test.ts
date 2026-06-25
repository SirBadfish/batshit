/**
 * DL-5 behavior-pinning harness for getToolRenderer routing (Gauntlet G-0002 companion).
 *
 * Pins the renderer-resolution behaviors that depend on the registry's two file-local
 * normalizers — normalizeAgentBrowserCommand and the brute-force batshit_server_*
 * prefix loop — plus the priority short-circuits a consolidation could silently break.
 * See toolNameNormalizers.pinning.test.ts for the full consolidation map.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { getToolRenderer } from '../toolRendererRegistry'

const load = async (importer: Promise<any>) => (await importer).default

const renderers = {
  generic: () => load(import('../generic/GenericToolRenderer.svelte')),
  genericMcp: () => load(import('../generic/GenericMCPRenderer.svelte')),
  readFile: () => load(import('../file/ReadFileRenderer.svelte')),
  bash: () => load(import('../command/BashRenderer.svelte')),
  subagent: () => load(import('../subagent/CallSubagentRenderer.svelte')),
  dynamicFind: () => load(import('../mcp/DynamicMcpFindRenderer.svelte')),
  imageGen: () => load(import('../image/ImageGenerationRenderer.svelte')),
  abScreenshot: () => load(import('../image/AgentBrowserScreenshotRenderer.svelte'))
}

// Svelte component trees are slow to transform on first import; warm them once so
// individual routing assertions stay within the default test timeout. Sequentially:
// concurrent first-imports of overlapping Svelte graphs can race module init on
// slow runners (seen on 2-core CI as "from_svg is not a function" from the lucide barrel).
beforeAll(async () => {
  for (const resolve of Object.values(renderers)) {
    await resolve()
  }
}, 120_000)

describe('getToolRenderer — priority short-circuits', () => {
  it('falls back to the generic renderer when toolData is missing', async () => {
    expect(await getToolRenderer('anything', null)).toBe(await renderers.generic())
  })

  it('routes subagent markers to the subagent renderer, except for native tools', async () => {
    expect(await getToolRenderer('foo', { isSubagent: true } as any)).toBe(
      await renderers.subagent()
    )
    // Native tool carve-out: fabric/dynamic-mcp tools are never subagents.
    expect(
      await getToolRenderer('native_fabric_use', { isSubagent: true, toolSource: 'native-tool' } as any)
    ).toBe(await renderers.generic())
  })

  it('honors the dynamic_mcp_find compatibility route via displayToolName', async () => {
    expect(
      await getToolRenderer('whatever', { displayToolName: 'batshit_server_dynamic_mcp_find' } as any)
    ).toBe(await renderers.dynamicFind())
  })

  it('routes provider-native image generation through the special-case table', async () => {
    expect(await getToolRenderer('image_generation', {} as any)).toBe(await renderers.imageGen())
  })

  it('lets an explicit rendererFamily win before source/name sniffing', async () => {
    expect(await getToolRenderer('anything_at_all', { rendererFamily: 'bash' } as any)).toBe(
      await renderers.bash()
    )
  })

  it('routes mcp-gateway tools to the generic MCP renderer', async () => {
    expect(
      await getToolRenderer('github_search_issues', {
        toolSource: 'mcp-gateway',
        toolProvider: 'mcp'
      } as any)
    ).toBe(await renderers.genericMcp())
  })
})

describe('getToolRenderer — normalizeAgentBrowserCommand pins', () => {
  it('routes screenshot results to the Agent Browser screenshot renderer (trim/case/JSON tolerant)', async () => {
    expect(
      await getToolRenderer('native_agent_browser_use', {
        toolResult: { command: 'screenshot' }
      } as any)
    ).toBe(await renderers.abScreenshot())
    expect(
      await getToolRenderer('native_agent_browser_use', {
        toolResult: { command: '  SCREENSHOT  ' }
      } as any)
    ).toBe(await renderers.abScreenshot())
    // JSON-string tool results are parsed before command extraction.
    expect(
      await getToolRenderer('native_agent_browser_use', {
        toolResult: '{"command":"screenshot"}'
      } as any)
    ).toBe(await renderers.abScreenshot())
  })

  it('pins the separator quirk: spaces/hyphens slug to _, so variants do NOT match screenshot', async () => {
    expect(
      await getToolRenderer('native_agent_browser_use', {
        toolResult: { command: 'Screen-Shot' }
      } as any)
    ).toBe(await renderers.generic())
    expect(
      await getToolRenderer('native_agent_browser_use', {
        toolResult: { command: 'screen shot' }
      } as any)
    ).toBe(await renderers.generic())
  })

  it('requires an agent-browser-shaped tool name, not just a screenshot result', async () => {
    expect(
      await getToolRenderer('random_tool', { toolResult: { command: 'screenshot' } } as any)
    ).toBe(await renderers.generic())
  })
})

describe('getToolRenderer — brute-force batshit_server_* prefix loop pins', () => {
  it('extracts the base tool from gateway-prefixed names for batshit-server sources', async () => {
    expect(
      await getToolRenderer('My_n8n_MCP_Trigger_batshit_server_read_file', {
        toolProvider: 'batshit-server'
      } as any)
    ).toBe(await renderers.readFile())
  })

  it('pins the case-sensitivity of the raw includes() check (uppercase prefixed names fall through)', async () => {
    expect(
      await getToolRenderer('My_GW_BATSHIT_SERVER_READ_FILE', {
        toolProvider: 'batshit-server'
      } as any)
    ).toBe(await renderers.generic())
  })
})
