import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import {
  buildContextGuardStopMessage,
  computeContextUsedTokens,
  mapAppServerItem,
  mapAppServerUsage,
  resolveContextGuardThreshold,
  startCodexAppServerRun,
  DEFAULT_CONTEXT_GUARD_THRESHOLD,
} from '../services/codexAppServerLane'
import { isContextExhaustionError } from '../services/contextExhaustion'
import {
  buildCodexAppServerThreadParams,
  extractAppServerSpawnArgs,
  resolveCodexTransportLane,
} from '../services/codexBridge'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const spawn = (...args: any[]) => spawnMock(...args)
  return {
    ...original,
    spawn,
    default: { ...(original as any).default ?? original, spawn },
  }
})

afterEach(() => {
  spawnMock.mockReset()
})

describe('mapAppServerItem', () => {
  it('maps commandExecution to command_execution with snake_case fields', () => {
    expect(
      mapAppServerItem({
        type: 'commandExecution',
        id: 'call_1',
        command: 'ls -la',
        aggregatedOutput: 'total 0\n',
        exitCode: 0,
        status: 'completed',
      }),
    ).toEqual({
      id: 'call_1',
      type: 'command_execution',
      command: 'ls -la',
      aggregated_output: 'total 0\n',
      exit_code: 0,
      status: 'completed',
    })
  })

  it('maps in-progress commandExecution without exit code', () => {
    const mapped = mapAppServerItem({
      type: 'commandExecution',
      id: 'call_2',
      command: 'cat x',
      aggregatedOutput: null,
      exitCode: null,
      status: 'inProgress',
    })
    expect(mapped).toMatchObject({
      type: 'command_execution',
      aggregated_output: '',
      status: 'in_progress',
    })
    expect(mapped && 'exit_code' in mapped).toBe(false)
  })

  it('maps agentMessage, reasoning, webSearch, todoList, mcpToolCall, fileChange', () => {
    expect(mapAppServerItem({ type: 'agentMessage', id: 'm1', text: 'hi' })).toEqual({
      id: 'm1',
      type: 'agent_message',
      text: 'hi',
    })
    expect(
      mapAppServerItem({ type: 'reasoning', id: 'r1', summary: [{ text: 'think' }], content: [] }),
    ).toEqual({ id: 'r1', type: 'reasoning', text: 'think' })
    expect(mapAppServerItem({ type: 'webSearch', id: 'w1', query: 'foo' })).toEqual({
      id: 'w1',
      type: 'web_search',
      query: 'foo',
    })
    expect(
      mapAppServerItem({ type: 'todoList', id: 't1', items: [{ text: 'a', completed: false }] }),
    ).toEqual({ id: 't1', type: 'todo_list', items: [{ text: 'a', completed: false }] })
    expect(
      mapAppServerItem({
        type: 'mcpToolCall',
        id: 'mc1',
        server: 'batshit',
        tool: 'list',
        arguments: { a: 1 },
        result: { content: [], structuredContent: { ok: true } },
        status: 'completed',
      }),
    ).toEqual({
      id: 'mc1',
      type: 'mcp_tool_call',
      server: 'batshit',
      tool: 'list',
      arguments: { a: 1 },
      result: { content: [], structured_content: { ok: true } },
      status: 'completed',
    })
    expect(
      mapAppServerItem({
        type: 'fileChange',
        id: 'f1',
        changes: [{ path: '/a.ts', kind: 'update' }],
        status: 'completed',
      }),
    ).toEqual({
      id: 'f1',
      type: 'file_change',
      changes: [{ path: '/a.ts', kind: 'update' }],
      status: 'completed',
    })
  })

  it('skips userMessage echoes and unknown types', () => {
    expect(mapAppServerItem({ type: 'userMessage', id: 'u1', content: [] })).toBeNull()
    expect(mapAppServerItem({ type: 'someFutureThing', id: 'x1' })).toBeNull()
    expect(mapAppServerItem(null)).toBeNull()
  })
})

describe('usage mapping and guard math', () => {
  it('maps cumulative usage totals to exec Usage shape', () => {
    expect(
      mapAppServerUsage({
        last: { inputTokens: 10, outputTokens: 2 },
        total: {
          inputTokens: 100,
          cachedInputTokens: 60,
          outputTokens: 20,
          reasoningOutputTokens: 5,
        },
        modelContextWindow: 121600,
      }),
    ).toEqual({
      input_tokens: 100,
      cached_input_tokens: 60,
      output_tokens: 20,
      reasoning_output_tokens: 5,
    })
    expect(mapAppServerUsage(null)).toEqual({
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
    })
  })

  it('computes context fill from the last request', () => {
    expect(
      computeContextUsedTokens({ last: { inputTokens: 9916, outputTokens: 607 } }),
    ).toBe(10523)
  })

  it('guard stop message is classified as context exhaustion', () => {
    const message = buildContextGuardStopMessage({
      usedTokens: 98_496,
      modelContextWindow: 121_600,
    })
    expect(message).toContain('81%')
    expect(isContextExhaustionError(message)).toBe(true)
  })

  it('resolves threshold from env with sane bounds', () => {
    expect(resolveContextGuardThreshold({})).toBe(DEFAULT_CONTEXT_GUARD_THRESHOLD)
    expect(
      resolveContextGuardThreshold({ BATSHIT_CODEX_CONTEXT_GUARD_THRESHOLD: '0.7' }),
    ).toBe(0.7)
    expect(
      resolveContextGuardThreshold({ BATSHIT_CODEX_CONTEXT_GUARD_THRESHOLD: '1.5' }),
    ).toBe(DEFAULT_CONTEXT_GUARD_THRESHOLD)
    expect(
      resolveContextGuardThreshold({ BATSHIT_CODEX_CONTEXT_GUARD_THRESHOLD: '0.1' }),
    ).toBe(DEFAULT_CONTEXT_GUARD_THRESHOLD)
  })
})

describe('bridge lane helpers', () => {
  it('routes managed scope to app-server with exec escape hatch', () => {
    expect(resolveCodexTransportLane({ configScope: 'managed' }, {})).toBe('app-server')
    expect(
      resolveCodexTransportLane({ configScope: 'managed' }, { BATSHIT_CODEX_TRANSPORT: 'exec' }),
    ).toBe('exec')
    expect(resolveCodexTransportLane({ configScope: 'global' }, {})).toBe('exec')
  })

  it('keeps only config/enable/disable flags for the app-server spawn', () => {
    expect(
      extractAppServerSpawnArgs([
        'exec',
        '--json',
        '--model',
        'gpt-5.3-codex-spark',
        '--config',
        'model=gpt-5.3-codex-spark',
        '--config',
        'default_tools_enabled=false',
        '--ephemeral',
        '--enable',
        'foo',
        '--cd',
        '/tmp/x',
      ]),
    ).toEqual([
      'app-server',
      '--config',
      'model=gpt-5.3-codex-spark',
      '--config',
      'default_tools_enabled=false',
      '--enable',
      'foo',
    ])
  })

  it('mirrors permission modes into thread params', () => {
    expect(
      buildCodexAppServerThreadParams({
        historyPersistence: 'none',
        workingDirectory: '/tmp/work',
        model: 'gpt-5.3-codex-spark',
        permissionMode: 'agent',
        configScope: 'managed',
      } as any),
    ).toEqual({
      ephemeral: true,
      cwd: '/tmp/work',
      model: 'gpt-5.3-codex-spark',
      approvalPolicy: 'on-failure',
      sandbox: 'workspace-write',
    })
    expect(
      buildCodexAppServerThreadParams({
        historyPersistence: 'none',
        permissionMode: 'agent_full',
        configScope: 'managed',
      } as any),
    ).toMatchObject({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
  })
})

type FakeChild = EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  killed: boolean
  kill: (signal?: string) => boolean
}

function createFakeAppServer(options: {
  tokenUsageSequence: Array<{ used: number; window: number }>
  onInterrupt?: () => void
  usageBeforeTurnStarted?: boolean
}) {
  const child = new EventEmitter() as FakeChild
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.kill = () => {
    child.killed = true
    return true
  }

  const send = (msg: Record<string, unknown>) =>
    child.stdout.write(JSON.stringify(msg) + '\n')
  const sendUsage = (usage: { used: number; window: number }, includeIds = true) => {
    send({
      jsonrpc: '2.0',
      method: 'thread/tokenUsage/updated',
      params: {
        ...(includeIds ? { threadId: 'thread-1', turnId: 'turn-1' } : {}),
        tokenUsage: {
          last: { inputTokens: usage.used, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: usage.used },
          total: { inputTokens: usage.used, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: usage.used },
          modelContextWindow: usage.window,
        },
      },
    })
  }
  const interruptCalls: any[] = []

  let buffered = ''
  child.stdin.on('data', (chunk) => {
    buffered += String(chunk)
    let index = buffered.indexOf('\n')
    while (index >= 0) {
      const line = buffered.slice(0, index)
      buffered = buffered.slice(index + 1)
      index = buffered.indexOf('\n')
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      if (msg.method === 'initialize') {
        send({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'fake' } })
      } else if (msg.method === 'thread/start') {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { thread: { id: 'thread-1', ephemeral: true } },
        })
      } else if (msg.method === 'turn/start') {
        send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } })
        const usageSequence =
          options.usageBeforeTurnStarted && options.tokenUsageSequence.length > 0
            ? options.tokenUsageSequence.slice(1)
            : options.tokenUsageSequence
        if (options.usageBeforeTurnStarted && options.tokenUsageSequence[0]) {
          sendUsage(options.tokenUsageSequence[0], false)
        }
        send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })
        send({
          jsonrpc: '2.0',
          method: 'item/started',
          params: {
            item: {
              type: 'commandExecution',
              id: 'call_1',
              command: 'ls',
              aggregatedOutput: null,
              exitCode: null,
              status: 'inProgress',
            },
          },
        })
        for (const usage of usageSequence) sendUsage(usage)
        if (options.tokenUsageSequence.every((u) => u.used / u.window < 0.8)) {
          send({
            jsonrpc: '2.0',
            method: 'item/completed',
            params: {
              item: {
                type: 'commandExecution',
                id: 'call_1',
                command: 'ls',
                aggregatedOutput: 'ok\n',
                exitCode: 0,
                status: 'completed',
              },
            },
          })
          send({
            jsonrpc: '2.0',
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
          })
        }
      } else if (msg.method === 'turn/interrupt') {
        interruptCalls.push(msg.params)
        options.onInterrupt?.()
        send({ jsonrpc: '2.0', id: msg.id, result: {} })
        send({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } },
        })
      }
    }
  })

  return { child, interruptCalls }
}

describe('environment sanity', () => {
  it('readline delivers lines from a PassThrough in this environment', async () => {
    const readline = (await import('node:readline')).default
    const stream = new PassThrough()
    const lines: string[] = []
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
    rl.on('line', (line) => lines.push(line))
    stream.write('hello\n')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(lines).toEqual(['hello'])
    rl.close()
  })
})

describe('startCodexAppServerRun', () => {
  it('streams mapped events and finishes on turn completion', async () => {
    const fake = createFakeAppServer({
      tokenUsageSequence: [{ used: 10_000, window: 121_600 }],
    })
    spawnMock.mockReturnValue(fake.child)

    const run = startCodexAppServerRun({
      executable: 'codex',
      env: {},
      cwd: '/tmp/work',
      threadParams: { ephemeral: true, cwd: '/tmp/work', model: 'gpt-5.3-codex-spark' },
      prompt: 'do the thing',
    })

    const events: any[] = []
    for await (const event of run.events) events.push(event)
    await run.cleanup()

    expect(events.map((e) => e.type)).toEqual([
      'thread.started',
      'turn.started',
      'item.started',
      'item.completed',
      'turn.completed',
    ])
    expect(events.at(-1).usage).toMatchObject({ input_tokens: 10_000 })
    expect(fake.interruptCalls).toHaveLength(0)
  })

  it('trips the context guard, interrupts, and surfaces a classified turn.failed', async () => {
    const fake = createFakeAppServer({
      tokenUsageSequence: [
        { used: 50_000, window: 121_600 },
        { used: 100_000, window: 121_600 },
      ],
    })
    spawnMock.mockReturnValue(fake.child)

    const run = startCodexAppServerRun({
      executable: 'codex',
      env: {},
      threadParams: { ephemeral: true },
      prompt: 'long task',
    })

    const events: any[] = []
    let failure: Error | null = null
    try {
      for await (const event of run.events) events.push(event)
    } catch (error) {
      failure = error as Error
    }
    await run.cleanup()

    expect(failure).toBeNull()
    expect(fake.interruptCalls).toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }])
    const terminal = events.at(-1)
    expect(terminal.type).toBe('turn.failed')
    expect(terminal.error.message).toContain('Batshit context guard')
    expect(isContextExhaustionError(terminal.error.message)).toBe(true)
  })

  it('does not burn the guard one-shot when token usage arrives before turn ids', async () => {
    const fake = createFakeAppServer({
      tokenUsageSequence: [
        { used: 100_000, window: 121_600 },
      ],
      usageBeforeTurnStarted: true,
    })
    spawnMock.mockReturnValue(fake.child)

    const run = startCodexAppServerRun({
      executable: 'codex',
      env: {},
      threadParams: { ephemeral: true },
      prompt: 'long task',
    })

    const events: any[] = []
    for await (const event of run.events) events.push(event)
    await run.cleanup()

    expect(fake.interruptCalls).toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }])
    expect(events.at(-1)?.type).toBe('turn.failed')
    expect(events.at(-1)?.error.message).toContain('Batshit context guard')
  })

  it('fails loudly when the app-server process dies before the turn ends', async () => {
    const child = new EventEmitter() as FakeChild
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.killed = false
    child.kill = () => {
      child.killed = true
      return true
    }
    spawnMock.mockReturnValue(child)

    const run = startCodexAppServerRun({
      executable: 'codex',
      env: {},
      threadParams: { ephemeral: true },
      prompt: 'task',
    })
    // Process dies before responding to initialize.
    setTimeout(() => child.emit('close', 1, null), 20)

    let failure: Error | null = null
    try {
      for await (const event of run.events) void event
    } catch (error) {
      failure = error as Error
    }
    await run.cleanup()
    expect(failure?.message).toContain('exited unexpectedly')
  })
})
