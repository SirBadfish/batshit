import { StringDecoder } from 'node:string_decoder'

/** The largest original command-text prefix Batshit can retain for a model to page through. */
export const MAX_COMMAND_MODEL_CAPTURE_CHARS = 8_000_000

export type CommandModelCapture = Readonly<{
  text: string
  originalTextChars: number
}>

export type CommandModelCaptureStatus = {
  exitCode?: number | null
  signal?: string | null
  timedOut?: boolean
  stopped?: boolean
  outputIncomplete?: boolean
}

const COMMAND_HEADER = 'Command output\n'
/** BL-679: the end of stderr leads the view, before stdout, so a first part always holds it. */
export const COMMAND_STDERR_TAIL_CHARS = 8_000
const STDOUT_SEPARATOR = '\nstdout:\n'
// Room kept for the two stderr headings, whose counts are known only when the process ends.
const STDERR_HEADING_RESERVE = 160

// Fixed-width, server-vouched fields make the output prefix budget exact before a process exits.
// Neither command arguments nor arbitrary error text belong in this header.
function statusLine(status: CommandModelCaptureStatus = {}): string {
  const exitCode = typeof status.exitCode === 'number' && Number.isInteger(status.exitCode) &&
    status.exitCode >= -99_999 && status.exitCode <= 999_999
    ? String(status.exitCode)
    : 'none'
  const signal = typeof status.signal === 'string' && /^SIG[A-Z0-9]{1,13}$/.test(status.signal)
    ? status.signal
    : 'none'
  return `status: exitCode=${exitCode.padEnd(7)}; signal=${signal.padEnd(16)}; timedOut=${String(status.timedOut === true).padEnd(5)}; stopped=${String(status.stopped === true).padEnd(5)}; outputIncomplete=${String(status.outputIncomplete === true).padEnd(5)}\n`
}

const count = (value: number) => value.toLocaleString('en-US')

function stderrTailHeading(stderrChars: number, tailChars: number): string {
  return stderrChars === tailChars
    ? 'stderr:\n'
    : `stderr (the last ${count(tailChars)} of ${count(stderrChars)} characters; the first ${count(stderrChars - tailChars)} follow stdout):\n`
}

function stderrHeadHeading(headChars: number): string {
  return `\nstderr (the first ${count(headChars)} characters, before the end shown above):\n`
}

// Everything before stdout, at its largest: stdout's budget is exact while the process runs.
const BEFORE_STDOUT_MAX_CHARS = COMMAND_HEADER.length + statusLine().length +
  STDERR_HEADING_RESERVE + COMMAND_STDERR_TAIL_CHARS + STDOUT_SEPARATOR.length
const STDOUT_BUDGET = MAX_COMMAND_MODEL_CAPTURE_CHARS - BEFORE_STDOUT_MAX_CHARS

function safePrefix(text: string, maxChars: number): string {
  let end = Math.min(text.length, Math.max(0, maxChars))
  // Never save half of a decoded supplementary character at the 8M boundary.
  if (end > 0 && end < text.length) {
    const before = text.charCodeAt(end - 1)
    const after = text.charCodeAt(end)
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end -= 1
  }
  return text.slice(0, end)
}

/** The last `maxChars` characters, never starting with the second half of a pair. */
function safeSuffix(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  let start = text.length - maxChars
  const first = text.charCodeAt(start)
  if (first >= 0xdc00 && first <= 0xdfff && start > 0) {
    const before = text.charCodeAt(start - 1)
    if (before >= 0xd800 && before <= 0xdbff) start += 1
  }
  return text.slice(start)
}

/**
 * The model view of one command (BL-679): the status line, the end of stderr (at most
 * `COMMAND_STDERR_TAIL_CHARS`), stdout, and then any earlier stderr. A first part of the view
 * always holds the exit code and the end of stderr, before stdout; the kept copy is the same
 * text, so an offset into it is true. The view is kept up to 8M characters and is always a
 * prefix of the whole view, with no gap: stdout comes before the earlier stderr.
 */
export function createCommandModelCapture() {
  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  let stdoutPrefix = ''
  let stderrHead = ''
  let stderrTail = ''
  let stdoutChars = 0
  let stderrChars = 0
  let stdoutSealed = false
  let stderrHeadSealed = false
  let finished: CommandModelCapture | null = null

  // The earlier stderr comes after stdout, so it gets only the room stdout leaves.
  const stderrHeadRoom = () => stdoutSealed
    ? 0
    : Math.max(0, STDOUT_BUDGET - stdoutPrefix.length - STDERR_HEADING_RESERVE)

  const appendDecoded = (stream: 'stdout' | 'stderr', decoded: string) => {
    if (finished || !decoded) return
    if (stream === 'stdout') {
      stdoutChars += decoded.length
      if (stdoutSealed) return
      const kept = safePrefix(decoded, STDOUT_BUDGET - stdoutPrefix.length)
      stdoutPrefix += kept
      if (kept.length < decoded.length) stdoutSealed = true
      // A later stdout chunk precedes all earlier stderr in the view. Reclaim that space
      // without ever keeping stderr after a discarded gap.
      if (stderrHead.length > stderrHeadRoom()) {
        stderrHead = safePrefix(stderrHead, stderrHeadRoom())
        stderrHeadSealed = true
      }
      return
    }
    stderrChars += decoded.length
    stderrTail = safeSuffix(stderrTail + decoded, COMMAND_STDERR_TAIL_CHARS)
    if (stderrHeadSealed) return
    const kept = safePrefix(decoded, stderrHeadRoom() - stderrHead.length)
    stderrHead += kept
    if (kept.length < decoded.length) stderrHeadSealed = true
  }

  const append = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
    if (finished) return
    const decoder = stream === 'stdout' ? stdoutDecoder : stderrDecoder
    appendDecoded(stream, decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk))
  }

  return {
    appendStdout(chunk: Buffer | string) { append('stdout', chunk) },
    appendStderr(chunk: Buffer | string) { append('stderr', chunk) },
    finish(status: CommandModelCaptureStatus = {}): CommandModelCapture {
      if (finished) return finished
      appendDecoded('stdout', stdoutDecoder.end())
      appendDecoded('stderr', stderrDecoder.end())
      const headChars = stderrChars - stderrTail.length
      const tailHeading = stderrTailHeading(stderrChars, stderrTail.length)
      let text = `${COMMAND_HEADER}${statusLine(status)}${tailHeading}${stderrTail}${STDOUT_SEPARATOR}${stdoutPrefix}`
      const headHeading = headChars > 0 ? stderrHeadHeading(headChars) : ''
      if (headChars > 0 && stdoutPrefix.length === stdoutChars &&
          text.length + headHeading.length <= MAX_COMMAND_MODEL_CAPTURE_CHARS) {
        const head = stderrHead.slice(0, Math.min(stderrHead.length, headChars))
        text += headHeading + safePrefix(head, MAX_COMMAND_MODEL_CAPTURE_CHARS - text.length - headHeading.length)
      }
      finished = Object.freeze({
        text,
        originalTextChars: COMMAND_HEADER.length + statusLine(status).length + tailHeading.length +
          stderrTail.length + STDOUT_SEPARATOR.length + stdoutChars + headHeading.length + headChars
      })
      return finished
    }
  }
}

const captureByResult = new WeakMap<object, CommandModelCapture>()

export function attachCommandModelCapture<T extends object>(result: T, capture: CommandModelCapture): T {
  captureByResult.set(result, capture)
  return result
}

export function getCommandModelCapture(result: unknown): CommandModelCapture | null {
  return result !== null && typeof result === 'object' ? captureByResult.get(result) ?? null : null
}

export function propagateCommandModelCapture<T extends object>(source: unknown, result: T): T {
  const capture = getCommandModelCapture(source)
  return capture ? attachCommandModelCapture(result, capture) : result
}
