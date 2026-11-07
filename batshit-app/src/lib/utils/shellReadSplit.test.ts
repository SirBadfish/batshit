import { describe, expect, it } from 'vitest'
import {
  emulateFileReadView,
  matchShellReadSplit,
  planShellReadSplit,
  planSingleFileRead,
  readSplitViews,
  readsWithoutShellWrapper,
  validShellReadSplit,
  type FileReadView
} from './shellReadSplit'
import { readFilesFromCommand } from './zipDeadCopies'

/**
 * BL-1652: a command that read several files is split into one part per file only when every
 * part is proven against the files' text; anything unproven stays one result, as before.
 */

const A = 'export const a = 1\nexport const b = 2\n'
const B = 'line one\nline two\nline three\nline four\n'
const C = '{"events":[1,2,3]}\n'

function split(command: string, stdout: string, files: Record<string, string | null>) {
  const plan = planShellReadSplit(command)
  if (!plan) return null
  return matchShellReadSplit(plan, stdout, new Map(Object.entries(files)))
}

function texts(command: string, stdout: string, files: Record<string, string | null>) {
  const result = split(command, stdout, files)
  return result?.parts.map((part) => ({ kind: part.kind, command: part.command, text: stdout.slice(part.start, part.end) })) ?? null
}

describe('planShellReadSplit', () => {
  it('plans a read of several files, alone or beside other commands', () => {
    expect(planShellReadSplit('cat src/a.js src/b.js')?.files).toEqual(['src/a.js', 'src/b.js'])
    expect(planShellReadSplit('cd /p && cat a.js && sed -n 1,60p b.js')).toMatchObject({ cdDir: '/p', files: ['a.js', 'b.js'] })
    expect(planShellReadSplit('cat a.js && ls && head -c 300 c.json')?.files).toEqual(['a.js', 'c.json'])
    expect(planShellReadSplit('cat a.js && npm test')?.files).toEqual(['a.js'])
  })

  it('leaves a one-file read, a command with no read, and anything outside the grammar alone', () => {
    expect(planShellReadSplit('cat src/a.js')).toBeNull()
    expect(planShellReadSplit('cd /p && cat a.js')).toBeNull()
    expect(planShellReadSplit('echo === && cat a.js')).toBeNull()
    expect(planShellReadSplit('ls && npm test')).toBeNull()
    expect(planShellReadSplit('cat a.js 2>&1 && cat b.js')).toBeNull()
    expect(planShellReadSplit('cat a.js || cat b.js')).toBeNull()
    expect(planShellReadSplit('cat $F b.js')).toBeNull()
    expect(planShellReadSplit('cat src/*.js b.js')).toBeNull()
    expect(planShellReadSplit('cat a.js && cd sub && cat b.js')).toBeNull()
    expect(planShellReadSplit('cat a.js > out.txt && cat b.js')).toBeNull()
  })
})

describe('matchShellReadSplit', () => {
  it('splits cat of several files into one part per file, each with its own command', () => {
    expect(texts('cd /p && cat a.js b.txt', A + B, { 'a.js': A, 'b.txt': B })).toEqual([
      { kind: 'read', command: 'cd /p && cat a.js', text: A },
      { kind: 'read', command: 'cd /p && cat b.txt', text: B }
    ])
  })

  it('emulates sed -n ranges, head, tail, cat -n, nl -ba, and a whole read piped to a range', () => {
    const cases: Array<[string, string]> = [
      ['sed -n 2,3p b.txt', 'line two\nline three\n'],
      ['sed -n 3p b.txt', 'line three\n'],
      ["sed -n '3,$p' b.txt", 'line three\nline four\n'],
      ['sed -n 3,1p b.txt', 'line three\n'],
      ['sed -n 1p;4p b.txt', 'line one\nline four\n'],
      ['head -n 2 b.txt', 'line one\nline two\n'],
      ['head -2 b.txt', 'line one\nline two\n'],
      ['head b.txt', B],
      ['head -c 6 b.txt', 'line o'],
      ['tail -n 1 b.txt', 'line four\n'],
      ['cat -n b.txt', '     1\tline one\n     2\tline two\n     3\tline three\n     4\tline four\n'],
      ['nl -ba b.txt', '     1\tline one\n     2\tline two\n     3\tline three\n     4\tline four\n'],
      ['cat b.txt | sed -n 2,3p', 'line two\nline three\n'],
      ['cat b.txt | head -n 1', 'line one\n']
    ]
    for (const [read, printed] of cases) {
      const command = read.includes(';') ? `cat a.js && sed -n '1p;4p' b.txt` : `cat a.js && ${read}`
      const result = texts(command, A + printed, { 'a.js': A, 'b.txt': B })
      expect(result, read).not.toBeNull()
      expect(result?.[1]?.text, read).toBe(printed)
      expect(result?.[1]?.kind, read).toBe('read')
    }
  })

  it('finds a read after another command by its text, and keeps that command as its own part', () => {
    const ls = 'a.js\nc.json\npackage.json\n'
    const stdout = A + ls + C.slice(0, 10)
    expect(texts('cd /p && cat a.js && ls && head -c 10 c.json', stdout, { 'a.js': A, 'c.json': C })).toEqual([
      { kind: 'read', command: 'cd /p && cat a.js', text: A },
      { kind: 'other', command: 'cd /p && ls', text: ls },
      { kind: 'read', command: 'cd /p && head -c 10 c.json', text: C.slice(0, 10) }
    ])
    const tests = 'PASS 12 tests\n'
    expect(texts('cat a.js && npm test', A + tests, { 'a.js': A })).toEqual([
      { kind: 'read', command: 'cat a.js', text: A },
      { kind: 'other', command: 'npm test', text: tests }
    ])
  })

  it('marks echo/printf separators, and does not split a single read framed only by them', () => {
    const result = split('cat a.js && echo --- && cat b.txt', `${A}---\n${B}`, { 'a.js': A, 'b.txt': B })
    expect(result?.parts.map((part) => [part.kind, part.kind === 'other' ? part.separatorsOnly : null])).toEqual([
      ['read', null],
      ['other', true],
      ['read', null]
    ])
    expect(split('echo === && cat a.js && echo ===', `===\n${A}===\n`, { 'a.js': A })).toBeNull()
  })

  it('splits nothing it cannot prove', () => {
    // a file changed after the command, or could not be read
    expect(split('cat a.js b.txt', A + B, { 'a.js': A, 'b.txt': `${B}more\n` })).toBeNull()
    expect(split('cat a.js b.txt', A + B, { 'a.js': A, 'b.txt': null })).toBeNull()
    // extra output after the last read
    expect(split('cat a.js b.txt', `${A}${B}x`, { 'a.js': A, 'b.txt': B })).toBeNull()
    // after an unknown output, a read found twice is ambiguous
    expect(split('cat a.js && ls && cat b.txt', `${A}${B}${B}`, { 'a.js': A, 'b.txt': B })).toBeNull()
    // the same, where the first match would still cover stdout (an ls that printed the file's text)
    expect(split('cat a.js && ls && cat b.txt && ls && cat c.json', `${A}${B}${B}y\n${C}`, { 'a.js': A, 'b.txt': B, 'c.json': C })).toBeNull()
    // an empty file after an unknown output has no position
    expect(split('cat a.js && ls && cat e.txt', `${A}x\n`, { 'a.js': A, 'e.txt': '' })).toBeNull()
    // numbering across several files differs between cats
    expect(split('cat -n a.js b.txt', 'x', { 'a.js': A, 'b.txt': B })).toBeNull()
    // empty output
    expect(split('cat a.js b.txt', '', { 'a.js': A, 'b.txt': B })).toBeNull()
  })

  it('gives each read part a command the dead-copy ledger reads as that one file', () => {
    const ls = 'x\n'
    const result = split('cd /p && cat src/a.js src/b.txt && ls && sed -n 2,3p src/b.txt', `${A}${B}${ls}line two\nline three\n`, {
      'src/a.js': A,
      'src/b.txt': B
    })
    const reads = result?.parts.filter((part) => part.kind === 'read') ?? []
    expect(reads.map((part) => [part.path, part.mode, [...(readFilesFromCommand(part.command, '/p') ?? new Map()).entries()]])).toEqual([
      ['src/a.js', 'whole', [['src/a.js', 'whole']]],
      ['src/b.txt', 'whole', [['src/b.txt', 'whole']]],
      ['src/b.txt', 'partial', [['src/b.txt', 'partial']]]
    ])
  })

  it('drops the other operands by their place, never by their text', () => {
    const result = split('cat -u cat dog', A + B, { cat: A, dog: B })
    expect(result?.parts.map((part) => part.command)).toEqual(['cat -u cat', 'cat -u dog'])
  })

  it('takes a file that ends without a newline as exactly its bytes, so a newline the next command printed stays with it', () => {
    const NONL = 'one\ntwo'
    const result = texts('sed -n 2p nonl.txt && echo && cat a.js', `two\n${A}`, { 'nonl.txt': NONL, 'a.js': A })
    expect(result).toEqual([
      { kind: 'read', command: 'sed -n 2p nonl.txt', text: 'two' },
      { kind: 'other', command: 'echo', text: '\n' },
      { kind: 'read', command: 'cat a.js', text: A }
    ])
    // a tool that adds the newline (GNU nl) is not guessed: nothing is split
    expect(split('nl -ba nonl.txt && cat a.js', `     1\tone\n     2\ttwo\n${A}`, { 'nonl.txt': NONL, 'a.js': A })).toBeNull()
  })

  it('quotes paths so the part command reads back the same file', () => {
    const result = split("cat 'my file.txt' b.txt", A + B, { 'my file.txt': A, 'b.txt': B })
    const first = result?.parts[0]
    expect(first?.command).toBe("cat 'my file.txt'")
    expect([...(readFilesFromCommand(first?.command ?? '', '/p') ?? new Map()).keys()]).toEqual(['my file.txt'])
  })
})

describe('validShellReadSplit', () => {
  it('accepts a split whose parts cover stdout exactly, and rejects anything else', () => {
    const stdout = A + B
    const good = split('cat a.js b.txt', stdout, { 'a.js': A, 'b.txt': B })
    expect(validShellReadSplit(good, stdout)).toEqual(good)
    expect(validShellReadSplit(good, `${stdout}x`)).toBeNull()
    expect(validShellReadSplit({ ...good, version: 2 }, stdout)).toBeNull()
    expect(validShellReadSplit({ ...good, parts: [good!.parts[1], good!.parts[0]] }, stdout)).toBeNull()
    expect(validShellReadSplit({ ...good, parts: [{ ...good!.parts[0], path: '' }, good!.parts[1]] }, stdout)).toBeNull()
    expect(validShellReadSplit(null, stdout)).toBeNull()
    expect(validShellReadSplit(good, undefined)).toBeNull()
  })
})

/**
 * SA-137 (D8): the read forms a live file read may show again, and the emulation it shows them
 * with. Only a plain, `-n` or `-b` cat, a `sed -n` range script and head/tail by a positive line
 * count; everything else has no view and stays as printed.
 */
describe('live file read views (SA-137)', () => {
  it('plans a one-file read in each v1 form, after an optional cd', () => {
    expect(planSingleFileRead('cat src/a.js')).toEqual({ cdDir: null, file: 'src/a.js', view: { kind: 'whole', numbering: 'none' } })
    expect(planSingleFileRead('cat -n src/a.js')?.view).toEqual({ kind: 'whole', numbering: 'all' })
    expect(planSingleFileRead('cat -b src/a.js')?.view).toEqual({ kind: 'whole', numbering: 'nonblank' })
    expect(planSingleFileRead('cd /p && sed -n 10,40p src/a.js')).toEqual({ cdDir: '/p', file: 'src/a.js', view: { kind: 'lines', script: '10,40p' } })
    expect(planSingleFileRead("sed -n '1,5p;9,$p' a.js")?.view).toEqual({ kind: 'lines', script: '1,5p;9,$p' })
    expect(planSingleFileRead('head -n 20 a.js')?.view).toEqual({ kind: 'head', lines: 20 })
    expect(planSingleFileRead('tail -5 a.js')?.view).toEqual({ kind: 'tail', lines: 5 })
    expect(planSingleFileRead('head a.js')?.view).toEqual({ kind: 'head', lines: 10 })
  })

  it('has no view for anything else: nl, bytes, both flags, a path program, a pipe alone, two files, a second command', () => {
    for (const command of [
      'nl -ba a.js',
      'head -c 300 a.js',
      'tail --bytes=20 a.js',
      'head -n 0 a.js',
      'cat -n -b a.js',
      'cat -u a.js',
      'cat -- a.js',
      '/bin/cat a.js',
      'cat a.js | sed -n 1,5p',
      'cat a.js b.js',
      'cat a.js && ls',
      'sed -n 1,5p a.js b.js',
      'sed -n /x/p a.js',
      'cat $F',
      'cat src/*.js',
      'cd a && cd b && cat c',
      "bash -c 'cat a.js'",
      "/bin/zsh -lc 'sed -n 1,5p a.js'",
      "sh -c 'cd src && cat a.js'"
    ]) {
      expect(planSingleFileRead(command), command).toBeNull()
    }
  })

  it('takes a split as a v1 read only when it reads without a shell wrapper', () => {
    expect(readsWithoutShellWrapper('cat a.js b.js && ls')).toBe(true)
    expect(readsWithoutShellWrapper("bash -c 'cat a.js b.js && ls'")).toBe(false)
    expect(readsWithoutShellWrapper('ls && npm test')).toBe(false)
  })

  it('gives each split read part its view in the order the split makes its parts', () => {
    const plan = planShellReadSplit('cat a.js b.js && ls && nl -ba c.js && cat d.js | head -n 3 && head -c 9 e.js')!
    expect(readSplitViews(plan)).toEqual([
      { file: 'a.js', view: { kind: 'whole', numbering: 'none' } },
      { file: 'b.js', view: { kind: 'whole', numbering: 'none' } },
      { file: 'c.js', view: null },
      { file: 'd.js', view: { kind: 'head', lines: 3 } },
      { file: 'e.js', view: null }
    ])
    // A pipe whose cat has an option other than -u, or a byte filter, has no view.
    expect(readSplitViews(planShellReadSplit('cat -n a.js | head -n 3 && cat b.js')!)[0].view).toBeNull()
    expect(readSplitViews(planShellReadSplit('cat a.js | head -c 3 && cat b.js')!)[0].view).toBeNull()
    expect(readSplitViews(planShellReadSplit('cat -u a.js | sed -n 2p && cat b.js')!)[0].view).toEqual({ kind: 'lines', script: '2p' })
  })

  it('shows changed content in the same form: blank lines, CRLF, no final newline, UTF-8, empty', () => {
    const whole: FileReadView = { kind: 'whole', numbering: 'none' }
    const all: FileReadView = { kind: 'whole', numbering: 'all' }
    const nonblank: FileReadView = { kind: 'whole', numbering: 'nonblank' }
    const changed = 'one\r\n\nthree – é\nfour'
    expect(emulateFileReadView(whole, changed)).toBe(changed)
    expect(emulateFileReadView(all, changed)).toBe('     1\tone\r\n     2\t\n     3\tthree – é\n     4\tfour')
    expect(emulateFileReadView(nonblank, changed)).toBe('     1\tone\r\n\n     2\tthree – é\n     3\tfour')
    expect(emulateFileReadView({ kind: 'lines', script: '2,3p' }, changed)).toBe('\nthree – é\n')
    expect(emulateFileReadView({ kind: 'lines', script: '3,$p' }, changed)).toBe('three – é\nfour')
    expect(emulateFileReadView({ kind: 'lines', script: '9p' }, changed)).toBe('')
    expect(emulateFileReadView({ kind: 'head', lines: 2 }, changed)).toBe('one\r\n\n')
    expect(emulateFileReadView({ kind: 'tail', lines: 1 }, changed)).toBe('four')
    for (const view of [whole, all, nonblank, { kind: 'head', lines: 3 } as FileReadView]) {
      expect(emulateFileReadView(view, '')).toBe('')
    }
  })

  it('emulates exactly what the split proves for the same form', () => {
    const text = 'a\n\nc\nd\n'
    const cases: Array<[string, FileReadView]> = [
      ['cat x && cat y', { kind: 'whole', numbering: 'none' }],
      ['cat -n x && cat y', { kind: 'whole', numbering: 'all' }],
      ['cat -b x && cat y', { kind: 'whole', numbering: 'nonblank' }],
      ['sed -n 2,3p x && cat y', { kind: 'lines', script: '2,3p' }],
      ['tail -n 2 x && cat y', { kind: 'tail', lines: 2 }]
    ]
    for (const [command, view] of cases) {
      const printed = emulateFileReadView(view, text)!
      const result = matchShellReadSplit(planShellReadSplit(command)!, printed + 'Y\n', new Map([['x', text], ['y', 'Y\n']]))
      expect(result?.parts[0], command).toMatchObject({ kind: 'read', path: 'x', start: 0, end: printed.length })
    }
  })
})
