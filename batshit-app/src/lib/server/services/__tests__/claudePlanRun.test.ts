// @vitest-environment node
/**
 * SA-139 P2 (V2, V3, V4, V8): the Claude plan run end to end against a test double of Claude Code
 * (`fixtures/claude-plan/fake-claude.mjs`) that really runs the production bridge, hooks and socket.
 * The AI SDK loop is the real `ai` 7.0.119 `streamText`; no model call is made anywhere here.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { stepCountIs, streamText, tool } from 'ai'
import { z } from 'zod'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// The real AI SDK loop, not the shared test mock.
vi.unmock('ai')

import { bindClaudePlanExecutable, type ClaudePlanExecutable } from '../claudePlanExecutable'
import { ClaudePlanModel, wrapClaudePlanApprovals, wrapClaudePlanToolSet } from '../claudePlanModel'
import { TYPED_READ_FILE_MARKER } from '../typedFileTools'
import { CLAUDE_PLAN_APPROVAL_REFUSAL, CLAUDE_PLAN_TOOL_NAMES_LINE, ClaudePlanRunError } from '../claudePlanProtocol'
import { ClaudePlanRun } from '../claudePlanRun'
import { claimHeldClaudePlanRun, closeClaudePlanRunAdmission, endClaudePlanRuns, endHeldClaudePlanRuns, isClaudePlanRunHeld, listClaudePlanRuns, resetClaudePlanRunRegistryForTests } from '../claudePlanRunRegistry'
import { runAbortSignalOf, trackToolExecution, withToolResultsOnStop } from '../lateToolResults'
import { createGatewayStreamFormatCheck } from '../providers/gatewayStreamFormat'
import { isContextExhaustedStreamFailure } from '../streamFailureEvidence'

const FAKE = path.resolve(__dirname, 'fixtures/claude-plan/fake-claude.mjs')
let executable: ClaudePlanExecutable
const folders: string[] = []

beforeAll(async () => {
  executable = await bindClaudePlanExecutable({ resolution: { executable: FAKE, source: 'env' }, runAs: {} })
})

afterEach(async () => {
  await endClaudePlanRuns({}, 'test over')
  resetClaudePlanRunRegistryForTests()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function project(scenario: Record<string, unknown>): string {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'sa139-p2-'))
  folders.push(folder)
  writeFileSync(path.join(folder, 'scenario.json'), JSON.stringify(scenario))
  return folder
}

function fakeLog(folder: string): any[] {
  const file = path.join(folder, 'fake-log.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
}

function model(folder: string, timing: Record<string, number> = {}) {
  return new ClaudePlanModel({
    modelId: 'claude-haiku-5-5', cliModel: 'claude-haiku-5-5', effort: null,
    owner: { userId: 'u1', sessionId: 's1', agentId: 'a1', kind: 'primary' },
    workingDirectory: folder, executable, runAs: {}, timing: { idleMs: 60_000, ...timing }
  })
}

const PROMPT = [
  { role: 'system' as const, content: 'You are a test agent.' },
  { role: 'user' as const, content: 'Please help.' }
]

type Timeline = Array<{ at: number; what: string }>

function weatherTools(timeline: Timeline, delayMs = 30) {
  return {
    get_weather: tool({
      description: 'Get the weather for a city.',
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => {
        timeline.push({ at: Date.now(), what: `start ${city}` })
        await new Promise(resolve => setTimeout(resolve, delayMs))
        timeline.push({ at: Date.now(), what: `end ${city}` })
        return `${city}: sunny`
      }
    }),
    // The registered typed reader's marker: only this makes a tool read-only (D4).
    read_file: Object.assign(tool({
      description: 'Read a file.',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path: file }) => {
        timeline.push({ at: Date.now(), what: `start ${file}` })
        await new Promise(resolve => setTimeout(resolve, delayMs))
        timeline.push({ at: Date.now(), what: `end ${file}` })
        return `contents of ${file}`
      }
    }), { [TYPED_READ_FILE_MARKER]: true })
  }
}

async function collect(pending: ReturnType<typeof streamText>) {
  const result = await pending
  const parts: any[] = []
  for await (const part of result.stream) parts.push(part)
  return parts
}

/** Every part, and the failure that ended the stream: an `error` part, or an error the read itself raised. */
async function collectToEnd(pending: ReturnType<typeof streamText>): Promise<{ parts: any[]; failure: unknown; raised: boolean }> {
  const result = await pending
  const parts: any[] = []
  try {
    for await (const part of result.stream) parts.push(part)
  } catch (error) {
    return { parts, failure: error, raised: true }
  }
  return { parts, failure: parts.find(p => p.type === 'error')?.error ?? null, raised: false }
}

async function settledAll(): Promise<void> {
  await Promise.all(listClaudePlanRuns().map(run => run.settled))
}

describe('Claude plan run: a reply on the test double', () => {
  it('streams thinking and text for a words-only reply, then exits and cleans up', async () => {
    const folder = project({ turns: [{ blocks: [{ type: 'thinking', text: 'Considering.' }, { type: 'text', text: 'Hello there.' }] }] })
    const m = model(folder)
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true }))
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('Hello there.')
    expect(parts.filter(p => p.type === 'reasoning-delta').map(p => p.text).join('')).toBe('Considering.')
    const finish = parts.find(p => p.type === 'finish-step')
    expect(finish.finishReason).toBe('stop')
    expect(finish.usage.inputTokens).toBe(153)
    expect(finish.usage.outputTokens).toBe(42)
    const run = m.currentRun!
    expect(await run.settled).toBe('exited')
    const log = fakeLog(folder)
    // No Thinking value: Claude Code's own default, nothing written.
    expect('alwaysThinkingEnabled' in log.find(e => e.kind === 'start').settings).toBe(false)
    const argv: string[] = log.find(e => e.kind === 'start').argv
    const runFolder = path.dirname(argv[argv.indexOf('--mcp-config') + 1])
    expect(runFolder).toMatch(/^\/tmp\/bcp-/)
    expect(existsSync(runFolder)).toBe(false)
    expect(log.filter(e => e.kind === 'model-call')).toHaveLength(1)
    expect(log.filter(e => e.kind === 'prompt').map(e => e.prompt)).toEqual(['batshit-handshake', 'Please help.'])
  })

  it('starts Claude Code with the documented flags and a strict environment (D2, D3, D4, D7, D12)', async () => {
    const folder = project({ turns: [{ blocks: [{ type: 'text', text: 'ok' }] }] })
    const m = new ClaudePlanModel({
      modelId: 'claude-opus-5-5', cliModel: 'claude-opus-5-5', effort: 'high', alwaysThinking: false,
      owner: { userId: 'u1', sessionId: 's1', agentId: 'a1', kind: 'primary' }, workingDirectory: folder, executable, runAs: {}
    })
    const previous = { ...process.env }
    process.env.ANTHROPIC_API_KEY = 'sk-never'
    process.env.BATSHIT_TOKEN = 'never'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'never'
    try {
      await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools([]), m) }))
    } finally {
      process.env = previous
    }
    await m.currentRun!.settled
    const start = fakeLog(folder).find(e => e.kind === 'start')
    const argv: string[] = start.argv
    for (const flag of ['-p', '--no-session-persistence', '--strict-mcp-config', '--include-partial-messages', '--verbose', '--replay-user-messages']) expect(argv).toContain(flag)
    const value = (name: string) => argv[argv.indexOf(name) + 1]
    expect(value('--tools')).toBe('')
    expect(value('--setting-sources')).toBe('')
    expect(value('--permission-mode')).toBe('dontAsk')
    expect(value('--thinking-display')).toBe('summarized')
    expect(value('--model')).toBe('claude-opus-5-5')
    expect(value('--effort')).toBe('high')
    expect(value('--input-format')).toBe('stream-json')
    expect(start.settings.alwaysThinkingEnabled).toBe(false)
    expect(Object.keys(start.settings).sort()).toEqual(['alwaysThinkingEnabled', 'hooks'])
    const env: Record<string, string> = start.env
    expect(Object.keys(env).filter(name => /^(ANTHROPIC_|BATSHIT_|CLAUDE_CODE_OAUTH|CLAUDE_CODE_USE_)/.test(name))).toEqual([])
    expect(env).toMatchObject({
      DISABLE_AUTO_COMPACT: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ENABLE_TOOL_SEARCH: 'false',
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1', MCP_TOOL_TIMEOUT: String(7 * 24 * 60 * 60 * 1000),
      CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: String(7 * 24 * 60 * 60 * 1000), CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0'
    })
    expect(Number(env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH)).toBeGreaterThan(4096)
    // No more than the allowlist plus the run's own documented settings.
    // `__CF_USER_TEXT_ENCODING` is added by macOS to every process it starts, not by Batshit.
    expect(Object.keys(env).filter(name => name !== '__CF_USER_TEXT_ENCODING').sort()).toEqual([
      'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK', 'CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH',
      'CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS', 'CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT', 'DISABLE_AUTO_COMPACT', 'ENABLE_TOOL_SEARCH',
      'HOME', 'LANG', 'LOGNAME', 'MAX_MCP_OUTPUT_TOKENS', 'MCP_TOOL_TIMEOUT', 'PATH', 'SHELL', 'TMPDIR', 'USER'
    ])
    expect(start.argv.join(' ')).not.toMatch(/[0-9a-f]{64}/)
    const tools = fakeLog(folder).find(e => e.kind === 'tools').tools
    expect(tools.map((t: any) => [t.name, t.annotations.readOnlyHint, t._meta['anthropic/maxResultSizeChars']])).toEqual([
      ['get_weather', false, 500_000], ['read_file', true, 500_000]
    ])
  })

  it('D17: a run that offers tools leads its system text with the one fixed tool-names line, once; a run with none (Compact) has no line', async () => {
    const offering = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'Sunny in Paris.' }] }
    ] })
    const m = model(offering)
    await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools([]), m), stopWhen: () => false }))
    await m.currentRun!.settled
    const log = fakeLog(offering)
    // Two model calls in one run, and Claude Code read one system text for both.
    expect(log.filter(e => e.kind === 'model-call')).toHaveLength(2)
    const starts = log.filter(e => e.kind === 'start')
    expect(starts).toHaveLength(1)
    expect(starts[0].systemPrompt).toBe(`${CLAUDE_PLAN_TOOL_NAMES_LINE}\n\nYou are a test agent.`)
    expect(starts[0].systemPrompt.split('mcp__batshit__<name>')).toHaveLength(2)

    const bare = project({ turns: [{ blocks: [{ type: 'text', text: 'A summary.' }] }] })
    const compact = model(bare)
    await collect(streamText({ model: compact, messages: PROMPT, allowSystemInMessages: true }))
    await compact.currentRun!.settled
    expect(fakeLog(bare).find(e => e.kind === 'start').systemPrompt).toBe('You are a test agent.')
  })

  it('runs one call after its admission and hands Claude the exact released result', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'Sunny in Paris.' }] }
    ] })
    const timeline: Timeline = []
    const m = model(folder)
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools(timeline), m), stopWhen: () => false }))
    expect(parts.find(p => p.type === 'tool-result')?.output).toBe('Paris: sunny')
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('Sunny in Paris.')
    expect(timeline.map(t => t.what)).toEqual(['start Paris', 'end Paris'])
    await m.currentRun!.settled
    const log = fakeLog(folder)
    expect(log.filter(e => e.kind === 'model-call')).toHaveLength(2)
    expect(log.find(e => e.kind === 'batch-passed')).toBeTruthy()
    const preHook = log.find(e => e.kind === 'hook' && e.event === 'PreToolUse')
    expect(JSON.parse(preHook.stdout).hookSpecificOutput.updatedInput).toMatchObject({ city: 'Paris', __batshit_call: expect.stringMatching(/^toolu_/) })
  })

  it('pipelines three write calls one at a time with no deadlock (P0 §3)', async () => {
    const folder = project({ turns: [
      { blocks: ['Paris', 'Oslo', 'Rome'].map(city => ({ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city } })) },
      { blocks: [{ type: 'text', text: 'Done.' }] }
    ] })
    const timeline: Timeline = []
    const m = model(folder)
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools(timeline, 40), m), stopWhen: () => false }))
    expect(parts.filter(p => p.type === 'tool-result')).toHaveLength(3)
    expect(timeline.map(t => t.what)).toEqual(['start Paris', 'end Paris', 'start Oslo', 'end Oslo', 'start Rome', 'end Rome'])
    await m.currentRun!.settled
  })

  it('runs read-only calls together (readOnlyHint, D4)', async () => {
    const folder = project({ turns: [
      { blocks: ['a.txt', 'b.txt', 'c.txt'].map(file => ({ type: 'tool_use', name: 'mcp__batshit__read_file', input: { path: file } })) },
      { blocks: [{ type: 'text', text: 'Read.' }] }
    ] })
    const timeline: Timeline = []
    const m = model(folder)
    await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools(timeline, 150), m), stopWhen: () => false }))
    const starts = timeline.filter(t => t.what.startsWith('start')).map(t => t.at)
    const firstEnd = Math.min(...timeline.filter(t => t.what.startsWith('end')).map(t => t.at))
    expect(starts).toHaveLength(3)
    expect(Math.max(...starts)).toBeLessThan(firstEnd)
    await m.currentRun!.settled
  })

  it('hands Claude the SDK\'s own error text for a call the SDK refused, then goes on (repairToolCall)', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { town: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'Retrying is up to me.' }] }
    ] })
    const timeline: Timeline = []
    const m = model(folder)
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools(timeline), m), repairToolCall: m.repairToolCall, stopWhen: () => false }))
    expect(parts.find(p => p.type === 'tool-error')).toBeTruthy()
    expect(timeline).toEqual([])
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('Retrying is up to me.')
    await m.currentRun!.settled
    const recorded = fakeLog(folder).filter(e => e.kind === 'hook' && e.event === 'PostToolBatch')
    expect(recorded).toHaveLength(1)
  })

  it('a thrown tool error reaches Claude as the SDK records it, and the reply goes on', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Nowhere' } }] },
      { blocks: [{ type: 'text', text: 'It failed.' }] }
    ] })
    const m = model(folder)
    const tools = { get_weather: tool({ description: 'w', inputSchema: z.object({ city: z.string() }), execute: async () => { throw new Error('station offline') } }) }
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(tools, m), stopWhen: () => false }))
    expect(parts.find(p => p.type === 'tool-error')).toBeTruthy()
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('It failed.')
    expect(parts.find(p => p.type === 'error')).toBeUndefined()
    await m.currentRun!.settled
  })

  it('the finish part passes the shared stream-format check (createGatewayStreamFormatCheck, SSE FM)', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'ok' }] }
    ] })
    const m = model(folder)
    const check = createGatewayStreamFormatCheck()
    for await (const part of (await streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools([]), m), stopWhen: () => false })).stream) {
      expect(check.observe(part)).toBeNull()
    }
    await m.currentRun!.settled
  })
})

describe('Claude plan run: integrity (D4)', () => {
  async function failing(scenario: Record<string, unknown>) {
    const folder = project(scenario)
    const timeline: Timeline = []
    const m = model(folder)
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools(timeline), m), stopWhen: () => false }))
    const run = m.currentRun!
    expect(await run.settled).toBe('exited')
    return { parts, timeline, run, log: fakeLog(folder) }
  }

  it('a result Claude Code wrote itself ends the run before any further model call', async () => {
    const { run, log, parts } = await failing({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' }, fault: 'own-result' }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    expect(run.failure?.code).toBe('integrity')
    // Caught on the recorded result itself, before the batch hook could add its own check.
    expect(run.failure?.message).toMatch(/recorded a tool result that Batshit did not send/)
    expect(log.filter(e => e.kind === 'model-call')).toHaveLength(1)
    expect(parts.some(p => p.type === 'text-delta' && p.text.includes('never'))).toBe(false)
  })

  it('a PreToolUse input that differs from Claude\'s proposal is refused before any effect', async () => {
    const { run, timeline } = await failing({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' }, fault: 'pre-input-differs' }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    expect(run.failure?.code).toBe('integrity')
    expect(run.failure?.message).toMatch(/input that differs/)
    expect(timeline).toEqual([])
  })

  it('a PreToolUse hook failure (a Claude Code denial) ends the run', async () => {
    const { run, log } = await failing({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' }, fault: 'pre-hook-fail' }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    expect(run.failure?.code).toBe('integrity')
    expect(log.filter(e => e.kind === 'model-call')).toHaveLength(1)
  })

  it('arguments that differ from Claude\'s proposal are refused before any effect', async () => {
    const { run, timeline } = await failing({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' }, fault: 'alter-args' }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    expect(run.failure?.code).toBe('integrity')
    expect(timeline).toEqual([])
  })

  it('a second MCP call for one consumed id is refused', async () => {
    const { run } = await failing({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' }, fault: 'duplicate-call' }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    expect(run.failure?.code).toBe('integrity')
  })

  it('an MCP call whose own call id disagrees with its admission tag is refused', async () => {
    const { run, timeline } = await failing({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' }, fault: 'meta-mismatch' }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    expect(run.failure?.code).toBe('integrity')
    expect(timeline).toEqual([])
  })

  it('a request with the wrong secret is refused and changes nothing', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'Fine.' }] }
    ] })
    const m = model(folder)
    let answer: any = null
    const tools = { get_weather: tool({ description: 'w', inputSchema: z.object({ city: z.string() }), execute: async ({ city }, { toolCallId }) => {
      const argv: string[] = fakeLog(folder).find(e => e.kind === 'start').argv
      const socketPath = path.join(path.dirname(argv[argv.indexOf('--mcp-config') + 1]), 's')
      answer = await new Promise(resolve => {
        const socket = connect(socketPath)
        let buffer = ''
        socket.on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) { socket.end(); resolve(JSON.parse(buffer)) } })
        socket.write(JSON.stringify({ secret: 'f'.repeat(64), op: 'call', id: toolCallId, name: 'get_weather', args: { city } }) + '\n')
      })
      return `${city}: sunny`
    } }) }
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(tools, m), stopWhen: () => false }))
    expect(answer).toEqual({ error: 'denied' })
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('Fine.')
    expect(m.currentRun!.failure).toBeNull()
    await m.currentRun!.settled
  })

  it('a call to a native tool name runs nothing: Claude Code answers it as unknown and the reply goes on (V2, BL-2368)', async () => {
    const { run, parts, timeline, log } = await failing({ turns: [
      { blocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
      { blocks: [{ type: 'text', text: 'No shell here.' }] }
    ] })
    expect(run.failure).toBeNull()
    expect(parts.find(p => p.type === 'tool-error')).toMatchObject({ toolName: 'Bash' })
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('No shell here.')
    expect(timeline).toEqual([])
    expect(log.some(e => e.kind === 'hook-start' && e.event === 'PreToolUse')).toBe(false)
  })

  it('a native tool name whose recorded result is anything but Claude Code\'s own "No such tool" error ends the run (V2, BL-2368)', async () => {
    const { run, log } = await failing({ turns: [
      { blocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' }, fault: 'unlisted-other-result' }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    expect(run.failure?.code).toBe('integrity')
    expect(run.failure?.message).toMatch(/not its own "No such tool" error/)
    expect(log.filter(e => e.kind === 'model-call')).toHaveLength(1)
  })

  it('EndConversation ends the reply readably with no Batshit tool run', async () => {
    const { run, parts, timeline } = await failing({ turns: [{ blocks: [{ type: 'text', text: 'Bye.' }, { type: 'tool_use', name: 'EndConversation', input: {} }] }] })
    const error = parts.find(p => p.type === 'error')?.error
    expect(error).toBeInstanceOf(ClaudePlanRunError)
    expect(error.code).toBe('end_conversation')
    expect(timeline).toEqual([])
    expect(run.failure).toBeNull()
  })
})

describe('Claude plan run: a call to an unlisted name (BL-2368)', () => {
  async function reply(scenario: Record<string, unknown>, stopWhen: Parameters<typeof streamText>[0]['stopWhen'] = () => false, timing: Record<string, number> = {}) {
    const folder = project(scenario)
    const timeline: Timeline = []
    const m = model(folder, timing)
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools(timeline), m), stopWhen }))
    return { folder, m, parts, timeline, run: m.currentRun! }
  }

  it('runs nothing, shows the failed call, tells Claude the right form, and the same reply goes on (rules 1 to 3)', async () => {
    const { folder, m, parts, timeline, run } = await reply({ turns: [
      { blocks: [{ type: 'tool_use', id: 'toolu_misnamed', name: 'batshit__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'Paris is sunny.' }] }
    ] })
    expect(run.failure).toBeNull()
    // Rule 3: the SDK refused it as an unknown tool, as on the API lane: a failed call the person sees and the record keeps.
    const failed = parts.find(p => p.type === 'tool-error')
    expect(failed).toMatchObject({ toolCallId: 'toolu_misnamed', toolName: 'batshit__batshit__get_weather' })
    expect(String(failed.error)).toMatch(/batshit__batshit__get_weather/)
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('Paris is sunny.')
    // Rule 1: nothing ran for it, no hook asked about it, no MCP call carried it; only the listed call ran.
    expect(timeline.map(t => t.what)).toEqual(['start Paris', 'end Paris'])
    const log = fakeLog(folder)
    expect(log.filter(e => e.kind === 'hook-start' && e.event === 'PreToolUse').map(e => e.toolUseId)).not.toContain('toolu_misnamed')
    expect(log.filter(e => e.kind === 'model-call')).toHaveLength(3)
    // Rule 2: the step's note names the right form, with the likely meaning.
    const note = log.find(e => e.kind === 'batch-passed')?.note as string
    expect(note).toContain('no tool is named batshit__batshit__get_weather')
    expect(note).toContain('mcp__batshit__<name>')
    expect(note).toContain('perhaps mcp__batshit__get_weather')
    expect(m.handoffs.map(h => [h.carrier, h.source, h.step])).toEqual([['batch_note', 'unlisted_tool', 1]])
    expect(await run.settled).toBe('exited')
  })

  it('a misnamed call beside a listed one in the same message: the listed call runs, the step goes on', async () => {
    const { parts, timeline, run } = await reply({ turns: [
      { blocks: [{ type: 'tool_use', name: 'get_weather', input: { city: 'Oslo' } }, { type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'Done.' }] }
    ] })
    expect(run.failure).toBeNull()
    expect(parts.filter(p => p.type === 'tool-error').map(p => p.toolName)).toEqual(['get_weather'])
    expect(timeline.map(t => t.what)).toEqual(['start Paris', 'end Paris'])
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('Done.')
    await run.settled
  })

  it('Faye S1: a tool with no execute step (client-side or provider-defined) is refused by name before any model call', async () => {
    const folder = project({ turns: [{ blocks: [{ type: 'text', text: 'never' }] }] })
    const m = model(folder)
    expect(() => wrapClaudePlanToolSet({ ...weatherTools([]), ask_user: tool({ description: 'Ask the person.', inputSchema: z.object({ question: z.string() }) }) }, m))
      .toThrow(expect.objectContaining({ code: 'unsupported_tool', message: expect.stringContaining('The ask_user tool has no step Batshit runs') }))
    expect(m.currentRun).toBeNull()
    expect(fakeLog(folder).filter(e => e.kind === 'start')).toHaveLength(0)
  })

  it('a bare tool name runs nothing and raises no card even where the tool itself needs approval', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', id: 'toolu_bare', name: 'get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'Could not.' }] }
    ] })
    const timeline: Timeline = []
    const m = model(folder)
    let asked = 0
    const parts = await collect(streamText({
      model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools(timeline), m), stopWhen: () => false,
      toolApproval: wrapClaudePlanApprovals({ get_weather: async () => { asked++; return 'user-approval' } }, m) as any
    }))
    expect(parts.some(p => p.type === 'tool-approval-request')).toBe(false)
    expect(asked).toBe(0)
    expect(timeline).toEqual([])
    expect(parts.find(p => p.type === 'tool-error')).toMatchObject({ toolCallId: 'toolu_bare', toolName: 'get_weather' })
    expect(String(parts.find(p => p.type === 'tool-error').error)).toMatch(/no tool name on the Claude plan connection/)
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('Could not.')
    expect(m.currentRun!.failure).toBeNull()
    await m.currentRun!.settled
  })

  it('a misnamed call answered only after a write call queued ahead of it still passes (the batch hook waits for its record)', async () => {
    const { parts, timeline, run } = await reply({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }, { type: 'tool_use', name: 'batshit__get_weather', input: { city: 'Oslo' }, lateRecord: true }] },
      { blocks: [{ type: 'text', text: 'Done.' }] }
    ] })
    expect(run.failure).toBeNull()
    expect(timeline.map(t => t.what)).toEqual(['start Paris', 'end Paris'])
    expect(parts.filter(p => p.type === 'tool-error').map(p => p.toolName)).toEqual(['batshit__get_weather'])
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('Done.')
    await run.settled
  })

  it('repeated misnames end under the normal step cap, with no loop of their own (rule 5)', async () => {
    const misnamed = { blocks: [{ type: 'tool_use', name: 'batshit__get_weather', input: { city: 'Paris' } }] }
    const { folder, m, parts, run } = await reply({ turns: [misnamed, misnamed, misnamed, misnamed] }, stepCountIs(2))
    m.endReply()
    expect(await run.settled).toBe('exited')
    expect(parts.filter(p => p.type === 'tool-error')).toHaveLength(2)
    // The barrier held Claude Code's third model call: the cap ended the reply first.
    expect(fakeLog(folder).filter(e => e.kind === 'model-call')).toHaveLength(2)
    expect(run.failure?.code).not.toBe('integrity')
  })

  it('a misnamed call Claude Code never answers itself: the batch hook refuses it and Claude Code\'s next model call never starts', async () => {
    const { folder, run } = await reply({ turns: [
      { blocks: [{ type: 'tool_use', name: 'batshit__get_weather', input: { city: 'Paris' }, fault: 'unlisted-no-record' }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] }, () => false, { recordedWaitMs: 300 })
    expect(await run.settled).toBe('exited')
    expect(run.failure?.code).toBe('integrity')
    expect(run.failure?.message).toMatch(/without recording the results/)
    expect(fakeLog(folder).filter(e => e.kind === 'model-call')).toHaveLength(1)
  })

  // Rule 4: every other record of such a call stays integrity, before any effect.
  it.each([
    ['Claude Code asks PreToolUse to run it', 'mcp__batshit__not_a_tool', 'unlisted-pre', /tried to run a tool Batshit does not list/],
    ['Claude Code sends it to the MCP server', 'mcp__batshit__not_a_tool', 'unlisted-mcp', /without its admission/],
    ['its recorded result is not an error', 'batshit__get_weather', 'unlisted-not-error', /not its own "No such tool" error/],
    ['its recorded result is another text', 'batshit__get_weather', 'unlisted-other-result', /not its own "No such tool" error/],
    ['its error is recorded twice', 'batshit__get_weather', 'unlisted-twice', /not its own "No such tool" error/]
  ])('%s: integrity', async (_label, name, fault, message) => {
    const { folder, run, timeline } = await reply({ turns: [
      { blocks: [{ type: 'tool_use', name, input: { city: 'Paris' }, fault }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    expect(await run.settled).toBe('exited')
    expect(run.failure?.code).toBe('integrity')
    expect(run.failure?.message).toMatch(message)
    expect(timeline).toEqual([])
    expect(fakeLog(folder).filter(e => e.kind === 'model-call')).toHaveLength(1)
  })
})

describe('Claude plan run: retries (D3, P0 §D)', () => {
  it('a retry before any visible output continues the same step', async () => {
    const folder = project({ turns: [{ retryAfterIndex: 0, blocks: [{ type: 'text', text: 'After retry.' }] }] })
    const m = model(folder)
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true }))
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('After retry.')
    expect(m.currentRun!.failure).toBeNull()
    await m.currentRun!.settled
  })

  it('a retry after visible output fails the step and kills the run, so nothing streams twice', async () => {
    const folder = project({ turns: [{ retryAfterIndex: 1, blocks: [{ type: 'text', text: 'Partial' }, { type: 'text', text: 'more' }] }] })
    const m = model(folder)
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true }))
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('Partial')
    expect(m.currentRun!.failure?.code).toBe('retry_after_output')
    expect(await m.currentRun!.settled).toBe('exited')
  })
})

describe('Claude plan run: startup admission refuses with zero model calls (D2)', () => {
  async function refused(scenario: Record<string, unknown>, timing: Record<string, number> = {}) {
    const folder = project({ ...scenario, turns: [{ blocks: [{ type: 'text', text: 'should never stream' }] }] })
    const m = model(folder, timing)
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: weatherTools([]) }))
    const error = parts.find(p => p.type === 'error')?.error
    expect(error).toBeInstanceOf(ClaudePlanRunError)
    expect(fakeLog(folder).filter(e => e.kind === 'model-call')).toEqual([])
    expect(fakeLog(folder).filter(e => e.kind === 'prompt').map(e => e.prompt)).not.toContain('Please help.')
    if (m.currentRun) expect(await m.currentRun.settled).toBe('exited')
    return error as ClaudePlanRunError
  }

  it('an API key in the initialize answer', async () => {
    const error = await refused({ account: { tokenSource: 'claude.ai', apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' } })
    expect(error.code).toBe('startup_refused')
  })

  it('no initialize answer (as with Bedrock) within the bound', async () => {
    const error = await refused({ noControlResponse: true }, { initializeMs: 500 })
    expect(error.code).toBe('startup_timeout')
  })

  it('a version that differs from the bound executable', async () => {
    expect((await refused({ controlVersion: '2.1.303' })).code).toBe('startup_refused')
  })

  it('a key source other than none in init', async () => {
    expect((await refused({ apiKeySource: 'ANTHROPIC_API_KEY' })).code).toBe('startup_refused')
  })

  it('a route variable in Claude Code\'s effective environment (a managed-settings redirect)', async () => {
    expect((await refused({ hookEnvExtra: { ANTHROPIC_BASE_URL: 'https://relay.example' } })).code).toBe('startup_refused')
  })

  it('a native tool beside Batshit\'s', async () => {
    expect((await refused({ extraInitTools: ['Bash'] })).code).toBe('startup_refused')
  })

  it('a model other than the one asked for', async () => {
    expect((await refused({ initModel: 'claude-opus-5-5' })).code).toBe('startup_refused')
  })

  it('a permission mode other than dontAsk', async () => {
    expect((await refused({ permissionMode: 'bypassPermissions' })).code).toBe('startup_refused')
  })

  it('a prompt check that never ran (a hook that cannot start)', async () => {
    expect((await refused({ gateFailsToStart: true })).code).toBe('startup_refused')
  })

  it('a model call during the handshake', async () => {
    expect((await refused({ modelCallInHandshake: true })).code).toBe('startup_refused')
  })

  function presetModel(folder: string, cliModel: string | null, effort: string | null) {
    return new ClaudePlanModel({
      modelId: cliModel ?? 'default', cliModel, effort, owner: { userId: 'u1', sessionId: 's1', agentId: 'a1', kind: 'primary' },
      workingDirectory: folder, executable, runAs: {}
    })
  }

  it('an alias starts as the Claude model Claude Code resolves it to (2.1.296: opus is claude-opus-5-5)', async () => {
    const folder = project({ initModel: 'claude-opus-5-5', turns: [{ blocks: [{ type: 'text', text: 'alias ok' }] }] })
    const m = presetModel(folder, 'opus', null)
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true }))
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('alias ok')
    await m.currentRun!.settled
  })

  it('an alias or "CLI default" that starts a non-Claude model is refused', async () => {
    const folder = project({ initModel: 'gpt-5', turns: [{ blocks: [{ type: 'text', text: 'never' }] }] })
    const m = presetModel(folder, null, null)
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true }))
    expect(parts.find(p => p.type === 'error')?.error.code).toBe('startup_refused')
    expect(fakeLog(folder).filter(e => e.kind === 'model-call')).toEqual([])
    await m.currentRun!.settled
  })

  it('an effort the started model does not take is refused before any model call (Opus 4.6 has no xhigh)', async () => {
    const folder = project({ turns: [{ blocks: [{ type: 'text', text: 'never' }] }] })
    const m = presetModel(folder, 'claude-opus-4-6', 'xhigh')
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true }))
    const error = parts.find(p => p.type === 'error')?.error
    expect(error.code).toBe('startup_refused')
    expect(error.message).toMatch(/Opus 4\.6 takes reasoning effort low, medium, high, max in Claude Code, not xhigh/)
    expect(fakeLog(folder).filter(e => e.kind === 'model-call')).toEqual([])
    await m.currentRun!.settled

    const ok = project({ turns: [{ blocks: [{ type: 'text', text: 'high is fine' }] }] })
    const fine = presetModel(ok, 'claude-opus-4-6', 'high')
    const okParts = await collect(streamText({ model: fine, messages: PROMPT, allowSystemInMessages: true }))
    expect(okParts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('high is fine')
    await fine.currentRun!.settled
  })

  it('a model that takes no effort refuses any effort (Haiku 4.5)', async () => {
    const folder = project({ turns: [{ blocks: [{ type: 'text', text: 'never' }] }] })
    const m = presetModel(folder, 'claude-haiku-4-5-20251001', 'low')
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true }))
    expect(parts.find(p => p.type === 'error')?.error.message).toMatch(/Haiku 4\.5 takes no reasoning effort/)
    await m.currentRun!.settled
  })

  it('EndConversation beside Batshit\'s tools is admitted as a harmless terminal control', async () => {
    const folder = project({ extraInitTools: ['EndConversation'], turns: [{ blocks: [{ type: 'text', text: 'fine' }] }] })
    const m = model(folder)
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: weatherTools([]) }))
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('fine')
    await m.currentRun!.settled
  })
})

describe('Claude plan run: limits and result kinds (P3, D7)', () => {
  async function ending(scenario: Record<string, unknown>) {
    const folder = project(scenario)
    const m = model(folder)
    const { parts, failure } = await collectToEnd(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true }))
    const run = m.currentRun!
    expect(await run.settled).toBe('exited')
    return { parts, failure: failure as ClaudePlanRunError, run, log: fakeLog(folder) }
  }

  it('a plan usage limit ends the reply as plan_limit, which send-routed never continues by itself', async () => {
    const { failure, run, log } = await ending({ turns: [{ apiError: { text: 'You\'ve hit your limit · resets 3pm (America/New_York)', status: 429, kind: 'usage_limit_reached', rateLimit: true } }] })
    expect(failure).toBeInstanceOf(ClaudePlanRunError)
    expect(failure.code).toBe('plan_limit')
    expect(failure.message).toContain('resets 3pm (America/New_York)')
    expect(isContextExhaustedStreamFailure(failure)).toBe(false)
    expect(run.failure?.code).toBe('plan_limit')
    expect(log.filter(e => e.kind === 'model-call')).toHaveLength(1)
  })

  it('an untyped 429 under a rejected rate-limit state still reads as the plan limit', async () => {
    const { failure } = await ending({ turns: [{ apiError: { text: 'Usage limit reached', status: 429, rateLimit: true } }] })
    expect(failure.code).toBe('plan_limit')
  })

  it('review A1, B S1: a request served from extra usage (rejected, isUsingOverage) that then fails is not the plan limit', async () => {
    const { failure } = await ending({ turns: [{ apiError: { text: 'Repeated 529 Overloaded errors', status: 529, rateLimit: { isUsingOverage: true } } }] })
    expect(failure.code).toBe('run_failed')
    expect(failure.message).toContain('Repeated 529 Overloaded errors')
  })

  it('review A1: a retry clears the rate-limit state, so the retry\'s own failure is read alone', async () => {
    const { failure } = await ending({ turns: [{ apiError: { text: 'Rate limited', status: 429, retryAfterRejected: true } }] })
    expect(failure.code).toBe('run_failed')
  })

  it('a prompt too long for Claude\'s context is context_exhausted, which the API lane\'s classifier continues (a fresh request, a fresh run)', async () => {
    const { failure } = await ending({ turns: [{ apiError: { text: 'Prompt is too long: 210000 tokens > 200000 maximum', status: 400 } }] })
    expect(failure.code).toBe('context_exhausted')
    expect(isContextExhaustedStreamFailure(failure)).toBe(true)
  })

  it('another API error keeps Claude Code\'s words and is never continued', async () => {
    const { failure } = await ending({ turns: [{ apiError: { text: 'Credit balance is too low', status: 400 } }] })
    expect(failure.code).toBe('run_failed')
    expect(failure.message).toContain('Credit balance is too low')
    expect(isContextExhaustedStreamFailure(failure)).toBe(false)
  })

  it('an error_during_execution result is its own named failure; its diagnostics stay hidden', async () => {
    const { failure } = await ending({ turns: [{ resultSubtype: 'error_during_execution' }] })
    expect(failure.code).toBe('run_failed')
    expect(failure.message).toContain('(error_during_execution)')
    expect(failure.message).not.toMatch(/secret|ede_diagnostic|Prompt is too long/)
    expect(isContextExhaustedStreamFailure(failure)).toBe(false)
  })

  it('Faye S3: at the output limit the step ends with no call; the call already waiting at the bridge is never admitted or run', async () => {
    const folder = project({ turns: [
      // gapMs: Claude Code's PreToolUse for the call is already waiting at the bridge when the limit arrives.
      { stop_reason: 'max_tokens', gapMs: 1500, blocks: [{ type: 'text', text: 'Partial answer' }, { type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'RECOVERED' }] }
    ] })
    const timeline: Timeline = []
    const m = model(folder)
    const result = streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools(timeline), m) })
    const { parts, failure } = await collectToEnd(result)
    expect(failure).toBeNull()
    expect(await result.finishReason).toBe('length')
    expect((await result.steps).length).toBe(1)
    expect(parts.some(p => p.type === 'tool-call')).toBe(false)
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('Partial answer')
    expect(timeline).toEqual([])
    const run = m.currentRun!
    expect(await run.settled).toBe('exited')
    expect(run.failure?.code).toBe('run_ended')
    expect(m.lastFinishReason).toBe('length')
    // The PreToolUse was waiting at the bridge when the limit arrived, got no allow (the hook was ended with
    // the run), and no MCP call reached Batshit.
    const log = fakeLog(folder)
    expect(log.some(e => e.kind === 'hook-start' && e.event === 'PreToolUse')).toBe(true)
    expect(log.some(e => e.kind === 'hook' && e.event === 'PreToolUse')).toBe(false)
    expect(log.some(e => e.kind === 'model-call' && e.n === 2)).toBe(false)
    // The run is over: the API lane's output-limit handling (send-routed) owns what follows, with no automatic retry.
    await expect(m.doStream({ prompt: PROMPT as any, tools: [] } as any)).rejects.toMatchObject({ code: 'run_ended' })
  })

  it('review A6: an EndConversation in a message cut at the output limit is not honored; the reply ends at the limit', async () => {
    const folder = project({ turns: [{ stop_reason: 'max_tokens', blocks: [{ type: 'text', text: 'Bye' }, { type: 'tool_use', name: 'EndConversation', input: {} }] }] })
    const m = model(folder)
    const result = streamText({ model: m, messages: PROMPT, allowSystemInMessages: true })
    const { failure } = await collectToEnd(result)
    expect(failure).toBeNull()
    expect(await result.finishReason).toBe('length')
    expect(m.currentRun!.failure?.code).toBe('run_ended')
    expect(await m.currentRun!.settled).toBe('exited')
  })

  it('a words-only reply that reaches its output limit ends the same way, and Claude Code\'s own recovery call is never read (Faye S3)', async () => {
    const folder = project({ turns: [{ stop_reason: 'max_tokens', blocks: [{ type: 'text', text: 'Cut off' }] }, { blocks: [{ type: 'text', text: 'RECOVERED' }] }] })
    const m = model(folder)
    const result = streamText({ model: m, messages: PROMPT, allowSystemInMessages: true })
    const { parts } = await collectToEnd(result)
    expect(await result.finishReason).toBe('length')
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('Cut off')
    expect(await m.currentRun!.settled).toBe('exited')
  })
})

describe('Claude plan run: Stop and lifecycle (D10)', () => {
  it('a Stop while a Batshit tool runs between steps ends the run; nothing is left running', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    const m = model(folder)
    const stop = new AbortController()
    const tools = { get_weather: tool({ description: 'w', inputSchema: z.object({ city: z.string() }), execute: async (_input, { abortSignal }) => {
      setTimeout(() => stop.abort(new Error('Stop')), 50)
      await new Promise((resolve, reject) => abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), { once: true }))
      return 'never'
    } }) }
    await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(tools, m), abortSignal: stop.signal, stopWhen: () => false }))
    const run = m.currentRun!
    expect(run.isEnded).toBe(true)
    expect(await run.settled).toBe('exited')
    expect(fakeLog(folder).filter(e => e.kind === 'model-call')).toHaveLength(1)
    expect(processesNaming(folder)).toEqual([])
  })

  it('a Stop during startup ends the run before any model call', async () => {
    const folder = project({ turns: [{ blocks: [{ type: 'text', text: 'never' }] }] })
    const m = model(folder)
    const stop = new AbortController()
    setTimeout(() => stop.abort(new Error('Stop')), 30)
    await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, abortSignal: stop.signal }))
    if (m.currentRun) expect(await m.currentRun.settled).toBe('exited')
    expect(fakeLog(folder).filter(e => e.kind === 'model-call')).toEqual([])
  })

  it('Part 3 review: a Stop while the run is still starting spawns nothing after it, and settlement leaves no process or folder', async () => {
    // The stop lands in each startup await in turn: the executable recheck, the hook-policy read,
    // the folder preparation, or after the spawn. Whatever the moment, a settled run left nothing.
    const moments: Array<() => Promise<void>> = [
      async () => {},
      () => new Promise(resolve => setImmediate(resolve)),
      () => new Promise(resolve => setTimeout(resolve, 2)),
      () => new Promise(resolve => setTimeout(resolve, 6)),
      () => new Promise(resolve => setTimeout(resolve, 15))
    ]
    for (const moment of moments) {
      const folder = project({ turns: [{ blocks: [{ type: 'text', text: 'never' }] }] })
      const run = new ClaudePlanRun({ executable, runAs: {}, cliModel: 'claude-haiku-5-5', effort: null, workingDirectory: folder, owner: { userId: 'u', sessionId: 'startup-race', agentId: 'a', kind: 'primary' } })
      const started = run.start({ systemPrompt: 's', content: [{ type: 'text', text: 'u' }], tools: [] }).catch(error => error)
      await moment()
      run.stop()
      expect(await started).toBeInstanceOf(ClaudePlanRunError)
      expect(await run.settled).toBe('exited')
      // Settlement waited for the start to unwind: no folder appears after it, no Claude Code runs on.
      expect((run as any).dir).toBeNull()
      expect((run as any).server).toBeNull()
      await new Promise(resolve => setTimeout(resolve, 50))
      expect((run as any).dir).toBeNull()
      expect((run as any).server).toBeNull()
      expect(processesNaming(folder)).toEqual([])
      expect(fakeLog(folder).filter(e => e.kind === 'model-call')).toEqual([])
    }
  })

  it('Faye N12: a Stop just after the spawn, or just before a startup wait begins, unwinds at once, not at that wait\'s limit', async () => {
    // Just before the handshake: its wait is created after the end, so only the end can cut it short.
    for (const step of ['spawnClaude', 'handshake'] as const) {
      const folder = project({ turns: [{ blocks: [{ type: 'text', text: 'never' }] }] })
      const run = new ClaudePlanRun({ executable, runAs: {}, cliModel: 'claude-haiku-5-5', effort: null, workingDirectory: folder, owner: { userId: 'u', sessionId: 'startup-race', agentId: 'a', kind: 'primary' } })
      const original = (run as any)[step].bind(run)
      ;(run as any)[step] = (...args: unknown[]) => {
        if (step === 'spawnClaude') { original(...args); run.stop(); return }
        run.stop()
        return original(...args)
      }
      const began = Date.now()
      const outcome = await run.start({ systemPrompt: 's', content: [{ type: 'text', text: 'u' }], tools: [] }).catch(error => error)
      expect(outcome).toBeInstanceOf(ClaudePlanRunError)
      expect(await run.settled).toBe('exited')
      expect(Date.now() - began, step).toBeLessThan(5000)
      expect((run as any).dir).toBeNull()
      expect((run as any).server).toBeNull()
      expect(processesNaming(folder)).toEqual([])
    }
  }, 20_000)

  it('a Stop at the barrier (between the release and the next step) ends the run', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    const m = model(folder)
    const stop = new AbortController()
    await collect(streamText({
      model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools([]), m), abortSignal: stop.signal,
      stopWhen: () => false,
      prepareStep: async ({ stepNumber }) => {
        if (stepNumber === 1) { stop.abort(new Error('Stop')); await new Promise(resolve => setTimeout(resolve, 50)) }
        return undefined
      }
    }))
    expect(await m.currentRun!.settled).toBe('exited')
    expect(fakeLog(folder).filter(e => e.kind === 'model-call')).toHaveLength(1)
  })

  it('the batch hook holds Claude Code\'s next model call until prepareStep finished (D4 barrier)', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'After the barrier.' }] }
    ] })
    const m = model(folder)
    let prepared = 0
    const parts = await collect(streamText({
      model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools([]), m), stopWhen: () => false,
      prepareStep: async ({ stepNumber }) => {
        if (stepNumber === 1) { await new Promise(resolve => setTimeout(resolve, 400)); prepared = Date.now() }
        return undefined
      }
    }))
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('After the barrier.')
    await m.currentRun!.settled
    const second = fakeLog(folder).filter(e => e.kind === 'model-call')[1]
    expect(prepared).toBeGreaterThan(0)
    expect(second.at).toBeGreaterThanOrEqual(prepared)
  })

  it('a loop that ends without another step (the step cap) ends the run in endReply', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    const m = model(folder)
    await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools([]), m), onEnd: () => m.endReply() }))
    expect(await m.currentRun!.settled).toBe('exited')
    expect(fakeLog(folder).filter(e => e.kind === 'model-call')).toHaveLength(1)
  })

  it('the idle backstop ends a quiet run, but never while an admitted call is running', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'Back after a long call.' }] }
    ] })
    const m = model(folder, { idleMs: 150 })
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools([], 600), m), stopWhen: () => false }))
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('Back after a long call.')
    await m.currentRun!.settled

    const quiet = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    const idle = model(quiet, { idleMs: 150 })
    await collect(streamText({ model: idle, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools([]), idle) }))
    expect(await idle.currentRun!.settled).toBe('exited')
    expect(idle.currentRun!.failure?.message).toMatch(/idle/)
  })

  it('a destructive owner ends a chat\'s runs and awaits real settlement', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    const m = model(folder)
    await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools([]), m) }))
    expect(listClaudePlanRuns({ sessionId: 's1' })).toHaveLength(1)
    const outcome = await endClaudePlanRuns({ sessionId: 's1' }, 'chat deleted')
    expect(outcome).toEqual({ ended: 1, unsettled: 0 })
    expect(listClaudePlanRuns({ sessionId: 's1' })).toEqual([])
    expect(processesNaming(folder)).toEqual([])
  })

  it('tools nit 1: an automatic approved or denied decision is refused too (send-routed would draw it as a card)', async () => {
    for (const policy of ['approved', 'denied', { type: 'denied', reason: 'no' }, async () => 'approved']) {
      const folder = project({ turns: [{ blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] }, { blocks: [{ type: 'text', text: 'never' }] }] })
      const timeline: Timeline = []
      const m = model(folder)
      const { parts, failure } = await collectToEnd(streamText({
        model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools(timeline), m), stopWhen: () => false,
        toolApproval: wrapClaudePlanApprovals({ get_weather: policy }, m) as any
      }))
      expect(parts.some(p => p.type === 'tool-approval-request')).toBe(false)
      expect(failure).toMatchObject({ code: 'unsupported_approval' })
      expect(timeline).toEqual([])
      await m.currentRun!.settled
    }
  })

  it('a not-applicable policy answer runs the call as usual', async () => {
    const folder = project({ turns: [{ blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] }, { blocks: [{ type: 'text', text: 'Sunny.' }] }] })
    const timeline: Timeline = []
    const m = model(folder)
    const parts = await collect(streamText({
      model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools(timeline), m), stopWhen: () => false,
      toolApproval: wrapClaudePlanApprovals({ get_weather: async () => 'not-applicable' }, m) as any
    }))
    expect(timeline.map(t => t.what)).toEqual(['start Paris', 'end Paris'])
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('Sunny.')
    await m.currentRun!.settled
  })

  it('Part 3 review: a reply that ends while the first step binds Claude Code starts no run', async () => {
    vi.stubEnv('BATSHIT_CLAUDE_CLI_PATH', FAKE)
    try {
      const folder = project({ turns: [{ blocks: [{ type: 'text', text: 'never' }] }] })
      // No executable given: the first step binds it (an await), the window this guards.
      const m = new ClaudePlanModel({ modelId: 'claude-haiku-5-5', cliModel: 'claude-haiku-5-5', effort: null,
        owner: { userId: 'u1', sessionId: 'bind-window', agentId: 'a1', kind: 'primary' }, workingDirectory: folder, runAs: {} })
      const step = m.doStream({ prompt: PROMPT.map(message => ({ role: message.role, content: message.role === 'system' ? message.content : [{ type: 'text', text: message.content }] })) } as any)
      m.endReply()
      await expect(step).rejects.toMatchObject({ code: 'run_ended' })
      expect(m.currentRun).toBeNull()
      expect(listClaudePlanRuns({ sessionId: 'bind-window' })).toEqual([])
      expect(fakeLog(folder)).toEqual([])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('review N2: a reply that already ended asks Claude nothing, even before any run started', async () => {
    const folder = project({ turns: [{ blocks: [{ type: 'text', text: 'never' }] }] })
    const m = model(folder)
    m.endReply()
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true }))
    expect(parts.find(p => p.type === 'error')?.error).toMatchObject({ code: 'run_ended' })
    expect(fakeLog(folder)).toEqual([])
    expect(listClaudePlanRuns()).toEqual([])
  })

  it('a same-reply change to what Claude already holds fails visibly (P3 carries it)', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    const m = model(folder)
    const parts = await collect(streamText({
      model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools([]), m), stopWhen: () => false,
      prepareStep: ({ stepNumber, messages }) => stepNumber === 1
        ? { messages: messages.map((message, index) => index === 1 ? { role: 'user' as const, content: 'Please help. (skill opened)' } : message) }
        : undefined
    }))
    expect(parts.find(p => p.type === 'error')?.error.code).toBe('unsupported_addition')
    expect(fakeLog(folder).filter(e => e.kind === 'model-call')).toHaveLength(1)
  })
})

describe('Claude plan run: additions between steps (P3 Part 2, D5)', () => {
  it('an addition for a step that is not the one waiting for its next model call is refused, and the run ends', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    const m = model(folder)
    const tools = { get_weather: tool({ description: 'w', inputSchema: z.object({ city: z.string() }), execute: async ({ city }) => {
      m.currentRun!.addBetweenSteps(7, { notes: ['A note for a step that does not exist.'], userMessages: [] })
      return `${city}: sunny`
    } }) }
    await collectToEnd(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(tools, m), stopWhen: () => false }))
    expect(m.currentRun!.failure?.code).toBe('integrity')
    expect(await m.currentRun!.settled).toBe('exited')
    expect(fakeLog(folder).filter(e => e.kind === 'model-call')).toHaveLength(1)
  })

  it('notes and a person\'s words handed over at one boundary: the note rides the batch hook, the words follow as a user message', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'Done.' }] }
    ] })
    const m = model(folder)
    const result = streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools([]), m), stopWhen: () => false,
      prepareStep: ({ stepNumber }) => {
        if (stepNumber === 1) {
          m.addSteers([
            { steerId: 'u1', messageId: 'm', text: 'Use Celsius.', at: '', source: 'user' },
            { steerId: 'd1', messageId: 'm', text: 'FYI from Ashe.', at: '', source: 'dm', label: 'Ashe' }
          ])
        }
        return undefined
      } })
    const { failure } = await collectToEnd(result)
    expect(failure).toBeNull()
    const log = fakeLog(folder)
    expect(log.find(e => e.kind === 'batch-passed')?.note).toBe('[Agent DM — from Ashe, not from the user, delivered mid-reply: FYI from Ashe.]')
    expect(JSON.stringify(log.find(e => e.kind === 'queued-user')?.content)).toContain('[The user said, mid-reply: Use Celsius.]')
    expect(m.handoffs.map(h => [h.carrier, h.steerId])).toEqual([['batch_note', 'd1'], ['user_message', 'u1']])
    // Review S2: the person's words were confirmed by Claude Code's replay echo before the next call.
    expect(m.handoffs.find(h => h.steerId === 'u1')?.deliveredAt).toEqual(expect.any(String))
    await m.currentRun!.settled
  })

  const steerAt = (m: ClaudePlanModel, steers: any[]) => ({ stepNumber }: { stepNumber: number }) => {
    if (stepNumber === 1) m.addSteers(steers)
    return undefined
  }

  it('review delta: two of a person\'s steers at one boundary are two messages, each confirmed by its own echo', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'Done.' }] }
    ] })
    const m = model(folder)
    const { failure } = await collectToEnd(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools([]), m), stopWhen: () => false,
      prepareStep: steerAt(m, [
        { steerId: 'u1', messageId: 'm', text: 'Use Celsius.', at: '', source: 'user' },
        { steerId: 'u2', messageId: 'm', text: 'Use Celsius.', at: '', source: 'user' }
      ]) }))
    expect(failure).toBeNull()
    expect(fakeLog(folder).find(e => e.kind === 'queued-user')?.content).toHaveLength(2)
    expect(m.handoffs.filter(h => h.carrier === 'user_message').map(h => [h.steerId, Boolean(h.deliveredAt)])).toEqual([['u1', true], ['u2', true]])
    await m.currentRun!.settled
  })

  it('review S2: a person\'s words that Claude Code did not take in before its next call stop the reply visibly', async () => {
    const folder = project({ lateSteer: true, turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'Answered without the steer.' }] }
    ] })
    const m = model(folder)
    const { parts, failure } = await collectToEnd(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools([]), m), stopWhen: () => false,
      prepareStep: steerAt(m, [{ steerId: 'u1', messageId: 'm', text: 'Use Celsius.', at: '', source: 'user' }]) }))
    expect((failure as ClaudePlanRunError)?.code).toBe('steer_not_delivered')
    expect(parts.some(p => p.type === 'text-delta' && p.text.includes('without'))).toBe(false)
    expect(m.handoffs.find(h => h.steerId === 'u1')?.deliveredAt).toBeUndefined()
    expect(await m.currentRun!.settled).toBe('exited')
  })

  it('review M1: a note longer than Claude Code passes on whole is refused by name, never cut', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    const m = model(folder)
    // One character over the limit, once wrapped: the boundary itself, not a far-off length.
    const long = 'x'.repeat(10_001 - '[Agent DM — from Ashe, not from the user, delivered mid-reply: ]'.length)
    const { failure } = await collectToEnd(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools([]), m), stopWhen: () => false,
      prepareStep: steerAt(m, [{ steerId: 'd1', messageId: 'm', text: long, at: '', source: 'dm', label: 'Ashe' }]) }))
    expect((failure as ClaudePlanRunError)?.code).toBe('addition_too_long')
    expect((failure as Error).message).toContain('is 10,001 characters long')
    expect((failure as Error).message).toContain('10,000')
    const log = fakeLog(folder)
    expect(log.some(e => e.kind === 'batch-passed')).toBe(false)
    expect(log.filter(e => e.kind === 'model-call')).toHaveLength(1)
    expect(await m.currentRun!.settled).toBe('exited')
  })

  it('review M1: a note of exactly the limit reaches Claude whole', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'Done.' }] }
    ] })
    const m = model(folder)
    const wrapperLength = '[Agent DM — from Ashe, not from the user, delivered mid-reply: ]'.length
    const text = 'y'.repeat(10_000 - wrapperLength)
    const { failure } = await collectToEnd(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools([]), m), stopWhen: () => false,
      prepareStep: steerAt(m, [{ steerId: 'd1', messageId: 'm', text, at: '', source: 'dm', label: 'Ashe' }]) }))
    expect(failure).toBeNull()
    const note = fakeLog(folder).find(e => e.kind === 'batch-passed')?.note as string
    expect(note.length).toBe(10_000)
    expect(note).not.toContain('persisted-output')
    await m.currentRun!.settled
  })
})

describe('Claude plan run: approval cards hold the run (P3 Part 3, D6, D3)', () => {
  const KEY = { sessionId: 's1', replyId: 'r1', version: '0' }
  const OWNER = { userId: 'u1', agentId: 'a1' }
  const base = (folder: string) => ({
    modelId: 'claude-haiku-5-5', cliModel: 'claude-haiku-5-5', effort: null,
    owner: { userId: 'u1', sessionId: 's1', agentId: 'a1', kind: 'primary' as const },
    workingDirectory: folder, executable, runAs: {}, timing: { idleMs: 60_000 }
  })
  const PARIS_OSLO = { turns: [
    { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }, { type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Oslo' } }] },
    { blocks: [{ type: 'text', text: 'Done.' }] }
  ] }
  const parisNeedsApproval = { get_weather: async (input: any) => input.city === 'Paris' ? 'user-approval' as const : undefined }

  async function toCard(folder: string, policy: Record<string, unknown>, timeline: Timeline, extra: Record<string, unknown> = {}) {
    const m = new ClaudePlanModel({ ...base(folder), holdKey: KEY, ...extra })
    const result = streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools(timeline), m), stopWhen: () => false,
      toolApproval: wrapClaudePlanApprovals(policy as any, m) as any })
    const { parts, failure } = await collectToEnd(result)
    m.endReplyAtLoopEnd() // what the brain's onEnd does
    return { m, parts, failure, response: await result.response.catch(() => ({ messages: [] as any[] })) }
  }

  async function click(folder: string, first: Awaited<ReturnType<typeof toCard>>, answers: (city: string) => boolean, policy: Record<string, unknown>, timeline: Timeline) {
    const held = claimHeldClaudePlanRun(KEY, OWNER)
    expect(held).not.toBeNull()
    const m2 = new ClaudePlanModel({ ...base(folder), holdKey: { ...KEY, version: '1' }, held: held! })
    const requests = first.parts.filter(p => p.type === 'tool-approval-request')
    const messages: any[] = [...PROMPT, ...first.response.messages,
      { role: 'tool', content: requests.map(r => ({ type: 'tool-approval-response', approvalId: r.approvalId, approved: answers(r.toolCall.input.city) })) }]
    const result = streamText({ model: m2, messages, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools(timeline), m2), stopWhen: () => false,
      toolApproval: wrapClaudePlanApprovals(policy as any, m2) as any })
    const { parts, failure } = await collectToEnd(result)
    return { m2, parts, failure, steps: await result.steps }
  }

  it('a call that needs approval raises the card and the run waits at it; nothing that needed approval ran, and the call behind it is carried', async () => {
    const folder = project(PARIS_OSLO)
    const timeline: Timeline = []
    const first = await toCard(folder, parisNeedsApproval, timeline)
    expect(first.failure).toBeNull()
    expect(first.parts.filter(p => p.type === 'tool-approval-request').map(p => p.toolCall.input.city)).toEqual(['Paris'])
    // D3: Oslo waits behind Paris inside Claude Code, so it is not offered yet.
    expect(first.parts.filter(p => p.type === 'tool-call').map(p => p.input.city)).toEqual(['Paris'])
    expect(timeline).toEqual([])
    const run = first.m.currentRun!
    expect(isClaudePlanRunHeld(KEY)).toBe(true)
    expect(run.isEnded).toBe(false)
    expect(run.isHolding).toBe(true)
    // The request's finalize backstop leaves a held run to the registry (Faye, P2 Part 3 read, answer 4).
    first.m.endReply()
    expect(run.isEnded).toBe(false)
    expect(fakeLog(folder).filter(e => e.kind === 'model-call')).toHaveLength(1)
  })

  it('the click claims the run: the approved call runs once, the carried call follows with no model call, and Claude goes on in the same run', async () => {
    const folder = project(PARIS_OSLO)
    const timeline: Timeline = []
    const first = await toCard(folder, parisNeedsApproval, timeline)
    const run = first.m.currentRun!
    const resumed = await click(folder, first, () => true, parisNeedsApproval, timeline)
    expect(resumed.failure).toBeNull()
    expect(resumed.m2.currentRun).toBe(run)
    expect(timeline.map(t => t.what)).toEqual(['start Paris', 'end Paris', 'start Oslo', 'end Oslo'])
    expect(resumed.parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('Done.')
    // The carried step made no model call: its usage is a known zero, and Claude Code made two calls in all.
    expect(resumed.steps[0].toolCalls.map(call => (call.input as any).city)).toEqual(['Oslo'])
    expect(resumed.steps[0].usage.inputTokens).toBe(0)
    expect(resumed.steps[0].usage.outputTokens).toBe(0)
    const log = fakeLog(folder)
    expect(log.filter(e => e.kind === 'start')).toHaveLength(1)
    expect(log.filter(e => e.kind === 'model-call')).toHaveLength(2)
    expect(await run.settled).toBe('exited')
  })

  it('BL-2368: a card and a misnamed call in one message: the card holds the run, the click resumes it, and the misnamed call, answered late, passes', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }, { type: 'tool_use', id: 'toolu_misnamed', name: 'batshit__get_weather', input: { city: 'Oslo' }, lateRecord: true }] },
      { blocks: [{ type: 'text', text: 'Done.' }] }
    ] })
    const timeline: Timeline = []
    const first = await toCard(folder, parisNeedsApproval, timeline)
    expect(first.failure).toBeNull()
    expect(first.parts.filter(p => p.type === 'tool-approval-request').map(p => p.toolCall.input.city)).toEqual(['Paris'])
    expect(first.parts.find(p => p.type === 'tool-error')).toMatchObject({ toolCallId: 'toolu_misnamed' })
    expect(isClaudePlanRunHeld(KEY)).toBe(true)
    const resumed = await click(folder, first, () => true, parisNeedsApproval, timeline)
    expect(resumed.failure).toBeNull()
    expect(timeline.map(t => t.what)).toEqual(['start Paris', 'end Paris'])
    expect(resumed.parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('Done.')
    // The note survived the hold and reached Claude with the step's batch.
    expect(fakeLog(folder).find(e => e.kind === 'batch-passed')?.note).toContain('no tool is named batshit__get_weather')
    expect(await resumed.m2.currentRun!.settled).toBe('exited')
  })

  it('BL-2368: a card, a carried call and a misnamed call in one message: all three settle in the same run (D3)', async () => {
    const folder = project({ turns: [
      { blocks: [
        { type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } },
        { type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Oslo' } },
        { type: 'tool_use', name: 'batshit__get_weather', input: { city: 'Rome' } }
      ] },
      { blocks: [{ type: 'text', text: 'Done.' }] }
    ] })
    const timeline: Timeline = []
    const first = await toCard(folder, parisNeedsApproval, timeline)
    expect(first.failure).toBeNull()
    expect(first.parts.filter(p => p.type === 'tool-call').map(p => p.input.city)).toEqual(['Paris', 'Rome'])
    const resumed = await click(folder, first, () => true, parisNeedsApproval, timeline)
    expect(resumed.failure).toBeNull()
    expect(timeline.map(t => t.what)).toEqual(['start Paris', 'end Paris', 'start Oslo', 'end Oslo'])
    expect(resumed.parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('Done.')
    // The note waited through the carried step and reached Claude with the native step's batch.
    expect(fakeLog(folder).find(e => e.kind === 'batch-passed')?.note).toContain('no tool is named batshit__get_weather')
    expect(fakeLog(folder).filter(e => e.kind === 'model-call')).toHaveLength(2)
    expect(await resumed.m2.currentRun!.settled).toBe('exited')
  })

  it('a denied call: Claude Code\'s waiting call gets the denial, nothing ran, and Claude goes on', async () => {
    const folder = project(PARIS_OSLO)
    const timeline: Timeline = []
    const first = await toCard(folder, parisNeedsApproval, timeline)
    const resumed = await click(folder, first, () => false, parisNeedsApproval, timeline)
    expect(resumed.failure).toBeNull()
    expect(timeline.map(t => t.what)).toEqual(['start Oslo', 'end Oslo'])
    expect(resumed.parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('Done.')
    expect(await resumed.m2.currentRun!.settled).toBe('exited')
  })

  it('review A M2: two write calls in a row that need approval come one card at a time; a denied first card leaves the second to its own card (a static rule)', async () => {
    const folder = project(PARIS_OSLO)
    const timeline: Timeline = []
    const first = await toCard(folder, { get_weather: 'user-approval' }, timeline)
    expect(first.parts.filter(p => p.type === 'tool-approval-request').map(p => p.toolCall.input.city)).toEqual(['Paris'])
    const resumed = await click(folder, first, () => false, { get_weather: 'user-approval' }, timeline)
    expect(resumed.failure).toBeNull()
    // Paris denied (nothing ran); Oslo's own card is raised next, and the run waits again.
    expect(resumed.parts.filter(p => p.type === 'tool-approval-request').map(p => p.toolCall.input.city)).toEqual(['Oslo'])
    expect(timeline).toEqual([])
    resumed.m2.endReplyAtLoopEnd()
    expect(isClaudePlanRunHeld({ ...KEY, version: '1' })).toBe(true)
  })

  it('review A M2: two read-only calls in a row that need approval share one card moment; mixed answers leave no call waiting', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__read_file', input: { path: 'a.txt' } }, { type: 'tool_use', name: 'mcp__batshit__read_file', input: { path: 'b.txt' } }] },
      { blocks: [{ type: 'text', text: 'Done.' }] }
    ] })
    const timeline: Timeline = []
    const policy = { read_file: 'user-approval' }
    const m = new ClaudePlanModel({ ...base(folder), holdKey: KEY })
    const result = streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools(timeline), m), stopWhen: () => false, toolApproval: wrapClaudePlanApprovals(policy as any, m) as any })
    const { parts } = await collectToEnd(result)
    m.endReplyAtLoopEnd()
    expect(parts.filter(p => p.type === 'tool-approval-request').map(p => p.toolCall.input.path)).toEqual(['a.txt', 'b.txt'])
    const held = claimHeldClaudePlanRun(KEY, OWNER)!
    const m2 = new ClaudePlanModel({ ...base(folder), holdKey: { ...KEY, version: '1' }, held })
    const requests = parts.filter(p => p.type === 'tool-approval-request')
    const messages: any[] = [...PROMPT, ...(await result.response).messages,
      { role: 'tool', content: requests.map(r => ({ type: 'tool-approval-response', approvalId: r.approvalId, approved: r.toolCall.input.path === 'b.txt' })) }]
    const resumed = await collectToEnd(streamText({ model: m2, messages, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools(timeline), m2), stopWhen: () => false, toolApproval: wrapClaudePlanApprovals(policy as any, m2) as any }))
    expect(resumed.failure).toBeNull()
    expect(timeline.filter(t => t.what.startsWith('start')).map(t => t.what)).toEqual(['start b.txt'])
    expect(resumed.parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('Done.')
    await m2.currentRun!.settled
  })

  it('review A M1: an approved call whose rule answers "not needed" by the replay (an approval window the click opened) still runs', async () => {
    const folder = project(PARIS_OSLO)
    const timeline: Timeline = []
    const window = { open: false }
    const policy = { get_weather: async (input: any) => (input.city === 'Paris' && !window.open ? 'user-approval' as const : undefined) }
    const first = await toCard(folder, policy, timeline)
    window.open = true
    const resumed = await click(folder, first, () => true, policy, timeline)
    expect(resumed.failure).toBeNull()
    expect(timeline.map(t => t.what)).toEqual(['start Paris', 'end Paris', 'start Oslo', 'end Oslo'])
    expect(resumed.parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('Done.')
  })

  it('review A M1: a carried call\'s card is decided when it is offered, not when its message ended', async () => {
    const folder = project(PARIS_OSLO)
    const timeline: Timeline = []
    // Both need approval when the message ends; approving Paris opens a window that covers Oslo too.
    const window = { open: false }
    const policy = { get_weather: async () => (window.open ? undefined : 'user-approval' as const) }
    const first = await toCard(folder, policy, timeline)
    window.open = true
    const resumed = await click(folder, first, () => true, policy, timeline)
    expect(resumed.failure).toBeNull()
    expect(resumed.parts.some(p => p.type === 'tool-approval-request')).toBe(false)
    expect(timeline.filter(t => t.what.startsWith('start')).map(t => t.what)).toEqual(['start Paris', 'start Oslo'])
  })

  it('review A M3: a call that ran before the card is not compared again on resume (the saved transcript turns an image into a note)', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Rome' } }, { type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'Done.' }] }
    ] })
    const timeline: Timeline = []
    const first = await toCard(folder, parisNeedsApproval, timeline)
    expect(timeline.map(t => t.what)).toEqual(['start Rome', 'end Rome'])
    const held = claimHeldClaudePlanRun(KEY, OWNER)!
    const m2 = new ClaudePlanModel({ ...base(folder), holdKey: { ...KEY, version: '1' }, held })
    const requests = first.parts.filter(p => p.type === 'tool-approval-request')
    // As the saved transcript has it: Rome's result is the sanitized copy, not the bytes Claude Code holds.
    const replayed = first.response.messages.map((message: any) => message.role !== 'tool' ? message : { ...message, content: message.content.map((part: any) =>
      part.type === 'tool-result' && part.toolName === 'get_weather' ? { ...part, output: { type: 'text', value: '[An image was here; it is not kept in the transcript.]' } } : part) })
    const messages: any[] = [...PROMPT, ...replayed, { role: 'tool', content: requests.map(r => ({ type: 'tool-approval-response', approvalId: r.approvalId, approved: true })) }]
    const resumed = await collectToEnd(streamText({ model: m2, messages, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools(timeline), m2), stopWhen: () => false, toolApproval: wrapClaudePlanApprovals(parisNeedsApproval as any, m2) as any }))
    expect(resumed.failure).toBeNull()
    expect(resumed.parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('Done.')
    await m2.currentRun!.settled
  })

  it('review B S5: a continuation for another model or effort is refused, and the held run ends; nothing ran', async () => {
    const folder = project(PARIS_OSLO)
    const timeline: Timeline = []
    await toCard(folder, parisNeedsApproval, timeline)
    const held = claimHeldClaudePlanRun(KEY, OWNER)!
    expect(() => new ClaudePlanModel({ ...base(folder), effort: 'high', holdKey: { ...KEY, version: '1' }, held })).toThrow(expect.objectContaining({ code: 'resume_changed' }))
    expect(await held.run.settled).toBe('exited')
    expect(timeline).toEqual([])
  })

  it('the card\'s own clock ends a held run with every browser closed; a later click finds nothing and runs nothing', async () => {
    const folder = project(PARIS_OSLO)
    const timeline: Timeline = []
    const first = await toCard(folder, parisNeedsApproval, timeline, { holdMs: 200 })
    const run = first.m.currentRun!
    expect(await run.settled).toBe('exited')
    expect(isClaudePlanRunHeld(KEY)).toBe(false)
    expect(claimHeldClaudePlanRun(KEY, OWNER)).toBeNull()
    expect(timeline).toEqual([])
  })

  it('a click for another agent ends the held run and runs nothing; a second claim finds nothing', async () => {
    const folder = project(PARIS_OSLO)
    const first = await toCard(folder, parisNeedsApproval, [])
    expect(claimHeldClaudePlanRun(KEY, { userId: 'u1', agentId: 'someone-else' })).toBeNull()
    expect(await first.m.currentRun!.settled).toBe('exited')
    expect(claimHeldClaudePlanRun(KEY, OWNER)).toBeNull()
  })

  it('Stop in the gap (or a new ordinary turn) ends only held runs, and awaits their exit', async () => {
    const folder = project(PARIS_OSLO)
    const first = await toCard(folder, parisNeedsApproval, [])
    // A run of the same chat that is not held (a reply still running) is left alone.
    const otherFolder = project({ turns: [{ blocks: [{ type: 'text', text: 'Still going.' }], stallMs: 2000 }] })
    const other = model(otherFolder)
    const running = collectToEnd(streamText({ model: other, messages: PROMPT, allowSystemInMessages: true }))
    await vi.waitFor(() => expect(other.currentRun).not.toBeNull(), { timeout: 5000 })
    expect(await endHeldClaudePlanRuns({ sessionId: 's1' }, 'Stopped after the reply.')).toEqual({ ended: 1, unsettled: 0 })
    expect(first.m.currentRun!.isEnded).toBe(true)
    expect(isClaudePlanRunHeld(KEY)).toBe(false)
    expect(other.currentRun!.isEnded).toBe(false)
    await running
  })

  it('a second card later in the same message: the carried call runs, then the reply ends at the next card and the run is held again under the new version', async () => {
    const folder = project({ turns: [
      { blocks: ['Paris', 'Oslo', 'Rome'].map(city => ({ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city } })) },
      { blocks: [{ type: 'text', text: 'Done.' }] }
    ] })
    const timeline: Timeline = []
    const policy = { get_weather: async (input: any) => (input.city === 'Oslo' ? undefined : 'user-approval' as const) }
    const first = await toCard(folder, policy, timeline)
    expect(first.parts.filter(p => p.type === 'tool-approval-request').map(p => p.toolCall.input.city)).toEqual(['Paris'])
    const resumed = await click(folder, first, () => true, policy, timeline)
    expect(resumed.failure).toBeNull()
    expect(resumed.parts.filter(p => p.type === 'tool-approval-request').map(p => p.toolCall.input.city)).toEqual(['Rome'])
    expect(timeline.filter(t => t.what.startsWith('start')).map(t => t.what)).toEqual(['start Paris', 'start Oslo'])
    resumed.m2.endReplyAtLoopEnd()
    expect(isClaudePlanRunHeld({ ...KEY, version: '1' })).toBe(true)
    expect(fakeLog(folder).filter(e => e.kind === 'model-call')).toHaveLength(1)
  })

  it('the idle backstop never ends a run held at a card (the card\'s clock rules), and the run goes on after the click', async () => {
    const folder = project(PARIS_OSLO)
    const timeline: Timeline = []
    const first = await toCard(folder, parisNeedsApproval, timeline, { timing: { idleMs: 150 } })
    const run = first.m.currentRun!
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(run.isEnded).toBe(false)
    const resumed = await click(folder, first, () => true, parisNeedsApproval, timeline)
    expect(resumed.failure).toBeNull()
    expect(resumed.parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('Done.')
  })

  it('chat delete (and every owner sweep) reaches a held run and awaits its exit', async () => {
    const folder = project(PARIS_OSLO)
    const first = await toCard(folder, parisNeedsApproval, [])
    expect(await endClaudePlanRuns({ sessionId: 's1' }, 'Chat deleted.')).toMatchObject({ ended: 1, unsettled: 0 })
    expect(first.m.currentRun!.isEnded).toBe(true)
    expect(isClaudePlanRunHeld(KEY)).toBe(false)
  })

  it('an approval rule that answers differently the second time stops the reply; nothing that needed approval ran', async () => {
    const folder = project(PARIS_OSLO)
    const timeline: Timeline = []
    let asked = 0
    const flaky = { get_weather: async (input: any) => (input.city === 'Paris' && ++asked > 1 ? 'user-approval' as const : undefined) }
    const first = await toCard(folder, flaky, timeline)
    expect((first.failure as ClaudePlanRunError)?.code).toBe('integrity')
    expect(timeline.some(t => t.what === 'start Paris')).toBe(false)
    expect(await first.m.currentRun!.settled).toBe('exited')
  })
})

describe('Claude plan run: Stop recording order (BL-1959, SSE FM)', () => {
  it('a Stop while a later call waits for its admission records only the call that ran', async () => {
    const folder = project({ turns: [
      { blocks: ['Paris', 'Oslo'].map(city => ({ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city } })) },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    const m = model(folder)
    const stop = new AbortController()
    const ran: string[] = []
    // The inner tool tracks its execution exactly as the readable wrapper does (vercelBrain, BL-1959).
    const tools = { get_weather: tool({ description: 'w', inputSchema: z.object({ city: z.string() }), execute: (input, options) => {
      const value = (async () => {
        ran.push(input.city)
        setTimeout(() => stop.abort(new Error('Stop')), 50)
        await new Promise((resolve, reject) => options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal!.reason), { once: true }))
        return 'never'
      })()
      trackToolExecution(runAbortSignalOf(options), options.toolCallId, 'get_weather', input, value)
      return value
    } }) }
    const result = await streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(tools, m), abortSignal: stop.signal, stopWhen: () => false })
    const parts: any[] = []
    for await (const part of withToolResultsOnStop(result.stream, stop.signal, { waitMs: 200 })) parts.push(part)
    expect(ran).toEqual(['Paris'])
    const recorded = parts.filter(p => p.type === 'tool-result' || p.type === 'tool-error').map(p => p.input?.city)
    expect(recorded).toEqual(['Paris'])
    expect(await m.currentRun!.settled).toBe('exited')
  })
})

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')

describe('Claude plan run: review fixes (2026-10-27)', () => {
  it('A-M1: a result Claude Code recorded differently from the one Batshit sent ends the run', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' }, fault: 'record-different' }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    const m = model(folder)
    await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools([]), m), stopWhen: () => false }))
    expect(m.currentRun!.failure?.code).toBe('integrity')
    expect(m.currentRun!.failure?.message).toMatch(/recorded a different tool result/)
    expect(fakeLog(folder).filter(e => e.kind === 'model-call')).toHaveLength(1)
    await m.currentRun!.settled
  })

  it('A-S1: PreToolUse waits out a slow message tail (600 s timeout); a short timeout would fail the call', async () => {
    const scenario = { turns: [
      { gapMs: 1500, blocks: ['Paris', 'Oslo'].map(city => ({ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city } })) },
      { blocks: [{ type: 'text', text: 'Both.' }] }
    ] }
    const folder = project(scenario)
    const m = model(folder)
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools([]), m), stopWhen: () => false }))
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('Both.')
    expect(fakeLog(folder).find(e => e.kind === 'start').settings.hooks.PreToolUse[0].hooks[0].timeout).toBe(600)
    await m.currentRun!.settled

    const short = project(scenario)
    const hurried = model(short, { preHookSeconds: 1 })
    await collect(streamText({ model: hurried, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools([]), hurried), stopWhen: () => false }))
    expect(hurried.currentRun!.failure?.code).toBe('integrity')
    await hurried.currentRun!.settled
  })

  it('A-S2: a Claude Code that does not run Batshit\'s hooks (a hooks-off policy) is refused before any prompt', async () => {
    const folder = project({ sessionHookSkipped: true, turns: [{ blocks: [{ type: 'text', text: 'never' }] }] })
    const m = model(folder, { sessionStartMs: 800 })
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true }))
    const error = parts.find(p => p.type === 'error')?.error
    expect(error.code).toBe('startup_refused')
    expect(error.message).toMatch(/disableAllHooks or allowManagedHooksOnly/)
    expect(fakeLog(folder).filter(e => e.kind === 'prompt')).toEqual([])
    expect(fakeLog(folder).filter(e => e.kind === 'model-call')).toEqual([])
    await m.currentRun!.settled
  })

  it('A-M1: a batch whose results Claude Code never recorded is refused before the next model call', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' }, fault: 'no-record' }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    const m = model(folder, { recordedWaitMs: 300 })
    await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools([]), m), stopWhen: () => false }))
    expect(m.currentRun!.failure?.message).toMatch(/without recording the results/)
    expect(fakeLog(folder).filter(e => e.kind === 'model-call')).toHaveLength(1)
    await m.currentRun!.settled
  })

  it('Faye S3: a batch of only EndConversation ends normally, never as integrity', async () => {
    const folder = project({ batchIdsOverride: ['toolu_end'], turns: [
      { blocks: [{ type: 'tool_use', id: 'toolu_end', name: 'EndConversation', input: {} }] }
    ] })
    const m = model(folder)
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true }))
    expect(parts.find(p => p.type === 'error')?.error.code).toBe('end_conversation')
    expect(m.currentRun!.failure).toBeNull()
    await m.currentRun!.settled

    // The batch handler itself: only EndConversation ids answer {} at once; an empty batch fails fast.
    const run = new ClaudePlanRun({ executable, runAs: {}, cliModel: null, effort: null, workingDirectory: folder, owner: { userId: 'u', sessionId: 'x', agentId: 'a', kind: 'primary' } })
    ;(run as any).endConversationIds.add('toolu_end')
    const answers: unknown[] = []
    await (run as any).onBatch({ ids: ['toolu_end'] }, (body: unknown) => answers.push(body))
    expect(answers).toEqual([{}])
    expect(run.failure).toBeNull()
    await (run as any).onBatch({ ids: [] }, (body: unknown) => answers.push(body))
    expect(run.failure?.code).toBe('integrity')
  })

  it('A-S3: a batch that names no call fails at once instead of hanging', async () => {
    const folder = project({ batchIdsOverride: [], turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    const m = model(folder)
    const started = Date.now()
    await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools([]), m), stopWhen: () => false }))
    expect(m.currentRun!.failure?.code).toBe('integrity')
    expect(Date.now() - started).toBeLessThan(5000)
    await m.currentRun!.settled
  })

  it('A-S4: a model call that goes silent is ended by the idle backstop', async () => {
    const folder = project({ turns: [{ stallMs: 2000, blocks: [{ type: 'text', text: 'too late' }] }] })
    const m = model(folder, { idleMs: 400 })
    await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true }))
    expect(m.currentRun!.failure?.message).toMatch(/idle/)
    await m.currentRun!.settled
  })

  it('A-S5: an unconfirmed exit keeps owners failing closed, and a later exit clears it', async () => {
    const folder = project({ ignoreTerm: true, turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    const m = model(folder, { stopGraceMs: 900, settleBoundMs: 200 })
    await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools([]), m) }))
    const outcome = await endClaudePlanRuns({ sessionId: 's1' }, 'chat deleted')
    expect(outcome.unsettled).toBe(1)
    expect(listClaudePlanRuns({ sessionId: 's1' })).toHaveLength(1)
    await m.currentRun!.exited
    expect(listClaudePlanRuns({ sessionId: 's1' })).toEqual([])
    expect(processesNaming(folder)).toEqual([])
  })

  it('N2: Claude Code\'s messaging socket is left after a clean exit and removed after a Stop', async () => {
    const clean = project({ messagingSocket: true, leaveSocketOnExit: true, turns: [{ blocks: [{ type: 'text', text: 'done' }] }] })
    const m = model(clean)
    await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true }))
    await m.currentRun!.settled
    const pid = fakeLog(clean).find(e => e.kind === 'start').pid
    expect(existsSync(path.join(clean, 'cc-socks', `${pid}.sock`))).toBe(true)

    const stopped = project({ messagingSocket: true, turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    const s2 = model(stopped)
    const stop = new AbortController()
    const tools = { get_weather: tool({ description: 'w', inputSchema: z.object({ city: z.string() }), execute: async (_input, { abortSignal }) => {
      setTimeout(() => stop.abort(new Error('Stop')), 50)
      await new Promise((resolve, reject) => abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), { once: true }))
      return 'never'
    } }) }
    await collect(streamText({ model: s2, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(tools, s2), abortSignal: stop.signal, stopWhen: () => false }))
    await s2.currentRun!.settled
    const pid2 = fakeLog(stopped).find(e => e.kind === 'start').pid
    expect(existsSync(path.join(stopped, 'cc-socks', `${pid2}.sock`))).toBe(false)
  })

  it('N3: a repeated call id fails the step with no call offered', async () => {
    const folder = project({ turns: [{ blocks: [
      { type: 'tool_use', id: 'toolu_same', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } },
      { type: 'tool_use', id: 'toolu_same', name: 'mcp__batshit__get_weather', input: { city: 'Oslo' } }
    ] }] })
    const m = model(folder)
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools([]), m), stopWhen: () => false }))
    expect(parts.filter(p => p.type === 'tool-call')).toEqual([])
    expect(m.currentRun!.failure?.code).toBe('integrity')
    await m.currentRun!.settled
  })

  it('N4: a large multi-byte input crosses socket chunks and is admitted exactly', async () => {
    const city = `Zürich ☀️ ${'é'.repeat(40_000)}`
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city } }] },
      { blocks: [{ type: 'text', text: 'ok' }] }
    ] })
    const timeline: Timeline = []
    const m = model(folder)
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools(timeline), m), stopWhen: () => false }))
    expect(timeline[0].what).toBe(`start ${city}`)
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('ok')
    await m.currentRun!.settled
  })

  it('B-S2: an image is released with the type its bytes name, as the SDK\'s next prompt holds it', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__photo', input: {} }] },
      { blocks: [{ type: 'text', text: 'A photo.' }] }
    ] })
    const m = model(folder)
    const tools = { photo: tool({
      description: 'A photo.', inputSchema: z.object({}),
      execute: async () => ({ ok: true }),
      toModelOutput: () => ({ type: 'content', value: [{ type: 'text', text: 'Here.' }, { type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data: PNG.toString('base64') } }] }) as any
    }) }
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(tools, m), stopWhen: () => false }))
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('A photo.')
    expect(m.currentRun!.failure).toBeNull()
    const mcpOut = fakeLog(folder).filter(e => e.kind === 'model-call')
    expect(mcpOut).toHaveLength(2)
    await m.currentRun!.settled
  })

  it('Faye S8: an image Claude Code resized and re-encoded still matches (recorded images compare by count)', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__photo', input: {}, fault: 'reencode-image' }] },
      { blocks: [{ type: 'text', text: 'Seen.' }] }
    ] })
    const m = model(folder)
    const tools = { photo: tool({
      description: 'A photo.', inputSchema: z.object({}),
      execute: async () => ({ ok: true }),
      toModelOutput: () => ({ type: 'content', value: [{ type: 'file', mediaType: 'image/png', data: { type: 'data', data: PNG.toString('base64') } }] }) as any
    }) }
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(tools, m), stopWhen: () => false }))
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('Seen.')
    expect(m.currentRun!.failure).toBeNull()
    await m.currentRun!.settled
  })

  it('B-S2: an image link is downloaded through the request\'s download before release; a refused download fails by name', async () => {
    const turns = [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__photo', input: {} }] },
      { blocks: [{ type: 'text', text: 'Fetched.' }] }
    ]
    const tools = { photo: tool({
      description: 'A photo.', inputSchema: z.object({}),
      execute: async () => ({ ok: true }),
      toModelOutput: () => ({ type: 'content', value: [{ type: 'file', mediaType: 'image/*', data: { type: 'url', url: new URL('https://example.com/p.png') } }] }) as any
    }) }
    const calls: string[] = []
    const download = async (requests: Array<{ url: URL }>) => requests.map(request => { calls.push(request.url.href); return { data: new Uint8Array(PNG), mediaType: 'image/png' } })
    const folder = project({ turns })
    const m = model(folder)
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(tools, m, { download }), experimental_download: download as any, stopWhen: () => false }))
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('Fetched.')
    expect(calls.length).toBeGreaterThanOrEqual(2)
    await m.currentRun!.settled

    const refusedFolder = project({ turns })
    const refused = model(refusedFolder)
    await collect(streamText({ model: refused, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(tools, refused, { download: async requests => requests.map(() => null) }), stopWhen: () => false }))
    expect(refused.currentRun!.failure?.code).toBe('unsupported_input')
    expect(refused.currentRun!.failure?.message).toMatch(/https:\/\/example\.com\/p\.png/)
    await refused.currentRun!.settled
  })

  it('B-S3: a result for a call Batshit never admitted (an unwrapped tool) is an integrity failure', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    const m = model(folder)
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: weatherTools([]), stopWhen: () => false }))
    expect(parts.find(p => p.type === 'error')?.error.code).toBe('integrity')
    expect(m.currentRun!.failure?.message).toMatch(/never admitted/)
    await m.currentRun!.settled
  })

  it('B-S4: billed thinking tokens read as reasoning, the rest as text', async () => {
    const folder = project({ turns: [{ thinkingTokens: 12, blocks: [{ type: 'thinking', text: 'Hm.' }, { type: 'text', text: 'Hi.' }] }] })
    const m = model(folder)
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true }))
    const finish = parts.find(p => p.type === 'finish-step')
    expect(finish.usage.outputTokens).toBe(42)
    expect(finish.usage.outputTokenDetails).toMatchObject({ reasoningTokens: 12, textTokens: 30 })
    await m.currentRun!.settled
  })

  it('B-N4: a reply that ends on an output limit with no calls ends the run by signal', async () => {
    const folder = project({ turns: [{ stop_reason: 'max_tokens', blocks: [{ type: 'text', text: 'cut' }] }] })
    const m = model(folder)
    const parts = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true }))
    expect(parts.find(p => p.type === 'finish-step').finishReason).toBe('length')
    expect(m.currentRun!.failure?.code).toBe('run_ended')
    expect(await m.currentRun!.settled).toBe('exited')
  })

  it('B-N5: the formatted-output cache is empty once the reply is over', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'ok' }] }
    ] })
    const m = model(folder)
    await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true, tools: wrapClaudePlanToolSet(weatherTools([]), m), stopWhen: () => false }))
    for (const cache of (m as any).formatCaches) expect(cache.size).toBe(0)
    await m.currentRun!.settled
  })

  it('B-N6: a start refused before any run existed may be tried again on the same model', async () => {
    const folder = project({ turns: [{ blocks: [{ type: 'text', text: 'second try' }] }] })
    const m = model(folder)
    const reopen = closeClaudePlanRunAdmission('restore in progress')
    const first = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true }))
    expect(first.find(p => p.type === 'error')?.error.message).toMatch(/restore in progress/)
    reopen()
    const second = await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true }))
    expect(second.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('second try')
    await m.currentRun!.settled
  })

  it('Thinking On writes alwaysThinkingEnabled true', async () => {
    const folder = project({ turns: [{ blocks: [{ type: 'text', text: 'ok' }] }] })
    const m = new ClaudePlanModel({
      modelId: 'claude-opus-4-6', cliModel: 'claude-opus-4-6', effort: null, alwaysThinking: true,
      owner: { userId: 'u1', sessionId: 's1', agentId: 'a1', kind: 'primary' }, workingDirectory: folder, executable, runAs: {}
    })
    await collect(streamText({ model: m, messages: PROMPT, allowSystemInMessages: true }))
    expect(fakeLog(folder).find(e => e.kind === 'start').settings.alwaysThinkingEnabled).toBe(true)
    await m.currentRun!.settled
  })

  it('Part 2 (D12, M4): a sampling option, output limit or forced tool choice is refused by name before any run', async () => {
    for (const [option, value] of [['temperature', 0.2], ['maxOutputTokens', 100], ['stopSequences', ['END']], ['toolChoice', 'required'], ['reasoning', 'high']] as const) {
      const folder = project({ turns: [{ blocks: [{ type: 'text', text: 'never' }] }] })
      const parts = await collect(streamText({
        model: model(folder), messages: PROMPT, allowSystemInMessages: true, [option]: value,
        ...(option === 'toolChoice' ? { tools: wrapClaudePlanToolSet(weatherTools([]), model(folder)) } : {})
      } as any))
      expect(parts.find(p => p.type === 'error')?.error).toMatchObject({ code: 'unsupported_input', message: expect.stringContaining(option) })
      expect(fakeLog(folder)).toEqual([])
    }
    expect(listClaudePlanRuns()).toEqual([])
  })
})

/** The fake's pid and every bridge or hook process of its run folder, still running. */
function processesNaming(folder: string): string[] {
  const start = fakeLog(folder).find(e => e.kind === 'start')
  const text = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  return text.split('\n').map(line => line.trim()).filter(line => {
    const pid = Number(line.split(/\s+/)[0])
    return (start && pid === start.pid) || (line.includes('claude-plan-bridge.cjs') && start && line.includes(String(start.argv[start.argv.indexOf('--mcp-config') + 1]).replace(/\/mcp\.json$/, '')))
  })
}
