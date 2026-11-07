// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { adaptCoolToolsToZipSystem, refreshedTypedReadTranscript } from '../coolToolZipAdapter'
import { normalizeToolArgs } from '../services/sseToolNormalization'
import { STOPPED_WITHOUT_RESULT_REASON } from '../services/lateToolResults'
import {
  buildTypedFileTools,
  typedEditFile,
  typedReadFile,
  typedWriteFile,
  type TypedFileEnvironment
} from '../services/typedFileTools'
import { toolStepFailureMessage } from '$lib/utils/toolResultProcessor'
import { buildCoolToolAiContent, parseCoolToolPayload } from '$lib/utils/coolToolAiContent'
import { describeToolResultFiles, findDeadCopies, type DeadCopyToolResult } from '$lib/utils/zipDeadCopies'
import { readFileReadSource } from '$lib/utils/fileReadSource'
import { collectDeadCopyToolResults, compileForAI } from '$lib/services/messageCompiler'
import { createZipStateView } from '$lib/services/zipping'
import { fetchZipForModel } from '../services/fetchZipForModel'

/**
 * SA-136 P2 (V4): what the zip system stores for the typed file tools. Every result comes from the
 * REAL tool on a real folder, becomes the step send-routed's `case 'tool-result'` builds for a
 * non-Bash API tool (`normalizeToolArgs`; no mapping), and is stored by the REAL zip adapter in
 * Redis. The frozen blocks must come back as written; the AI view, the step error and the
 * dead-copy ledger read what was stored. A reply stopped while a call ran is stored from the part
 * BL-1959/1978 hands on: the call's last report plus the stopped-with-no-result fields.
 */

useRedisTestServer()

const AGENT = 'agent-typed-files'
let root = ''
let session = ''
let counter = 0

beforeEach(async () => {
  counter += 1
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'batshit-typed-zips-')))
  session = `typed-files-${counter}-${Date.now()}`
  await redis.createSession({ id: session, user_id: 'user-1', title: 'Typed files', agent_id: AGENT } as any)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const env = (extra: Partial<TypedFileEnvironment> = {}): TypedFileEnvironment => ({ workspaceRoot: root, cwd: root, accessMode: 'agent', commandBackend: 'local', ...extra })

/** send-routed's `stepForZip` and the saved step's error for a non-Bash API tool result. */
function apiStep(toolName: string, input: Record<string, unknown>, result: unknown, toolCallId?: string) {
  const args = normalizeToolArgs(input)
  counter += 1
  return {
    step: {
      toolName,
      originalToolName: toolName,
      toolInput: args,
      toolArgs: args,
      toolResult: result,
      toolCallId: toolCallId ?? `call_typed_${counter}`,
      timestamp: new Date().toISOString(),
      metadata: { sessionId: session }
    },
    stepError: toolStepFailureMessage(toolName, args, result)
  }
}

async function store(toolName: string, input: Record<string, unknown>, result: unknown, messageIndex: number, toolCallId?: string) {
  const { step, stepError } = apiStep(toolName, input, result, toolCallId)
  const refs = await adaptCoolToolsToZipSystem([step], session, `msg_typed_${messageIndex}`, {}, undefined)
  expect(refs).toHaveLength(1)
  const zip = (await redis.json.get(`zip:${refs[0].zipId}`)) as any
  return {
    zipId: refs[0].zipId!,
    reference: refs[0].reference as string,
    zip,
    stepError,
    operationKind: (zip?.metadata?.operationKind ?? null) as string | null,
    payload: (parseCoolToolPayload(zip?.content) ?? {}) as Record<string, any>
  }
}

const ledger = (entry: { zipId: string; operationKind: string | null; payload: any }, messageIndex: number): DeadCopyToolResult => ({
  zipId: entry.zipId,
  authorId: AGENT,
  messageIndex,
  operationKind: entry.operationKind,
  payload: entry.payload
})

/** The part BL-1959 hands on for a call still running when the Stop ended the stream. */
const neverReturned = (reported: Record<string, unknown> | undefined) => ({
  ...reported,
  success: false,
  blocked: false,
  stopped: true,
  neverReturned: true,
  reason: STOPPED_WITHOUT_RESULT_REASON
})

describe('typed reads keep their frozen block (SA-136 D5)', () => {
  it('a whole read: the block comes back as written, the label, the AI view and the ledger', async () => {
    await writeFile(path.join(root, 'a.ts'), 'one\ntwo\nthree\n')
    const result = await typedReadFile({ path: 'a.ts' }, env())
    const stored = await store('read_file', { path: 'a.ts' }, result, 0)
    expect(stored.operationKind).toBe('read_file')
    expect(stored.stepError).toBeUndefined()
    expect(stored.payload.error).toBeUndefined()
    expect(stored.payload.toolResult.typedFileRead).toEqual(result.typedFileRead)
    expect(stored.payload.toolResult).toMatchObject({ filePath: 'a.ts', lineCount: 3 })
    expect(stored.reference).toMatch(/:::read_file: a\.ts - 3 lines\}\}$/)
    expect(buildCoolToolAiContent(stored.zipId, stored.zip, stored.payload)).toContain('Lines: 1–3 of 3')
    expect(describeToolResultFiles(stored, { projectPath: root })).toEqual({ kind: 'read', files: new Map([['a.ts', 'whole']]) })
  })

  it('a range read: the block keeps the range and the total; the ledger keeps it partial', async () => {
    await writeFile(path.join(root, 'b.ts'), Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n'))
    const result = await typedReadFile({ path: 'b.ts', offset: 4, limit: 3 }, env())
    const stored = await store('read_file', { path: 'b.ts', offset: 4, limit: 3 }, result, 0)
    expect(stored.payload.toolResult.typedFileRead).toMatchObject({ startLine: 4, endLine: 6, totalLines: 10, whole: false })
    expect(buildCoolToolAiContent(stored.zipId, stored.zip, stored.payload)).toContain('Lines: 4–6 of 10')
    expect(describeToolResultFiles(stored, { projectPath: root })).toEqual({ kind: 'read', files: new Map([['b.ts', 'partial']]) })
  })

  it('a forged block with an impossible whole read is dropped, not kept', async () => {
    const forged = {
      success: true,
      tool: 'read_file',
      path: 'c.ts',
      filePath: 'c.ts',
      content: 'x\n',
      typedFileRead: { v: 1, startLine: 2, endLine: 3, totalLines: 3, whole: true, truncated: false, empty: false, bytes: 2, lineEnding: 'lf' }
    }
    const stored = await store('read_file', { path: 'c.ts' }, forged, 0)
    expect(stored.payload.toolResult.typedFileRead).toBeUndefined()
  })
})

describe('typed edits and writes: applied, unapplied, stopped (SA-136 D5, D6)', () => {
  it('a concise SDK edit reply keeps the diff for the card, Fetch Zip and later history, and makes the earlier read stale', async () => {
    await writeFile(path.join(root, 'a.ts'), 'old\nstay\nend')
    const read = await store('read_file', { path: 'a.ts' }, await typedReadFile({ path: 'a.ts' }, env()), 0)
    const input = { path: 'a.ts', edits: [{ oldText: 'old', newText: 'new' }, { oldText: 'end', newText: 'END' }] }
    const tools = buildTypedFileTools({ accessMode: 'agent', resolveEnvironment: async () => env() })
    const result = await tools.edit_file.execute(input, { toolCallId: 'edit-confirmation', messages: [] })
    const richResult = JSON.stringify(result)
    expect(await tools.edit_file.toModelOutput({ output: result })).toEqual({
      type: 'text', value: 'edit_file: a.ts: 2 edits applied; it has 3 lines now.'
    })
    const edit = await store('edit_file', input, result, 1)
    expect(edit.operationKind).toBe('edit_file')
    expect(edit.stepError).toBeUndefined()
    expect(edit.payload.error).toBeUndefined()
    expect(edit.payload.toolResult.typedFileEdit).toEqual(result.typedFileEdit)
    expect(result.diff).toContain('+   1 | new')
    expect(result.diff).toContain('+   3 | END')
    expect(edit.payload.toolResult.diff).toBe(result.diff)
    expect(buildCoolToolAiContent(edit.zipId, edit.zip, edit.payload)).toContain(result.diff)
    const fetched = await fetchZipForModel({ userId: 'user-1', sessionId: session, agentId: AGENT }, { zipId: edit.zipId })
    expect(fetched.found).toBe(true)
    expect(parseCoolToolPayload(fetched.content)?.toolResult.diff).toBe(result.diff)
    const compiled = await compileForAI(edit.reference, 0, 1, {}, { metadata: { zipIds: [edit.zipId] } }, {}, {
      zipResolver: async (id) => await redis.json.get(`zip:${id}`) as any,
      // Edits auto-zip by default; expose this saved result through the existing user Hold.
      zipState: createZipStateView([{ zipId: edit.zipId, sessionId: session, permanent: true, unzippedAt: 0, source: 'user' }]),
      zipViewMode: 'inline'
    })
    expect(compiled).toContain(result.diff)
    expect(JSON.stringify(result)).toBe(richResult)
    expect(edit.reference).toMatch(/:::edit_file: a\.ts - \d+ lines\}\}$/)
    const dead = findDeadCopies([ledger(read, 0), ledger(edit, 1)], { projectPath: root })
    expect(dead.get(read.zipId)).toMatchObject({ reason: 'stale' })
  })

  it('a refused edit wrote nothing: a failed step, no edit for the ledger, no "unknown"', async () => {
    await writeFile(path.join(root, 'a.ts'), 'x\nx\n')
    const read = await store('read_file', { path: 'a.ts' }, await typedReadFile({ path: 'a.ts' }, env()), 0)
    const result = await typedEditFile({ path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }] }, env())
    const edit = await store('edit_file', { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }] }, result, 1)
    expect(edit.stepError).toBe(result.reason)
    expect(edit.payload.error).toBe(result.reason)
    expect(edit.payload.toolResult.typedFileEdit).toEqual({ v: 1, outcome: 'unapplied' })
    expect(edit.payload.toolResult.stopped).toBeUndefined()
    expect(describeToolResultFiles(edit, { projectPath: root })).toEqual({ kind: 'none' })
    expect(findDeadCopies([ledger(read, 0), ledger(edit, 1)], { projectPath: root }).size).toBe(0)
    expect(buildCoolToolAiContent(edit.zipId, edit.zip, edit.payload)).not.toContain('Outcome: unknown')
  })

  it('a write the Stop reached before its rename stays "not written", never "unknown"', async () => {
    const stop = new AbortController()
    stop.abort()
    const result = await typedWriteFile({ path: 'n.ts', content: 'x' }, env({ abortSignal: stop.signal }))
    const write = await store('write_file', { path: 'n.ts', content: 'x' }, result, 0)
    expect(write.payload.toolResult.typedFileWrite).toEqual({ v: 1, outcome: 'unapplied' })
    expect(write.payload.toolResult.stopped).toBeUndefined()
    expect(buildCoolToolAiContent(write.zipId, write.zip, write.payload)).not.toContain('Outcome: unknown')
  })

  it('a call stopped after its rename is stored as applied (its applied report), not as "no result"', async () => {
    await writeFile(path.join(root, 'a.ts'), 'old\n')
    const read = await store('read_file', { path: 'a.ts' }, await typedReadFile({ path: 'a.ts' }, env()), 0)
    const reports: Record<string, unknown>[] = []
    await typedEditFile({ path: 'a.ts', edits: [{ oldText: 'old', newText: 'new' }] }, env({ onProgress: (facts) => reports.push(facts) }))
    expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toBe('new\n')
    const part = neverReturned(Object.assign({}, ...reports))
    const edit = await store('edit_file', { path: 'a.ts', edits: [{ oldText: 'old', newText: 'new' }] }, part, 1)
    expect(edit.stepError).toBeUndefined()
    expect(edit.payload.error).toBeUndefined()
    expect(edit.payload.toolResult.typedFileEdit).toMatchObject({ outcome: 'applied' })
    expect(edit.payload.toolResult.stopped).toBeUndefined()
    expect(edit.payload.toolResult.diff).toContain('+   1 | new')
    expect(findDeadCopies([ledger(read, 0), ledger(edit, 1)], { projectPath: root }).get(read.zipId)).toMatchObject({ reason: 'stale' })
  })

  it('a call whose last report is "committing" is unknown: the card facts, the AI view, and the ledger retires', async () => {
    await writeFile(path.join(root, 'a.ts'), 'old\n')
    const read = await store('read_file', { path: 'a.ts' }, await typedReadFile({ path: 'a.ts' }, env()), 0)
    const reports: Record<string, unknown>[] = []
    await typedEditFile({ path: 'a.ts', edits: [{ oldText: 'old', newText: 'new' }] }, env({ onProgress: (facts) => reports.push(facts) }))
    const part = neverReturned(reports[0])
    const edit = await store('edit_file', { path: 'a.ts', edits: [{ oldText: 'old', newText: 'new' }] }, part, 1)
    expect(edit.payload.error).toBe(STOPPED_WITHOUT_RESULT_REASON)
    expect(edit.payload.toolResult).toMatchObject({ stopped: true, neverReturned: true, typedFileEdit: { outcome: 'unknown', stage: 'committing' } })
    expect(buildCoolToolAiContent(edit.zipId, edit.zip, edit.payload)).toContain('Outcome: unknown')
    expect(findDeadCopies([ledger(read, 0), ledger(edit, 1)], { projectPath: root }).get(read.zipId)).toMatchObject({ reason: 'stale' })
  })
})

describe("a Primary typed read's sealed proof (SA-136 P2b, on SA-137's writer rule)", () => {
  /** The proof's owner, bound to the chat, the reply `store` writes and this call. */
  const owner = (messageIndex: number, toolCallId: string) => ({
    userId: 'user-1', agentId: AGENT, sessionId: session, messageId: `msg_typed_${messageIndex}`, toolCallId
  })
  const ledgerOf = (entry: { zipId: string; operationKind: string | null; payload: any; zip: any }, messageIndex: number): DeadCopyToolResult => ({
    ...ledger(entry, messageIndex),
    fileReadSource: readFileReadSource(entry.zip?.metadata?.fileReadSource)
  })

  it("becomes the zip's fileReadSource with a typed view, and the proof itself is never stored", async () => {
    await writeFile(path.join(root, 'a.ts'), 'one\ntwo\n')
    const result = await typedReadFile({ path: 'a.ts' }, env({ readProofOwner: owner(0, 'call_proof_a') }))
    expect(result.fileReadProof).toBeDefined()
    const stored = await store('read_file', { path: 'a.ts' }, result, 0, 'call_proof_a')
    expect(readFileReadSource(stored.zip.metadata.fileReadSource)).toMatchObject({
      backend: 'local', cwd: root, locator: 'a.ts', view: { kind: 'typed', startLine: 1, endLine: null },
      owner: { sessionId: session, messageId: 'msg_typed_0', toolCallId: 'call_proof_a', agentId: AGENT }
    })
    expect(JSON.stringify(stored.zip)).not.toContain('fileReadProof')
    expect(stored.payload.toolResult.fileReadProof).toBeUndefined()
  })

  it.each([
    { backend: 'local', liveReadsOn: false },
    { backend: 'apple_container', liveReadsOn: false },
    { backend: 'apple_container', liveReadsOn: true },
    { backend: 'docker_sandbox', liveReadsOn: false },
    { backend: 'docker_sandbox', liveReadsOn: true }
  ] as const)('keeps a proven large whole read whole: $backend, refresh $liveReadsOn', async ({ backend, liveReadsOn }) => {
    await writeFile(path.join(root, 'long.txt'), Array.from({ length: 2_500 }, (_, i) => `l${i}`).join('\n'))
    const older = await store('read_file', { path: 'long.txt' }, await typedReadFile({ path: 'long.txt' }, env({ commandBackend: backend, liveReadsOn, readProofOwner: owner(0, 'call_long_1') })), 0, 'call_long_1')
    const newer = await store('read_file', { path: 'long.txt' }, await typedReadFile({ path: 'long.txt' }, env({ commandBackend: backend, liveReadsOn, readProofOwner: owner(1, 'call_long_2') })), 1, 'call_long_2')
    expect(readFileReadSource(newer.zip.metadata.fileReadSource)).toMatchObject({ backend, liveReadsOn })
    expect(describeToolResultFiles(ledgerOf(newer, 1), { projectPath: root })).toEqual({ kind: 'read', files: new Map([['long.txt', 'whole']]) })
    expect(describeToolResultFiles(ledger(newer, 1), { projectPath: root })).toEqual({ kind: 'read', files: new Map([['long.txt', 'partial']]) })
    expect(findDeadCopies([ledgerOf(older, 0), ledgerOf(newer, 1)], { projectPath: root }).get(older.zipId)).toMatchObject({ reason: 'superseded' })
  })

  it.each(['local', 'apple_container', 'docker_sandbox'] as const)('keeps a %s range read partial through its descriptor', async (backend) => {
    await writeFile(path.join(root, 'b.ts'), Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n'))
    const stored = await store('read_file', { path: 'b.ts', offset: 4, limit: 3 }, await typedReadFile({ path: 'b.ts', offset: 4, limit: 3 }, env({ commandBackend: backend, readProofOwner: owner(0, 'call_range') })), 0, 'call_range')
    expect(readFileReadSource(stored.zip.metadata.fileReadSource)?.view).toEqual({ kind: 'typed', startLine: 4, endLine: 6 })
    expect(describeToolResultFiles(ledgerOf(stored, 0), { projectPath: root })).toEqual({ kind: 'read', files: new Map([['b.ts', 'partial']]) })
    // A range from line 1 is a part too, even one that happened to reach the end of the file.
    const fromStart = await store('read_file', { path: 'b.ts', offset: 1, limit: 50 }, await typedReadFile({ path: 'b.ts', offset: 1, limit: 50 }, env({ commandBackend: backend, readProofOwner: owner(1, 'call_start') })), 1, 'call_start')
    expect(readFileReadSource(fromStart.zip.metadata.fileReadSource)?.view).toEqual({ kind: 'typed', startLine: 1, endLine: 50 })
    expect(describeToolResultFiles(ledgerOf(fromStart, 1), { projectPath: root })).toEqual({ kind: 'read', files: new Map([['b.ts', 'partial']]) })
  })

  it('writes no descriptor for a broken seal or a proof bound to another call, and strips it all the same', async () => {
    await writeFile(path.join(root, 'c.ts'), 'x\n')
    const result = await typedReadFile({ path: 'c.ts' }, env({ readProofOwner: owner(0, 'call_c') }))
    const forged = { ...result, fileReadProof: { ...result.fileReadProof, seal: 'A'.repeat(43) } }
    const one = await store('read_file', { path: 'c.ts' }, forged, 0, 'call_c')
    expect(one.zip.metadata.fileReadSource).toBeUndefined()
    expect(JSON.stringify(one.zip)).not.toContain('fileReadProof')
    const other = await store('read_file', { path: 'c.ts' }, result, 0, 'call_someone_else')
    expect(other.zip.metadata.fileReadSource).toBeUndefined()
  })

  it('does not stamp an Apple read whose sealed backend or read-time setting was replaced', async () => {
    await writeFile(path.join(root, 'sealed.ts'), 'x\n')
    const result = await typedReadFile({ path: 'sealed.ts' }, env({ commandBackend: 'apple_container', liveReadsOn: true, readProofOwner: owner(0, 'call_apple_seal') }))
    expect(result.fileReadProof).toMatchObject({ backend: 'apple_container', liveReadsOn: true })
    for (const changed of [{ backend: 'local' }, { liveReadsOn: false }]) {
      const forged = { ...result, fileReadProof: { ...result.fileReadProof, ...changed } }
      const stored = await store('read_file', { path: 'sealed.ts' }, forged, 0, 'call_apple_seal')
      expect(stored.zip.metadata.fileReadSource).toBeUndefined()
      expect(JSON.stringify(stored.zip)).not.toContain('fileReadProof')
    }
  })

  it.each(['local', 'apple_container', 'docker_sandbox'] as const)("counts a %s proof only on the exact registered name", async (backend) => {
    await writeFile(path.join(root, 'f.ts'), 'x\n')
    const result = await typedReadFile({ path: 'f.ts' }, env({ commandBackend: backend, readProofOwner: owner(0, 'call_other') }))
    const stored = await store('batshit_server_read_file', { path: 'f.ts' }, result, 0, 'call_other')
    expect(stored.operationKind).toBe('read_file')
    expect(stored.zip.metadata.fileReadSource).toBeUndefined()
  })

  it.each(['local', 'apple_container', 'docker_sandbox'] as const)('keeps a cut %s typed read partial, with or without a proof', async (backend) => {
    // A whole copy first (with its proof), then the file grows to 1,000 lines of 100 characters:
    // the 90,000 cap shows 900 lines, under the 2,000-line rule.
    await writeFile(path.join(root, 'wide.txt'), 'small\n')
    const whole = await store('read_file', { path: 'wide.txt' }, await typedReadFile({ path: 'wide.txt' }, env({ commandBackend: backend, readProofOwner: owner(0, 'call_small') })), 0, 'call_small')
    expect(describeToolResultFiles(ledgerOf(whole, 0), { projectPath: root })).toEqual({ kind: 'read', files: new Map([['wide.txt', 'whole']]) })
    await writeFile(path.join(root, 'wide.txt'), `${'x'.repeat(99)}\n`.repeat(1_000))
    const cut = await store('read_file', { path: 'wide.txt' }, await typedReadFile({ path: 'wide.txt' }, env({ commandBackend: backend, readProofOwner: owner(1, 'call_wide') })), 1, 'call_wide')
    expect(cut.payload.toolResult.typedFileRead).toMatchObject({ truncated: true, whole: false, endLine: 900 })
    expect(cut.zip.metadata.fileReadSource).toBeUndefined()
    expect(describeToolResultFiles(ledgerOf(cut, 1), { projectPath: root })).toEqual({ kind: 'read', files: new Map([['wide.txt', 'partial']]) })
    // One line longer than the cap: only its start is shown.
    await writeFile(path.join(root, 'one.txt'), `${'y'.repeat(95_000)}\n`)
    const long = await store('read_file', { path: 'one.txt' }, await typedReadFile({ path: 'one.txt' }, env()), 2)
    expect(long.payload.toolResult.partialLine).toBe(true)
    expect(describeToolResultFiles(ledgerOf(long, 2), { projectPath: root })).toEqual({ kind: 'read', files: new Map([['one.txt', 'partial']]) })
    expect(findDeadCopies([ledgerOf(whole, 0), ledgerOf(cut, 1)], { projectPath: root }).size).toBe(0)
  })

  it('makes no proof without an owner (a delegated run) or for a cut read', async () => {
    await writeFile(path.join(root, 'd.ts'), 'x\n')
    expect((await typedReadFile({ path: 'd.ts' }, env())).fileReadProof).toBeUndefined()
    await writeFile(path.join(root, 'big.txt'), `${'x'.repeat(99)}\n`.repeat(1_000))
    expect((await typedReadFile({ path: 'big.txt' }, env({ readProofOwner: owner(0, 'call_big') }))).fileReadProof).toBeUndefined()
    expect((await typedReadFile({ path: 'd.ts', offset: 9 }, env({ readProofOwner: owner(0, 'call_past') }))).fileReadProof).toBeUndefined()
  })

  it('records whether live file reads were on when the read ran (SA-137: only an ON read refreshes)', async () => {
    await writeFile(path.join(root, 'g.ts'), 'x\n')
    const on = await store('read_file', { path: 'g.ts' }, await typedReadFile({ path: 'g.ts' }, env({ readProofOwner: owner(0, 'call_on'), liveReadsOn: true })), 0, 'call_on')
    const off = await store('read_file', { path: 'g.ts' }, await typedReadFile({ path: 'g.ts' }, env({ readProofOwner: owner(1, 'call_off') })), 1, 'call_off')
    expect(readFileReadSource(on.zip.metadata.fileReadSource)?.liveReadsOn).toBe(true)
    expect(readFileReadSource(off.zip.metadata.fileReadSource)?.liveReadsOn).toBe(false)
  })

  it('SA-137: a refreshed typed copy reads exactly as a fresh call with the same arguments on the changed file', async () => {
    const cases: Array<{ name: string; before: string; after: string; input: Record<string, unknown> }> = [
      { name: 'w.ts', before: 'a\nb\n', after: 'a\nb\nc\nd\n', input: { path: 'w.ts' } },
      { name: 'r.ts', before: 'l1\nl2\nl3\nl4\nl5\n', after: 'L1\nL2\nL3\nL4\nL5\nL6\n', input: { path: 'r.ts', offset: 2, limit: 3 } },
      { name: 'crlf.txt', before: 'one\r\ntwo\r\n', after: 'one\r\nTWO\r\nthree', input: { path: 'crlf.txt' } },
      { name: 'bom.txt', before: '\ufeffold\n', after: '\ufeffnew\nmore\n', input: { path: 'bom.txt' } },
      { name: 'tail.ts', before: 'x\ny\nz\n', after: 'x\ny\nz\nw\n', input: { path: 'tail.ts', offset: 3 } }
    ]
    let index = 0
    for (const { name, before, after, input } of cases) {
      index += 1
      await writeFile(path.join(root, name), before)
      const callId = `call_refresh_${index}`
      const stored = await store('read_file', input, await typedReadFile(input as any, env({ readProofOwner: owner(index, callId), liveReadsOn: true })), index, callId)
      await writeFile(path.join(root, name), after)
      const view = readFileReadSource(stored.zip.metadata.fileReadSource)!.view
      const refreshed = refreshedTypedReadTranscript(stored.zipId, stored.payload, stored.zip.metadata, await readFile(path.join(root, name), 'utf8'), view)
      const fresh = await store('read_file', input, await typedReadFile(input as any, env()), index + 100, callId)
      const expected = buildCoolToolAiContent(stored.zipId, { ...fresh.zip, metadata: stored.zip.metadata }, fresh.payload)
      expect(refreshed?.text, name).toBe(expected)
      expect(refreshed?.text, name).not.toBe(buildCoolToolAiContent(stored.zipId, stored.zip, stored.payload))
    }
  })

  it('SA-137: no refreshed typed transcript for bytes read_file refuses, a range now cut or past the end, or arguments that disagree with the view', async () => {
    await writeFile(path.join(root, 'h.ts'), 'x\n')
    const stored = await store('read_file', { path: 'h.ts' }, await typedReadFile({ path: 'h.ts' }, env({ readProofOwner: owner(0, 'call_h'), liveReadsOn: true })), 0, 'call_h')
    const view = readFileReadSource(stored.zip.metadata.fileReadSource)!.view
    const refresh = (text: string, payload = stored.payload, at = view) => refreshedTypedReadTranscript(stored.zipId, payload, stored.zip.metadata, text, at)
    expect(refresh('y\n')).not.toBeNull()
    expect(refresh('a\u0000b\n')).toBeNull()
    expect(refresh(`${'x'.repeat(99)}\n`.repeat(1_000))).toBeNull()
    expect(refresh(`${'y'.repeat(95_000)}\n`)).toBeNull()
    // Not the typed tool's own copy: the Bash builder owns it, this one never does.
    expect(refresh('x\n', { ...stored.payload, originalToolName: 'native_bash_execute' })).toBeNull()
    // The stored arguments must give exactly the view the proof recorded.
    expect(refresh('a\nb\nc\n', { ...stored.payload, toolArgs: { ...stored.payload.toolArgs, offset: 2 } })).toBeNull()
    expect(refresh('a\nb\nc\n', { ...stored.payload, toolArgs: { ...stored.payload.toolArgs, offset: '2' } }, { kind: 'typed', startLine: 2, endLine: null })).toBeNull()
    expect(refresh('a\nb\nc\n', stored.payload, { kind: 'typed', startLine: 1, endLine: 2 })).toBeNull()
    expect(refresh('a\nb\nc\n', stored.payload, { kind: 'whole', numbering: 'none' })).toBeNull()

    // A range read whose file shrank so the range starts past its end: a fresh call says "no lines", never proven.
    await writeFile(path.join(root, 'p.ts'), 'l1\nl2\nl3\nl4\nl5\n')
    const range = await store('read_file', { path: 'p.ts', offset: 4, limit: 2 }, await typedReadFile({ path: 'p.ts', offset: 4, limit: 2 }, env({ readProofOwner: owner(1, 'call_p'), liveReadsOn: true })), 1, 'call_p')
    const rangeView = readFileReadSource(range.zip.metadata.fileReadSource)!.view
    expect(refreshedTypedReadTranscript(range.zipId, range.payload, range.zip.metadata, 'L1\nL2\nL3\nL4\n', rangeView)).not.toBeNull()
    expect(refreshedTypedReadTranscript(range.zipId, range.payload, range.zip.metadata, 'L1\nL2\n', rangeView)).toBeNull()
  })

  it("reaches the compile's ledger list through collectDeadCopyToolResults", async () => {
    await writeFile(path.join(root, 'e.ts'), 'x\n')
    const stored = await store('read_file', { path: 'e.ts' }, await typedReadFile({ path: 'e.ts' }, env({ readProofOwner: owner(0, 'call_e') })), 0, 'call_e')
    const message = { role: 'assistant', agent_id: AGENT, content: stored.reference, metadata: { zipIds: [stored.zipId] } }
    const { results } = await collectDeadCopyToolResults([message], async (zipId) => (await redis.json.get(`zip:${zipId}`)) as any)
    expect(results).toHaveLength(1)
    expect(results[0].fileReadSource?.view).toEqual({ kind: 'typed', startLine: 1, endLine: null })
  })
})
