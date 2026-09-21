import { describe, expect, it } from 'vitest'
import {
  DEFAULT_QUICK_ACTION_WAKE_WORD,
  QUICK_ACTION_IDS,
  QUICK_ACTIONS,
  isSwallowedQuickActionTurn,
  normalizeQuickActionWakeWord,
  quickActionWakeWordProblem,
  resolveJevQuickActionsWakeWord,
  resolveJevQuickActionsWakeWordRequired,
  resolveQuickActionWakeGate,
  quickActionDidText,
  quickActionInvolvesAgent,
  quickActionMarkOf,
  quickActionMarkText,
  quickActionRoutingText,
  quickActionSettingsTabTarget,
  quickActionTellLine,
  readQuickActionMark,
  readQuickActionVerdict,
  resolveJevQuickActionsEnabled
} from '../jevJuiceQuickActions'

/**
 * SA-120 P9 — the browser-safe half of quick actions: the switch reader (absent means OFF),
 * the catalog (every action is a click the user could make; no Goon expression, DL-120-10),
 * the mark on a stored user message, the route's answer, the words the user sees (every number
 * says "confidence"), and the one line the agent reads.
 */

describe('resolveJevQuickActionsEnabled', () => {
  it('is ON only for a stored `true`', () => {
    expect(resolveJevQuickActionsEnabled({ jevJuiceQuickActions: true })).toBe(true)
    expect(resolveJevQuickActionsEnabled({ jevJuiceQuickActions: 'true' })).toBe(false)
    expect(resolveJevQuickActionsEnabled({})).toBe(false)
    expect(resolveJevQuickActionsEnabled(null)).toBe(false)
  })
})

describe('the catalog', () => {
  it('holds six app actions, none of them a Goon expression, a memory write, a DM, or a file', () => {
    expect(QUICK_ACTION_IDS).toEqual(['stop', 'end_voice_mode', 'open_goon_dock', 'close_goon_dock', 'open_settings', 'show_execution_viewer'])
    for (const action of QUICK_ACTIONS) {
      // The ask names the Settings tabs (one is "memory"); the action itself never writes anything.
      expect(action.ask).not.toMatch(/mood|emote|expression|remember|save|send a|delete|write/i)
      expect(action.did).toMatch(/^(stopped|ended|opened|closed) /)
    }
  })

  it('none of the six involves the agent, so none is told (Josh, 2026-09-18); an unknown id is never told', () => {
    for (const id of QUICK_ACTION_IDS) expect(quickActionInvolvesAgent(id)).toBe(false)
    expect(quickActionInvolvesAgent('launch_missiles')).toBe(false)
    expect(quickActionInvolvesAgent(null)).toBe(false)
  })

  it('a swallowed turn is a user message whose mark says only-this; a mixed turn, a reply, or a fake mark is not', () => {
    expect(isSwallowedQuickActionTurn({ role: 'user', metadata: { quickAction: { id: 'stop', onlyThis: true } } })).toBe(true)
    expect(isSwallowedQuickActionTurn({ role: 'user', metadata: { quickAction: { id: 'stop', onlyThis: false } } })).toBe(false)
    expect(isSwallowedQuickActionTurn({ role: 'assistant', metadata: { quickAction: { id: 'stop', onlyThis: true } } })).toBe(false)
    expect(isSwallowedQuickActionTurn({ role: 'user', metadata: { quickAction: { id: 'launch_missiles', onlyThis: true } } })).toBe(false)
    expect(isSwallowedQuickActionTurn({ role: 'user' })).toBe(false)
    expect(isSwallowedQuickActionTurn(null)).toBe(false)
  })
})

describe('readQuickActionMark / readQuickActionVerdict', () => {
  it('reads a stored mark and refuses an unknown action or a broken record', () => {
    expect(readQuickActionMark({ quickAction: { id: 'open_settings', tab: 'voice', confidence: 0.92, onlyThis: true, snapshotId: 'qa_1', at: 't' } })).toEqual({
      id: 'open_settings',
      tab: 'voice',
      confidence: 0.92,
      onlyThis: true,
      snapshotId: 'qa_1',
      at: 't'
    })
    expect(readQuickActionMark({ quickAction: { id: 'launch_missiles', confidence: 1 } })).toBeNull()
    expect(readQuickActionMark({ quickAction: { id: 'stop', confidence: 7, tab: 'nope', onlyThis: 'yes' } })).toEqual({
      id: 'stop',
      tab: null,
      confidence: 1,
      onlyThis: false,
      snapshotId: null,
      at: ''
    })
    expect(readQuickActionMark(null)).toBeNull()
    expect(readQuickActionMark({})).toBeNull()
  })

  it('reads the route answer the same way, and a tab only with open_settings', () => {
    expect(readQuickActionVerdict({ action: 'open_goon_dock', tab: 'voice', onlyThis: true, confidence: 0.98, snapshotId: 'qa_2' })).toEqual({
      action: 'open_goon_dock',
      tab: null,
      onlyThis: true,
      confidence: 0.98,
      snapshotId: 'qa_2'
    })
    expect(readQuickActionVerdict({ action: null, onlyThis: true })).toEqual({ action: null, tab: null, onlyThis: false, confidence: 0, snapshotId: null })
    expect(readQuickActionVerdict('garbage')).toEqual({ action: null, tab: null, onlyThis: false, confidence: 0, snapshotId: null })
    const mark = quickActionMarkOf({ action: 'open_settings', tab: 'goons', onlyThis: false, confidence: 0.9, snapshotId: null }, new Date('2026-09-17T23:00:00.000Z'))
    expect(mark).toEqual({ id: 'open_settings', tab: 'goons', confidence: 0.9, onlyThis: false, snapshotId: null, at: '2026-09-17T23:00:00.000Z' })
    expect(quickActionMarkOf({ action: null, tab: null, onlyThis: false, confidence: 0, snapshotId: null })).toBeNull()
  })
})

describe('the words', () => {
  const mark = { id: 'open_goon_dock' as const, tab: null, confidence: 0.984, onlyThis: true, snapshotId: null, at: '' }

  it('says what Batshit did, by Jev, with a rounded percent that says "confidence"', () => {
    expect(quickActionMarkText(mark)).toBe('Quick action by Jev: opened the Goon Dock (98% confidence)')
    expect(quickActionDidText({ id: 'open_settings', tab: 'voice' })).toBe('opened Settings (Voice)')
    expect(quickActionDidText({ id: 'open_settings', tab: 'goons' })).toBe('opened Settings (3D Goons)')
    expect(quickActionDidText({ id: 'open_settings', tab: null })).toBe('opened Settings')
    expect(quickActionRoutingText(mark, 'Faye')).toBe('Nothing was sent to Faye.')
    expect(quickActionRoutingText({ ...mark, onlyThis: false }, 'Faye')).toBe('The rest went to Faye.')
  })

  it('tells the agent in one line, quoting what was said, and says it was not the agent', () => {
    expect(quickActionTellLine(mark, '  open   the dock ')).toBe(
      'The user said "open the dock" and Batshit opened the Goon Dock for them (a quick action by Jev, not you); that turn never reached you.'
    )
    expect(quickActionTellLine({ ...mark, onlyThis: false }, 'open the dock and tell me a joke')).toBe(
      'In this message the user also asked Batshit to act, and Batshit opened the Goon Dock (a quick action by Jev, not you) before you read it.'
    )
    expect(quickActionTellLine(mark, 'x'.repeat(400))).toContain(`"${'x'.repeat(160)}"`)
  })

  it('maps the Settings tabs to the panel\'s real tab values; general and none open the usual tab', () => {
    expect(quickActionSettingsTabTarget('goons')).toBe('3d-goons')
    expect(quickActionSettingsTabTarget('voice')).toBe('voice')
    expect(quickActionSettingsTabTarget('agents')).toBe('agents')
    expect(quickActionSettingsTabTarget('memory')).toBe('memory')
    expect(quickActionSettingsTabTarget('tools')).toBe('tools')
    expect(quickActionSettingsTabTarget('general')).toBeUndefined()
    expect(quickActionSettingsTabTarget(null)).toBeUndefined()
  })
})

describe('the wake word (SA-120 P9b, Josh 2026-09-18)', () => {
  it('is "Yo" by default and required by default; an unusable stored word reads as the default', () => {
    expect(DEFAULT_QUICK_ACTION_WAKE_WORD).toBe('Yo')
    expect(resolveJevQuickActionsWakeWordRequired({})).toBe(true)
    expect(resolveJevQuickActionsWakeWordRequired(null)).toBe(true)
    expect(resolveJevQuickActionsWakeWordRequired({ jevJuiceQuickActionsWakeWordRequired: false })).toBe(false)
    expect(resolveJevQuickActionsWakeWordRequired({ jevJuiceQuickActionsWakeWordRequired: 'false' })).toBe(true)
    expect(resolveJevQuickActionsWakeWord({})).toBe('Yo')
    expect(resolveJevQuickActionsWakeWord({ jevJuiceQuickActionsWakeWord: '  Hey   Bat ' })).toBe('Hey Bat')
    for (const bad of ['', '   ', 'a'.repeat(25), 'one two three four', 'yo!', 42, null]) {
      expect(normalizeQuickActionWakeWord(bad)).toBe('Yo')
    }
    expect(normalizeQuickActionWakeWord("O'Malley-Bat 2")).toBe("O'Malley-Bat 2")
  })

  it('refuses a bad word on the write side with a reason, and accepts a plain one', () => {
    expect(quickActionWakeWordProblem('Yo')).toBeNull()
    expect(quickActionWakeWordProblem('Hey Bat')).toBeNull()
    expect(quickActionWakeWordProblem('')).toMatch(/cannot be empty/)
    expect(quickActionWakeWordProblem('a'.repeat(25))).toMatch(/24 characters/)
    expect(quickActionWakeWordProblem('yo, now')).toMatch(/plain words/)
  })

  it('gates a turn on the FIRST word, exactly, ignoring case and punctuation, and hands Jev the rest', () => {
    const settings = {}
    expect(resolveQuickActionWakeGate('Yo, hang up!', settings)).toEqual({ said: 'hang up!', stripped: true })
    expect(resolveQuickActionWakeGate('yo hang up', settings)).toEqual({ said: 'hang up', stripped: true })
    expect(resolveQuickActionWakeGate('"Yo." open the dock', settings)).toEqual({ said: 'open the dock', stripped: true })
    expect(resolveQuickActionWakeGate('  YO   open   the dock ', settings)).toEqual({ said: 'open the dock', stripped: true })
    // A misheard wake word is no wake word: the turn goes to the agent (the safe direction).
    expect(resolveQuickActionWakeGate('You hang up', settings)).toBeNull()
    expect(resolveQuickActionWakeGate('Yeah, hang up', settings)).toBeNull()
    expect(resolveQuickActionWakeGate('hang up, yo', settings)).toBeNull()
    expect(resolveQuickActionWakeGate('hang up', settings)).toBeNull()
    // The word alone judges nothing.
    expect(resolveQuickActionWakeGate('Yo', settings)).toBeNull()
    expect(resolveQuickActionWakeGate('Yo!', settings)).toBeNull()
    expect(resolveQuickActionWakeGate('', settings)).toBeNull()
  })

  it('a two-word wake word must match both words; "no wake word" judges the whole turn as spoken', () => {
    const two = { jevJuiceQuickActionsWakeWord: 'Hey Bat' }
    expect(resolveQuickActionWakeGate('hey bat, show the goon', two)).toEqual({ said: 'show the goon', stripped: true })
    expect(resolveQuickActionWakeGate('hey, show the goon', two)).toBeNull()
    expect(resolveQuickActionWakeGate('Hey Bat', two)).toBeNull()
    const off = { jevJuiceQuickActionsWakeWordRequired: false }
    expect(resolveQuickActionWakeGate('hang up', off)).toEqual({ said: 'hang up', stripped: false })
    expect(resolveQuickActionWakeGate('Yo, hang up', off)).toEqual({ said: 'Yo, hang up', stripped: false })
  })
})
