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

  it('says loudly that zip actions were ignored when the hidden permission is off', async () => {
    const result = await finalize('Ok.\n<batshit-zip-control>{"unzip":["tool_result_1"]}</batshit-zip-control>')
    expect(result.content).toBe('Ok.')
    expect(result.metadata.controlErrors[0]).toMatchObject({
      tag: 'batshit-zip-control',
      error: 'Zip control is off for you, so the unzip and zip actions were ignored.'
    })
  })

  // SA-129 DL-06 (BL-1484): only the experiment key turns the parked actions on. The older key's
  // stored true (Josh's Mac app: global and three agents) is ignored, so the actions stay off.
  it('ignores a stored legacy zip_agent_control_enabled true, global or agent: the actions stay off', async () => {
    await readZip('cool_tool_1790600000000_fin03', 'b.ts')
    const result = await finalize(
      'Ok.\n{{batshit-zip:cool_tool_1790600000000_fin03}}\n<batshit-zip-control>{"unzip":["tool_result_1"]}</batshit-zip-control>',
      {
        replyZipIds: ['cool_tool_1790600000000_fin03'],
        agent: { ...AGENT, zip_agent_control_enabled: true, zip_control_mode: 'agent' },
        globalZipSettings: { zip_agent_control_enabled: true }
      }
    )
    expect(result.metadata.controlErrors?.[0]).toMatchObject({
      tag: 'batshit-zip-control',
      error: 'Zip control is off for you, so the unzip and zip actions were ignored.'
    })
    expect(await redis.get(`unzipped_item:${SESSION}:cool_tool_1790600000000_fin03`)).toBeNull()
  })

  it('the global experiment key turns the parked actions on for an agent with no key of its own', async () => {
    await readZip('cool_tool_1790600000000_fin04', 'c.ts')
    const result = await finalize(
      'Ok.\n{{batshit-zip:cool_tool_1790600000000_fin04}}\n<batshit-zip-control>{"unzip":["tool_result_1"]}</batshit-zip-control>',
      { replyZipIds: ['cool_tool_1790600000000_fin04'], globalZipSettings: { zip_agent_control_experiment: true } }
    )
    expect(result.zipStateChanged).toBe('agent')
    expect(await redis.get(`unzipped_item:${SESSION}:cool_tool_1790600000000_fin04`)).toMatchObject({ source: 'agent' })
  })

  it('applies the parked zip actions when the hidden permission is on', async () => {
    await readZip('cool_tool_1790600000000_fin02', 'a.ts')
    const result = await finalize(
      'Ok.\n{{batshit-zip:cool_tool_1790600000000_fin02}}\n<batshit-zip-control>{"unzip":["tool_result_1"]}</batshit-zip-control>',
      { replyZipIds: ['cool_tool_1790600000000_fin02'], agent: { ...AGENT, zip_agent_control_experiment: true } }
    )
    expect(result.zipStateChanged).toBe('agent')
    // BL-539: the record names the agent, so deleting the agent releases it.
    expect(await redis.get(`unzipped_item:${SESSION}:cool_tool_1790600000000_fin02`)).toMatchObject({
      source: 'agent',
      permanent: true,
      agentId: AGENT.id
    })
  })

  it('records a too-large parked unzip refusal on the reply', async () => {
    const zipId = 'cool_tool_1790600000000_largezip'
    await readZip(zipId, 'huge.ts')
    const zip = await redis.getZip(zipId)
    await redis.execute((client: any) => client.json.set(`zip:${zipId}`, '$', {
      ...zip,
      metadata: { ...zip.metadata, promptTokens: 25_000, tokenBasis: 'ai_expanded' }
    }))
    const result = await finalize(
      `Ok.\n{{batshit-zip:${zipId}}}\n<batshit-zip-control>{"unzip":["tool_result_1"]}</batshit-zip-control>`,
      { replyZipIds: [zipId], agent: { ...AGENT, zip_agent_control_experiment: true } }
    )
    expect(result.metadata.controlErrors?.[0]).toMatchObject({ tag: 'batshit-zip-control' })
    expect(result.metadata.controlErrors?.[0].error).toContain('25,000 tokens')
    expect(await redis.get(`unzipped_item:${SESSION}:${zipId}`)).toBeNull()
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

  it('a parked zip action that failed', async () => {
    await readZip('cool_tool_1790600000000_fin22', 'src/a.ts')
    restore = failRedisWritesTouching((key) => key === `unzipped_item:${SESSION}:cool_tool_1790600000000_fin22`)

    const result = await finalize(
      `Unzip.\n{{batshit-zip:cool_tool_1790600000000_fin22}}\n<batshit-zip-control>{"unzip":["cool_tool_1790600000000_fin22"]}</batshit-zip-control>`,
      { replyZipIds: ['cool_tool_1790600000000_fin22'], agent: { ...AGENT, zip_agent_control_experiment: true } }
    )

    expect(result.zipStateChanged).toBe('agent')
    expect(JSON.stringify(result.metadata.controlErrors)).toContain("could not finish this reply's zip actions")
  })

  it('a countdown that failed', async () => {
    await redis.sAdd(`unzipped:${SESSION}`, 'zip_temp')
    await redis.set(`unzipped_item:${SESSION}:zip_temp`, { zipId: 'zip_temp', sessionId: SESSION, permanent: false, duration: 5, messageCount: 0, unzippedAt: 1, source: 'user' })
    restore = failRedisWritesTouching((key) => key === `unzipped_item:${SESSION}:zip_temp`)

    const result = await finalize('Just words.')

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
