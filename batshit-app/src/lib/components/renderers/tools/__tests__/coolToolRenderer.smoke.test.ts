import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import CoolToolRenderer from '../CoolToolRenderer.svelte'
import { buildHydratedCoolToolStep } from '$lib/components/chat/coolToolHydration'

// F-P6-5: a managed Codex `cat`, as the cool_tool zip stores it, before chat hydration.
function storedShellReadPayload(filePath: string, toolResult: Record<string, any>) {
  return {
    schemaVersion: 1,
    type: 'tool',
    toolName: 'read_file',
    displayToolName: 'batshit_server_read_file',
    originalToolName: 'batshit_server_read_file',
    operationKind: 'read_file',
    rendererFamily: 'read_file',
    toolCallId: 'call_shell_read',
    toolArgs: { filePath, path: filePath, innerCommand: `cat ${filePath}` },
    toolResult: { filePath, path: filePath, ...toolResult },
    observation: '[Circular]',
    timestamp: '2026-09-17T08:37:29.415Z',
    toolProvider: 'batshit-server',
    toolSource: 'mode3-workflow',
    rawSidecar: { status: 'not_retained', reason: 'compact-main-payload' },
    storage: { compacted: false, truncated: false, binaryLikeOmitted: false, forceCompress: false },
    metadata: {
      sessionId: 'session-shell-read',
      operationKind: 'read_file',
      rendererFamily: 'read_file',
      forceCompress: false,
      compacted: false,
      truncated: false,
      binaryLikeOmitted: false
    }
  }
}

// The same stored shape for the other file actions a shell command becomes (F-P6-5 follow-up).
function storedShellActionPayload(options: {
  lane: 'write_file' | 'edit_file' | 'list_files'
  toolName: string
  toolArgs: Record<string, any>
  toolResult: Record<string, any>
  error?: string
}) {
  return {
    schemaVersion: 1,
    type: 'tool',
    toolName: options.lane,
    displayToolName: options.toolName,
    originalToolName: options.toolName,
    operationKind: options.lane,
    rendererFamily: options.lane,
    toolCallId: `call_shell_${options.lane}`,
    toolArgs: options.toolArgs,
    toolResult: options.toolResult,
    observation: '[Circular]',
    ...(options.error ? { error: options.error } : {}),
    timestamp: '2026-09-17T08:37:29.415Z',
    toolProvider: 'batshit-server',
    toolSource: 'mode3-workflow',
    rawSidecar: { status: 'not_retained', reason: 'compact-main-payload' },
    storage: { compacted: false, truncated: false, binaryLikeOmitted: false, forceCompress: false },
    metadata: {
      sessionId: 'session-shell-read',
      operationKind: options.lane,
      rendererFamily: options.lane,
      forceCompress: false,
      compacted: false,
      truncated: false,
      binaryLikeOmitted: false
    }
  }
}

const hydratedZip = {
  toolName: 'batshit_server_read_file',
  toolArgs: { path: '/tmp/example.txt' },
  toolResult: { content: 'hello world' },
  metadata: {
    toolProvider: 'batshit-server',
    gatewayName: 'Docker Gateway'
  },
  success: true
}

const nativeDynamicMcpFindZip = {
  toolName: 'native_dynamic_mcp_find',
  toolArgs: { query: 'redis' },
  toolResult: {
    query: 'redis',
    totalMatches: 1,
    results: [
      {
        toolName: 'Redis_get',
        description: 'Get value from Redis'
      }
    ]
  },
  metadata: {
    toolProvider: 'batshit-server',
    gatewayName: 'Docker Gateway'
  },
  success: true
}

const mappedNativeBashSearchZip = {
  toolName: 'batshit_server_search_files',
  toolArgs: {
    command: 'rg "Dynamic MCP" docs',
    innerCommand: 'rg "Dynamic MCP" docs',
    originalToolName: 'native_bash_execute'
  },
  toolResult: {
    success: true,
    stdout:
      'docs/batshit_System_Prompts/batshit_dynamic_mcp.md:1:Dynamic MCP lets you discover and use tools beyond your enabled set',
    stderr: '',
    mappedToolName: 'batshit_server_search_files',
    originalToolName: 'native_bash_execute'
  },
  metadata: {
    toolProvider: 'batshit-server'
  },
  success: true
}

const mappedNativeBashReadZip = {
  toolName: 'batshit_server_read_file',
  toolArgs: {
    command: 'cat docs/user-docs/architecture/local-first-boundaries.md',
    innerCommand: 'cat docs/user-docs/architecture/local-first-boundaries.md',
    filePath: 'docs/user-docs/architecture/local-first-boundaries.md',
    path: 'docs/user-docs/architecture/local-first-boundaries.md',
    originalToolName: 'native_bash_execute'
  },
  toolResult: {
    success: true,
    stdout: '# Batshit Overview\n\nThis is a test payload.',
    mappedToolName: 'batshit_server_read_file',
    originalToolName: 'native_bash_execute'
  },
  metadata: {
    toolProvider: 'batshit-server'
  },
  success: true
}

const mappedNativeBashListZip = {
  toolName: 'batshit_server_list_files',
  toolArgs: {
    command: 'ls -la testing-native-bash',
    originalToolName: 'native_bash_execute'
  },
  toolResult: {
    success: true,
    stdout:
      'total 8\n-rw-r--r-- 1 user staff 10 Feb 08 12:00 Luci.md\ndrwxr-xr-x 3 user staff 96 Feb 08 12:00 docs',
    mappedToolName: 'batshit_server_list_files',
    originalToolName: 'native_bash_execute'
  },
  metadata: {
    toolProvider: 'batshit-server'
  },
  success: true
}

const nativeFabricStructuredErrorZip = {
  toolName: 'native_fabric_use',
  toolArgs: {
    controlId: 'artifact.artifact_123.field.zone.set',
    dryRun: false,
    allowRisky: true
  },
  toolResult: {
    success: false,
    controlId: 'artifact.artifact_123.field.zone.set',
    error: {
      code: 'CONTROL_EXECUTION_FAILED',
      message: 'Zone is required. Provide one of: header, panel, trigger.'
    }
  },
  metadata: {
    toolProvider: 'batshit-server'
  },
  success: false
}

const staleSubagentArtifactUseZip = {
  toolName: 'native_batshit_tool_use',
  toolArgs: {
    ref: 'artifact:use.artifact.gpt_image_2_generator',
    input: {
      prompt: 'A tiny friendly robot painting a glowing purple Batshit logo'
    }
  },
  toolResult: {
    success: false,
    ref: 'artifact:use.artifact.gpt_image_2_generator',
    family: 'artifact',
    target: 'use.artifact.gpt_image_2_generator',
    operationKind: 'artifact-use',
    error: {
      code: 'CONTROL_EXECUTION_FAILED',
      message: 'Image generation failed: Unknown parameter: response_format.'
    }
  },
  toolProvider: 'subagent',
  metadata: {
    toolProvider: 'subagent'
  },
  success: false
}

const brokeredFetchZip = {
  toolName: 'native_batshit_tool_use',
  displayToolName: 'Fetch Zip',
  operationKind: 'fetch_zip',
  rendererFamily: 'fetch_zip',
  toolArgs: {
    ref: 'fabric:sys.zip.fetch',
    input: {
      zipId: 'cool_tool_1234_abcd',
      includeContent: false
    }
  },
  toolResult: {
    success: true,
    ref: 'fabric:sys.zip.fetch',
    family: 'fabric',
    target: 'sys.zip.fetch',
    operationKind: 'fetch_zip',
    rendererFamily: 'fetch_zip',
    result: {
      zipId: 'cool_tool_1234_abcd',
      type: 'cool_tool',
      description: 'Fetched zip metadata'
    }
  },
  metadata: {
    toolProvider: 'batshit-server',
    rendererTitle: 'Fetch Zip'
  },
  success: true
}

const normalizedBashZip = {
  toolName: 'batshit_server_execute_command',
  operationKind: 'bash',
  rendererFamily: 'bash',
  toolArgs: {
    command: 'pwd',
    cwd: '/Users/example/batshit'
  },
  toolResult: {
    command: 'pwd',
    stdout: '/Users/example/batshit',
    stderr: '',
    exitCode: 0
  },
  metadata: {
    toolProvider: 'batshit-server'
  },
  success: true
}

const normalizedSkillReadZip = {
  toolName: 'native_skill',
  operationKind: 'skill_read',
  rendererFamily: 'skill_read',
  toolArgs: {
    action: 'read',
    skillId: 'agent-browser',
    path: '/Users/example/batshit/.agents/skills/agent-browser/SKILL.md'
  },
  toolResult: {
    action: 'read',
    skillId: 'agent-browser',
    skillName: 'Agent Browser',
    path: '/Users/example/batshit/.agents/skills/agent-browser/SKILL.md',
    content: '# Agent Browser\n\nUse the browser.'
  },
  metadata: {
    toolProvider: 'batshit-server'
  },
  success: true
}

const normalizedSkillInvokeZip = {
  toolName: 'native_skill',
  operationKind: 'skill_read',
  rendererFamily: 'skill_read',
  toolArgs: {
    action: 'invoke',
    skillId: 'agent-browser',
    path: 'SKILL.md'
  },
  toolResult: {
    action: 'invoke',
    skillId: 'agent-browser',
    skillName: 'Agent Browser',
    path: 'SKILL.md',
    content: '# Agent Browser\n\nUse the browser.'
  },
  metadata: {
    toolProvider: 'batshit-server'
  },
  success: true
}

const normalizedWriteFileZip = {
  toolName: 'batshit_server_overwrite_file',
  operationKind: 'write_file',
  rendererFamily: 'write_file',
  toolArgs: {
    path: '/Users/example/hello/sa049-smoke-write.txt',
    content: 'alpha\nbeta\ngamma'
  },
  toolResult: {
    filePath: '/Users/example/hello/sa049-smoke-write.txt',
    content: 'alpha\nbeta\ngamma'
  },
  metadata: {
    toolProvider: 'batshit-server'
  },
  success: true
}

const normalizedCommandOnlyWriteFileZip = {
  toolName: 'Batshit_Native_Tools',
  operationKind: 'write_file',
  rendererFamily: 'write_file',
  toolArgs: {
    filePath: '/Users/example/hello/sa049-mode1-write.txt',
    path: '/Users/example/hello/sa049-mode1-write.txt',
    command:
      'mkdir -p /Users/example/hello && printf "alpha\\nbeta\\ngamma\\n" > /Users/example/hello/sa049-mode1-write.txt',
    innerCommand:
      'mkdir -p /Users/example/hello && printf "alpha\\nbeta\\ngamma\\n" > /Users/example/hello/sa049-mode1-write.txt'
  },
  toolResult: {
    filePath: '/Users/example/hello/sa049-mode1-write.txt',
    path: '/Users/example/hello/sa049-mode1-write.txt',
    content: '',
    lineCount: 3,
    size: 17
  },
  metadata: {
    toolProvider: 'batshit-server'
  },
  success: true
}

const normalizedSummaryOnlyEditFileZip = {
  toolName: 'Batshit_Native_Tools',
  operationKind: 'edit_file',
  rendererFamily: 'edit_file',
  toolArgs: {
    filePath: '/Users/example/hello/sa049-mode1-write-unblocked.txt',
    path: '/Users/example/hello/sa049-mode1-write-unblocked.txt'
  },
  toolResult: {
    filePath: '/Users/example/hello/sa049-mode1-write-unblocked.txt',
    path: '/Users/example/hello/sa049-mode1-write-unblocked.txt',
    diff: 'Updated /Users/example/hello/sa049-mode1-write-unblocked.txt. Diff unavailable because Batshit could not reconstruct the before/after change.',
    diffTruncated: false,
    diffOmitted: false
  },
  metadata: {
    toolProvider: 'batshit-server'
  },
  success: true
}

const normalizedDiffEditFileZip = {
  toolName: 'Batshit_Native_Tools',
  operationKind: 'edit_file',
  rendererFamily: 'edit_file',
  toolArgs: {
    filePath: '/Users/example/hello/sa049-mode1-write-unblocked.txt',
    path: '/Users/example/hello/sa049-mode1-write-unblocked.txt'
  },
  toolResult: {
    filePath: '/Users/example/hello/sa049-mode1-write-unblocked.txt',
    path: '/Users/example/hello/sa049-mode1-write-unblocked.txt',
    diff: '--- Before\n+++ After\n  1 | alpha\n-  2 | beta\n+  2 | bravo\n  3 | gamma'
  },
  metadata: {
    toolProvider: 'batshit-server'
  },
  success: true
}

// What the API lane stores for `sed -i` now that the edit target's before/after copies reach the
// diff, from the real path (`apiShellStep` → `adaptCoolToolsToZipSystem`), trimmed to the fields the
// card reads.
const apiSnapshotEditFileZip = (diff: string, command: string) => ({
  toolName: 'edit_file',
  displayToolName: 'batshit_server_edit_file',
  originalToolName: 'native_bash_execute',
  operationKind: 'edit_file',
  rendererFamily: 'edit_file',
  toolArgs: {
    filePath: '/tmp/batshit-example/notes.md',
    path: '/tmp/batshit-example/notes.md',
    command,
    innerCommand: command
  },
  toolResult: {
    filePath: '/tmp/batshit-example/notes.md',
    path: '/tmp/batshit-example/notes.md',
    diff,
    diffTruncated: false,
    diffOmitted: false,
    language: 'markdown'
  },
  toolProvider: 'batshit-server',
  toolSource: 'native-tool',
  success: true
})

const rawMode1NativeSkillInvokeZip = {
  toolName: 'Batshit_Native_Tools',
  toolArgs: {
    action: 'native_skill'
  },
  toolResult: [
    {
      success: true,
      action: 'native_skill',
      data: {
        success: true,
        action: 'invoke',
        skill: {
          id: 'agent_browser',
          name: 'Agent Browser'
        },
        skillMarkdown: '# Agent Browser\n\nUse the browser.'
      }
    }
  ],
  metadata: {
    toolProvider: 'batshit-server'
  },
  success: true
}

const normalizedWebSearchZip = {
  toolName: 'native_web_search',
  operationKind: 'web_search',
  rendererFamily: 'web_search',
  toolArgs: {
    query: 'batshit app'
  },
  toolResult: {
    query: 'batshit app',
    provider: 'exa',
    totalMatches: 1,
    results: [
      {
        title: 'Batshit',
        url: 'https://batshit.ai',
        snippet: 'Batshit is an AI workspace.'
      }
    ]
  },
  metadata: {
    toolProvider: 'batshit-server'
  },
  success: true
}

const normalizedSearchFilesFallbackZip = {
  toolName: 'batshit_server_search_files',
  operationKind: 'search_files',
  rendererFamily: 'bash',
  toolArgs: {
    command: 'rg "zipActivation" batshit-app/src/lib',
    innerCommand: 'rg "zipActivation" batshit-app/src/lib'
  },
  toolResult: {
    query: 'zipActivation',
    totalMatches: 2,
    totalMatchingFiles: 2,
    results: [
      {
        path: 'batshit-app/src/lib/utils/zipActivation.ts',
        matchCount: 1,
        matches: [{ lineNumber: 84, text: 'const resolvedToolName = ...' }]
      },
      {
        path: 'batshit-app/src/lib/services/messageCompiler.ts',
        matchCount: 1,
        matches: [{ lineNumber: 17, text: 'import { zipActivation } from "./zipActivation"' }]
      }
    ]
  },
  metadata: {
    toolProvider: 'batshit-server'
  },
  success: true
}

const normalizedSearchFilesFilesOnlyZip = {
  toolName: 'batshit_server_search_files',
  operationKind: 'search_files',
  rendererFamily: 'bash',
  toolArgs: {
    command: 'rg -n -l "zipActivation" /Users/example/batshit',
    innerCommand: 'rg -n -l "zipActivation" /Users/example/batshit'
  },
  toolResult: {
    query: 'zipActivation',
    totalMatches: 3,
    totalMatchingFiles: 3,
    results: [
      {
        path: '/Users/example/batshit/batshit-app/src/lib/services/messageCompiler.ts',
        matchCount: 1,
        matches: []
      },
      {
        path: '/Users/example/batshit/docs/user-docs/tools/zips.md',
        matchCount: 1,
        matches: []
      },
      {
        path: '/Users/example/batshit/batshit-app/src/lib/utils/zipActivation.test.ts',
        matchCount: 1,
        matches: []
      }
    ]
  },
  metadata: {
    toolProvider: 'batshit-server'
  },
  success: true
}

const normalizedSearchFilesGrepCombinedFlagsZip = {
  toolName: 'batshit_server_search_files',
  operationKind: 'search_files',
  rendererFamily: 'bash',
  toolArgs: {
    command: 'grep -rl "\\bworkspace\\b" /Users/example/hello',
    innerCommand: 'grep -rl "\\bworkspace\\b" /Users/example/hello'
  },
  toolResult: {
    query: '\\bworkspace\\b',
    totalMatches: 1,
    totalMatchingFiles: 1,
    results: [
      {
        path: '/Users/example/hello/hello.md',
        matchCount: 1,
        matches: []
      }
    ]
  },
  metadata: {
    toolProvider: 'batshit-server'
  },
  success: true
}

const normalizedListFilesFromRgZip = {
  toolName: 'batshit_server_list_files',
  operationKind: 'list_files',
  rendererFamily: 'bash',
  toolArgs: {
    command: 'rg --files /Users/example/batshit/batshit-app/src/lib/components/chat',
    innerCommand: 'rg --files /Users/example/batshit/batshit-app/src/lib/components/chat',
    path: '/Users/example/batshit/batshit-app/src/lib/components/chat',
    dirPath: '/Users/example/batshit/batshit-app/src/lib/components/chat'
  },
  toolResult: {
    totalFiles: 3,
    totalDirectories: 0,
    totalItems: 3,
    files: [
      {
        path: '/Users/example/batshit/batshit-app/src/lib/components/chat/ChatArea.svelte',
        name: 'ChatArea.svelte',
        type: 'file'
      },
      {
        path: '/Users/example/batshit/batshit-app/src/lib/components/chat/ToolActivityGroup.svelte',
        name: 'ToolActivityGroup.svelte',
        type: 'file'
      },
      {
        path: '/Users/example/batshit/batshit-app/src/lib/components/chat/ToolActivitySegment.svelte',
        name: 'ToolActivitySegment.svelte',
        type: 'file'
      }
    ]
  },
  metadata: {
    toolProvider: 'batshit-server'
  },
  success: true
}

const normalizedListFilesFromBareLsZip = {
  toolName: 'batshit_server_list_files',
  operationKind: 'list_files',
  rendererFamily: 'bash',
  toolArgs: {
    command: 'ls /Users/example/hello',
    innerCommand: 'ls /Users/example/hello',
    path: '/Users/example/hello',
    dirPath: '/Users/example/hello',
    filePath: '/Users/example/hello'
  },
  toolResult: {
    totalFiles: 0,
    totalDirectories: 0,
    totalUnknownItems: 2,
    totalItems: 2,
    files: [
      {
        path: 'artifacts',
        name: 'artifacts',
        type: 'unknown'
      },
      {
        path: 'hello.md',
        name: 'hello.md',
        type: 'unknown'
      }
    ]
  },
  metadata: {
    toolProvider: 'batshit-server'
  },
  success: true
}

const subagentPreviewResultZip = {
  toolName: 'call_subagent',
  toolArgs: {
    Prompt__User_Message_: 'Please read /workspace/README.md for me',
    subagentName: 'API Subagent',
    agentName: 'API Primary'
  },
  toolResult: {
    input: 'Please read /workspace/README.md for me',
    output: {
      preview: 'Of course, Gina. I read README.md successfully.'
    },
    subagentName: 'API Subagent',
    agentName: 'API Primary'
  },
  metadata: {
    toolProvider: 'subagent',
    subagentName: 'API Subagent',
    agentName: 'API Primary'
  },
  isSubagent: true,
  success: true
}

const subagentIconAvatarZip = {
  toolName: 'call_subagent',
  toolArgs: {
    Prompt__User_Message_: 'Run a tiny delegation test',
    subagentName: 'Icon Subagent',
    agentName: 'Icon Primary'
  },
  toolResult: {
    input: 'Run a tiny delegation test',
    output: 'Icon delegation complete.',
    subagentName: 'Icon Subagent',
    agentName: 'Icon Primary'
  },
  metadata: {
    toolProvider: 'subagent',
    subagentName: 'Icon Subagent',
    subagentAvatarIconRef: { kind: 'batshit', id: 'subagents' },
    subagentAvatarIconFit: 'fill',
    agentName: 'Icon Primary',
    agentAvatarIconRef: { kind: 'batshit', id: 'agents' },
    agentAvatarIconFit: 'fill'
  },
  isSubagent: true,
  success: true
}

describe('CoolToolRenderer (zip-hydrated)', () => {
  it('renders normalized payload without errors', () => {
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: hydratedZip,
        toolId: 'zip123'
      }
    })

    expect(container.innerHTML.length).toBeGreaterThan(0)
  })

  it('does not mutate hydrated tool result objects while extracting display metadata', () => {
    const observation = {
      metadata: {
        toolProvider: 'batshit-server',
        origin: 'zip'
      },
      executionTime: 123,
      tokenCount: 45,
      content: 'hello from a hydrated zip'
    }

    render(CoolToolRenderer as any, {
      props: {
        intermediateStep: {
          toolName: 'unknown_tool',
          toolResult: observation,
          success: true
        },
        toolId: 'zip_mutation_guard_1'
      }
    })

    expect(observation).toEqual({
      metadata: {
        toolProvider: 'batshit-server',
        origin: 'zip'
      },
      executionTime: 123,
      tokenCount: 45,
      content: 'hello from a hydrated zip'
    })
  })

  it('maps native dynamic find results to the Dynamic MCP renderer', async () => {
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: nativeDynamicMcpFindZip,
        toolId: 'zip_dynamic_find_1'
      }
    })

    await waitFor(() => {
      expect(container.textContent || '').not.toContain('Loading native_dynamic_mcp_find')
    })
    expect(screen.getByText('Dynamic Tool Search')).toBeTruthy()
    expect(screen.getByText(/query: redis/i)).toBeTruthy()
  })

  it('renders mapped native bash search results without crashing', async () => {
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: mappedNativeBashSearchZip,
        toolId: 'zip_native_bash_search_1'
      }
    })

    await waitFor(() => {
      expect(container.textContent || '').toContain('Search Files')
    })
    expect(container.textContent || '').toContain('1 match in 1 file')
  })

  it('renders mapped native bash read results using file content output', async () => {
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: mappedNativeBashReadZip,
        toolId: 'zip_native_bash_read_1'
      }
    })

    await waitFor(() => {
      expect(container.textContent || '').toContain('Read File')
    })
    const headerButton = await screen.findByRole('button', { name: /read file/i })
    await fireEvent.click(headerButton)
    expect(container.textContent || '').toContain('Batshit Overview')
    expect(container.textContent || '').not.toContain('"stdout"')
  })

  it('shows a shell read that exited non-zero as a failed Read File card (F-P6-5)', async () => {
    const filePath = '/definitely/not/a/real/file.txt'
    const step = buildHydratedCoolToolStep(
      storedShellReadPayload(filePath, {
        content: `cat: ${filePath}: No such file or directory`,
        lineCount: 2,
        size: 64,
        language: 'plaintext',
        contentTruncated: false,
        contentOmitted: false,
        contentChars: 64,
        exitCode: 1
      })
    )
    const { container } = render(CoolToolRenderer as any, {
      props: { intermediateStep: step, toolId: 'zip_failed_shell_read_1' }
    })

    const headerButton = await screen.findByRole('button', { name: /read file/i })
    expect(container.querySelector('.full-tool')?.classList.contains('error')).toBe(true)
    await fireEvent.click(headerButton)
    await waitFor(() => {
      const text = container.textContent || ''
      expect(text).toContain('Command exited with code 1')
      expect(text).toContain('No such file or directory')
      expect(text).toContain('Exit Code')
    })
    expect(container.querySelector('.error-content')).not.toBeNull()
  })

  it('keeps a successful shell read card free of any failure (F-P6-5)', async () => {
    const filePath = '/tmp/batshit-example/notes.md'
    const step = buildHydratedCoolToolStep(
      storedShellReadPayload(filePath, {
        content: '# Notes\n\nFirst line.\nSecond line.',
        lineCount: 5,
        size: 34,
        language: 'markdown',
        contentTruncated: false,
        contentOmitted: false,
        contentChars: 34
      })
    )
    const { container } = render(CoolToolRenderer as any, {
      props: { intermediateStep: step, toolId: 'zip_present_shell_read_1' }
    })

    const headerButton = await screen.findByRole('button', { name: /read file/i })
    expect(container.querySelector('.full-tool')?.classList.contains('error')).toBe(false)
    await fireEvent.click(headerButton)
    await waitFor(() => {
      expect(container.textContent || '').toContain('First line.')
    })
    const text = container.textContent || ''
    expect(text).not.toContain('Exit Code')
    expect(text).not.toContain('exited with code')
    expect(container.querySelector('.error-content')).toBeNull()
  })

  it('shows a shell write that exited non-zero as not written (F-P6-5)', async () => {
    const step = buildHydratedCoolToolStep(
      storedShellActionPayload({
        lane: 'write_file',
        toolName: 'batshit_server_overwrite_file',
        toolArgs: { filePath: '/nope/dir/out.txt', path: '/nope/dir/out.txt', innerCommand: 'echo hi > /nope/dir/out.txt' },
        toolResult: {
          filePath: '/nope/dir/out.txt',
          path: '/nope/dir/out.txt',
          content: 'hi',
          lineCount: 1,
          size: 2,
          language: 'plaintext',
          contentTruncated: false,
          contentOmitted: false,
          contentChars: 2,
          exitCode: 1,
          commandOutput: 'zsh: no such file or directory: /nope/dir/out.txt'
        }
      })
    )
    const { container } = render(CoolToolRenderer as any, {
      props: { intermediateStep: step, toolId: 'zip_failed_shell_write_1' }
    })

    const headerButton = await screen.findByRole('button', { name: /write file/i })
    expect(container.querySelector('.full-tool')?.classList.contains('error')).toBe(true)
    expect(headerButton.textContent || '').toContain('not written')
    expect(headerButton.textContent || '').not.toContain('lines written')
    await fireEvent.click(headerButton)
    await waitFor(() => {
      const text = container.textContent || ''
      expect(text).toContain('Command exited with code 1')
      expect(text).toContain('zsh: no such file or directory: /nope/dir/out.txt')
      expect(text).toContain('Not written')
      expect(text).toContain('Exit Code')
    })
    expect(container.querySelector('.error-content')).not.toBeNull()
  })

  it('shows a shell edit that exited non-zero as not applied (F-P6-5)', async () => {
    const step = buildHydratedCoolToolStep(
      storedShellActionPayload({
        lane: 'edit_file',
        toolName: 'batshit_server_edit_file',
        toolArgs: { filePath: '/nope/missing.txt', path: '/nope/missing.txt', innerCommand: 'sed -i s/a/b/ /nope/missing.txt' },
        toolResult: {
          filePath: '/nope/missing.txt',
          path: '/nope/missing.txt',
          diff: '',
          diffTruncated: false,
          diffOmitted: false,
          language: 'plaintext',
          exitCode: 1,
          commandOutput: 'sed: /nope/missing.txt: No such file or directory'
        }
      })
    )
    const { container } = render(CoolToolRenderer as any, {
      props: { intermediateStep: step, toolId: 'zip_failed_shell_edit_1' }
    })

    const headerButton = await screen.findByRole('button', { name: /edit not applied/i })
    expect(container.querySelector('.full-tool')?.classList.contains('error')).toBe(true)
    await fireEvent.click(headerButton)
    await waitFor(() => {
      const text = container.textContent || ''
      expect(text).toContain('Edit not applied: Command exited with code 1')
      expect(text).toContain('Not applied')
      expect(text).toContain('Exit Code')
    })
    // What the command printed is in the error section, never a data dump shown as the diff.
    expect(container.querySelector('.error-content')?.textContent).toContain(
      'sed: /nope/missing.txt: No such file or directory'
    )
    expect(container.querySelector('.diff-display')).toBeNull()
    expect(container.textContent || '').not.toContain('commandOutput')
    expect(container.textContent || '').not.toContain('No changes made')
  })

  it.each([
    {
      label: 'a Codex listing that exited 1',
      error: undefined,
      exitCode: 1,
      headline: 'Command exited with code 1'
    },
    {
      label: 'an API listing the step marked failed',
      error: 'Tool execution failed.',
      exitCode: 2,
      headline: 'Tool execution failed.'
    }
  ])('shows $label as a failed listing, not an empty directory (F-P6-5)', async ({ error, exitCode, headline }) => {
    const step = buildHydratedCoolToolStep(
      storedShellActionPayload({
        lane: 'list_files',
        toolName: 'batshit_server_list_files',
        toolArgs: { path: '/nope', dirPath: '/nope', innerCommand: 'ls /nope' },
        toolResult: {
          files: [],
          totalFiles: 0,
          totalDirectories: 0,
          totalUnknownItems: 0,
          totalItems: 0,
          exitCode,
          commandOutput: 'ls: /nope: No such file or directory'
        },
        error
      })
    )
    const { container } = render(CoolToolRenderer as any, {
      props: { intermediateStep: step, toolId: `zip_failed_shell_list_${exitCode}` }
    })

    const headerButton = await screen.findByRole('button', { name: /list files/i })
    expect(headerButton.textContent || '').toContain('Failed to list nope')
    expect(headerButton.textContent || '').not.toContain('Empty directory')
    expect(headerButton.hasAttribute('disabled')).toBe(false)
    await fireEvent.click(headerButton)
    await waitFor(() => {
      const text = container.textContent || ''
      expect(text).toContain(headline)
      expect(text).toContain('ls: /nope: No such file or directory')
    })
    expect(container.textContent || '').not.toContain('No files found')
  })

  // fp65g: a failed search keeps what the command printed as `commandOutput`, because the API lane
  // keeps a command's error text in `stderr`, apart from its output.
  function storedSearchStep(toolResult: Record<string, any>, error?: string) {
    const command = toolResult.results ? 'grep -rn First /tmp/batshit-example /nope' : 'grep -rn zzz /nope'
    return buildHydratedCoolToolStep({
      schemaVersion: 1,
      type: 'tool',
      toolName: 'search_files',
      displayToolName: 'batshit_server_search_files',
      originalToolName: 'native_bash_execute',
      operationKind: 'search_files',
      rendererFamily: 'bash',
      toolCallId: 'call_failed_search',
      toolArgs: { command, innerCommand: command },
      toolResult,
      ...(error ? { error } : {}),
      timestamp: '2026-09-18T08:00:00.000Z',
      toolProvider: 'batshit-server',
      toolSource: 'native-tool',
      rawSidecar: { status: 'not_retained', reason: 'compact-main-payload' },
      storage: { compacted: false, truncated: false, binaryLikeOmitted: false, forceCompress: false },
      metadata: { operationKind: 'search_files', rendererFamily: 'bash' }
    })
  }

  it('shows what a failed API search printed, never that it printed nothing (fp65g)', async () => {
    const step = storedSearchStep(
      {
        query: 'zzz',
        output: '',
        stdout: '',
        truncated: false,
        exitCode: 2,
        commandOutput: 'grep: /nope: No such file or directory'
      },
      'Tool execution failed.'
    )
    const { container } = render(CoolToolRenderer as any, {
      props: { intermediateStep: step, toolId: 'zip_failed_api_search_1' }
    })

    const headerButton = await screen.findByRole('button', { name: /search files/i })
    expect(container.querySelector('.full-tool')?.classList.contains('error')).toBe(true)
    await fireEvent.click(headerButton)
    await waitFor(() => {
      expect(container.querySelector('.terminal-output')?.textContent).toContain(
        'grep: /nope: No such file or directory'
      )
    })
    const text = container.textContent || ''
    expect(text).not.toContain('Command completed with no output')
    expect(text).toContain('Process exited with code 2')
    expect(text).not.toContain('commandOutput')
  })

  it('shows what a failed search printed under the matches it found first (fp65g)', async () => {
    const step = storedSearchStep({
      results: [
        {
          path: '/tmp/batshit-example/notes.md',
          matchCount: 1,
          matches: [{ lineNumber: 3, text: 'First line.' }]
        }
      ],
      query: 'First',
      totalMatches: 1,
      totalMatchingFiles: 1,
      exitCode: 2,
      commandOutput: '/tmp/batshit-example/notes.md:3:First line.\ngrep: /nope: No such file or directory'
    })
    const { container } = render(CoolToolRenderer as any, {
      props: { intermediateStep: step, toolId: 'zip_failed_partial_search_1' }
    })

    const headerButton = await screen.findByRole('button', { name: /search files/i })
    expect(headerButton.textContent || '').toContain('1 match in 1 file')
    await fireEvent.click(headerButton)
    await waitFor(() => {
      expect(container.querySelector('.search-results')?.textContent).toContain('First line.')
    })
    expect(container.querySelector('.terminal-output')?.textContent).toContain(
      'grep: /nope: No such file or directory'
    )
  })

  it('shows a search error a lane stored as its output once, and a clean search no terminal (fp65g)', async () => {
    const failed = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: storedSearchStep({
          query: 'zzz',
          output: 'grep: /nope: No such file or directory',
          stdout: 'grep: /nope: No such file or directory',
          truncated: false,
          exitCode: 2
        }),
        toolId: 'zip_failed_codex_search_1'
      }
    })
    await fireEvent.click(await within(failed.container).findByRole('button', { name: /search files/i }))
    await waitFor(() => {
      expect(failed.container.querySelector('.terminal-output')).not.toBeNull()
    })
    expect((failed.container.textContent || '').split('grep: /nope: No such file or directory').length - 1).toBe(1)

    const matched = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: storedSearchStep({
          results: [
            { path: '/tmp/batshit-example/notes.md', matchCount: 1, matches: [{ lineNumber: 3, text: 'First line.' }] }
          ],
          query: 'First',
          totalMatches: 1,
          totalMatchingFiles: 1
        }),
        toolId: 'zip_matched_search_1'
      }
    })
    await fireEvent.click(await within(matched.container).findByRole('button', { name: /search files/i }))
    await waitFor(() => {
      expect(matched.container.querySelector('.search-results')).not.toBeNull()
    })
    expect(matched.container.querySelector('.terminal-output')).toBeNull()
  })

  // F-P6-5 follow-up item 4: Codex reports a native patch's targets as a list of objects, and
  // reading that list as a diff made every delete an Edit File card whose diff was its JSON.
  it('renders a Codex delete as its command, not as an edit with a JSON diff', async () => {
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: {
          toolName: 'batshit_server_execute_command',
          operationKind: 'bash',
          rendererFamily: 'bash',
          toolArgs: { command: 'rm /tmp/batshit-example/old.md' },
          toolResult: { command: 'rm /tmp/batshit-example/old.md', stdout: '', stderr: '' },
          metadata: { toolProvider: 'batshit-server' },
          success: true
        },
        toolId: 'zip_codex_delete_1'
      }
    })

    const headerButton = await screen.findByRole('button', { name: /bash/i })
    expect(headerButton.textContent || '').toContain('rm /tmp/batshit-example/old.md')
    expect(container.querySelector('.diff-display')).toBeNull()
    expect(container.textContent || '').not.toContain('"kind"')
  })

  // F-P6-5 follow-up item 6: `ls` of several directories heads each one's entries with `<dir>:`.
  it('renders a multi-directory listing under its directories, without the header rows', async () => {
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: {
          toolName: 'batshit_server_list_files',
          operationKind: 'list_files',
          rendererFamily: 'list_files',
          toolArgs: { command: 'ls /tmp/x /tmp/y', innerCommand: 'ls /tmp/x /tmp/y', path: '/tmp/x' },
          toolResult: {
            files: [
              { name: 'a.md', path: '/tmp/x/a.md', type: 'unknown' },
              { name: 'b.md', path: '/tmp/y/b.md', type: 'unknown' }
            ],
            totalItems: 2,
            totalFiles: 0,
            totalDirectories: 0,
            totalUnknownItems: 2
          },
          metadata: { toolProvider: 'batshit-server' },
          success: true
        },
        toolId: 'zip_list_files_multi_1'
      }
    })

    const headerButton = await screen.findByRole('button', { name: /list files/i })
    expect(headerButton.textContent || '').toContain('2 files')
    await fireEvent.click(headerButton)
    const text = container.textContent || ''
    expect(text).toContain('a.md')
    expect(text).toContain('b.md')
    // The directories are the tree the entries hang under, never entries of their own.
    expect(text).not.toContain('/tmp/x:')
    expect(text).not.toContain('/tmp/y:')
  })

  it('keeps mapped native bash list results expandable', async () => {
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: mappedNativeBashListZip,
        toolId: 'zip_native_bash_list_1'
      }
    })

    const headerButton = await screen.findByRole('button', { name: /list files/i })
    expect(headerButton.hasAttribute('disabled')).toBe(false)
    await fireEvent.click(headerButton)
    await waitFor(() => {
      expect(container.textContent || '').toContain('Luci.md')
    })
  })

  it('renders structured tool errors as readable text (not [object Object])', async () => {
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: nativeFabricStructuredErrorZip,
        toolId: 'zip_native_fabric_structured_error_1'
      }
    })

    await waitFor(() => {
      expect((container.textContent || '').toLowerCase()).toContain('artifact field')
    })

    const headerButton = await screen.findByRole('button', { name: /artifact field/i })
    await fireEvent.click(headerButton)

    await waitFor(() => {
      const text = container.textContent || ''
      expect(text).toContain('Zone is required')
      expect(text).not.toContain('[object Object]')
    })
  })

  it('does not render artifact-use broker results as subagent calls when stale provider metadata says subagent', async () => {
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: staleSubagentArtifactUseZip,
        toolId: 'zip_stale_subagent_artifact_use_1'
      }
    })

    await waitFor(() => {
      expect((container.textContent || '').toLowerCase()).toContain('artifact')
    })

    expect(container.textContent || '').not.toContain('Subagent Call')
  })

  it('renders brokered Fetch Zip by its helper label, not the broker wrapper', async () => {
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: brokeredFetchZip,
        toolId: 'zip_brokered_fetch_zip_1'
      }
    })

    await waitFor(() => {
      expect(container.textContent || '').toContain('Fetch Zip')
    })
    expect(container.textContent || '').not.toContain('Dynamic Tool Use')
  })

  it('renders the bash renderer family as Bash', async () => {
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: normalizedBashZip,
        toolId: 'zip_bash_family_1'
      }
    })

    await waitFor(() => {
      expect(container.textContent || '').toContain('Bash')
    })
    const headerButton = await screen.findByRole('button', { name: /bash/i })
    expect(headerButton.textContent || '').toContain('pwd')
    await fireEvent.click(headerButton)
    expect(container.textContent || '').toContain('/Users/example/batshit')
    expect(container.textContent || '').toContain('Working Directory')
    expect(container.textContent || '').toContain('Exit Code')
  })

  it('renders skill_read with the read-file renderer family', async () => {
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: normalizedSkillReadZip,
        toolId: 'zip_skill_read_1'
      }
    })

    await waitFor(() => {
      expect(container.textContent || '').toContain('Skill Read')
    })

    const headerButton = await screen.findByRole('button', { name: /skill read/i })
    expect(headerButton.textContent || '').toContain('Agent Browser')
    expect(headerButton.textContent || '').toContain('3 lines')
    await fireEvent.click(headerButton)
    expect(container.textContent || '').toContain('Agent Browser')
    expect(container.textContent || '').toContain('Skill')
    expect(container.textContent || '').toContain('.agents/skills/agent-browser/SKILL.md')
    expect(container.textContent || '').toContain('Language')
  })

  it('renders skill invoke content without falling back to raw JSON', async () => {
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: normalizedSkillInvokeZip,
        toolId: 'zip_skill_invoke_1'
      }
    })

    await waitFor(() => {
      expect(container.textContent || '').toContain('Skill')
    })

    const headerButton = await screen.findByRole('button', { name: /skill/i })
    expect(headerButton.textContent || '').toContain('Agent Browser')
    await fireEvent.click(headerButton)
    const text = container.textContent || ''
    expect(text).toContain('Agent Browser')
    expect(text).toContain('Action')
    expect(text).toContain('Invoke')
    expect(text).toContain('SKILL.md')
    expect(text).not.toContain('"skillMarkdown"')
  })

  it('normalizes raw legacy Batshit Native Tools skill invokes before renderer selection', async () => {
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: rawMode1NativeSkillInvokeZip,
        toolId: 'zip_mode1_native_skill_invoke_1'
      }
    })

    await waitFor(() => {
      expect(container.textContent || '').toContain('Skill')
    })

    const headerButton = await screen.findByRole('button', { name: /skill/i })
    expect(headerButton.textContent || '').toContain('Agent Browser')
    expect(container.textContent || '').not.toContain('batshit Native Tools')
    await fireEvent.click(headerButton)
    const text = container.textContent || ''
    expect(text).toContain('Action')
    expect(text).toContain('Invoke')
    expect(text).toContain('SKILL.md')
    expect(text).not.toContain('"skillMarkdown"')
  })

  it('renders web_search with the dedicated renderer family', async () => {
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: normalizedWebSearchZip,
        toolId: 'zip_web_search_1'
      }
    })

    await waitFor(() => {
      expect(container.textContent || '').toContain('Web Search')
    })

    const headerButton = await screen.findByRole('button', { name: /web search/i })
    expect(headerButton.textContent || '').toContain('batshit app')
    await fireEvent.click(headerButton)
    expect(container.textContent || '').toContain('Batshit')
    expect(container.textContent || '').toContain('batshit.ai')
    const resultLink = screen.getByRole('link', { name: /open batshit/i })
    expect(resultLink.getAttribute('href')).toBe('https://batshit.ai')
    expect(resultLink.getAttribute('target')).toBe('_blank')
    expect(resultLink.getAttribute('rel')).toContain('noopener')
    expect(container.textContent || '').toContain('Provider')
    expect(container.textContent || '').toContain('exa')
    expect(container.textContent || '').toContain('Results')
  })

  it('renders write_file with the shared Write File title', async () => {
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: normalizedWriteFileZip,
        toolId: 'zip_write_file_1'
      }
    })

    await waitFor(() => {
      expect(container.textContent || '').toContain('Write File')
    })

    const headerButton = await screen.findByRole('button', { name: /write file/i })
    expect(headerButton.textContent || '').toContain('sa049-smoke-write.txt')
    expect(container.textContent || '').not.toContain('Overwrite File')
    await fireEvent.click(headerButton)
    const text = container.textContent || ''
    expect(text).toContain('File Path')
    expect(text).toContain('/Users/example/hello/sa049-smoke-write.txt')
    expect(text).toContain('Lines Written')
    expect(text).toContain('3')
    expect(text).toContain('alpha')
    expect(text).toContain('beta')
    expect(text).toContain('gamma')
  })

  it('renders command-only write_file payloads with truthful counts and preview text', async () => {
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: normalizedCommandOnlyWriteFileZip,
        toolId: 'zip_write_file_command_only_1'
      }
    })

    await waitFor(() => {
      expect(container.textContent || '').toContain('Write File')
    })

    const headerButton = await screen.findByRole('button', { name: /write file/i })
    expect(headerButton.textContent || '').toContain('3 lines')
    await fireEvent.click(headerButton)
    const text = container.textContent || ''
    expect(text).toContain('/Users/example/hello/sa049-mode1-write.txt')
    expect(text).toContain('Lines Written')
    expect(text).toContain('3')
    expect(text).toContain('alpha')
    expect(text).toContain('beta')
    expect(text).toContain('gamma')
    expect(text).not.toContain('content preview unavailable')
  })

  it('renders summary-only edit_file payloads without a fake zero-change count', async () => {
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: normalizedSummaryOnlyEditFileZip,
        toolId: 'zip_edit_file_summary_only_1'
      }
    })

    await waitFor(() => {
      expect(container.textContent || '').toContain('Edit File')
    })

    const headerButton = await screen.findByRole('button', { name: /edit file/i })
    const headerText = headerButton.textContent || ''
    expect(headerText).toContain('sa049-mode1-write-unblocked.txt')
    expect(headerText).not.toContain('0 changes')

    await fireEvent.click(headerButton)
    const text = container.textContent || ''
    expect(text).toContain('File Path')
    expect(text).toContain('/Users/example/hello/sa049-mode1-write-unblocked.txt')
    expect(text).toContain('Diff unavailable because Batshit could not reconstruct the before/after change.')
    expect(text).not.toContain('Total Changes')
  })

  it('renders edit_file diffs when the compact payload includes before/after-derived diff text', async () => {
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: normalizedDiffEditFileZip,
        toolId: 'zip_edit_file_diff_1'
      }
    })

    await waitFor(() => {
      expect(container.textContent || '').toContain('Edit File')
    })

    const headerButton = await screen.findByRole('button', { name: /edit file/i })
    expect(headerButton.textContent || '').toContain('2 changes')

    await fireEvent.click(headerButton)
    const text = container.textContent || ''
    expect(text).toContain('Total Changes')
    expect(text).toContain('2')
    expect(text).toContain('beta')
    expect(text).toContain('bravo')
  })

  it('renders an API edit stored from its before/after copies as its changed lines', async () => {
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: apiSnapshotEditFileZip(
          '--- Before\n+++ After\n    1 | # Notes\n    2 | \n-   3 | First line.\n+   3 | Last line.\n    4 | Second line.\n    5 |',
          "sed -i 's/First/Last/' /tmp/batshit-example/notes.md"
        ),
        toolId: 'zip_api_edit_snapshot_1'
      }
    })

    const headerButton = await screen.findByRole('button', { name: /edit file/i })
    expect(headerButton.textContent || '').toContain('2 changes')

    await fireEvent.click(headerButton)
    const text = container.textContent || ''
    expect(text).toContain('- 3 | First line.')
    expect(text).toContain('+ 3 | Last line.')
    expect(text).not.toContain('Diff unavailable')
  })

  it('renders an edit that changed nothing as that sentence, with no count and no data dump', async () => {
    const sentence = 'No changes: the command left /tmp/batshit-example/notes.md exactly as it was.'
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: apiSnapshotEditFileZip(sentence, "sed -i 's/zzz/yyy/' /tmp/batshit-example/notes.md"),
        toolId: 'zip_api_edit_unchanged_1'
      }
    })

    const headerButton = await screen.findByRole('button', { name: /edit file/i })
    expect(headerButton.textContent || '').not.toContain('changes')

    await fireEvent.click(headerButton)
    const text = container.textContent || ''
    expect(text).toContain(sentence)
    expect(text).not.toContain('Edit Not Applied')
    expect(text).not.toContain('diffTruncated')
    expect(text).not.toContain('Total Changes')
  })

  it('renders search_files fallback metadata with truthful query and counts', async () => {
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: normalizedSearchFilesFallbackZip,
        toolId: 'zip_search_files_fallback_1'
      }
    })

    await waitFor(() => {
      expect(container.textContent || '').toContain('Search Files')
    })

    const headerButton = await screen.findByRole('button', { name: /search files/i })
    expect(headerButton.textContent || '').toContain('2 matches in 2 files')
    await fireEvent.click(headerButton)
    const text = container.textContent || ''
    expect(text).toContain('Query')
    expect(text).toContain('zipActivation')
    expect(text).toContain('Matching Files')
    expect(text).toContain('2')
    expect(text).toContain('Total Matches')
    expect(text).toContain('zipActivation.ts')
  })

  it('renders files-only search_files output as matching file rows without mangling hyphenated filenames', async () => {
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: normalizedSearchFilesFilesOnlyZip,
        toolId: 'zip_search_files_files_only_1'
      }
    })

    await waitFor(() => {
      expect(container.textContent || '').toContain('Search Files')
    })

    const headerButton = await screen.findByRole('button', { name: /search files/i })
    expect(headerButton.textContent || '').toContain('3 matches in 3 files')
    await fireEvent.click(headerButton)
    const text = container.textContent || ''
    expect(text).toContain('Query')
    expect(text).toContain('zipActivation')
    expect(text).toContain('Matching Files')
    expect(text).toContain('3')
    expect(text).toContain('/Users/example/batshit/docs/user-docs/tools/zips.md')
    expect(text).not.toContain('/Users/example/batshit/docs/user-docs/tools 1 match')
  })

  it('renders grep -rl files-only search output with truthful counts', async () => {
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: normalizedSearchFilesGrepCombinedFlagsZip,
        toolId: 'zip_search_files_grep_combined_flags_1'
      }
    })

    await waitFor(() => {
      expect(container.textContent || '').toContain('Search Files')
    })

    const headerButton = await screen.findByRole('button', { name: /search files/i })
    expect(headerButton.textContent || '').toContain('1 match in 1 file')
    await fireEvent.click(headerButton)
    const text = container.textContent || ''
    expect(text).toContain('Query')
    expect(text).toContain('\\bworkspace\\b')
    expect(text).toContain('Matching Files')
    expect(text).toContain('1')
    expect(text).toContain('/Users/example/hello/hello.md')
  })

  it('renders rg --files list payloads as List Files with structured counts', async () => {
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: normalizedListFilesFromRgZip,
        toolId: 'zip_list_files_rg_files_1'
      }
    })

    await waitFor(() => {
      expect(container.textContent || '').toContain('List Files')
    })

    const headerButton = await screen.findByRole('button', { name: /list files/i })
    expect(headerButton.textContent || '').toContain('3 items')
    await fireEvent.click(headerButton)
    const text = container.textContent || ''
    expect(text).toContain('ChatArea.svelte')
    expect(text).toContain('ToolActivityGroup.svelte')
    expect(text).toContain('Files')
    expect(text).toContain('3')
    expect(text).toContain('Directories')
    expect(text).toContain('0')
    expect(text).toContain('Items')
  })

  it('renders bare ls list payloads without inventing file or directory certainty', async () => {
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: normalizedListFilesFromBareLsZip,
        toolId: 'zip_list_files_bare_ls_1'
      }
    })

    await waitFor(() => {
      expect(container.textContent || '').toContain('List Files')
    })

    const headerButton = await screen.findByRole('button', { name: /list files/i })
    expect(headerButton.textContent || '').toContain('2 items')
    await fireEvent.click(headerButton)
    const text = container.textContent || ''
    expect(text).toContain('artifacts')
    expect(text).toContain('hello.md')
    expect(text).toContain('Unknown Type')
    expect(text).toContain('Item')
    expect(text).not.toContain('Known Files0')
    expect(text).not.toContain('Known Directories0')
  })

  it('renders subagent preview payloads as clean response text instead of raw JSON', async () => {
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: subagentPreviewResultZip,
        toolId: 'zip_subagent_preview_result_1'
      }
    })

    await waitFor(() => {
      expect(container.textContent || '').toContain('Subagent Call')
    })

    const headerButton = await screen.findByRole('button', { name: /subagent/i })
    await fireEvent.click(headerButton)

    const text = container.textContent || ''
    expect(text).toContain('Of course, Gina. I read README.md successfully.')
    expect(text).not.toContain('"preview"')
  })

  it('renders icon-only subagent call avatars through the shared avatar icon path', async () => {
    const { container } = render(CoolToolRenderer as any, {
      props: {
        intermediateStep: subagentIconAvatarZip,
        toolId: 'zip_subagent_icon_avatar_1'
      }
    })

    await waitFor(() => {
      expect(container.textContent || '').toContain('Subagent Call')
    })

    const headerButton = await screen.findByRole('button', { name: /subagent/i })
    await fireEvent.click(headerButton)

    await waitFor(() => {
      expect(container.querySelectorAll('.bs-entity-avatar-icon').length).toBeGreaterThanOrEqual(2)
    })
    expect(container.querySelector('img[src="/assets/batshit_default_AI_Avatar_1.png"]')).toBeNull()
    expect(container.textContent || '').toContain('Icon delegation complete.')
  })
})
