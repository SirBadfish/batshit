// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  advanceZipCountdowns,
  applyAgentHoldChanges,
  applyLegacyAgentZipActions,
  markAgentBeingDeleted,
  releaseDeletedAgentHolds,
  type ReplyForHolds
} from '../zipHolds'
import { failRedisWritesTouching } from '$lib/test-utils/redisWriteFailures'
import { isZipStateLockBusy, withZipStateLock } from '../zipStateLock'
import { POST as userHoldRoute } from '../../../../routes/api/unzipping/+server'
import { DELETE as userReleaseRoute } from '../../../../routes/api/unzipping/[zipId]/+server'
import { normalizeId } from '$lib/utils/idNormalizer'

const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'

/**
 * SA-129 P2 (DL-02, DL-06, DL-08): the server's writer for an agent's holds and releases, the
 * parked zip actions, and the countdown. Same keys and shapes as the `/api/unzipping` routes and
 * `zipStateInferred.ts`, so deletion, backup, the compiler, and the badges need nothing new. Runs
 * on the fake and, under `npm run test:redis` (CI's real-Redis list), on real RedisJSON.
 */

useRedisTestServer()

const PROJECT = '/work/proj'
const AGENT = 'agent-holder'
let SESSION = ''
let counter = 0
let zipCounter = 0

beforeEach(async () => {
  counter += 1
  SESSION = `zip-holds-session-${counter}-${Date.now()}`
  // The real `saveMessage` refuses a message whose chat does not exist.
  await redis.createSession({ id: SESSION, user_id: 'user-1', title: 'Holds', agent_id: AGENT } as any)
  // An agent writes zip state only while its record exists (BL-606).
  await redis.createAgent({ id: AGENT, user_id: 'user-1', name: 'Holder', displayName: 'Holder' } as any)
  await redis.createAgent({ id: 'agent-other', user_id: 'user-1', name: 'Other', displayName: 'Other' } as any)
})

function zipId() {
  zipCounter += 1
  return `cool_tool_1790500000000_h${String(zipCounter).padStart(4, '0')}x`
}

async function storeZip(id: string, operationKind: string, toolArgs: Record<string, any>, toolResult: Record<string, any>) {
  const payload = { schemaVersion: 1, operationKind, toolName: operationKind, toolArgs, toolResult }
  await redis.execute((client: any) =>
    client.json.set(`zip:${id}`, '$', {
      id,
      type: 'cool_tool',
      content: JSON.stringify(payload),
      description: `${operationKind}: ${toolArgs.filePath ?? toolArgs.skillId ?? ''} - 3 lines`,
      tokens: 42,
      metadata: { operationKind, toolName: operationKind, sessionId: SESSION }
    })
  )
}

async function wholeRead(path: string) {
  const id = zipId()
  await storeZip(id, 'read_file', { filePath: path }, { filePath: path, content: 'a\nb\nc', lineCount: 3 })
  return id
}

async function tooLargeWholeRead(path: string) {
  const id = await wholeRead(path)
  const zip = await redis.getZip(id)
  await redis.execute((client: any) => client.json.set(`zip:${id}`, '$', {
    ...zip,
    tokens: 25_000,
    metadata: { ...zip.metadata, promptTokens: 25_000, tokenBasis: 'ai_expanded' }
  }))
  return id
}

async function partialRead(path: string) {
  const id = zipId()
  await storeZip(id, 'read_file', { filePath: path, offset: 10, limit: 5 }, { filePath: path, content: 'x', lineCount: 5 })
  return id
}

async function edit(path: string) {
  const id = zipId()
  await storeZip(id, 'edit_file', { filePath: path }, { filePath: path, diff: '+x' })
  return id
}

let messageCounter = 0
async function reply(zipIds: string[], agentId = AGENT) {
  messageCounter += 1
  const id = `msg_reply_${messageCounter}`
  await redis.saveMessage({
    id,
    session_id: SESSION,
    user_id: 'user-1',
    agent_id: agentId,
    role: 'assistant',
    content: zipIds.map((zip) => `{{batshit-zip:${zip}}}`).join('\n'),
    created_at: new Date(Date.now() + messageCounter).toISOString(),
    metadata: { zipIds }
  } as any)
  return id
}

function current(zipIds: string[]): ReplyForHolds {
  messageCounter += 1
  return {
    messageId: `msg_current_${messageCounter}`,
    content: zipIds.map((zip) => `{{batshit-zip:${zip}}}`).join('\n'),
    zipIds
  }
}

const item = (zip: string) => redis.get(`unzipped_item:${SESSION}:${zip}`) as Promise<any>

async function apply(hold: string[], release: string[] = [], currentReply: ReplyForHolds | null = null) {
  return applyAgentHoldChanges({ sessionId: SESSION, agentId: AGENT, projectPath: PROJECT, blocks: [{ hold, release }], currentReply })
}

/** Several Tool Notes blocks, in order (BL-538). */
async function applyBlocks(blocks: Array<{ hold?: string[]; release?: string[] }>, currentReply: ReplyForHolds | null = null) {
  return applyAgentHoldChanges({
    sessionId: SESSION,
    agentId: AGENT,
    projectPath: PROJECT,
    blocks: blocks.map((block) => ({ hold: block.hold ?? [], release: block.release ?? [] })),
    currentReply
  })
}

async function userHold(zip: string, extra: Record<string, any> = {}) {
  await redis.sAdd(`unzipped:${SESSION}`, zip)
  await redis.set(`unzipped_item:${SESSION}:${zip}`, { zipId: zip, sessionId: SESSION, permanent: true, unzippedAt: 1, source: 'user', ...extra })
}

describe('hold (DL-02)', () => {
  it('checks the real zip behind an old normalized all-digit Hold, and releases its original state key', async () => {
    const rawZipId = 'cool_tool_1790500000000_12345'
    const stateZipId = normalizeId(rawZipId)
    await storeZip(rawZipId, 'read_file', { filePath: 'src/legacy-digits.ts' }, {
      filePath: 'src/legacy-digits.ts', content: 'large', lineCount: 1
    })
    const zip = await redis.getZip(rawZipId)
    await redis.execute((client: any) => client.json.set(`zip:${rawZipId}`, '$', {
      ...zip, tokens: 25_000, metadata: { ...zip.metadata, promptTokens: 25_000, tokenBasis: 'ai_expanded' }
    }))
    await redis.sAdd(`session:${SESSION}:zips`, rawZipId)
    await reply([rawZipId])
    await redis.sAdd(`unzipped:${SESSION}`, stateZipId)
    await redis.set(`unzipped_item:${SESSION}:${stateZipId}`, {
      zipId: stateZipId, sessionId: SESSION, permanent: true, source: 'agent', path: 'src/legacy-digits.ts', agentId: AGENT
    })

    const repeated = await apply(['src/legacy-digits.ts'])
    expect(repeated.errors[0].error).toContain('25,000 tokens')
    expect(await item(stateZipId)).toMatchObject({ source: 'agent' })
    const released = await apply([], ['src/legacy-digits.ts'])
    expect(released.released).toEqual([{ path: 'src/legacy-digits.ts', zipId: stateZipId }])
    expect(await item(stateZipId)).toBeNull()
    expect(await redis.sMembers(`unzipped:${SESSION}`)).toEqual([])
  })

  it('stores a new all-digit zip Hold under exactly one normalized state ID', async () => {
    const rawZipId = 'cool_tool_1790500000001_12345'
    const stateZipId = normalizeId(rawZipId)
    await storeZip(rawZipId, 'read_file', { filePath: 'src/digits.ts' }, {
      filePath: 'src/digits.ts', content: 'small', lineCount: 1
    })
    await redis.sAdd(`session:${SESSION}:zips`, rawZipId)
    const changes = await apply(['src/digits.ts'], [], current([rawZipId]))
    expect(changes.held).toEqual([{ path: 'src/digits.ts', zipId: stateZipId }])
    expect(await item(stateZipId)).toMatchObject({ source: 'agent' })
  })

  it('does not create an agent Hold when two raw reads share one normalized state ID', async () => {
    const first = 'cool_tool_1790500000003_12345'
    const second = 'cool_tool_1790500000003_67890'
    for (const rawZipId of [first, second]) {
      await storeZip(rawZipId, 'read_file', { filePath: 'src/ambiguous.ts' }, {
        filePath: 'src/ambiguous.ts', content: 'small', lineCount: 1
      })
      await redis.sAdd(`session:${SESSION}:zips`, rawZipId)
    }
    const changes = await apply(['src/ambiguous.ts'], [], current([first]))
    expect(changes.held).toEqual([])
    expect(changes.errors[0].error).toContain('ambiguous')
    expect(await redis.sMembers(`unzipped:${SESSION}`)).toEqual([])
  })

  it('refuses a too-large whole read loudly before writing Hold state, including a repeat request', async () => {
    const read = await tooLargeWholeRead('src/huge.ts')
    const first = await apply(['src/huge.ts'], [], current([read]))
    const repeated = await apply(['src/huge.ts'], [], current([read]))
    for (const changes of [first, repeated]) {
      expect(changes.held).toEqual([])
      expect(changes.errors[0].error).toContain('25,000 tokens')
      expect(changes.errors[0].error).toContain('Fetch it in parts')
    }
    expect(await item(read)).toBeNull()
    expect(await redis.sMembers(`unzipped:${SESSION}`)).toEqual([])
  })

  it('refuses a new request to keep a legacy too-large agent Hold open, but still releases it', async () => {
    const read = await tooLargeWholeRead('src/legacy.ts')
    await reply([read])
    await redis.sAdd(`unzipped:${SESSION}`, read)
    await redis.set(`unzipped_item:${SESSION}:${read}`, {
      zipId: read, sessionId: SESSION, permanent: true, source: 'agent', path: 'src/legacy.ts', agentId: AGENT
    })
    const repeated = await apply(['src/legacy.ts'])
    expect(repeated.errors[0].error).toContain('too large to open')
    expect(repeated.held).toEqual([])
    expect(await item(read)).toMatchObject({ source: 'agent' })
    const released = await apply([], ['src/legacy.ts'])
    expect(released.released).toEqual([{ path: 'src/legacy.ts', zipId: read }])
    expect(await item(read)).toBeNull()
  })

  it('holds the newest whole read of the path, as the routes\' own record with the path and the agent', async () => {
    const older = await wholeRead('src/app.ts')
    await reply([older])
    const newer = await wholeRead(`${PROJECT}/src/app.ts`)
    await reply([newer])

    const changes = await apply(['src/app.ts'])

    expect(changes.errors).toEqual([])
    expect(changes.held).toEqual([{ path: 'src/app.ts', zipId: newer }])
    expect(await redis.sMembers(`unzipped:${SESSION}`)).toEqual([newer])
    expect(await item(newer)).toMatchObject({
      zipId: newer,
      sessionId: SESSION,
      permanent: true,
      source: 'agent',
      path: 'src/app.ts',
      agentId: AGENT,
      tokens: 42
    })
    expect(await item(older)).toBeNull()
  })

  it('finds a read in the reply being finished, which is not stored yet', async () => {
    const read = await wholeRead('docs/spec.md')
    const changes = await apply(['docs/spec.md'], [], current([read]))
    expect(changes.held).toEqual([{ path: 'docs/spec.md', zipId: read }])
  })

  it('never holds a partial read, and says so', async () => {
    const part = await partialRead('src/big.ts')
    await reply([part])
    const changes = await apply(['src/big.ts'])
    expect(changes.held).toEqual([])
    expect(changes.errors).toHaveLength(1)
    expect(changes.errors[0]).toMatchObject({ tag: 'batshit-tool-notes' })
    expect(changes.errors[0].error).toContain('no whole read of src/big.ts')
    expect(await redis.sMembers(`unzipped:${SESSION}`)).toEqual([])
  })

  it('reports a path with no read in this chat loudly', async () => {
    const changes = await apply(['nowhere.ts'])
    expect(changes.errors.map((error) => error.error)).toEqual([
      'You have no whole read of nowhere.ts in this chat, so nothing was held. Read the whole file, then hold it.'
    ])
  })

  it('never holds another agent\'s read (holds, like dead copies, stay within one author)', async () => {
    const theirs = await wholeRead('src/app.ts')
    await reply([theirs], 'agent-other')
    const changes = await apply(['src/app.ts'])
    expect(changes.held).toEqual([])
    expect(changes.errors).toHaveLength(1)
  })

  it('leaves a read the user holds to the user, and tells the agent', async () => {
    const read = await wholeRead('src/app.ts')
    await reply([read])
    await userHold(read)
    const changes = await apply(['src/app.ts'])
    expect(changes.held).toEqual([])
    expect(changes.errors[0].error).toBe('The user already holds src/app.ts; your hold was not needed.')
    expect(await item(read)).toMatchObject({ source: 'user' })
  })

  it('never undoes the user\'s "Zip now"', async () => {
    const read = await wholeRead('src/app.ts')
    await reply([read])
    await redis.sAdd(`rezipped:${SESSION}`, read)
    await redis.set(`rezipped_item:${SESSION}:${read}`, { zipId: read, sessionId: SESSION, source: 'user', rezippedAt: 1 })
    const changes = await apply(['src/app.ts'])
    expect(changes.held).toEqual([])
    expect(changes.errors[0].error).toContain('The user zipped src/app.ts by hand')
    expect(await redis.sMembers(`rezipped:${SESSION}`)).toEqual([read])
  })

  it('holds a skill file named <skill id>/<path>', async () => {
    const id = zipId()
    await storeZip(id, 'skill_read', { skillId: 'skill_creator', action: 'invoke' }, { skillId: 'skill_creator', action: 'invoke', content: '# Skill' })
    await reply([id])
    const changes = await apply(['skill_creator/SKILL.md'])
    expect(changes.held).toEqual([{ path: 'skill_creator/SKILL.md', zipId: id }])
    expect(await item(id)).toMatchObject({ path: 'skill:skill_creator:SKILL.md' })
  })
})

describe('the hold follows the file (DL-02)', () => {
  it('keeps the old Hold when a newer whole read is too large, then moves to a later small read', async () => {
    const first = await wholeRead('src/app.ts')
    await reply([first])
    await apply(['src/app.ts'])
    const huge = await tooLargeWholeRead('src/app.ts')
    const refused = await apply([], [], current([huge]))
    expect(refused.moved).toEqual([])
    expect(refused.errors[0].error).toContain('stayed on the earlier read')
    expect(await item(first)).toMatchObject({ source: 'agent' })
    expect(await item(huge)).toBeNull()

    await reply([huge])
    const laterReply = await apply([], [], current([]))
    expect(laterReply.errors).toEqual([])
    expect(laterReply.moved).toEqual([])
    expect(await item(first)).toMatchObject({ source: 'agent' })
    const small = await wholeRead('src/app.ts')
    const resumed = await apply([], [], current([small]))
    expect(resumed.moved).toEqual([{ path: 'src/app.ts', from: first, to: small }])
    expect(await item(first)).toBeNull()
    expect(await item(small)).toMatchObject({ source: 'agent' })
  })

  it('moves to a newer whole read at the next reply end, and the older copy returns to the automatic rules', async () => {
    const first = await wholeRead('src/app.ts')
    await reply([first])
    await apply(['src/app.ts'])
    const second = await wholeRead('src/app.ts')

    const changes = await apply([], [], current([second]))

    expect(changes.moved).toEqual([{ path: 'src/app.ts', from: first, to: second }])
    expect(await item(first)).toBeNull()
    expect(await item(second)).toMatchObject({ source: 'agent', path: 'src/app.ts', agentId: AGENT, permanent: true })
    expect(await redis.sMembers(`unzipped:${SESSION}`)).toEqual([second])
  })

  it('stays on a copy the agent edited since until the next whole read, then moves at once', async () => {
    const first = await wholeRead('src/app.ts')
    await reply([first])
    await apply(['src/app.ts'])
    const change = await edit('src/app.ts')

    // An edit alone: the hold stays on the stale copy (the compile compresses it by DL-01).
    const afterEdit = await apply([], [], current([change]))
    expect(afterEdit.moved).toEqual([])
    expect(await item(first)).toMatchObject({ source: 'agent' })

    await reply([change])
    const reread = await wholeRead('src/app.ts')
    const afterRead = await apply([], [], current([reread]))
    expect(afterRead.moved).toEqual([{ path: 'src/app.ts', from: first, to: reread }])
  })

  it('does not move onto a newer copy the user holds', async () => {
    const first = await wholeRead('src/app.ts')
    await reply([first])
    await apply(['src/app.ts'])
    const second = await wholeRead('src/app.ts')
    await reply([second])
    await userHold(second)
    const changes = await apply([])
    expect(changes.moved).toEqual([])
    expect(await item(first)).toMatchObject({ source: 'agent' })
    expect(await item(second)).toMatchObject({ source: 'user' })
  })

  it('a partial read never takes the hold', async () => {
    const first = await wholeRead('src/app.ts')
    await reply([first])
    await apply(['src/app.ts'])
    const part = await partialRead('src/app.ts')
    const changes = await apply([], [], current([part]))
    expect(changes.moved).toEqual([])
    expect(await item(first)).toMatchObject({ source: 'agent' })
  })
})

describe('release (DL-02)', () => {
  it('clears the agent\'s hold, exactly like the Zip Manager\'s return to automatic', async () => {
    const read = await wholeRead('src/app.ts')
    await reply([read])
    await apply(['src/app.ts'])
    const changes = await apply([], ['src/app.ts'])
    expect(changes.released).toEqual([{ path: 'src/app.ts', zipId: read }])
    expect(changes.errors).toEqual([])
    expect(await redis.sMembers(`unzipped:${SESSION}`)).toEqual([])
    expect(await item(read)).toBeNull()
  })

  it('never releases what the user holds', async () => {
    const read = await wholeRead('src/app.ts')
    await reply([read])
    await userHold(read)
    const changes = await apply([], ['src/app.ts'])
    expect(changes.released).toEqual([])
    expect(changes.errors[0].error).toBe('The user holds src/app.ts; only the user can release it.')
    expect(await item(read)).toMatchObject({ source: 'user' })
  })

  it('says so when there is nothing to release', async () => {
    const changes = await apply([], ['src/app.ts'])
    expect(changes.errors[0].error).toBe('You do not hold src/app.ts; there was nothing to release.')
  })

  it('release then hold of one path in one block ends with it held', async () => {
    const read = await wholeRead('src/app.ts')
    await reply([read])
    await apply(['src/app.ts'])
    const changes = await apply(['src/app.ts'], ['src/app.ts'])
    expect(changes.released).toHaveLength(1)
    expect(changes.held).toEqual([{ path: 'src/app.ts', zipId: read }])
    expect(await item(read)).toMatchObject({ source: 'agent' })
  })

  it('an agent never releases another agent\'s hold', async () => {
    const read = await wholeRead('src/app.ts')
    await reply([read])
    await apply(['src/app.ts'])
    const changes = await applyAgentHoldChanges({
      sessionId: SESSION,
      agentId: 'agent-other',
      projectPath: PROJECT,
      blocks: [{ hold: [], release: ['src/app.ts'] }],
      currentReply: null
    })
    expect(changes.released).toEqual([])
    expect(await item(read)).toMatchObject({ source: 'agent', agentId: AGENT })
  })
})

/**
 * BL-538: several Tool Notes blocks run in order, and the last block to name a FILE decides,
 * whatever spelling each block used (`src/a.ts`, `./src/a.ts`, or the absolute path).
 */
describe('several Tool Notes blocks name one file in different spellings (BL-538)', () => {
  const spellings = ['src/a.ts', './src/a.ts', `${PROJECT}/src/a.ts`]

  for (const first of spellings) {
    for (const second of spellings) {
      it(`hold ${first}, then release ${second}: not held`, async () => {
        const read = await wholeRead('src/a.ts')
        const changes = await applyBlocks([{ hold: [first] }, { release: [second] }], current([read]))
        expect(changes.errors).toEqual([])
        expect(changes.held).toEqual([{ path: 'src/a.ts', zipId: read }])
        expect(changes.released).toEqual([{ path: 'src/a.ts', zipId: read }])
        expect(await item(read)).toBeNull()
        expect(await redis.sMembers(`unzipped:${SESSION}`)).toEqual([])
      })
    }
  }

  it('release in one block, then hold in a later one, of a file already held: held', async () => {
    const read = await wholeRead('src/a.ts')
    await reply([read])
    await apply(['src/a.ts'])
    const changes = await applyBlocks([{ release: [`${PROJECT}/src/a.ts`] }, { hold: ['./src/a.ts'] }])
    expect(changes.errors).toEqual([])
    expect(await item(read)).toMatchObject({ source: 'agent', path: 'src/a.ts', agentId: AGENT })
  })

  it('a single block still releases before it holds, whatever order its keys come in', async () => {
    const read = await wholeRead('src/a.ts')
    await reply([read])
    await apply(['src/a.ts'])
    const changes = await applyBlocks([{ hold: ['./src/a.ts'], release: ['src/a.ts'] }])
    expect(changes.released).toHaveLength(1)
    expect(await item(read)).toMatchObject({ source: 'agent' })
  })
})

/**
 * BL-350 (Faye's review probes, 2026-09-27): an API-lane approval resume finalizes the SAME
 * message id with a stream that starts empty, so the reply the step is handed is only the words
 * after the card. The part before the card is the stored record of that id.
 */
describe('approval resume (BL-350: the reply continues a stored message with the same id)', () => {
  async function storedPart(id: string, zipIds: string[], words = '') {
    await redis.saveMessage({
      id,
      session_id: SESSION,
      user_id: 'user-1',
      agent_id: AGENT,
      role: 'assistant',
      content: `${zipIds.map((zip) => `{{batshit-zip:${zip}}}`).join('\n')}${words}`,
      created_at: new Date(Date.now() + zipCounter).toISOString(),
      metadata: { zipIds }
    } as any)
  }

  it('holds a file that was read BEFORE the approval card', async () => {
    const read = await wholeRead('src/app.ts')
    // The pause stored the first part of the message, with the read.
    await storedPart('msg_paused', [read], 'Checking with the shell now.')
    // The resume finalizes the SAME id; its stream started empty, so it carries no read.
    const changes = await apply(['src/app.ts'], [], { messageId: 'msg_paused', content: 'Done.', zipIds: [] })
    expect(changes.errors).toEqual([])
    expect(changes.held).toEqual([{ path: 'src/app.ts', zipId: read }])
    expect(await item(read)).toMatchObject({ source: 'agent', path: 'src/app.ts', agentId: AGENT })
  })

  it('a hold that moved to the read before the card does not move BACK to the older copy at the resume', async () => {
    const older = await wholeRead('src/app.ts')
    await storedPart('msg_older', [older])
    await apply(['src/app.ts'])
    expect(await item(older)).toMatchObject({ source: 'agent', path: 'src/app.ts' })

    // The next reply reads the file again, then pauses for approval: the pause finalizes and the hold follows the file.
    const newer = await wholeRead('src/app.ts')
    const pause = await apply([], [], { messageId: 'msg_paused', content: `{{batshit-zip:${newer}}}`, zipIds: [newer] })
    expect(pause.moved).toEqual([{ path: 'src/app.ts', from: older, to: newer }])
    await storedPart('msg_paused', [newer])

    // The resume: same id, empty stream.
    const resume = await apply([], [], { messageId: 'msg_paused', content: 'Done.', zipIds: [] })
    expect(resume.moved).toEqual([])
    expect(await item(newer)).toMatchObject({ source: 'agent', path: 'src/app.ts' })
    expect(await item(older)).toBeNull()
  })

  it('a read after the card is still newer than the read before it', async () => {
    const before = await wholeRead('src/app.ts')
    await storedPart('msg_paused', [before], 'Checking with the shell now.')
    const after = await wholeRead('src/app.ts')
    const changes = await apply(['src/app.ts'], [], {
      messageId: 'msg_paused',
      content: `{{batshit-zip:${after}}}`,
      zipIds: [after]
    })
    expect(changes.held).toEqual([{ path: 'src/app.ts', zipId: after }])
    expect(await item(before)).toBeNull()
  })
})

/**
 * BL-352: the reply-end step read the chat's zip state once and wrote it later, so a user's
 * click that landed in between was overwritten. Each case pauses the step right after it read
 * the record, lets the user click through the REAL route, then lets the step go on.
 */
describe('a user click while a reply ends (BL-352: one zip state writer at a time)', () => {
  let restore: (() => void) | null = null
  afterEach(() => {
    restore?.()
    restore = null
  })

  /** Pauses the first `redis.get` of `key`, AFTER it read the value, until `open()`. */
  function pauseAfterFirstRead(key: string) {
    let open!: () => void
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    let reached!: () => void
    const readDone = new Promise<void>((resolve) => {
      reached = resolve
    })
    const original = (redis.get as any).getMockImplementation?.() ?? redis.get.bind(redis)
    let paused = false
    const spy = vi.spyOn(redis, 'get').mockImplementation(async (k: string) => {
      const value = await original(k)
      if (!paused && k === key) {
        paused = true
        reached()
        await gate
      }
      return value
    })
    restore = () => spy.mockRestore()
    return { open, readDone }
  }

  const user = { user: { id: 'user-1' } }
  const clickRelease = (zip: string) =>
    userReleaseRoute({
      params: { zipId: zip },
      url: new URL(`http://batshit.test/api/unzipping/${zip}?sessionId=${SESSION}&mode=automatic`),
      locals: user
    } as any)
  const clickHold = (zip: string) =>
    userHoldRoute({
      request: new Request('http://batshit.test/api/unzipping', {
        method: 'POST',
        body: JSON.stringify({ zipId: zip, sessionId: SESSION, permanent: true, unzippedAt: 5 })
      }),
      locals: user
    } as any)
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

  it('a Release clicked while the countdown runs stays released, with no item record left behind', async () => {
    await redis.sAdd(`unzipped:${SESSION}`, 'zip_temp')
    await redis.set(`unzipped_item:${SESSION}:zip_temp`, { zipId: 'zip_temp', sessionId: SESSION, permanent: false, duration: 5, messageCount: 0, unzippedAt: 1, source: 'user' })
    const pause = pauseAfterFirstRead(`unzipped_item:${SESSION}:zip_temp`)

    const countdown = advanceZipCountdowns(SESSION)
    await pause.readDone
    const release = clickRelease('zip_temp')
    await tick()
    pause.open()
    await countdown
    expect((await release).status).toBe(200)

    expect(await redis.sMembers(`unzipped:${SESSION}`)).toEqual([])
    expect(await item('zip_temp')).toBeNull()
  })

  it('a Hold clicked while the countdown runs is not turned back into a countdown', async () => {
    await redis.execute((client: any) => client.json.set('zip:zip_temp', '$', {
      id: 'zip_temp', type: 'text', content: 'small', tokens: 2, description: '', metadata: { sessionId: SESSION }
    }))
    await redis.sAdd(`unzipped:${SESSION}`, 'zip_temp')
    await redis.set(`unzipped_item:${SESSION}:zip_temp`, { zipId: 'zip_temp', sessionId: SESSION, permanent: false, duration: 5, messageCount: 0, unzippedAt: 1, source: 'user' })
    const pause = pauseAfterFirstRead(`unzipped_item:${SESSION}:zip_temp`)

    const countdown = advanceZipCountdowns(SESSION)
    await pause.readDone
    const hold = clickHold('zip_temp')
    await tick()
    pause.open()
    await countdown
    expect((await hold).status).toBe(200)

    expect(await item('zip_temp')).toMatchObject({ permanent: true, source: 'user' })
  })

  it('a Hold clicked while the hold follows the file keeps the user\'s hold on that copy', async () => {
    const older = await wholeRead('src/app.ts')
    await reply([older])
    await apply(['src/app.ts'])
    const newer = await wholeRead('src/app.ts')
    const pause = pauseAfterFirstRead(`unzipped_item:${SESSION}:${older}`)

    const move = apply([], [], current([newer]))
    await pause.readDone
    const hold = clickHold(newer)
    await tick()
    pause.open()
    await move
    expect((await hold).status).toBe(200)

    expect(await item(newer)).toMatchObject({ source: 'user', permanent: true })
    expect(await item(newer)).not.toHaveProperty('agentId')
  })

  it('takes turns: a second writer for the same chat waits, and a nested one for the same chat does not deadlock', async () => {
    const order: string[] = []
    let open!: () => void
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const first = withZipStateLock(SESSION, async () => {
      order.push('first:start')
      await gate
      order.push('first:end')
    })
    const second = withZipStateLock(SESSION, async () => {
      order.push('second')
    })
    const otherChat = withZipStateLock(`${SESSION}-other`, async () => {
      order.push('other chat')
    })
    await otherChat
    await tick()
    expect(order).toEqual(['first:start', 'other chat'])
    open()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'other chat', 'first:end', 'second'])
    expect(isZipStateLockBusy(SESSION)).toBe(false)

    await expect(
      withZipStateLock(SESSION, () => withZipStateLock(SESSION, async () => 'nested ran'))
    ).resolves.toBe('nested ran')
  })

  it('a writer that throws lets the next one in', async () => {
    await expect(withZipStateLock(SESSION, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(withZipStateLock(SESSION, async () => 'next')).resolves.toBe('next')
    expect(isZipStateLockBusy(SESSION)).toBe(false)
  })

  it.runIf(REAL_REDIS_LANE)('deleting a chat takes an item record with no set member too (the sweep reads by pattern, like backup)', async () => {
    await redis.set(`unzipped_item:${SESSION}:zip_orphan`, { zipId: 'zip_orphan', sessionId: SESSION, permanent: false, source: 'user' })
    await redis.set(`rezipped_item:${SESSION}:zip_orphan_rezip`, { zipId: 'zip_orphan_rezip', sessionId: SESSION, source: 'user' })
    await userHold('zip_member')
    await redis.deleteSession(SESSION)
    expect(await redis.keys(`unzipped_item:${SESSION}:*`)).toEqual([])
    expect(await redis.keys(`rezipped_item:${SESSION}:*`)).toEqual([])
    expect(await redis.exists(`unzipped:${SESSION}`)).toBe(false)
  })
})

/**
 * BL-541: `redis.deleteSession` builds KEYS patterns from the chat id. Redis reads `*`, `?`, `[`,
 * `]`, and `\` in a pattern as glob syntax, so deleting a chat whose id was `a*` swept the
 * records of every chat whose id starts with `a`. Real Redis only: the fake's pattern matcher is
 * not Redis's.
 */
describe('deleting a chat whose id carries glob characters (BL-541)', () => {
  const families = (id: string) => [
    `episode:${id}:ep_1`,
    `session_clip:${id}:clip_1`,
    `subagent_sessions:${id}:subagent:helper`,
    `subagent_thread:${id}:helper`,
    `subagent_lock:${id}:helper`,
    `n8n:sse-callback:${id}:msg_1`,
    `unzipped_item:${id}:zip_1`,
    `rezipped_item:${id}:zip_2`
  ]

  for (const [glob, other] of [
    ['*', 'bc'],
    ['?', 'b'],
    ['[b]', 'b'],
    ['\\', '']
  ] as const) {
    it.runIf(REAL_REDIS_LANE)(`deleting "a${glob}" leaves "a${other}"'s records`, async () => {
      const stamp = `bl541-${Date.now()}-${counter}-`
      const deleted = `${stamp}a${glob}`
      const kept = `${stamp}a${other}`
      await redis.createSession({ id: deleted, user_id: 'user-1', title: 'Glob' } as any)
      await redis.createSession({ id: kept, user_id: 'user-1', title: 'Kept' } as any)
      for (const key of [...families(deleted), ...families(kept)]) await redis.set(key, { owner: key })

      await redis.deleteSession(deleted)

      for (const key of families(kept)) expect(await redis.get(key), key).toEqual({ owner: key })
      for (const key of families(deleted)) expect(await redis.get(key), key).toBeNull()
      expect(await redis.getSession(kept)).not.toBeNull()
    })
  }
})

/** BL-351: deleting an agent releases its holds in every chat. */
describe('deleting an agent (BL-351)', () => {
  it("releases the agent's holds in every chat and leaves every other hold alone", async () => {
    await redis.createAgent({ id: AGENT, user_id: 'user-1', name: 'Holder', displayName: 'Holder' } as any)
    const read = await wholeRead('src/app.ts')
    await reply([read])
    await apply(['src/app.ts'])
    const otherChat = `${SESSION}-second`
    await redis.createSession({ id: otherChat, user_id: 'user-1', title: 'Second', agent_id: AGENT } as any)
    await redis.sAdd(`unzipped:${otherChat}`, 'zip_there')
    await redis.set(`unzipped_item:${otherChat}:zip_there`, { zipId: 'zip_there', sessionId: otherChat, permanent: true, source: 'agent', path: 'b.ts', agentId: AGENT })
    await userHold('zip_user')
    await redis.sAdd(`unzipped:${SESSION}`, 'zip_other_agent')
    await redis.set(`unzipped_item:${SESSION}:zip_other_agent`, { zipId: 'zip_other_agent', sessionId: SESSION, permanent: true, source: 'agent', path: 'c.ts', agentId: 'agent-other' })

    const released = await releaseDeletedAgentHolds(AGENT)

    expect(released).toEqual(
      expect.arrayContaining([
        { sessionId: SESSION, zipId: read },
        { sessionId: otherChat, zipId: 'zip_there' }
      ])
    )
    expect(released).toHaveLength(2)
    expect(await item(read)).toBeNull()
    expect(await redis.sMembers(`unzipped:${otherChat}`)).toEqual([])
    expect(await redis.get(`unzipped_item:${otherChat}:zip_there`)).toBeNull()
    expect(await item('zip_user')).toMatchObject({ source: 'user' })
    expect(await item('zip_other_agent')).toMatchObject({ agentId: 'agent-other' })
    expect((await redis.sMembers(`unzipped:${SESSION}`)).sort()).toEqual(['zip_other_agent', 'zip_user'])
  })

  it('releases the parked zip-control unzip too: it now carries the agent (BL-539)', async () => {
    await redis.createAgent({ id: AGENT, user_id: 'user-1', name: 'Holder', displayName: 'Holder' } as any)
    const a = await wholeRead('a.ts')
    const outcome = await applyLegacyAgentZipActions({
      sessionId: SESSION,
      agentId: AGENT,
      unzip: ['tool_result_1'],
      zip: [],
      currentReply: current([a]),
      currentToolZipIds: [a]
    })
    expect(outcome.unzipped).toEqual([a])
    expect(await item(a)).toMatchObject({ source: 'agent', agentId: AGENT, permanent: true })

    expect(await releaseDeletedAgentHolds(AGENT)).toEqual([{ sessionId: SESSION, zipId: a }])
    expect(await item(a)).toBeNull()
    expect(await redis.sMembers(`unzipped:${SESSION}`)).toEqual([])
  })

  it("reads the chats of the agent's user, never the whole keyspace (BL-539)", async () => {
    await redis.createAgent({ id: AGENT, user_id: 'user-1', name: 'Holder', displayName: 'Holder' } as any)
    const read = await wholeRead('src/app.ts')
    await reply([read])
    await apply(['src/app.ts'])
    const keys = vi.spyOn(redis, 'keys')
    try {
      expect(await releaseDeletedAgentHolds(AGENT)).toEqual([{ sessionId: SESSION, zipId: read }])
      expect(keys).not.toHaveBeenCalled()
    } finally {
      keys.mockRestore()
    }
  })

  it('releases nothing for an agent with no record (no user, so no chats to read)', async () => {
    await redis.sAdd(`unzipped:${SESSION}`, 'zip_orphan_agent')
    await redis.set(`unzipped_item:${SESSION}:zip_orphan_agent`, { zipId: 'zip_orphan_agent', sessionId: SESSION, permanent: true, source: 'agent', path: 'a.ts', agentId: 'agent-no-record' })
    expect(await releaseDeletedAgentHolds('agent-no-record')).toEqual([])
  })

  it.runIf(REAL_REDIS_LANE)('redis.deleteAgent runs the release before it deletes the agent', async () => {
    const agentId = `agent-deleted-${Date.now()}`
    await redis.createAgent({ id: agentId, user_id: 'user-1', name: 'Deleted', displayName: 'Deleted' } as any)
    await redis.sAdd(`unzipped:${SESSION}`, 'zip_gone')
    await redis.set(`unzipped_item:${SESSION}:zip_gone`, { zipId: 'zip_gone', sessionId: SESSION, permanent: true, source: 'agent', path: 'a.ts', agentId })
    expect(await redis.deleteAgent(agentId)).toEqual({ releasedHolds: [{ sessionId: SESSION, zipId: 'zip_gone' }] })
    expect(await item('zip_gone')).toBeNull()
    expect(await redis.sMembers(`unzipped:${SESSION}`)).toEqual([])
  })
})

describe('the countdown (DL-08)', () => {
  it('counts one message on every temporary hold, and ends one whose count reaches its duration', async () => {
    await redis.sAdd(`unzipped:${SESSION}`, 'zip_temp')
    await redis.set(`unzipped_item:${SESSION}:zip_temp`, { zipId: 'zip_temp', sessionId: SESSION, permanent: false, duration: 2, messageCount: 0, unzippedAt: 1, source: 'user' })
    await userHold('zip_forever')

    expect(await advanceZipCountdowns(SESSION)).toEqual({ counted: ['zip_temp'], ended: [] })
    expect(await item('zip_temp')).toMatchObject({ messageCount: 1 })

    expect(await advanceZipCountdowns(SESSION)).toEqual({ counted: [], ended: ['zip_temp'] })
    expect(await item('zip_temp')).toBeNull()
    expect(await redis.sMembers(`unzipped:${SESSION}`)).toEqual(['zip_forever'])
    expect(await item('zip_forever')).toMatchObject({ permanent: true })
  })

  it('never counts a hold marked permanent, even one that also carries a duration', async () => {
    await userHold('zip_forever', { duration: 1, messageCount: 0 })
    expect(await advanceZipCountdowns(SESSION)).toEqual({ counted: [], ended: [] })
    expect(await item('zip_forever')).toMatchObject({ permanent: true, messageCount: 0 })
  })

  it('does nothing in a chat with no temporary hold', async () => {
    await userHold('zip_forever')
    expect(await advanceZipCountdowns(SESSION)).toEqual({ counted: [], ended: [] })
  })
})

describe('the parked zip-control actions (DL-06)', () => {
  it('refuses a too-large legacy unzip with a control error', async () => {
    const read = await tooLargeWholeRead('huge.ts')
    const outcome = await applyLegacyAgentZipActions({
      sessionId: SESSION,
      agentId: AGENT,
      unzip: ['tool_result_1'],
      zip: [],
      currentReply: current([read]),
      currentToolZipIds: [read]
    })
    expect(outcome.unzipped).toEqual([])
    expect(outcome.errors?.[0]).toMatchObject({ tag: 'batshit-zip-control' })
    expect(outcome.errors?.[0].error).toContain('25,000 tokens')
    expect(await item(read)).toBeNull()

    await userHold(read)
    const repeated = await applyLegacyAgentZipActions({
      sessionId: SESSION,
      agentId: AGENT,
      unzip: ['tool_result_1'],
      zip: [],
      currentReply: current([read]),
      currentToolZipIds: [read]
    })
    expect(repeated.errors?.[0].error).toContain('too large to open')
    expect(await item(read)).toMatchObject({ source: 'user' })
  })

  it('unzips by tool_result_N alias and zips by id, never touching the user\'s lock', async () => {
    const a = await wholeRead('a.ts')
    const b = await wholeRead('b.ts')
    await reply([b])
    await userHold(b)
    const reply1 = current([a])
    const outcome = await applyLegacyAgentZipActions({
      sessionId: SESSION,
      agentId: AGENT,
      unzip: ['tool_result_1'],
      zip: [b],
      currentReply: reply1,
      currentToolZipIds: [a]
    })
    expect(outcome.unzipped).toEqual([a])
    expect(outcome.zipped).toEqual([])
    // BL-360: the refused zip is a loud line, never a silent skip.
    expect(outcome.errors?.map((error) => error.error)).toEqual([
      `The user holds ${b}, so it stays open; only the user can zip it.`
    ])
    expect(outcome.errors?.[0]).toMatchObject({ tag: 'batshit-zip-control' })
    expect(await item(a)).toMatchObject({ source: 'agent', permanent: true })
    expect(await item(a)).not.toHaveProperty('path')
    expect(await item(b)).toMatchObject({ source: 'user' })
  })

  it("never re-unzips over the user's own hold (it would turn the user's lock into the agent's)", async () => {
    const a = await wholeRead('a.ts')
    await userHold(a, { permanent: false, duration: 10, messageCount: 2 })
    const outcome = await applyLegacyAgentZipActions({
      sessionId: SESSION,
      agentId: AGENT,
      unzip: ['tool_result_1'],
      zip: [],
      currentReply: current([a]),
      currentToolZipIds: [a]
    })
    expect(outcome.unzipped).toEqual([])
    expect(outcome.zipped).toEqual([])
    expect(outcome.errors?.map((error) => error.error)).toEqual([
      `The user already holds ${a}; your unzip was not needed.`
    ])
    expect(await item(a)).toMatchObject({ source: 'user', duration: 10, messageCount: 2 })
  })

  /** The user's "Zip now", as `DELETE /api/unzipping/[zipId]` writes it. */
  async function userZipNow(zip: string) {
    await redis.sAdd(`rezipped:${SESSION}`, zip)
    await redis.set(`rezipped_item:${SESSION}:${zip}`, { zipId: zip, sessionId: SESSION, source: 'user', rezippedAt: 1 })
  }

  const legacy = (unzip: string[], zip: string[], zipIds: string[]) =>
    applyLegacyAgentZipActions({
      sessionId: SESSION,
      agentId: AGENT,
      unzip,
      zip,
      currentReply: current(zipIds),
      currentToolZipIds: zipIds
    })

  // BL-360: `writeUnzippedItem` deletes the rezip marker, and the parked path checked only the
  // user's holds, so a legacy unzip undid the user's "Zip now" without a word.
  it('never undoes the user\'s "Zip now", and says so (BL-360)', async () => {
    const a = await wholeRead('a.ts')
    await userZipNow(a)

    const outcome = await legacy(['tool_result_1'], [], [a])

    expect(outcome.unzipped).toEqual([])
    expect(outcome.errors?.map((error) => error.error)).toEqual([
      `The user zipped ${a} by hand, so it stays compressed; ask the user if you need it open.`
    ])
    expect(await item(a)).toBeNull()
    expect(await redis.sMembers(`unzipped:${SESSION}`)).toEqual([])
    expect(await redis.sMembers(`rezipped:${SESSION}`)).toEqual([a])
    expect(await redis.get(`rezipped_item:${SESSION}:${a}`)).toMatchObject({ source: 'user' })
  })

  it('a legacy zip of what the user zipped keeps the marker the user\'s, and says so (BL-360)', async () => {
    const a = await wholeRead('a.ts')
    await reply([a])
    await userZipNow(a)

    const outcome = await legacy([], [a], [])

    expect(outcome.zipped).toEqual([])
    expect(outcome.errors?.map((error) => error.error)).toEqual([
      `The user already zipped ${a} by hand; your zip was not needed.`
    ])
    expect(await redis.get(`rezipped_item:${SESSION}:${a}`)).toMatchObject({ source: 'user', rezippedAt: 1 })
  })

  it('an id that matches nothing in this chat is a loud line, not a silent drop (BL-360)', async () => {
    const a = await wholeRead('a.ts')

    const outcome = await legacy(['tool_result_4'], ['cool_tool_1790500000000_nothere'], [a])

    expect(outcome).toMatchObject({ unzipped: [], zipped: [] })
    expect(outcome.errors?.map((error) => error.error)).toEqual([
      'Nothing in this chat matches tool_result_4, so nothing was unzipped.',
      'Nothing in this chat matches cool_tool_1790500000000_nothere, so nothing was zipped.'
    ])
  })

  it('an unzip of a result an agent already holds open changes nothing and is no refusal', async () => {
    const a = await wholeRead('a.ts')
    await reply([a])
    await apply(['a.ts'])

    const outcome = await legacy([a], [], [])

    expect(outcome).toEqual({ unzipped: [], zipped: [] })
    expect(await item(a)).toMatchObject({ source: 'agent', path: expect.any(String) })
  })

  it('reads the user\'s "Zip now" under the chat\'s zip state lock: a click queued first wins (BL-352, BL-360)', async () => {
    const a = await wholeRead('a.ts')
    let open!: () => void
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const holder = withZipStateLock(SESSION, () => gate)
    const click = userReleaseRoute({
      params: { zipId: a },
      url: new URL(`http://batshit.test/api/unzipping/${a}?sessionId=${SESSION}`),
      locals: { user: { id: 'user-1' } }
    } as any)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const step = legacy(['tool_result_1'], [], [a])
    await new Promise((resolve) => setTimeout(resolve, 5))
    open()
    await holder
    expect((await click).status).toBe(200)
    const outcome = await step

    expect(outcome.unzipped).toEqual([])
    expect(outcome.errors?.[0].error).toContain('The user zipped')
    expect(await redis.sMembers(`rezipped:${SESSION}`)).toEqual([a])
    expect(await item(a)).toBeNull()
  })
})

/**
 * BL-537: a Release was four separate Redis writes, and so was a Hold. When Redis failed after the
 * first, the step's lists said nothing was written, yet the chat's state was half changed: a Release
 * left an item record with no set member (a hold no reader sees and no Release can reach), a Hold a
 * set member with no record. Each is one MULTI now: a lost connection lands none of it (an error
 * inside EXEC, such as WRONGTYPE, would still apply the other commands; these keys have one type).
 */
describe('a Release or a Hold that fails lands whole or not at all (BL-537)', () => {
  let restore: (() => void) | null = null
  afterEach(() => {
    restore?.()
    restore = null
  })

  it('a Release that fails leaves the hold whole: its set member and its record', async () => {
    const read = await wholeRead('src/app.ts')
    await reply([read])
    await apply(['src/app.ts'])
    restore = failRedisWritesTouching((key) => key === `unzipped_item:${SESSION}:${read}`)

    const changes = await apply([], ['src/app.ts'])

    expect(changes.failure).toBe('Redis connection lost')
    expect(changes.released).toEqual([])
    restore()
    restore = null
    expect(await redis.sMembers(`unzipped:${SESSION}`)).toEqual([read])
    expect(await item(read)).toMatchObject({ source: 'agent', agentId: AGENT })
  })

  it('a Hold that fails leaves no set member without its record', async () => {
    const read = await wholeRead('src/app.ts')
    await reply([read])
    restore = failRedisWritesTouching((key) => key === `unzipped_item:${SESSION}:${read}`)

    const changes = await apply(['src/app.ts'])

    expect(changes.failure).toBe('Redis connection lost')
    expect(changes.held).toEqual([])
    restore()
    restore = null
    expect(await redis.sMembers(`unzipped:${SESSION}`)).toEqual([])
    expect(await item(read)).toBeNull()
  })

  it('a parked zip action that fails leaves no half-written rezip', async () => {
    const a = await wholeRead('a.ts')
    await redis.sAdd(`unzipped:${SESSION}`, a)
    await redis.set(`unzipped_item:${SESSION}:${a}`, { zipId: a, sessionId: SESSION, permanent: true, source: 'agent', agentId: AGENT })
    restore = failRedisWritesTouching((key) => key === `rezipped_item:${SESSION}:${a}`)

    const outcome = await applyLegacyAgentZipActions({
      sessionId: SESSION,
      agentId: AGENT,
      unzip: [],
      zip: ['tool_result_1'],
      currentReply: current([a]),
      currentToolZipIds: [a]
    })

    expect(outcome.failure).toBe('Redis connection lost')
    expect(outcome.zipped).toEqual([])
    restore()
    restore = null
    // Nothing of the rezip landed: the agent's unzip is still whole.
    expect(await redis.sMembers(`unzipped:${SESSION}`)).toEqual([a])
    expect(await item(a)).toMatchObject({ source: 'agent' })
    expect(await redis.sMembers(`rezipped:${SESSION}`)).toEqual([])
  })
})

/**
 * BL-606: `releaseDeletedAgentHolds` goes chat by chat, and a turn of the agent that still runs (a
 * group chat, a kept locked chat, or any chat when "Also delete its chats" is off) could finish in
 * a chat the release had already passed and hold a file there for an agent that no longer exists,
 * with nothing left to release it. An agent writes no zip state while its delete is under way
 * (`markAgentBeingDeleted`, set by `redis.deleteAgent` before the release) or once its record is
 * gone.
 */
describe('a turn of an agent being deleted writes no hold (BL-606)', () => {
  let restore: (() => void) | null = null
  afterEach(() => {
    restore?.()
    restore = null
  })

  /** Pauses the release at its read of `key` (a chat's held set) until `open()`. */
  function pauseReleaseAt(key: string) {
    let open!: () => void
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    let reached!: () => void
    const readDone = new Promise<void>((resolve) => {
      reached = resolve
    })
    const original = (redis.sMembers as any).getMockImplementation?.() ?? redis.sMembers.bind(redis)
    let paused = false
    const spy = vi.spyOn(redis, 'sMembers').mockImplementation(async (k: string) => {
      const value = await original(k)
      if (!paused && k === key) {
        paused = true
        reached()
        await gate
      }
      return value
    })
    restore = () => spy.mockRestore()
    return { open, readDone }
  }

  it('a reply that ends in a chat the release already passed holds nothing, and says why', async () => {
    const read = await wholeRead('src/app.ts')
    await reply([read])
    // A second chat of the same user, released after this one (the release goes in id order).
    const laterChat = `${SESSION}-second`
    await redis.createSession({ id: laterChat, user_id: 'user-1', title: 'Second', agent_id: AGENT } as any)

    // The delete's own order: mark, release chat by chat, delete the record, let go.
    const done = markAgentBeingDeleted(AGENT)
    const pause = pauseReleaseAt(`unzipped:${laterChat}`)
    const release = releaseDeletedAgentHolds(AGENT)
    await pause.readDone
    // The release has passed this chat; the agent's reply here ends now and asks for a hold.
    const changes = await apply(['src/app.ts'])
    pause.open()
    await release
    await redis.del(`agent:${AGENT}`)
    done()

    expect(changes.held).toEqual([])
    expect(changes.errors.map((error) => error.error)).toEqual([
      'This agent is being deleted, so its holds and releases were not applied.'
    ])
    expect(await redis.sMembers(`unzipped:${SESSION}`)).toEqual([])
    expect(await item(read)).toBeNull()
  })

  it('a reply that ends after the delete finished holds nothing (its record is gone)', async () => {
    const read = await wholeRead('src/app.ts')
    await reply([read])
    await redis.del(`agent:${AGENT}`)

    const changes = await apply(['src/app.ts'])

    expect(changes.held).toEqual([])
    expect(changes.errors).toHaveLength(1)
    expect(await redis.sMembers(`unzipped:${SESSION}`)).toEqual([])
  })

  it('an agent that is not being deleted holds as before once the mark is let go (a failed delete)', async () => {
    const read = await wholeRead('src/app.ts')
    await reply([read])
    const done = markAgentBeingDeleted(AGENT)
    done()
    done()

    expect((await apply(['src/app.ts'])).held).toEqual([{ path: 'src/app.ts', zipId: read }])
  })

  it('the parked zip actions of an agent being deleted write nothing, and fail loudly', async () => {
    const a = await wholeRead('a.ts')
    const done = markAgentBeingDeleted(AGENT)
    try {
      const outcome = await applyLegacyAgentZipActions({
        sessionId: SESSION,
        agentId: AGENT,
        unzip: ['tool_result_1'],
        zip: [],
        currentReply: current([a]),
        currentToolZipIds: [a]
      })
      expect(outcome.unzipped).toEqual([])
      expect(outcome.failure).toBe('This agent is being deleted, so its holds and releases were not applied.')
    } finally {
      done()
    }
    expect(await item(a)).toBeNull()
  })

  it.runIf(REAL_REDIS_LANE)('through redis.deleteAgent: a reply that ends after the release passed its chat holds nothing', async () => {
    const read = await wholeRead('src/app.ts')
    await reply([read])
    const laterChat = `${SESSION}-second`
    await redis.createSession({ id: laterChat, user_id: 'user-1', title: 'Second', agent_id: AGENT } as any)

    const pause = pauseReleaseAt(`unzipped:${laterChat}`)
    const deleted = redis.deleteAgent(AGENT)
    await pause.readDone
    const changes = await apply(['src/app.ts'])
    pause.open()
    await deleted

    expect(changes.held).toEqual([])
    expect(await redis.sMembers(`unzipped:${SESSION}`)).toEqual([])
    expect(await redis.exists(`agent:${AGENT}`)).toBe(false)
  })
})
