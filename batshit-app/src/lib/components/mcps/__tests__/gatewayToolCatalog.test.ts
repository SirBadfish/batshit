import { describe, expect, it } from 'vitest'
import {
  buildGatewayGroupsFromCache,
  buildGatewayGroupsFromToolsResponse,
  resolveGatewayToolGroups
} from '$lib/components/mcps/gatewayToolCatalog'
import type { MCPGateway } from '$lib/types/database'

const gateway: MCPGateway = {
  id: 'docker-gateway',
  name: 'Docker MCP Gateway',
  type: 'docker-catalog',
  enabled: true,
  discoveredTools: [
    'fetch',
    'docker_list_containers',
    'batshit_server_dynamic_mcp_find',
    'youtube_get_transcript',
    'unassigned_tool'
  ],
  toolGroupings: [
    {
      mcpName: 'Fetch',
      toolIds: ['fetch', 'batshit_server_dynamic_mcp_find']
    },
    {
      mcpName: 'Docker Tools',
      toolIds: ['docker_list_containers']
    },
    {
      mcpName: 'YouTube Transcript',
      toolIds: ['youtube_get_transcript']
    }
  ],
  created_at: '2026-05-24T00:00:00.000Z'
}

describe('gatewayToolCatalog', () => {
  it('builds grouped rows from cached gateway discovery metadata', () => {
    const groups = buildGatewayGroupsFromCache(gateway)

    expect(groups.map((group) => group.name)).toEqual([
      'Docker Tools',
      'Fetch',
      'Ungrouped Tools',
      'YouTube Transcript'
    ])
    expect(groups.find((group) => group.name === 'Fetch')?.tools.map((tool) => tool.id)).toEqual([
      'fetch'
    ])
    expect(groups.find((group) => group.name === 'Ungrouped Tools')?.tools).toEqual([
      { id: 'unassigned_tool', name: 'unassigned_tool' }
    ])
  })

  it('builds grouped rows from live tools responses and hides internal helper tools', () => {
    const groups = buildGatewayGroupsFromToolsResponse({
      mcps: [
        {
          id: 'fetch',
          name: 'Fetch',
          tools: [
            { id: 'fetch', name: 'fetch', description: 'Fetch a URL' },
            { id: 'batshit_server_dynamic_mcp_find', name: 'batshit_server_dynamic_mcp_find' }
          ]
        }
      ]
    })

    expect(groups).toEqual([
      {
        id: 'fetch',
        name: 'Fetch',
        iconRef: null,
        tools: [{ id: 'fetch', name: 'fetch', description: 'Fetch a URL' }]
      }
    ])
  })

  it('falls back to cached groups when a live tools response is empty', () => {
    const groups = resolveGatewayToolGroups(gateway, { mcps: [] })

    expect(groups.map((group) => group.name)).toContain('Docker Tools')
    expect(groups.map((group) => group.name)).toContain('Fetch')
  })
})
