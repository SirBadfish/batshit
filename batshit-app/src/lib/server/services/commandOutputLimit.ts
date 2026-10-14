/**
 * One output stream of a command Batshit runs (the local shell, Docker Sandbox, and the local
 * Agent Browser CLI), kept up to `limit` characters.
 *
 * A stream past its limit ends with one line saying it was cut (BL-166; it used to stop mid-line
 * with nothing in it saying so). What comes before that line is the whole lines that fit, unless
 * the last of them ends more than a quarter of the limit before the cut: then the start of the
 * long line is kept too, or a short header and one long line (curl -si of minified JSON, a
 * minified bundle) would keep only the header. A stream this cuts is always at least three
 * quarters of the limit long, which is how the shapers tell a runner's cut line from one a command
 * printed itself (`withNativeBashOutputCut`, toolActivityContract.ts): the line's words are a
 * contract.
 *
 * Once cut, a stream takes no more chunks: a small last chunk would otherwise fit into the room a
 * dropped partial line left and join output from both sides of the gap. The stream holds that as
 * its own state (BL-313). It used to be read back from the text (three quarters of the limit,
 * ending with the cut line), so a command that printed that much and then the cut line itself, at
 * the end of a chunk, lost everything it printed after and read as cut.
 *
 * The Docker Agent Browser sidecar runs in its own image and keeps a hand-kept twin of this
 * (`tools/docker/agent-browser-sidecar/output-limit.mjs`); `commandOutputLimit.test.ts` compares
 * the two chunk for chunk.
 */
export type LimitedOutput = {
  append(chunk: string): void
  /** What the stream kept, ending with the cut line when it was cut. */
  readonly text: string
  /** True once the stream passed its limit. */
  readonly cut: boolean
}

export function outputCutLine(limit: number): string {
  return `[Output cut here by Batshit: the command printed more than ${limit.toLocaleString('en-US')} characters.]`
}

export function limitedOutput(limit: number): LimitedOutput {
  let text = ''
  let cut = false
  return {
    append(chunk: string) {
      if (cut || !chunk) return
      const combined = text + chunk
      if (combined.length <= limit) {
        text = combined
        return
      }
      const cutLine = outputCutLine(limit)
      const start = combined.slice(0, Math.max(0, limit - cutLine.length - 1))
      const wholeLinesEnd = start.lastIndexOf('\n') + 1
      const kept = start.length - wholeLinesEnd <= limit / 4 ? start.slice(0, wholeLinesEnd) : `${start}\n`
      text = `${kept}${cutLine}`
      cut = true
    },
    get text() {
      return text
    },
    get cut() {
      return cut
    }
  }
}
