// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { adaptCoolToolsToZipSystem } from '../coolToolZipAdapter'
import { applyAgentHoldChanges } from '../services/zipHolds'
import { resolveSessionZipForHold } from '../services/resolveSessionZipForHold'
import { parseCoolToolPayload } from '$lib/utils/coolToolAiContent'
import {
  describeToolResultFiles,
  findDeadCopies,
  newestWholeReadsByFile,
  type DeadCopyToolResult
} from '$lib/utils/zipDeadCopies'
import {
  FILESYSTEM_MCP_READ_RESULTS,
  filesystemMcpWholeRead,
  gatewayReadStep
} from '$lib/test-utils/gateway-read-steps'

/**
 * BL-418 (Faye's decision, 2026-09-27): a gateway MCP `read_file` is a whole read for the dead-copy
 * ledger and holds when its STORED result carries the path and the whole file; otherwise it stays
 * unknown. Every payload here is stored by the real zip adapter from the real server's answers
 * (`gateway-read-steps.ts`), so a change in what the adapter keeps shows up here.
 */

useRedisTestServer()

const PROJECT = '/work/proj'
const FILE = '/work/proj/notes.txt'
/** The ledger's key for FILE: relative to the chat's project, as for every other read. */
const KEY = 'notes.txt'
const AGENT = 'agent-gateway'
let SESSION = ''
let counter = 0

beforeEach(async () => {
  counter += 1
  SESSION = `gateway-read-${counter}-${Date.now()}`
  await redis.createSession({ id: SESSION, user_id: 'user-1', title: 'Gateway reads', agent_id: AGENT } as any)
  // BL-606: the hold step refuses an agent whose record is gone, so the holder must exist.
  await redis.createAgent({ id: AGENT, user_id: 'user-1', name: 'Gateway', displayName: 'Gateway' } as any)
})

interface StoredRead {
  zipId: string
  reference: string
  operationKind: string | null
  payload: Record<string, any>
}

async function storeGatewayRead(
  input: Record<string, unknown>,
  result: unknown,
  toolName = 'read_file',
  zipId?: string
): Promise<StoredRead> {
  return storeGatewayCall({ ref: `mcp:${toolName}`, input }, result, toolName, zipId)
}

/**
 * `call` is the model's whole `native_batshit_tool_use` input: top-level keys, `params`, `input`.
 * `zipId`, when given, is the id the zip is stored under (the adapter's reserved-id path), so a
 * test can fix the random tail of `cool_tool_<ms>_<tail>` instead of leaving it to chance.
 */
async function storeGatewayCall(
  call: Record<string, unknown>,
  result: unknown,
  toolName = 'read_file',
  zipId?: string
): Promise<StoredRead> {
  counter += 1
  const step = gatewayReadStep({ call, result, toolName, sessionId: SESSION })
  const [created] = await adaptCoolToolsToZipSystem(
    [step],
    SESSION,
    `msg_gateway_${counter}`,
    {},
    undefined,
    zipId ? { reservedZipIdsByToolCallId: { [step.toolCallId]: zipId } } : {}
  )
  const zip = (await redis.json.get(`zip:${created.zipId}`)) as any
  return {
    zipId: created.zipId,
    reference: created.reference,
    operationKind: zip?.metadata?.operationKind ?? null,
    payload: parseCoolToolPayload(zip?.content) ?? {}
  }
}

function asLedgerResult(stored: StoredRead, messageIndex: number, authorId = AGENT): DeadCopyToolResult {
  return { zipId: stored.zipId, authorId, messageIndex, operationKind: stored.operationKind, payload: stored.payload }
}

function nativeRead(path: string, messageIndex: number): DeadCopyToolResult {
  return {
    zipId: `cool_tool_1790500000000_native${messageIndex}`,
    authorId: AGENT,
    messageIndex,
    operationKind: 'read_file',
    payload: { operationKind: 'read_file', toolArgs: { filePath: path }, toolResult: { filePath: path, content: 'body', lineCount: 5 } }
  }
}

function nativeEdit(path: string, messageIndex: number): DeadCopyToolResult {
  return {
    zipId: `cool_tool_1790500000000_edit${messageIndex}`,
    authorId: AGENT,
    messageIndex,
    operationKind: 'edit_file',
    payload: { operationKind: 'edit_file', toolArgs: { filePath: path }, toolResult: { filePath: path, diff: '+x' } }
  }
}

const describeFiles = (stored: StoredRead) =>
  describeToolResultFiles({ operationKind: stored.operationKind, payload: stored.payload }, { projectPath: PROJECT })

describe('a gateway MCP read_file in the dead-copy ledger (BL-418)', () => {
  it('is stored the way the live run stored it', async () => {
    const stored = await storeGatewayRead({ path: FILE }, FILESYSTEM_MCP_READ_RESULTS.whole)
    expect(stored.operationKind).toBe('dynamic_use')
    expect(stored.payload.toolName).toBe('read_file')
    expect(stored.reference).toMatch(/:::dynamic_use: read_file - success - \d+ lines\}\}$/)
  })

  it('a whole read of an absolute path is a whole read of that file', async () => {
    const stored = await storeGatewayRead({ path: FILE }, FILESYSTEM_MCP_READ_RESULTS.whole)
    expect(describeFiles(stored)).toEqual({ kind: 'read', files: new Map([[KEY, 'whole']]) })
  })

  it('read_text_file, the same tool under its new name, counts the same', async () => {
    const stored = await storeGatewayRead({ path: FILE }, FILESYSTEM_MCP_READ_RESULTS.whole, 'read_text_file')
    expect(describeFiles(stored)).toEqual({ kind: 'read', files: new Map([[KEY, 'whole']]) })
  })

  it('head and tail reads stay unknown, and so does head 0, which the server reads whole', async () => {
    for (const [input, result] of [
      [{ path: FILE, head: 2 }, FILESYSTEM_MCP_READ_RESULTS.head2],
      [{ path: FILE, tail: 2 }, FILESYSTEM_MCP_READ_RESULTS.tail2],
      [{ path: FILE, head: 0 }, FILESYSTEM_MCP_READ_RESULTS.head0]
    ] as const) {
      const stored = await storeGatewayRead(input, result)
      expect(describeFiles(stored), JSON.stringify(input)).toEqual({ kind: 'unknown_read' })
    }
  })

  it('counts only when the tool\'s own arguments are exactly { path }, wherever the model put it', async () => {
    const whole = FILESYSTEM_MCP_READ_RESULTS.whole
    // The broker hands the tool top level, then params, then input (later wins); `ref` is its own.
    for (const call of [
      { ref: 'mcp:read_file', path: FILE },
      { ref: 'mcp:read_file', params: { path: FILE } },
      { ref: 'mcp:read_file', path: FILE, params: { path: FILE } },
      { ref: 'mcp:read_file', input: { path: FILE }, params: { path: FILE } }
    ]) {
      const stored = await storeGatewayCall(call, whole)
      expect(describeFiles(stored), JSON.stringify(call)).toEqual({ kind: 'read', files: new Map([[KEY, 'whole']]) })
    }
  })

  it('stays unknown for any other argument, a range in params, or a path it cannot be sure of (review cases)', async () => {
    const whole = FILESYSTEM_MCP_READ_RESULTS.whole
    for (const call of [
      // A range in `params`: the tool read two lines.
      { ref: 'mcp:read_file', path: FILE, params: { head: 2 } },
      // The tool read /work/proj/other.txt (params beats the top level); never a read of FILE.
      { ref: 'mcp:read_file', path: FILE, params: { path: '/work/proj/other.txt' } },
      // Or FILE, if the path came from `input`: the stored record cannot tell, so unknown.
      { ref: 'mcp:read_file', input: { path: FILE }, params: { path: '/work/proj/other.txt' } },
      // An argument this module does not know may read part of the file.
      { ref: 'mcp:read_file', input: { path: FILE, length: 10 } },
      // The model's own filePath is an argument the tool received, not the stored copy of path.
      { ref: 'mcp:read_file', input: { path: FILE, filePath: '/work/proj/other.txt' } },
      { ref: 'mcp:read_file', input: { file_path: FILE } },
      // `params` that is not an object: the broker drops it, but the ledger does not guess.
      { ref: 'mcp:read_file', path: FILE, params: 'head=2' }
    ]) {
      const stored = await storeGatewayCall(call, whole)
      expect(describeFiles(stored), JSON.stringify(call)).toEqual({ kind: 'unknown_read' })
    }
  })

  it('a JSON file stays unknown: its text is stored as the parsed value, not the whole text', async () => {
    const text = '{\n  "name": "batshit",\n  "private": true\n}\n'
    const stored = await storeGatewayRead(
      { path: '/work/proj/package.json' },
      { content: [{ type: 'text', text }], structuredContent: { content: text } }
    )
    expect(typeof stored.payload.toolResult.result.content[0].text).toBe('object')
    expect(describeFiles(stored)).toEqual({ kind: 'unknown_read' })
  })

  it('a failed read stays unknown (the broker says success, the MCP result says isError)', async () => {
    const stored = await storeGatewayRead({ path: FILE }, FILESYSTEM_MCP_READ_RESULTS.missing(FILE))
    expect(stored.payload.toolResult.success).toBe(true)
    expect(describeFiles(stored)).toEqual({ kind: 'unknown_read' })
  })

  it('a call that failed before the tool answered stays unknown (a tool error is stored as success false)', async () => {
    const step = gatewayReadStep({ input: { path: FILE }, result: undefined, sessionId: SESSION })
    step.toolResult = { success: false, error: 'Tool "read_file" not found.', input: step.toolResult.input } as any
    counter += 1
    const [created] = await adaptCoolToolsToZipSystem([step], SESSION, `msg_gateway_${counter}`, {})
    const zip = (await redis.json.get(`zip:${created.zipId}`)) as any
    const stored = { zipId: created.zipId, reference: created.reference, operationKind: zip?.metadata?.operationKind ?? null, payload: parseCoolToolPayload(zip?.content) ?? {} }
    expect(stored.payload.toolResult).toMatchObject({ success: false })
    // Stored without the executed tool's name, so not even a read; either way never a whole one.
    expect(describeFiles(stored).kind).not.toBe('read')
  })

  it('a relative path stays unknown: the tool server resolves it against its own folder', async () => {
    const stored = await storeGatewayRead({ path: 'notes.txt' }, FILESYSTEM_MCP_READ_RESULTS.whole)
    expect(describeFiles(stored)).toEqual({ kind: 'unknown_read' })
  })

  it('a file longer than the stored summary keeps stays unknown: the result holds only its start', async () => {
    const longRead = await storeGatewayRead({ path: FILE }, filesystemMcpWholeRead(80))
    expect(longRead.payload.toolResult.result.content[0].text).toMatchObject({ truncated: true })
    expect(describeFiles(longRead)).toEqual({ kind: 'unknown_read' })

    // 79 lines and the final newline are 80 lines to the summary, the most it keeps whole.
    const fits = await storeGatewayRead({ path: FILE }, filesystemMcpWholeRead(79))
    expect(describeFiles(fits)).toEqual({ kind: 'read', files: new Map([[KEY, 'whole']]) })
  })

  it('other gateway tools are not reads', async () => {
    const stored = await storeGatewayRead({ path: '/work/proj' }, FILESYSTEM_MCP_READ_RESULTS.whole, 'list_directory')
    expect(describeFiles(stored)).toEqual({ kind: 'none' })
  })

  it('a whole gateway read supersedes an earlier read and is superseded by a later one', async () => {
    const gateway = await storeGatewayRead({ path: FILE }, FILESYSTEM_MCP_READ_RESULTS.whole)

    const superseding = findDeadCopies([nativeRead(FILE, 0), asLedgerResult(gateway, 1)], { projectPath: PROJECT })
    expect(superseding.get('cool_tool_1790500000000_native0')).toMatchObject({ reason: 'superseded' })
    expect(superseding.has(gateway.zipId)).toBe(false)

    const superseded = findDeadCopies([asLedgerResult(gateway, 0), nativeRead(FILE, 1)], { projectPath: PROJECT })
    expect(superseded.get(gateway.zipId)).toMatchObject({ reason: 'superseded', deadAtMessageIndex: 1 })

    const stale = findDeadCopies([asLedgerResult(gateway, 0), nativeEdit(FILE, 1)], { projectPath: PROJECT })
    expect(stale.get(gateway.zipId)).toMatchObject({ reason: 'stale' })
  })

  it('a head read neither supersedes nor is killed', async () => {
    const head = await storeGatewayRead({ path: FILE, head: 2 }, FILESYSTEM_MCP_READ_RESULTS.head2)
    const dead = findDeadCopies(
      [nativeRead(FILE, 0), asLedgerResult(head, 1), nativeRead(FILE, 2)],
      { projectPath: PROJECT }
    )
    expect(dead.get('cool_tool_1790500000000_native0')).toMatchObject({ deadAtMessageIndex: 2 })
    expect(dead.has(head.zipId)).toBe(false)
  })

  it('is the newest whole read a hold sits on', async () => {
    const gateway = await storeGatewayRead({ path: FILE }, FILESYSTEM_MCP_READ_RESULTS.whole)
    const newest = newestWholeReadsByFile([nativeRead(FILE, 0), asLedgerResult(gateway, 1)], { projectPath: PROJECT })
    expect(newest.get(KEY)).toEqual({ zipId: gateway.zipId, messageIndex: 1 })
  })
})

describe('holding a gateway MCP read (BL-418)', () => {
  async function replyWith(zipIds: string[]) {
    counter += 1
    await redis.saveMessage({
      id: `msg_gateway_reply_${counter}`,
      session_id: SESSION,
      user_id: 'user-1',
      agent_id: AGENT,
      role: 'assistant',
      content: zipIds.map((zip) => `{{batshit-zip:${zip}}}`).join('\n'),
      created_at: new Date(Date.now() + counter).toISOString(),
      metadata: { zipIds }
    } as any)
  }

  const hold = (path: string) =>
    applyAgentHoldChanges({
      sessionId: SESSION,
      agentId: AGENT,
      projectPath: PROJECT,
      blocks: [{ hold: [path], release: [] }],
      currentReply: null
    })

  /**
   * BL-853: a Hold is recorded under the zip's STATE id, `normalizeId(<raw zip id>)`, the id the
   * compile looks zip state up by; the zip itself stays stored under its raw id. The two differ
   * exactly when the random tail of `cool_tool_<ms>_<tail>` is all digits (about 1 zip in 600):
   * `normalizeId` cuts a digit-only `_N` tail (the clip index rule). This suite used to store the
   * zip under a random tail and expect the raw id back, so it failed for that 1 in 600 (the
   * held entry read `cool_tool_1790627467077` for the zip `cool_tool_1790627467077_14079`).
   * The tails are fixed here; each row states the state id literally.
   */
  const HOLD_TAILS = [
    { name: 'a tail with letters keeps its whole id', raw: 'cool_tool_1790627467077_ab1c9', state: 'cool_tool_1790627467077_ab1c9' },
    { name: 'an all-digit tail is cut from the state id', raw: 'cool_tool_1790627467077_14079', state: 'cool_tool_1790627467077' },
    { name: 'an all-zero tail is cut from the state id', raw: 'cool_tool_1790627467077_00000', state: 'cool_tool_1790627467077' }
  ]

  for (const { name, raw, state } of HOLD_TAILS) {
    it(`holds a whole gateway read by its path: ${name}`, async () => {
      const gateway = await storeGatewayRead({ path: FILE }, FILESYSTEM_MCP_READ_RESULTS.whole, 'read_file', raw)
      expect(gateway.zipId).toBe(raw)
      await replyWith([gateway.zipId])

      const changes = await hold('notes.txt')

      expect(changes.errors).toEqual([])
      expect(changes.held).toEqual([{ path: KEY, zipId: state }])
      expect(await redis.get(`unzipped_item:${SESSION}:${state}`)).toMatchObject({
        zipId: state,
        source: 'agent',
        agentId: AGENT,
        path: KEY
      })
      expect(await redis.sMembers(`unzipped:${SESSION}`)).toEqual([state])
      // The zip stays stored under its raw id, and the state id resolves back to it through the
      // chat's own zip index: a Hold never points at a zip Batshit cannot find.
      expect(await redis.getZip(raw)).toMatchObject({ type: 'cool_tool' })
      expect(await resolveSessionZipForHold(SESSION, state)).toMatchObject({
        status: 'found',
        rawZipId: raw,
        stateZipId: state
      })
    })
  }

  it('refuses to hold a head read loudly, as before', async () => {
    const head = await storeGatewayRead({ path: FILE, head: 2 }, FILESYSTEM_MCP_READ_RESULTS.head2)
    await replyWith([head.zipId])

    const changes = await hold(FILE)

    expect(changes.held).toEqual([])
    expect(changes.errors[0]?.error).toContain(`You have no whole read of ${FILE}`)
  })
})
