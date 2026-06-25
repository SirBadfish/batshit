import { describe, expect, it } from 'vitest'
import { buildHydratedCoolToolStep } from './coolToolHydration'

describe('coolToolHydration', () => {
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
