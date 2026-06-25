import { describe, expect, it } from 'vitest'
import { normalizeToolStep, processIntermediateSteps } from '../toolResultProcessor'

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
    expect((normalized.toolResult as any).exitCode).toBe(1)
    expect((normalized.toolResult as any).stderr).toContain('Awaiting approval before execution.')
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
