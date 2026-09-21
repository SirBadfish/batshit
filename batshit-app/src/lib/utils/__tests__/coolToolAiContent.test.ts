import { describe, expect, it } from 'vitest'
import { buildCoolToolAiContent } from '../coolToolAiContent'

function aiView(payload: Record<string, any>) {
  return buildCoolToolAiContent('zip_bash', { content: JSON.stringify(payload) }, payload)
}

const sandboxReason =
  '[0/6] [0s]\n[6/6] Starting container [0s]\nError: failed to create container (cause: "exists: "container already exists: batshit-apple-sandbox-josh-s52af26b6-5d17df6157"")'

describe('buildCoolToolAiContent for bash results', () => {
  it('renders a command that ran exactly as before', () => {
    expect(
      aiView({
        toolName: 'bash',
        operationKind: 'bash',
        toolArgs: { command: 'ls src' },
        toolResult: { command: 'ls src', stdout: 'a.ts\nb.ts', stderr: '', exitCode: 0 }
      })
    ).toBe(
      'Tool result: bash\nCommand: ls src\nExit code: 0\nStdout:\n```text\na.ts\nb.ts\n```'
    )
  })

  it('does not add the generic step error to a command that exited non-zero', () => {
    const view = aiView({
      toolName: 'bash',
      operationKind: 'bash',
      toolArgs: { command: 'npm test' },
      toolResult: { command: 'npm test', stdout: '', stderr: '2 failing', exitCode: 1 },
      error: 'Tool execution failed.'
    })

    expect(view).toBe(
      'Tool result: bash\nCommand: npm test\nExit code: 1\nStdout:\n```text\n\n```\nStderr:\n```text\n2 failing\n```'
    )
  })

  it('names the error code of a command that never started, without repeating its reason', () => {
    const view = aiView({
      toolName: 'bash',
      operationKind: 'bash',
      toolArgs: { command: 'git log --oneline -5' },
      toolResult: {
        command: 'git log --oneline -5',
        stdout: '',
        stderr: sandboxReason,
        errorCode: 'SANDBOX_UNAVAILABLE'
      },
      error: sandboxReason
    })

    expect(view).toContain('Error code: SANDBOX_UNAVAILABLE')
    expect(view).not.toContain('Exit code')
    expect(view.split('container already exists')).toHaveLength(2)
  })

  // The zip stored during the 2026-09-17 SA-120 P5 live proof, before the F-P5-1 fix.
  it('shows the reason stored beside the invented exit code 0 of an older zip', () => {
    const view = aiView({
      schemaVersion: 1,
      type: 'tool',
      toolName: 'bash',
      displayToolName: 'native_bash_execute',
      originalToolName: 'native_bash_execute',
      operationKind: 'bash',
      rendererFamily: 'bash',
      toolArgs: { command: 'git log --oneline -5', innerCommand: 'git log --oneline -5' },
      toolResult: {
        command: 'git log --oneline -5',
        innerCommand: 'git log --oneline -5',
        stdout: '',
        stderr: '',
        exitCode: 0,
        interrupted: false,
        isImage: false,
        stdoutTruncated: false,
        stderrTruncated: false
      },
      observation: '[Circular]',
      error: sandboxReason
    })

    expect(view).toContain(`Error:\n\`\`\`text\n${sandboxReason}\n\`\`\``)
  })
})

// F-P6-5 follow-up: a failed write or edit wrote nothing, so its transcript names the failure
// instead of "Written content" or "Diff"; a read keeps its content, which is what it printed.
describe('buildCoolToolAiContent for shell commands stored as file actions', () => {
  const claudeError = 'Error: Exit code 1\nzsh: no such file or directory: /nope/dir/out.txt'

  it('names the failure of a write that a lane reported only as text', () => {
    const view = aiView({
      toolName: 'write_file',
      operationKind: 'write_file',
      rendererFamily: 'write_file',
      toolArgs: { filePath: '/nope/dir/out.txt' },
      toolResult: { filePath: '/nope/dir/out.txt', content: 'hi', lineCount: 1 },
      error: claudeError
    })

    expect(view).toBe(`Tool result: write_file\nPath: /nope/dir/out.txt\nError:\n\`\`\`text\n${claudeError}\n\`\`\``)
    expect(view).not.toContain('Written content')
  })

  it('renders a write that succeeded exactly as before', () => {
    expect(
      aiView({
        toolName: 'write_file',
        operationKind: 'write_file',
        rendererFamily: 'write_file',
        toolArgs: { filePath: 'out.txt' },
        toolResult: { filePath: 'out.txt', content: 'hi', lineCount: 1, size: 2, language: 'plaintext' }
      })
    ).toBe('Tool result: write_file\nPath: out.txt\nLines: 1\nChars/bytes: 2\nWritten content:\n```plaintext\nhi\n```')
  })

  it('adds the error to a read only when the read printed nothing and has no exit code', () => {
    const declined = aiView({
      toolName: 'read_file',
      operationKind: 'read_file',
      toolResult: { filePath: 'a.txt', content: '' },
      error: 'Codex reported this command as failed and gave no exit code.'
    })
    expect(declined).toContain('Error:\n```text\nCodex reported this command as failed and gave no exit code.\n```')

    const claudeRead = aiView({
      toolName: 'read_file',
      operationKind: 'read_file',
      toolResult: { filePath: 'a.txt', content: 'Exit code 1\ncat: a.txt: No such file or directory' },
      error: 'Error: Exit code 1\ncat: a.txt: No such file or directory'
    })
    expect(claudeRead).not.toContain('Error:\n')
  })

  it('adds the exit code and what a failed listing printed after its entries', () => {
    expect(
      aiView({
        toolName: 'list_files',
        operationKind: 'list_files',
        toolArgs: { path: '/nope' },
        toolResult: { files: [], totalItems: 0, exitCode: 1, commandOutput: 'ls: /nope: No such file or directory' },
        error: 'Tool execution failed.'
      })
    ).toBe(
      'Tool result: list_files\nPath: /nope\nExit code: 1\nItems: 0\nFiles:\n(none)\n' +
        'Output:\n```text\nls: /nope: No such file or directory\n```'
    )
  })
})
