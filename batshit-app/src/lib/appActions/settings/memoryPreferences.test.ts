import { describe, expect, it } from 'vitest'
import { memoryWindowModes } from './memoryPreferences'
import { validateMemoryChanges, validateOwnUpdate } from './validation'

describe('finite ready-only Memory request and active mode source', () => {
  it('retains zero numeric choices and admits only a boolean and automatic window', () => {
    expect(validateMemoryChanges({ enabled: false, windowMode: 'auto', recalled: 0 })).toEqual({ enabled: false, windowMode: 'auto', recalled: 0 })
    expect(validateMemoryChanges({ enabled: true })).toEqual({ enabled: true })
  })
  it('retains the legacy own-memory alias five-field surface while managed validation admits ready-only choices', () => {
    const before = { subjectAgentId: 'a', expectedRevision: `sha256:${'a'.repeat(64)}` }
    for (const changes of [{ enabled: false }, { windowMode: 'auto' }]) {
      expect(() => validateOwnUpdate({ ...before, changes }, 'memory')).toThrow('invalid_arguments')
      expect(validateMemoryChanges(changes)).toEqual(changes)
    }
    expect(validateOwnUpdate({ ...before, changes: { recalled: 0 } }, 'memory')).toMatchObject({ changes: { recalled: 0 } })
  })
  it.each([{}, { enabled: null }, { enabled: 'true' }, { windowMode: null }, { windowMode: 'custom' }, { floorMode: 'auto' }, { summaryModel: 'current' }, { recalled: -1 }, { triggerLingerTurns: 0.5 }])('refuses nonfinite or unselected changes %j', changes => {
    expect(() => validateMemoryChanges(changes)).toThrow()
  })
  it('uses a nonnull canonical object before the legacy alias and retains a mixed pair', () => {
    expect(memoryWindowModes(['object', 'object'], ['custom', 'auto', 'auto', 'custom'])).toEqual({ root: '$.memory_window', floorMode: 'custom', ceilingHeadroomMode: 'auto', windowMode: 'mixed' })
    expect(memoryWindowModes(['null', 'object'], [undefined, undefined, 'custom', 'custom'])).toEqual({ root: '$.memoryWindow', floorMode: 'custom', ceilingHeadroomMode: 'custom', windowMode: 'custom' })
  })
  it('keeps factory absent/null automatic and refuses malformed active containers or mode leaves', () => {
    expect(memoryWindowModes(['', ''], [])).toMatchObject({ floorMode: 'auto', ceilingHeadroomMode: 'auto', windowMode: 'auto' })
    expect(() => memoryWindowModes(['array', 'object'], [])).toThrow('container')
    expect(() => memoryWindowModes(['object', ''], ['bad'])).toThrow('mode')
    expect(memoryWindowModes(['object', 'array'], ['auto', null])).toMatchObject({ windowMode: 'auto' })
  })
})
