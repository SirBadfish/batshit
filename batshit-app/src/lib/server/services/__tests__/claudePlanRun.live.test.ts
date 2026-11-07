// @vitest-environment node
/**
 * SA-139 P2 live proof against the REAL pinned Claude Code (2.1.296), signed in with the user's own
 * Claude plan. Skipped unless run deliberately; each case makes one or two short Haiku calls:
 *
 *   BATSHIT_LIVE_CLAUDE_PLAN=1 npx vitest run src/lib/server/services/__tests__/claudePlanRun.live.test.ts
 *
 * With BATSHIT_LIVE_CLAUDE_PLAN_RECORD=<folder> it also writes every stdout event and every hook and
 * MCP message of each case there (the D13 drift fixtures are curated from those recordings).
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { streamText, tool } from 'ai'
import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { bindClaudePlanExecutable, readClaudePlanAuthStatus, type ClaudePlanExecutable } from '../claudePlanExecutable'
import { ClaudePlanModel, wrapClaudePlanToolSet } from '../claudePlanModel'
import { TYPED_READ_FILE_MARKER } from '../typedFileTools'
import { listClaudePlanRuns } from '../claudePlanRunRegistry'
import { writeRecordingBridge } from './fixtures/claude-plan/recordingBridge'

vi.unmock('ai')

const LIVE = process.env.BATSHIT_LIVE_CLAUDE_PLAN === '1'
const RECORD = process.env.BATSHIT_LIVE_CLAUDE_PLAN_RECORD ?? ''

let executable: ClaudePlanExecutable
let work: string
let scriptsDir: string | undefined

function model(name: string, options: { effort?: string | null } = {}) {
  let stdout: string | null = null
  if (RECORD) {
    mkdirSync(RECORD, { recursive: true })
    stdout = path.join(RECORD, `${name}.stdout.jsonl`)
    scriptsDir = writeRecordingBridge(work, path.join(RECORD, `${name}.bridge.jsonl`))
  }
  return new ClaudePlanModel({
    modelId: 'claude-haiku-5-5', cliModel: 'claude-haiku-5-5', effort: options.effort ?? null,
    owner: { userId: 'live', sessionId: `live-${name}`, agentId: 'live', kind: 'primary' },
    workingDirectory: work, executable, runAs: {}, scriptsDir,
    onRawEvent: stdout ? event => appendFileSync(stdout!, JSON.stringify(event) + '\n') : undefined
  })
}

/** A small two-colour PNG (left magenta, right green), so Claude can say what it sees. */
function makePng(w = 64, h = 64): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(x < w / 2 ? [255, 0, 255] : [0, 160, 0], y * (w * 3 + 1) + 1 + x * 3)
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (bytes: Buffer) => { let c = 0xffffffff; for (const b of bytes) c = table[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data]); const check = Buffer.alloc(4); check.writeUInt32BE(crc(body))
    return Buffer.concat([length, body, check])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(w, 0); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const SYSTEM = { role: 'system' as const, content: 'You are a terse test assistant. Use the tools you are given exactly as asked. Answer in one short line.' }
const CODE_WORDS: Record<string, string> = { Paris: 'HERON', Oslo: 'PUFFIN', Rome: 'OTTER' }

function tools(timeline: Array<{ at: number; what: string }>) {
  return {
    get_weather: tool({
      description: 'Get the current weather for a city. Returns a code word.',
      inputSchema: z.object({ city: z.string() }).strict(),
      execute: async ({ city }) => {
        timeline.push({ at: Date.now(), what: `start ${city}` })
        await new Promise(resolve => setTimeout(resolve, 300))
        timeline.push({ at: Date.now(), what: `end ${city}` })
        return `${city}: sunny, 18 C (code word ${CODE_WORDS[city] ?? 'NONE'})`
      }
    }),
    read_file: Object.assign(tool({
      description: 'Read a text file from the project. Read-only.',
      inputSchema: z.object({ path: z.string() }).strict(),
      execute: async ({ path: file }) => {
        timeline.push({ at: Date.now(), what: `start ${file}` })
        await new Promise(resolve => setTimeout(resolve, 600))
        timeline.push({ at: Date.now(), what: `end ${file}` })
        return `${file} says: the secret word is ${file === 'a.txt' ? 'MAPLE' : 'CEDAR'}`
      }
    }), { [TYPED_READ_FILE_MARKER]: true })
  }
}

async function run(m: ClaudePlanModel, prompt: string, options: { tools?: Record<string, any>; abortSignal?: AbortSignal; prepareStep?: (step: { stepNumber: number }) => undefined; system?: string } = {}) {
  const result = await streamText({
    model: m, allowSystemInMessages: true, messages: [options.system ? { role: 'system' as const, content: options.system } : SYSTEM, { role: 'user', content: prompt }],
    ...(options.tools ? { tools: wrapClaudePlanToolSet(options.tools, m), repairToolCall: m.repairToolCall } : {}),
    ...(options.prepareStep ? { prepareStep: options.prepareStep } : {}),
    abortSignal: options.abortSignal, stopWhen: () => false, onEnd: () => m.endReply()
  })
  const parts: any[] = []
  for await (const part of result.stream) parts.push(part)
  const settlement = m.currentRun ? await m.currentRun.settled : null
  return {
    parts, settlement,
    text: parts.filter(p => p.type === 'text-delta').map(p => p.text).join(''),
    reasoning: parts.filter(p => p.type === 'reasoning-delta').map(p => p.text).join(''),
    steps: parts.filter(p => p.type === 'finish-step')
  }
}

describe.skipIf(!LIVE)('Claude plan run on the real pinned Claude Code', () => {
  beforeAll(async () => {
    executable = await bindClaudePlanExecutable()
    work = mkdtempSync(path.join(os.tmpdir(), 'sa139-p2-live-'))
  })
  afterAll(() => {
    rmSync(work, { recursive: true, force: true })
    // D10: no Claude Code session files for these runs (--no-session-persistence).
    const projects = path.join(os.homedir(), '.claude', 'projects')
    const slug = work.replace(/[^A-Za-z0-9]/g, '-')
    expect(spawnSync('ls', [projects], { encoding: 'utf8' }).stdout.split('\n').filter(name => name.includes(path.basename(work)) || name === slug)).toEqual([])
    const left = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n').filter(line => line.includes('/tmp/bcp-'))
    expect(left).toEqual([])
  })

  it('binds the pin and reads a Claude plan sign-in without a model call', async () => {
    expect(executable.version).toBe('2.1.296')
    const status = await readClaudePlanAuthStatus(executable)
    expect(status.state).toBe('plan')
  })

  it('a words-only reply with summarized thinking', async () => {
    const outcome = await run(model('words', { effort: 'high' }), 'Think briefly about why the sky looks blue, then reply with exactly: PONG')
    expect(outcome.text).toContain('PONG')
    expect(outcome.steps).toHaveLength(1)
    expect(outcome.steps[0].usage.outputTokens).toBeGreaterThan(0)
    expect(outcome.settlement).toBe('exited')
  }, 90_000)

  it('summarized thinking streams as reasoning (D12)', async () => {
    const outcome = await run(model('thinking', { effort: 'high' }), 'A bat and a ball cost 1.10 together. The bat costs 1.00 more than the ball. How much is the ball? Think it through, then answer in one short line.')
    expect(outcome.reasoning.length).toBeGreaterThan(0)
    expect(outcome.text.length).toBeGreaterThan(0)
  }, 90_000)

  it('one call on a strict schema: admitted, run once, released, answered', async () => {
    const timeline: Array<{ at: number; what: string }> = []
    const outcome = await run(model('one-call'), 'Call get_weather for Paris once. Then answer with the code word only.', { tools: tools(timeline) })
    expect(timeline.map(t => t.what)).toEqual(['start Paris', 'end Paris'])
    expect(outcome.text).toContain('HERON')
    expect(outcome.settlement).toBe('exited')
  }, 90_000)

  it('three write calls in one message run one at a time and all reach Claude', async () => {
    const timeline: Array<{ at: number; what: string }> = []
    const outcome = await run(model('three-calls'), 'Get the weather for Paris, Oslo and Rome IN PARALLEL: make all three get_weather tool calls in ONE message. Then answer with the three code words.', { tools: tools(timeline) })
    const starts = timeline.filter(t => t.what.startsWith('start'))
    expect(starts).toHaveLength(3)
    for (let i = 1; i < timeline.length; i++) if (timeline[i].what.startsWith('start')) expect(timeline[i - 1].what.startsWith('end')).toBe(true)
    for (const word of ['HERON', 'PUFFIN', 'OTTER']) expect(outcome.text).toContain(word)
    expect(outcome.settlement).toBe('exited')
  }, 120_000)

  it('read-only calls in one message run together', async () => {
    const timeline: Array<{ at: number; what: string }> = []
    const outcome = await run(model('read-only'), 'Read a.txt and b.txt with read_file, both calls in ONE message. Then answer with the two secret words.', { tools: tools(timeline) })
    const starts = timeline.filter(t => t.what.startsWith('start')).map(t => t.at)
    const firstEnd = Math.min(...timeline.filter(t => t.what.startsWith('end')).map(t => t.at))
    expect(starts).toHaveLength(2)
    expect(Math.max(...starts)).toBeLessThan(firstEnd)
    expect(outcome.text).toContain('MAPLE')
    expect(outcome.text).toContain('CEDAR')
  }, 120_000)

  it('an image tool result reaches Claude as an image, and its recorded form matches what Batshit sent', async () => {
    const photo = { get_photo: tool({
      description: 'Get the photo from the camera. Returns an image.', inputSchema: z.object({}).strict(),
      execute: async () => ({ ok: true }),
      toModelOutput: () => ({ type: 'content', value: [{ type: 'text', text: 'Photo attached.' }, { type: 'file', mediaType: 'image/png', data: { type: 'data', data: makePng().toString('base64') } }] }) as any
    }) }
    const m = model('image-result')
    const outcome = await run(m, 'Call get_photo once. Then name the colour of its left half and of its right half, in one short line.', { tools: photo })
    expect(m.currentRun!.failure).toBeNull()
    expect(outcome.text.toLowerCase()).toMatch(/magenta|pink|purple|fuchsia/)
    expect(outcome.text.toLowerCase()).toContain('green')
    expect(outcome.settlement).toBe('exited')
  }, 90_000)

  it('Faye S8: a large image, a large text result near the size guard, and an error result are recorded as sent', async () => {
    const report = `${'This line is filler for a long report and says nothing new. '.repeat(1400)}The final code word is LANTERN.`
    const tools = {
      get_report: tool({ description: 'Get the long daily report as text.', inputSchema: z.object({}).strict(), execute: async () => report }),
      get_broken: tool({ description: 'A tool that is broken today.', inputSchema: z.object({}).strict(), execute: async () => { throw new Error('station offline') } }),
      get_big_photo: tool({
        description: 'Get the big photo from the camera. Returns an image.', inputSchema: z.object({}).strict(),
        execute: async () => ({ ok: true }),
        toModelOutput: () => ({ type: 'content', value: [{ type: 'file', mediaType: 'image/png', data: { type: 'data', data: makePng(2400, 2400).toString('base64') } }] }) as any
      })
    }
    const m = model('large-results')
    const outcome = await run(m, 'Call get_report, get_broken and get_big_photo, all three in ONE message. Then answer in one line: the report\'s final code word, the error text from get_broken, and the photo\'s two colours.', { tools })
    // The recorded-result check passed for every call: text verbatim, the error flag, the image by count.
    expect(m.currentRun!.failure).toBeNull()
    expect(outcome.text).toContain('LANTERN')
    expect(outcome.settlement).toBe('exited')
  }, 120_000)

  it('Faye M4 (P3 Part 2): a person\'s steer mid-reply joins the next model call, and the pin\'s replay echo carries it unchanged', async () => {
    const m = model('steer')
    const timeline: Array<{ at: number; what: string }> = []
    const steer = { steerId: 'live-steer-1', messageId: 'live', text: 'Also end your answer with the word BANANA.', at: '', source: 'user' as const }
    const { text, settlement } = await run(m, 'Call get_weather once for Paris, then tell me its code word.', {
      tools: tools(timeline),
      prepareStep: ({ stepNumber }) => { if (stepNumber === 1) m.addSteers([steer]); return undefined }
    })
    expect(m.currentRun!.failure).toBeNull()
    expect(settlement).toBe('exited')
    // Confirmed only by the echo matching the written text exactly (`takeUserEcho`), before the next call.
    expect(m.handoffs).toEqual([expect.objectContaining({ carrier: 'user_message', steerId: 'live-steer-1', deliveredAt: expect.any(String) })])
    expect(timeline.map(t => t.what)).toEqual(['start Paris', 'end Paris'])
    expect(text).toMatch(/HERON/)
  }, 120_000)

  it('BL-2368: a call to an unlisted name runs nothing, Claude Code answers it as unknown, and the same reply goes on', async () => {
    // A model rarely misnames a tool by itself, so the prompt asks for the exact wrong name (P5 saw Haiku do it unasked).
    const system = 'You are the model inside an error-handling test harness. When the user gives an exact tool name, emit a tool call with exactly that name, character for character, even when it is not in your tool list. Do not correct or substitute the name. Be brief.'
    const m = model('misnamed')
    const timeline: Array<{ at: number; what: string }> = []
    const outcome = await run(m, 'Step 1: emit a tool call named exactly batshit__batshit__get_weather with input {"city":"Paris"}. Step 2: after its result arrives, call the get_weather tool you are given for Paris. Step 3: answer in one line with what each call returned.', { tools: tools(timeline), system })
    expect(m.currentRun!.failure).toBeNull()
    expect(outcome.parts.some(p => p.type === 'tool-error' && p.toolName === 'batshit__batshit__get_weather')).toBe(true)
    expect(m.handoffs.some(h => h.source === 'unlisted_tool')).toBe(true)
    // Nothing ran for the misnamed call; only a listed call may have run.
    expect(timeline.filter(t => t.what.startsWith('start')).length).toBeLessThanOrEqual(1)
    expect(outcome.settlement).toBe('exited')
  }, 120_000)

  it('a Stop while a Batshit tool runs ends the run with no further model call', async () => {
    const stop = new AbortController()
    const slow = { get_weather: tool({ description: 'Get the current weather for a city.', inputSchema: z.object({ city: z.string() }).strict(), execute: async (_input, { abortSignal }) => {
      setTimeout(() => stop.abort(new Error('Stop')), 300)
      await new Promise((resolve, reject) => abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), { once: true }))
      return 'never'
    } }) }
    const m = model('stop-mid-tool')
    const outcome = await run(m, 'Call get_weather for Paris once.', { tools: slow, abortSignal: stop.signal })
    // The SDK ends an aborted step without its finish part: count model calls by their starts.
    expect(outcome.parts.filter(p => p.type === 'start-step')).toHaveLength(1)
    expect(outcome.settlement).toBe('exited')
    expect(m.currentRun!.failure?.code).toBe('stopped')
    expect(listClaudePlanRuns({ sessionId: 'live-stop-mid-tool' })).toEqual([])
  }, 90_000)
})
