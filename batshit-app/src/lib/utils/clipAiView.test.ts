import { describe, it, expect } from 'vitest'
import {
  buildClipRosterDcmLines,
  buildClipRosterLines,
  compileClipReferencesForAiView,
  formatClipLog,
  CLIP_LOG_UNNAMED_LABEL
} from './clipAiView'

/**
 * SA-109 — the AI view's clip vocabulary.
 *
 * The behaviour these pin is what DL-109-02/03/04 lock: attached clips leave
 * NO marker (their content arrives structurally), departed clips leave exactly
 * one Clip Log at the position they rode, and the roster is the only place the
 * new-vs-persisting question is answered.
 */
describe('compileClipReferencesForAiView', () => {
  const attached = (...ids: string[]) => new Set(ids)

  it('DL-109-02: an attached clip leaves no marker at all', () => {
    const content = 'Look at this\n\n{{batshit-clip:clip_a:::photo.png}}'
    expect(compileClipReferencesForAiView(content, attached('clip_a'))).toBe('Look at this')
  })

  it('DL-109-03: a departed clip becomes a Clip Log at its position', () => {
    const content = 'Look at this\n\n{{batshit-clip:clip_a:::photo.png}}'
    expect(compileClipReferencesForAiView(content, attached())).toBe(
      'Look at this\n\n**(Clip Log: photo.png)**'
    )
  })

  it('keeps a Clip Log inline where the placeholder sat mid-sentence', () => {
    const content = 'Compare {{batshit-clip:clip_a:::a.png}} with the new one.'
    expect(compileClipReferencesForAiView(content, attached())).toBe(
      'Compare **(Clip Log: a.png)** with the new one.'
    )
  })

  it('mixes attached and departed clips in one message', () => {
    const content =
      'Both files\n\n{{batshit-clip:clip_live:::live.md}}\n{{batshit-clip:clip_gone:::gone.md}}'
    expect(compileClipReferencesForAiView(content, attached('clip_live'))).toBe(
      'Both files\n\n**(Clip Log: gone.md)**'
    )
  })

  it('falls back to the clip-name map when the placeholder carries no filename', () => {
    const content = 'ref {{batshit-clip:clip_a}}'
    expect(
      compileClipReferencesForAiView(content, attached(), {
        clipNames: new Map([['clip_a', 'recovered.txt']])
      })
    ).toBe('ref **(Clip Log: recovered.txt)**')
  })

  it('is loudly generic — never silently dropped — for a fully deleted clip', () => {
    const content = 'ref {{batshit-clip:clip_a}}'
    expect(compileClipReferencesForAiView(content, attached())).toBe(
      `ref **(Clip Log: ${CLIP_LOG_UNNAMED_LABEL})**`
    )
  })

  it('handles the legacy block form, including its inline name', () => {
    const content = 'a {{batshit-clip|id:clip_old|name:legacy.md}}body{{/batshit-clip}} b'
    expect(compileClipReferencesForAiView(content, attached())).toBe(
      'a **(Clip Log: legacy.md)** b'
    )
    expect(compileClipReferencesForAiView(content, attached('clip_old'))).toBe('a  b')
  })

  it('returns clip-free content byte-for-byte (clip-free chats pay nothing)', () => {
    const content = 'No clips here.\n\n\n\nDeliberate blank lines kept.'
    expect(compileClipReferencesForAiView(content, attached('clip_a'))).toBe(content)
  })

  it('leaves zip syntax completely untouched', () => {
    const content = 'out {{batshit-zip:zip_1:::10 lines}} {{batshit-clip:clip_a:::x.png}}'
    expect(compileClipReferencesForAiView(content, attached('clip_a'))).toBe(
      'out {{batshit-zip:zip_1:::10 lines}}'
    )
  })

  it('never leaves raw clip syntax behind in either state', () => {
    const content = '{{batshit-clip:clip_a:::a.png}} {{batshit-clip:clip_b:::b.png}}'
    for (const active of [attached(), attached('clip_a'), attached('clip_a', 'clip_b')]) {
      expect(compileClipReferencesForAiView(content, active)).not.toContain('{{batshit-clip')
    }
  })

  it('treats unknown clip state as attached rather than claiming a clip departed', () => {
    const content = 'x {{batshit-clip:clip_a:::a.png}}'
    const compiled = compileClipReferencesForAiView(content, null)
    expect(compiled).toBe('x')
    expect(compiled).not.toContain('Clip Log')
  })

  it('is deterministic — the same stored content always compiles to the same bytes', () => {
    const content = 'x\n\n{{batshit-clip:clip_a:::a.png}}\n{{batshit-clip:clip_b:::b.png}}'
    const once = compileClipReferencesForAiView(content, attached('clip_a'))
    const twice = compileClipReferencesForAiView(content, attached('clip_a'))
    expect(once).toBe(twice)
  })
})

describe('formatClipLog', () => {
  it('uses the locked wording', () => {
    expect(formatClipLog('notes.md')).toBe('**(Clip Log: notes.md)**')
  })
})

describe('buildClipRosterLines / buildClipRosterDcmLines', () => {
  it('DL-109-04: splits Current from Lingering by history membership', () => {
    const roster = buildClipRosterLines({
      entries: [
        {
          clipId: 'clip_old',
          name: 'old-notes.txt',
          attachedToMessageId: 'msg_1',
          messagesUntilUnclip: 3
        },
        { clipId: 'clip_new', name: 'new.png', attachedToMessageId: 'msg_unsaved' }
      ],
      historyMessageIds: new Set(['msg_1'])
    })

    expect(roster.currentLines).toEqual([
      '  - ✅ clip "new.png" (clip_new) — attached with this message'
    ])
    expect(roster.lingeringLines).toEqual([
      '  - 🟢 clip "old-notes.txt" (clip_old) — attached earlier, still active, 3 messages left'
    ])
  })

  it('DL-109-09: a temporarily-unclipped clip is departed and never listed', () => {
    const roster = buildClipRosterLines({
      entries: [
        { clipId: 'clip_hidden', name: 'hidden.png', temporarilyUnclipped: true }
      ],
      historyMessageIds: new Set()
    })
    expect(roster.currentLines).toEqual([])
    expect(roster.lingeringLines).toEqual([])
  })

  it('falls back to the bare id when no filename resolved', () => {
    const roster = buildClipRosterLines({
      entries: [{ clipId: 'clip_x', attachedToMessageId: 'msg_1' }],
      historyMessageIds: new Set(['msg_1'])
    })
    expect(roster.lingeringLines[0]).toContain('clip clip_x — attached earlier')
  })

  it('emits nothing when no clip is attached, so clip-free sends cost zero', () => {
    expect(buildClipRosterDcmLines({ currentLines: [], lingeringLines: [] })).toEqual([])
  })

  it('renders the DCM section with both groups', () => {
    const lines = buildClipRosterDcmLines({
      currentLines: ['  - ✅ clip "a" (clip_a) — attached with this message'],
      lingeringLines: ['  - 🟢 clip "b" (clip_b) — attached earlier, still active']
    })
    expect(lines[0]).toBe('Clips attached (their content is delivered with this message):')
    expect(lines).toContain('- Current (new this message):')
    expect(lines).toContain('- Lingering (from earlier messages):')
  })
})
