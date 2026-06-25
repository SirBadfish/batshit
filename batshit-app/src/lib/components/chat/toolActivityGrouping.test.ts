import { describe, expect, it } from 'vitest'
import { buildToolActivityGroups, formatToolActivityLabel, isToolActivitySegment } from './toolActivityGrouping'

describe('toolActivityGrouping', () => {
  it('detects both inline cool_tool segments and legacy batshit cool-tool zips', () => {
    expect(isToolActivitySegment({ type: 'cool_tool' })).toBe(true)
    expect(isToolActivitySegment({ type: 'batshit', zipType: 'cool_tool' })).toBe(true)
    expect(isToolActivitySegment({ type: 'text' })).toBe(false)
  })

  it('formats canonical renderer families into human labels', () => {
    expect(formatToolActivityLabel({ toolData: { rendererFamily: 'skill_read' } })).toBe('Skill Read')
    expect(formatToolActivityLabel({ toolData: { rendererFamily: 'web_search' } })).toBe('Web Search')
    expect(formatToolActivityLabel({ toolData: { rendererFamily: 'bash' } })).toBe('Bash')
  })

  it('prefers hydrated tool payloads for zip-backed summary labels', () => {
    const coolToolFromZip = new Map([
      ['message-1-cool_tool-0', { rendererFamily: 'web_search' }]
    ])

    expect(
      formatToolActivityLabel(
        {
          type: 'cool_tool',
          zipId: 'message-1-cool_tool-3',
          toolName: 'Native Web Search'
        },
        coolToolFromZip
      )
    ).toBe('Web Search')
  })

  it('normalizes raw inline native tool names into canonical summary labels', () => {
    expect(
      formatToolActivityLabel({
        type: 'cool_tool',
        toolName: 'native_skill',
        intermediateStep: {
          toolName: 'native_skill',
          toolArgs: { action: 'read', skillId: 'agent-browser' },
          toolResult: { action: 'read', skillName: 'Agent Browser' }
        }
      })
    ).toBe('Skill Read')

    expect(
      formatToolActivityLabel({
        type: 'cool_tool',
        toolName: 'native_web_search',
        intermediateStep: {
          toolName: 'native_web_search',
          toolArgs: { query: 'Svelte 5 runes' },
          toolResult: { query: 'Svelte 5 runes', results: [] }
        }
      })
    ).toBe('Web Search')
  })

  it('labels broker use actions with the executed human-readable target', () => {
    expect(
      formatToolActivityLabel({
        type: 'cool_tool',
        toolName: 'sys.cli_tool.list',
        toolData: {
          operationKind: 'fabric_use',
          rendererFamily: 'generic_tool',
          toolName: 'sys.cli_tool.list',
          toolArgs: {
            ref: 'fabric:sys.cli_tool.list',
            target: 'sys.cli_tool.list'
          }
        }
      })
    ).toBe('CLI Tool List')
  })

  it('uses artifact display names for brokered artifact controls', () => {
    expect(
      formatToolActivityLabel({
        type: 'cool_tool',
        toolName: 'native_batshit_tool_use',
        toolData: {
          operationKind: 'fabric_use',
          rendererFamily: 'generic_tool',
          toolName: 'native_batshit_tool_use',
          displayToolName: 'Artifact Logs',
          toolArgs: {
            ref: 'fabric:sys.artifact.run_logs.get',
            target: 'sys.artifact.run_logs.get'
          }
        }
      })
    ).toBe('Artifact Logs')
  })

  it('preserves exact explicit labels for brokered Fabric controls', () => {
    expect(
      formatToolActivityLabel({
        type: 'cool_tool',
        toolName: 'native_batshit_tool_use',
        toolData: {
          operationKind: 'fabric_use',
          rendererFamily: 'generic_tool',
          toolName: 'native_batshit_tool_use',
          displayToolName: 'ComfyUI Workflows',
          toolArgs: {
            ref: 'fabric:sys.comfyui.workflows',
            target: 'sys.comfyui.workflows'
          }
        }
      })
    ).toBe('ComfyUI Workflows')
  })

  it('groups only contiguous tool-activity segments and keeps breaks separate', () => {
    const segments = [
      { type: 'text', content: 'before' },
      { type: 'cool_tool', zipId: 'tool-1', toolData: { rendererFamily: 'skill_read' } },
      { type: 'batshit', zipType: 'cool_tool', id: 'tool-2', name: 'legacy_tool' },
      { type: 'text', content: 'break' },
      { type: 'cool_tool', zipId: 'tool-3', isPending: true, toolData: { rendererFamily: 'web_search' } }
    ]

    const grouped = buildToolActivityGroups(segments, 'message-1')

    expect(grouped.groups.size).toBe(2)
    expect(grouped.continuations.has(2)).toBe(true)
    expect(grouped.continuations.has(4)).toBe(false)

    const firstGroup = grouped.groups.get(1)
    expect(firstGroup?.items).toHaveLength(2)
    expect(firstGroup?.summary).toEqual([
      { label: 'Skill Read', status: 'success' },
      { label: 'Legacy Tool', status: 'success' }
    ])

    const secondGroup = grouped.groups.get(4)
    expect(secondGroup?.summary).toEqual([
      { label: 'Web Search', status: 'loading' }
    ])
  })

  it('hydrates zip-backed group labels and error status from coolToolFromZip', () => {
    const segments = [
      { type: 'cool_tool', zipId: 'message-1-cool_tool-3', toolName: 'Native Web Search' },
      { type: 'cool_tool', zipId: 'message-1-cool_tool-4', toolName: 'Native Skill' }
    ]

    const coolToolFromZip = new Map([
      ['message-1-cool_tool-0', { rendererFamily: 'web_search' }],
      ['message-1-cool_tool-4', { rendererFamily: 'skill_read', error: 'boom' }]
    ])

    const grouped = buildToolActivityGroups(segments, 'message-1', coolToolFromZip)
    const firstGroup = grouped.groups.get(0)

    expect(firstGroup?.summary).toEqual([
      { label: 'Web Search', status: 'success' },
      { label: 'Skill Read', status: 'error' }
    ])
  })
})
