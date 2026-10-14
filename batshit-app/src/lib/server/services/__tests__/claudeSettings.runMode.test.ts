import { describe, expect, it } from 'vitest'

import { buildClaudeRuntimeSettings, resolveClaudeRunMode } from '../claudeSettings'

/**
 * BL-941: the agent's record is the upper bound of a Claude run's mode. A mode that a send carries
 * (the chat bar's `metadata.claudePermissionMode`) can make a run tighter than the record, never
 * looser. Order: `plan` < `default` < `acceptEdits` < `bypassPermissions`, compared after the
 * older values are read (`chat` is `default`, `agent` is `acceptEdits`, `agent_full` is
 * `bypassPermissions`), so the settings name the mode that runs.
 */

function block(permissionMode: string | undefined) {
  return {
    ...(permissionMode === undefined ? {} : { permissionMode }),
    model: 'sonnet',
    addDirs: [],
    allowedTools: [],
    disallowedTools: []
  }
}

type Row = {
  name: string
  sent?: unknown
  record: Record<string, unknown> | null
  mode: 'plan' | 'default' | 'acceptEdits' | 'bypassPermissions'
  limited?: { sentMode: string; ranMode: string }
}

const rows: Row[] = [
  { name: 'condition B: a member whose record holds Ask before edits', sent: 'bypassPermissions', record: block('default'), mode: 'default', limited: { sentMode: 'bypassPermissions', ranMode: 'default' } },
  { name: 'a member whose record holds Edit automatically', sent: 'bypassPermissions', record: block('acceptEdits'), mode: 'acceptEdits', limited: { sentMode: 'bypassPermissions', ranMode: 'acceptEdits' } },
  { name: 'condition C: an older window sends Edit automatically to a record with Plan', sent: 'acceptEdits', record: block('plan'), mode: 'plan', limited: { sentMode: 'acceptEdits', ranMode: 'plan' } },
  { name: 'a sent Edit automatically to a record with Ask before edits', sent: 'acceptEdits', record: block('default'), mode: 'default', limited: { sentMode: 'acceptEdits', ranMode: 'default' } },
  { name: 'a sent Plan to a record with Bypass permissions: Plan runs, no note', sent: 'plan', record: block('bypassPermissions'), mode: 'plan' },
  { name: 'isolated test driver: a sent Ask before edits to a record with Edit automatically', sent: 'default', record: block('acceptEdits'), mode: 'default' },
  { name: 'the same mode: no note', sent: 'bypassPermissions', record: block('bypassPermissions'), mode: 'bypassPermissions' },
  { name: 'no sent mode: the record decides', record: block('plan'), mode: 'plan' },
  { name: 'a sent null is no sent mode', sent: null, record: block('acceptEdits'), mode: 'acceptEdits' },
  { name: 'a sent older value is read first (chat is Ask before edits)', sent: 'chat', record: block('acceptEdits'), mode: 'default' },
  { name: 'a record older value is read first (agent is Edit automatically)', sent: 'bypassPermissions', record: block('agent'), mode: 'acceptEdits', limited: { sentMode: 'bypassPermissions', ranMode: 'acceptEdits' } },
  { name: 'the older record: Plan, a sent Bypass permissions', sent: 'bypassPermissions', record: { claude_permission_mode: 'plan' }, mode: 'plan', limited: { sentMode: 'bypassPermissions', ranMode: 'plan' } }
]

describe('BL-941: the record is the upper bound of a Claude run', () => {
  it.each(rows)('$name', (row) => {
    const settings = buildClaudeRuntimeSettings(
      row.record as any,
      row.sent === undefined ? undefined : { permissionMode: row.sent as any }
    )
    expect(settings.permissionMode).toBe(row.mode)
    expect(settings.modeLimitedByAgentSettings ?? null).toEqual(row.limited ?? null)
  })
})

describe('BL-941: resolveClaudeRunMode reads its own inputs', () => {
  // An unknown value counts as Edit automatically, the reading the old code gave an unknown SENT
  // value and the one Agent Settings shows for an unknown saved value (BL-959 keeps it). As the
  // sent side it can only make a Bypass permissions record tighter, never a tighter record looser.
  it('an unknown value never wins a comparison', () => {
    expect(resolveClaudeRunMode({ recordMode: 'plan', sentMode: 'root' })).toEqual({
      permissionMode: 'plan', modeLimitedByAgentSettings: { sentMode: 'acceptEdits', ranMode: 'plan' }
    })
    expect(resolveClaudeRunMode({ recordMode: 'bypassPermissions', sentMode: 'root' })).toEqual({
      permissionMode: 'acceptEdits', modeLimitedByAgentSettings: null
    })
    expect(resolveClaudeRunMode({ recordMode: 'root' })).toEqual({ permissionMode: 'acceptEdits', modeLimitedByAgentSettings: null })
    expect(resolveClaudeRunMode({ recordMode: 'root', sentMode: 'bypassPermissions' })).toEqual({
      permissionMode: 'acceptEdits', modeLimitedByAgentSettings: { sentMode: 'bypassPermissions', ranMode: 'acceptEdits' }
    })
    expect(resolveClaudeRunMode({ recordMode: 'chat', sentMode: null })).toEqual({ permissionMode: 'default', modeLimitedByAgentSettings: null })
  })
})

describe('BL-941 R1: which settings are the agent block (the old gate)', () => {
  it('a settings bag with a model key keeps its older keys: a saved Plan and a deny list', () => {
    const settings = buildClaudeRuntimeSettings(
      { model: 'sonnet', claude_permission_mode: 'plan', claude_disallowed_tools: ['Bash'] },
      { permissionMode: 'bypassPermissions' }
    )
    expect(settings.permissionMode).toBe('plan')
    expect(settings.disallowedTools).toEqual(['Bash'])
  })
})
