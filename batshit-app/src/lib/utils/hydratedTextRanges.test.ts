import { describe, expect, it } from 'vitest'
import { projectRemovedTextRanges, replaceTextRanges } from './hydratedTextRanges'

describe('structural hydration ranges', () => {
  it('shifts later hydration, splits a replacement, and gives inserted bytes no trust', () => {
    expect(replaceTextRanges([{ start: 2, end: 9 }, { start: 12, end: 15 }], 4, 6, 3)).toEqual([
      { start: 2, end: 4 }, { start: 7, end: 10 }, { start: 13, end: 16 }
    ])
  })
  it('keeps trustworthy text through whitespace/control removals and refuses inserted text', () => {
    expect(projectRemovedTextRanges(' X\n\n\n<img> Y ', 'X\n\n<img> Y', [{ start: 5, end: 10 }])).toEqual([{ start: 3, end: 8 }])
    expect(projectRemovedTextRanges('a<img>b', 'a<image>b', [{ start: 1, end: 6 }])).toEqual([])
  })
  it('cannot borrow trust from a matching tag in a removed raw or hydrated part', () => {
    expect(projectRemovedTextRanges('<img><img>', '<img>', [{ start: 5, end: 10 }])).toEqual([])
    expect(projectRemovedTextRanges('<img><img>', '<img>', [{ start: 0, end: 5 }])).toEqual([])
  })
  it('never grants a character trust if any possible deletion mapping places it in raw text', () => {
    // Enumerate every subsequence of several repeated-character strings. The oracle retains
    // all possible source alignments, independent of the implementation's two greedy bounds.
    for (const before of ['ababa', 'aaaab', 'aababb', '<><><>']) {
      const possibilities = new Map<string, number[][]>()
      for (let mask = 1; mask < 2 ** before.length; mask++) {
        const positions = [...before].flatMap((_, i) => (mask & (1 << i)) ? [i] : [])
        const after = positions.map((i) => before[i]).join('')
        possibilities.set(after, [...(possibilities.get(after) ?? []), positions])
      }
      for (let start = 0; start < before.length; start++) for (let end = start + 1; end <= before.length; end++) {
        for (const [after, mappings] of possibilities) {
          const ranges = projectRemovedTextRanges(before, after, [{ start, end }])
          for (const range of ranges) for (let i = range.start; i < range.end; i++) {
            expect(mappings.every((mapping) => mapping[i] >= start && mapping[i] < end)).toBe(true)
          }
        }
      }
    }
  })
})
