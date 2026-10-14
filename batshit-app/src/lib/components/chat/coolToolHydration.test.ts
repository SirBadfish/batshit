import { describe, expect, it } from 'vitest'
import { guardCutNotice } from '$lib/test-utils/guard-cut-notice'
import { buildHydratedCoolToolStep } from './coolToolHydration'

describe('coolToolHydration', () => {
  it.each([
    ['bash', 'bash', { command: 'printf large-output' }],
    ['read_file', 'read_file', { path: '/tmp/large.txt', command: 'cat /tmp/large.txt' }],
    ['batshit_server_fetch_zip', 'fetch_zip', { zipId: 'raw_1', offset: 0 }]
  ] as const)('keeps a saved model-text cut from %s in the generic renderer', (toolName, operationKind, toolArgs) => {
    const cutText = `Command output\nstdout:\n${'x'.repeat(7900)}\n${guardCutNotice(7_900, 'raw_1')}`
    const hydrated = buildHydratedCoolToolStep({
      type: 'tool', toolName, originalToolName: toolName,
      operationKind, rendererFamily: 'generic_tool', toolArgs,
      toolResult: { content: cutText, modelTextOnly: true },
      metadata: { operationKind, rendererFamily: 'generic_tool' }
    })

    expect(hydrated.operationKind).toBe(operationKind)
    expect(hydrated.rendererFamily).toBe('generic_tool')
    expect(hydrated.metadata.rendererFamily).toBe('generic_tool')
    expect(hydrated.toolResult).toEqual({ content: cutText, modelTextOnly: true })
    expect(hydrated.observation).toEqual(hydrated.toolResult)
  })

  // Review of BL-677: the P2 guard (3ac8f5517) saved cut views of up to 100,000 characters. After
  // the 96,000 ceiling such a card reloaded as a typed card with empty stdout and stderr.
  const p2Notice = guardCutNotice(99_000, 'tool_raw_1790000000000_p2', 400_000)
  const p2View = (length: number) => {
    const header = 'Command output\nstatus: exitCode=0\nstdout:\n'
    return `${header}${'y'.repeat(length - header.length - 1 - p2Notice.length)}\n${p2Notice}`
  }
  const reload = (toolName: string, operationKind: string, toolArgs: Record<string, any>, content: string) =>
    buildHydratedCoolToolStep({
      type: 'tool', toolName, originalToolName: toolName,
      operationKind, rendererFamily: 'generic_tool', toolArgs,
      // The shape the P2 normalizer saved: savedPlainMcpText plus modelTextOnly.
      toolResult: { content, contentLength: content.length, contentTruncated: false, modelTextOnly: true },
      metadata: { operationKind, rendererFamily: 'generic_tool' }
    })

  it.each([
    ['bash', 'bash', { command: 'cat /tmp/huge.log' }],
    ['read_file', 'read_file', { path: '/tmp/huge.log', command: 'cat /tmp/huge.log' }],
    ['batshit_server_fetch_zip', 'fetch_zip', { zipId: 'tool_raw_1790000000000_p2', offset: 0 }]
  ] as const)('reloads a P2-era saved %s cut of 99,500 characters as its cut view', (toolName, operationKind, toolArgs) => {
    const content = p2View(99_500)
    expect(content).toHaveLength(99_500)
    const hydrated = reload(toolName, operationKind, toolArgs, content)
    expect(hydrated.operationKind).toBe(operationKind)
    expect(hydrated.rendererFamily).toBe('generic_tool')
  })

  it('does not stretch the saved ceiling past the old 100,000 characters', () => {
    const hydrated = reload('bash', 'bash', { command: 'cat /tmp/huge.log' }, p2View(100_001))
    expect(hydrated.rendererFamily).toBe('bash')
  })

  it('preserves normalized renderer identity for hydrated native wrapper tool zips', () => {
    const hydrated = buildHydratedCoolToolStep({
      type: 'tool',
      toolName: 'Batshit_Native_Tools',
      displayToolName: 'Skill Read',
      originalToolName: 'Batshit_Native_Tools',
      operationKind: 'skill_read',
      rendererFamily: 'skill_read',
      toolCallId: 'call_skill_read_1',
      toolArgs: { action: 'read', skillId: 'agent-browser' },
      toolResult: {
        action: 'read',
        skillName: 'agent-browser',
        skillMarkdown: '# Agent Browser'
      },
      rawSidecar: {
        status: 'stored',
        zipId: 'zip:raw_skill_read_1'
      },
      metadata: {
        executionTime: 42
      }
    })

    expect(hydrated.toolName).toBe('skill_read')
    expect(hydrated.displayToolName).toBe('Skill Read')
    expect(hydrated.originalToolName).toBe('Batshit_Native_Tools')
    expect(hydrated.operationKind).toBe('skill_read')
    expect(hydrated.rendererFamily).toBe('skill_read')
    expect(hydrated.rawSidecar).toEqual({
      status: 'stored',
      zipId: 'zip:raw_skill_read_1'
    })
    expect(hydrated.metadata.executionTime).toBe(42)
    expect(hydrated.metadata.operationKind).toBe('skill_read')
    expect(hydrated.metadata.rendererFamily).toBe('skill_read')
    expect(hydrated.metadata.rawSidecarZipId).toBe('zip:raw_skill_read_1')
  })

  it('repairs older unknown Batshit_Tools web search zips during hydration', () => {
    const hydrated = buildHydratedCoolToolStep({
      type: 'tool',
      toolName: 'Batshit_Tools',
      originalToolName: 'Batshit_Tools',
      operationKind: 'unknown_tool',
      rendererFamily: 'generic_tool',
      toolArgs: {
        action: 'web_search'
      },
      toolResult: [
        {
          auth: 'service',
          success: true,
          action: 'web_search',
          backend: 'local',
          data: {
            query: 'Docker n8n web search',
            provider: 'exa',
            results: [
              {
                title: 'Docker',
                url: 'https://docs.docker.com/'
              }
            ]
          }
        }
      ]
    })

    expect(hydrated.toolName).toBe('web_search')
    expect(hydrated.displayToolName).toBe('Web Search')
    expect(hydrated.operationKind).toBe('web_search')
    expect(hydrated.rendererFamily).toBe('web_search')
    expect(hydrated.metadata.operationKind).toBe('web_search')
    expect(hydrated.metadata.rendererFamily).toBe('web_search')
  })

  it('uses individual MCP tool names for dynamic MCP use zips during hydration', () => {
    const hydrated = buildHydratedCoolToolStep({
      type: 'tool',
      toolName: 'Batshit_Tools',
      originalToolName: 'Batshit_Tools',
      operationKind: 'dynamic_use',
      rendererFamily: 'generic_tool',
      toolArgs: {
        action: 'dynamic_mcp_use',
        input: {
          toolName: 'mcp_huggingface_search_models',
          params: {
            query: 'text to image'
          }
        }
      },
      toolResult: [
        {
          auth: 'service',
          success: true,
          action: 'dynamic_mcp_use',
          backend: 'local',
          data: {
            success: true,
            toolName: 'mcp_huggingface_search_models',
            result: {
              models: []
            }
          }
        }
      ]
    })

    expect(hydrated.toolName).toBe('mcp_huggingface_search_models')
    expect(hydrated.displayToolName).toBe('mcp_huggingface_search_models')
    expect(hydrated.operationKind).toBe('dynamic_use')
    expect(hydrated.rendererFamily).toBe('generic_tool')
  })
})
