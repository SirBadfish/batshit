import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { limitedOutput, outputCutLine } from '../commandOutputLimit'

/**
 * BL-166 / BL-313: how Batshit keeps one output stream of a command it runs. The local shell,
 * Docker Sandbox, and local Agent Browser runners use `commandOutputLimit.ts`; the Docker Agent
 * Browser sidecar runs in its own image and keeps a hand-kept twin
 * (`tools/docker/agent-browser-sidecar/output-limit.mjs`). The twin is compared here over the
 * same chunks, so the two cannot drift.
 */

const LIMIT = 1_000
const CUT_LINE = '[Output cut here by Batshit: the command printed more than 1,000 characters.]'

type LimitedOutputFactory = typeof limitedOutput

function keep(factory: LimitedOutputFactory, chunks: string[], limit = LIMIT) {
  const stream = factory(limit)
  for (const chunk of chunks) stream.append(chunk)
  return { text: stream.text, cut: stream.cut }
}

const numbered = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => String(from + i)).join('\n') + '\n'

// Chunks as a command prints them: split anywhere, including mid-line and right after a cut line.
const CORPUS: Record<string, string[]> = {
  'nothing': [],
  'an empty chunk': [''],
  'a short output': ['1\n2\n', '3\n'],
  'exactly the limit': ['x'.repeat(LIMIT)],
  'one character past the limit': ['x'.repeat(LIMIT + 1)],
  'many short lines in one chunk': [numbered(1, 2_000)],
  'many short lines, split mid-line': [numbered(1, 150).slice(0, 333), numbered(1, 150).slice(333), numbered(151, 400)],
  'a small chunk after the cut': [numbered(1, 2_000), 'zz'],
  'a header and one line longer than the limit': ['HTTP/1.1 200 OK\n', 'x'.repeat(3_000)],
  'the cut line printed early': ['one\n', CUT_LINE, '\nafter\n'],
  'the cut line printed at the end of a long chunk (BL-313)': [`${'y'.repeat(800)}\n${CUT_LINE}`, '\nafter\n'],
  'the cut line printed at the end of a long chunk, then past the limit': [
    `${'y'.repeat(800)}\n${CUT_LINE}`,
    `\n${numbered(1, 100)}`
  ],
  'multibyte text past the limit': ['é\n'.repeat(900)]
}

describe('commandOutputLimit: one output stream kept up to its limit (BL-166, BL-313)', () => {
  it('names its limit in the cut line the shapers read', () => {
    expect(outputCutLine(LIMIT)).toBe(CUT_LINE)
    expect(outputCutLine(120_000)).toBe(
      '[Output cut here by Batshit: the command printed more than 120,000 characters.]'
    )
  })

  it('keeps an output within the limit exactly as printed', () => {
    expect(keep(limitedOutput, ['1\n2\n', '3\n'])).toEqual({ text: '1\n2\n3\n', cut: false })
    expect(keep(limitedOutput, ['x'.repeat(LIMIT)])).toEqual({ text: 'x'.repeat(LIMIT), cut: false })
  })

  it('keeps whole lines, ends with one cut line, stays within the limit, and takes nothing after', () => {
    const kept = keep(limitedOutput, [numbered(1, 2_000), 'zz'])

    expect(kept.cut).toBe(true)
    expect(kept.text.length).toBeLessThanOrEqual(LIMIT)
    expect(kept.text.endsWith(`\n${CUT_LINE}`)).toBe(true)
    expect(kept.text).not.toContain('zz')
    const lines = kept.text.slice(0, -CUT_LINE.length).split('\n').filter(Boolean)
    expect(lines).toEqual(Array.from({ length: lines.length }, (_, i) => String(i + 1)))
  })

  it('keeps the start of a line longer than the limit after a short header', () => {
    const kept = keep(limitedOutput, ['HTTP/1.1 200 OK\n', 'x'.repeat(3_000)])

    expect(kept.cut).toBe(true)
    expect(kept.text.startsWith('HTTP/1.1 200 OK\nxxxx')).toBe(true)
    expect(kept.text.endsWith(`x\n${CUT_LINE}`)).toBe(true)
  })

  it('never takes a cut line the command printed itself for its own cut (BL-313)', () => {
    // Three quarters of the limit and then the cut line, at the end of a chunk: the old rule read
    // that from the text alone as a stream it had cut, and dropped every later chunk.
    const printed = `${'y'.repeat(800)}\n${CUT_LINE}`
    expect(keep(limitedOutput, [printed, '\nafter\n'])).toEqual({ text: `${printed}\nafter\n`, cut: false })

    // Past the limit later on, it is cut at the real limit, once.
    const past = keep(limitedOutput, [printed, `\n${numbered(1, 100)}`])
    expect(past.cut).toBe(true)
    expect(past.text.endsWith(`\n${CUT_LINE}`)).toBe(true)
    expect(past.text.split(CUT_LINE)).toHaveLength(3)
  })

  it('is the same rule as the Docker Agent Browser sidecar twin, chunk for chunk', async () => {
    // Loaded by Node itself, like the other twins beside the app (appleContainerSystemRecord.test.ts):
    // the file is outside batshit-app, where Vite's dev server refuses to serve it (BL-624).
    const twinPath = path.resolve(process.cwd(), '../tools/docker/agent-browser-sidecar/output-limit.mjs')
    const twin = createRequire(import.meta.url)(twinPath) as {
      limitedOutput: LimitedOutputFactory
      outputCutLine: typeof outputCutLine
    }

    expect(twin.outputCutLine(LIMIT)).toBe(outputCutLine(LIMIT))
    for (const [name, chunks] of Object.entries(CORPUS)) {
      for (const limit of [LIMIT, 1_337, 4_096]) {
        expect({ name, limit, ...keep(twin.limitedOutput, chunks, limit) }).toEqual({
          name,
          limit,
          ...keep(limitedOutput, chunks, limit)
        })
      }
    }
  })
})
