import { describe, expect, it } from 'vitest'
import { buildCoolToolAiContent, buildCoolToolAiContentWithSources } from '../coolToolAiContent'

function aiView(payload: Record<string, any>) {
  return buildCoolToolAiContent('zip_bash', { content: JSON.stringify(payload) }, payload)
}

describe('Cool Tool model text provenance', () => {
  it('keeps echoed commands and proposed writes as agent words while actual output stays tool result', () => {
    const commandUrl = 'https://command.example/not-read.png'
    const outputUrl = 'https://output.example/read.png'
    const payload = {
      toolName: 'bash', operationKind: 'bash',
      toolArgs: { command: `echo ${commandUrl}` },
      toolResult: { command: `echo ${commandUrl}`, stdout: outputUrl, stderr: '', exitCode: 0 }
    }

    const formatted = buildCoolToolAiContentWithSources('zip_bash', { content: JSON.stringify(payload) }, payload)

    expect(formatted.text).toBe(buildCoolToolAiContent('zip_bash', { content: JSON.stringify(payload) }, payload))
    expect(formatted.parts.map((part) => part.text).join('')).toBe(formatted.text)
    expect(formatted.parts.filter((part) => part.source === 'tool_result').map((part) => part.text).join('')).toContain(outputUrl)
    expect(formatted.parts.filter((part) => part.source === 'tool_result').map((part) => part.text).join('')).not.toContain(commandUrl)
    expect(formatted.parts.filter((part) => part.source === 'agent_words').map((part) => part.text).join('')).toContain(commandUrl)
  })

  it('does not call model-proposed write content a tool result', () => {
    const proposedUrl = 'https://proposed.example/not-read.png'
    const payload = {
      toolName: 'write_file', operationKind: 'write_file',
      toolArgs: { path: '/tmp/proposed.txt' },
      toolResult: { path: '/tmp/proposed.txt', content: `const url = '${proposedUrl}'` }
    }

    const formatted = buildCoolToolAiContentWithSources('zip_write', { content: JSON.stringify(payload) }, payload)

    expect(formatted.text).toContain(proposedUrl)
    expect(formatted.parts.map((part) => part.text).join('')).toBe(formatted.text)
    expect(formatted.parts.filter((part) => part.source === 'tool_result').map((part) => part.text).join('')).not.toContain(proposedUrl)
    expect(formatted.parts.filter((part) => part.source === 'agent_words').map((part) => part.text).join('')).toContain(proposedUrl)
  })

  it.each([
    {
      lane: 'read_file', operationKind: 'read_file', toolName: 'read_file',
      toolArgs: { path: 'https://path.example/agent.png' },
      toolResult: { filePath: 'https://path.example/agent.png', content: 'https://body.example/result.png' },
      agentOnly: 'https://path.example/agent.png', resultOnly: 'https://body.example/result.png'
    },
    {
      lane: 'skill_read', operationKind: 'skill_read', toolName: 'native_skill',
      toolArgs: { path: 'https://skill-path.example/agent.png' },
      toolResult: { skillMarkdown: 'https://skill-body.example/result.png' },
      agentOnly: 'https://skill-path.example/agent.png', resultOnly: 'https://skill-body.example/result.png'
    },
    {
      lane: 'edit_file', operationKind: 'edit_file', toolName: 'edit_file',
      toolArgs: { path: 'https://edit-path.example/agent.png' },
      toolResult: { diff: '+ https://diff.example/proposed.png' },
      agentOnly: 'https://diff.example/proposed.png', agentAlso: 'https://edit-path.example/agent.png', resultOnly: ''
    },
    {
      lane: 'list_files', operationKind: 'list_files', toolName: 'list_files',
      toolArgs: { path: 'https://list-path.example/agent.png' },
      toolResult: { path: 'https://list-path.example/agent.png', files: ['https://entry.example/result.png'], totalItems: 1 },
      agentOnly: 'https://list-path.example/agent.png', resultOnly: 'https://entry.example/result.png'
    },
    {
      lane: 'search_files (cut)', operationKind: 'search_files', toolName: 'search_files',
      toolArgs: { query: 'https://query.example/agent.png' },
      toolResult: { matches: ['https://match.example/result.png'], totalMatches: 2, outputCut: { by: 'test lane', keptBytes: 20, totalBytes: 40 } },
      agentOnly: 'https://query.example/agent.png', resultOnly: 'https://match.example/result.png'
    },
    {
      lane: 'fetch_zip', operationKind: 'fetch_zip', toolName: 'fetch_zip',
      toolArgs: { zipId: 'https://zip-id.example/agent.png' },
      toolResult: { content: 'https://fetched.example/result.png', found: true },
      agentOnly: 'https://zip-id.example/agent.png', resultOnly: 'https://fetched.example/result.png'
    },
    {
      lane: 'generic', operationKind: 'custom_tool', toolName: 'custom_tool',
      toolArgs: { url: 'https://argument.example/agent.png' },
      toolResult: 'https://generic-result.example/result.png',
      agentOnly: 'https://argument.example/agent.png', resultOnly: 'https://generic-result.example/result.png'
    }
  ])('uses structural output boundaries for $lane', ({ operationKind, toolName, toolArgs, toolResult, agentOnly, agentAlso, resultOnly }) => {
    const payload = { toolName, operationKind, toolArgs, toolResult }
    const formatted = buildCoolToolAiContentWithSources('zip_branch', { content: JSON.stringify(payload) }, payload)
    const agentText = formatted.parts.filter((part) => part.source === 'agent_words').map((part) => part.text).join('')
    const resultText = formatted.parts.filter((part) => part.source === 'tool_result').map((part) => part.text).join('')

    expect(formatted.parts.map((part) => part.text).join('')).toBe(formatted.text)
    expect(agentText).toContain(agentOnly)
    if (agentAlso) expect(agentText).toContain(agentAlso)
    if (resultOnly) expect(resultText).toContain(resultOnly)
    expect(resultText).not.toContain(agentOnly)
  })
})

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

/**
 * Find 1 (bug batch 2026-09-22): a skill reference an agent keeps unzipped comes back on later
 * turns through this view. A partial read keeps its "what it showed, how to read on" line there
 * too; every other read renders exactly as before.
 */
describe('buildCoolToolAiContent for a partial skill read (find 1)', () => {
  const readMore =
    'Showing characters 1 to 12,000 of 38,635. To read on, call native_skill again with skillId "artifact_creator", action "read", path "references/big.md", and offset 12000.'

  function skillRead(extra: Record<string, any>) {
    return {
      toolName: 'native_skill',
      operationKind: 'skill_read',
      toolArgs: { skillId: 'artifact_creator', action: 'read', path: 'references/big.md' },
      toolResult: {
        action: 'read',
        skillId: 'artifact_creator',
        skillName: 'Artifact Creator',
        path: 'references/big.md',
        content: 'part one',
        ...extra
      }
    }
  }

  it('keeps the next call after the content', () => {
    const view = aiView(skillRead({ contentTruncated: true, originalChars: 38635, returnedChars: 12000, offset: 0, nextOffset: 12000, readMore }))
    expect(view.endsWith(`\n\`\`\`\n${readMore}`)).toBe(true)
  })

  it('renders a whole read exactly as before', () => {
    expect(aiView(skillRead({ contentTruncated: false, originalChars: 8, returnedChars: 8 }))).toBe(
      'Tool result: native_skill\nPath: references/big.md\nSkill: Artifact Creator\nContent:\n```text\npart one\n```'
    )
  })
})
