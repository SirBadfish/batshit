import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { nativeToolService } from '../nativeTools'
import { findCommandModelCapture, commandModelCaptureResponse } from '../commandModelCaptureResponse'
import { redis } from '$lib/server/redis'
import { VercelAIBrain } from '../vercelBrain'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'

useRedisTestServer()
// The in-memory lane has no Lua; the fake stands in for the kept copy's atomic publish.
beforeEach(() => {
  if (process.env.VITEST_USE_REAL_REDIS !== 'true') vi.stubEnv('VITEST_FAKE_RETAINED_OUTPUT_EVAL', 'true')
})

let workspace: string | null = null
afterEach(async () => {
  vi.unstubAllEnvs()
  if (workspace) await rm(workspace, { recursive: true, force: true })
  workspace = null
})

describe('native command output crosses actual result boundaries privately', () => {
  it('keeps a tail beyond the visible Bash cap through direct and managed dispatch', async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-command-capture-'))
    const stdout = '界'.repeat(140_000) + '\nORIGINAL-TAIL'
    await writeFile(path.join(workspace, 'output.txt'), stdout)
    const direct = await nativeToolService.nativeBashExecute({
      command: 'cat output.txt', workspaceRoot: workspace, cwd: workspace,
      accessMode: 'dangerous', backend: 'local'
    })
    expect(direct.success).toBe(true)
    expect(direct.truncated).toBe(true)
    expect(direct.stdout).not.toContain('ORIGINAL-TAIL')
    const original = findCommandModelCapture(direct)
    expect(original?.text).toContain(stdout)
    expect(original?.text).toContain('exitCode=0')
    expect(JSON.stringify(direct)).not.toContain('ORIGINAL-TAIL')
    const agentId = 'agent-private-capture'
    await redis.set(`agent:${agentId}`, {
      user_id: 'capture-user', provider_specific_settings: {
        nativeTools: { executionBackend: 'local', bashEnabled: true, bashAccessMode: 'dangerous' }
      }
    })
    // BL-878 (Josh, 2026-09-28): the agent lane (a managed Codex or Claude run's credential) is
    // refused `bash_execute`, so the dispatch's private capture is proven on a caller that keeps
    // Bash through it, an n8n Workflow Subagent's callback. `commandModelCaptureResponse` below
    // takes the route's lane flag (`auth.auth === 'agent'`) as a plain boolean either way.
    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'capture-user', action: 'bash_execute', payloadInput: { command: 'cat output.txt' },
      context: { session_id: 'capture-session', agent_id: agentId, mode: 'mode4', actor_type: 'primary' },
      projectPath: workspace, actorType: 'n8n-callback'
    } as any)
    expect(result.success).toBe(true)
    expect(findCommandModelCapture(result)?.text).toContain(stdout)
    const internal = commandModelCaptureResponse(result, true)
    expect(internal.headers.get('x-batshit-command-model-capture')).toBe('1')
    const body = await internal.json()
    expect(body.modelCapture.text).toContain('ORIGINAL-TAIL')
    expect(JSON.stringify(body.result)).not.toContain('ORIGINAL-TAIL')
    expect(await commandModelCaptureResponse(result, false).text()).not.toContain('ORIGINAL-TAIL')
  })

  // BL-679: a build prints 150,000 characters and then fails with one line on stderr. With
  // stdout first, the agent saw exitCode=1 and not the reason.
  it('gives the API agent the exit code and the stderr reason before a large stdout', async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-command-capture-'))
    await writeFile(path.join(workspace, 'build.js'), [
      "process.stdout.write('compiling module\\n'.repeat(9_000))",
      "process.stderr.write('error: cannot find module ./missing\\n')",
      'process.exitCode = 1'
    ].join('\n'))
    const run = await nativeToolService.nativeBashExecute({
      command: `"${process.execPath}" build.js`, workspaceRoot: workspace, cwd: workspace,
      accessMode: 'dangerous', backend: 'local'
    })
    expect(run.exitCode).toBe(1)
    expect(findCommandModelCapture(run)?.originalTextChars).toBeGreaterThan(150_000)

    const owner = { userId: 'bl679-user', sessionId: `bl679-chat-${Date.now()}`, messageId: 'bl679-reply', agentId: 'bl679-agent' }
    await redis.createSession({ id: owner.sessionId, user_id: owner.userId, agent_id: owner.agentId, title: 'BL-679' } as any)
    const wrapped = (VercelAIBrain.prototype as any).wrapToolsWithReadableModelOutput({
      native_bash_execute: { execute: async () => run }
    }, { ...owner, fetchZipAllowed: true })
    const model = await wrapped.native_bash_execute.toModelOutput({ toolCallId: 'bl679', input: {}, output: run })
    const text = String(model.value)
    const firstPart = text.slice(0, text.lastIndexOf('\n[Output cut here by Batshit'))
    expect(firstPart).toContain('exitCode=1 ')
    expect(firstPart).toContain('error: cannot find module ./missing')
    expect(firstPart.indexOf('error: cannot find module')).toBeLessThan(firstPart.indexOf('\nstdout:\ncompiling module'))
  }, 60_000)
})
