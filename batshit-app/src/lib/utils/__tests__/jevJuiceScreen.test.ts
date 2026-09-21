import { describe, expect, it } from 'vitest'
import {
  UNTRUSTED_TEXT_ADVISORY_TEXT,
  UNTRUSTED_TEXT_APPROVAL_HINT,
  UNTRUSTED_TEXT_BADGE_TEXT,
  UNTRUSTED_TEXT_CLIPPED_TEXT,
  UNTRUSTED_TEXT_DM_CARD_TOLD_TEXT,
  UNTRUSTED_TEXT_DRAWER_TOLD_TEXT,
  UNTRUSTED_TEXT_IMPORT_ADVISORY_TEXT,
  UNTRUSTED_TEXT_INLINE_TEXT,
  UNTRUSTED_TEXT_NOTICE_LEAD,
  UNTRUSTED_TEXT_NOTICE_TITLE,
  UNTRUSTED_TEXT_SKILL_NO_FLAG_TEXT,
  UNTRUSTED_TEXT_WAKE_MESSAGE_TOLD_TEXT,
  jevJuiceNoteDetail,
  jevJuiceNoteText,
  readUntrustedTextScreen,
  resolveWakeDmIdsByIndex,
  resolveWakeTurnsByIndex,
  untrustedTextCategoryLines,
  untrustedTextCategoryText,
  untrustedTextConfidenceText,
  untrustedTextFlagDetail,
  untrustedTextFlagLines,
  untrustedTextHarmText,
  untrustedTextImportLines,
  untrustedTextQuote,
  untrustedTextSkippedNote,
  wakeOriginText
} from '$lib/utils/jevJuice'

/**
 * SA-120 P7 — what a surface may draw from a stored incoming-text screen, and the words it uses.
 *
 * The contract every assertion here defends (DL-120-12): "no flag" is NEVER drawable. A screen
 * that raised nothing, a flagged screen with no readable finding, and a screen that was never
 * run all read as `null`, so no badge anywhere can be mistaken for "this text is safe".
 */

/** The stored shape, as `untrustedText.jev.ts` writes it onto a DM record. */
function stored(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    source: 'agent_dm',
    status: 'flagged',
    at: '2026-09-17T09:30:00.000Z',
    findings: [
      { id: 'override', probability: 0.98 },
      { id: 'against_user', probability: 0.71 }
    ],
    severity: 'serious',
    harm: 2,
    record: {
      feature: 'untrusted_text',
      model: 'jev-1.13.0',
      latencyMs: 190,
      usage: null,
      deadlineHit: false,
      status: 'ok',
      questionCount: 4,
      at: '2026-09-17T09:30:00.000Z'
    },
    ...overrides
  }
}

function flaggedView(overrides: Record<string, unknown> = {}) {
  const view = readUntrustedTextScreen(stored(overrides))
  if (!view || view.status !== 'flagged') throw new Error('expected a flagged view')
  return view
}

describe('readUntrustedTextScreen: "no flag" is never drawable', () => {
  it('answers null for a screen that raised nothing, so no surface can call it safe', () => {
    expect(readUntrustedTextScreen(stored({ status: 'no_flag', findings: [], severity: undefined, harm: 0 }))).toBeNull()
    // And on the STATUS alone: a `no_flag` record that somehow carries findings is still
    // nothing to draw. Only `flagged` may ever become a badge.
    expect(readUntrustedTextScreen(stored({ status: 'no_flag' }))).toBeNull()
  })

  it('answers null for a flagged screen with nothing readable in it', () => {
    expect(readUntrustedTextScreen(stored({ findings: [] }))).toBeNull()
    expect(readUntrustedTextScreen(stored({ findings: undefined }))).toBeNull()
    expect(readUntrustedTextScreen(stored({ findings: [{ id: 'made_up', probability: 0.99 }] }))).toBeNull()
    expect(readUntrustedTextScreen(stored({ findings: [{ id: 'override' }] }))).toBeNull()
    expect(readUntrustedTextScreen(stored({ findings: [{ id: 'override', probability: Number.NaN }] }))).toBeNull()
  })

  it('answers null for anything it cannot read at all', () => {
    expect(readUntrustedTextScreen(null)).toBeNull()
    expect(readUntrustedTextScreen(undefined)).toBeNull()
    expect(readUntrustedTextScreen('flagged')).toBeNull()
    expect(readUntrustedTextScreen({})).toBeNull()
    expect(readUntrustedTextScreen(stored({ status: 'something_else' }))).toBeNull()
  })
})

describe('readUntrustedTextScreen: what it keeps', () => {
  it('keeps every readable finding and drops the rest', () => {
    const view = flaggedView({
      findings: [{ id: 'override', probability: 0.98 }, { id: 'made_up', probability: 0.9 }, { id: 'aimed_at_assistant', probability: 0.64 }]
    })
    expect(view.findings.map((finding) => finding.id)).toEqual(['override', 'aimed_at_assistant'])
  })

  it('reads severity, harm, clipping and source, and never guesses one that is missing', () => {
    const full = flaggedView({ clipped: true, source: 'webhook' })
    expect(full.severity).toBe('serious')
    expect(full.harm).toBe(2)
    expect(full.clipped).toBe(true)
    expect(full.source).toBe('webhook')

    const bare = flaggedView({ severity: undefined, harm: undefined, clipped: undefined, source: 'nonsense' })
    expect(bare.severity).toBe('caution')
    expect(bare.harm).toBeNull()
    expect(bare.clipped).toBe(false)
    expect(bare.source).toBe('agent_dm')
    expect(flaggedView({ source: 'skill' }).source).toBe('skill')
  })

  it('keeps a skipped screen and the reason it could not run', () => {
    expect(readUntrustedTextScreen(stored({ status: 'skipped', reason: 'deadline', findings: [] }))).toEqual({
      status: 'skipped',
      reason: 'deadline',
      source: 'agent_dm'
    })
    // A skipped screen with no reason recorded still has to say something, never nothing.
    expect(readUntrustedTextScreen(stored({ status: 'skipped', reason: undefined, findings: [] }))).toEqual({
      status: 'skipped',
      reason: 'master_off',
      source: 'agent_dm'
    })
  })
})

describe('the words a flag uses (Josh, 2026-09-17)', () => {
  it('names each finding as a category, one wording for a message and one for a skill file', () => {
    expect(untrustedTextCategoryText('override', 'agent_dm')).toBe('Potential takeover attempt')
    expect(untrustedTextCategoryText('aimed_at_assistant', 'webhook')).toBe('Potential hidden instructions')
    expect(untrustedTextCategoryText('against_user', 'agent_dm')).toBe('Potentially unwanted request')
    // A skill file IS instructions for the model, so its middle category asks about overreach.
    expect(untrustedTextCategoryText('aimed_at_assistant', 'skill')).toBe('Potential overreach')
    expect(untrustedTextCategoryText('override', 'skill')).toBe('Potential takeover attempt')
  })

  it('says the confidence as a whole percent and ALWAYS with the word', () => {
    expect(untrustedTextConfidenceText({ id: 'override', probability: 0.98 })).toBe('98% confidence')
    expect(untrustedTextConfidenceText({ id: 'override', probability: 0.955 })).toBe('96% confidence')
    expect(untrustedTextConfidenceText({ id: 'override', probability: 0.7 })).toBe('70% confidence')
    expect(untrustedTextConfidenceText({ id: 'override', probability: 1.4 })).toBe('100% confidence')
    expect(untrustedTextConfidenceText({ id: 'override', probability: -0.2 })).toBe('0% confidence')
  })

  it('writes one "Category:" line for one finding, and a list with the word on every line for more', () => {
    expect(untrustedTextCategoryLines(flaggedView({ findings: [{ id: 'aimed_at_assistant', probability: 0.96 }] }))).toEqual([
      'Category: Potential hidden instructions (96% confidence)'
    ])
    expect(untrustedTextCategoryLines(flaggedView())).toEqual([
      'Categories:',
      'Potential takeover attempt (98% confidence)',
      'Potentially unwanted request (71% confidence)'
    ])
    // A newcomer who first meets a list must still learn what the number means: no bare "(98%)".
    for (const line of untrustedTextCategoryLines(flaggedView())) {
      if (line.includes('%')) expect(line).toMatch(/\(\d+% confidence\)$/)
    }
  })

  it('says the potential harm as serious or minor', () => {
    expect(untrustedTextHarmText(flaggedView())).toBe('Potential harm: serious')
    expect(untrustedTextHarmText(flaggedView({ severity: 'caution' }))).toBe('Potential harm: minor')
  })

  it('carries the promise on every surface: a guess, maybe wrong, nothing blocked', () => {
    expect(UNTRUSTED_TEXT_ADVISORY_TEXT).toBe(
      "This is Jev's best guess, and Jev can be wrong. Nothing was blocked; this flag is only to inform you."
    )
    expect(UNTRUSTED_TEXT_IMPORT_ADVISORY_TEXT).toBe(
      "This is Jev's best guess, and Jev can be wrong. Nothing was blocked: the skill is in the form, and saving it is still your call. Read SKILL.md first."
    )
    expect(UNTRUSTED_TEXT_APPROVAL_HINT).toBe(
      'If an approval card follows, read the message before deciding to Approve or Deny.'
    )
    expect(UNTRUSTED_TEXT_DM_CARD_TOLD_TEXT).toBe('The agent that read this DM was told the same.')
    expect(UNTRUSTED_TEXT_DRAWER_TOLD_TEXT).toBe('The agent is told the same when it reads this DM.')
    expect(UNTRUSTED_TEXT_WAKE_MESSAGE_TOLD_TEXT).toBe('The agent was told the same in this turn.')
  })

  it('puts the categories, the harm, the promise, the clipped note, and the closing line in that order', () => {
    expect(untrustedTextFlagLines(flaggedView({ clipped: true }), UNTRUSTED_TEXT_DM_CARD_TOLD_TEXT)).toEqual([
      'Categories:',
      'Potential takeover attempt (98% confidence)',
      'Potentially unwanted request (71% confidence)',
      'Potential harm: serious',
      UNTRUSTED_TEXT_ADVISORY_TEXT,
      UNTRUSTED_TEXT_CLIPPED_TEXT,
      UNTRUSTED_TEXT_DM_CARD_TOLD_TEXT
    ])
    expect(untrustedTextFlagLines(flaggedView())).not.toContain(UNTRUSTED_TEXT_CLIPPED_TEXT)
    expect(untrustedTextFlagDetail(flaggedView(), UNTRUSTED_TEXT_DRAWER_TOLD_TEXT)).toBe(
      untrustedTextFlagLines(flaggedView(), UNTRUSTED_TEXT_DRAWER_TOLD_TEXT).join(' ')
    )
  })

  it('writes the import box with the skill category names and its own closing line', () => {
    const view = flaggedView({
      source: 'skill',
      findings: [{ id: 'against_user', probability: 0.97 }, { id: 'aimed_at_assistant', probability: 0.96 }]
    })
    expect(untrustedTextImportLines(view)).toEqual([
      'Categories:',
      'Potentially unwanted request (97% confidence)',
      'Potential overreach (96% confidence)',
      'Potential harm: serious',
      UNTRUSTED_TEXT_IMPORT_ADVISORY_TEXT
    ])
  })

  it('names Jev, not Jev Juice, as the one that flagged, and never says "clean"', () => {
    expect(UNTRUSTED_TEXT_BADGE_TEXT).toBe('Flagged by Jev')
    expect(UNTRUSTED_TEXT_INLINE_TEXT).toBe('flagged by Jev')
    expect(UNTRUSTED_TEXT_NOTICE_TITLE).toBe('Jev Juice flag')
    expect(UNTRUSTED_TEXT_NOTICE_LEAD).toBe('Jev flagged the wake-up message that started this chat.')
    expect(UNTRUSTED_TEXT_SKILL_NO_FLAG_TEXT).toBe(
      'Jev read SKILL.md and raised no flag. That is not a safety check: still read the skill before you trust it.'
    )
    for (const text of [UNTRUSTED_TEXT_ADVISORY_TEXT, UNTRUSTED_TEXT_IMPORT_ADVISORY_TEXT, UNTRUSTED_TEXT_SKILL_NO_FLAG_TEXT]) {
      expect(text.toLowerCase()).not.toContain('safe.')
      expect(text.toLowerCase()).not.toContain('clean')
    }
  })

  it('quotes the start of a message on one line, subject first, and cuts a long one', () => {
    expect(untrustedTextQuote('Quick one', 'Line one.\n\nLine   two.')).toBe('Quick one · Line one. Line two.')
    expect(untrustedTextQuote('', '   ')).toBe('')
    expect(untrustedTextQuote(null, 'body only')).toBe('body only')
    const long = untrustedTextQuote('Subject', 'word '.repeat(80))
    expect(long.length).toBeLessThanOrEqual(160)
    expect(long.endsWith('…')).toBe(true)
  })

  it('writes the origin line of a woken turn from who wrote the DM, never from Jev', () => {
    expect(wakeOriginText({ kind: 'webhook', name: 'Nightly build' })).toBe(
      'This turn was started by a wake-up message from webhook "Nightly build", not by you.'
    )
    expect(wakeOriginText({ kind: 'agent', name: 'Cooper' })).toBe(
      'This turn was started by a wake-up message from agent "Cooper", not by you.'
    )
    expect(wakeOriginText({ kind: 'schedule', name: 'Morning check' })).toBe(
      'This turn was started by a wake-up message from the schedule "Morning check", not by you.'
    )
    expect(wakeOriginText({ kind: 'agent', name: '   ' })).toContain('agent "unknown"')
    expect(wakeOriginText(null)).toBeNull()
    expect(wakeOriginText(undefined)).toBeNull()
  })

  it('turns a skipped screen into the ordinary Jev Juice miss note, which never claims a send was touched', () => {
    const skipped = readUntrustedTextScreen(stored({ status: 'skipped', reason: 'deadline', findings: [] }))
    if (!skipped || skipped.status !== 'skipped') throw new Error('expected a skipped view')
    const note = untrustedTextSkippedNote(skipped)
    expect(jevJuiceNoteText(note)).toBe('Jev Juice: Incoming text screen skipped')
    expect(jevJuiceNoteDetail(note)).toBe('TypeSafe did not answer in time. This text was not screened.')
    expect(jevJuiceNoteDetail(note)).not.toContain('The message was sent')
  })

  it('uses no em dash anywhere the user reads it', () => {
    const view = flaggedView({ clipped: true })
    const strings = [
      UNTRUSTED_TEXT_BADGE_TEXT,
      UNTRUSTED_TEXT_INLINE_TEXT,
      UNTRUSTED_TEXT_NOTICE_TITLE,
      UNTRUSTED_TEXT_NOTICE_LEAD,
      UNTRUSTED_TEXT_APPROVAL_HINT,
      UNTRUSTED_TEXT_SKILL_NO_FLAG_TEXT,
      ...untrustedTextFlagLines(view, UNTRUSTED_TEXT_DRAWER_TOLD_TEXT),
      ...untrustedTextImportLines({ ...view, source: 'skill' }),
      wakeOriginText({ kind: 'webhook', name: 'x' }) ?? '',
      jevJuiceNoteText(untrustedTextSkippedNote({ status: 'skipped', reason: 'deadline', source: 'agent_dm' })),
      jevJuiceNoteDetail(untrustedTextSkippedNote({ status: 'skipped', reason: 'deadline', source: 'agent_dm' }))
    ]
    for (const text of strings) expect(text).not.toContain('—')
  })
})

describe('resolveWakeTurnsByIndex', () => {
  it('hands the wake-up message itself and every reply of its turn the same DM and message id', () => {
    const messages = [
      { id: 'm1', role: 'user', metadata: { wake: { dmId: 'dm_one' } } },
      { id: 'm2', role: 'assistant', metadata: {} },
      { id: 'm3', role: 'assistant', metadata: {} }
    ]
    expect(resolveWakeTurnsByIndex(messages)).toEqual([
      { dmId: 'dm_one', messageId: 'm1' },
      { dmId: 'dm_one', messageId: 'm1' },
      { dmId: 'dm_one', messageId: 'm1' }
    ])
  })

  it('keeps a wake-up message with no id readable, with a null message id', () => {
    expect(resolveWakeTurnsByIndex([{ role: 'user', metadata: { wake: { dmId: 'dm_one' } } }, { role: 'assistant' }])).toEqual([
      { dmId: 'dm_one', messageId: null },
      { dmId: 'dm_one', messageId: null }
    ])
  })
})

describe('resolveWakeDmIdsByIndex', () => {
  it('hands every reply of a woken turn the DM that started it, and nothing to the user rows', () => {
    const messages = [
      { role: 'user', metadata: { wake: { dmId: 'dm_one' } } },
      { role: 'assistant', metadata: {} },
      { role: 'assistant', metadata: {} }
    ]
    expect(resolveWakeDmIdsByIndex(messages)).toEqual([null, 'dm_one', 'dm_one'])
  })

  it('stops at the next user message, so a typed reply is never blamed on an earlier DM', () => {
    const messages = [
      { role: 'user', metadata: { wake: { dmId: 'dm_one' } } },
      { role: 'assistant' },
      { role: 'user', metadata: {} },
      { role: 'assistant' },
      { role: 'user', metadata: { wake: { dmId: 'dm_two' } } },
      { role: 'assistant' }
    ]
    expect(resolveWakeDmIdsByIndex(messages)).toEqual([null, 'dm_one', null, null, null, 'dm_two'])
  })

  it('ignores a wake id that is not a usable string, and any role that is not a reply', () => {
    const messages = [
      { role: 'user', metadata: { wake: { dmId: '  ' } } },
      { role: 'assistant' },
      { role: 'user', metadata: { wake: { dmId: 42 } } },
      { role: 'assistant' },
      { role: 'user', metadata: { wake: { dmId: '  dm_spaced  ' } } },
      { role: 'system' },
      { role: 'assistant' }
    ]
    expect(resolveWakeDmIdsByIndex(messages)).toEqual([null, null, null, null, null, null, 'dm_spaced'])
    expect(resolveWakeDmIdsByIndex([])).toEqual([])
  })
})
