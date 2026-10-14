// @vitest-environment node
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nativeToolService } from '../nativeTools'
import { VercelAIBrain } from '../vercelBrain'
import { attachCommandModelCapture } from '../commandModelCapture'
import { guardToolModelText } from '../toolModelResultGuard'
import { formatBashResultForModel, isBashResultForModel } from '../bashResultModelText'

vi.mock('../toolModelResultGuard', () => ({
  guardToolModelText: vi.fn(async () => '[cut with saved zip]')
}))

/**
 * BL-1483: inside a reply the API lane's model read every Bash result as a pretty-printed object
 * of about twenty fields (the command three times, stdout JSON-escaped). It now reads a lean text
 * that keeps every fact the prompts and the native Bash guidance rely on. The result object the
 * card, the zip and the stored steps keep is unchanged, and the 25,000-token guard still applies.
 */

const BOOKKEEPING = {
  policyMode: 'auto',
  accessMode: 'agent',
  backend: 'local',
  backendLabel: 'This Mac',
  cwd: '/work/proj',
  workspaceRoot: '/work',
  mappedToolName: 'bash',
  mappedToolInput: { command: 'npm test' },
  mappedReason: 'generic shell command',
  durationMs: 812
}

function ranResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    blocked: false,
    command: 'npm test',
    stdout: 'ok 1 - adds\nok 2 - "quotes" stay plain\n',
    stderr: '',
    exitCode: 0,
    signal: null,
    timedOut: false,
    truncated: false,
    ...BOOKKEEPING,
    ...overrides
  }
}

describe('the lean Bash text (BL-1483)', () => {
  it('a success: the status line and stdout as plain text, nothing else', () => {
    expect(formatBashResultForModel(ranResult())).toBe(
      'success:true; exitCode:0\nstdout:\nok 1 - adds\nok 2 - "quotes" stay plain\n'
    )
  })

  it('a failing exit code keeps stdout and stderr', () => {
    expect(formatBashResultForModel(ranResult({
      success: false, exitCode: 1, stdout: 'compiling\n', stderr: 'error: cannot find module ./missing\n'
    }))).toBe('success:false; exitCode:1\nstdout:\ncompiling\n\nstderr:\nerror: cannot find module ./missing\n')
  })

  it('a blocked command keeps success:false, blocked:true, POLICY_BLOCKED and the reason', () => {
    const text = formatBashResultForModel({
      success: false, blocked: true, errorCode: 'POLICY_BLOCKED',
      reason: 'Plan mode only allows markdown (.md) apply_patch targets. Blocked: src/app.ts',
      command: 'apply_patch <<PATCH', policyMode: 'plan', accessMode: 'plan'
    })
    expect(text).toBe('success:false; blocked:true; errorCode:POLICY_BLOCKED\nreason: Plan mode only allows markdown (.md) apply_patch targets. Blocked: src/app.ts')
    // The literal words the native Bash guidance tells the model to look for.
    for (const fact of ['success:false', 'blocked:true', 'POLICY_BLOCKED']) expect(text).toContain(fact)
  })

  it('a timeout keeps timedOut, the signal and the output so far', () => {
    expect(formatBashResultForModel(ranResult({
      success: false, exitCode: null, signal: 'SIGTERM', timedOut: true, stdout: 'waiting...\n'
    }))).toBe('success:false; signal:SIGTERM; timedOut:true\nstdout:\nwaiting...\n')
  })

  it('a Stop keeps stopped and its reason', () => {
    expect(formatBashResultForModel(ranResult({
      success: false, exitCode: null, stopped: true, reason: 'The command was stopped.', stdout: ''
    }))).toBe('success:false; stopped:true\nreason: The command was stopped.\n(no output)')
  })

  it('a truncated result says truncated', () => {
    expect(formatBashResultForModel(ranResult({ truncated: true, stdout: 'line\n' }))).toBe(
      'success:true; exitCode:0; truncated:true\nstdout:\nline\n'
    )
  })

  it('an error keeps the error code and the reason once, and a different error line', () => {
    expect(formatBashResultForModel({
      success: false, blocked: false, errorCode: 'INVALID_INPUT', reason: 'Invalid apply_patch payload.',
      error: 'Invalid apply_patch payload.', command: 'apply_patch', ...BOOKKEEPING
    })).toBe('success:false; errorCode:INVALID_INPUT\nreason: Invalid apply_patch payload.')
    expect(formatBashResultForModel({
      success: false, errorCode: 'BACKEND_UNAVAILABLE', reason: 'Docker is not running.', error: 'spawn docker ENOENT'
    })).toBe('success:false; errorCode:BACKEND_UNAVAILABLE\nreason: Docker is not running.\nerror: spawn docker ENOENT')
  })

  it('keeps the shell, a managed patch\'s files, an edit diff and every Agent Browser fact', () => {
    const text = formatBashResultForModel(ranResult({
      shell: '/bin/zsh',
      stdout: 'Done!\n',
      managedApplyPatch: { managed: true, operationsApplied: 2, touchedPaths: ['src/a.ts', 'src/b.ts'] },
      diff: '@@ -1 +1 @@\n-a\n+b',
      agentBrowser: { command: 'screenshot', screenshot: { path: null, modelImageUrl: null } },
      modelImageUrl: 'https://tunnel.example/shot.png'
    }))
    expect(text).toBe([
      'success:true; exitCode:0',
      'shell: /bin/zsh',
      'apply_patch: 2 operations; files: src/a.ts, src/b.ts',
      'agentBrowser: {"command":"screenshot","screenshot":{"path":null,"modelImageUrl":null}}',
      'modelImageUrl: https://tunnel.example/shot.png',
      'diff:\n@@ -1 +1 @@\n-a\n+b',
      'stdout:\nDone!\n'
    ].join('\n'))
  })

  it('drops the command, the modes, the backend, the folders, the renderer mapping and the duration', () => {
    const text = formatBashResultForModel(ranResult({ command: 'npm test -- --grep unique-command-marker' }))
    for (const dropped of ['unique-command-marker', 'policyMode', 'accessMode', 'This Mac', '/work', 'mappedTool', 'generic shell command', 'durationMs', '812']) {
      expect(text).not.toContain(dropped)
    }
  })

  it('only a result object with a success flag is a Bash result', () => {
    expect(isBashResultForModel(ranResult())).toBe(true)
    expect(isBashResultForModel({ agentBrowser: { command: 'screenshot' } })).toBe(false)
    expect(isBashResultForModel('text')).toBe(false)
    expect(isBashResultForModel(null)).toBe(false)
    expect(isBashResultForModel([])).toBe(false)
  })
})

async function bashTool() {
  const { tools } = await nativeToolService.buildMode3NativeTools({
    userId: 'bl1483-user',
    projectPath: process.cwd(),
    imageDelivery: { lane: 'tool_result', reason: 'test' },
    providerSettings: {
      nativeTools: { fetchZipEnabled: false, dynamicMcpEnabled: false, webSearchEnabled: false, bashEnabled: true, agentBrowserEnabled: false }
    },
    toolApprovalMode: 'none'
  } as any)
  return (tools as any).native_bash_execute
}

describe('native_bash_execute gives the model the lean text (BL-1483)', () => {
  let workspace: string | null = null
  beforeEach(() => vi.clearAllMocks())
  afterEach(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true })
    workspace = null
  })

  it('a real failing command: exit code, stdout and stderr, and the stored result is unchanged', async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-bl1483-'))
    const run = await nativeToolService.nativeBashExecute({
      command: "printf 'out\\n'; printf 'err\\n' >&2; exit 3",
      workspaceRoot: workspace, cwd: workspace, accessMode: 'dangerous', backend: 'local'
    })
    const stored = JSON.stringify(run)
    const tool = await bashTool()
    const model = await tool.toModelOutput({ toolCallId: 'bl1483-run', input: {}, output: run })
    expect(model).toEqual({ type: 'text', value: `success:false; exitCode:3\nshell: ${run.shell}\nstdout:\nout\n\nstderr:\nerr\n` })
    expect(JSON.stringify(run)).toBe(stored)
    expect(run).toMatchObject({ command: expect.any(String), cwd: expect.any(String), mappedToolName: expect.any(String) })
  }, 30_000)

  it('a string or a result with no success flag keeps today\'s shape', async () => {
    const tool = await bashTool()
    expect(await tool.toModelOutput({ toolCallId: 'text', input: {}, output: 'plain' })).toEqual({ type: 'text', value: 'plain' })
    expect(await tool.toModelOutput({ toolCallId: 'odd', input: {}, output: { other: 1 } })).toEqual({ type: 'json', value: { other: 1 } })
  })

  it('through the API wrapper, a lean text at or over the 25,000-token guard is still cut', async () => {
    const owner = { userId: 'bl1483-user', sessionId: 'bl1483-chat', messageId: 'bl1483-reply', agentId: 'bl1483-agent' }
    const tool = await bashTool()
    const wrapped = (VercelAIBrain.prototype as any).wrapToolsWithReadableModelOutput({ native_bash_execute: tool }, owner)
    const big = ranResult({ stdout: 'x'.repeat(110_000) })
    const model = await wrapped.native_bash_execute.toModelOutput({ toolCallId: 'big', input: {}, output: big })
    expect(guardToolModelText).toHaveBeenCalledOnce()
    const [guarded, context] = vi.mocked(guardToolModelText).mock.calls[0]
    expect(guarded).toBe(formatBashResultForModel(big))
    expect(guarded.startsWith('success:true; exitCode:0\nstdout:\nxxx')).toBe(true)
    expect(context).toMatchObject({ ...owner, toolName: 'native_bash_execute' })
    expect(model).toEqual({ type: 'text', value: '[cut with saved zip]' })
  })

  it('through the API wrapper, a large command capture still wins (BL-679 layout)', async () => {
    const owner = { userId: 'bl1483-user', sessionId: 'bl1483-chat', messageId: 'bl1483-reply', agentId: 'bl1483-agent' }
    const tool = await bashTool()
    const wrapped = (VercelAIBrain.prototype as any).wrapToolsWithReadableModelOutput({ native_bash_execute: tool }, owner)
    const capture = { text: 'Command output\nstatus: exitCode=1 ...\n' + 'y'.repeat(120_000), originalTextChars: 120_040 }
    const output = attachCommandModelCapture(ranResult({ success: false, exitCode: 1, stdout: 'y'.repeat(1_000) }), capture)
    const model = await wrapped.native_bash_execute.toModelOutput({ toolCallId: 'capture', input: {}, output })
    expect(guardToolModelText).toHaveBeenCalledWith(capture.text, { ...owner, toolName: 'native_bash_execute', originalTextChars: capture.originalTextChars })
    expect(model).toEqual({ type: 'text', value: '[cut with saved zip]' })
  })

  it('through the API wrapper, a small result is the lean text and the guard is not asked', async () => {
    const tool = await bashTool()
    const wrapped = (VercelAIBrain.prototype as any).wrapToolsWithReadableModelOutput({ native_bash_execute: tool }, { userId: 'u', sessionId: 's', messageId: 'm', agentId: 'a' })
    const model = await wrapped.native_bash_execute.toModelOutput({ toolCallId: 'small', input: {}, output: ranResult() })
    expect(model).toEqual({ type: 'text', value: formatBashResultForModel(ranResult()) })
    expect(guardToolModelText).not.toHaveBeenCalled()
  })
})
