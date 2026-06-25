/**
 * Codex app-server transport lane for Batshit-managed CLI runs.
 *
 * Runs one `codex app-server` process per turn with a fresh EPHEMERAL
 * in-memory thread (no session/rollout files on disk), maps app-server
 * JSON-RPC notifications into the exact exec-JSONL `ThreadEvent` shapes that
 * `CodexEventAdapter` already consumes, and watches `thread/tokenUsage/updated`
 * notifications to stop the turn gracefully (`turn/interrupt`) before the
 * model context window fills up mid-task.
 *
 * A guard stop surfaces as a synthetic `turn.failed` whose message is
 * classified by `isContextExhaustionError`, so send-routed's existing
 * partial-finalize + auto-continue machinery takes over — same recovery lane
 * as a real context-window failure, minus the wasted failed API call.
 *
 * Architectural constraints: one fresh thread per run; NEVER thread/resume,
 * thread/rollback, or thread reuse across turns — Batshit owns the transcript.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import type { ThreadEvent, ThreadItem, Usage } from '$lib/types/codexProtocol'
import { logger } from '$lib/utils/logger'

export const DEFAULT_CONTEXT_GUARD_THRESHOLD = 0.8
const CONTEXT_GUARD_ENV_VAR = 'BATSHIT_CODEX_CONTEXT_GUARD_THRESHOLD'
const RPC_RESPONSE_TIMEOUT_MS = 120_000
const INTERRUPT_GRACE_MS = 10_000

export function resolveContextGuardThreshold(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env[CONTEXT_GUARD_ENV_VAR])
  if (Number.isFinite(raw) && raw >= 0.5 && raw < 1) return raw
  return DEFAULT_CONTEXT_GUARD_THRESHOLD
}

export function buildContextGuardStopMessage(details: {
  usedTokens: number
  modelContextWindow: number
}): string {
  const pct = Math.round(
    (details.usedTokens / details.modelContextWindow) * 100,
  )
  return (
    `Batshit context guard: Codex context window usage reached ${pct}% ` +
    `(${details.usedTokens.toLocaleString()} of ${details.modelContextWindow.toLocaleString()} tokens) mid-task. ` +
    `The run was stopped gracefully before the model ran out of room.`
  )
}

type AppServerTokenUsage = {
  last?: {
    inputTokens?: number
    cachedInputTokens?: number
    outputTokens?: number
    reasoningOutputTokens?: number
    totalTokens?: number
  }
  total?: {
    inputTokens?: number
    cachedInputTokens?: number
    outputTokens?: number
    reasoningOutputTokens?: number
    totalTokens?: number
  }
  modelContextWindow?: number | null
}

export function mapAppServerUsage(usage: AppServerTokenUsage | null): Usage {
  const total = usage?.total ?? {}
  return {
    input_tokens: total.inputTokens ?? 0,
    cached_input_tokens: total.cachedInputTokens ?? 0,
    output_tokens: total.outputTokens ?? 0,
    reasoning_output_tokens: total.reasoningOutputTokens ?? 0,
  }
}

/**
 * Computes current context fill from the most recent per-request usage.
 * `last` reflects the latest Responses API call, i.e. the live context size.
 */
export function computeContextUsedTokens(usage: AppServerTokenUsage): number {
  const last = usage.last ?? {}
  return (last.inputTokens ?? 0) + (last.outputTokens ?? 0)
}

const STATUS_MAP: Record<string, string> = {
  inProgress: 'in_progress',
  completed: 'completed',
  failed: 'failed',
  declined: 'failed',
  cancelled: 'failed',
  canceled: 'failed',
}

function mapStatus(value: unknown): string {
  if (typeof value !== 'string' || !value) return 'in_progress'
  return STATUS_MAP[value] ?? value.replace(/([A-Z])/g, '_$1').toLowerCase()
}

function reasoningText(item: Record<string, any>): string {
  const parts: string[] = []
  for (const collection of [item.summary, item.content]) {
    if (!Array.isArray(collection)) continue
    for (const entry of collection) {
      if (typeof entry === 'string') parts.push(entry)
      else if (entry && typeof entry.text === 'string') parts.push(entry.text)
    }
    if (parts.length > 0) break
  }
  return parts.join('\n')
}

/**
 * Maps an app-server thread item (camelCase) to the exec-JSONL ThreadItem
 * shape (snake_case) the event adapter consumes. Returns null for item kinds
 * the exec stream never emits (e.g. userMessage echoes) — those are skipped.
 */
export function mapAppServerItem(raw: unknown): ThreadItem | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, any>
  const id = typeof item.id === 'string' ? item.id : ''

  switch (item.type) {
    case 'agentMessage':
      return { id, type: 'agent_message', text: item.text ?? '' }
    case 'reasoning':
      return { id, type: 'reasoning', text: reasoningText(item) }
    case 'commandExecution':
      return {
        id,
        type: 'command_execution',
        command: item.command ?? '',
        aggregated_output: item.aggregatedOutput ?? '',
        ...(typeof item.exitCode === 'number' ? { exit_code: item.exitCode } : {}),
        status: mapStatus(item.status) as any,
      }
    case 'fileChange':
      return {
        id,
        type: 'file_change',
        changes: Array.isArray(item.changes)
          ? item.changes.map((change: any) => ({
              path: change?.path ?? '',
              kind: change?.kind ?? 'update',
            }))
          : [],
        status: mapStatus(item.status) as any,
      }
    case 'mcpToolCall':
      return {
        id,
        type: 'mcp_tool_call',
        server: item.server ?? item.serverName ?? '',
        tool: item.tool ?? item.toolName ?? '',
        arguments: item.arguments ?? item.args ?? null,
        ...(item.result
          ? {
              result: {
                content: Array.isArray(item.result.content)
                  ? item.result.content
                  : [],
                structured_content:
                  item.result.structured_content ??
                  item.result.structuredContent ??
                  null,
              },
            }
          : {}),
        ...(item.error?.message ? { error: { message: item.error.message } } : {}),
        status: mapStatus(item.status) as any,
      }
    case 'webSearch':
      return { id, type: 'web_search', query: item.query ?? '' }
    case 'todoList':
      return {
        id,
        type: 'todo_list',
        items: Array.isArray(item.items)
          ? item.items.map((todo: any) => ({
              text: todo?.text ?? '',
              completed: Boolean(todo?.completed),
            }))
          : [],
      }
    case 'error':
      return { id, type: 'error', message: item.message ?? 'Unknown Codex error' }
    case 'userMessage':
      return null
    default:
      console.warn('[CodexAppServer] Skipping unknown item type', {
        itemType: item.type,
      })
      return null
  }
}

export type CodexAppServerThreadParams = {
  ephemeral: boolean
  cwd?: string
  model?: string
  approvalPolicy?: string
  sandbox?: string
  developerInstructions?: string
  config?: Record<string, unknown>
}

export type CodexAppServerRunInput = {
  executable: string
  env: NodeJS.ProcessEnv
  cwd?: string
  threadParams: CodexAppServerThreadParams
  prompt: string
  imagePaths?: string[]
  signal?: AbortSignal
  contextGuardThreshold?: number
  /** Disable the proactive guard entirely (e.g. for tests). */
  contextGuardEnabled?: boolean
}

export type CodexAppServerRun = {
  events: AsyncGenerator<ThreadEvent>
  cleanup: () => Promise<void>
}

type PendingRpc = {
  resolve: (value: any) => void
  reject: (error: Error) => void
  method: string
}

/** Deny decisions per server-initiated approval request method. Managed runs
 * use codex-native approval policies that should not ask, so any request that
 * does arrive is declined loudly — mirroring non-interactive `codex exec`. */
const APPROVAL_DENY_RESULTS: Array<{ pattern: RegExp; result: Record<string, unknown> }> = [
  { pattern: /commandExecution\/requestApproval$/i, result: { decision: 'decline' } },
  { pattern: /execCommandApproval$/i, result: { decision: 'denied' } },
  { pattern: /applyPatchApproval$/i, result: { decision: 'denied' } },
  { pattern: /fileChange\/requestApproval$/i, result: { decision: 'decline' } },
  { pattern: /permissions\/requestApproval$/i, result: { decision: 'decline' } },
]

class AsyncEventQueue<T> {
  private values: T[] = []
  private resolvers: Array<(value: IteratorResult<T>) => void> = []
  private finished = false
  private failure: Error | null = null

  push(value: T) {
    if (this.finished) return
    const resolver = this.resolvers.shift()
    if (resolver) resolver({ value, done: false })
    else this.values.push(value)
  }

  finish(error?: Error) {
    if (this.finished) return
    this.finished = true
    this.failure = error ?? null
    for (const resolver of this.resolvers.splice(0)) {
      resolver({ value: undefined as never, done: true })
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.values.length > 0) {
      return { value: this.values.shift() as T, done: false }
    }
    if (this.finished) {
      if (this.failure) throw this.failure
      return { value: undefined as never, done: true }
    }
    return await new Promise<IteratorResult<T>>((resolve) => {
      this.resolvers.push(resolve)
    }).then((result) => {
      if (result.done && this.failure) throw this.failure
      return result
    })
  }
}

export function startCodexAppServerRun(
  input: CodexAppServerRunInput,
): CodexAppServerRun {
  const child: ChildProcess = spawn(input.executable, ['app-server'], {
    cwd: input.cwd,
    env: input.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const queue = new AsyncEventQueue<ThreadEvent>()
  const pending = new Map<number, PendingRpc>()
  const agentTextById = new Map<string, string>()
  const itemTypeById = new Map<string, string>()

  const guardEnabled = input.contextGuardEnabled !== false
  const guardThreshold =
    input.contextGuardThreshold ?? resolveContextGuardThreshold(input.env)

  let nextRpcId = 1
  let threadId: string | null = null
  let turnId: string | null = null
  let latestUsage: AppServerTokenUsage | null = null
  let guardTripped = false
  let guardStopMessage: string | null = null
  let interruptRequested = false
  let stderrTail = ''
  let closed = false

  const send = (payload: Record<string, unknown>) => {
    if (!child.stdin || child.stdin.destroyed) return
    child.stdin.write(JSON.stringify(payload) + '\n')
  }

  const request = (method: string, params: Record<string, unknown>) => {
    const id = nextRpcId++
    return new Promise<any>((resolve, reject) => {
      // Register BEFORE sending: a response must never be able to race the
      // pending-entry registration, no matter how fast the transport is.
      pending.set(id, { resolve, reject, method })
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`Codex app-server: timed out waiting for ${method} response`))
        }
      }, RPC_RESPONSE_TIMEOUT_MS).unref?.()
      send({ jsonrpc: '2.0', id, method, params })
    })
  }

  const requestInterrupt = (reason: 'guard' | 'abort') => {
    if (interruptRequested || !threadId || !turnId) return false
    interruptRequested = true
    logger.debug('[CodexAppServer] Sending turn/interrupt', { reason, threadId, turnId })
    request('turn/interrupt', { threadId, turnId }).catch((error) => {
      console.error('[CodexAppServer] turn/interrupt failed', { reason, error })
    })
    // Backstop: if codex does not finish the turn after an interrupt, fail loudly.
    setTimeout(() => {
      if (!closed) {
        finishWithError(
          new Error(
            reason === 'guard'
              ? guardStopMessage ?? 'Codex context guard interrupt did not complete in time'
              : 'Codex interrupt did not complete in time',
          ),
        )
      }
    }, INTERRUPT_GRACE_MS).unref?.()
    return true
  }

  const maybeRequestContextGuardInterrupt = () => {
    if (
      !guardEnabled ||
      guardTripped ||
      !latestUsage ||
      typeof latestUsage.modelContextWindow !== 'number' ||
      latestUsage.modelContextWindow <= 0
    ) {
      return
    }

    const used = computeContextUsedTokens(latestUsage)
    if (used / latestUsage.modelContextWindow < guardThreshold) return

    guardStopMessage = buildContextGuardStopMessage({
      usedTokens: used,
      modelContextWindow: latestUsage.modelContextWindow,
    })
    if (requestInterrupt('guard')) {
      guardTripped = true
      console.warn('[CodexAppServer] Context guard tripped', {
        used,
        modelContextWindow: latestUsage.modelContextWindow,
        threshold: guardThreshold,
      })
    } else {
      logger.debug('[CodexAppServer] Context guard threshold reached before turn identifiers were available', {
        used,
        modelContextWindow: latestUsage.modelContextWindow,
        threshold: guardThreshold,
        hasThreadId: Boolean(threadId),
        hasTurnId: Boolean(turnId),
      })
    }
  }

  const finishWithError = (error: Error) => {
    if (closed) return
    closed = true
    queue.finish(error)
    try {
      if (!child.killed) child.kill()
    } catch {}
  }

  const finishNormally = () => {
    if (closed) return
    closed = true
    queue.finish()
    try {
      if (!child.killed) child.kill()
    } catch {}
  }

  const onAbort = () => requestInterrupt('abort')
  if (input.signal) {
    if (input.signal.aborted) onAbort()
    else input.signal.addEventListener('abort', onAbort, { once: true })
  }

  child.stderr?.on('data', (chunk) => {
    const text = String(chunk)
    stderrTail = (stderrTail + text).slice(-4000)
    if (text.trim()) console.warn('[CodexAppServer stderr]', text.trim())
  })

  child.once('error', (error) => {
    finishWithError(
      new Error(`Codex app-server failed to start: ${(error as Error).message}`),
    )
  })

  child.once('close', (code, signalName) => {
    if (closed) return
    finishWithError(
      new Error(
        `Codex app-server exited unexpectedly (code ${code ?? 'null'}, signal ${signalName ?? 'null'})` +
          (stderrTail.trim() ? `: ${stderrTail.trim().slice(-500)}` : ''),
      ),
    )
  })

  const handleNotification = (method: string, params: Record<string, any>) => {
    // Notifications carry their own ids — never depend on RPC response timing
    // for the ids the guard needs to interrupt the turn.
    if (!threadId && typeof params.threadId === 'string') threadId = params.threadId
    if (!turnId && typeof params.turnId === 'string') turnId = params.turnId
    if (!turnId && typeof params?.turn?.id === 'string') turnId = params.turn.id
    if (method !== 'thread/tokenUsage/updated') {
      maybeRequestContextGuardInterrupt()
    }

    if (method === 'thread/tokenUsage/updated') {
      latestUsage = params.tokenUsage ?? null
      maybeRequestContextGuardInterrupt()
      return
    }

    if (method === 'turn/started') {
      queue.push({ type: 'turn.started' })
      return
    }

    if (method === 'item/started' || method === 'item/completed' || method === 'item/updated') {
      const rawItem = params.item
      if (rawItem?.id && typeof rawItem.type === 'string') {
        itemTypeById.set(rawItem.id, rawItem.type)
      }
      const mapped = mapAppServerItem(rawItem)
      if (!mapped) return
      if (mapped.type === 'agent_message') {
        if (method === 'item/started') agentTextById.set(mapped.id, mapped.text)
        else agentTextById.set(mapped.id, mapped.text)
      }
      const type =
        method === 'item/started'
          ? 'item.started'
          : method === 'item/completed'
            ? 'item.completed'
            : 'item.updated'
      queue.push({ type, item: mapped } as ThreadEvent)
      return
    }

    if (method === 'item/agentMessage/delta') {
      const itemId = params.itemId
      if (typeof itemId !== 'string' || typeof params.delta !== 'string') return
      const accumulated = (agentTextById.get(itemId) ?? '') + params.delta
      agentTextById.set(itemId, accumulated)
      queue.push({
        type: 'item.updated',
        item: { id: itemId, type: 'agent_message', text: accumulated },
      })
      return
    }

    if (/^item\/.+\/delta$/.test(method)) {
      // Reasoning (and any future) deltas: surface as item.updated when we know
      // the item kind; reasoning text streams are summary-only and the adapter
      // tolerates repeated updates.
      const itemId = params.itemId
      const knownType = typeof itemId === 'string' ? itemTypeById.get(itemId) : undefined
      if (knownType === 'reasoning' && typeof params.delta === 'string') {
        const accumulated = (agentTextById.get(itemId) ?? '') + params.delta
        agentTextById.set(itemId, accumulated)
        queue.push({
          type: 'item.updated',
          item: { id: itemId, type: 'reasoning', text: accumulated },
        })
      }
      return
    }

    if (/^turn\/(completed|failed|aborted)$/.test(method)) {
      const turn = params.turn ?? {}
      const status = typeof turn.status === 'string' ? turn.status : method.split('/')[1]
      if (status === 'completed') {
        queue.push({ type: 'turn.completed', usage: mapAppServerUsage(latestUsage) })
        finishNormally()
        return
      }
      if (status === 'interrupted') {
        if (guardTripped) {
          queue.push({
            type: 'turn.failed',
            error: {
              message:
                guardStopMessage ??
                'Batshit context guard: Codex context window usage reached the configured limit mid-task.',
            },
          })
          finishNormally()
        } else if (input.signal?.aborted) {
          const abortError = new Error('Codex run aborted by user')
          abortError.name = 'AbortError'
          finishWithError(abortError)
        } else {
          finishWithError(new Error('Codex turn was interrupted unexpectedly'))
        }
        return
      }
      const message =
        turn?.error?.message || `Codex turn ended with status ${status}`
      queue.push({ type: 'turn.failed', error: { message } })
      finishNormally()
      return
    }

    if (method === 'error' || /\berror\b/i.test(method)) {
      const message = params?.message ?? params?.error?.message
      if (typeof message === 'string' && message) {
        queue.push({ type: 'error', message })
      }
    }
  }

  const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }

    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = pending.get(msg.id)
      if (entry) {
        pending.delete(msg.id)
        if (msg.error) {
          entry.reject(
            new Error(`Codex app-server ${entry.method} failed: ${JSON.stringify(msg.error)}`),
          )
        } else {
          entry.resolve(msg.result)
        }
        return
      }
    }

    if (msg.id !== undefined && typeof msg.method === 'string') {
      // Server-initiated request (approvals, auth refresh, ...). Managed runs
      // configure codex so these should not occur; decline loudly when they do.
      const deny = APPROVAL_DENY_RESULTS.find((entry) => entry.pattern.test(msg.method))
      console.warn('[CodexAppServer] Declining server-initiated request', {
        method: msg.method,
        recognized: Boolean(deny),
      })
      if (deny) send({ jsonrpc: '2.0', id: msg.id, result: deny.result })
      else
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: 'Batshit managed Codex runs do not handle this request' },
        })
      return
    }

    if (typeof msg.method === 'string') {
      handleNotification(msg.method, msg.params ?? {})
    }
  })

  const run = (async () => {
    try {
      const init = await request('initialize', {
        clientInfo: { name: 'batshit', title: 'Batshit', version: '0.1.0' },
      })
      void init
      send({ jsonrpc: '2.0', method: 'initialized', params: {} })

      const threadResult = await request('thread/start', {
        ephemeral: input.threadParams.ephemeral,
        ...(input.threadParams.cwd ? { cwd: input.threadParams.cwd } : {}),
        ...(input.threadParams.model ? { model: input.threadParams.model } : {}),
        ...(input.threadParams.approvalPolicy
          ? { approvalPolicy: input.threadParams.approvalPolicy }
          : {}),
        ...(input.threadParams.sandbox ? { sandbox: input.threadParams.sandbox } : {}),
        ...(input.threadParams.developerInstructions
          ? { developerInstructions: input.threadParams.developerInstructions }
          : {}),
        ...(input.threadParams.config ? { config: input.threadParams.config } : {}),
      })
      threadId = threadResult?.thread?.id ?? null
      if (!threadId) {
        throw new Error(
          `Codex app-server thread/start returned no thread id: ${JSON.stringify(threadResult).slice(0, 300)}`,
        )
      }
      queue.push({ type: 'thread.started', thread_id: threadId })

      const inputItems: Array<Record<string, unknown>> = [
        { type: 'text', text: input.prompt },
      ]
      for (const imagePath of input.imagePaths ?? []) {
        inputItems.push({ type: 'localImage', path: imagePath })
      }
      const turnResult = await request('turn/start', {
        threadId,
        input: inputItems,
      })
      turnId = turnResult?.turn?.id ?? null
      if (!turnId) {
        throw new Error(
          `Codex app-server turn/start returned no turn id: ${JSON.stringify(turnResult).slice(0, 300)}`,
        )
      }
      if (input.signal?.aborted) requestInterrupt('abort')
    } catch (error) {
      finishWithError(error instanceof Error ? error : new Error(String(error)))
    }
  })()
  void run

  async function* events(): AsyncGenerator<ThreadEvent> {
    while (true) {
      const result = await queue.next()
      if (result.done) return
      yield result.value
    }
  }

  const cleanup = async () => {
    closed = true
    queue.finish()
    rl.close()
    input.signal?.removeEventListener('abort', onAbort)
    try {
      if (!child.killed) child.kill()
    } catch {}
  }

  return { events: events(), cleanup }
}
