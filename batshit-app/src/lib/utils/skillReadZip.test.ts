import { describe, expect, it } from 'vitest'
import { classifyStoredSkillReadZip, isStoredSkillReadZip } from './skillReadZip'

const body = (toolName: string, toolArgs: Record<string, any> = {}) => JSON.stringify({
  schemaVersion: 1, type: 'tool', toolName, toolArgs, toolResult: { content: '# Real saved read' }
})

describe('stored skill identity shares the activation contract (BL-2264)', () => {
  it.each([
    { type: 'cool_tool', metadata: { operationKind: 'skill_read' } },
    { type: 'cool_tool', metadata: { rendererFamily: 'skill_read' } },
    { type: 'cool_tool', metadata: { toolName: 'skill_read' } },
    { type: 'cool_tool', content: body('native_skill', { action: 'invoke', skillId: 'example' }) },
    { type: 'cool_tool', metadata: { operationKind: 'unknown_tool' }, content: body('native_skill', { action: 'read', skillId: 'example', path: 'SKILL.md' }) },
    { type: 'cool_tool', metadata: { operationKind: 'unknown_tool' }, content: JSON.stringify({ operationKind: 'skill_read', toolName: 'native_skill', toolArgs: { action: 'invoke' } }) }
  ])('identifies current and supported legacy skill rows: %j', (zip) => {
    expect(classifyStoredSkillReadZip(zip)).toBe('skill')
    expect(isStoredSkillReadZip(zip)).toBe(true)
  })

  it.each([null, undefined, 'broken', [], {}, { type: 'cool_tool', content: '{broken' },
    { type: 'cool_tool', metadata: { operationKind: 'unknown_tool', toolName: 'unrecognized' } }])('unknown never certifies non-skill: %j', (zip) => {
    expect(classifyStoredSkillReadZip(zip)).toBe('unknown')
  })

  it('accepts a known canonical non-skill lane, preserving metadata precedence', () => {
    expect(classifyStoredSkillReadZip({ type: 'cool_tool', metadata: { operationKind: 'read_file' }, content: body('read_file') })).toBe('non_skill')
    expect(classifyStoredSkillReadZip({ type: 'cool_tool', metadata: { operationKind: 'read_file' }, content: '{legacy malformed body' })).toBe('non_skill')
  })
})
