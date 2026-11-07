// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { adaptCoolToolsToZipSystem } from '../coolToolZipAdapter'
import { nativeToolService } from '../services/nativeTools'
import { normalizeToolArgs } from '../services/sseToolNormalization'
import { resolveNativeBashMapping } from '../services/bashCommandMapper'
import { toolStepFailureMessage } from '$lib/utils/toolResultProcessor'
import { buildCoolToolAiContent, parseCoolToolPayload } from '$lib/utils/coolToolAiContent'
import { describeToolResultFiles, findDeadCopies, type DeadCopyToolResult } from '$lib/utils/zipDeadCopies'
import { compileForAI } from '$lib/services/messageCompiler'
import { STOPPED_WITHOUT_RESULT_REASON, trackToolExecution, withToolResultsOnStop } from '../services/lateToolResults'
import { VercelAIBrain } from '../services/vercelBrain'
import { __setAnchoredWriterTestHook } from '../services/anchoredProjectWriter'

// BL-1916: a test can make one write fail, to produce a real partly written patch. BL-2157: the patch
// writes through the anchored writer (BL-2006), so the failure stands in at its test hook (a path is
// given as `/<path relative to the workspace>`); a `node:fs/promises` mock no longer sees the writes.
const writeFailure = vi.hoisted(() => ({ when: null as null | ((file: string) => boolean) }))
__setAnchoredWriterTestHook(async (op, paths) => {
  if (op === 'write' && writeFailure.when?.(`/${paths[0]}`)) throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' })
})

/**
 * SA-126 item 2 (Faye's review questions a, d, e): what the zip system stores for a native Bash call
 * that applied a managed patch and then ran the commands after it. Every result here comes from the
 * REAL executor on a real folder, becomes the step send-routed's `case 'tool-result'` builds
 * (`normalizeToolArgs`, `resolveNativeBashMapping`, `toolStepFailureMessage`), and is stored by the
 * REAL zip adapter in Redis; the dead-copy ledger, the AI view and the compile read what it stored.
 */

useRedisTestServer()

const AGENT = 'agent-after-patch'
let root = ''
let session = ''
let counter = 0

beforeEach(async () => {
  counter += 1
  root = await mkdtemp(path.join(os.tmpdir(), 'batshit-after-patch-zips-'))
  session = `after-patch-${counter}-${Date.now()}`
  await redis.createSession({ id: session, user_id: 'user-1', title: 'After patch', agent_id: AGENT } as any)
})

afterEach(async () => {
  writeFailure.when = null
  await rm(root, { recursive: true, force: true })
})

const patch = (file: string, before = 'old', after = 'new') =>
  `*** Begin Patch\n*** Update File: ${file}\n@@\n-${before}\n+${after}\n*** End Patch`

async function runBash(command: string, extra: Record<string, unknown> = {}) {
  return nativeToolService.nativeBashExecute({
    command, backend: 'local', accessMode: 'dangerous', requireApproval: false, workspaceRoot: root,
    runCommandAfterPatch: true, ...extra
  } as any)
}

/** The step send-routed's `case 'tool-result'` builds for an API `native_bash_execute` result. */
function apiStep(command: string, result: Record<string, any>) {
  const toolName = 'native_bash_execute'
  const args = normalizeToolArgs({ command })
  const resultPayload = { ...result, input: args }
  const mapping = resolveNativeBashMapping({ toolName, args, result: resultPayload })!
  const mappedResult = { ...resultPayload, originalToolName: toolName, mappedToolName: mapping.mappedToolName, mappedReason: mapping.reason }
  const error = toolStepFailureMessage(mapping.mappedToolName, mapping.mappedArgs, mappedResult)
  counter += 1
  return {
    toolName: mapping.mappedToolName, originalToolName: toolName, toolInput: mapping.mappedArgs, toolArgs: mapping.mappedArgs,
    toolResult: mappedResult, toolCallId: `call_after_${counter}`, timestamp: Date.now(), error, success: !error,
    metadata: { sessionId: session }, toolProvider: 'batshit-server', toolSource: 'native-tool', mcpServerName: 'batshit-native'
  }
}

async function store(command: string, result: Record<string, any>, messageIndex: number) {
  const step = apiStep(command, result)
  const refs = await adaptCoolToolsToZipSystem([step], session, `msg_after_${messageIndex}`, {}, undefined)
  const stored = []
  for (const ref of refs) {
    const zip = (await redis.json.get(`zip:${ref.zipId}`)) as any
    stored.push({ zipId: ref.zipId!, reference: ref.reference, zip, operationKind: zip?.metadata?.operationKind ?? null, payload: parseCoolToolPayload(zip?.content) ?? {} })
  }
  return stored
}

const ledger = (entries: Array<{ zipId: string; operationKind: string | null; payload: any }>, messageIndex: number): DeadCopyToolResult[] =>
  entries.map((entry) => ({ zipId: entry.zipId, authorId: AGENT, messageIndex, operationKind: entry.operationKind, payload: entry.payload }))

describe('a patch with commands after it is stored as two parts (SA-126 item 2)', () => {
  it('a failing test: the edit part is an applied edit; the test part keeps its exit code and output', async () => {
    await writeFile(path.join(root, 'a.txt'), 'old\n')
    const read = await store('cat a.txt', await runBash('cat a.txt'), 0)
    const command = `apply_patch <<'PATCH'\n${patch('a.txt')}\nPATCH\ncat a.txt && node -e "process.exit(1)"`
    const result = await runBash(command)
    expect(result).toMatchObject({ success: false, exitCode: 1, managedApplyPatch: { applied: true, afterPatchStarted: true } })

    // The call's one step (Execution Viewer, saved step list) says the patch applied.
    expect(toolStepFailureMessage('batshit_server_edit_file', { command }, result)).toBe('The patch applied; the command failed with exit code 1.')
    const [edit, tail, ...more] = await store(command, result, 1)
    expect(more).toEqual([])
    expect(edit.operationKind).toBe('edit_file')
    expect(edit.payload.error).toBeUndefined()
    expect(edit.payload.toolResult).toMatchObject({ filePath: 'a.txt' })
    expect(edit.payload.toolResult.diff).toContain('+new')
    expect(edit.payload.toolResult.exitCode).toBeUndefined()
    expect(edit.payload.toolResult.commandOutput).toBeUndefined()
    expect(edit.reference).toMatch(/:::edit_file: a\.txt - \d+ lines\}\}$/)

    expect(tail.operationKind).toBe('bash')
    expect(tail.payload.error).toBe('The command failed with exit code 1.')
    expect(tail.payload.toolResult).toMatchObject({ exitCode: 1, stdout: 'new' })
    expect(tail.payload.toolArgs.command).toBe('cat a.txt && node -e "process.exit(1)"')
    // A failed step reads `error` in its label, like any failed API-lane command.
    expect(tail.reference).toMatch(/:::bash: cat a\.txt && node -e .* - error - \d+ lines?\}\}$/)
    // Both parts are one call's: one tool call id, the part marker in call order.
    expect(edit.zip.metadata.toolCallId).toBe(tail.zip.metadata.toolCallId)
    expect([edit.zip.metadata.shellReadSplitPart, tail.zip.metadata.shellReadSplitPart]).toEqual([
      { index: 0, of: 2, command }, { index: 1, of: 2, command }
    ])

    // The ledger: the patch edited a.txt, so the read before it is stale, though the call failed.
    expect(describeToolResultFiles({ operationKind: edit.operationKind, payload: edit.payload }, { projectPath: root }))
      .toEqual({ kind: 'edit', files: new Set(['a.txt']) })
    const dead = findDeadCopies([...ledger(read, 0), ...ledger([edit, tail], 1)], { projectPath: root })
    expect(dead.get(read[0].zipId)).toMatchObject({ reason: 'stale' })

    // The AI view of each part: the diff for the edit, the output and exit code for the test.
    const editAi = buildCoolToolAiContent(edit.zipId, edit.zip, edit.payload)
    expect(editAi).toContain('+new')
    const tailAi = buildCoolToolAiContent(tail.zipId, tail.zip, tail.payload)
    expect(tailAi).toContain('new')
  })

  it('a passing test after a cd-form patch: a whole read of the patched file, under its folder', async () => {
    await mkdirp(path.join(root, 'app'))
    await writeFile(path.join(root, 'app', 'a.txt'), 'old\n')
    const command = `cd app && apply_patch <<'PATCH' && cat a.txt\n${patch('a.txt')}\nPATCH`
    const result = await runBash(command)
    expect(result).toMatchObject({ success: true, stdout: 'new\n' })

    const [edit, tail] = await store(command, result, 1)
    expect(edit.operationKind).toBe('edit_file')
    expect(tail.operationKind).toBe('read_file')
    expect(tail.payload.toolArgs.innerCommand).toBe('cd app && cat a.txt')
    expect(tail.payload.toolResult).toMatchObject({ content: 'new', lineCount: 1 })
    expect(describeToolResultFiles({ operationKind: tail.operationKind, payload: tail.payload }, { projectPath: root }))
      .toEqual({ kind: 'read', files: new Map([['app/a.txt', 'whole']]) })
  })

  it('a Stop after the write: the test part says it never started, and only it carries the error', async () => {
    await writeFile(path.join(root, 'a.txt'), 'old\n')
    const controller = new AbortController()
    const command = `apply_patch <<'PATCH' && npm test\n${patch('a.txt')}\nPATCH`
    writeFailure.when = (file) => {
      if (file.includes('a.txt')) queueMicrotask(() => controller.abort())
      return false
    }
    const result = await runBash(command, { abortSignal: controller.signal })
    expect(result).toMatchObject({ stopped: true, managedApplyPatch: { applied: true, afterPatchStarted: false } })

    const [edit, tail] = await store(command, result, 1)
    expect(edit.payload.error).toBeUndefined()
    expect(edit.operationKind).toBe('edit_file')
    // A command that never started has no exit code: its zip keeps the reason as stderr (FM).
    expect(tail.payload.toolResult).toMatchObject({ stdout: '', stderr: 'Never started: the reply was stopped after the patch applied.' })
    expect(tail.payload.error).toBe('Never started: the reply was stopped after the patch applied.')
    expect(tail.reference).toMatch(/:::bash: npm test - error -/)
  })

  it('a Stop during the test: the SDK drops the result, the Stop rule hands it on, and it is stored as two parts (BL-1959)', async () => {
    await writeFile(path.join(root, 'a.txt'), 'old\n')
    const controller = new AbortController()
    const command = `apply_patch <<'PATCH' && echo started && sleep 30\n${patch('a.txt')}\nPATCH`
    // The Stop lands after the write, while the commands after the patch run.
    writeFailure.when = (file) => {
      if (file.includes('a.txt')) setTimeout(() => controller.abort(), 400)
      return false
    }
    const execution = runBash(command, { abortSignal: controller.signal })
    // What the AI SDK does on that Stop (pinned in `lateToolResults.test.ts`): it waits for the
    // call's execute, then ends the stream with `abort` and no `tool-result`.
    trackToolExecution(controller.signal, 'call_stopped_tail', 'native_bash_execute', { command }, execution)
    async function* sdkStream() {
      yield { type: 'tool-call', toolCallId: 'call_stopped_tail', toolName: 'native_bash_execute', input: { command } }
      await execution
      yield { type: 'abort', reason: 'user' }
    }
    const parts: Array<Record<string, any>> = []
    for await (const part of withToolResultsOnStop(sdkStream(), controller.signal)) parts.push(part)
    const handedOn = parts.find((part) => part.type === 'tool-result')
    expect(handedOn?.output).toMatchObject({ stopped: true, managedApplyPatch: { applied: true, afterPatchStarted: true } })

    const [edit, tail, ...more] = await store(command, handedOn!.output, 1)
    expect(more).toEqual([])
    // The patch applied: its part is an ordinary edit with no error.
    expect(edit.operationKind).toBe('edit_file')
    expect(edit.payload.error).toBeUndefined()
    expect(edit.payload.toolResult.diff).toContain('+new')
    expect(tail.payload.toolArgs.command).toBe('echo started && sleep 30')
    // The stopped command is the test part's, with its output so far, stored as a plain stopped
    // command is (its reason as stderr).
    expect(tail.payload.toolResult).toMatchObject({ stdout: 'started', stderr: 'The command was stopped.' })
    expect(tail.payload.error).toBe('The command was stopped.')
    expect(tail.reference).toMatch(/:::bash: echo started && sleep 30 - error -/)
  }, 20_000)

  it('a call still running when the Stop wait ends keeps its applied edit (BL-1978; the API tool as the SDK sees it)', async () => {
    await writeFile(path.join(root, 'a.txt'), 'old\n')
    const read = await store('cat a.txt', await runBash('cat a.txt'), 0)
    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'user-1',
      projectPath: root,
      providerSettings: {
        nativeTools: {
          bashEnabled: true, executionBackend: 'local', bashPolicyMode: 'workspace', bashAccessMode: 'dangerous',
          fetchZipEnabled: false, dynamicMcpEnabled: false, webSearchEnabled: false, agentBrowserEnabled: false
        }
      },
      toolApprovalMode: 'none'
    } as any)
    // Wrapped as `vercelBrain.ts` hands every API tool to the SDK: its execute tracked under the run's Stop.
    const sdkTools = (new VercelAIBrain() as any).wrapToolsWithReadableModelOutput(tools, {
      userId: 'user-1', sessionId: session, messageId: 'm', agentId: AGENT, fetchZipAllowed: false
    })
    const stop = new AbortController()
    // The commands ignore SIGTERM, so only the SIGKILL 400 ms later ends them: an end slower than the wait below.
    const command = `apply_patch <<'PATCH'\n${patch('a.txt')}\nPATCH\ntrap '' TERM\ntouch started.txt\nsleep 30`
    const execution: Promise<unknown> = sdkTools.native_bash_execute.execute({ command }, { toolCallId: 'call_slow_end', abortSignal: stop.signal, messages: [] })
    async function* sdkStream() {
      yield { type: 'tool-call', toolCallId: 'call_slow_end', toolName: 'native_bash_execute', input: { command } }
      // The Stop lands once the commands run with SIGTERM ignored (the patch applied before them).
      while (!existsSync(path.join(root, 'started.txt'))) await new Promise((resolve) => setTimeout(resolve, 10))
      expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('new\n')
      stop.abort('user')
      // The SDK waits for the tool to settle, then ends the stream with `abort` and no result.
      await execution
      yield { type: 'abort', reason: 'user' }
    }
    // A 50 ms wait against a 400 ms end stands in for a sandbox end (up to 5 s) that outlasts the
    // real 3 s one.
    const parts: Array<Record<string, any>> = []
    for await (const part of withToolResultsOnStop(sdkStream(), stop.signal, { waitMs: 50 })) parts.push(part)
    const handedOn = parts.find((part) => part.type === 'tool-result')!
    expect(handedOn.output).toMatchObject({
      success: false, stopped: true, neverReturned: true, reason: STOPPED_WITHOUT_RESULT_REASON, command,
      managedApplyPatch: { applied: true, touchedPaths: ['a.txt'], afterPatch: { command: "trap '' TERM\ntouch started.txt\nsleep 30" } }
    })

    const [edit, tail, ...more] = await store(command, handedOn.output, 1)
    expect(more).toEqual([])
    expect(edit.operationKind).toBe('edit_file')
    expect(edit.payload.error).toBeUndefined()
    expect(edit.payload.toolResult.diff).toContain('+new')
    expect(edit.payload.toolResult.neverReturned).toBeUndefined()
    expect(tail.payload.toolArgs.command).toBe("trap '' TERM\ntouch started.txt\nsleep 30")
    // It returned no result: no output, and never "Never started" (it may have run).
    expect(tail.payload.toolResult).toMatchObject({ stdout: '', stderr: STOPPED_WITHOUT_RESULT_REASON })
    expect(tail.payload.error).toBe(STOPPED_WITHOUT_RESULT_REASON)
    expect(tail.reference).toMatch(/:::bash: trap '' TERM touch started\.txt sleep 30 - error - 1 line\}\}$/)
    // The ledger sees the edit: the read before it is stale.
    const dead = findDeadCopies([...ledger(read, 0), ...ledger([edit, tail], 1)], { projectPath: root })
    expect(dead.get(read[0].zipId)).toMatchObject({ reason: 'stale' })
    // The call itself settles once the Stop's kill lands; nothing else runs.
    await expect(execution).resolves.toMatchObject({ stopped: true, managedApplyPatch: { afterPatchStarted: true } })
  }, 20_000)

  it('a patch alone stays one ordinary zip', async () => {
    await writeFile(path.join(root, 'a.txt'), 'old\n')
    const command = `apply_patch <<'PATCH'\n${patch('a.txt')}\nPATCH`
    const stored = await store(command, await runBash(command), 1)
    expect(stored).toHaveLength(1)
    expect(stored[0].zip.metadata.shellReadSplitPart).toBeUndefined()
  })

  it('the compile shows the edit label and the test part, each with its own zip state', async () => {
    await writeFile(path.join(root, 'a.txt'), 'old\n')
    const command = `apply_patch <<'PATCH'\n${patch('a.txt')}\nPATCH\nnode -e "console.log('ran'); process.exit(2)"`
    const [edit, tail] = await store(command, await runBash(command), 1)
    const content = `${edit.reference}${tail.reference}`
    const zipResolver = async (zipId: string) => (await redis.json.get(`zip:${zipId}`)) as any
    const message = { id: 'msg_after_1', role: 'assistant', metadata: { zipIds: [edit.zipId, tail.zipId] } }

    // An old reply, past every buffer: both parts compressed to their labels.
    const compressed = await compileForAI(content, 0, 9, { buffer_size_edit_file: 1, buffer_size_execute_command: 1 }, message, {}, { zipResolver })
    expect(compressed).toContain(`{{batshit-zip:${edit.zipId}:::edit_file: a.txt -`)
    expect(compressed).toContain(`{{batshit-zip:${tail.zipId}:::`)
    expect(compressed).toMatch(new RegExp(`\\{\\{batshit-zip:${tail.zipId}:::bash: node -e .* - error - 1 line\\}\\}`))

    // The newest reply: both open, the diff and the run's output.
    const normal = {
      buffer_size_edit_file: 5, zip_threshold_edit_file: 0, auto_zip_edit_file: false,
      buffer_size_execute_command: 5, zip_threshold_execute_command: 0, auto_zip_execute_command: false
    }
    const open = await compileForAI(content, 8, 9, normal, message, {}, { zipResolver })
    expect(open).toContain('+new')
    expect(open).toContain('ran')
  })
})

describe('a partly written patch keeps the paths it left changed in the stored edit (BL-1916, SA-126 item 2)', () => {
  it('on a real API-lane payload, the ledger counts them as edited', async () => {
    await writeFile(path.join(root, 'a.txt'), 'old\n')
    await writeFile(path.join(root, 'b.txt'), 'old\n')
    const read = await store('cat a.txt', await runBash('cat a.txt'), 0)
    const command = `apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** Update File: b.txt\n@@\n-old\n+new\n*** End Patch\nPATCH`
    // b.txt fails, and putting a.txt back fails too: a.txt is left changed.
    let aWrites = 0
    writeFailure.when = (file) => {
      if (file.endsWith(`${path.sep}b.txt`)) return true
      if (file.endsWith(`${path.sep}a.txt`)) return ++aWrites > 1
      return false
    }
    const result = await runBash(command)
    expect(result.managedApplyPatch).toMatchObject({ partial: true })

    const [edit] = await store(command, result, 1)
    expect(edit.payload.error).toBeTruthy()
    expect(edit.payload.toolResult.managedApplyPatch).toMatchObject({ partial: true, changedPaths: expect.arrayContaining([expect.stringMatching(/a\.txt$/)]) })
    const dead = findDeadCopies([...ledger(read, 0), ...ledger([edit], 1)], { projectPath: await realpath(root) })
    expect(dead.get(read[0].zipId)).toMatchObject({ reason: 'stale' })
  })
})

describe('a shell edit or write cut before it finished keeps that fact in its stored card (BL-1979)', () => {
  // The cards (`EditFileRenderer`, `WriteFileRenderer`) read these facts to say the outcome is
  // unknown instead of "not applied": the command may have changed the file before it was cut.
  const stopAfter = (ms: number) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort('user'), ms)
    return controller.signal
  }

  it('a stopped in-place edit (this backend: the call returns, stopped)', async () => {
    await writeFile(path.join(root, 'x.js'), 'a\n')
    const command = "sed -i.bak 's/a/b/' x.js\nsleep 30"
    const result = await runBash(command, { abortSignal: stopAfter(400) })
    expect(result).toMatchObject({ stopped: true })
    // The edit ran before the Stop: the file changed, though the call failed.
    expect(await readFile(path.join(root, 'x.js'), 'utf8')).toBe('b\n')
    const [edit] = await store(command, result, 1)
    expect(edit.operationKind).toBe('edit_file')
    expect(edit.payload.toolResult).toMatchObject({ filePath: 'x.js', stopped: true })
    expect(edit.payload.toolResult.timedOut).toBeUndefined()
    // The model's view says the outcome is unknown, never that nothing was written.
    expect(buildCoolToolAiContent(edit.zipId, edit.zip, edit.payload)).toContain('Outcome: unknown; it was stopped before it finished, so the file may or may not have changed')
  })

  it('never for a command the Stop reached before it started: that one is known not applied', async () => {
    await writeFile(path.join(root, 'x.js'), 'a\n')
    const stop = new AbortController()
    stop.abort('user')
    const command = "sed -i.bak 's/a/b/' x.js"
    const result = await runBash(command, { abortSignal: stop.signal })
    expect(result).toMatchObject({ stopped: true, neverStarted: true })
    expect(await readFile(path.join(root, 'x.js'), 'utf8')).toBe('a\n')
    const [edit] = await store(command, result, 1)
    expect(edit.payload.toolResult.stopped).toBeUndefined()
    expect(buildCoolToolAiContent(edit.zipId, edit.zip, edit.payload)).not.toContain('Outcome: unknown')
  })

  it('never for an in-place edit after a patch that the Stop reached before it started (SA-126 item 2 part 1)', async () => {
    await writeFile(path.join(root, 'a.txt'), 'old\n')
    await writeFile(path.join(root, 'b.txt'), 'x\n')
    const controller = new AbortController()
    const command = `apply_patch <<'PATCH'\n${patch('a.txt')}\nPATCH\nsed -i.bak 's/x/y/' b.txt`
    writeFailure.when = (file) => {
      if (file.includes('a.txt')) queueMicrotask(() => controller.abort())
      return false
    }
    const result = await runBash(command, { abortSignal: controller.signal })
    expect(result).toMatchObject({ stopped: true, managedApplyPatch: { applied: true, afterPatchStarted: false } })
    expect(await readFile(path.join(root, 'b.txt'), 'utf8')).toBe('x\n')
    const [, tail] = await store(command, result, 1)
    expect(tail.operationKind).toBe('edit_file')
    expect(tail.payload.error).toBe('Never started: the reply was stopped after the patch applied.')
    // Known not applied: no cut facts, so the card says "Edit Not Applied", as before.
    expect(tail.payload.toolResult.stopped).toBeUndefined()
  })

  it('an in-place edit still running when the Stop rule ended the stream (a sandbox end)', async () => {
    const command = "sed -i.bak 's/a/b/' x.js\nsleep 30"
    const handedOn = { success: false, blocked: false, stopped: true, neverReturned: true, reason: STOPPED_WITHOUT_RESULT_REASON }
    const [edit] = await store(command, handedOn, 1)
    expect(edit.operationKind).toBe('edit_file')
    expect(edit.payload.toolResult).toMatchObject({ stopped: true, neverReturned: true })
    expect(edit.payload.error).toBe(STOPPED_WITHOUT_RESULT_REASON)
  })

  it('an in-place edit cut by its time limit', async () => {
    await writeFile(path.join(root, 'x.js'), 'a\n')
    const command = "sed -i.bak 's/a/b/' x.js\nsleep 30"
    const result = await runBash(command, { timeoutMs: 1_000 })
    expect(result).toMatchObject({ timedOut: true })
    const [edit] = await store(command, result, 1)
    expect(edit.payload.toolResult).toMatchObject({ timedOut: true })
    expect(edit.payload.toolResult.stopped).toBeUndefined()
  })

  it('a stopped redirect write', async () => {
    const command = 'echo hi > y.txt\nsleep 30'
    const result = await runBash(command, { abortSignal: stopAfter(400) })
    const [write] = await store(command, result, 1)
    expect(write.operationKind).toBe('write_file')
    expect(write.payload.toolResult).toMatchObject({ filePath: 'y.txt', stopped: true })
  })

  it('never for a shell edit that finished and failed, or a managed patch (written whole or not at all)', async () => {
    await writeFile(path.join(root, 'x.js'), 'a\n')
    const failed = await runBash("sed -i.bak 's/a/b' x.js")
    const [failedEdit] = await store("sed -i.bak 's/a/b' x.js", failed, 1)
    expect(failedEdit.payload.toolResult).toMatchObject({ exitCode: 1 })
    expect(failedEdit.payload.toolResult.stopped).toBeUndefined()

    // A managed patch the Stop reached before its write wrote nothing, and says so.
    const stop = new AbortController()
    stop.abort('user')
    const command = `apply_patch <<'PATCH'\n${patch('x.js', 'a', 'b')}\nPATCH`
    const stopped = await runBash(command, { abortSignal: stop.signal })
    expect(stopped).toMatchObject({ stopped: true })
    expect(await readFile(path.join(root, 'x.js'), 'utf8')).toBe('a\n')
    const [patchEdit] = await store(command, stopped, 2)
    expect(patchEdit.operationKind).toBe('edit_file')
    expect(patchEdit.payload.toolResult.stopped).toBeUndefined()
    expect(patchEdit.payload.toolResult.neverReturned).toBeUndefined()
  })
})

async function mkdirp(dir: string) {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
}
