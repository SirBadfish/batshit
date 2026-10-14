import { describe, expect, it } from 'vitest'
import {
  MAX_COMMAND_MODEL_CAPTURE_CHARS,
  attachCommandModelCapture,
  createCommandModelCapture,
  getCommandModelCapture,
  propagateCommandModelCapture
} from '../commandModelCapture'
import { formatToolModelTextCut } from '$lib/utils/toolModelTextSizeGuard'

const HEADER = 'Command output\n'

/** The whole view, written out by hand: status, the end of stderr, stdout, the earlier stderr. */
function wholeView(status: string, stdout: string, stderr: string): string {
  const tail = stderr.slice(-8_000)
  const head = stderr.slice(0, stderr.length - tail.length)
  const n = (value: number) => value.toLocaleString('en-US')
  return `${HEADER}${status}` +
    (head ? `stderr (the last ${n(tail.length)} of ${n(stderr.length)} characters; the first ${n(head.length)} follow stdout):\n` : 'stderr:\n') +
    `${tail}\nstdout:\n${stdout}` +
    (head ? `\nstderr (the first ${n(head.length)} characters, before the end shown above):\n${head}` : '')
}

function statusOf(text: string): string {
  return text.slice(HEADER.length, text.indexOf('\n', HEADER.length) + 1)
}

describe('private command model capture', () => {
  it('decodes UTF-8 split across byte chunks and counts UTF-16 code units', () => {
    const capture = createCommandModelCapture()
    const stdout = Buffer.from('Aé𝄞Z')
    for (const byte of stdout) capture.appendStdout(Buffer.from([byte]))
    const stderr = Buffer.from('⚠️')
    for (const byte of stderr) capture.appendStderr(Buffer.from([byte]))

    const result = capture.finish({ exitCode: 0, signal: 'SIGTERM', stopped: true })
    expect(result.text).toContain('status: exitCode=0')
    expect(result.text).toContain('signal=SIGTERM')
    expect(result.text).toContain('stopped=true')
    expect(result.text).toContain('stderr:\n⚠️\nstdout:\nAé𝄞Z')
    expect(result.text).toBe(wholeView(statusOf(result.text), 'Aé𝄞Z', '⚠️'))
    expect(result.originalTextChars).toBe(result.text.length)
    expect(capture.finish()).toBe(result)
  })

  // BL-679: stdout came first, so a large stdout pushed the reason for a failure out of the part
  // the agent reads first, and out of the kept copy altogether past 8M.
  it('puts the exit code and the end of stderr before a large stdout', () => {
    const capture = createCommandModelCapture()
    const stdout = 'build step output\n'.repeat(8_400)
    capture.appendStdout(stdout)
    capture.appendStderr('error TS2322: Type string is not assignable to type number.\n')
    const result = capture.finish({ exitCode: 1 })
    const view = wholeView(statusOf(result.text), stdout, 'error TS2322: Type string is not assignable to type number.\n')
    expect(result.text).toBe(view)
    expect(result.originalTextChars).toBe(view.length)

    // The part the agent reads first, cut by the real guard: exit code and error, then stdout.
    const first = formatToolModelTextCut(result.text, 'tool_raw_bl679', result.originalTextChars)
    expect(first.cut).toBe(true)
    const part = first.text.slice(0, first.keptChars)
    expect(part).toContain('exitCode=1 ')
    expect(part).toContain('error TS2322')
    expect(part.indexOf('error TS2322')).toBeLessThan(part.indexOf('\nstdout:\n'))
    // The kept copy has the same layout, so the notice's offset is where the agent stopped.
    expect(result.text.slice(0, first.keptChars)).toBe(part)
    expect(first.text).toContain(`offset ${first.keptChars} to read the rest`)
  })

  it('leads with the last 8,000 characters of a long stderr and keeps the rest after stdout', () => {
    const capture = createCommandModelCapture()
    const stderr = Array.from({ length: 2_000 }, (_, index) => `warning ${index}\n`).join('') + 'fatal: the real reason\n'
    capture.appendStderr(stderr.slice(0, 7_000))
    capture.appendStdout('stdout between\n')
    capture.appendStderr(stderr.slice(7_000))
    const result = capture.finish({ exitCode: 2 })
    expect(stderr.length).toBeGreaterThan(8_000)
    expect(result.text).toBe(wholeView(statusOf(result.text), 'stdout between\n', stderr))
    expect(result.text.indexOf('fatal: the real reason')).toBeLessThan(result.text.indexOf('\nstdout:\n'))
    expect(result.text.indexOf('warning 0\n')).toBeGreaterThan(result.text.indexOf('\nstdout:\n'))
    expect(result.originalTextChars).toBe(result.text.length)
  })

  it('never splits a pair at the start of the stderr end', () => {
    const capture = createCommandModelCapture()
    // 8,001 characters: the last 8,000 would start with the second half of the first pair.
    const stderr = `${'😀'.repeat(4_000)}z`
    capture.appendStderr(stderr)
    const result = capture.finish({ exitCode: 1 })
    const tail = result.text.slice(result.text.indexOf('):\n') + 3, result.text.indexOf('\nstdout:\n'))
    expect(tail).toBe(`${'😀'.repeat(3_999)}z`)
    expect(result.text).toContain('stderr (the last 7,999 of 8,001 characters; the first 2 follow stdout):')
    expect(result.text.endsWith('before the end shown above):\n😀')).toBe(true)
    expect(result.originalTextChars).toBe(result.text.length)
  })

  it('keeps the end of stderr even when stdout alone is over 8M, as a prefix of the whole view', () => {
    const capture = createCommandModelCapture()
    capture.appendStderr('early warning\n')
    capture.appendStdout(Buffer.alloc(9_000_000, 'a'))
    capture.appendStderr('late failure reason\n')
    const result = capture.finish({ exitCode: 1 })
    const stderr = 'early warning\nlate failure reason\n'
    const view = wholeView(statusOf(result.text), 'a'.repeat(9_000_000), stderr)

    expect(result.text.length).toBeLessThanOrEqual(MAX_COMMAND_MODEL_CAPTURE_CHARS)
    expect(result.text.length).toBeGreaterThan(MAX_COMMAND_MODEL_CAPTURE_CHARS - 10_000)
    expect(view.startsWith(result.text)).toBe(true)
    expect(result.text).toContain(`stderr:\n${stderr}\nstdout:\naaaa`)
    expect(result.text.endsWith('a')).toBe(true)
    expect(result.originalTextChars).toBe(view.length)
  })

  it('keeps no earlier stderr after a cut stdout: the kept view has no gap', () => {
    const capture = createCommandModelCapture()
    const stderr = `${'w'.repeat(20_000)}REASON`
    capture.appendStderr(stderr)
    capture.appendStdout(Buffer.alloc(9_000_000, 'a'))
    const result = capture.finish({ exitCode: 1 })
    const view = wholeView(statusOf(result.text), 'a'.repeat(9_000_000), stderr)
    expect(view.startsWith(result.text)).toBe(true)
    expect(result.text.endsWith('a')).toBe(true)
    expect(result.text).toContain('REASON\nstdout:\n')
    expect(result.originalTextChars).toBe(view.length)
  })

  it('drops earlier stderr for later stdout without a gap, and keeps it when stdout ends', () => {
    const big = createCommandModelCapture()
    const stderr = `${'e'.repeat(3_000_000)}END-OF-STDERR`
    big.appendStderr(stderr)
    big.appendStdout('o'.repeat(6_000_000))
    const cut = big.finish({ exitCode: 7, timedOut: true })
    const bigView = wholeView(statusOf(cut.text), 'o'.repeat(6_000_000), stderr)
    expect(cut.text.length).toBeLessThanOrEqual(MAX_COMMAND_MODEL_CAPTURE_CHARS)
    expect(bigView.startsWith(cut.text)).toBe(true)
    expect(cut.text).toContain('END-OF-STDERR\nstdout:\n')
    expect(cut.originalTextChars).toBe(bigView.length)
    expect(cut.text).toContain('timedOut=true')
  })
  it('propagates privately without adding a JSON, event, or card field', () => {
    const capture = createCommandModelCapture()
    capture.appendStdout('hello')
    const original = attachCommandModelCapture({ success: false, stdout: 'hello' }, capture.finish({ exitCode: 2 }))
    const final = propagateCommandModelCapture(original, { success: false, stdout: 'hello', error: 'failed' })

    expect(getCommandModelCapture(final)).toBe(getCommandModelCapture(original))
    expect(Object.keys(final)).toEqual(['success', 'stdout', 'error'])
    expect(JSON.stringify(final)).toBe('{"success":false,"stdout":"hello","error":"failed"}')
    expect(getCommandModelCapture(JSON.parse(JSON.stringify(final)))).toBeNull()
  })
})
