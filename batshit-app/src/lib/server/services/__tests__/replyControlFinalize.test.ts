// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { failRedisWritesTouching } from '$lib/test-utils/redisWriteFailures'

const memoryCalls = vi.hoisted(() => ({ calls: [] as any[], results: [] as any[] }))
vi.mock('$lib/server/services/memory/memoryTools', () => ({
  processInlineMemorySaves: vi.fn(async (options: any) => {
    memoryCalls.calls.push(options)
    return memoryCalls.results
  })
}))

import { MAX_INLINE_MEMORY_SAVE_BLOCKS, finalizeReplyControl } from '../replyControlFinalize'
import { buildControlErrorDcmLines } from '$lib/utils/controlTags'

/**
 * SA-129 P2 (DL-08, BL-234): the reply-end control step runs on the server, so a reply that no
 * chat page finalizes (a woken turn, a schedule, isolated test driver, the benchmark driver) stores the same
 * notes, holds, memory saves, and control errors as an open chat page. These drive the step
 * exactly as `send-routed` does, with no browser anywhere.
 */

useRedisTestServer()

const AGENT = { id: 'agent-final', name: 'Opie', memory_enabled: true }
let SESSION = ''
let counter = 0

beforeEach(async () => {
  counter += 1
  SESSION = `reply-control-${counter}-${Date.now()}`
  memoryCalls.calls = []
  memoryCalls.results = []
  await redis.createSession({ id: SESSION, user_id: 'user-1', title: 'Reply control', agent_id: AGENT.id } as any)
  // An agent writes zip state only while its record exists (BL-606).
  await redis.createAgent({ id: AGENT.id, user_id: 'user-1', name: AGENT.name } as any)
})

async function readZip(id: string, path: string) {
  const payload = { operationKind: 'read_file', toolName: 'read_file', toolArgs: { filePath: path }, toolResult: { filePath: path, content: 'x', lineCount: 1 } }
  await redis.execute((client: any) =>
    client.json.set(`zip:${id}`, '$', { id, type: 'cool_tool', content: JSON.stringify(payload), tokens: 5, metadata: { operationKind: 'read_file' } })
  )
}

function finalize(content: string, overrides: Record<string, any> = {}) {
  return finalizeReplyControl({
    userId: 'user-1',
    sessionId: SESSION,
    messageId: `msg_${counter}`,
    agent: AGENT,
    globalZipSettings: {},
    content,
    replyZipIds: [],
    projectPath: '/work/proj',
    countsAsMessage: true,
    ...overrides
  })
}

describe('finalizeReplyControl (a headless reply)', () => {
  it('stores the notes and returns the cleaned text, with the flag `/api/sse` reads', async () => {
    const result = await finalize(
      'All done.\n<batshit-tool-notes>{"notes":[{"toolName":"bash","summary":"tests pass"}]}</batshit-tool-notes>'
    )
    expect(result.content).toBe('All done.')
    expect(result.metadata).toMatchObject({
      replyControlFinalized: true,
      zipControl: { unzip: [], zip: [], toolResultsSummary: [{ toolName: 'bash', summary: 'tests pass' }] }
    })
    expect(result.metadata.controlErrors).toBeUndefined()
  })

  it('with Tool Notes off, keeps no notes and says so on the reply, naming the Whiteboard only when the compile offered it (BL-1785)', async () => {
    const reply = 'All done.\n<batshit-tool-notes>{"notes":[{"toolName":"bash","summary":"tests pass"}]}</batshit-tool-notes>'
    const agent = { ...AGENT, zip_tool_notes_enabled: false }
    for (const [whiteboardAvailable, hint] of [
      [true, 'Put what you still need on your Whiteboard, or hold a file you still need open; Fetch Zip shows any earlier result again.'],
      [false, 'Hold a file you still need open; Fetch Zip shows any earlier result again.']
    ] as const) {
      const result = await finalize(reply, { agent, whiteboardAvailable })
      expect(result.metadata.zipControl?.toolResultsSummary).toEqual([])
      expect(result.metadata.controlErrors).toEqual([expect.objectContaining({
        tag: 'batshit-tool-notes', error: 'Tool Notes are off for this agent; the notes in this reply were not saved.', hint
      })])
    }
  })

  it('with Tool Notes off, a refused hold\'s fix line names no notes (BL-1785 review M1)', async () => {
    const result = await finalize('Keep it.\n<batshit-tool-notes>{"hold":["src/missing.ts"]}</batshit-tool-notes>', {
      agent: { ...AGENT, zip_tool_notes_enabled: false }
    })
    expect(result.metadata.controlErrors).toEqual([expect.objectContaining({
      hint: 'Use <batshit-tool-notes>{"hold":["path/to/file"],"release":["path/to/file"]}</batshit-tool-notes>; leave out notes.'
    })])
    const on = await finalize('Keep it.\n<batshit-tool-notes>{"hold":["src/missing.ts"]}</batshit-tool-notes>')
    expect(on.metadata.controlErrors[0].hint).toContain('"notes"')
  })

  it('holds the file the reply read and says the zip state changed', async () => {
    await readZip('cool_tool_1790600000000_fin01', 'src/app.ts')
    const result = await finalize(
      'Read it.\n{{batshit-zip:cool_tool_1790600000000_fin01}}\n<batshit-tool-notes>{"hold":["src/app.ts"]}</batshit-tool-notes>',
      { replyZipIds: ['cool_tool_1790600000000_fin01'] }
    )
    expect(result.zipStateChanged).toBe('agent')
    expect(result.metadata.zipHolds).toEqual({ held: [{ path: 'src/app.ts', zipId: 'cool_tool_1790600000000_fin01' }] })
    expect(await redis.get(`unzipped_item:${SESSION}:cool_tool_1790600000000_fin01`)).toMatchObject({
      source: 'agent',
      path: 'src/app.ts',
      agentId: AGENT.id
    })
  })

  it('saves memory blocks as the SERVER-vouched agent, and keeps the saves on the reply', async () => {
    memoryCalls.results = [{ index: 0, saved: { id: 'mem_1', lane: 'ltm', gist: 'likes short replies' } }]
    const result = await finalize('Noted.\n<batshit-memory>{"lane":"ltm","content":"Josh likes short replies","importance":6}</batshit-memory>')
    expect(result.content).toBe('Noted.')
    expect(result.hadMemoryBlock).toBe(true)
    expect(memoryCalls.calls).toHaveLength(1)
    expect(memoryCalls.calls[0]).toMatchObject({ userId: 'user-1', agentId: AGENT.id, sessionId: SESSION })
    expect(result.metadata.memorySaves).toEqual([{ id: 'mem_1', lane: 'ltm', gist: 'likes short replies' }])
  })

  it('refuses memory saves loudly when memory is off for the agent', async () => {
    const result = await finalize('Noted.\n<batshit-memory>{"lane":"ltm","content":"x","importance":6}</batshit-memory>', {
      agent: { id: 'agent-final', memory_enabled: false }
    })
    expect(memoryCalls.calls).toEqual([])
    expect(result.metadata.controlErrors[0]).toMatchObject({
      tag: 'batshit-memory',
      error: 'Memory is not enabled for this agent; the memory save block(s) were not stored.'
    })
  })

  it('refuses more memory blocks than one message may carry, without saving any', async () => {
    const block = '<batshit-memory>{"lane":"ltm","content":"x","importance":6}</batshit-memory>'
    const result = await finalize(`Noted.\n${Array.from({ length: MAX_INLINE_MEMORY_SAVE_BLOCKS + 1 }, () => block).join('\n')}`)
    expect(memoryCalls.calls).toEqual([])
    expect(result.metadata.controlErrors[0].error).toContain('at most 12 memory save blocks')
  })

  // Decision 7 (Josh, 2026-10-23): agent zip control is retired. The `zip_agent_control_experiment`
  // key is retired with it and must not turn anything on, whoever carries it.
  it('ignores a reply\'s unzip and zip actions with one loud error, changing no zip state, even with the retired experiment key set', async () => {
    const zipId = 'cool_tool_1790600000000_fin02'
    await readZip(zipId, 'a.ts')
    const reply = `Ok.\n{{batshit-zip:${zipId}}}\n<batshit-zip-control>{"unzip":["tool_result_1"],"zip":["x"]}</batshit-zip-control>`
    const expected = {
      tag: 'batshit-zip-control',
      error: 'Agents cannot unzip or zip results, so the unzip and zip actions were ignored.',
      hint: 'To keep a file you read open, hold it: <batshit-tool-notes>{"hold":["path/to/file"]}</batshit-tool-notes>. Use Fetch Zip to read an earlier result.'
    }

    for (const [agent, globalZipSettings] of [
      [AGENT, {}],
      [{ ...AGENT, zip_agent_control_experiment: true }, { zip_agent_control_experiment: true }]
    ] as const) {
      const result = await finalize(reply, { replyZipIds: [zipId], agent, globalZipSettings })
      expect(result.content).toBe(`Ok.\n{{batshit-zip:${zipId}}}`)
      expect(result.metadata.controlErrors).toEqual([expect.objectContaining(expected)])
      expect(result.metadata.zipHolds).toBeUndefined()
      expect(result.zipStateChanged).toBeNull()
      expect(await redis.get(`unzipped_item:${SESSION}:${zipId}`)).toBeNull()
      expect(await redis.sMembers(`unzipped:${SESSION}`)).toEqual([])
      expect(await redis.sMembers(`rezipped:${SESSION}`)).toEqual([])
    }
  })

  it('counts the reply toward a temporary hold, except an approval resume (the same message)', async () => {
    await redis.sAdd(`unzipped:${SESSION}`, 'zip_temp')
    await redis.set(`unzipped_item:${SESSION}:zip_temp`, { zipId: 'zip_temp', sessionId: SESSION, permanent: false, duration: 5, messageCount: 0, unzippedAt: 1, source: 'user' })

    const resumed = await finalize('Continued.', { countsAsMessage: false })
    expect(resumed.zipStateChanged).toBeNull()
    expect(await redis.get(`unzipped_item:${SESSION}:zip_temp`)).toMatchObject({ messageCount: 0 })

    const fresh = await finalize('New reply.')
    expect(fresh.zipStateChanged).toBe('countdown')
    expect(await redis.get(`unzipped_item:${SESSION}:zip_temp`)).toMatchObject({ messageCount: 1 })
  })
})

/**
 * BL-538: with several Tool Notes blocks, the last hold or release of a FILE counts, not of a
 * spelling. The merge compared the raw path text, so `hold src/a.ts` then `release ./src/a.ts`
 * ended held. The blocks now reach the hold step in order, and it compares paths by file.
 */
describe('finalizeReplyControl with several Tool Notes blocks naming one file two ways (BL-538)', () => {
  const ZIP = 'cool_tool_1790600000000_bl538'
  const notes = (payload: Record<string, string[]>) => `<batshit-tool-notes>${JSON.stringify(payload)}</batshit-tool-notes>`
  const readAndSay = (...blocks: string[]) => [`Read it.\n{{batshit-zip:${ZIP}}}`, ...blocks].join('\n')

  for (const spelling of ['./src/a.ts', '/work/proj/src/a.ts', 'src/a.ts']) {
    it(`hold src/a.ts, then release ${spelling}: not held`, async () => {
      await readZip(ZIP, 'src/a.ts')
      const result = await finalize(readAndSay(notes({ hold: ['src/a.ts'] }), notes({ release: [spelling] })), {
        replyZipIds: [ZIP]
      })
      expect(await redis.get(`unzipped_item:${SESSION}:${ZIP}`)).toBeNull()
      expect(await redis.sMembers(`unzipped:${SESSION}`)).toEqual([])
      expect(result.metadata.zipHolds?.released).toEqual([{ path: 'src/a.ts', zipId: ZIP }])
    })

    it(`release ${spelling}, then hold src/a.ts, of a file already held: held`, async () => {
      await readZip(ZIP, 'src/a.ts')
      await finalize(readAndSay(notes({ hold: ['src/a.ts'] })), { replyZipIds: [ZIP] })
      await finalize(readAndSay(notes({ release: [spelling] }), notes({ hold: ['./src/a.ts'] })), {
        replyZipIds: [ZIP]
      })
      expect(await redis.get(`unzipped_item:${SESSION}:${ZIP}`)).toMatchObject({ source: 'agent', path: 'src/a.ts' })
    })
  }
})

/**
 * BL-353: each step fails on its own. Before, one throw anywhere (a Redis error in the countdown
 * after the holds and the memory saves landed) told the agent "Nothing you asked for in the
 * control blocks was applied; ask again", so it saved the same memories again.
 */
describe('finalizeReplyControl when Redis fails part way (BL-353)', () => {
  const restores: Array<() => void> = []
  afterEach(() => {
    while (restores.length > 0) restores.pop()!()
  })

  function failWhen(method: 'set' | 'sMembers', when: (key: string, ...rest: any[]) => boolean) {
    const original = (redis[method] as any).getMockImplementation?.() ?? (redis[method] as any).bind(redis)
    const spy = vi.spyOn(redis, method as any).mockImplementation(async (key: any, ...rest: any[]) => {
      if (when(key, ...rest)) throw new Error('Redis connection lost')
      return original(key, ...rest)
    })
    restores.push(() => spy.mockRestore())
  }

  const MEMORY_BLOCK = '<batshit-memory>{"lane":"ltm","content":"Josh likes short replies","importance":6}</batshit-memory>'

  it('a countdown that throws after the holds and the memory saves landed keeps them, and says only the countdown failed', async () => {
    await readZip('cool_tool_1790600000000_fin11', 'src/app.ts')
    await redis.sAdd(`unzipped:${SESSION}`, 'zip_temp')
    await redis.set(`unzipped_item:${SESSION}:zip_temp`, { zipId: 'zip_temp', sessionId: SESSION, permanent: false, duration: 5, messageCount: 0, unzippedAt: 1, source: 'user' })
    memoryCalls.results = [{ index: 0, saved: { id: 'mem_1', lane: 'ltm', gist: 'short replies' } }]
    // The countdown is the only reader of the held set after the memory step.
    failWhen('sMembers', (key) => key === `unzipped:${SESSION}` && memoryCalls.calls.length > 0)

    const result = await finalize(
      `Saved and held.\n{{batshit-zip:cool_tool_1790600000000_fin11}}\n<batshit-tool-notes>{"hold":["src/app.ts"]}</batshit-tool-notes>\n${MEMORY_BLOCK}`,
      { replyZipIds: ['cool_tool_1790600000000_fin11'] }
    )

    expect(result.metadata.zipHolds).toEqual({ held: [{ path: 'src/app.ts', zipId: 'cool_tool_1790600000000_fin11' }] })
    expect(result.metadata.memorySaves).toEqual([{ id: 'mem_1', lane: 'ltm', gist: 'short replies' }])
    expect(result.zipStateChanged).toBe('agent')
    expect(await redis.get(`unzipped_item:${SESSION}:cool_tool_1790600000000_fin11`)).toMatchObject({ source: 'agent' })
    const errors = result.metadata.controlErrors as Array<{ error: string; hint?: string }>
    expect(errors).toHaveLength(1)
    expect(errors[0].error).toContain('could not count this reply toward the results held for a number of messages')
    expect(errors[0].hint).toBe('Nothing for you to do.')
    expect(JSON.stringify(errors)).not.toContain('Nothing you asked for')
  })

  it('a hold step that stops part way says what it applied, and the memory step and the countdown still run', async () => {
    await readZip('cool_tool_1790600000000_fin12', 'src/a.ts')
    await readZip('cool_tool_1790600000000_fin13', 'src/b.ts')
    await redis.sAdd(`unzipped:${SESSION}`, 'zip_temp')
    await redis.set(`unzipped_item:${SESSION}:zip_temp`, { zipId: 'zip_temp', sessionId: SESSION, permanent: false, duration: 5, messageCount: 0, unzippedAt: 1, source: 'user' })
    memoryCalls.results = [{ index: 0, saved: { id: 'mem_2', lane: 'ltm', gist: 'short replies' } }]
    // The hold's writes are one MULTI (BL-537): the whole hold of b.ts fails, none of it lands.
    restores.push(failRedisWritesTouching((key) => key === `unzipped_item:${SESSION}:cool_tool_1790600000000_fin13`))

    const result = await finalize(
      `Held two.\n{{batshit-zip:cool_tool_1790600000000_fin12}}\n{{batshit-zip:cool_tool_1790600000000_fin13}}\n<batshit-tool-notes>{"hold":["src/a.ts","src/b.ts"]}</batshit-tool-notes>\n${MEMORY_BLOCK}`,
      { replyZipIds: ['cool_tool_1790600000000_fin12', 'cool_tool_1790600000000_fin13'] }
    )

    expect(result.metadata.zipHolds).toEqual({ held: [{ path: 'src/a.ts', zipId: 'cool_tool_1790600000000_fin12' }] })
    expect(result.zipStateChanged).toBe('agent')
    const errors = result.metadata.controlErrors as Array<{ error: string }>
    expect(errors).toHaveLength(1)
    expect(errors[0].error).toContain("Batshit could not finish this reply's holds and releases (Redis connection lost).")
    expect(errors[0].error).toContain('Applied before it stopped: held src/a.ts.')
    expect(result.metadata.memorySaves).toEqual([{ id: 'mem_2', lane: 'ltm', gist: 'short replies' }])
    expect(await redis.get(`unzipped_item:${SESSION}:zip_temp`)).toMatchObject({ messageCount: 1 })
  })
})

/**
 * BL-537: the flag that tells every tab to read the chat's zip state again was set only from the
 * lists of what a step wrote. A step that failed may have changed state all the same (its failing
 * write is in no list), so a failed step sets the flag too.
 */
describe('a reply-end step that failed still tells the tabs (BL-537)', () => {
  let restore: (() => void) | null = null
  afterEach(() => {
    restore?.()
    restore = null
  })

  it('a hold step that failed before it wrote anything', async () => {
    await readZip('cool_tool_1790600000000_fin21', 'src/a.ts')
    restore = failRedisWritesTouching((key) => key === `unzipped_item:${SESSION}:cool_tool_1790600000000_fin21`)

    const result = await finalize(
      `Held.\n{{batshit-zip:cool_tool_1790600000000_fin21}}\n<batshit-tool-notes>{"hold":["src/a.ts"]}</batshit-tool-notes>`,
      { replyZipIds: ['cool_tool_1790600000000_fin21'] }
    )

    expect(result.metadata.zipHolds).toBeUndefined()
    expect(result.zipStateChanged).toBe('agent')
  })

  it('a countdown that failed', async () => {
    await redis.sAdd(`unzipped:${SESSION}`, 'zip_temp')
    await redis.set(`unzipped_item:${SESSION}:zip_temp`, { zipId: 'zip_temp', sessionId: SESSION, permanent: false, duration: 5, messageCount: 0, unzippedAt: 1, source: 'user' })
    // Countdown now updates the strict JSON facade directly. Fail that actual
    // write rather than the retired redis.set path or an unrelated hold MULTI.
    const original = (redis.json.set as any).getMockImplementation?.() ?? redis.json.set.bind(redis.json)
    let failed = false
    const spy = vi.spyOn(redis.json, 'set').mockImplementation(async (key: any, ...args: any[]) => {
      if (key === `unzipped_item:${SESSION}:zip_temp`) {
        failed = true
        throw new Error('Redis connection lost')
      }
      return original(key, ...args)
    })
    restore = () => spy.mockRestore()

    const result = await finalize('Just words.')

    expect(failed).toBe(true)
    expect(await redis.get(`unzipped_item:${SESSION}:zip_temp`)).toMatchObject({ messageCount: 0 })
    expect(result.zipStateChanged).toBe('countdown')
    expect(JSON.stringify(result.metadata.controlErrors)).toContain('could not count this reply')
  })
})


describe('finalizeReplyControl: what counts as a control block (BL-442)', () => {
  const FOUR_BUG_CASES = [
    'Here is how I save a memory:',
    '```',
    '<batshit-memory>{"lane":"ltm","content":"an example, not a save"}</batshit-memory>',
    '```',
    'I write a <batshit-memory> block when you ask me to remember something.',
    'If the count is < 5, retry.'
  ].join('\n')

  it('saves only the correct block next to the four bug cases, and keeps every word of them', async () => {
    memoryCalls.results = [{ saved: { id: 'mem-1', lane: 'ltm', gist: 'Josh likes tea' } }]
    const result = await finalize(
      `${FOUR_BUG_CASES}\n<batshit-memory>{"lane":"ltm","content":"Josh likes tea"}</batshit-memory>\nThe end <`
    )
    expect(memoryCalls.calls).toHaveLength(1)
    expect(memoryCalls.calls[0].payloads.map((payload: any) => payload.content)).toEqual(['Josh likes tea'])
    expect(result.content).toBe(`${FOUR_BUG_CASES}\n\nThe end <`)
    expect(result.metadata.controlErrors).toBeUndefined()
    expect(result.metadata.memorySaves).toEqual([{ id: 'mem-1', lane: 'ltm', gist: 'Josh likes tea' }])
  })

  it('gives a memory-off agent no error for an example or a mention, and cuts nothing', async () => {
    const result = await finalize(FOUR_BUG_CASES, { agent: { ...AGENT, memory_enabled: false } })
    expect(memoryCalls.calls).toHaveLength(0)
    expect(result.hadMemoryBlock).toBe(false)
    expect(result.content).toBe(FOUR_BUG_CASES)
    expect(result.metadata.controlErrors).toBeUndefined()
  })

  it('gives a closed block with a bad payload the loud error, and hides it (R2 b)', async () => {
    const result = await finalize('Noted.\n<batshit-memory>lane: ltm, content: Josh likes tea</batshit-memory>')
    expect(memoryCalls.calls).toHaveLength(0)
    expect(result.content).toBe('Noted.')
    expect(result.metadata.controlErrors).toEqual([expect.objectContaining({ tag: 'batshit-memory' })])
  })

  it('hides a cut tag at the reply end with no error, and keeps a lone < (R4)', async () => {
    const cut = await finalize('The answer.\n<batshit-tool-no')
    expect(cut.content).toBe('The answer.')
    expect(cut.metadata.controlErrors).toBeUndefined()
    // A cut start is no block: no notes record, no zip-control record.
    expect(cut.metadata.zipControl).toBeUndefined()
    const cutZip = await finalize('The answer.\n<batshit-zip-co')
    expect(cutZip.content).toBe('The answer.')
    expect(cutZip.metadata.zipControl).toBeUndefined()
    // A cut start of a tag the reply end does not read (a cue) is hidden too.
    const cutCue = await finalize('The answer.\n<batshit-cu')
    expect(cutCue.content).toBe('The answer.')
    const lone = await finalize('If x is less than y, write x <')
    expect(lone.content).toBe('If x is less than y, write x <')
  })

  it('removes every memory block past the 20th and says how many were not saved', async () => {
    const reply = `Saved.\n${Array.from({ length: 23 }, (_, index) => `<batshit-memory>{"lane":"ltm","content":"fact ${index + 1}"}</batshit-memory>`).join('\n')}`
    const result = await finalize(reply)
    expect(result.content).toBe('Saved.')
    const errors = (result.metadata.controlErrors ?? []).map((entry: any) => entry.error)
    expect(errors).toContain(
      'This reply had 23 memory save blocks. Batshit read only the first 20; the other 3 were removed from the reply and not saved.'
    )
  })

  it('puts the memory cap line FIRST, so the next turn (which shows four tag errors) always sees it', async () => {
    const bad = Array.from({ length: 5 }, () => '<batshit-memory>{not json}</batshit-memory>')
    const good = Array.from({ length: 18 }, (_, index) => `<batshit-memory>{"lane":"ltm","content":"fact ${index + 1}"}</batshit-memory>`)
    const result = await finalize(`Saved.\n${[...bad, ...good].join('\n')}`)
    expect(result.metadata.controlErrors[0].error).toBe(
      'This reply had 23 memory save blocks. Batshit read only the first 20; the other 3 were removed from the reply and not saved.'
    )
    expect(buildControlErrorDcmLines([{ role: 'assistant', metadata: result.metadata }]).join('\n')).toContain(
      'the other 3 were removed from the reply and not saved'
    )
  })

  it('hides a Tool Notes block the reply was cut inside, with the loud error (BL-480, R3)', async () => {
    const result = await finalize('The answer.\n\n<batshit-tool-notes>{"notes":[{"toolName":"read","sum')
    expect(result.content).toBe('The answer.')
    expect(result.metadata.controlErrors).toEqual([
      expect.objectContaining({
        tag: 'batshit-tool-notes',
        error: 'Unclosed <batshit-tool-notes> block (missing </batshit-tool-notes>).'
      })
    ])
  })
})

describe('BL-695: a reply that is only an open cue block', () => {
  it('stores no words and one loud error the next turn reads', async () => {
    const result = await finalize('<batshit-cue>{"goon_mood":"happy"}')
    expect(result.content).toBe('')
    expect(result.metadata.controlErrors?.map((error: any) => error.tag)).toEqual(['batshit-cue'])
    expect(buildControlErrorDcmLines([{ role: 'assistant', metadata: result.metadata }]).join('\n')).toContain('<batshit-cue>: Unclosed')
  })

  it('keeps the words after an open cue block, with the same error', async () => {
    const result = await finalize('<batshit-cue>{"goon_mood":"happy"}\nThe answer is 4.')
    expect(result.content).toBe('The answer is 4.')
    expect(result.metadata.controlErrors?.map((error: any) => error.tag)).toEqual(['batshit-cue'])
  })
})
