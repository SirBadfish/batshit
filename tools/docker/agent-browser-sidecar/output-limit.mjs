// One output stream of an Agent Browser run, kept up to `limit` characters (BL-313).
//
// A hand-kept twin of the app's `batshit-app/src/lib/server/services/commandOutputLimit.ts`,
// because this sidecar runs in its own image: the same whole-line cut, the same one line saying
// where the cut is (its words are a contract the app's shapers read), and the same rule that a
// stream takes no more chunks once cut, held as its own state rather than read back from the
// text. `commandOutputLimit.test.ts` compares the two chunk for chunk, so change both together.
// Before this the sidecar kept the first N characters, mid-line, with nothing saying so.

export function outputCutLine(limit) {
  return `[Output cut here by Batshit: the command printed more than ${limit.toLocaleString('en-US')} characters.]`
}

export function limitedOutput(limit) {
  let text = ''
  let cut = false
  return {
    append(chunk) {
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
