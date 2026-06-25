/**
 * DL-5 behavior-pinning harness for the tool-name normalizer family (Gauntlet G-0002).
 *
 * Batshit now centralizes reusable tool-name policy in `toolNameNormalization.ts`,
 * but the policies are intentionally named instead of collapsed into one generic
 * slugger. This suite protects both the migrated callers and the remaining
 * higher-level behavior contracts.
 *
 * Current policy map (updated 2026-06-13):
 *   1. canonicalToolName            src/lib/utils/toolRenderMap.ts            (zip policy + renderer lookup)
 *   2. sanitizeForComparison        toolNameNormalization.ts, pinned via detectToolSource
 *   3. normalizeDisplayAliasKey     toolNameFormatter.ts delegates to shared slugToolName
 *   4. normalizeToolNameForLooseMatch toolNameNormalization.ts               (separator-deleting loose match)
 *   5. normalizeAgentBrowserCommandName toolNameNormalization.ts             (command-name policy)
 *   6-8. normalizeName / canonicalizeMode4HelperSegment / collapseAlphaNumeric (+ inline
 *                                   normalizeExplicitOperationKind) src/lib/utils/toolActivityContract.ts
 *                                   (delegates to shared primitives; pinned via resolveToolOperationKind)
 *   9. normalizeToolNameForAiSdkKey toolNameNormalization.ts                 (hyphen-preserving AI SDK tool-map key)
 *
 * Server-side adapters:
 *   - claudeEventAdapter.ts subagent detection is pinned in claudeEventAdapter.test.ts.
 *   - codexEventAdapter.ts subagent and Dynamic MCP checks are pinned in codexEventAdapter.test.ts.
 *
 * Key asymmetries these pins protect (a naive cleanup would flatten them):
 *   - miss-fallthrough: canonicalToolName returns the ORIGINAL string (case preserved);
 *     toolActivityContract's chain always lowercases.
 *   - separators: most slug to '_'; loose matching deletes them; AI SDK keys keep '-'.
 *   - toolSourceDetector's gateway-prefixed lane requires the suffix to be lowercase in the
 *     original name; pure-uppercase names only match via the exact-set lane.
 *   - batshit_tool_use / native_batshit_tool_use intentionally canonicalize to 'unknown'.
 */
import { describe, expect, it } from 'vitest'
import { canonicalToolName } from '$lib/utils/toolRenderMap'
import { detectToolSource } from '$lib/utils/toolSourceDetector'
import {
  formatBatshitToolTargetDisplayName,
  formatToolDisplayName,
  stripGatewayPrefix,
  stripToSuffix
} from '$lib/utils/toolNameFormatter'
import { resolveToolOperationKind } from '$lib/utils/toolActivityContract'
import {
  isDynamicMcpFindToolName,
  isDynamicMcpUseToolName,
  normalizeToolNameForAiSdkKey,
  normalizeToolNameForLooseMatch
} from '$lib/utils/toolNameNormalization'

describe('canonicalToolName (toolRenderMap.ts) — zip policy + renderer lookup key', () => {
  it('returns unknown for missing input', () => {
    expect(canonicalToolName(undefined)).toBe('unknown')
    expect(canonicalToolName('')).toBe('unknown')
  })

  it('pins the exact-alias lane', () => {
    expect(canonicalToolName('batshit_server_read_file')).toBe('read_file')
    expect(canonicalToolName('batshit_server_overwrite_file')).toBe('write_file')
    expect(canonicalToolName('batshit_server_bash_execute')).toBe('execute_command')
    expect(canonicalToolName('native_bash_execute')).toBe('execute_command')
    expect(canonicalToolName('native_batshit_tool_search')).toBe('tool_find')
    expect(canonicalToolName('native_skill')).toBe('skill_reference')
    expect(canonicalToolName('native_skill_reference')).toBe('skill_reference')
    expect(canonicalToolName('claude_web_search')).toBe('web_search')
    expect(canonicalToolName('call_subagent')).toBe('subagent')
    expect(canonicalToolName('mcp_fabric_use')).toBe('fabric_use')
  })

  it('pins the INTENTIONAL batshit_tool_use → unknown mapping', () => {
    // The broker "use" lane is deliberately rendered as unknown/generic — see
    // canonicalToolAliases. A consolidation must keep this or update zip policy too.
    expect(canonicalToolName('batshit_tool_use')).toBe('unknown')
    expect(canonicalToolName('native_batshit_tool_use')).toBe('unknown')
  })

  it('short-circuits ANY name containing subagent_ to subagent, before alias lookup', () => {
    expect(canonicalToolName('mcp.gw.subagent_researcher')).toBe('subagent')
    expect(canonicalToolName('MCP.GW.SUBAGENT_RESEARCHER')).toBe('subagent')
  })

  it('returns the ORIGINAL string unmodified on a miss (case + punctuation preserved)', () => {
    expect(canonicalToolName('My_Custom_Tool')).toBe('My_Custom_Tool')
    expect(canonicalToolName('Research-Helper')).toBe('Research-Helper')
  })

  it('tolerates whitespace, casing, and separator noise via the slug lane', () => {
    expect(canonicalToolName('  Read_File  ')).toBe('read_file')
    expect(canonicalToolName('batshit-server Execute Command')).toBe('execute_command')
  })

  it('strips "Tool execution: … - N lines" summary chrome before lookup', () => {
    expect(canonicalToolName('Tool execution: read_file - 42 lines')).toBe('read_file')
    // Summary-shaped misses still return the original, un-stripped string.
    expect(canonicalToolName('Tool execution: My Fancy Tool - 7 lines')).toBe(
      'Tool execution: My Fancy Tool - 7 lines'
    )
  })
})

describe('detectToolSource (toolSourceDetector.ts) — sanitizeForComparison lanes', () => {
  it('matches gateway-prefixed batshit-server names when the suffix is lowercase', () => {
    expect(detectToolSource({ toolName: 'My_Gateway_batshit_server_read_file' } as any)).toEqual({
      toolProvider: 'batshit-server',
      toolSource: 'direct-attachment',
      isSubagent: false
    })
  })

  it('pins the case-sensitivity quirk: UPPERCASE prefixed names do NOT match the marker lane', () => {
    // sanitizeForComparison lowercases for lookup but the marker lane compares the
    // original-cased suffix against its lowercase form (suffix === suffixLower).
    expect(detectToolSource({ toolName: 'MY_GW_BATSHIT_SERVER_READ_FILE' } as any)).toEqual({
      toolProvider: 'unknown',
      toolSource: 'unknown',
      isSubagent: false
    })
    // …while a pure-uppercase UNPREFIXED name still matches via the exact-set lane.
    expect(detectToolSource({ toolName: 'BATSHIT_SERVER_READ_FILE' } as any).toolProvider).toBe(
      'batshit-server'
    )
  })

  it('collapses punctuation runs to single underscores before set lookup', () => {
    expect(detectToolSource({ toolName: 'batshit.server read file' } as any).toolProvider).toBe(
      'batshit-server'
    )
  })

  it('treats bare base names as batshit-server only without gateway/workflow markers', () => {
    expect(detectToolSource({ toolName: 'read_file' } as any).toolProvider).toBe('batshit-server')
    expect(
      detectToolSource({ toolName: 'read_file', gatewayName: 'My Gateway' } as any)
    ).toEqual({ toolProvider: 'mcp', toolSource: 'mcp-gateway', isSubagent: false })
  })

  it('does not partial-match names that merely contain a base name', () => {
    expect(detectToolSource({ toolName: 'batshit_server_read_file_advanced' } as any).toolProvider).toBe(
      'unknown'
    )
  })

  it('keeps the native_ prefix and provider-native lanes ahead of name sniffing', () => {
    expect(detectToolSource({ toolName: 'native_anything' } as any)).toEqual({
      toolProvider: 'batshit-server',
      toolSource: 'native-tool',
      isSubagent: false
    })
    expect(detectToolSource({ toolName: 'web_search_preview' } as any)).toEqual({
      toolProvider: 'llm-native',
      toolSource: 'provider-native',
      isSubagent: false
    })
  })
})

describe('formatToolDisplayName (toolNameFormatter.ts) — display label normalization', () => {
  it('pins direct alias hits', () => {
    expect(formatToolDisplayName('batshit_server_execute_command')).toBe('Bash')
    expect(formatToolDisplayName('batshit_tool_use')).toBe('Dynamic Tool Use')
    expect(formatToolDisplayName('native_skill')).toBe('Skill Reference')
  })

  it('pins the previously-untested suffix-matching lane (gateway-prefixed names)', () => {
    expect(formatToolDisplayName('my_gateway_batshit_server_read_file')).toBe('Read File')
    expect(formatToolDisplayName('my_gateway_read_file')).toBe('Read File')
    expect(formatToolDisplayName('My Gateway batshit_server_bash_execute')).toBe('Bash')
  })

  it('pins typed-ref and Fabric control labels', () => {
    expect(formatToolDisplayName('fabric:sys.artifact.apply_patch')).toBe('Artifact Edit')
    expect(formatToolDisplayName('fabric:sys.zip.fetch')).toBe('Fetch Zip')
    expect(formatToolDisplayName('artifact:use.artifact.nano_banana_2')).toBe('Artifact Run')
    expect(formatToolDisplayName('sys.voice.engine.start')).toBe('Voice Engine Start')
  })

  it('pins the title-case fallback with brand-casing rules', () => {
    expect(formatToolDisplayName('firecrawl_search')).toBe('Firecrawl Search')
    expect(formatToolDisplayName('N8N_connector')).toBe('n8n Connector')
    expect(formatToolDisplayName('batshit_server_magic_wand')).toBe('batshit-server Magic Wand')
    expect(formatToolDisplayName('')).toBe('')
    expect(formatToolDisplayName(undefined)).toBe('')
  })
})

describe('formatBatshitToolTargetDisplayName (toolNameFormatter.ts)', () => {
  it('resolves only known families/targets and returns null otherwise', () => {
    expect(formatBatshitToolTargetDisplayName('cli:my-tool')).toBeNull()
    expect(formatBatshitToolTargetDisplayName('artifact.goon_widget.field.model.set')).toBe(
      'Artifact Model'
    )
    expect(formatBatshitToolTargetDisplayName('artifact.goon_widget.field.prompt.set')).toBe(
      'Artifact Field'
    )
    expect(formatBatshitToolTargetDisplayName(undefined)).toBeNull()
  })
})

describe('stripGatewayPrefix / stripToSuffix (toolNameFormatter.ts)', () => {
  it('strips a sanitized gateway prefix case-insensitively and returns the SANITIZED remainder', () => {
    expect(stripGatewayPrefix('My_Gateway_read_file', 'My Gateway')).toBe('read_file')
    // The remainder comes from the sanitized name, not the raw input.
    expect(stripGatewayPrefix('My-Gateway read-file', 'My Gateway')).toBe('read_file')
  })

  it('returns the original name when there is no gateway or no usable remainder', () => {
    expect(stripGatewayPrefix('read_file', undefined)).toBe('read_file')
    expect(stripGatewayPrefix('Other_Gateway_read_file', 'My Gateway')).toBe(
      'Other_Gateway_read_file'
    )
    expect(stripGatewayPrefix('My_Gateway_', 'My Gateway')).toBe('My_Gateway_')
  })

  it('stripToSuffix keeps the original-cased tail from the last suffix hit', () => {
    expect(stripToSuffix('My_GW_Batshit_Server_Read_File', 'batshit_server_read_file')).toBe(
      'Batshit_Server_Read_File'
    )
    expect(stripToSuffix('unrelated', 'batshit_server_read_file')).toBe('unrelated')
  })
})

describe('toolActivityContract normalizers — pinned via resolveToolOperationKind', () => {
  it('treats mode4-wrapped helper names exactly like their bare helper names', () => {
    const wrappedEqualsBare = (wrapped: string, bare: string) => {
      expect(resolveToolOperationKind({ toolName: wrapped })).toBe(
        resolveToolOperationKind({ toolName: bare })
      )
    }
    wrappedEqualsBare(
      'mcp.agent-123-mode4-controls.batshit_server_bash_execute',
      'batshit_server_bash_execute'
    )
    wrappedEqualsBare('mcp.agent-123-mode4-controls.native_skill', 'native_skill')
    wrappedEqualsBare(
      'mcp.batshit_gateway_cody-mode4-controls.batshit_tool_search',
      'batshit_tool_search'
    )
  })

  it('lowercases the whole name before segment analysis (normalizeName contract)', () => {
    expect(
      resolveToolOperationKind({ toolName: 'MCP.Agent-123-Mode4-Controls.Batshit_Tool_Search' })
    ).toBe(resolveToolOperationKind({ toolName: 'batshit_tool_search' }))
  })

  it('routes subagent-shaped names to the subagent kind', () => {
    expect(resolveToolOperationKind({ toolName: 'mcp.gw.subagent_helper' })).toBe('subagent')
    expect(resolveToolOperationKind({ toolName: 'call_subagent' })).toBe('subagent')
    expect(resolveToolOperationKind({ toolName: 'x', isSubagent: true })).toBe('subagent')
  })

  it('lets explicit metadata operationKind win, with slug-tolerant validation', () => {
    expect(
      resolveToolOperationKind({ toolName: 'whatever_tool', metadata: { operationKind: 'read_file' } })
    ).toBe('read_file')
    expect(
      resolveToolOperationKind({ toolName: 'whatever_tool', metadata: { operationKind: ' Read-File ' } })
    ).toBe('read_file')
    // Invalid explicit kinds are ignored, not trusted.
    expect(
      resolveToolOperationKind({ toolName: 'call_subagent', metadata: { operationKind: 'nonsense' } })
    ).toBe('subagent')
  })
})

describe('shared toolNameNormalization policies', () => {
  it('keeps loose matching separator-free without preserving dead hyphen literals', () => {
    expect(normalizeToolNameForLooseMatch('batshit-server dynamic_mcp use')).toBe(
      'batshitserverdynamicmcpuse'
    )
    expect(isDynamicMcpUseToolName('batshit-server dynamic_mcp use')).toBe(true)
    expect(isDynamicMcpFindToolName('native_dynamic-mcp-find')).toBe(true)
  })

  it('preserves hyphens for AI SDK tool-map keys', () => {
    expect(normalizeToolNameForAiSdkKey('Research-Helper')).toBe('research-helper')
    expect(normalizeToolNameForAiSdkKey('Research Helper')).toBe('research_helper')
  })
})

describe('cross-implementation disagreement map (the consolidation contract)', () => {
  it('documents how the SAME input diverges across normalizers today', () => {
    // 'Research-Helper' — a plausible subagent/tool display name:
    //   canonicalToolName        → returned as-is (case + hyphen preserved)
    //   formatToolDisplayName    → 'Research Helper' (title case fallback)
    //   normalizeToolNameForAiSdkKey → 'research-helper' (hyphen KEPT)
    //   normalizeToolNameForLooseMatch → 'researchhelper' (separators DELETED)
    expect(canonicalToolName('Research-Helper')).toBe('Research-Helper')
    expect(formatToolDisplayName('Research-Helper')).toBe('Research Helper')
    expect(normalizeToolNameForAiSdkKey('Research-Helper')).toBe('research-helper')
    expect(normalizeToolNameForLooseMatch('Research-Helper')).toBe('researchhelper')

    // 'My_Gateway_batshit_server_read_file' — gateway-prefixed helper:
    //   detectToolSource         → batshit-server (lowercase-suffix marker lane)
    //   canonicalToolName        → miss, returned as-is (no suffix lane there)
    //   formatToolDisplayName    → 'Read File' (suffix alias lane)
    expect(detectToolSource({ toolName: 'My_Gateway_batshit_server_read_file' } as any).toolProvider).toBe(
      'batshit-server'
    )
    expect(canonicalToolName('My_Gateway_batshit_server_read_file')).toBe(
      'My_Gateway_batshit_server_read_file'
    )
    expect(formatToolDisplayName('My_Gateway_batshit_server_read_file')).toBe('Read File')

    // 'batshit_tool_use' — broker use lane:
    //   canonicalToolName        → 'unknown' (intentional)
    //   formatToolDisplayName    → 'Dynamic Tool Use' (real label)
    expect(canonicalToolName('batshit_tool_use')).toBe('unknown')
    expect(formatToolDisplayName('batshit_tool_use')).toBe('Dynamic Tool Use')
  })
})
