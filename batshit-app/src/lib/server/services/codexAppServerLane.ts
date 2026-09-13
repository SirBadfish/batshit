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
import {
  CONTEXT_GUARD_CLASSIFIER_MARKER,
  DEFAULT_CONTEXT_GUARD_THRESHOLD,
  resolveManagedContextGuardThreshold,
} from './contextGuardPolicy'

export { DEFAULT_CONTEXT_GUARD_THRESHOLD }
const CONTEXT_GUARD_ENV_VAR = 'BATSHIT_CODEX_CONTEXT_GUARD_THRESHOLD'
const RPC_RESPONSE_TIMEOUT_MS = 120_000
const INTERRUPT_GRACE_MS = 10_000

export function resolveContextGuardThreshold(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  return resolveManagedContextGuardThreshold(env, CONTEXT_GUARD_ENV_VAR)
}

export function buildContextGuardStopMessage(details: {
  usedTokens: number
  modelContextWindow: number
}): string {
  const pct = Math.round(
    (details.usedTokens / details.modelContextWindow) * 100,
  )
  return (
    `${CONTEXT_GUARD_CLASSIFIER_MARKER}: Codex context window usage reached ${pct}% ` +
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
  if (typeof last.totalTokens === 'number' && Number.isFinite(last.totalTokens)) {
    return Math.max(0, last.totalTokens)
  }
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
  spawnArgs?: string[]
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

/**
 * SA-114 P2 (DL-114-06) — what `turn/steer` answered.
 *
 * A refusal is not an error to throw: all three of Codex's refusals mean "the model never
 * got this", which is exactly the state DL-114-07 promotes from. The reason travels back so
 * the caller can log what happened rather than guessing.
 */
export type CodexSteerResult =
  | { accepted: true; turnId: string }
  | { accepted: false; reason: string }

export type CodexAppServerRun = {
  events: AsyncGenerator<ThreadEvent>
  cleanup: () => Promise<void>
  /**
   * SA-114 P2 (DL-114-06) — append the user's mid-reply words to the turn that is running.
   *
   * `turn/steer` is the vendor's own primitive: the app server holds the text and hands it
   * to the model at its next step, so Batshit never has to guess at a boundary. Acceptance
   * is not delivery — the lane pushes a `steer.delivered` event when the app server emits
   * its own `userMessage` item for this text (AMD-114-02).
   */
  steer: (payload: { steerIds: string[]; text: string }) => Promise<CodexSteerResult>
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
  const guardThreshold = (() => {
    if (input.contextGuardEnabled === false) return null
    if (input.contextGuardThreshold !== undefined) {
      if (
        !Number.isFinite(input.contextGuardThreshold) ||
        input.contextGuardThreshold < 0.5 ||
        input.contextGuardThreshold >= 1
      ) {
        throw new Error('Codex context guard threshold must be from 0.5 (inclusive) to 1 (exclusive).')
      }
      return input.contextGuardThreshold
    }
    return resolveContextGuardThreshold(input.env)
  })()
  const child: ChildProcess = spawn(input.executable, input.spawnArgs ?? ['app-server'], {
    cwd: input.cwd,
    env: input.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const queue = new AsyncEventQueue<ThreadEvent>()
  const pending = new Map<number, PendingRpc>()
  const agentTextById = new Map<string, string>()
  const itemTypeById = new Map<string, string>()

  let nextRpcId = 1
  let threadId: string | null = null
  let turnId: string | null = null
  /**
   * F-P2-1 (SA-114 review): settles `true` the moment this run has a turn id, `false` when
   * the run ends without one. `steer()` waits on it, because send-routed attaches the
   * steer channel as soon as `streamNativeMode` resolves — which is BEFORE the eager
   * `initialize` → `thread/start` → `turn/start` chain below has answered. A steer flushed
   * in that window used to be refused as "no active turn" and never pushed again. It
   * settles on the `turn/started` NOTIFICATION, not the `turn/start` reply: live Codex
   * refused a steer sent in the gap between the two.
   */
  let resolveTurnReady: (ready: boolean) => void = () => {}
  const turnReady = new Promise<boolean>((resolve) => {
    resolveTurnReady = resolve
  })
  let latestUsage: AppServerTokenUsage | null = null
  let guardTripped = false
  let guardStopMessage: string | null = null
  let interruptRequested = false
  let stderrTail = ''
  let closed = false
  /**
   * SA-114 P2 (AMD-114-02) — steers sent but not yet echoed, oldest first.
   *
   * Matched by EXACT text, never by arrival order alone, because `turn/start` emits a
   * `userMessage` item for the turn's ORIGINAL prompt too (measured in P0's log: two of the
   * four `userMessage` items in that run were the prompt). Matching on order would confirm
   * a steer against the prompt's echo and write the marker before the steer had been sent.
   */
  const steersAwaitingEcho: Array<{ steerIds: string[]; text: string }> = []
  /** `item/started` and `item/completed` both fire for one item; only the first counts. */
  const echoedSteerItemIds = new Set<string>()
  /**
   * F-P2-3 (SA-114 review) — echoed, and waiting for the model call that reads them.
   *
   * The echo is not the delivery point. Measured live with `sleep 8`: Codex accepted the
   * steer at once and echoed it 6.3 s later, when its loop picked the input up for the NEXT
   * model call — and that echo reached Batshit before the finished command's own
   * `item/completed`. A marker written at the echo therefore sat BEFORE the tool result the
   * model read the steer after. The first `item/started` of any model-produced item after
   * the echo is the reading call, so that is where `steer.delivered` is pushed: after
   * everything the previous step produced, before anything the reading call produces. An
   * echo the turn ends on without such an item is not a delivery; the steer stays in flight
   * and the end of the turn promotes it (DL-114-07).
   */
  const steersEchoedAwaitingModelCall: string[][] = []

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

  /**
   * SA-118 (DL-118-06) — every outstanding JSON-RPC dies with the lane, not 120 s later.
   *
   * Before this, the only exit for a `pending` entry was `RPC_RESPONSE_TIMEOUT_MS`. A
   * `turn/steer` in flight when the child died — Stop, a guard interrupt, a crash — sat for
   * two minutes after the run had ended and then rejected into
   * `flushPendingSteersToTransport`'s catch, which calls `returnSteersToPending`. Since
   * PR #106 review F-9 that return no longer resurrects a cleared inbox, so nothing is
   * corrupted; but a two-minute orphan is still long enough to land in an unrelated later
   * turn, and a rejection that arrives after everyone stopped listening explains nothing.
   *
   * Clearing the map makes this idempotent, which matters because `cleanup` does not guard
   * on `closed` the way the two finish paths do. The timer stays as the backstop for the
   * other failure: a LIVE child that simply never answers.
   */
  const failPending = (reason: string) => {
    if (pending.size === 0) return
    const entries = [...pending.values()]
    pending.clear()
    for (const entry of entries) {
      entry.reject(
        new Error(`Codex app-server closed before ${entry.method} answered (${reason})`)
      )
    }
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
      guardThreshold === null ||
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

  /**
   * Is this `userMessage` item the echo of a steer this lane sent?
   *
   * Exact text, first match, once per item id. Anything else — the turn's original prompt,
   * or an item shape a future Codex adds — is left alone.
   */
  const matchSteerEcho = (rawItem: Record<string, any>): string[] | null => {
    const itemId = typeof rawItem?.id === 'string' ? rawItem.id : ''
    if (itemId && echoedSteerItemIds.has(itemId)) return null
    if (steersAwaitingEcho.length === 0) return null

    const parts = Array.isArray(rawItem?.content) ? rawItem.content : []
    const text = parts
      .map((part: any) => (part && typeof part.text === 'string' ? part.text : ''))
      .join('')
    if (!text) return null

    const index = steersAwaitingEcho.findIndex((entry) => entry.text === text)
    if (index === -1) return null

    const [matched] = steersAwaitingEcho.splice(index, 1)
    if (itemId) echoedSteerItemIds.add(itemId)
    return matched.steerIds
  }

  const steer = async (payload: {
    steerIds: string[]
    text: string
  }): Promise<CodexSteerResult> => {
    if (closed) return { accepted: false, reason: 'The Codex run has already finished.' }
    if (!turnId) {
      // The turn has not been answered yet (F-P2-1): wait for it rather than refusing. The
      // wait ends the moment `turn/start` is answered or `turn/started` arrives, or when
      // the run dies first — and only then is "no active turn to steer" the truth. P0
      // measured that exact refusal on the wire; the lane answers it itself here rather
      // than spending a round trip on it.
      const started = await turnReady
      if (!started || closed || !threadId || !turnId) {
        return { accepted: false, reason: 'no active turn to steer' }
      }
    }
    if (!threadId) return { accepted: false, reason: 'no active turn to steer' }
    const activeTurnId = turnId
    // Registered BEFORE the request is sent, for the same reason `request` registers its
    // pending entry before writing: the app server's response and its `userMessage` echo
    // can arrive in the SAME stdout flush, and the readline handler processes both lines
    // synchronously. Pushing after the `await` leaves the echo arriving while this list is
    // still empty — the steer is then never marked delivered even though the model read it,
    // and it is promoted into a second turn asking for something already done.
    const awaiting = { steerIds: [...payload.steerIds], text: payload.text }
    steersAwaitingEcho.push(awaiting)
    try {
      const result = await request('turn/steer', {
        threadId,
        input: [{ type: 'text', text: payload.text }],
        expectedTurnId: activeTurnId,
      })
      // The app server answers with the turn id that took the input. The echo is what turns
      // this into a delivery; acceptance alone only means Codex is holding the text.
      return { accepted: true, turnId: result?.turnId ?? activeTurnId }
    } catch (error) {
      const index = steersAwaitingEcho.indexOf(awaiting)
      if (index !== -1) steersAwaitingEcho.splice(index, 1)
      // All three refusals are `-32600` (P0): no active turn, a turn-id mismatch, and a
      // steer after `turn/completed` — which is indistinguishable from "no turn" on the
      // wire. Every one of them means the model never saw it, so the caller returns the
      // entries to the inbox and the end of the turn promotes them.
      const reason = error instanceof Error ? error.message : String(error)
      console.warn('[CodexAppServer] turn/steer refused; the steer will be promoted instead', {
        reason,
      })
      return { accepted: false, reason }
    }
  }

  const finishWithError = (error: Error) => {
    if (closed) return
    closed = true
    resolveTurnReady(false)
    failPending(error.message)
    queue.finish(error)
    try {
      if (!child.killed) child.kill()
    } catch {}
  }

  const finishNormally = () => {
    if (closed) return
    closed = true
    // DL-118-06: `finishWithError` and `cleanup` both settle `turnReady`; this path did
    // not, so a `steer()` parked on it in the pre-`turn/started` window waited for the
    // stream to drain instead of for the finish that had already happened.
    resolveTurnReady(false)
    failPending('the turn finished')
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
      // F-P2-1: THIS is what makes the turn steerable — the `turn/start` reply carries the
      // id, but live Codex refused a `turn/steer` sent in the gap between that reply and
      // this notification (the review's early-steer run).
      if (turnId && threadId) resolveTurnReady(true)
      queue.push({ type: 'turn.started' })
      return
    }

    if (method === 'item/started' || method === 'item/completed' || method === 'item/updated') {
      const rawItem = params.item
      if (rawItem?.id && typeof rawItem.type === 'string') {
        itemTypeById.set(rawItem.id, rawItem.type)
      }
      // SA-114 P2 (AMD-114-02): the app server's own echo of a steer Batshit sent is the
      // delivery signal. `mapAppServerItem` returns null for every `userMessage` item, so
      // this is also the only place that can see it — and it must stay that way: surfacing
      // the echo as agent text would put the user's own words in the agent's mouth, and
      // surfacing it as a user turn would split the reply in two.
      if (rawItem?.type === 'userMessage') {
        const echoed = matchSteerEcho(rawItem)
        if (echoed) steersEchoedAwaitingModelCall.push(echoed)
        return
      }
      // Any other item STARTING is the model call that read whatever was echoed before it
      // (F-P2-3) — delivered here, ahead of that item's own event.
      if (method === 'item/started' && steersEchoedAwaitingModelCall.length > 0) {
        for (const steerIds of steersEchoedAwaitingModelCall.splice(0)) {
          queue.push({ type: 'steer.delivered', steer_ids: steerIds })
        }
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
    resolveTurnReady(false)
    failPending('the lane was cleaned up')
    queue.finish()
    rl.close()
    input.signal?.removeEventListener('abort', onAbort)
    try {
      if (!child.killed) child.kill()
    } catch {}
  }

  return { events: events(), cleanup, steer }
}
