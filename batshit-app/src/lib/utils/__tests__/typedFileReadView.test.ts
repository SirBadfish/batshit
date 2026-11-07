import { describe, expect, it } from 'vitest'
import { emulateFileReadView } from '$lib/utils/shellReadSplit'
import { readFileReadView } from '$lib/utils/fileReadSource'
import { sliceTypedRead, TYPED_READ_MAX_CHARS } from '$lib/utils/typedFileFacts'

/**
 * SA-136 P2b: the `typed` read view (agreed with SA-137). A typed read's copy is shown again by the
 * tool's own line rule; a slice the tool would cut, or one past the end, is never shown as live.
 */
describe('the typed read view', () => {
  it('is read only in its exact shape', () => {
    expect(readFileReadView({ kind: 'typed', startLine: 1, endLine: null })).toEqual({ kind: 'typed', startLine: 1, endLine: null })
    expect(readFileReadView({ kind: 'typed', startLine: 4, endLine: 6 })).toEqual({ kind: 'typed', startLine: 4, endLine: 6 })
    for (const bad of [
      { kind: 'typed', startLine: 0, endLine: null },
      { kind: 'typed', startLine: 4, endLine: 3 },
      { kind: 'typed', startLine: 1.5, endLine: null },
      { kind: 'typed', startLine: 1 },
      { kind: 'typed', startLine: 1, endLine: null, extra: true },
      { kind: 'typed', startLine: '1', endLine: null }
    ]) {
      expect(readFileReadView(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('shows what the tool returns for the same range, by the same rule', () => {
    const text = 'a\nb\r\nc\rd\n'
    expect(emulateFileReadView({ kind: 'typed', startLine: 1, endLine: null }, text)).toBe(text)
    expect(emulateFileReadView({ kind: 'typed', startLine: 2, endLine: 3 }, text)).toBe(sliceTypedRead(text, 2, 2).content)
    expect(emulateFileReadView({ kind: 'typed', startLine: 3, endLine: 100 }, text)).toBe('c\rd\n')
    expect(emulateFileReadView({ kind: 'typed', startLine: 1, endLine: null }, '')).toBe('')
  })

  it('shows nothing live for a range past the end, a cut slice, or a cut long line', () => {
    expect(emulateFileReadView({ kind: 'typed', startLine: 9, endLine: null }, 'a\nb\n')).toBeNull()
    const long = `${'x'.repeat(99)}\n`.repeat(1_000)
    expect(emulateFileReadView({ kind: 'typed', startLine: 1, endLine: null }, long)).toBeNull()
    expect(emulateFileReadView({ kind: 'typed', startLine: 1, endLine: 10 }, long)).toBe(long.slice(0, 1_000))
    expect(emulateFileReadView({ kind: 'typed', startLine: 1, endLine: 1 }, `${'y'.repeat(TYPED_READ_MAX_CHARS + 1)}\n`)).toBeNull()
  })
})
