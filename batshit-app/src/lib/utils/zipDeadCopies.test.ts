import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCompressHintLastReply } from './zipActivation'
import {
  describeDeadCopiesCompressedThisTurn,
  describeHeldPath,
  describeToolResultFiles,
  findDeadCopies,
  holdPathKeys,
  newestWholeReadsByFile,
  readFilesFromCommand,
  type DeadCopyToolResult
} from './zipDeadCopies'
import { HELD_BY_USER_HINT, heldByUserForMessagesHint } from './zipHoldWords'
import { ZIP_INDEX_STATUS_HEADINGS } from './compiledChatTags'
import { buildToolGuidanceZipPromptBlock } from './toolPromptInjection'
import { applyPromptRuntimeScope } from './promptRuntimeScope'
import { formatToolModelTextCut } from './toolModelTextSizeGuard'
import { guardCutNotice } from '$lib/test-utils/guard-cut-notice'
import { limitedOutput } from '$lib/server/services/commandOutputLimit'

// SA-129 P1 (DL-01). One test per sentence of the lock; each was mutation-checked (the evidence
// log in the story names the mutations).

const PROJECT = '/work/proj'

let counter = 0
function nextId() {
  counter += 1
  return `cool_tool_1790000000000_${String(counter).padStart(5, '0')}`
}

type Options = { message?: number; author?: string | null }

function shellRead(command: string, options: Options & { label?: string } = {}, result: Record<string, any> = {}): DeadCopyToolResult {
  // By default the mapper's label is deliberately wrong (BL-233): only the command decides the files.
  const label = options.label ?? 'label-only.md'
  return {
    zipId: nextId(),
    authorId: options.author === undefined ? 'agent-a' : options.author,
    messageIndex: options.message ?? 0,
    operationKind: 'read_file',
    payload: {
      operationKind: 'read_file',
      toolArgs: { filePath: label, innerCommand: command },
      toolResult: { filePath: label, content: 'body', lineCount: 1, ...result }
    }
  }
}

function directRead(path: string, options: Options = {}, args: Record<string, any> = {}, result: Record<string, any> = {}): DeadCopyToolResult {
  return {
    zipId: nextId(),
    authorId: options.author === undefined ? 'agent-a' : options.author,
    messageIndex: options.message ?? 0,
    operationKind: 'read_file',
    payload: {
      operationKind: 'read_file',
      toolArgs: { filePath: path, ...args },
      toolResult: { filePath: path, content: 'body', lineCount: 10, ...result }
    }
  }
}

function directEdit(path: string, options: Options = {}, extra: Record<string, any> = {}): DeadCopyToolResult {
  return {
    zipId: nextId(),
    authorId: options.author === undefined ? 'agent-a' : options.author,
    messageIndex: options.message ?? 0,
    operationKind: 'edit_file',
    payload: { operationKind: 'edit_file', toolArgs: { filePath: path }, toolResult: { filePath: path, diff: '+x' }, ...extra }
  }
}

function commandResult(operationKind: string, command: string, label: string, options: Options = {}): DeadCopyToolResult {
  return {
    zipId: nextId(),
    authorId: options.author === undefined ? 'agent-a' : options.author,
    messageIndex: options.message ?? 0,
    operationKind,
    payload: { operationKind, toolArgs: { filePath: label, innerCommand: command }, toolResult: { filePath: label, diff: '+x' } }
  }
}

function skillRead(skillId: string, path: string, action: string, options: Options = {}, args: Record<string, any> = {}): DeadCopyToolResult {
  return {
    zipId: nextId(),
    authorId: options.author === undefined ? 'agent-a' : options.author,
    messageIndex: options.message ?? 0,
    operationKind: 'skill_read',
    payload: {
      operationKind: 'skill_read',
      toolArgs: { skillId, path, action, ...args },
      toolResult: { skillId, path, filePath: path, content: 'skill body', action }
    }
  }
}

const dead = (results: DeadCopyToolResult[]) => findDeadCopies(results, { projectPath: PROJECT })

describe('findDeadCopies: dead copies (SA-129 DL-01)', () => {
  it('a later whole read supersedes an earlier whole read; the newest copy stays live', () => {
    const first = shellRead('cat src/app.js', { message: 1 })
    const second = shellRead('cat src/app.js', { message: 3 })
    const result = dead([first, second])
    expect(result.get(first.zipId)).toEqual({
      reason: 'superseded',
      deadAtMessageIndex: 3,
      files: [{ path: 'src/app.js', reason: 'superseded' }]
    })
    expect(result.has(second.zipId)).toBe(false)
  })

  it('an edit of the file after a whole read makes that copy stale', () => {
    const read = shellRead('cat src/app.js', { message: 1 })
    const edit = directEdit(`${PROJECT}/src/app.js`, { message: 3 })
    expect(dead([read, edit]).get(read.zipId)).toEqual({
      reason: 'stale',
      deadAtMessageIndex: 3,
      files: [{ path: 'src/app.js', reason: 'stale' }]
    })
  })

  it('Refreshed File Reads has no exemption: an edit makes a copy stale in the one ledger every compile uses (Josh, 2026-11-04)', () => {
    const read = shellRead('cat src/app.js', { message: 1 })
    const edit = directEdit(`${PROJECT}/src/app.js`, { message: 3 })
    // An option the ledger no longer knows changes nothing (a caller cannot keep an edited copy open).
    expect(findDeadCopies([read, edit], { projectPath: PROJECT, staleExempt: new Set([read.zipId]) } as any).get(read.zipId)?.reason).toBe('stale')
    const again = shellRead('cat src/app.js', { message: 5 })
    expect(findDeadCopies([read, edit, again], { projectPath: PROJECT }).get(read.zipId)?.reason).toBe('stale')
  })

  it('an edit BEFORE the read leaves the read live', () => {
    const edit = directEdit(`${PROJECT}/src/app.js`, { message: 1 })
    const read = shellRead('cat src/app.js', { message: 3 })
    expect(dead([edit, read]).size).toBe(0)
  })

  it('a later whole read supersedes an earlier PARTIAL read too', () => {
    const part = shellRead("sed -n '1,40p' src/app.js", { message: 1 })
    const whole = shellRead('cat src/app.js', { message: 3 })
    expect(dead([part, whole]).get(part.zipId)?.reason).toBe('superseded')
  })

  it('a partial read never supersedes anything (sed -n, head, tail, a piped range, a read with a range, a cut read)', () => {
    const partials = [
      shellRead("sed -n '1,40p' src/app.js", { message: 3 }),
      shellRead('head -n 20 src/app.js', { message: 3 }),
      shellRead('tail -30 src/app.js', { message: 3 }),
      shellRead("nl -ba src/app.js | sed -n '10,20p'", { message: 3 }),
      directRead('src/app.js', { message: 3 }, { offset: 100, limit: 50 }),
      shellRead('cat src/app.js', { message: 3 }, { content: 'start\n[Output cut here by Batshit: the command printed more than 120,000 characters.]' })
    ]
    for (const partial of partials) {
      const whole = shellRead('cat src/app.js', { message: 1 })
      expect(dead([whole, partial]).size).toBe(0)
    }
  })

  // BL-678: the words `[Output cut here by ` anywhere in a read made it a cut (partial) read, so a
  // whole read of a file that quotes the guard's notice never superseded and could not be held.
  describe('only a real cut makes a read partial (BL-678)', () => {
    const files = (read: DeadCopyToolResult) => describeToolResultFiles(read, { projectPath: PROJECT })
    const sourceText = readFileSync(resolve(process.cwd(), 'src/lib/utils/toolModelTextSizeGuard.ts'), 'utf8')
    const quoted = `# Size guard notes\n${guardCutNotice(4_000)}\nThe line above is a quote.\n`

    it('a whole read of a file that quotes the notice is whole, and supersedes', () => {
      for (const content of [sourceText, quoted]) {
        expect(files(shellRead('cat src/app.js', {}, { content }))).toEqual({ kind: 'read', files: new Map([['src/app.js', 'whole']]) })
        expect(files(directRead('src/app.js', {}, {}, { content }))).toEqual({ kind: 'read', files: new Map([['src/app.js', 'whole']]) })
      }
      const older = shellRead('cat src/app.js', { message: 1 })
      const newer = shellRead('cat src/app.js', { message: 3 }, { content: quoted })
      expect(dead([older, newer]).get(older.zipId)?.reason).toBe('superseded')
    })

    it('a real guard cut view is still a cut read', () => {
      const view = formatToolModelTextCut(`${'line\n'.repeat(30_000)}`, 'tool_raw_bl678').text
      expect(files(shellRead('cat src/app.js', {}, { content: view, modelTextOnly: true })))
        .toEqual({ kind: 'read', files: new Map([['src/app.js', 'partial']]) })
      // A saved P2 view (100,000-character ceiling) ends with the same notice.
      const savedP2 = `${'x'.repeat(99_500 - 1 - guardCutNotice(99_000).length)}\n${guardCutNotice(99_000)}`
      expect(files(directRead('src/app.js', {}, {}, { content: savedP2, modelTextOnly: true })))
        .toEqual({ kind: 'read', files: new Map([['src/app.js', 'partial']]) })
    })

    it("a real runner stream cut is still a cut read, also with stderr joined after it", () => {
      const stream = limitedOutput(1_000)
      stream.append('first line\n'.repeat(200))
      expect(stream.cut).toBe(true)
      for (const content of [stream.text, `${stream.text}\nwarning printed on stderr`]) {
        expect(files(shellRead('cat src/app.js', {}, { content }))).toEqual({ kind: 'read', files: new Map([['src/app.js', 'partial']]) })
      }
    })

    it("Claude Code's cut line, with Claude's trailing note after it, is still a cut read", () => {
      for (const line of ['[Output cut here by Claude Code: 29,948 of 60,300 bytes kept.]', '[Output cut here by Claude Code: only the first 2,048 bytes kept.]']) {
        const content = `kept line\n${line}\nShell cwd was reset to /work/proj`
        expect(files(shellRead('cat src/app.js', {}, { content }))).toEqual({ kind: 'read', files: new Map([['src/app.js', 'partial']]) })
      }
    })
  })

  it('a partial copy never goes stale; only a whole read replaces it', () => {
    const part = shellRead("sed -n '1,40p' src/app.js", { message: 1 })
    const edit = directEdit('src/app.js', { message: 3 })
    expect(dead([part, edit]).size).toBe(0)
  })

  it('a failed edit never counts as an edit', () => {
    const read = shellRead('cat src/app.js', { message: 1 })
    const failed = directEdit('src/app.js', { message: 3 }, { error: 'String not found in file' })
    expect(dead([read, failed]).size).toBe(0)
  })

  it('a Bash command with an unknown effect never counts as an edit', () => {
    const read = shellRead('cat src/app.js', { message: 1 })
    const bash = (command: string, extra: Record<string, any> = {}): DeadCopyToolResult => ({
      zipId: nextId(),
      authorId: 'agent-a',
      messageIndex: 3,
      operationKind: 'bash',
      payload: { operationKind: 'bash', toolArgs: { command, ...extra }, toolResult: { command, stdout: '', exitCode: 0, ...extra } }
    })
    expect(dead([read, bash('node scripts/rewrite.js src/app.js')]).size).toBe(0)
    // A Codex delete is stored as a command that names its file; it is still not an edit.
    expect(dead([read, bash('rm src/app.js', { filePath: 'src/app.js', path: 'src/app.js' })]).size).toBe(0)
  })

  it('a managed apply_patch makes every file in the patch stale, resolved against its leading cd', () => {
    const readA = shellRead('cat pkg/a.js', { message: 1 })
    const readB = shellRead('cat pkg/b.js', { message: 1 })
    const readC = shellRead('cat c.js', { message: 1 })
    const patch = commandResult(
      'edit_file',
      "cd pkg && apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: a.js\n@@\n-x\n+y\n*** Delete File: b.js\n*** End Patch\nPATCH",
      'a.js',
      { message: 3 }
    )
    const result = dead([readA, readB, readC, patch])
    expect(result.get(readA.zipId)?.reason).toBe('stale')
    expect(result.get(readB.zipId)?.reason).toBe('stale')
    expect(result.has(readC.zipId)).toBe(false)
  })

  it('a patch followed by commands it never runs edits only the files in the patch (BL-1915)', () => {
    const readA = shellRead('cat pkg/a.js', { message: 1 })
    const readT = shellRead('cat pkg/t.js', { message: 1 })
    // The command joined by `&&` and the one on the next line were not run.
    const patch = commandResult(
      'edit_file',
      "cd pkg && apply_patch <<'PATCH' && npm test\n*** Begin Patch\n*** Update File: a.js\n@@\n-x\n+y\n*** End Patch\nPATCH\ncat > t.js <<'EOF'\n*** Update File: t.js\n*** End Patch\nEOF",
      'a.js',
      { message: 3 }
    )
    const result = dead([readA, readT, patch])
    expect(result.get(readA.zipId)?.reason).toBe('stale')
    expect(result.has(readT.zipId)).toBe(false)
  })

  it('a failed patch edits nothing, except the paths it names as left changed (BL-1916)', () => {
    const readA = shellRead('cat a.js', { message: 1 })
    const readB = shellRead('cat b.js', { message: 1 })
    const command = "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: a.js\n@@\n-x\n+y\n*** Add File: b.js\n+z\n*** End Patch\nPATCH"
    const failed = (managedApplyPatch?: Record<string, unknown>): DeadCopyToolResult => ({
      zipId: nextId(),
      authorId: 'agent-a',
      messageIndex: 3,
      operationKind: 'edit_file',
      payload: {
        operationKind: 'edit_file',
        toolArgs: { filePath: 'a.js', innerCommand: command },
        toolResult: { success: false, errorCode: 'INVALID_INPUT', reason: 'Writing "b.js" failed', ...(managedApplyPatch ? { managedApplyPatch } : {}) }
      }
    })
    // Written whole or not at all: a failed patch changed nothing.
    expect(dead([readA, readB, failed()]).size).toBe(0)
    // A write that could not be undone names what it left changed, by absolute path.
    const partial = dead([readA, readB, failed({ managed: true, partial: true, changedPaths: [`${PROJECT}/a.js`] })])
    expect(partial.get(readA.zipId)?.reason).toBe('stale')
    expect(partial.has(readB.zipId)).toBe(false)
    // The n8n automation lane keeps it in the error's details.
    const automation: DeadCopyToolResult = {
      ...failed(),
      zipId: nextId(),
      payload: {
        operationKind: 'edit_file',
        toolArgs: { filePath: 'a.js', innerCommand: command },
        toolResult: { success: false, error: { code: 'INVALID_INPUT', details: { managedApplyPatch: { managed: true, partial: true, changedPaths: [`${PROJECT}/b.js`] } } } }
      }
    }
    const viaDetails = dead([readA, readB, automation])
    expect(viaDetails.get(readB.zipId)?.reason).toBe('stale')
    expect(viaDetails.has(readA.zipId)).toBe(false)
  })

  it('patch text inside some other command is not a managed patch and edits nothing', () => {
    const read = shellRead('cat artifact.html', { message: 1 })
    const script = commandResult(
      'edit_file',
      "node - <<'NODE'\nconst patch = ['*** Begin Patch', '*** Update File: artifact.html'].join('\\n')\nNODE\n*** Begin Patch\n*** Update File: artifact.html\n*** End Patch",
      'artifact.html',
      { message: 3 }
    )
    expect(dead([read, script]).size).toBe(0)
  })

  it('a shell edit counts for its labelled path only when that path is one of its literal words and no cd moved it', () => {
    const read = shellRead('cat src/app.js', { message: 1 })
    expect(dead([read, commandResult('edit_file', "sed -i 's/a/b/' src/app.js", 'src/app.js', { message: 3 })]).get(read.zipId)?.reason).toBe('stale')
    // After a cd the label names a file under another folder: never counted.
    expect(dead([read, commandResult('edit_file', "cd vendor && sed -i 's/a/b/' src/app.js", 'src/app.js', { message: 3 })]).size).toBe(0)
    // BL-233's mislabel: the label is not a word of the command.
    expect(dead([read, commandResult('edit_file', "perl -pi -e 's/a/b/' other.js", 'src/app.js', { message: 3 })]).size).toBe(0)
  })

  it('a Codex patch of several files names them all', () => {
    const readA = shellRead('cat a.js', { message: 1 })
    const readB = shellRead('cat b.js', { message: 1 })
    const codex = directEdit('a.js', { message: 3 })
    codex.payload!.toolArgs.paths = ['a.js', 'b.js']
    const result = dead([readA, readB, codex])
    expect(result.get(readA.zipId)?.reason).toBe('stale')
    expect(result.get(readB.zipId)?.reason).toBe('stale')
  })

  it('a result that holds several files compresses only when every file in it is dead', () => {
    const both = shellRead('cat a.js b.js', { message: 1 })
    const againA = shellRead('cat a.js', { message: 3 })
    expect(dead([both, againA]).has(both.zipId)).toBe(false)
    const againB = shellRead('cat b.js', { message: 5 })
    expect(dead([both, againA, againB]).get(both.zipId)).toEqual({
      reason: 'superseded',
      deadAtMessageIndex: 5,
      files: [
        { path: 'a.js', reason: 'superseded' },
        { path: 'b.js', reason: 'superseded' }
      ]
    })
  })

  it('stale wins over superseded when a copy has both, and the copy dies at its last file', () => {
    const both = shellRead('cat a.js b.js', { message: 1 })
    const editA = directEdit('a.js', { message: 3 })
    const againB = shellRead('cat b.js', { message: 5 })
    // BL-1541: each file keeps what made it dead, for the `Current Zip State` line.
    expect(dead([both, editA, againB]).get(both.zipId)).toEqual({
      reason: 'stale',
      deadAtMessageIndex: 5,
      files: [
        { path: 'a.js', reason: 'stale' },
        { path: 'b.js', reason: 'superseded' }
      ]
    })
  })

  it('a result whose file set is unknown is never dead and never supersedes', () => {
    const unknowns = [
      'cat src/app.js | grep export',
      'cat src/*.js',
      'cat "$FILE"',
      'cat src/app.js 2>/dev/null',
      'cat src/app.js || true',
      'wc -l src/app.js && cat src/app.js',
      'cat ~/notes.md'
    ]
    for (const command of unknowns) {
      // Labelled with the file, as BL-233's mapper labels a compound read.
      const unknown = shellRead(command, { message: 1, label: 'src/app.js' })
      const whole = shellRead('cat src/app.js', { message: 3 })
      expect(dead([unknown, whole]).has(unknown.zipId), command).toBe(false)
      const earlier = shellRead('cat src/app.js', { message: 1 })
      const later = shellRead(command, { message: 3, label: 'src/app.js' })
      expect(dead([earlier, later]).size, command).toBe(0)
    }
    // The same glob read twice may name different files the second time.
    expect(dead([shellRead('cat src/*.js', { message: 1 }), shellRead('cat src/*.js', { message: 3 })]).size).toBe(0)
  })

  it('a failed read is an unknown file set', () => {
    const failed = shellRead('cat src/app.js', { message: 1 }, { exitCode: 1 })
    failed.payload!.error = 'cat: src/app.js: No such file or directory'
    const whole = shellRead('cat src/app.js', { message: 3 })
    expect(dead([failed, whole]).size).toBe(0)
    const earlier = shellRead('cat src/app.js', { message: 1 })
    const failedLater = shellRead('cat src/app.js', { message: 3 }, { success: false })
    expect(dead([earlier, failedLater]).size).toBe(0)
  })

  it("another agent's read never supersedes, and another agent's edit never makes a copy stale", () => {
    const mine = shellRead('cat src/app.js', { message: 1, author: 'agent-a' })
    const theirRead = shellRead('cat src/app.js', { message: 3, author: 'agent-b' })
    const theirEdit = directEdit('src/app.js', { message: 5, author: 'agent-b' })
    expect(dead([mine, theirRead, theirEdit]).has(mine.zipId)).toBe(false)
    // ...while agent-b's own copy is superseded only by agent-b.
    const theirSecond = shellRead('cat src/app.js', { message: 7, author: 'agent-b' })
    expect(dead([mine, theirRead, theirSecond]).get(theirRead.zipId)?.reason).toBe('superseded')
  })

  it('paths compare after normalization against the project path', () => {
    const relative = shellRead('cat ./src/../src/app.js', { message: 1 })
    const absolute = directRead(`${PROJECT}/src/app.js`, { message: 3 })
    expect(dead([relative, absolute]).get(relative.zipId)?.reason).toBe('superseded')

    const viaCd = shellRead('cd src && cat app.js', { message: 1 })
    expect(dead([viaCd, shellRead('cat src/app.js', { message: 3 })]).get(viaCd.zipId)?.reason).toBe('superseded')

    const tmp = findDeadCopies(
      [shellRead('cat /private/tmp/job/a.txt', { message: 1 }), directRead('a.txt', { message: 3 })],
      { projectPath: '/tmp/job' }
    )
    expect(tmp.size).toBe(1)
  })

  it('when in doubt the copy stays: without a project path a relative and an absolute path never match', () => {
    const relative = shellRead('cat src/app.js', { message: 1 })
    const absolute = directRead(`${PROJECT}/src/app.js`, { message: 3 })
    expect(findDeadCopies([relative, absolute], {}).size).toBe(0)
  })

  it('a long direct read may be the start of a longer file, so it never supersedes', () => {
    const earlier = shellRead('cat big.ts', { message: 1 })
    const capped = directRead('big.ts', { message: 3 }, {}, { lineCount: 2000 })
    expect(dead([earlier, capped]).size).toBe(0)
  })

  it('skill reads: only invoke is whole, so a read window never supersedes', () => {
    const invoke = skillRead('writer', 'SKILL.md', 'invoke', { message: 1 })
    const window = skillRead('writer', 'SKILL.md', 'read', { message: 3 })
    expect(dead([invoke, window]).size).toBe(0)
    const again = skillRead('writer', 'SKILL.md', 'invoke', { message: 5 })
    const result = dead([invoke, window, again])
    expect(result.get(invoke.zipId)?.reason).toBe('superseded')
    expect(result.get(window.zipId)?.reason).toBe('superseded')
    // another skill's file with the same name is another file
    expect(dead([skillRead('other', 'SKILL.md', 'invoke', { message: 1 }), again]).size).toBe(0)
  })
})

describe('readFilesFromCommand: the strict read grammar', () => {
  const read = (command: string) => {
    const files = readFilesFromCommand(command, PROJECT)
    return files ? Object.fromEntries(files) : null
  }

  it('reads whole files through cat and nl, with separators and a leading cd', () => {
    expect(read('cat -n a.js b.js')).toEqual({ 'a.js': 'whole', 'b.js': 'whole' })
    expect(read('nl -ba a.js')).toEqual({ 'a.js': 'whole' })
    expect(read('cd sub && echo "=== a.js ===" && cat a.js && echo "=== b.js ===" && cat b.js')).toEqual({
      'sub/a.js': 'whole',
      'sub/b.js': 'whole'
    })
    expect(read("/bin/zsh -lc 'cat a.js'")).toEqual({ 'a.js': 'whole' })
    expect(read('cat a.js\ncat b.js')).toEqual({ 'a.js': 'whole', 'b.js': 'whole' })
    expect(read(`cat ${PROJECT}/routes/+server.ts`)).toEqual({ 'routes/+server.ts': 'whole' })
  })

  it('reads parts through sed -n ranges, head, tail, and a whole read piped to a range', () => {
    expect(read("sed -n '1,20p;40,60p' a.js")).toEqual({ 'a.js': 'partial' })
    expect(read('head -5 a.js && tail -n 5 b.js')).toEqual({ 'a.js': 'partial', 'b.js': 'partial' })
    expect(read('cat -n a.js | head -n 50')).toEqual({ 'a.js': 'partial' })
    expect(read("sed -n '1,5p' a.js && cat a.js")).toEqual({ 'a.js': 'whole' })
  })

  it('refuses everything else', () => {
    for (const command of [
      'cat a.js; rm b.js',
      'cat a.js | grep x',
      'tail -f log.txt',
      'cat - < a.js',
      'cat a.js && cd sub && cat b.js',
      "sed -i 's/a/b/' a.js",
      'cat a.js # comment',
      'cat $(ls)',
      '(cat a.js)',
      'cat a.js &'
    ]) {
      expect(read(command), command).toBeNull()
    }
  })

  it('describes a skill read by its skill, never by a project path', () => {
    const files = describeToolResultFiles(skillRead('writer', 'references/x.md', 'read'), { projectPath: PROJECT })
    expect(files.kind === 'read' ? Object.fromEntries(files.files) : null).toEqual({ 'skill:writer:references/x.md': 'partial' })
  })
})

describe('the zip prompts teach the words the compile writes (SA-129 DL-03, DL-04)', () => {
  // BL-1756: the packaged prompt file holds only the guidance variable, and the compile fills it
  // with the built block (`resolveToolZipGuidancePrompt`), so the words are checked in the prompt
  // as each runtime receives it. Josh's text (2026-10-23) teaches two status lines by example and
  // the Zip Index headings by name; the compile writes the same headings (`ZIP_INDEX_STATUS_HEADINGS`).
  // SA-139 R4: the API lane (`vercel`) is the one lane a compile builds; the `claude` variants left
  // with the CLI compile flavor.
  const file = 'batshit_tool_prompt_zips.md'
  const variants = [
    ...[true, false].map((toolNotesEnabled) => ({ runtimeFlavor: 'vercel' as const, toolNotesEnabled, liveFileReads: false })),
    { runtimeFlavor: 'vercel' as const, toolNotesEnabled: true, liveFileReads: true },
    { runtimeFlavor: 'vercel' as const, toolNotesEnabled: false, liveFileReads: true }
  ]
  for (const { runtimeFlavor, toolNotesEnabled, liveFileReads } of variants) {
    it(`${file} (${runtimeFlavor}, Tool Notes ${toolNotesEnabled ? 'on' : 'off'}, Refreshed File Reads ${liveFileReads ? 'on' : 'off'})`, () => {
      const block = buildToolGuidanceZipPromptBlock({ toolNotesEnabled, liveFileReads })
      const prompt = applyPromptRuntimeScope(
        readFileSync(resolve(process.cwd(), `../docs/batshit_System_Prompts/${file}`), 'utf8'),
        'api'
      )
        .replaceAll('{{ $api_tool_zip_guidance }}', block)
      // The Zip Index's status headings, as the compile writes them (decision 5).
      expect(prompt).toContain(`**${ZIP_INDEX_STATUS_HEADINGS.settings}**`)
      expect(prompt).toContain(`**${ZIP_INDEX_STATUS_HEADINGS.zippedThisTurn}**`)
      expect(prompt).not.toContain('Current Zip State')
      // BL-1756 named Tool Notes in the last-reply line (2026-10-18); BL-1785 (Josh, 2026-10-19,
      // option B) gives an agent with Tool Notes off its own line, never naming them.
      expect(prompt).toContain(`\`${readCompressHintLastReply(toolNotesEnabled)}\``)
      expect(prompt).toContain(`\`${HELD_BY_USER_HINT}\``)
      expect(heldByUserForMessagesHint(3).replace('3', 'N')).toBe('Held by the user for N messages.')
      // The size guard's words, word for word.
      expect(prompt).toContain('`large: hold it or fetch it`')
      expect(prompt).toContain('`too large to open: fetch it in parts`')
      expect(prompt).toContain('`Output cut here by Batshit`')
      expect(prompt).not.toContain('on Codex')
      expect(prompt.includes('REFRESHED: <file>, <range> (at the start of this turn)')).toBe(liveFileReads)
      // Josh's order: the overview, how to operate, the notes and holds, the file copies, the size
      // guard, the cost recap, then the sections that are not about Zips.
      const order = [
        "# Batshit's Unique Tool Results Compression System (Zips)",
        '## So WHEN do Zips get Zipped or Unzipped? And WHY?',
        '## How You Need to Operate as a Batshit Agent',
        ...(toolNotesEnabled ? ['## More About Tool Notes', '## Tool Notes, Zip Hold and Zip Release: How to Use'] : ['## Zip Hold and Zip Release: How to Use']),
        liveFileReads ? '## Refreshed File Reads' : '## Older Copies of a File',
        '## Very Large Results (Size Guard)',
        '## Your Part: Keeping Costs Down',
        '# Messages That Reach You While You Work',
        '# Work Modes (Plan, Agent, Dangerous)',
        '# When an Action Fails'
      ].map((words) => prompt.indexOf(words))
      expect(order.every((at) => at >= 0)).toBe(true)
      expect([...order].sort((a, b) => a - b)).toEqual(order)
      // Decision 6: a result that is not a file comes back with Fetch Zip; nobody asks the user.
      expect(prompt).not.toContain('ask the user to hold')
      expect(prompt.includes('Your Tool Notes are your memory.')).toBe(toolNotesEnabled)
      expect(prompt).not.toContain('Tool Notes are disabled for this agent/session.')
    })
  }
})

// SA-129 P2 (DL-02): what a hold or release names, and which read it lands on.
describe('holds', () => {
  it('reads a project path relative or absolute, and a skill file as <skill id>/<path>', () => {
    expect(holdPathKeys('src/app.ts', { projectPath: PROJECT })).toEqual(['src/app.ts', 'skill:src:app.ts'])
    expect(holdPathKeys(`${PROJECT}/src/app.ts`, { projectPath: PROJECT })).toEqual(['src/app.ts'])
    expect(holdPathKeys('/elsewhere/x.md', { projectPath: PROJECT })).toEqual(['/elsewhere/x.md'])
    expect(holdPathKeys('skill:skill_creator/SKILL.md', { projectPath: PROJECT })).toEqual(['skill:skill_creator:SKILL.md'])
    expect(holdPathKeys('skill_creator/references/a.md', { projectPath: PROJECT })).toEqual([
      'skill_creator/references/a.md',
      'skill:skill_creator:references/a.md'
    ])
  })

  it('means nothing for a path it cannot compare (a ~, a flag, an empty entry)', () => {
    expect(holdPathKeys('~/notes.md', { projectPath: PROJECT })).toEqual([])
    expect(holdPathKeys('', { projectPath: PROJECT })).toEqual([])
    expect(holdPathKeys('   ', { projectPath: PROJECT })).toEqual([])
  })

  it('shows a skill key the way the agent names it', () => {
    expect(describeHeldPath('skill:skill_creator:SKILL.md')).toBe('skill_creator/SKILL.md')
    expect(describeHeldPath('src/app.ts')).toBe('src/app.ts')
  })

  it('finds the newest WHOLE read of each file; a partial read never counts', () => {
    const first = directRead('src/app.ts', { message: 0 })
    const partial = directRead('src/app.ts', { message: 1 }, { offset: 5, limit: 10 })
    const second = directRead(`${PROJECT}/src/app.ts`, { message: 2 })
    const newest = newestWholeReadsByFile([first, partial, second], { projectPath: PROJECT })
    expect(newest.get('src/app.ts')).toEqual({ zipId: second.zipId, messageIndex: 2 })
    const onlyPartial = newestWholeReadsByFile([directRead('b.ts', {}, { offset: 1 })], { projectPath: PROJECT })
    expect(onlyPartial.has('b.ts')).toBe(false)
  })
})

describe('describeDeadCopiesCompressedThisTurn: the Current Zip State line (BL-1541)', () => {
  it('names each path once with its reason, in chat order', () => {
    expect(
      describeDeadCopiesCompressedThisTurn([
        { files: [{ path: 'src/money.js', reason: 'superseded' }] },
        { files: [{ path: 'src/cli.js', reason: 'stale' }] }
      ])
    ).toBe('- Older copies compressed this turn: src/money.js (was read again later), src/cli.js (was edited after the read).')
  })

  it('lists a path once when several copies of it compressed at once; the newest copy\'s reason wins', () => {
    expect(
      describeDeadCopiesCompressedThisTurn([
        { files: [{ path: 'src/money.js', reason: 'superseded' }] },
        { files: [{ path: 'src/money.js', reason: 'stale' }, { path: 'src/cli.js', reason: 'superseded' }] }
      ])
    ).toBe('- Older copies compressed this turn: src/money.js (was edited after the read), src/cli.js (was read again later).')
  })

  it('names a skill file the way an agent names it, and says nothing when nothing compressed', () => {
    expect(describeDeadCopiesCompressedThisTurn([{ files: [{ path: 'skill:writer:SKILL.md', reason: 'superseded' }] }])).toBe(
      '- Older copies compressed this turn: writer/SKILL.md (was read again later).'
    )
    expect(describeDeadCopiesCompressedThisTurn([])).toBeNull()
    expect(describeDeadCopiesCompressedThisTurn([{ files: [] }])).toBeNull()
  })
})
