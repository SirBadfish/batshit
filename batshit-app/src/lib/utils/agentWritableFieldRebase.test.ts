import { describe, expect, it } from 'vitest'
import { resolveAgentMemorySettingsDraft } from '$lib/utils/memoryControl'
import { agentWritableConflictLabels, rebaseAgentWritableFields } from '$lib/utils/agentWritableFieldRebase'

/**
 * SA-122 A-1y (BL-1294): Agent Settings rebases the name and the memory settings of a form that holds
 * an edit onto the record read again, leaf by leaf, from the baseline the conflicting save was
 * worked out from. An untouched leaf takes the record's value; an edited leaf keeps the user's value
 * and its baseline takes the record's (so the next save still carries it); a leaf both changed keeps
 * the user's value and is named. Every other field is returned as given.
 */

function form(overrides: { displayName?: string; budgets?: Partial<Record<'on_my_mind' | 'triggers' | 'recalled', number>>; linger?: number; other?: string } = {}) {
  return {
    displayName: overrides.displayName ?? 'Probe',
    show_reasoning: overrides.other === undefined ? false : true,
    other: overrides.other ?? 'unchanged',
    memory_settings: resolveAgentMemorySettingsDraft({
      memory_enabled: true,
      memory_linger_turns: overrides.linger ?? 2,
      memory_lane_budgets: { on_my_mind: 100, triggers: 200, recalled: 300, ...overrides.budgets }
    })
  }
}

describe('rebaseAgentWritableFields (BL-1294)', () => {
  it('A8 keeps a dirty custom Memory floor choice together when the agent selects automatic modes', () => {
    const base = form(), draft = form(), server = form()
    base.memory_settings.window.floorMode = 'custom'; base.memory_settings.window.floorTokens = 64000
    draft.memory_settings.window = { ...base.memory_settings.window, floorTokens: 65000 }
    server.memory_settings.window = { ...base.memory_settings.window, floorMode: 'auto' }
    const result = rebaseAgentWritableFields(draft, base, server, base)
    expect(result.draft.memory_settings.window).toMatchObject({ floorMode: 'custom', floorTokens: 65000 })
    expect(result.base.memory_settings.window).toMatchObject({ floorMode: 'auto', floorTokens: 64000 })
    expect(agentWritableConflictLabels(result.conflicts)).toEqual(['Infinite Session Window'])
  })
  it('the user edited Recalled, the agent changed Awareness: both survive, no conflict', () => {
    const base = form()
    const draft = form({ budgets: { recalled: 350 } })
    const server = form({ budgets: { on_my_mind: 120 } })

    const result = rebaseAgentWritableFields(draft, base, server, base)

    expect(result.draft.memory_settings.budgets).toEqual({ onMyMind: 120, triggers: 200, recalled: 350 })
    expect(result.base.memory_settings.budgets).toEqual({ onMyMind: 120, triggers: 200, recalled: 300 })
    expect(result.baseChanged).toBe(true)
    expect(result.conflicts).toEqual([])
  })

  it('the user and the agent changed the same leaf to different values: the user value is kept and named', () => {
    const base = form()
    const draft = form({ budgets: { on_my_mind: 150 } })
    const server = form({ budgets: { on_my_mind: 130 } })

    const result = rebaseAgentWritableFields(draft, base, server, base)

    expect(result.draft.memory_settings.budgets.onMyMind).toBe(150)
    expect(result.base.memory_settings.budgets.onMyMind).toBe(130)
    expect(result.conflicts).toEqual(['memory_settings.budgets.onMyMind'])
    expect(agentWritableConflictLabels(result.conflicts)).toEqual(['Awareness'])
  })

  it('both changed a leaf to the same value: no conflict, and the next save sends nothing new for it', () => {
    const base = form()
    const draft = form({ budgets: { on_my_mind: 130 } })
    const server = form({ budgets: { on_my_mind: 130 } })

    const result = rebaseAgentWritableFields(draft, base, server, base)

    expect(result.conflicts).toEqual([])
    expect(result.draft.memory_settings).toEqual(result.base.memory_settings)
  })

  it('the agent renamed itself while the user edited memory: the untouched name takes the new name', () => {
    const base = form()
    const draft = form({ linger: 5 })
    const server = form({ displayName: 'Probe 2' })

    const result = rebaseAgentWritableFields(draft, base, server, base)

    expect(result.draft.displayName).toBe('Probe 2')
    expect(result.base.displayName).toBe('Probe 2')
    expect(result.draft.memory_settings.lingerTurns).toBe(5)
    expect(result.base.memory_settings.lingerTurns).toBe(2)
  })

  it('a record equal to the baseline changes nothing (the conflict loop guard reads baseChanged)', () => {
    const base = form()
    const draft = form({ budgets: { recalled: 350 } })

    const result = rebaseAgentWritableFields(draft, base, form(), base)

    expect(result.baseChanged).toBe(false)
    expect(result.draft).toEqual(draft)
    expect(result.base).toEqual(base)
  })

  it('compares from the given (captured) baseline, and keeps every other field of the current baseline and the draft', () => {
    const captured = form()
    const currentBase = { ...form(), other: 'a newer baseline field' }
    const draft = { ...form({ budgets: { recalled: 350 } }), other: 'typed elsewhere' }
    const server = form({ budgets: { triggers: 220 } })

    const result = rebaseAgentWritableFields(draft, captured, server, currentBase)

    expect(result.draft.other).toBe('typed elsewhere')
    expect(result.base.other).toBe('a newer baseline field')
    expect(result.draft.memory_settings.budgets).toEqual({ onMyMind: 100, triggers: 220, recalled: 350 })
    expect(result.base.memory_settings.budgets).toEqual({ onMyMind: 100, triggers: 220, recalled: 300 })
  })

  it('names each conflicting field once, in the Settings words', () => {
    expect(
      agentWritableConflictLabels([
        'displayName',
        'memory_settings.window.floorTokens',
        'memory_settings.window.floorMode',
        'memory_settings.recallLingerTurns'
      ])
    ).toEqual(['Display Name', 'Infinite Session Window', 'Recall Linger'])
  })
})

describe('reasoning display fields stay with their owner', () => {
  // SA-139 R4: the CLI Primary's reasoning-pair rebase left with that lane. An API agent's
  // reasoning display and retention fields were never this rebase's to change.
  const api = (show: boolean | null, preserve: boolean | null) => ({
    ...form(), agentType: 'api', show_reasoning: show, preserve_reasoning: preserve
  })

  it('leaves the API reasoning display and retention group with its existing owner', () => {
    const base = api(true, false)
    const server = api(false, true)
    const result = rebaseAgentWritableFields(base, base, server, base)
    expect(result.draft).toEqual(base)
    expect(result.base).toEqual(base)
    expect(result.baseChanged).toBe(false)
  })
})
