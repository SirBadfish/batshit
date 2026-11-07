import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { lstat, mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import {
  applyClaudeRuntimeOwnershipToHandle,
  applyClaudeRuntimeOwnershipWithoutFollowing,
  buildClaudeChildProcessOptions,
  type ClaudeRunAsIdentity
} from '$lib/server/services/claudeRuntimeUser'
import {
  assertClaudePlanExecutableUnchanged,
  buildClaudePlanBaseEnv,
  checkClaudeCodeHookPolicy,
  type ClaudePlanExecutable
} from '$lib/server/services/claudePlanExecutable'
import {
  CLAUDE_PLAN_APPROVAL_REFUSAL,
  CLAUDE_PLAN_END_CONVERSATION_TOOL,
  CLAUDE_PLAN_MCP_SERVER,
  ClaudePlanRunError,
  claudeCodeNoSuchToolText,
  claudePlanDescriptionLimit,
  claudePlanSdkErrorAnswer,
  claudePlanSystemText,
  recordedClaudePlanToolAnswer,
  sameClaudePlanToolAnswer,
  toMcpToolListing,
  type ClaudeContentBlock,
  type ClaudePlanPreparedTool,
  type ClaudePlanToolAnswer
} from '$lib/server/services/claudePlanProtocol'
import { DELEGATION_BRIDGE_TOOL_TIMEOUT_MS } from '$lib/server/services/mode4InternalTools'
import { waitForProcessExit } from '$lib/server/services/subagentRunSettle'

/**
 * SA-139 P2: one Claude Code run per reply (D3), started and guarded by Batshit.
 *
 * Startup admission (D2), four steps, each refusing with zero model calls: the bound executable is
 * checked again right before spawn; the Agent SDK's documented `initialize` control request answers
 * before any prompt (version, plan account, no API key source); a `UserPromptSubmit` gate hook checks
 * the run secret, `CLAUDE_PID` and the effective environment names; and a handshake prompt the gate
 * always blocks makes Claude Code print `init` (key source, version, permission mode, model, exact tool
 * list) before the real prompt is written.
 *
 * Admission before effects (D4): a streamed `tool_use` is only a proposal. Batshit's executor for a
 * call waits until the PreToolUse hook (native id, wire name, input) and the MCP call (same id, bare
 * name, identical arguments) both matched it, unconsumed, after its message's `message_stop`. Each
 * result is released at once; the PostToolBatch hook holds Claude Code's next model call until the
 * adapter's next `doStream` began, so `prepareStep` always finishes first.
 *
 * Integrity (D4): anything unknown, duplicate or mismatched, and any `tool_result` Claude Code records
 * that Batshit did not release, ends the run at once with SIGKILL of its process group; nothing after
 * it is used. One exception (BL-2368): a call to a name none of the run's tools has, which Claude Code
 * answers itself with its exact "No such tool available" error, with no hook and no MCP call: nothing
 * ran, so the step goes on and Claude reads why. Lifecycle (D10): a run-wide Stop, a quiet-only idle backstop, real settlement (process
 * exit confirmed, then the run folder and Claude Code's messaging socket removed).
 */

export const CLAUDE_PLAN_HANDSHAKE_TEXT = 'batshit-handshake'

export type ClaudePlanRunTiming = {
  /** Bounded wait for the `initialize` answer (no answer, as with Bedrock, refuses). */
  initializeMs: number
  /** Bounded wait for the handshake's `init` and `result`. */
  handshakeMs: number
  /** Explicit hook timeouts, in seconds (never Claude Code's defaults; D4). */
  sessionHookSeconds: number
  gateHookSeconds: number
  /** PreToolUse waits for its message's `message_stop`, so it must outlast a whole streamed message. */
  preHookSeconds: number
  batchHookSeconds: number
  /** Bounded wait for the SessionStart hook: it proves Claude Code runs Batshit's hooks before any prompt. */
  sessionStartMs: number
  /** How long the batch hook waits for Claude Code's record of each released result to be checked. */
  recordedWaitMs: number
  /** Backstop only: real silence (no model call and no admitted call running). */
  idleMs: number
  /** After stdin closes at a normal end, how long Claude Code gets to exit by itself. */
  exitWaitMs: number
  /** SIGTERM to SIGKILL. */
  stopGraceMs: number
  /** From the end: an exit not confirmed by then leaves the settlement unknown. */
  settleBoundMs: number
}

export const CLAUDE_PLAN_RUN_TIMING: Readonly<ClaudePlanRunTiming> = Object.freeze({
  initializeMs: 15_000,
  handshakeMs: 30_000,
  sessionHookSeconds: 30,
  gateHookSeconds: 30,
  preHookSeconds: 600,
  batchHookSeconds: 600,
  sessionStartMs: 15_000,
  recordedWaitMs: 10_000,
  idleMs: 10 * 60_000,
  exitWaitMs: 5_000,
  stopGraceMs: 2_000,
  settleBoundMs: 25_000
})

export type ClaudePlanRunOwner = Readonly<{
  userId: string | null
  sessionId: string | null
  agentId: string | null
  /** A Primary reply, or a delegated Subagent or Worker run. */
  kind: 'primary' | 'delegated'
}>

export type ClaudePlanRunOptions = {
  executable: ClaudePlanExecutable
  runAs: ClaudeRunAsIdentity
  /** `--model`, or null to let Claude Code choose ("CLI default"). */
  cliModel: string | null
  /** `--effort`, only when the preset sets it. */
  effort: string | null
  /** The preset's Thinking (D12, P1's `alwaysThinking`): `alwaysThinkingEnabled` in the run's own settings file; null leaves Claude Code's default. */
  alwaysThinking?: boolean | null
  workingDirectory: string
  owner: ClaudePlanRunOwner
  scriptsDir?: string
  nodePath?: string
  timing?: Partial<ClaudePlanRunTiming>
  /** Called once the run has settled (exit confirmed or unknown). */
  onSettled?: (run: ClaudePlanRun, settlement: ClaudePlanSettlement) => void
  /** Drift recording only (D13): every stdout event as Claude Code printed it. */
  onRawEvent?: (event: unknown) => void
}

export type ClaudePlanSettlement = 'exited' | 'unknown'

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  promise.catch(() => undefined)
  return { promise, resolve, reject }
}

/** One proposal from Claude's stream, and what has matched it so far. */
type CallRecord = {
  id: string
  step: number
  tool: ClaudePlanPreparedTool
  input: unknown
  pre: boolean
  mcp: boolean
  admitted: Deferred<void>
  claimed: boolean
  executing: boolean
  answer: ClaudePlanToolAnswer | null
  /** Claude Code's own record of the result was seen and matched the released answer (M1). */
  recorded: boolean
  reply: ((body: unknown) => void) | null
}

export type ClaudePlanProposal = { id: string; tool: ClaudePlanPreparedTool; input: unknown }

/** BL-2368: a streamed call to a name none of the run's tools has; Claude Code answers it itself. */
type UnlistedCall = { id: string; name: string; step: number; sealed: boolean; recorded: boolean; confirmed: boolean }

/** A one-reader queue of Claude Code's stream-json events; `next()` answers null once the run ended. */
class EventQueue {
  private items: any[] = []
  private waiter: ((value: any) => void) | null = null
  private closed = false
  push(item: any) {
    if (this.closed) return
    if (this.waiter) { const waiter = this.waiter; this.waiter = null; waiter(item) } else this.items.push(item)
  }
  close() {
    this.closed = true
    this.items = []
    if (this.waiter) { const waiter = this.waiter; this.waiter = null; waiter(null) }
  }
  next(): Promise<any | null> {
    if (this.items.length) return Promise.resolve(this.items.shift())
    if (this.closed) return Promise.resolve(null)
    return new Promise(resolve => { this.waiter = resolve })
  }
}

const ROUTE_NAME = /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH)/
/** One socket request; a tool's input cannot be larger than one model message, far below this. */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024

/** The text of a stream-json user message's content (a string, or its text blocks joined). */
function userMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.filter((block: any) => block?.type === 'text' && typeof block.text === 'string').map((block: any) => block.text).join('') : ''
}

function sameSecret(given: unknown, secret: string): boolean {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

export class ClaudePlanRun {
  readonly id = randomBytes(8).toString('hex')
  readonly owner: ClaudePlanRunOwner
  private readonly options: ClaudePlanRunOptions
  private readonly timing: ClaudePlanRunTiming
  private readonly secret = randomBytes(32).toString('hex')
  private proc: ChildProcessWithoutNullStreams | null = null
  private server: Server | null = null
  private readonly connections = new Set<Socket>()
  private dir: string | null = null
  private tools: readonly ClaudePlanPreparedTool[] = []
  private readonly events = new EventQueue()
  private readonly calls = new Map<string, CallRecord>()
  /** EndConversation calls, noted as they stream: Claude Code records their result itself (D2). */
  private readonly endConversationIds = new Set<string>()
  /** BL-2368: calls to unlisted names, noted as they stream, with Claude Code's own error once recorded. */
  private readonly unlisted = new Map<string, UnlistedCall>()
  /** D5: the note each step's PostToolBatch hook hands Claude, keyed by the step whose calls it closes. */
  private readonly batchNotes = new Map<number, string>()
  /**
   * D5 delivery evidence: the text of each user message Claude Code took in, from its
   * `--replay-user-messages` echo (written when the message joins a model call, before that call starts).
   */
  private readonly echoedUserTexts: string[] = []
  private phase: 'new' | 'initialize' | 'handshake' | 'running' = 'new'
  private initializeAnswer: Deferred<any> | null = null
  private handshakeDone: Deferred<void> | null = null
  private handshakeInit: any = null
  private handshakeGateProblem: string | null = null
  private handshakeGateSeen = false
  private handshakePassed = false
  private sessionStarted: Deferred<void> | null = null
  /** Batshit signalled the process itself (only then may it remove Claude Code's messaging socket). */
  private escalated = false
  private messagingSocketPath: string | null = null
  /** Claude Code's own model list from the `initialize` answer: only the effort facts are kept. */
  private modelCatalog: ClaudePlanModelEntry[] = []
  /** The last model call whose `message_stop` was seen (its proposals are complete). */
  private sealedStep = 0
  /** Model calls the adapter has begun (`doStream`). */
  private modelCallsBegun = 0
  private modelCallActive = false
  private readonly stepWaiters: Array<{ step: number; done: () => void }> = []
  private readonly preWaiters = new Set<() => void>()
  private readonly recordedWaiters = new Set<() => void>()
  private executing = 0
  /** D6: held at an approval card; the registry's card deadline rules, not the idle timer. */
  private holding = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private lastActivity = 0
  private stderrTail = ''
  private endError: ClaudePlanRunError | null = null
  private ended = false
  /** Resolved once `start` has returned or thrown: settlement waits for it, so nothing spawns after it. */
  private startUnwound: Deferred<void> | null = null
  private exitSeen = false
  private readonly endedController = new AbortController()
  private readonly settledDeferred = deferred<ClaudePlanSettlement>()
  private readonly exitedDeferred = deferred<void>()
  /** Outside signals reach the run only through this controller (`relayAbort`, BL-246). */
  readonly stopController = new AbortController()

  constructor(options: ClaudePlanRunOptions) {
    this.options = options
    this.owner = options.owner
    this.timing = { ...CLAUDE_PLAN_RUN_TIMING, ...options.timing }
    this.stopController.signal.addEventListener('abort', () => this.stop(), { once: true, signal: this.endedController.signal })
  }

  /** Aborted when the run ends: every listener registered with it goes too (BL-246). */
  get endedSignal(): AbortSignal { return this.endedController.signal }
  get settled(): Promise<ClaudePlanSettlement> { return this.settledDeferred.promise }
  /** Resolves once the exit is confirmed and leftovers are removed, also after an `unknown` settlement. */
  get exited(): Promise<void> { return this.exitedDeferred.promise }
  get isEnded(): boolean { return this.ended }
  get failure(): ClaudePlanRunError | null { return this.endError }
  get pid(): number | null { return this.proc?.pid ?? null }

  // ---------------------------------------------------------------------------------------------
  // Startup (D2)

  async start(input: { systemPrompt: string; content: ClaudeContentBlock[]; tools: readonly ClaudePlanPreparedTool[] }): Promise<void> {
    if (this.phase !== 'new') throw new Error('A Claude plan run starts once.')
    this.tools = input.tools
    const unwound = this.startUnwound = deferred<void>()
    try {
      await assertClaudePlanExecutableUnchanged(this.options.executable)
      this.assertStillStarting()
      const policy = await checkClaudeCodeHookPolicy()
      this.assertStillStarting()
      if (policy) throw new ClaudePlanRunError('startup_refused', policy)
      this.sessionStarted = deferred()
      await this.prepareFolder(input.systemPrompt)
      // A Stop, delete or restore that ended the run during these awaits spawns nothing (review, Part 3).
      this.assertStillStarting()
      this.spawnClaude()
      await this.writePrivate('claude.json', JSON.stringify({ pid: this.proc?.pid ?? null }))
      await Promise.all([this.initialize(), this.awaitSessionStart()])
      await this.handshake()
      this.phase = 'running'
      this.write({ type: 'user', message: { role: 'user', content: input.content } })
    } catch (error) {
      const refusal = error instanceof ClaudePlanRunError ? error
        : new ClaudePlanRunError('startup_refused', `Batshit could not start Claude Code: ${error instanceof Error ? error.message : String(error)}`)
      this.endWith(this.endError ?? refusal, 'kill')
      throw this.endError ?? refusal
    } finally {
      unwound.resolve()
    }
  }

  /** The run ended while it was still starting: stop before the next startup step. */
  private assertStillStarting(): void {
    if (this.ended) throw this.endError ?? new ClaudePlanRunError('stopped', 'The reply was stopped before Claude Code started.')
  }

  private async prepareFolder(systemPrompt: string): Promise<void> {
    // A short folder: macOS refuses Unix socket paths over about 104 bytes (P0 §3).
    this.dir = await mkdtemp('/tmp/bcp-')
    await applyClaudeRuntimeOwnershipWithoutFollowing(this.dir)
    const node = this.options.nodePath ?? process.execPath
    const bridge = path.join(this.options.scriptsDir ?? path.join(process.cwd(), 'scripts'), 'claude-plan-bridge.cjs')
    const hook = (role: string, timeout: number) => ({ type: 'command', command: node, args: [bridge, role, this.dir], timeout, onFailure: 'block' })
    // Who owns this folder, so a boot sweep after a crash removes only this Batshit's leftovers.
    await this.writePrivate('owner.json', JSON.stringify({ ownerPid: process.pid, runId: this.id, createdAt: new Date().toISOString() }))
    await this.writePrivate('secret', this.secret)
    // D17: the one fixed tool-names line leads the system text when the run offers tools.
    await this.writePrivate('system.txt', claudePlanSystemText(systemPrompt, this.tools))
    await this.writePrivate('mcp.json', JSON.stringify({
      mcpServers: { [CLAUDE_PLAN_MCP_SERVER]: { type: 'stdio', command: node, args: [bridge, 'mcp', this.dir], env: {}, alwaysLoad: true } }
    }))
    await this.writePrivate('settings.json', JSON.stringify({
      ...(typeof this.options.alwaysThinking === 'boolean' ? { alwaysThinkingEnabled: this.options.alwaysThinking } : {}),
      hooks: {
        SessionStart: [{ hooks: [hook('session', this.timing.sessionHookSeconds)] }],
        UserPromptSubmit: [{ hooks: [hook('gate', this.timing.gateHookSeconds)] }],
        PreToolUse: [{ matcher: 'mcp__batshit__.*', hooks: [hook('pre', this.timing.preHookSeconds)] }],
        PostToolBatch: [{ hooks: [hook('batch', this.timing.batchHookSeconds)] }]
      }
    }))
    this.server = createServer(socket => this.serve(socket))
    const socketPath = path.join(this.dir, 's')
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(socketPath, () => { this.server!.off('error', reject); resolve() })
    })
    await applyClaudeRuntimeOwnershipWithoutFollowing(socketPath)
  }

  private async writePrivate(name: string, contents: string): Promise<void> {
    const handle = await open(path.join(this.dir!, name), 'wx', 0o600)
    try {
      await applyClaudeRuntimeOwnershipToHandle(handle)
      await handle.writeFile(contents, 'utf8')
    } finally {
      await handle.close()
    }
  }

  /** The documented flags (D3, D12) and the strict environment (D2, D4, D7). */
  buildArgs(): string[] {
    return [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages',
      '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--mcp-config', path.join(this.dir!, 'mcp.json'),
      '--settings', path.join(this.dir!, 'settings.json'), '--setting-sources', '', '--permission-mode', 'dontAsk',
      '--system-prompt-file', path.join(this.dir!, 'system.txt'), '--thinking-display', 'summarized',
      ...(this.options.cliModel ? ['--model', this.options.cliModel] : []),
      ...(this.options.effort ? ['--effort', this.options.effort] : [])
    ]
  }

  buildEnv(): Record<string, string> {
    const sevenDays = String(DELEGATION_BRIDGE_TOOL_TIMEOUT_MS)
    return {
      ...buildClaudePlanBaseEnv(this.options.runAs),
      DISABLE_AUTO_COMPACT: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      ENABLE_TOOL_SEARCH: 'false',
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
      CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: String(claudePlanDescriptionLimit(this.tools)),
      MCP_TOOL_TIMEOUT: sevenDays,
      CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: sevenDays,
      CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0',
      MAX_MCP_OUTPUT_TOKENS: '200000'
    }
  }

  private spawnClaude(): void {
    const proc = spawn(this.options.executable.realPath, this.buildArgs(), {
      cwd: this.options.workingDirectory,
      env: this.buildEnv(),
      ...buildClaudeChildProcessOptions(this.options.runAs),
      // Its own process group, so an end reaches its hooks and the bridge too.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.proc = proc
    let buffer = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (!line.trim()) continue
        let event: any
        try { event = JSON.parse(line) } catch {
          this.fail('run_failed', 'Claude Code printed a line Batshit could not read. The run was stopped.')
          return
        }
        this.options.onRawEvent?.(event)
        this.onEvent(event)
      }
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => { this.stderrTail = (this.stderrTail + chunk).slice(-2000) })
    proc.stdin.on('error', () => { /* a closed pipe after the process ended; its close reports the end */ })
    proc.on('error', error => this.fail('run_failed', `Claude Code could not start: ${error.message}`))
    // `close`, not `exit`: it fires after stdout was read to its end, so no last event is lost.
    proc.on('close', (code, signal) => {
      this.exitSeen = true
      if (!this.ended) {
        // Only the last line reaches a person (Faye nit); the full tail is never logged.
        const last = this.stderrTail.trim().split('\n').filter(Boolean).at(-1)?.slice(0, 200)
        this.endWith(new ClaudePlanRunError('run_ended', `Claude Code ended unexpectedly (${signal ?? `exit ${code}`}).${last ? ` ${last}` : ''}`), 'none')
      }
    })
  }

  private write(message: unknown): void {
    if (!this.proc || this.ended) return
    this.proc.stdin.write(JSON.stringify(message) + '\n')
  }

  /** A startup wait, bounded by its own limit and cut short when the run ends (Faye N12). */
  private async within<T>(promise: Promise<T>, ms: number, refusal: ClaudePlanRunError): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let onEnd: (() => void) | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => { timer = setTimeout(() => reject(refusal), ms) }),
        new Promise<T>((_, reject) => {
          const ended = () => reject(this.endError ?? new ClaudePlanRunError('stopped', 'The reply was stopped before Claude Code started.'))
          if (this.ended) { ended(); return }
          onEnd = ended
          this.endedSignal.addEventListener('abort', onEnd, { once: true })
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
      if (onEnd) this.endedSignal.removeEventListener('abort', onEnd)
    }
  }

  private async initialize(): Promise<void> {
    this.phase = 'initialize'
    this.initializeAnswer = deferred()
    this.write({ type: 'control_request', request_id: `batshit-initialize-${this.id}`, request: { subtype: 'initialize' } })
    const answer = await this.within(this.initializeAnswer.promise, this.timing.initializeMs,
      new ClaudePlanRunError('startup_timeout', 'Claude Code did not answer its startup check in time, so Batshit sent nothing. A Claude Code set up for a cloud provider does not answer; Claude plan replies need Claude Code signed in with a Claude plan.'))
    const problem = checkInitializeAnswer(answer, this.options.executable.version)
    if (problem) throw new ClaudePlanRunError('startup_refused', `${problem} Batshit stopped before any model call.`)
    this.modelCatalog = readModelCatalog(answer)
  }

  /**
   * The SessionStart hook runs before any prompt (P0 §4). If it never arrives, Claude Code is not running
   * Batshit's hooks (for example an organization policy with `disableAllHooks` or `allowManagedHooksOnly`,
   * from any source, including server-managed settings), so the gate could not hold the handshake.
   */
  private async awaitSessionStart(): Promise<void> {
    await this.within(this.sessionStarted!.promise, this.timing.sessionStartMs,
      new ClaudePlanRunError('startup_refused', 'Claude Code did not run Batshit\'s start-up hook, so Batshit sent nothing. An organization policy that turns off hooks (disableAllHooks or allowManagedHooksOnly) stops the Claude plan connection.'))
  }

  private async handshake(): Promise<void> {
    this.phase = 'handshake'
    this.handshakeDone = deferred()
    this.write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: CLAUDE_PLAN_HANDSHAKE_TEXT }] } })
    await this.within(this.handshakeDone.promise, this.timing.handshakeMs,
      new ClaudePlanRunError('startup_timeout', 'Claude Code did not finish its startup check in time, so Batshit sent nothing.'))
    const problem = (this.handshakeGateSeen ? null : 'Batshit\'s prompt check did not run inside Claude Code.') ??
      this.handshakeGateProblem ?? this.checkInit(this.handshakeInit) ??
      checkEffortSupport(this.modelCatalog, this.options.cliModel, String(this.handshakeInit?.model), this.options.effort)
    if (problem) throw new ClaudePlanRunError('startup_refused', `${problem} Batshit stopped before any model call.`)
    this.handshakePassed = true
  }

  /** `init` must show the plan route and exactly Batshit's tools (D2 step 4). */
  private checkInit(init: any): string | null {
    if (!init) return 'Claude Code did not report how it starts.'
    if (init.apiKeySource !== 'none') return `Claude Code would use ${String(init.apiKeySource)}, not the Claude plan sign-in.`
    if (init.claude_code_version !== this.options.executable.version) return `Claude Code reported version ${String(init.claude_code_version)}, not the checked ${this.options.executable.version}.`
    if (init.permissionMode !== 'dontAsk') return `Claude Code started in ${String(init.permissionMode)} mode, not dontAsk.`
    // A full model id must start as itself; an alias (`opus`, `best`, `opusplan[1m]`) or "CLI default"
    // starts as whatever Claude model Claude Code resolves it to (measured on 2.1.296: `opus` starts
    // `claude-opus-5-5`, `opusplan` starts `claude-sonnet-5-5`).
    if (this.options.cliModel && /^claude-/.test(this.options.cliModel)) {
      if (init.model !== this.options.cliModel) return `Claude Code started ${String(init.model)}, not ${this.options.cliModel}.`
    } else if (typeof init.model !== 'string' || !/^claude-/.test(init.model)) {
      return `Claude Code started ${String(init.model)}, which is not a Claude model.`
    }
    const servers = Array.isArray(init.mcp_servers) ? init.mcp_servers : []
    if (servers.length !== 1 || servers[0]?.name !== CLAUDE_PLAN_MCP_SERVER || servers[0]?.status !== 'connected') {
      return 'Claude Code did not connect exactly Batshit\'s tool server.'
    }
    const offered = new Set(this.tools.map(tool => tool.wireName))
    const listed = Array.isArray(init.tools) ? init.tools.map(String) : []
    const extra = listed.filter((name: string) => !offered.has(name) && name !== CLAUDE_PLAN_END_CONVERSATION_TOOL)
    const missing = [...offered].filter(name => !listed.includes(name))
    if (extra.length) return `Claude Code offered its own tools (${extra.slice(0, 5).join(', ')}).`
    if (missing.length) return `Claude Code did not load ${missing.length} of Batshit's tools (${missing.slice(0, 5).join(', ')}).`
    return null
  }

  private gateProblem(request: any): string | null {
    if (!this.proc?.pid || String(request.claudePid) !== String(this.proc.pid)) return 'The prompt check came from another Claude Code process.'
    const names = Array.isArray(request.envNames) ? request.envNames.map(String) : null
    if (!names) return 'The prompt check could not read Claude Code\'s environment.'
    const routes = names.filter((name: string) => ROUTE_NAME.test(name))
    if (routes.length) return `Claude Code's settings set ${routes.join(', ')}, which can move it off the Claude plan.`
    return null
  }

  // ---------------------------------------------------------------------------------------------
  // Claude Code's events

  private onEvent(event: any): void {
    if (this.ended) return
    if (event?.type === 'control_request') {
      this.fail('run_failed', 'Claude Code asked Batshit a question it does not answer. The run was stopped.')
      return
    }
    if (this.phase === 'initialize') {
      if (event?.type === 'control_response' && event.response?.request_id === `batshit-initialize-${this.id}`) this.initializeAnswer?.resolve(event.response)
      return
    }
    if (this.phase === 'handshake') {
      if (event?.type === 'system' && event.subtype === 'init') {
        this.handshakeInit = event
        if (typeof event.messaging_socket_path === 'string') this.messagingSocketPath = event.messaging_socket_path
      } else if (event?.type === 'result') {
        if (event.is_error || Number(event.usage?.output_tokens ?? 0) !== 0) {
          this.handshakeGateProblem ??= 'Claude Code answered the startup prompt instead of stopping at Batshit\'s check.'
        }
        this.handshakeDone?.resolve()
      } else if (event?.type === 'stream_event' || event?.type === 'assistant') {
        this.handshakeGateProblem ??= 'Claude Code started a model call during its startup check.'
        this.fail('startup_refused', 'Claude Code started a model call during its startup check. Batshit stopped it.')
      }
      return
    }
    this.lastActivity = Date.now()
    if (event?.type === 'system' && event.subtype === 'init') {
      const problem = this.checkInit(event)
      if (problem) { this.fail('integrity', `${problem} Batshit stopped the run.`); return }
      if (typeof event.messaging_socket_path === 'string') this.messagingSocketPath = event.messaging_socket_path
      return
    }
    const block = event?.type === 'stream_event' && !event.parent_tool_use_id ? event.event?.content_block : null
    if (block?.type === 'tool_use') {
      if (block.name === CLAUDE_PLAN_END_CONVERSATION_TOOL) {
        if (this.unlisted.has(String(block.id))) this.fail('integrity', 'Claude streamed a tool call with a missing or repeated id. The run was stopped.')
        else this.endConversationIds.add(String(block.id))
      } else if (!this.tools.some(tool => tool.wireName === block.name)) this.noteUnlisted(block)
      if (this.ended) return
    }
    if (event?.type === 'user' && event.isReplay === true) this.echoedUserTexts.push(userMessageText(event.message?.content))
    if (event?.type === 'user') this.checkRecordedResults(event)
    if (this.ended) return
    this.events.push(event)
  }

  /**
   * D4 integrity: every `tool_result` Claude Code records must be one Batshit released, with the same
   * content and error flag (M1). A bridge that died, a reply that never arrived, or a result Claude Code
   * replaced (an MCP error, an oversize swap) records something else, and the run ends.
   */
  private checkRecordedResults(event: any): void {
    const content = event.message?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block?.type !== 'tool_result') continue
      const id = String(block.tool_use_id)
      if (this.endConversationIds.has(id)) continue
      const unlisted = this.unlisted.get(id)
      if (unlisted) {
        // Only Claude Code's own error, once, for a call no hook or MCP call reached (BL-2368).
        if (unlisted.recorded || block.is_error !== true || block.content !== claudeCodeNoSuchToolText(unlisted.name)) {
          this.fail('integrity', 'Claude Code recorded a result for a call to a tool Batshit does not list that is not its own "No such tool" error. The run was stopped and nothing after it was used.')
          return
        }
        unlisted.recorded = true
        for (const wake of [...this.recordedWaiters]) wake()
        continue
      }
      const record = this.calls.get(id)
      if (!record?.answer) {
        this.fail('integrity', 'Claude Code recorded a tool result that Batshit did not send (a hook or tool failure). The run was stopped and nothing after it was used.')
        return
      }
      // Images by count only: Claude Code may resize a large image and re-encode its type (Faye S8).
      if (!sameClaudePlanToolAnswer(record.answer, recordedClaudePlanToolAnswer(block), { imageTypes: false })) {
        this.fail('integrity', 'Claude Code recorded a different tool result than the one Batshit sent (a bridge or MCP failure, or a result it replaced). The run was stopped and nothing after it was used.')
        return
      }
      record.recorded = true
      for (const wake of [...this.recordedWaiters]) wake()
    }
  }

  /** BL-2368: a streamed call to an unlisted name, in the model call now running. Its id must be new. */
  private noteUnlisted(block: any): void {
    const id = typeof block.id === 'string' ? block.id : ''
    if (!id || this.calls.has(id) || this.unlisted.has(id) || this.endConversationIds.has(id)) {
      this.fail('integrity', 'Claude streamed a tool call with a missing or repeated id. The run was stopped.')
      return
    }
    this.unlisted.set(id, { id, name: String(block.name ?? ''), step: this.modelCallsBegun, sealed: false, recorded: false, confirmed: false })
  }

  /** The adapter's reader. Null once the run has ended. */
  nextEvent(): Promise<any | null> {
    return this.events.next()
  }

  // ---------------------------------------------------------------------------------------------
  // Steps, proposals and admission (D3, D4)

  /** A new `doStream`: the previous step's batch hook may now let Claude Code's next model call go. */
  beginModelCall(step: number): void {
    if (this.ended) return
    this.modelCallsBegun = step
    this.modelCallActive = true
    this.lastActivity = Date.now()
    this.armIdle()
    for (const waiter of [...this.stepWaiters]) {
      if (waiter.step <= step) { this.stepWaiters.splice(this.stepWaiters.indexOf(waiter), 1); waiter.done() }
    }
  }

  /**
   * D5 (SA-139 P3 Part 2): what Batshit adds after a step's results, handed over before the next model
   * call is released (`beginModelCall`), so it reaches that call and nothing earlier changes. A note
   * rides the step's PostToolBatch `additionalContext` (next to the results, for success and error
   * alike); a person's words are a stream-json user message on stdin, which Claude Code 2.1.296 takes
   * into the same next model call right after its PostToolBatch hooks (the query loop reads its message
   * queue there; P0 §A proved the delivery live). Only the step whose batch hook is still waiting takes
   * an addition.
   */
  addBetweenSteps(step: number, additions: { notes: readonly string[]; userMessages: readonly string[] }): void {
    if (this.ended) return
    if (step !== this.modelCallsBegun || step !== this.sealedStep) {
      this.fail('integrity', 'Batshit tried to add to a step that is not the one waiting for its next model call. The run was stopped.')
      return
    }
    if (additions.notes.length > 0) {
      this.batchNotes.set(step, [this.batchNotes.get(step), ...additions.notes].filter(Boolean).join('\n\n'))
    }
    for (const text of additions.userMessages) this.write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
  }

  /** D5: did Claude Code take in this user message (its replay echo)? Each echo answers one message once. */
  takeUserEcho(text: string): boolean {
    const index = this.echoedUserTexts.indexOf(text)
    if (index < 0) return false
    this.echoedUserTexts.splice(index, 1)
    return true
  }

  endModelCall(): void {
    this.modelCallActive = false
    for (const wake of [...this.preWaiters]) wake()
    this.lastActivity = Date.now()
    this.armIdle()
  }

  /** `message_stop` of step `step`: its proposals are complete and may now be admitted. */
  seal(step: number, proposals: readonly ClaudePlanProposal[]): void {
    if (this.ended) return
    for (const proposal of proposals) {
      if (this.calls.has(proposal.id) || this.unlisted.has(proposal.id)) { this.fail('integrity', 'Claude streamed the same tool call id twice. The run was stopped.'); return }
      this.calls.set(proposal.id, {
        id: proposal.id, step, tool: proposal.tool, input: proposal.input, pre: false, mcp: false,
        admitted: deferred<void>(), claimed: false, executing: false, answer: null, recorded: false, reply: null
      })
    }
    // BL-2368: calls to unlisted names streamed in this model call belong to the step it seals.
    for (const entry of this.unlisted.values()) if (!entry.sealed) { entry.step = step; entry.sealed = true }
    this.sealedStep = step
    for (const wake of [...this.preWaiters]) wake()
  }

  /** The executor's wait (D4): resolves only once both rendezvous matched this exact call. */
  async admit(toolCallId: string | undefined, signal?: AbortSignal): Promise<void> {
    if (this.ended) throw this.endError ?? new ClaudePlanRunError('run_ended', 'The Claude plan run has already ended.')
    const record = toolCallId ? this.calls.get(toolCallId) : undefined
    if (!record || record.step !== this.sealedStep || record.claimed) {
      const error = new ClaudePlanRunError('integrity', 'Batshit was asked to run a tool call this Claude run did not propose. Nothing ran.')
      this.fail('integrity', error.message)
      throw error
    }
    record.claimed = true
    if (signal?.aborted) throw signal.reason
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal!.reason)
      signal?.addEventListener('abort', onAbort, { once: true, signal: this.endedSignal })
      record.admitted.promise.then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort))
    })
    record.executing = true
    this.executing += 1
    this.disarmIdle()
  }

  /** The executor's result, released to the waiting MCP call at once (D4). */
  release(toolCallId: string, answer: ClaudePlanToolAnswer): void {
    const record = this.calls.get(toolCallId)
    if (!record || this.ended) return
    if (record.answer) {
      if (!isDeepStrictEqual(record.answer, answer)) this.fail('integrity', 'Batshit released two different results for one tool call. The run was stopped.')
      return
    }
    record.answer = answer
    if (record.executing) { record.executing = false; this.executing -= 1 }
    if (record.reply) { const reply = record.reply; record.reply = null; reply({ result: answer }) }
    this.lastActivity = Date.now()
    this.armIdle()
  }

  /** D6: the reply ended at an approval card; the run waits for the click under the registry's deadline. */
  hold(): void {
    if (this.ended) return
    this.holding = true
    this.disarmIdle()
  }

  /** D6: the click claimed the run; it goes on, and the idle backstop measures real silence again. */
  unhold(): void {
    if (this.ended) return
    this.holding = false
    this.lastActivity = Date.now()
    this.armIdle()
  }

  get isHolding(): boolean { return this.holding }

  /** Has this call's result been released to Claude Code? */
  hasAnswer(toolCallId: string): boolean {
    return Boolean(this.calls.get(toolCallId)?.answer)
  }

  /**
   * D6: a call the person denied at its card. The SDK records the denial as the call's result and never
   * runs it; Claude Code's waiting MCP call gets that same denial, so nothing ran and Claude reads why.
   */
  releaseDenied(toolCallId: string, answer: ClaudePlanToolAnswer): void {
    const record = this.calls.get(toolCallId)
    if (!record || record.claimed || record.answer) {
      this.fail('integrity', 'A denied approval named a tool call that is not waiting for its answer. The run was stopped.')
      return
    }
    record.claimed = true
    this.release(toolCallId, answer)
  }

  /** A claimed call that ended without a result (its run was stopped): it no longer counts as running. */
  abandon(toolCallId: string): void {
    const record = this.calls.get(toolCallId)
    if (record?.executing) { record.executing = false; this.executing -= 1 }
    this.lastActivity = Date.now()
    this.armIdle()
  }

  /** The SDK refused a call before running it (invalid input, unknown tool): Claude gets the SDK's own text. */
  refuseBySdk(toolCallId: string, error: unknown): void {
    const record = this.calls.get(toolCallId)
    if (!record || record.claimed) return
    record.claimed = true
    this.release(toolCallId, claudePlanSdkErrorAnswer(error))
  }

  /**
   * An automatic approval decision the connection does not take (D6): the run ends with a readable
   * failure before anything that needed approval runs. Returns that failure to throw.
   */
  refuseApproval(): ClaudePlanRunError {
    this.fail('unsupported_approval', CLAUDE_PLAN_APPROVAL_REFUSAL)
    return this.failure ?? new ClaudePlanRunError('unsupported_approval', CLAUDE_PLAN_APPROVAL_REFUSAL)
  }

  /**
   * The result the SDK recorded for a step's call, checked against what Claude received. A call that
   * was never released may take its result here only when it is the SDK's own error text for a call it
   * refused before running (B S3); anything else would be an effect Batshit never admitted.
   */
  confirmRecordedResult(toolCallId: string, answer: ClaudePlanToolAnswer, sdkErrorText: boolean): void {
    const record = this.calls.get(toolCallId)
    if (!record) { this.fail('integrity', 'The next step held a tool result for a call this Claude run never made. The run was stopped.'); return }
    if (record.answer) {
      if (!sameClaudePlanToolAnswer(record.answer, answer)) this.fail('integrity', 'The tool result Batshit recorded differs from the one Claude received. The run was stopped.')
      return
    }
    if (!sdkErrorText || !answer.isError || record.claimed) {
      this.fail('integrity', 'The next step held a tool result for a call Batshit never admitted. The run was stopped.')
      return
    }
    record.claimed = true
    this.release(toolCallId, answer)
  }

  /** BL-2368: is this id a call to an unlisted name (answered by Claude Code itself)? */
  isUnlisted(toolCallId: string): boolean {
    return this.unlisted.has(toolCallId)
  }

  /**
   * BL-2368: the SDK's record of a call to an unlisted name. The SDK refused it (an unknown tool, or a bare
   * tool name the wrapper refuses), so its record must be an error. Claude Code's own "No such tool" record
   * is required by the batch hook, which holds Claude Code's next model call until it was seen (Claude Code
   * may record it after a call queued ahead of it). Each such call is confirmed once.
   */
  confirmUnlistedResult(toolCallId: string, sdkError: boolean): void {
    const entry = this.unlisted.get(toolCallId)
    if (!entry || !sdkError || entry.confirmed) {
      this.fail('integrity', 'The next step held a result for a call to an unlisted tool that was not a refusal. The run was stopped.')
      return
    }
    entry.confirmed = true
  }

  /** Proposals of a step that still have no result (the adapter checks a step's prompt against these). */
  callsOfStep(step: number): string[] {
    return [...this.calls.values()].filter(record => record.step === step).map(record => record.id)
  }

  // ---------------------------------------------------------------------------------------------
  // The socket

  private serve(socket: Socket): void {
    this.connections.add(socket)
    const chunks: Buffer[] = []
    let size = 0
    let handled = false
    socket.on('data', (chunk: Buffer) => {
      if (handled) return
      // Bytes, not characters; the line end is looked for only in the new chunk.
      const end = chunk.indexOf(10)
      if (end < 0) {
        size += chunk.length
        if (size > MAX_REQUEST_BYTES) socket.destroy()
        else chunks.push(chunk)
        return
      }
      handled = true
      if (size + end > MAX_REQUEST_BYTES) { socket.destroy(); return }
      let request: any
      try { request = JSON.parse(Buffer.concat([...chunks, chunk.subarray(0, end)]).toString('utf8')) } catch { socket.destroy(); return }
      const reply = (body: unknown) => { if (!socket.destroyed) socket.end(JSON.stringify(body) + '\n') }
      if (!sameSecret(request?.secret, this.secret)) { reply({ error: 'denied' }); return }
      void this.handle(request, reply, () => !socket.destroyed)
    })
    socket.on('error', () => undefined)
    socket.on('close', () => this.connections.delete(socket))
  }

  private async handle(request: any, reply: (body: unknown) => void, isOpen: () => boolean): Promise<void> {
    switch (request.op) {
      case 'tools': return reply({ tools: this.tools.map(toMcpToolListing) })
      case 'session':
        this.sessionStarted?.resolve()
        return reply({})
      case 'gate': return this.onGate(request, reply)
      case 'pre': return this.onPre(request, reply, isOpen)
      case 'call': return this.onCall(request, reply)
      case 'batch': return this.onBatch(request, reply)
      default: return reply({ error: 'unknown op' })
    }
  }

  private onGate(request: any, reply: (body: unknown) => void): void {
    const problem = this.gateProblem(request)
    if (request.prompt === CLAUDE_PLAN_HANDSHAKE_TEXT && this.phase === 'handshake') {
      this.handshakeGateSeen = true
      this.handshakeGateProblem ??= problem
      reply({ decision: 'block', reason: CLAUDE_PLAN_HANDSHAKE_TEXT })
      return
    }
    if (!this.handshakePassed || this.ended || problem) {
      reply({ decision: 'block', reason: 'Batshit refused this prompt: its startup checks did not pass.' })
      if (problem) this.fail('integrity', `${problem} Batshit stopped the run.`)
      return
    }
    reply({ decision: 'allow' })
  }

  /** PreToolUse: the first rendezvous. A refusal never answers; it ends the run (D4). */
  private async onPre(request: any, reply: (body: unknown) => void, isOpen: () => boolean): Promise<void> {
    const id = typeof request.id === 'string' ? request.id : null
    // BL-2368: a call to an unlisted name runs nothing; Claude Code asking to run one ends the run
    // (checked again after the wait, for a hook that arrived before its stream event was read).
    const unlisted = () => id !== null && this.unlisted.has(id)
    const refuseUnlisted = () => this.fail('integrity', 'Claude Code tried to run a tool Batshit does not list. Nothing ran; the run was stopped.')
    if (unlisted()) return refuseUnlisted()
    const record = id ? await this.waitForProposal(id) : null
    if (unlisted()) return refuseUnlisted()
    // A hook Claude Code already abandoned (its attempt was retried) asks nothing any more.
    if (this.ended || !isOpen()) return
    if (!record) return this.fail('integrity', 'Claude Code tried to run a tool call Claude did not propose. Nothing ran; the run was stopped.')
    if (record.pre) return this.fail('integrity', 'Claude Code tried to run one tool call twice. The run was stopped.')
    if (request.name !== record.tool.wireName || !isDeepStrictEqual(request.input, record.input)) {
      return this.fail('integrity', `Claude Code tried to run ${String(request.name)} with input that differs from what Claude proposed. Nothing ran; the run was stopped.`)
    }
    record.pre = true
    reply({ decision: 'allow' })
  }

  /** Waits until the id is a sealed proposal, or is known never to become one. */
  private waitForProposal(id: string): Promise<CallRecord | null> {
    return new Promise(resolve => {
      const check = () => {
        if (this.ended) { this.preWaiters.delete(check); resolve(null); return }
        const record = this.calls.get(id)
        if (record) { this.preWaiters.delete(check); resolve(record); return }
        // The current model call is sealed and the id is not in it: it is unknown. A call of a later
        // message cannot reach PreToolUse before that model call began (the batch hook holds it).
        if (this.modelCallsBegun > 0 && this.sealedStep === this.modelCallsBegun) {
          this.preWaiters.delete(check); resolve(null)
        }
      }
      this.preWaiters.add(check)
      check()
    })
  }

  /** The MCP call: the second rendezvous. On a match the executor may run the real tool. */
  private onCall(request: any, reply: (body: unknown) => void): void {
    const record = typeof request.id === 'string' ? this.calls.get(request.id) : undefined
    if (!record || !record.pre) return this.fail('integrity', 'A tool call reached Batshit without its admission. Nothing ran; the run was stopped.')
    if (record.mcp) return this.fail('integrity', 'A tool call reached Batshit twice. The run was stopped.')
    // Claude Code 2.1.296 also names the native id in the call's `_meta`; when present it must agree.
    if (request.metaId != null && request.metaId !== record.id) return this.fail('integrity', 'A tool call named two different call ids. Nothing ran; the run was stopped.')
    if (request.name !== record.tool.name || !isDeepStrictEqual(request.args, record.input)) {
      return this.fail('integrity', `The tool call for ${String(request.name)} carried input that differs from what Claude proposed. Nothing ran; the run was stopped.`)
    }
    record.mcp = true
    if (record.answer) reply({ result: record.answer })
    else record.reply = reply
    record.admitted.resolve()
  }

  /**
   * PostToolBatch: the batch must be exactly the step's calls, each released and each recorded by Claude
   * Code as released (its `tool_result` reaches stdout before the hook runs; a bounded wait covers the
   * read). Then it holds Claude Code's next model call until the adapter's next step began.
   */
  private async onBatch(request: any, reply: (body: unknown) => void): Promise<void> {
    const named: string[] = Array.isArray(request.ids) ? request.ids.map(String) : []
    // EndConversation ends the reply by itself (Faye S3): a batch of only those ends normally.
    const ids = named.filter(id => !this.endConversationIds.has(id))
    if (named.length > 0 && ids.length === 0) return reply({})
    // BL-2368: calls to unlisted names belong to the batch too, each answered by Claude Code itself.
    const listedIds = ids.filter(id => !this.unlisted.has(id))
    const unlistedIds = ids.filter(id => this.unlisted.has(id))
    const records = listedIds.map(id => this.calls.get(id))
    const step = records[0]?.step ?? this.unlisted.get(unlistedIds[0] ?? '')?.step
    const expected = step === undefined ? [] : this.callsOfStep(step)
    const expectedUnlisted = step === undefined ? [] : [...this.unlisted.values()].filter(entry => entry.step === step).map(entry => entry.id)
    const complete = ids.length > 0 && records.every(record => record && record.step === step && record.answer) &&
      listedIds.length === expected.length && expected.every(id => listedIds.includes(id)) &&
      unlistedIds.length === expectedUnlisted.length && expectedUnlisted.every(id => unlistedIds.includes(id))
    const refuse = (message: string) => {
      reply({ block: true, reason: 'Batshit stopped this run: the finished tool calls do not match what it released.' })
      this.fail('integrity', message)
    }
    if (!complete) return refuse('The finished tool calls Claude Code reported do not match the ones Batshit released. The run was stopped.')
    const recorded = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => { this.recordedWaiters.delete(check); resolve(false) }, this.timing.recordedWaitMs)
      const check = () => {
        if (this.ended || (records.every(record => record!.recorded) && unlistedIds.every(id => this.unlisted.get(id)!.recorded))) { clearTimeout(timer); this.recordedWaiters.delete(check); resolve(true) }
      }
      this.recordedWaiters.add(check)
      check()
    })
    if (this.ended) return reply({ block: true, reason: this.endError?.message ?? 'Batshit ended this run.' })
    if (!recorded) return refuse('Claude Code finished tool calls without recording the results Batshit sent. The run was stopped.')
    await new Promise<void>(resolve => {
      if (this.ended || this.modelCallsBegun > step!) { resolve(); return }
      this.stepWaiters.push({ step: step! + 1, done: resolve })
    })
    if (this.ended) {
      reply({ block: true, reason: this.endError?.message ?? 'Batshit ended this run.' })
      return
    }
    const note = this.batchNotes.get(step!)
    this.batchNotes.delete(step!)
    reply(note ? { note } : {})
  }

  // ---------------------------------------------------------------------------------------------
  // Ending (D4, D10)

  /** A normal end: Claude finished its reply. Closing stdin lets Claude Code exit by itself. */
  finish(): void {
    if (this.ended) return
    this.endWith(null, 'finish')
  }

  /** The run-wide Stop: works at any moment, also while a tool runs between steps. */
  stop(error: ClaudePlanRunError = new ClaudePlanRunError('stopped', 'The reply was stopped.')): void {
    if (this.ended) return
    this.endWith(error, 'term')
  }

  /** Integrity or failure: SIGKILL of the whole process group at once, nothing after it used. */
  fail(code: ClaudePlanRunError['code'], message: string): void {
    if (this.ended) return
    this.endWith(new ClaudePlanRunError(code, message), 'kill')
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const proc = this.proc
    if (!proc?.pid || this.exitSeen || proc.exitCode !== null || proc.signalCode !== null) return
    this.escalated = true
    try { process.kill(-proc.pid, signal) } catch {
      try { proc.kill(signal) } catch { /* already gone */ }
    }
  }

  /** After Claude Code's own exit: its hooks and bridge may linger in the group; end them too (N1). */
  private killLeftoverGroup(): void {
    const pid = this.proc?.pid
    if (!pid) return
    try {
      process.kill(-pid, 0)
      process.kill(-pid, 'SIGKILL')
    } catch { /* the group is gone */ }
  }

  private endWith(error: ClaudePlanRunError | null, mode: 'finish' | 'term' | 'kill' | 'none'): void {
    if (this.ended) return
    this.ended = true
    this.endError = error
    if (mode === 'kill') this.signalGroup('SIGKILL')
    this.disarmIdle()
    this.endedController.abort(error ?? new ClaudePlanRunError('run_ended', 'The Claude plan run ended.'))
    const reason = error ?? new ClaudePlanRunError('run_ended', 'The Claude plan run ended.')
    for (const record of this.calls.values()) record.admitted.reject(reason)
    this.initializeAnswer?.reject(reason)
    this.handshakeDone?.reject(reason)
    this.sessionStarted?.reject(reason)
    for (const waiter of this.stepWaiters.splice(0)) waiter.done()
    for (const wake of [...this.preWaiters]) wake()
    for (const wake of [...this.recordedWaiters]) wake()
    this.events.close()
    this.closeSockets()
    if (mode === 'finish') {
      try { this.proc?.stdin.end() } catch { /* already closed */ }
    } else if (mode === 'term') {
      this.signalGroup('SIGTERM')
    }
    void this.settle(mode)
  }

  private closeSockets(): void {
    for (const socket of this.connections) socket.destroy()
    this.connections.clear()
    this.server?.close()
    this.server = null
  }

  private async settle(mode: 'finish' | 'term' | 'kill' | 'none'): Promise<void> {
    let settlement: ClaudePlanSettlement = 'exited'
    let escalation: Array<ReturnType<typeof setTimeout>> = []
    // A run ended while starting settles only once `start` has unwound: its folder or process, if any
    // came to exist meanwhile, is then this settlement's to end and remove (review, Part 3).
    if (this.startUnwound) await this.startUnwound.promise
    // The run's socket may have been opened after `endWith` closed the others (review, Part 3).
    this.closeSockets()
    const proc = this.proc
    if (proc) {
      const bound = new AbortController()
      const timers: Array<ReturnType<typeof setTimeout>> = []
      const after = (ms: number, act: () => void) => { const timer = setTimeout(act, ms); timer.unref?.(); timers.push(timer) }
      if (mode === 'finish') {
        after(this.timing.exitWaitMs, () => this.signalGroup('SIGTERM'))
        after(this.timing.exitWaitMs + this.timing.stopGraceMs, () => this.signalGroup('SIGKILL'))
      } else if (mode === 'term') {
        after(this.timing.stopGraceMs, () => this.signalGroup('SIGKILL'))
      }
      after(this.timing.settleBoundMs, () => bound.abort(new Error('exit not confirmed')))
      try {
        await waitForProcessExit(proc, bound.signal)
        for (const timer of timers) clearTimeout(timer)
      } catch {
        // The escalation (SIGTERM, then SIGKILL) keeps running past the bound: only a confirmed exit stops it.
        settlement = 'unknown'
      }
      escalation = timers
    }
    if (settlement === 'exited') {
      this.killLeftoverGroup()
      await this.removeLeftovers()
      this.exitedDeferred.resolve()
    } else {
      console.error(`[claude-plan] Claude Code (pid ${proc?.pid ?? 'unknown'}) did not confirm its exit within ${this.timing.settleBoundMs} ms; its run folder is kept until it does.`)
      // The settlement stays `unknown` (owners fail closed), but a later exit still cleans up and is reported (S5).
      void waitForProcessExit(proc!).then(async () => {
        for (const timer of escalation) clearTimeout(timer)
        this.killLeftoverGroup()
        await this.removeLeftovers()
        this.exitedDeferred.resolve()
      })
    }
    this.settledDeferred.resolve(settlement)
    this.options.onSettled?.(this, settlement)
  }

  /**
   * Only after the exit is confirmed: the run folder, and Claude Code's messaging socket, which only an
   * ending by signal leaves behind (a clean exit removes it, and a reused pid's live socket must stay; N2).
   */
  private async removeLeftovers(): Promise<void> {
    const bySignal = this.escalated || this.proc?.signalCode != null
    if (bySignal && this.messagingSocketPath && this.proc?.pid && path.basename(this.messagingSocketPath) === `${this.proc.pid}.sock`) {
      try {
        const facts = await lstat(this.messagingSocketPath)
        if (facts.isSocket()) await rm(this.messagingSocketPath, { force: true })
      } catch { /* already removed by a clean exit */ }
    }
    if (this.dir) {
      try { await rm(this.dir, { recursive: true, force: true }) } catch (error) {
        console.error('[claude-plan] Could not remove a run folder', this.dir, error)
      }
      this.dir = null
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Idle backstop (D10): measures real silence, never a running admitted call

  /**
   * Silence is measured from the last sign of life (a stdout event, a step, a release). It is off only
   * while an admitted call runs; a model call that goes silent (S4) and a quiet run between steps end.
   */
  private armIdle(): void {
    if (this.ended || this.executing > 0 || this.holding) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    const wait = Math.max(0, this.lastActivity + this.timing.idleMs - Date.now())
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.ended || this.executing > 0) return
      if (Date.now() - this.lastActivity < this.timing.idleMs) { this.armIdle(); return }
      this.stop(new ClaudePlanRunError('run_ended', 'The Claude plan run was idle too long and was ended.'))
    }, wait)
    this.idleTimer.unref?.()
  }

  private disarmIdle(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
  }
}

export type ClaudePlanModelEntry = Readonly<{
  value: string
  resolvedModel: string | null
  displayName: string | null
  supportsEffort: boolean
  supportedEffortLevels: readonly string[] | null
}>

/** Only the model facts of the `initialize` answer (never the account). */
export function readModelCatalog(answer: any): ClaudePlanModelEntry[] {
  const models = answer?.response?.models
  if (!Array.isArray(models)) return []
  return models.filter(entry => typeof entry?.value === 'string').map(entry => Object.freeze({
    value: entry.value,
    resolvedModel: typeof entry.resolvedModel === 'string' ? entry.resolvedModel : null,
    displayName: typeof entry.displayName === 'string' ? entry.displayName : null,
    supportsEffort: entry.supportsEffort === true,
    supportedEffortLevels: Array.isArray(entry.supportedEffortLevels) ? entry.supportedEffortLevels.map(String) : null
  }))
}

/**
 * A preset's effort must be one the started model takes, by Claude Code's own model list (2.1.296:
 * Opus 4.6 and Sonnet 4.6 take no `xhigh`; Haiku 4.5 takes no effort). A model the list does not
 * name is left to Claude Code: unknown is not refused.
 */
export function checkEffortSupport(catalog: readonly ClaudePlanModelEntry[], cliModel: string | null, startedModel: string, effort: string | null): string | null {
  if (!effort) return null
  const base = startedModel.replace(/\[1m\]$/, '')
  const entry = catalog.find(model => model.value === (cliModel ?? 'default')) ?? catalog.find(model => model.resolvedModel === base)
  if (!entry) return null
  const name = entry.displayName ?? base
  if (!entry.supportsEffort) return `${name} takes no reasoning effort in Claude Code. Clear the preset's reasoning effort.`
  if (entry.supportedEffortLevels && !entry.supportedEffortLevels.includes(effort)) {
    return `${name} takes reasoning effort ${entry.supportedEffortLevels.join(', ')} in Claude Code, not ${effort}. Change the preset's reasoning effort.`
  }
  return null
}

/** D2 step 2: version, a plan account, no API key source. Never keeps the email or organization. */
export function checkInitializeAnswer(answer: any, version: string): string | null {
  if (answer?.subtype !== 'success') return 'Claude Code refused its startup check.'
  const response = answer.response ?? {}
  if (response.claude_code_version !== version) return `Claude Code reported version ${String(response.claude_code_version)}, not the checked ${version}.`
  const account = response.account ?? {}
  if (account.apiKeySource) return `Claude Code would use ${String(account.apiKeySource)}, not the Claude plan sign-in.`
  if (account.apiProvider !== 'firstParty') return 'Claude Code is not signed in directly with Anthropic.'
  if (typeof account.subscriptionType !== 'string' || !account.subscriptionType.trim()) return 'Claude Code is not signed in with a Claude plan.'
  return null
}

/**
 * Boot sweep (S5): a Batshit that crashed leaves its runs' detached Claude Code process groups and their
 * `/tmp/bcp-*` folders (each holds a run secret). For a folder whose recorded owner process is gone, the
 * recorded Claude Code group is killed only while that pid still runs a command naming this exact folder
 * (a reused pid belongs to a stranger and is never signalled), and the folder is removed. A folder whose
 * owner still runs (another Batshit), or that names no owner, is kept.
 */
export async function sweepStaleClaudePlanRunFolders(options: {
  root?: string
  isAlive?: (pid: number) => boolean
  commandOf?: (pid: number) => string | null
  kill?: (pid: number) => void
} = {}): Promise<{ removed: string[]; killed: number[]; kept: string[] }> {
  const root = options.root ?? '/tmp'
  const isAlive = options.isAlive ?? ((pid: number) => {
    try { process.kill(pid, 0); return true } catch (error: any) { return error?.code === 'EPERM' }
  })
  const commandOf = options.commandOf ?? ((pid: number) => {
    try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim() || null } catch { return null }
  })
  const kill = options.kill ?? ((pid: number) => { try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ } })
  const outcome = { removed: [] as string[], killed: [] as number[], kept: [] as string[] }
  let names: string[] = []
  try { names = (await readdir(root)).filter(name => /^bcp-[A-Za-z0-9]{6}$/.test(name)) } catch { return outcome }
  for (const name of names) {
    const folder = path.join(root, name)
    let owner: any = null
    let claude: any = null
    try { owner = JSON.parse(await readFile(path.join(folder, 'owner.json'), 'utf8')) } catch { owner = null }
    try { claude = JSON.parse(await readFile(path.join(folder, 'claude.json'), 'utf8')) } catch { claude = null }
    const ownerPid = Number(owner?.ownerPid)
    if (!Number.isInteger(ownerPid) || ownerPid <= 0 || ownerPid === process.pid || isAlive(ownerPid)) {
      outcome.kept.push(folder)
      continue
    }
    const claudePid = Number(claude?.pid)
    if (Number.isInteger(claudePid) && claudePid > 0 && isAlive(claudePid) && (commandOf(claudePid) ?? '').includes(folder)) {
      kill(claudePid)
      outcome.killed.push(claudePid)
    }
    try {
      await rm(folder, { recursive: true, force: true })
      outcome.removed.push(folder)
    } catch {
      outcome.kept.push(folder)
    }
  }
  return outcome
}
