// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { adaptCoolToolsToZipSystem } from '../coolToolZipAdapter'
import { parseCoolToolPayload } from '$lib/utils/coolToolAiContent'
import { describeToolResultFiles, findDeadCopies, type DeadCopyToolResult } from '$lib/utils/zipDeadCopies'

/**
 * BL-2005: a read of PART of a file must stay a part in the dead-copy ledger. The ledger reads
 * the range arguments on the STORED payload, and the compact read arguments used to drop them, so
 * Claude Code's `Read` of lines 100-149 was stored as a whole read: it superseded the agent's
 * earlier whole copy and a hold could sit on it. Every step here goes through the REAL zip adapter
 * into Redis in the shape the lane hands it over (`claudeEventAdapter.ts` maps `Read` to
 * `batshit_server_read_file`).
 */

useRedisTestServer()

const PROJECT = '/p'
let session = ''
let counter = 0

beforeEach(async () => {
  counter += 1
  session = `read-range-${counter}-${Date.now()}`
  await redis.createSession({ id: session, user_id: 'user-1', title: 'Ranges', agent_id: 'agent-1' } as any)
})

async function store(step: Record<string, any>, messageIndex: number) {
  counter += 1
  const refs = await adaptCoolToolsToZipSystem(
    [{ toolCallId: `call_range_${counter}`, timestamp: new Date().toISOString(), metadata: { sessionId: session }, ...step }],
    session,
    `msg_range_${messageIndex}`,
    {},
    undefined
  )
  const zip = (await redis.json.get(`zip:${refs[0].zipId}`)) as any
  const payload = (parseCoolToolPayload(zip?.content) ?? {}) as Record<string, any>
  return { zipId: refs[0].zipId!, operationKind: (zip?.metadata?.operationKind ?? null) as string | null, payload }
}

/** Claude Code's `Read`, as `claudeEventAdapter.ts` hands it to the zip adapter. */
const claudeRead = (args: Record<string, unknown>, lines: number) => ({
  toolName: 'batshit_server_read_file',
  originalToolName: 'Read',
  toolArgs: { file_path: '/p/a.ts', filePath: '/p/a.ts', path: '/p/a.ts', ...args },
  toolInput: { file_path: '/p/a.ts', filePath: '/p/a.ts', path: '/p/a.ts', ...args },
  toolResult: { filePath: '/p/a.ts', content: 'x\n'.repeat(lines), lineCount: lines }
})

const asLedger = (entry: { zipId: string; operationKind: string | null; payload: any }, messageIndex: number): DeadCopyToolResult => ({
  zipId: entry.zipId,
  authorId: 'agent-1',
  messageIndex,
  operationKind: entry.operationKind,
  payload: entry.payload
})

describe('a ranged read keeps its range on the stored payload (BL-2005)', () => {
  it("Claude Code's Read with offset and limit is a part, and does not supersede the earlier whole read", async () => {
    const whole = await store(claudeRead({}, 300), 0)
    const part = await store(claudeRead({ offset: 100, limit: 50 }, 50), 1)
    expect(part.operationKind).toBe('read_file')
    expect(part.payload.toolArgs).toMatchObject({ offset: 100, limit: 50 })
    expect(describeToolResultFiles(part, { projectPath: PROJECT })).toEqual({ kind: 'read', files: new Map([['a.ts', 'partial']]) })
    expect(describeToolResultFiles(whole, { projectPath: PROJECT })).toEqual({ kind: 'read', files: new Map([['a.ts', 'whole']]) })
    expect(findDeadCopies([asLedger(whole, 0), asLedger(part, 1)], { projectPath: PROJECT }).size).toBe(0)
  })

  it('a whole Read still supersedes, and only plain values are kept', async () => {
    const first = await store(claudeRead({}, 300), 0)
    const second = await store(claudeRead({ limit: { nested: true }, lines: [1, 2] }, 300), 1)
    expect(second.payload.toolArgs.limit).toBeUndefined()
    expect(second.payload.toolArgs.lines).toEqual([1, 2])
    const third = await store(claudeRead({}, 300), 2)
    expect(findDeadCopies([asLedger(first, 0), asLedger(third, 2)], { projectPath: PROJECT }).get(first.zipId)).toMatchObject({ reason: 'superseded' })
  })
})
