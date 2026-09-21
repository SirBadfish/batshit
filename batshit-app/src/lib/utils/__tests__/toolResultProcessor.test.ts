import { describe, expect, it } from 'vitest'
import {
  normalizeToolStep,
  processIntermediateSteps,
  toolFailureFallbackMessage,
  toolStepFailureMessage,
  toolStepFailureSource,
  toolStepFoundNothing
} from '../toolResultProcessor'
import { PRESENT_FILE_CONTENT, PRESENT_FILE_PATH, apiShellStep } from '$lib/test-utils/shell-command-steps'

describe('normalizeToolStep', () => {
  it('parses native bash list stdout into list_files entries', () => {
    const normalized = normalizeToolStep({
      type: 'tool',
      toolName: 'batshit_server_list_files',
      toolArgs: {
        command: 'ls -la /Users/example/batshit/docs/user-docs/architecture',
        path: '/Users/example/batshit/docs/user-docs/architecture'
      },
      toolResult: {
        stdout:
          'total 8\n' +
          'drwxr-xr-x  3 user staff   96 Feb 08 12:00 deep-dives\n' +
          '-rw-r--r--  1 user staff  774 Feb 08 12:00 README.md',
        mappedToolInput: {
          path: '/Users/example/batshit/docs/user-docs/architecture',
          dirPath: '/Users/example/batshit/docs/user-docs/architecture'
        }
      }
    } as any)

    expect(normalized.toolName).toBe('list_files')
    const files = (normalized.toolResult as any).files
    expect(Array.isArray(files)).toBe(true)
    expect(files.length).toBe(2)
    expect(files[0]?.name).toBe('deep-dives')
    expect(files[0]?.type).toBe('directory')
    expect(files[1]?.name).toBe('README.md')
    expect((normalized.toolResult as any).dirPath).toBe('/Users/example/batshit/docs/user-docs/architecture')
  })

  it('preserves unknown entry type for bare ls output without directory markers', () => {
    const normalized = normalizeToolStep({
      type: 'tool',
      toolName: 'batshit_server_list_files',
      toolArgs: {
        command: 'ls /Users/example/hello',
        path: '/Users/example/hello'
      },
      toolResult: {
        stdout: 'artifacts\nhello.md'
      }
    } as any)

    expect(normalized.toolName).toBe('list_files')
    const files = (normalized.toolResult as any).files
    expect(Array.isArray(files)).toBe(true)
    expect(files).toEqual([
      expect.objectContaining({
        name: 'artifacts',
        type: 'unknown'
      }),
      expect.objectContaining({
        name: 'hello.md',
        type: 'unknown'
      })
    ])
  })

  it('prefers stdout for read_file content to avoid JSON blob rendering', () => {
    const normalized = normalizeToolStep({
      type: 'tool',
      toolName: 'batshit_server_read_file',
      toolArgs: {
        command: "sed -n '1,40p' docs/user-docs/security/overview.md"
      },
      toolResult: {
        success: true,
        stdout: '# Batshit Coding Standards\n\nLine 2',
        mappedToolInput: {
          filePath: 'docs/user-docs/security/overview.md',
          path: 'docs/user-docs/security/overview.md'
        }
      }
    } as any)

    expect(normalized.toolName).toBe('read_file')
    expect((normalized.toolResult as any).content).toBe('# Batshit Coding Standards\n\nLine 2')
    expect((normalized.toolResult as any).content).not.toContain('"stdout"')
    expect((normalized.toolResult as any).filePath).toBe('docs/user-docs/security/overview.md')
  })

  it('resolves edit_file path from mapped native bash metadata', () => {
    const normalized = normalizeToolStep({
      type: 'tool',
      toolName: 'batshit_server_edit_file',
      toolArgs: {
        command:
          "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: docs/user-docs/architecture/local-first-boundaries.md\n*** End Patch\nPATCH"
      },
      toolResult: {
        mappedToolInput: {
          filePath: 'docs/user-docs/architecture/local-first-boundaries.md',
          path: 'docs/user-docs/architecture/local-first-boundaries.md'
        },
        output:
          "*** Begin Patch\n*** Update File: docs/user-docs/architecture/local-first-boundaries.md\n*** End Patch"
      }
    } as any)

    expect(normalized.toolName).toBe('edit_file')
    expect((normalized.toolResult as any).filePath).toBe('docs/user-docs/architecture/local-first-boundaries.md')
  })

  it('preserves blocked apply_patch edits as failed edit_file results', () => {
    const command =
      "apply_patch <<'PATCH'\n" +
      '*** Begin Patch\n' +
      '*** Update File: batshit-app/src/routes/api/artifacts/complete/+server.ts\n' +
      '@@\n' +
      '+async function generateOpenAIImageDirect() {}\n' +
      '*** End Patch\n' +
      'PATCH'
    const blockedResult = {
      success: false,
      blocked: true,
      errorCode: 'POLICY_BLOCKED',
      reason:
        'Batshit product source is read-only from in-app agents. Use the external coding workspace to edit files inside the Batshit repo.',
      command
    }

    const normalized = normalizeToolStep({
      type: 'tool',
      toolName: 'batshit_server_edit_file',
      toolArgs: {
        command,
        filePath: 'batshit-app/src/routes/api/artifacts/complete/+server.ts'
      },
      toolResult: blockedResult,
      success: true
    } as any)

    expect(normalized.toolName).toBe('edit_file')
    expect(normalized.success).toBe(false)
    expect(normalized.error).toContain('read-only from in-app agents')
    expect((normalized.toolResult as any).success).toBe(false)
    expect((normalized.toolResult as any).blocked).toBe(true)
    expect((normalized.toolResult as any).errorCode).toBe('POLICY_BLOCKED')
    expect((normalized.toolResult as any).reason).toContain('external coding workspace')
    expect((normalized.toolResult as any).diff).toContain('generateOpenAIImageDirect')

    const segments = processIntermediateSteps([
      {
        type: 'tool',
        toolName: 'batshit_server_edit_file',
        toolArgs: {
          command,
          filePath: 'batshit-app/src/routes/api/artifacts/complete/+server.ts'
        },
        toolResult: blockedResult,
        success: true
      } as any
    ])

    expect(segments).toHaveLength(1)
    expect((segments[0] as any).toolStatus).toBe('error')
    expect((segments[0] as any).intermediateStep.success).toBe(false)
    expect((segments[0] as any).intermediateStep.error).toContain('read-only from in-app agents')
  })

  it('extracts edit_file diff text from nested native bash apply_patch wrappers', () => {
    const patch =
      "apply_patch<<'PATCH'\n" +
      '*** Begin Patch\n' +
      '*** Update File: /Users/example/hello/sa049-mode2-write.txt\n' +
      '@@\n' +
      ' alpha\n' +
      '-beta\n' +
      '+BRAVO\n' +
      ' gamma\n' +
      '*** End Patch\n' +
      'PATCH'

    const normalized = normalizeToolStep({
      type: 'tool',
      toolName: 'batshit_server_edit_file',
      toolArgs: {
        command: patch,
        filePath: 'sa049-mode2-write.txt',
        path: 'sa049-mode2-write.txt'
      },
      toolResult: {
        data: {
          command: patch,
          mappedToolInput: {
            command: patch,
            innerCommand: patch,
            filePath: 'sa049-mode2-write.txt',
            path: 'sa049-mode2-write.txt'
          }
        }
      }
    } as any)

    expect(normalized.toolName).toBe('edit_file')
    expect((normalized.toolResult as any).filePath).toBe('sa049-mode2-write.txt')
    expect((normalized.toolResult as any).diff).toContain('*** Begin Patch')
    expect((normalized.toolResult as any).diff).toContain('+BRAVO')
  })

  // `nativeBashExecute` reports an edit's diff, built from copies of its target read around a clean
  // run. This rebuild once dropped those copies, so every API edit without a patch was stored as
  // "Diff unavailable"; the run now sends only the diff, and the rebuild keeps it.
  describe("an API edit's diff", () => {
    const edited = PRESENT_FILE_CONTENT.replace('First', 'Last')
    const snapshotDiff =
      '--- Before\n+++ After\n    1 | # Notes\n    2 | \n-   3 | First line.\n+   3 | Last line.\n    4 | Second line.\n    5 | '

    it('keeps the diff the run reports, and nothing else of the run', () => {
      const normalized = normalizeToolStep(
        apiShellStep({
          id: 'toolu_api_edit',
          command: `sed -i 's/First/Last/' ${PRESENT_FILE_PATH}`,
          exitCode: 0,
          snapshots: { before: PRESENT_FILE_CONTENT, after: edited }
        }) as any
      )

      expect(normalized.toolName).toBe('edit_file')
      expect(normalized.toolResult).toEqual({ diff: snapshotDiff, filePath: PRESENT_FILE_PATH, language: 'markdown' })
    })

    it('never takes what the command printed for the diff', () => {
      const normalized = normalizeToolStep(
        apiShellStep({
          id: 'toolu_api_edit_print',
          command:
            `python3 - <<'PY'\nfrom pathlib import Path\np = Path('${PRESENT_FILE_PATH}')\n` +
            "p.write_text(p.read_text().replace('First', 'Last'))\nprint('done')\nPY",
          stdout: 'done\n',
          exitCode: 0,
          snapshots: { before: PRESENT_FILE_CONTENT, after: edited }
        }) as any
      )

      expect((normalized.toolResult as any).diff).toBe(snapshotDiff)
    })

    it('keeps the run saying the command left the file as it was', () => {
      const normalized = normalizeToolStep(
        apiShellStep({
          id: 'toolu_api_edit_nomatch',
          command: `sed -i 's/zzz/yyy/' ${PRESENT_FILE_PATH}`,
          exitCode: 0,
          snapshots: { before: PRESENT_FILE_CONTENT, after: PRESENT_FILE_CONTENT }
        }) as any
      )

      expect((normalized.toolResult as any).diff).toBe(
        `No changes: the command left ${PRESENT_FILE_PATH} exactly as it was.`
      )
    })

    it('reads the diff the native wrapper nests under `data`', () => {
      const command = `sed -i 's/First/Last/' ${PRESENT_FILE_PATH}`
      const normalized = normalizeToolStep({
        type: 'tool',
        toolName: 'batshit_server_edit_file',
        toolArgs: { command, filePath: PRESENT_FILE_PATH, path: PRESENT_FILE_PATH },
        toolResult: { data: { success: true, exitCode: 0, diff: snapshotDiff } }
      } as any)

      expect((normalized.toolResult as any).diff).toBe(snapshotDiff)
    })

    it('keeps the patch an `apply_patch` wrote', () => {
      const command =
        `apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: ${PRESENT_FILE_PATH}\n@@\n` +
        '-First line.\n+Last line.\n*** End Patch\nPATCH'
      const normalized = normalizeToolStep(
        apiShellStep({
          id: 'toolu_api_patch',
          command,
          exitCode: 0,
          snapshots: { before: PRESENT_FILE_CONTENT, after: edited }
        }) as any
      )

      expect((normalized.toolResult as any).diff).toBe(
        `*** Begin Patch\n*** Update File: ${PRESENT_FILE_PATH}\n@@\n-First line.\n+Last line.\n*** End Patch`
      )
    })

    // Nothing sends the copies any more; one that still arrives is not a diff.
    it('builds no diff from stray copies of the file', () => {
      const step = apiShellStep({
        id: 'toolu_api_edit_stray',
        command: `sed -i 's/First/Last/' ${PRESENT_FILE_PATH}`,
        exitCode: 0
      })
      step.toolResult = { ...step.toolResult, before: PRESENT_FILE_CONTENT, after: edited }

      const normalized = normalizeToolStep(step as any)

      expect((normalized.toolResult as any).diff).toBeUndefined()
      expect(JSON.stringify(normalized.toolResult)).not.toContain('Second line')
    })
  })

  it('does not report approval-pending execute_command steps as exit code 0', () => {
    const normalized = normalizeToolStep({
      type: 'tool',
      toolName: 'batshit_server_execute_command',
      toolArgs: {
        command: 'mkdir Luci'
      },
      success: false,
      toolResult: {}
    } as any)

    expect(normalized.toolName).toBe('execute_command')
    // The command has not run, so it has no exit code at all.
    expect(normalized.toolResult).not.toHaveProperty('exitCode')
    expect((normalized.toolResult as any).stderr).toContain('Awaiting approval before execution.')
  })

  // F-P5-1: a failed sandbox start used to come back as `exitCode: 0` with empty output.
  it.each([
    {
      label: 'a sandbox that failed to start',
      result: {
        success: false,
        blocked: false,
        errorCode: 'SANDBOX_UNAVAILABLE',
        reason: 'Error: failed to create container (cause: "exists: container already exists")',
        command: 'git log --oneline -5',
        backend: 'apple_container'
      }
    },
    {
      label: 'a policy block',
      result: {
        success: false,
        blocked: true,
        errorCode: 'POLICY_BLOCKED',
        reason: 'Batshit product source is read-only from in-app agents.',
        command: 'git log --oneline -5',
        backend: 'apple_container'
      }
    }
  ])('reports $label as a failure with its reason and no exit code', ({ result }) => {
    const normalized = normalizeToolStep({
      type: 'tool',
      toolName: 'native_bash_execute',
      toolArgs: { command: 'git log --oneline -5' },
      toolResult: result
    } as any)

    expect(normalized.toolName).toBe('execute_command')
    expect(normalized.success).toBe(false)
    expect(normalized.error).toBe(result.reason)
    expect(normalized.toolResult).not.toHaveProperty('exitCode')
    expect(normalized.toolResult).toMatchObject({
      stdout: '',
      stderr: result.reason,
      errorCode: result.errorCode,
      command: 'git log --oneline -5'
    })
  })

  it('keeps the exit code and stderr of a command that ran and failed', () => {
    const normalized = normalizeToolStep({
      type: 'tool',
      toolName: 'native_bash_execute',
      toolArgs: { command: 'false' },
      toolResult: {
        success: false,
        blocked: false,
        command: 'false',
        stdout: '',
        stderr: 'boom',
        exitCode: 1
      }
    } as any)

    expect(normalized.toolResult).toMatchObject({ stdout: '', stderr: 'boom', exitCode: 1 })
    expect(normalized.toolResult).not.toHaveProperty('errorCode')
  })

  // F-P6-5: a shell `cat` shaped as a file read kept its text and dropped its failure.
  it.each([
    { label: 'exited 1', exitCode: 1, kept: 1 },
    { label: 'exited 0', exitCode: 0, kept: undefined },
    { label: 'reported no exit code', exitCode: undefined, kept: undefined }
  ])('keeps the exit code of a shell read only when it failed ($label)', ({ exitCode, kept }) => {
    const normalized = normalizeToolStep({
      type: 'tool',
      toolName: 'batshit_server_read_file',
      toolArgs: { command: 'cat /tmp/missing.txt', filePath: '/tmp/missing.txt' },
      toolResult: {
        content: 'cat: /tmp/missing.txt: No such file or directory\n',
        exitCode,
        status: exitCode ? 'failed' : 'completed',
        filePath: '/tmp/missing.txt'
      }
    } as any)

    expect(normalized.toolName).toBe('read_file')
    expect((normalized.toolResult as any).exitCode).toBe(kept)
    expect(Object.keys(normalized.toolResult as any)).toEqual(
      kept === undefined
        ? ['content', 'filePath', 'language', 'lineCount']
        : ['content', 'filePath', 'language', 'lineCount', 'exitCode']
    )
  })

  // F-P6-5 follow-up: the last command decides the exit code, and grep's exit 1 means no match.
  it('keeps no exit code for a shell read piped into a search that matched nothing', () => {
    const normalized = normalizeToolStep({
      type: 'tool',
      toolName: 'batshit_server_read_file',
      toolArgs: { command: 'cat notes.md | grep zzz', filePath: 'notes.md' },
      toolResult: { content: '', exitCode: 1, status: 'failed', filePath: 'notes.md' }
    } as any)

    expect(normalized.toolName).toBe('read_file')
    expect(normalized.toolResult).not.toHaveProperty('exitCode')
  })

  // F-P6-5 follow-up item 1: the API lane's native bash calls every non-zero exit a failure.
  it.each([
    { label: 'a search that matched nothing', toolName: 'batshit_server_search_files', command: 'rg zzz src', exitCode: 1, failed: false },
    { label: 'a grep that matched nothing', toolName: 'batshit_server_search_files', command: 'grep -rn zzz src', exitCode: 1, failed: false },
    { label: 'an `rg --files` listing with nothing in it', toolName: 'batshit_server_list_files', command: 'rg --files /tmp/empty', exitCode: 1, failed: false },
    { label: 'a read piped into a search that matched nothing', toolName: 'batshit_server_read_file', command: 'cat notes.md | grep zzz', exitCode: 1, failed: false },
    { label: 'a search reached through a failed OR branch', toolName: 'batshit_server_search_files', command: 'false || rg zzz src', exitCode: 1, failed: false },
    { label: 'a search skipped after a failed AND branch', toolName: 'batshit_server_search_files', command: 'false && rg zzz src', exitCode: 1, failed: true },
    { label: 'a search skipped by an explicit shell exit', toolName: 'batshit_server_search_files', command: 'exit 1; rg zzz src', exitCode: 1, failed: true },
    { label: 'an OR search skipped by an earlier shell exit', toolName: 'batshit_server_search_files', command: 'exit 1; false || rg zzz src', exitCode: 1, failed: true },
    { label: 'an OR search skipped by combined-flag errexit', toolName: 'batshit_server_search_files', command: 'set -eu; false; false || rg zzz src', exitCode: 1, failed: true },
    { label: 'a search that hit an error', toolName: 'batshit_server_search_files', command: 'rg zzz /nope', exitCode: 2, failed: true },
    { label: 'a read of a missing file', toolName: 'batshit_server_read_file', command: 'cat /nope', exitCode: 1, failed: true },
    { label: 'a listing of a missing directory', toolName: 'batshit_server_list_files', command: 'ls /nope', exitCode: 1, failed: true }
  ])('stores $label as failed=$failed on the API lane', ({ toolName, command, exitCode, failed }) => {
    const normalized = normalizeToolStep({
      type: 'tool',
      toolName,
      toolArgs: { command, innerCommand: command },
      toolResult: { success: exitCode === 0, blocked: false, command, stdout: '', stderr: '', exitCode, timedOut: false }
    } as any)

    expect(Boolean(normalized.error)).toBe(failed)
    expect(normalized.success === false).toBe(failed)
  })

  it('keeps a search that timed out or was blocked a failure whatever it exited with', () => {
    const timedOut = normalizeToolStep({
      type: 'tool',
      toolName: 'batshit_server_search_files',
      toolArgs: { command: 'rg zzz src', innerCommand: 'rg zzz src' },
      toolResult: { success: false, command: 'rg zzz src', stdout: '', stderr: '', exitCode: 1, timedOut: true }
    } as any)
    const blocked = normalizeToolStep({
      type: 'tool',
      toolName: 'batshit_server_search_files',
      toolArgs: { command: 'rg zzz src', innerCommand: 'rg zzz src' },
      toolResult: { success: false, blocked: true, reason: 'Blocked by Agent mode policy.', command: 'rg zzz src' }
    } as any)

    expect(timedOut.error).toBeTruthy()
    expect(blocked.error).toBe('Blocked by Agent mode policy.')
  })

  it('leaves the bash lane its own failure, since bash keeps every exit code it reported', () => {
    const normalized = normalizeToolStep({
      type: 'tool',
      toolName: 'native_bash_execute',
      toolArgs: { command: 'echo start; grep zzz notes.md' },
      toolResult: {
        success: false,
        command: 'echo start; grep zzz notes.md',
        stdout: 'start\n',
        stderr: '',
        exitCode: 1,
        timedOut: false
      }
    } as any)

    expect(normalized.toolName).toBe('execute_command')
    // fp65h: the result names no reason, so the failure gives its exit code.
    expect(normalized.error).toBe('The command failed with exit code 1.')
  })

  // fp65g: send-routed's own copies of an API step (the Execution Viewer's, the saved message's,
  // the `end` event's) read the raw native flag, so a search that matched nothing was a failed
  // row there while the stored zip called it the answer it is. Both now ask one rule.
  describe('the exit-1 rule the stored step and its copies share (fp65g)', () => {
    const DIR = '/tmp/batshit-example'

    it.each([
      { label: 'a search that matched nothing', command: `rg zzz ${DIR}`, exitCode: 1, foundNothing: true },
      { label: 'a grep that matched nothing', command: `grep -rn zzz ${DIR}`, exitCode: 1, foundNothing: true },
      { label: 'an `rg --files` listing with nothing in it', command: 'rg --files /tmp/empty', exitCode: 1, foundNothing: true },
      { label: 'a read piped into a search that matched nothing', command: `cat ${PRESENT_FILE_PATH} | grep zzz`, exitCode: 1, foundNothing: true },
      { label: 'a search reached through a failed OR branch', command: `false || rg zzz ${DIR}`, exitCode: 1, foundNothing: true },
      { label: 'a search skipped after a failed AND branch', command: `false && rg zzz ${DIR}`, exitCode: 1, foundNothing: false },
      { label: 'a skipped search at the end of a pipeline', command: `false && cat ${PRESENT_FILE_PATH} | grep zzz`, exitCode: 1, foundNothing: false },
      { label: 'an OR search skipped by an earlier shell exit', command: `exit 1; false || rg zzz ${DIR}`, exitCode: 1, foundNothing: false },
      { label: 'an OR search skipped by combined-flag errexit', command: `set -eu; false; false || rg zzz ${DIR}`, exitCode: 1, foundNothing: false },
      { label: 'a search that hit an error', command: 'grep -rn zzz /nope', stderr: 'grep: /nope: No such file or directory\n', exitCode: 2, foundNothing: false },
      { label: 'a read of a missing file', command: 'cat /nope', exitCode: 1, foundNothing: false },
      { label: 'a listing of a missing directory', command: 'ls /nope', exitCode: 1, foundNothing: false },
      { label: 'a bash pipeline that ends in a grep with no match', command: 'echo hi | grep zzz', exitCode: 1, foundNothing: false },
      { label: 'a search that matched', command: `grep -rn First ${DIR}`, stdout: `${PRESENT_FILE_PATH}:3:First line.\n`, exitCode: 0, foundNothing: false }
    ])('reads $label on the API lane the way the stored step does', ({ command, exitCode, stdout, stderr, foundNothing }) => {
      const step = apiShellStep({ id: 'toolu_step_copy', command, exitCode, stdout, stderr })
      const stored = normalizeToolStep({ ...step } as any)

      expect(toolStepFoundNothing(step.toolName, step.toolArgs, step.toolResult)).toBe(foundNothing)
      expect(toolStepFailureSource(step.toolName, step.toolArgs, step.toolResult)).toBe(
        foundNothing ? undefined : step.toolResult
      )
      // The stored step drops the raw flag exactly where the copies do.
      expect(Boolean(stored.error)).toBe(exitCode !== 0 && !foundNothing)
    })

    it('keeps a search that timed out or never ran a failure in the copies too', () => {
      const step = apiShellStep({ id: 'toolu_step_copy_timeout', command: `rg zzz ${DIR}`, exitCode: 1 })
      const timedOut = { ...step.toolResult, timedOut: true }
      const blocked = {
        success: false,
        blocked: true,
        reason: 'Blocked by Agent mode policy.',
        exitCode: 1,
        mappedToolName: step.toolResult.mappedToolName
      }

      expect(toolStepFailureSource(step.toolName, step.toolArgs, timedOut)).toBe(timedOut)
      expect(toolStepFailureSource(step.toolName, step.toolArgs, blocked)).toBe(blocked)
    })

    it('never excuses a tool that is not a shell command stored as a file action', () => {
      const result = { success: false, command: 'rg zzz src', stdout: '', stderr: '', exitCode: 1, timedOut: false }

      expect(toolStepFailureSource('native_bash_execute', { command: 'rg zzz src' }, result)).toBe(result)
      expect(toolStepFailureSource('web_search', { query: 'rg zzz src' }, result)).toBe(result)
      expect(toolStepFailureSource(undefined, { command: 'rg zzz src' }, result)).toBe(result)
    })
  })

  // fp65h: the words a copy of a step (the Execution Viewer's row, the saved message's step, the
  // `end` event's) gives for a failure, from the facts the stored zip reads. A Codex command that
  // exited non-zero carries only its exit code, and an API command that ran out of time carries
  // `timedOut: true` with no reason, so the first was a Success row and the second said only
  // `Tool execution failed.`
  describe('the words a failed step gives (fp65h)', () => {
    const codexStep = (toolName: string, command: string, result: Record<string, unknown>) => ({
      toolName,
      args: { command: `/bin/zsh -lc '${command}'`, innerCommand: command },
      result
    })

    it.each([
      {
        label: 'a Codex read of a missing file',
        step: codexStep('batshit_server_read_file', 'cat /nope', { content: 'cat: /nope: No such file or directory\n', exitCode: 1, status: 'failed' }),
        words: 'The command failed with exit code 1.'
      },
      {
        label: 'a Codex search that hit an error',
        step: codexStep('batshit_server_search_files', 'rg zzz /nope', { output: 'rg: /nope: No such file or directory\n', exitCode: 2, status: 'failed' }),
        words: 'The command failed with exit code 2.'
      },
      {
        label: 'a Codex bash command that exited 3',
        step: codexStep('batshit_server_execute_command', 'node build.js', { output: 'boom\n', exitCode: 3, status: 'failed' }),
        words: 'The command failed with exit code 3.'
      },
      {
        label: 'a Codex bash grep with no match, which bash counts like the API lane does',
        step: codexStep('batshit_server_execute_command', 'echo hi | grep zzz', { output: '', exitCode: 1, status: 'failed' }),
        words: 'The command failed with exit code 1.'
      },
      {
        label: 'a Codex command failed with no exit code',
        step: codexStep('batshit_server_execute_command', 'echo hi', {
          output: '',
          status: 'failed',
          success: false,
          error: 'Codex reported this command as failed and gave no exit code.'
        }),
        words: 'Codex reported this command as failed and gave no exit code.'
      }
    ])('names $label', ({ step, words }) => {
      expect(toolStepFailureMessage(step.toolName, step.args, step.result)).toBe(words)
    })

    it.each([
      {
        label: 'a Codex search that matched nothing',
        step: codexStep('batshit_server_search_files', 'rg zzz src', { output: '', exitCode: 1, status: 'failed' })
      },
      {
        label: 'a Codex command that succeeded',
        step: codexStep('batshit_server_execute_command', 'node -v', { output: 'v24\n', exitCode: 0, status: 'completed' })
      },
      {
        label: 'a Codex read that succeeded',
        step: codexStep('batshit_server_read_file', 'cat notes.md', { content: 'hi\n', exitCode: 0, status: 'completed' })
      }
    ])('finds no failure in $label', ({ step }) => {
      expect(toolStepFailureMessage(step.toolName, step.args, step.result)).toBeUndefined()
    })

    it('says an API command ran out of time, and for how long', () => {
      const step = apiShellStep({ id: 'toolu_timeout', command: 'sleep 999', exitCode: 1 })
      const timedOut = { ...step.toolResult, exitCode: null, timedOut: true, durationMs: 120_034 }

      expect(toolStepFailureMessage(step.toolName, step.toolArgs, timedOut)).toBe('The command timed out after 120 s.')
      expect(toolFailureFallbackMessage({ timedOut: true, durationMs: 450 })).toBe('The command timed out after 450 ms.')
      expect(toolFailureFallbackMessage({ timedOut: true })).toBe('The command timed out.')
    })

    it('gives an API command that failed its exit code, and keeps a reason the result names', () => {
      const failed = apiShellStep({ id: 'toolu_failed', command: 'node build.js', stderr: 'boom\n', exitCode: 2 })
      const blocked = { success: false, blocked: true, reason: 'Blocked by Agent mode policy.', command: 'node build.js' }

      expect(toolStepFailureMessage(failed.toolName, failed.toolArgs, failed.toolResult)).toBe('The command failed with exit code 2.')
      expect(toolStepFailureMessage(failed.toolName, failed.toolArgs, blocked)).toBe('Blocked by Agent mode policy.')
      expect(toolStepFailureMessage('web_search', { query: 'x' }, { success: false })).toBe('Tool execution failed.')
    })

    it('keeps the exit-1 rule: an API search that matched nothing is no failure', () => {
      const step = apiShellStep({ id: 'toolu_nomatch', command: 'grep -rn zzz /tmp/batshit-example', exitCode: 1 })

      expect(toolStepFailureMessage(step.toolName, step.toolArgs, step.toolResult)).toBeUndefined()
    })

    it('reads `status` as a failure only on a delegated run, and an exit code only on a shell command', () => {
      expect(toolStepFailureMessage('subagent', {}, { kind: 'subagent', status: 'failed', success: true })).toBe(
        'Tool execution failed.'
      )
      expect(toolStepFailureMessage('mcp.ci.get_run', {}, { status: 'failed', exitCode: 1 })).toBeUndefined()
      expect(toolStepFailureMessage(undefined, {}, { exitCode: 2 })).toBeUndefined()
    })

    it('stores the same words on the step itself', () => {
      const timedOut = normalizeToolStep({
        ...apiShellStep({ id: 'toolu_stored_timeout', command: 'sleep 999', exitCode: 1 }),
        toolResult: {
          ...apiShellStep({ id: 'toolu_stored_timeout', command: 'sleep 999', exitCode: 1 }).toolResult,
          exitCode: null,
          timedOut: true,
          durationMs: 120_034
        }
      } as any)
      const failed = normalizeToolStep({ ...apiShellStep({ id: 'toolu_stored_failed', command: 'node build.js', stderr: 'boom\n', exitCode: 2 }) } as any)

      expect(timedOut.error).toBe('The command timed out after 120 s.')
      expect(failed.error).toBe('The command failed with exit code 2.')
    })
  })

  // F-P6-5 follow-up item 2: an empty read read nothing.
  it.each([
    {
      label: 'a Codex read of an empty file',
      toolArgs: { command: 'cat empty.txt', innerCommand: 'cat empty.txt', filePath: 'empty.txt' },
      toolResult: { content: '', exitCode: 0, status: 'completed', filePath: 'empty.txt' }
    },
    {
      label: 'an API read of an empty file',
      toolArgs: { command: 'cat empty.txt', innerCommand: 'cat empty.txt', filePath: 'empty.txt' },
      toolResult: { success: true, command: 'cat empty.txt', stdout: '', stderr: '', exitCode: 0, filePath: 'empty.txt' }
    },
    {
      label: 'a read tool that returned an empty file',
      toolArgs: { filePath: 'empty.txt' },
      toolResult: { content: '', filePath: 'empty.txt' }
    }
  ])('stores nothing as the content of $label, never the whole result', ({ toolArgs, toolResult }) => {
    const normalized = normalizeToolStep({
      type: 'tool',
      toolName: 'batshit_server_read_file',
      toolArgs,
      toolResult
    } as any)

    expect(normalized.toolResult.content).toBe('')
    expect(normalized.toolResult.content).not.toContain('{')
  })

  it('still falls back to the whole result for a read that carries no text at all', () => {
    const normalized = normalizeToolStep({
      type: 'tool',
      toolName: 'batshit_server_read_file',
      toolArgs: { filePath: 'notes.md' },
      toolResult: { lines: ['a', 'b'], encoding: 'utf8' }
    } as any)

    expect(normalized.toolResult.content).toContain('"encoding": "utf8"')
  })

  // F-P6-5 follow-up item 4: Codex reports a native patch's targets as a list of objects.
  it('keeps a Codex delete a command, not an edit whose diff is the JSON of its changes', () => {
    const normalized = normalizeToolStep({
      type: 'tool',
      toolName: 'batshit_server_execute_command',
      toolArgs: { filePath: 'old.md', path: 'old.md', command: 'rm old.md', changes: [{ path: 'old.md', kind: 'delete' }] },
      toolResult: { changes: [{ path: 'old.md', kind: 'delete' }], filePath: 'old.md', command: 'rm old.md', status: 'completed' }
    } as any)

    expect(normalized.toolName).toBe('execute_command')
    expect(normalized.toolResult.command).toBe('rm old.md')
    expect(JSON.stringify(normalized.toolResult)).not.toContain('"kind"')
  })

  it('still remaps a command whose result carries real diff text into an edit', () => {
    const normalized = normalizeToolStep({
      type: 'tool',
      toolName: 'batshit_server_execute_command',
      toolArgs: { command: 'git apply patch.diff', filePath: 'app.js' },
      toolResult: { changes: '--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-a\n+b', filePath: 'app.js' }
    } as any)

    expect(normalized.toolName).toBe('edit_file')
    expect(normalized.toolResult.diff).toContain('+++ b/app.js')
  })

  // Bug sweep item 8 (2026-09-18): the command-to-file remap lowercased the whole command before it
  // took the path out, so a denied `cat /Users/Example/Hello.md; exit 3` was stored as a read of
  // `/users/josh/hello.md`. It still matches the command name and the patch header in any case.
  describe('a command remapped to a file action keeps its path as written (item 8)', () => {
    it.each([
      ['cat /Users/Example/Hello.md; exit 3', '/Users/Example/Hello.md'],
      ['CAT /Users/Example/Hello.md; exit 3', '/Users/Example/Hello.md'],
      ['cd /Users/Example && sed -n 1,5p Notes/Plan.MD; exit 3', 'Notes/Plan.MD']
    ])('reads `%s` as a read of its own path', (command, filePath) => {
      const normalized = normalizeToolStep({
        type: 'tool',
        toolName: 'batshit_server_execute_command',
        toolArgs: { command },
        toolResult: { stdout: '# Hello', exitCode: 3 }
      } as any)

      expect(normalized.toolName).toBe('read_file')
      expect(normalized.toolResult.filePath).toBe(filePath)
      expect(normalized.toolArgs.filePath).toBe(filePath)
    })

    it.each(['*** Update File: /Users/Example/Notes.MD', '*** UPDATE FILE: /Users/Example/Notes.MD'])(
      'reads `%s` as an edit of its own path',
      (header) => {
        const normalized = normalizeToolStep({
          type: 'tool',
          toolName: 'execute_command',
          toolArgs: { command: `apply_patch <<'PATCH'\n*** Begin Patch\n${header}\n@@\n-a\n+b\n*** End Patch\nPATCH` },
          toolResult: { stdout: 'Done!', exitCode: 0 }
        } as any)

        expect(normalized.toolName).toBe('edit_file')
        expect(normalized.toolResult.filePath).toBe('/Users/Example/Notes.MD')
      }
    )
  })

  // F-P6-5 follow-up item 6: `ls` of several directories heads each one with `<dir>:`.
  it('parses a multi-directory listing into entries under their own directories', () => {
    const command = 'ls /tmp/x /tmp/y'
    const normalized = normalizeToolStep({
      type: 'tool',
      toolName: 'batshit_server_list_files',
      toolArgs: { command, innerCommand: command },
      toolResult: { stdout: '/tmp/x:\na.md\nsub\n\n/tmp/y:\nb.md\n', exitCode: 0 }
    } as any)

    expect(normalized.toolResult.files).toEqual([
      { name: 'a.md', type: 'unknown', path: '/tmp/x/a.md' },
      { name: 'sub', type: 'unknown', path: '/tmp/x/sub' },
      { name: 'b.md', type: 'unknown', path: '/tmp/y/b.md' }
    ])
  })

  it('leaves a single-directory listing bare, even when a file is named like a header', () => {
    const normalized = normalizeToolStep({
      type: 'tool',
      toolName: 'batshit_server_list_files',
      toolArgs: { command: 'ls /tmp/x', innerCommand: 'ls /tmp/x' },
      toolResult: { stdout: 'weird:\nnotes.md\n', exitCode: 0 }
    } as any)

    expect(normalized.toolResult.files).toEqual([
      { name: 'weird:', type: 'unknown' },
      { name: 'notes.md', type: 'unknown' }
    ])
  })

  it("never reads a read tool's own status or code as an exit code", () => {
    const normalized = normalizeToolStep({
      type: 'tool',
      toolName: 'read_file',
      toolArgs: { path: 'notes.md' },
      toolResult: { content: 'hello', status: 404, code: 2 }
    } as any)

    expect(normalized.toolResult).not.toHaveProperty('exitCode')
  })

  it('preserves nested tool steps on normalized subagent results', () => {
    const nestedSteps = [
      {
        action: {
          tool: 'Batshit Subagent Tools',
          toolInput: { action: 'bash_execute', input: { command: 'pwd' } }
        },
        observation: { data: { stdout: '/workspace' } }
      }
    ]

    const normalized = normalizeToolStep({
      type: 'tool',
      toolName: 'call_subagent',
      toolArgs: {
        message: 'Check the workspace.'
      },
      toolResult: {
        output: 'The workspace is ready.',
        intermediateSteps: nestedSteps
      }
    } as any)

    expect(normalized.toolName).toBe('subagent')
    expect((normalized.toolResult as any).output).toBe('The workspace is ready.')
    expect((normalized.toolResult as any).intermediateSteps).toEqual(nestedSteps)
  })

  it('keeps n8n Subnode Subagent nested tools on the renderable segment', () => {
    const nestedSteps = [
      {
        action: {
          tool: 'Batshit Subagent Tools',
          toolInput: { action: 'bash_execute', input: { command: 'pwd' } }
        },
        observation: { data: { stdout: '/workspace' } }
      }
    ]

    const segments = processIntermediateSteps([
      {
        type: 'tool',
        toolName: 'n8n Subnode Subagent',
        toolArgs: {
          Prompt__User_Message_: 'Check the workspace.'
        },
        toolResult: {
          output: 'The workspace is ready.',
          intermediateSteps: nestedSteps
        }
      } as any
    ])

    expect(segments).toHaveLength(1)
    expect((segments[0] as any).toolName).toBe('call_subagent')
    expect((segments[0] as any).toolResult.input).toBe('Check the workspace.')
    expect((segments[0] as any).toolResult.intermediateSteps).toEqual(nestedSteps)
    expect((segments[0] as any).intermediateStep.toolResult.intermediateSteps).toEqual(nestedSteps)
  })
})
