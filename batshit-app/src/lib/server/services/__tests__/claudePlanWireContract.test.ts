// @vitest-environment node
/**
 * SA-139 P2 (D13, V10): the fields the Claude plan connection reads hold on recorded REAL events of the
 * pinned Claude Code (`fixtures/claude-plan/recorded/`, from the live proof), and the test double the
 * other tests use speaks the same shapes. A drift in either fails here.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { streamText, tool } from 'ai'
import { z } from 'zod'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { formatSteerForModel } from '$lib/utils/steerControl'

import { bindClaudePlanExecutable } from '../claudePlanExecutable'
import { claudeCodeNoSuchToolText, prepareClaudePlanTools, recordedClaudePlanToolAnswer, sameClaudePlanToolAnswer } from '../claudePlanProtocol'
import { checkEffortSupport, readModelCatalog } from '../claudePlanRun'
import { ClaudePlanModel, wrapClaudePlanToolSet } from '../claudePlanModel'
import {
  CLAUDE_PLAN_DOCUMENTED_ONLY_KINDS,
  CLAUDE_PLAN_HOOK_CONTRACT,
  CLAUDE_PLAN_MCP_CONTRACT,
  CLAUDE_PLAN_NOT_YET_RECORDED_KINDS,
  CLAUDE_PLAN_STDOUT_CONTRACT,
  checkClaudePlanWire,
  claudePlanStdoutKind
} from '../claudePlanWireContract'
import { writeRecordingBridge } from './fixtures/claude-plan/recordingBridge'

vi.unmock('ai')

const RECORDED = path.resolve(__dirname, 'fixtures/claude-plan/recorded')
const FAKE = path.resolve(__dirname, 'fixtures/claude-plan/fake-claude.mjs')
const work = mkdtempSync(path.join(os.tmpdir(), 'sa139-p2-contract-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const lines = (file: string) => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))

type Traffic = { stdout: any[]; bridge: any[] }

function audit(traffic: Traffic) {
  const problems: string[] = []
  const seen = { stdout: new Set<string>(), hooks: new Set<string>(), mcp: new Set<string>() }
  for (const event of traffic.stdout) {
    const kind = claudePlanStdoutKind(event)
    if (!kind) continue
    seen.stdout.add(kind)
    problems.push(...checkClaudePlanWire(CLAUDE_PLAN_STDOUT_CONTRACT, kind, event))
  }
  for (const entry of traffic.bridge) {
    if (entry.direction === 'hook-in') {
      seen.hooks.add(entry.body.hook_event_name)
      problems.push(...checkClaudePlanWire(CLAUDE_PLAN_HOOK_CONTRACT, entry.body.hook_event_name, entry.body))
    } else if (entry.direction === 'mcp-in' && entry.body.method in CLAUDE_PLAN_MCP_CONTRACT) {
      seen.mcp.add(entry.body.method)
      problems.push(...checkClaudePlanWire(CLAUDE_PLAN_MCP_CONTRACT, entry.body.method, entry.body))
    }
  }
  return { problems, seen }
}

const everyKind = {
  stdout: Object.keys(CLAUDE_PLAN_STDOUT_CONTRACT).sort(),
  hooks: Object.keys(CLAUDE_PLAN_HOOK_CONTRACT).sort(),
  mcp: Object.keys(CLAUDE_PLAN_MCP_CONTRACT).sort()
}

describe('Claude plan wire contract (D13)', () => {
  it('holds on every recorded real event of the pin, and the recordings cover every contract kind', () => {
    const names = readdirSync(RECORDED).filter(name => name.endsWith('.stdout.jsonl')).map(name => name.replace('.stdout.jsonl', ''))
    expect(names.length).toBeGreaterThan(0)
    const traffic: Traffic = { stdout: [], bridge: [] }
    for (const name of names) {
      traffic.stdout.push(...lines(path.join(RECORDED, `${name}.stdout.jsonl`)))
      traffic.bridge.push(...lines(path.join(RECORDED, `${name}.bridge.jsonl`)))
    }
    const { problems, seen } = audit(traffic)
    expect(problems).toEqual([])
    const recordable = (kinds: string[]) => kinds.filter(kind => !CLAUDE_PLAN_DOCUMENTED_ONLY_KINDS.has(kind) && !CLAUDE_PLAN_NOT_YET_RECORDED_KINDS.has(kind))
    expect([...seen.stdout].sort()).toEqual(recordable(everyKind.stdout))
    expect([...seen.hooks].sort()).toEqual(recordable(everyKind.hooks))
    expect([...seen.mcp].sort()).toEqual(everyKind.mcp)
    // The pin is what was recorded.
    expect(traffic.stdout.find(event => event.type === 'system' && event.subtype === 'init').claude_code_version).toBe('2.1.296')
  })

  it('holds on the test double, which covers the same kinds', async () => {
    const folder = mkdtempSync(path.join(work, 'project-'))
    writeFileSync(path.join(folder, 'scenario.json'), JSON.stringify({ turns: [
      { blocks: [{ type: 'thinking', text: 'Plan.' }, { type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city: 'Paris' } }] },
      { blocks: [{ type: 'text', text: 'Sunny.' }] }
    ] }))
    const target = path.join(folder, 'bridge.jsonl')
    const stdout: any[] = []
    const executable = await bindClaudePlanExecutable({ resolution: { executable: FAKE, source: 'env' }, runAs: {} })
    const m = new ClaudePlanModel({
      modelId: 'claude-haiku-5-5', cliModel: 'claude-haiku-5-5', effort: null,
      owner: { userId: 'u', sessionId: 'contract', agentId: 'a', kind: 'primary' }, workingDirectory: folder, executable, runAs: {},
      scriptsDir: writeRecordingBridge(folder, target), onRawEvent: event => stdout.push(event)
    })
    const tools = { get_weather: tool({ description: 'w', inputSchema: z.object({ city: z.string() }), execute: async ({ city }) => `${city}: sunny` }) }
    const result = await streamText({ model: m, allowSystemInMessages: true, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], tools: wrapClaudePlanToolSet(tools, m), stopWhen: () => false })
    for await (const _part of result.stream) { /* drain */ }
    expect(await m.currentRun!.settled).toBe('exited')
    const { problems, seen } = audit({ stdout, bridge: lines(target) })
    expect(problems).toEqual([])
    // The double covers every kind, the retry included when a scenario asks for one (claudePlanRun.test.ts).
    expect([...seen.stdout].sort()).toEqual(everyKind.stdout.filter(kind => !CLAUDE_PLAN_DOCUMENTED_ONLY_KINDS.has(kind)))
    expect([...seen.hooks].sort()).toEqual(everyKind.hooks)
    expect([...seen.mcp].sort()).toEqual(everyKind.mcp)
  })

  it('the pin\'s own model list decides effort: Opus 4.6 and Sonnet 4.6 take no xhigh, Haiku 4.5 takes none', () => {
    const answer = lines(path.join(RECORDED, 'words.stdout.jsonl')).find(event => event.type === 'control_response').response
    const catalog = readModelCatalog(answer)
    expect(checkEffortSupport(catalog, 'claude-opus-4-6', 'claude-opus-4-6', 'xhigh')).toMatch(/not xhigh/)
    expect(checkEffortSupport(catalog, 'claude-opus-4-6', 'claude-opus-4-6', 'max')).toBeNull()
    expect(checkEffortSupport(catalog, 'claude-sonnet-4-6', 'claude-sonnet-4-6', 'xhigh')).toMatch(/not xhigh/)
    expect(checkEffortSupport(catalog, 'claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001', 'low')).toMatch(/takes no reasoning effort/)
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-opus-4-8', 'claude-sonnet-5']) {
      for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) expect(checkEffortSupport(catalog, model, model, effort)).toBeNull()
    }
    // Aliases resolve through the started model (opusplan started claude-sonnet-5-5[1m] on 2.1.296).
    expect(checkEffortSupport(catalog, 'opusplan[1m]', 'claude-sonnet-5-5[1m]', 'xhigh')).toBeNull()
    // No email or organization is kept from the answer.
    expect(JSON.stringify(catalog)).not.toMatch(/email|organization/)
  })

  it('maps recorded real streams of the pin to the same parts the stream itself carries (B-N3)', async () => {
    const replay = async (name: string) => {
      const events = lines(path.join(RECORDED, `${name}.stdout.jsonl`))
      // The real reply starts after the second init (the first belongs to the blocked handshake).
      const start = events.findIndex((event, index) => event.type === 'system' && event.subtype === 'init' && events.slice(0, index).some(e => e.type === 'system' && e.subtype === 'init'))
      const queue = events.slice(start + 1)
      const calls: Array<{ step: number; ids: string[] }> = []
      let finished = 0
      const run = {
        nextEvent: async () => queue.shift() ?? null, seal: (step: number, proposals: any[]) => calls.push({ step, ids: proposals.map(p => p.id) }),
        finish: () => { finished += 1 }, stop: () => undefined, fail: (code: string, message: string) => { throw new Error(`${code}: ${message}`) },
        failure: null, isEnded: false
      }
      const model = new ClaudePlanModel({ modelId: 'claude-haiku-5-5', cliModel: 'claude-haiku-5-5', effort: null, owner: { userId: 'u', sessionId: 's', agentId: 'a', kind: 'primary' }, workingDirectory: work })
      ;(model as any).tools = prepareClaudePlanTools([{ type: 'function', name: 'get_weather', description: '', inputSchema: { type: 'object' } }, { type: 'function', name: 'read_file', description: '', inputSchema: { type: 'object' } }])
      const steps: any[][] = []
      while (queue.some(event => event.type === 'stream_event' && event.event?.type === 'message_start')) {
        const parts: any[] = []
        await (model as any).pump(run, steps.length + 1, undefined, (part: any) => parts.push(part))
        steps.push(parts)
      }
      return { events, steps, calls, finished }
    }

    // A words-only reply: the text and the final usage are the stream's own.
    const thinking = await replay('thinking')
    const lastDelta = thinking.events.filter(e => e.type === 'stream_event' && e.event?.type === 'message_delta').at(-1).event
    const text = thinking.events.filter(e => e.type === 'stream_event' && e.event?.delta?.type === 'text_delta').map(e => e.event.delta.text).join('')
    const reasoning = thinking.events.filter(e => e.type === 'stream_event' && e.event?.delta?.type === 'thinking_delta').map(e => e.event.delta.thinking).join('')
    const parts = thinking.steps.at(-1)!
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.delta).join('')).toBe(text)
    expect(reasoning.length).toBeGreaterThan(0)
    expect(parts.filter(p => p.type === 'reasoning-delta').map(p => p.delta).join('')).toBe(reasoning)
    const finish = parts.find(p => p.type === 'finish')
    expect(finish.finishReason).toEqual({ unified: 'stop', raw: 'end_turn' })
    expect(finish.usage.outputTokens.total).toBe(lastDelta.usage.output_tokens)
    expect(thinking.finished).toBe(1)

    // Three calls in one message: each offered with the exact input the stream built, then the answer.
    const three = await replay('three-calls')
    const offered = three.steps[0].filter(p => p.type === 'tool-call')
    const proposed = three.events.filter(e => e.type === 'assistant').flatMap(e => e.message.content.filter((b: any) => b.type === 'tool_use'))
    expect(offered.map(p => [p.toolCallId, p.toolName, JSON.parse(p.input)])).toEqual(proposed.map((b: any) => [b.id, 'get_weather', b.input]))
    expect(three.steps[0].find(p => p.type === 'finish').finishReason).toEqual({ unified: 'tool-calls', raw: 'tool_use' })
    expect(three.calls[0].ids).toEqual(proposed.map((b: any) => b.id))
    expect(three.steps.at(-1)!.find(p => p.type === 'finish').finishReason.unified).toBe('stop')
  })

  it('BL-2368: the pin answers a call to an unlisted name itself, with no hook and no MCP call, and the batch hook names it', () => {
    // Recorded live on 2.1.296 through Batshit's own run (P5, 2026-10-27): asked for an exact wrong name.
    const events = lines(path.join(RECORDED, 'misnamed.stdout.jsonl'))
    const bridge = lines(path.join(RECORDED, 'misnamed.bridge.jsonl'))
    const misnamed = events.find(e => e.type === 'stream_event' && e.event?.content_block?.type === 'tool_use' && !String(e.event.content_block.name).startsWith('mcp__batshit__')).event.content_block
    expect(misnamed.name).toBe('batshit__batshit__get_weather')
    const at = (predicate: (e: any) => boolean) => events.findIndex(predicate)
    const result = at(e => e.type === 'user' && e.message?.content?.some?.((b: any) => b.type === 'tool_result' && b.tool_use_id === misnamed.id))
    const block = events[result].message.content.find((b: any) => b.tool_use_id === misnamed.id)
    expect(block).toEqual({ type: 'tool_result', content: claudeCodeNoSuchToolText(misnamed.name), is_error: true, tool_use_id: misnamed.id })
    // Recorded before its own message ends (Claude Code answers it as its block completes).
    const stop = at((e: any) => e.type === 'stream_event' && e.event?.type === 'message_stop')
    expect(result).toBeLessThan(stop)
    // No PreToolUse and no MCP call carried it; the PostToolBatch hook named it with Claude Code's own answer.
    expect(bridge.filter(e => e.direction === 'hook-in' && e.body.hook_event_name === 'PreToolUse').map(e => e.body.tool_use_id)).not.toContain(misnamed.id)
    expect(JSON.stringify(bridge.filter(e => e.direction === 'mcp-in' && e.body.method === 'tools/call'))).not.toContain(misnamed.id)
    const batch = bridge.find(e => e.direction === 'hook-in' && e.body.hook_event_name === 'PostToolBatch' && e.body.tool_calls.some((c: any) => c.tool_use_id === misnamed.id))
    expect(batch.body.tool_calls).toHaveLength(1)
    // The same reply went on: Batshit's note reached Claude, then the listed call ran in the next model call.
    const notes = bridge.filter(e => e.direction === 'hook-out' && e.role === 'batch' && e.stdout).map(e => JSON.parse(e.stdout).hookSpecificOutput.additionalContext)
    expect(notes[0]).toMatch(/no tool is named batshit__batshit__get_weather.*mcp__batshit__<name>/)
    expect(events.some(e => e.type === 'stream_event' && e.event?.content_block?.name === 'mcp__batshit__get_weather')).toBe(true)
  })

  it('the pin records an MCP image result as an image block that matches what Batshit sent (A-M1)', () => {
    const events = lines(path.join(RECORDED, 'image-result.stdout.jsonl'))
    const block = events.filter(e => e.type === 'user').flatMap(e => e.message.content).find((b: any) => b.type === 'tool_result')
    const recorded = recordedClaudePlanToolAnswer(block)
    expect(recorded.content.map(item => item.type === 'image' ? ['image', item.mimeType] : ['text', item.text])).toEqual([['text', 'Photo attached.'], ['image', 'image/png']])
    expect(sameClaudePlanToolAnswer(recorded, { isError: false, content: [{ type: 'text', text: 'Photo attached.' }, { type: 'image', data: 'x', mimeType: 'image/png' }] })).toBe(true)
  })

  it('the pin records an MCP error result as one plain string with is_error, and it matches what Batshit sent', () => {
    // Recorded live on 2.1.296 (Faye S8 case, 2026-10-27): the bridge answered isError with one text item.
    const sent = lines(path.join(RECORDED, 'error-result.bridge.jsonl')).filter(e => e.direction === 'mcp-out' && e.body.result?.isError === true)
    const block = lines(path.join(RECORDED, 'error-result.stdout.jsonl')).filter(e => e.type === 'user').flatMap(e => e.message.content).find((b: any) => b.is_error === true)
    expect(sent).toHaveLength(1)
    expect(block).toMatchObject({ type: 'tool_result', content: 'Error: station offline', is_error: true })
    expect(sameClaudePlanToolAnswer(recordedClaudePlanToolAnswer(block), sent[0].body.result)).toBe(true)
    expect(sameClaudePlanToolAnswer(recordedClaudePlanToolAnswer({ ...block, is_error: undefined }), sent[0].body.result)).toBe(false)
  })

  it('Faye S15 (P3 Part 1): the result and rate-limit fields the limit classes read are held, null where the pin writes null', () => {
    const result = (extra: Record<string, unknown>) => ({ type: 'result', subtype: 'success', is_error: true, usage: { output_tokens: 0 }, result: 'x', ...extra })
    expect(checkClaudePlanWire(CLAUDE_PLAN_STDOUT_CONTRACT, 'result/success', result({ api_error_status: null }))).toEqual([])
    expect(checkClaudePlanWire(CLAUDE_PLAN_STDOUT_CONTRACT, 'result/success', result({ api_error_status: 429, api_error: 'usage_limit_reached' }))).toEqual([])
    expect(checkClaudePlanWire(CLAUDE_PLAN_STDOUT_CONTRACT, 'result/success', result({ api_error_status: '429' }))).toEqual([
      'result/success api_error_status: expected number|null?, got string'
    ])
    expect(checkClaudePlanWire(CLAUDE_PLAN_STDOUT_CONTRACT, 'result/success', { type: 'result', subtype: 'success', is_error: true, usage: { output_tokens: 0 }, text: 'renamed' })).toEqual([
      'result/success result: expected string, got undefined'
    ])
    const limit = (info: Record<string, unknown>) => ({ type: 'rate_limit_event', rate_limit_info: info })
    expect(checkClaudePlanWire(CLAUDE_PLAN_STDOUT_CONTRACT, claudePlanStdoutKind(limit({ status: 'allowed' }))!, limit({ status: 'allowed' }))).toEqual([])
    expect(checkClaudePlanWire(CLAUDE_PLAN_STDOUT_CONTRACT, 'rate_limit_event', limit({ state: 'rejected', isUsingOverage: 'yes' }))).toEqual([
      'rate_limit_event rate_limit_info.status: expected string, got undefined',
      'rate_limit_event rate_limit_info.isUsingOverage: expected boolean?, got string'
    ])
    expect(claudePlanStdoutKind({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [] })).toBe('result/error_during_execution')
  })

  it('Faye M4 (P3 Part 2): on the pin, a person\'s steer is echoed word for word after the step\'s results and before the next model call', () => {
    const events = lines(path.join(RECORDED, 'steer.stdout.jsonl'))
    const written = formatSteerForModel({ steerId: 'live-steer-1', messageId: 'live', text: 'Also end your answer with the word BANANA.', at: '', source: 'user' })
    const textOf = (event: any) => (Array.isArray(event.message?.content) ? event.message.content.filter((block: any) => block?.type === 'text').map((block: any) => block.text).join('') : String(event.message?.content ?? ''))
    const echo = events.findIndex(event => event.type === 'user' && event.isReplay === true && textOf(event) === written)
    expect(echo).toBeGreaterThan(0)
    const result = events.findIndex(event => event.type === 'user' && Array.isArray(event.message?.content) && event.message.content.some((block: any) => block?.type === 'tool_result'))
    expect(result).toBeGreaterThan(0)
    expect(result).toBeLessThan(echo)
    const starts = events.map((event, index) => (event.type === 'stream_event' && event.event?.type === 'message_start' ? index : -1)).filter(index => index >= 0)
    expect(starts.length).toBe(2)
    expect(starts[0]).toBeLessThan(result)
    expect(echo).toBeLessThan(starts[1])
  })

  it('reports a renamed or missing field', () => {
    const event = { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', toolUseId: 'x', name: 'mcp__batshit__w' } } }
    expect(checkClaudePlanWire(CLAUDE_PLAN_STDOUT_CONTRACT, claudePlanStdoutKind(event)!, event)).toEqual([
      'stream_event:content_block_start.tool_use event.content_block.id: expected string, got undefined'
    ])
    expect(checkClaudePlanWire(CLAUDE_PLAN_MCP_CONTRACT, 'tools/call', { params: { name: 'w', arguments: {} } })).toEqual([
      'tools/call params._meta.claudecode/toolUseId: expected string, got undefined'
    ])
    // The effort fields may be absent, but a renamed type fails loudly (reviewer B).
    const answer = (entry: Record<string, unknown>) => ({ response: { subtype: 'success', request_id: 'r', response: {
      claude_code_version: '2.1.296', account: { subscriptionType: 'plan', apiProvider: 'firstParty' }, models: [{ value: 'haiku', ...entry }]
    } } })
    expect(checkClaudePlanWire(CLAUDE_PLAN_STDOUT_CONTRACT, 'control_response', answer({}))).toEqual([])
    expect(checkClaudePlanWire(CLAUDE_PLAN_STDOUT_CONTRACT, 'control_response', answer({ supportsEffort: true, supportedEffortLevels: ['low'] }))).toEqual([])
    expect(checkClaudePlanWire(CLAUDE_PLAN_STDOUT_CONTRACT, 'control_response', answer({ supportsEffort: 'yes', supportedEffortLevels: [1] }))).toEqual([
      'control_response response.response.models[].supportsEffort: expected boolean?, got string',
      'control_response response.response.models[].supportedEffortLevels[]: expected string?, got number'
    ])
  })
})
