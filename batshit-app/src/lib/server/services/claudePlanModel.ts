import { createHash } from 'node:crypto'
import os from 'node:os'
import { createDownload } from 'ai'
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage
} from '@ai-sdk/provider'

import { resolveClaudeRunAsIdentity, type ClaudeRunAsIdentity } from '$lib/server/services/claudeRuntimeUser'
import { bindClaudePlanExecutable, type ClaudePlanExecutable } from '$lib/server/services/claudePlanExecutable'
import {
  CLAUDE_PLAN_APPROVAL_REFUSAL,
  CLAUDE_PLAN_END_CONVERSATION_TOOL,
  CLAUDE_PLAN_HOOK_NOTE_LIMIT,
  ClaudePlanRunError,
  buildClaudePlanOpening,
  claudePlanFinishReason,
  claudePlanResultFailure,
  claudePlanSdkErrorAnswer,
  claudePlanToolsFingerprint,
  claudePlanUnlistedCallFailure,
  claudePlanUnlistedToolNote,
  claudePlanUsage,
  mapClaudePlanWireName,
  prepareClaudePlanToolAnswer,
  prepareClaudePlanTools,
  toClaudePlanToolAnswer,
  type ClaudePlanDownload,
  type ClaudePlanPreparedTool
} from '$lib/server/services/claudePlanProtocol'
import { ClaudePlanRun, type ClaudePlanProposal, type ClaudePlanRunOwner, type ClaudePlanRunTiming } from '$lib/server/services/claudePlanRun'
import { holdClaudePlanRun, registerClaudePlanRun, type ClaudePlanHeldState, type ClaudePlanHoldKey } from '$lib/server/services/claudePlanRunRegistry'
import { TOOL_APPROVAL_TIMEOUT_MS } from '$lib/server/services/toolApprovalState'
import { runAbortSignalOf } from '$lib/server/services/lateToolResults'
import { resolveBashWorkspaceRoot, resolveExistingDirectory } from '$lib/server/services/bashWorkspaceRoot'
import { TYPED_READ_FILE_MARKER } from '$lib/server/services/typedFileTools'
import { relayAbort } from '$lib/server/services/turnAbortRelay'
import { formatSteerForModel, type SteerEntry } from '$lib/utils/steerControl'
import type { AddressSourcePiece } from '$lib/utils/imageAddressOrigin'

/**
 * SA-139 P2: the Claude plan connection as ONE AI SDK model (D3). The first `doStream` starts the
 * reply's Claude Code run and sends Batshit's compiled turn; each later `doStream` is the next model
 * call of the SAME run: it checks the step's prompt against what Claude already holds, confirms each
 * tool result against what Claude received, lets Claude Code's next model call go, and streams it.
 * One `doStream` is one Claude Code model call with its internal retries; a retry after visible
 * output fails the step and kills the run, so nothing streams twice. Calls are offered to the SDK
 * only at `message_stop`, so a proposal from an abandoned attempt never reaches Batshit's executor.
 *
 * The carried-calls split, approval holds, appended human input and between-step notes are P3's;
 * until then each one fails visibly here by name, never silently.
 */

export type ClaudePlanModelConfig = {
  /** Batshit's model id (the catalog value, `default` for "CLI default"). */
  modelId: string
  cliModel: string | null
  effort: string | null
  /** The preset's Thinking (D12; P1 admission's `alwaysThinking`); null or absent leaves Claude Code's default. */
  alwaysThinking?: boolean | null
  owner: ClaudePlanRunOwner
  workingDirectory: string
  executable?: ClaudePlanExecutable
  runAs?: ClaudeRunAsIdentity
  scriptsDir?: string
  nodePath?: string
  timing?: Partial<ClaudePlanRunTiming>
  /** Drift recording only (D13). */
  onRawEvent?: (event: unknown) => void
  /** D6: this reply's hold key (chat, reply, paused version); absent where no card can hold (delegated runs). */
  holdKey?: ClaudePlanHoldKey
  /** D6: the held run, and its state, that the click handed this continuation. */
  held?: { run: ClaudePlanRun; state: ClaudePlanHeldState }
  /** Tests only: the card's clock (default `TOOL_APPROVAL_TIMEOUT_MS`, 180 s). */
  holdMs?: number
}

/** A sealed call of the native message not offered yet (D3 carried call). */
type CarriedCall = { id: string; tool: ClaudePlanPreparedTool; json: string }

/** What a held run's continuation needs, kept by the registry beside the run (D6). */
type ClaudePlanHeldSnapshot = {
  step: number
  nativeStep: number
  lastStepCalls: string[]
  awaitingApproval: string[]
  carried: CarriedCall[]
  tools: readonly ClaudePlanPreparedTool[]
  toolsPrint: string
  readOnlyTools: string[]
  decisions: Array<[string, boolean]>
  /** Additions taken but not handed over yet, and those handed over (budget and evidence) (review A S1). */
  pendingNotes: ClaudePlanHandoff[]
  pendingWords: ClaudePlanHandoff[]
  handedOver: ClaudePlanHandoff[]
  /** The run's frozen selection: a continuation for another model or effort is refused (review B S5). */
  selection: { cliModel: string | null; effort: string | null; alwaysThinking: boolean | null }
}

type BlockState =
  | { kind: 'text'; id: string }
  | { kind: 'reasoning'; id: string }
  | { kind: 'skip' }
  | { kind: 'tool'; id: string; tool: ClaudePlanPreparedTool; json: string }
  /** BL-2368: a call to a name none of Batshit's tools has. */
  | { kind: 'unlisted'; id: string; name: string; json: string }
  | { kind: 'end'; id: string }

/** Canonical JSON for a prompt fingerprint: bytes as base64, request options left out (they change per step). */
function canonical(value: unknown): unknown {
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString('base64') }
  if (value instanceof URL) return { url: value.href }
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      if (key === 'providerOptions') continue
      out[key] = canonical((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/** D5 evidence: one addition handed to Claude Code between steps, and how it travelled. */
export type ClaudePlanHandoff = Readonly<{
  /** The step whose results it follows. */
  step: number
  carrier: 'batch_note' | 'user_message'
  /** `unlisted_tool` (BL-2368): Batshit's note after a call to a name none of its tools has. */
  source: 'skill' | 'dm_steer' | 'user_steer' | 'unlisted_tool'
  text: string
  steerId?: string
  /** When Batshit wrote it to Claude Code; set once handed over. */
  handedAt?: string
  /**
   * A person's words only: when Claude Code's replay echo showed the message joined the next model call.
   * A note rides the batch hook's answer, which Claude Code adds to that call before it starts.
   */
  deliveredAt?: string
}>

function fingerprint(messages: LanguageModelV4Prompt): string {
  return createHash('sha256').update(JSON.stringify(canonical(messages))).digest('hex')
}

export class ClaudePlanModel implements LanguageModelV4 {
  readonly specificationVersion = 'v4' as const
  readonly provider = 'claude-plan'
  /** None: the SDK downloads any URL first, so Claude gets bytes it can check. */
  readonly supportedUrls = {}
  readonly modelId: string

  private readonly config: ClaudePlanModelConfig
  private run: ClaudePlanRun | null = null
  private starting: Promise<void> | null = null
  private tools: readonly ClaudePlanPreparedTool[] = []
  private toolsPrint = ''
  private step = 0
  private held: { length: number; print: string } | null = null
  private lastStepCalls: string[] = []
  private lastFinish: LanguageModelV4FinishReason['unified'] | null = null
  private readonly relayed = new WeakSet<AbortSignal>()
  /** Tools registered as truly read-only (the typed reader's marker), offered with `readOnlyHint` (D4). */
  private readonly readOnlyTools = new Set<string>()
  /** `endReply` came first: this reply is over, so no later step may start or continue a run (review N2). */
  private ended = false
  /** The tool wrapper's formatted outputs: cleared once a step's results are confirmed, and at the end (N5). */
  private readonly formatCaches = new Set<Map<string, unknown>>()
  /** D3, D6: the turn's own approval rules, asked once per call when its message ends (the SDK asks again). */
  private needsApproval: ((name: string, input: unknown, toolCallId: string) => Promise<boolean>) | null = null
  /** Each call's answer from those rules; the SDK's own answer must agree. */
  private readonly decisions = new Map<string, boolean>()
  /** Offered calls of the last step that wait at a card. */
  private awaitingApproval = new Set<string>()
  /** D3: sealed calls of the native message not offered yet: they wait behind a call held at a card. */
  private carried: CarriedCall[] = []
  /** The step of the last real model call (a carried step makes none); the batch hook's boundary. */
  private nativeStep = 0
  /** D6: this reply ended at a card and its run waits in the registry for the click. */
  private holdingAtCard = false
  /** D6: a continuation's first step reads the paused step's results from a prompt compiled again. */
  private resuming = false
  /** Calls whose first approval ask at their own step has been checked (review A M1). */
  private readonly asked = new Set<string>()
  /** When the step that waits at a card was offered: the card's own clock starts there (review B S4). */
  private cardOfferedAt = 0
  /** D5: additions the loop handed over for the next step, in order, until that step is accepted. */
  private pendingNotes: ClaudePlanHandoff[] = []
  private pendingWords: ClaudePlanHandoff[] = []
  /** D5 evidence: what reached Claude Code between steps, apart from the logical SDK request. */
  private readonly handedOver: ClaudePlanHandoff[] = []
  /** A person's words handed over at the last boundary, until the next model call shows they arrived. */
  private awaitingEcho: ClaudePlanHandoff[] = []

  constructor(config: ClaudePlanModelConfig) {
    this.config = config
    this.modelId = config.modelId
    if (config.held) this.attachHeld(config.held.run, config.held.state as unknown as ClaudePlanHeldSnapshot)
  }

  /** D6: the click claimed the held run; this continuation goes on from the paused step. */
  private attachHeld(run: ClaudePlanRun, state: ClaudePlanHeldSnapshot): void {
    this.run = run
    this.step = state.step
    this.nativeStep = state.nativeStep
    this.lastStepCalls = [...state.lastStepCalls]
    this.awaitingApproval = new Set(state.awaitingApproval)
    this.carried = [...state.carried]
    this.tools = state.tools
    this.toolsPrint = state.toolsPrint
    for (const name of state.readOnlyTools) this.readOnlyTools.add(name)
    for (const [id, needs] of state.decisions) this.decisions.set(id, needs)
    this.pendingNotes = [...state.pendingNotes]
    this.pendingWords = [...state.pendingWords]
    this.handedOver.push(...state.handedOver)
    const selection = { cliModel: this.config.cliModel ?? null, effort: this.config.effort ?? null, alwaysThinking: this.config.alwaysThinking ?? null }
    if (selection.cliModel !== state.selection.cliModel || selection.effort !== state.selection.effort || selection.alwaysThinking !== state.selection.alwaysThinking) {
      const failure = new ClaudePlanRunError('resume_changed', 'The agent\'s Claude model, effort or Thinking changed while the approval card waited, so the run behind the card ended and nothing ran. Ask the agent again.')
      run.stop(failure)
      throw failure
    }
    this.resuming = true
    run.unhold()
  }

  private heldSnapshot(): ClaudePlanHeldState {
    const snapshot: ClaudePlanHeldSnapshot = {
      step: this.step, nativeStep: this.nativeStep, lastStepCalls: [...this.lastStepCalls],
      awaitingApproval: [...this.awaitingApproval], carried: [...this.carried], tools: this.tools,
      toolsPrint: this.toolsPrint, readOnlyTools: [...this.readOnlyTools], decisions: [...this.decisions],
      pendingNotes: [...this.pendingNotes], pendingWords: [...this.pendingWords], handedOver: [...this.handedOver],
      selection: { cliModel: this.config.cliModel ?? null, effort: this.config.effort ?? null, alwaysThinking: this.config.alwaysThinking ?? null }
    }
    return snapshot as unknown as ClaudePlanHeldState
  }

  /** D3, D6: the turn's approval rules, from `wrapClaudePlanApprovals`. */
  setApprovalPredicate(predicate: (name: string, input: unknown, toolCallId: string) => Promise<boolean>): void {
    this.needsApproval = predicate
  }

  /**
   * The SDK's own approval answer for a call must agree with the one the adapter split the message on
   * (D3): a call it holds at a card must be the one the adapter offered last, and no other. A card is
   * passed through; an automatic decision is refused as before.
   */
  reviewApprovalDecision(toolCallId: string | undefined, status: unknown): unknown {
    const type = typeof status === 'string' ? status : status && typeof status === 'object' ? (status as { type?: unknown }).type : undefined
    if (type !== undefined && type !== 'not-applicable' && type !== 'user-approval') return this.refuseApproval()
    const card = type === 'user-approval'
    // D6 replay: the SDK asks again for a call the person answered at its card, and a rule's live answer
    // may have changed by then (an approval window the click opened); the SDK treats both answers as
    // approved, so they pass. Only a call's first ask at its own step must agree (review A M1).
    if (toolCallId && this.resuming && this.awaitingApproval.has(toolCallId)) return status
    if (!toolCallId || this.asked.has(toolCallId)) return status
    this.asked.add(toolCallId)
    const expected = this.decisions.get(toolCallId)
    if (expected !== undefined && expected !== card) {
      const failure = new ClaudePlanRunError('integrity', 'A tool call\'s approval rule answered differently the second time it was asked. Nothing that needed approval ran, and the reply stopped here.')
      this.run?.fail(failure.code, failure.message)
      this.endReply()
      throw this.run?.failure ?? failure
    }
    return status
  }

  /** The reply's run, for the tool wrapper. A call outside a running reply is refused. */
  activeRun(): ClaudePlanRun {
    if (!this.run) throw new ClaudePlanRunError('integrity', 'A tool call reached the Claude plan connection before its run started. Nothing ran.')
    return this.run
  }

  get currentRun(): ClaudePlanRun | null { return this.run }

  /** BL-2368: a call Claude made to a name none of Batshit's tools has here (Claude Code answered it). */
  isUnlistedCall(toolCallId: string | undefined): boolean {
    return Boolean(toolCallId && this.run?.isUnlisted(toolCallId))
  }

  /** For `wrapClaudePlanToolSet`: its cache of formatted outputs lives no longer than the step that needs it. */
  registerFormatCache(cache: Map<string, unknown>): void {
    this.formatCaches.add(cache)
  }

  private clearFormatCaches(): void {
    for (const cache of this.formatCaches) cache.clear()
  }

  /** For `wrapClaudePlanToolSet`: a tool carrying the typed reader's registration marker only reads. */
  markReadOnlyTool(name: string): void {
    this.readOnlyTools.add(name)
  }

  /**
   * D5, D9 (SA-139 P3 Part 2): Claude Code holds the compiled opening once the first step began, so the
   * loop may no longer edit it; what it adds goes to Claude between steps, append-only (Ashe M4: the
   * loop hands each addition over explicitly; the adapter never infers one from the SDK prompt).
   */
  get holdsOpening(): boolean { return this.run !== null || this.starting !== null }

  /**
   * D9: a same-reply skill update. The SDK prompt keeps the compiled message as Claude Code read it; the
   * new list of open skills reaches Claude as the step's note and plainly replaces the earlier one.
   */
  addSkillUpdate(openSkills: string): void {
    const text = openSkills.trim()
      ? `Batshit updated the skills open in this reply. This list replaces any earlier one:\n${openSkills.trim()}`
      : 'Batshit closed the skills that were open in this reply. None is open now.'
    this.pendingNotes.push({ step: this.step, carrier: 'batch_note', source: 'skill', text })
  }

  /**
   * D5: steers taken at this tool boundary, each in the one steer wrapper (`formatSteerForModel`,
   * BL-466). A person's words are a user message; a DM keeps its non-user provenance as the step's note.
   * So within one boundary the notes reach Claude first, then the person's words (Claude Code's order).
   */
  addSteers(steers: readonly SteerEntry[]): void {
    for (const steer of steers) {
      const handoff: ClaudePlanHandoff = steer.source === 'dm'
        ? { step: this.step, carrier: 'batch_note', source: 'dm_steer', text: formatSteerForModel(steer), steerId: steer.steerId }
        : { step: this.step, carrier: 'user_message', source: 'user_steer', text: formatSteerForModel(steer), steerId: steer.steerId }
      ;(handoff.carrier === 'batch_note' ? this.pendingNotes : this.pendingWords).push(handoff)
    }
  }

  /**
   * D5 budget: everything this run holds beyond the SDK prompt (the notes and words handed over, and
   * those waiting), as one message the context check counts. Never capped, never raised.
   */
  nativeAdditionsForBudget(): Array<{ role: 'user'; content: string }> {
    const texts = [...this.handedOver, ...this.pendingNotes, ...this.pendingWords].map(item => item.text)
    return texts.length ? [{ role: 'user', content: texts.join('\n\n') }] : []
  }

  /** D5 evidence: what reached Claude Code between steps, in order (the SDK request does not show it). */
  get handoffs(): readonly ClaudePlanHandoff[] { return this.handedOver }

  /**
   * D5 (review B M2, S1): what Claude reads natively beyond the SDK prompt, for the picture-address
   * record of what the agent read: a person's steer as the user's words, a DM as an agent's note, a
   * skill update as Batshit's. The additions handed over and those waiting for this step.
   */
  nativeAdditionPieces(): AddressSourcePiece[] {
    return [...this.handedOver, ...this.pendingNotes, ...this.pendingWords].map(item => ({
      source: item.source === 'user_steer' ? 'user' : item.source === 'dm_steer' ? 'agent_note' : 'batshit',
      text: item.text
    }))
  }

  /**
   * The reply is over (the loop ended: a normal end, the step cap, a size-guard refusal, a failure).
   * A run that already finished normally is left to exit by itself; anything else is stopped (D10).
   */
  endReply(): void {
    this.ended = true
    this.clearFormatCaches()
    // D6 (Faye, P2 Part 3 read, answer 4): a run held at a card is the registry's; the request's
    // finalize backstop and a later end hook leave it to the card's clock and the sweeps.
    if (this.holdingAtCard) return
    const run = this.run
    if (!run || run.isEnded) return
    run.stop(new ClaudePlanRunError('run_ended', 'The reply ended before Claude finished.'))
  }

  /**
   * D6: the loop ended. A reply whose last step offered a call that waits at a card (no result) keeps
   * its run: the registry holds it under the reply's key with the card's own clock, and the click hands
   * it to the continuation. Anything else ends the run as `endReply` does.
   */
  endReplyAtLoopEnd(): void {
    const run = this.run
    const key = this.config.holdKey
    // Held while any call of the step still waits at its card (a refused neighbour already has its answer, review A S2).
    if (run && key && !this.ended && !run.isEnded && [...this.awaitingApproval].some(id => !run.hasAnswer(id))) {
      this.ended = true
      this.clearFormatCaches()
      try {
        holdClaudePlanRun(run, key, (this.cardOfferedAt || Date.now()) + (this.config.holdMs ?? TOOL_APPROVAL_TIMEOUT_MS), this.heldSnapshot(), [...this.awaitingApproval])
      } catch (error) {
        run.stop(error instanceof ClaudePlanRunError ? error : new ClaudePlanRunError('integrity', 'Batshit could not hold this run at its approval card.'))
        return
      }
      this.holdingAtCard = true
      run.hold()
      return
    }
    this.endReply()
  }

  get isHoldingAtCard(): boolean { return this.holdingAtCard }

  async doStream(options: LanguageModelV4CallOptions) {
    const signal = options.abortSignal
    if (signal?.aborted) throw signal.reason
    if (this.ended) throw new ClaudePlanRunError('run_ended', 'This reply already ended, so Claude was not asked again. Nothing was sent.')
    assertClaudePlanCallOptions(options)
    if (!this.run) {
      if (this.starting) throw new ClaudePlanRunError('integrity', 'The Claude plan connection was asked for two first steps at once. Nothing was sent.')
      // A start that failed before any run existed (admission closed) may be tried again (N6).
      this.starting = this.startRun(options).catch(error => {
        if (!this.run) this.starting = null
        throw error
      })
      await this.starting
    } else if (this.resuming) {
      this.acceptResume(options)
    } else {
      this.acceptStep(options)
    }
    const run = this.run!
    this.relayStop(signal, run)
    const step = ++this.step
    // D3: calls of the native message that waited behind a held call are offered with no model call.
    if (this.carried.length > 0) return await this.carriedStep(run, step)
    try {
      this.handOver(run)
    } catch (error) {
      const failure = error instanceof ClaudePlanRunError ? error : new ClaudePlanRunError('integrity', `Batshit could not hand its additions to Claude Code: ${error instanceof Error ? error.message : String(error)}`)
      run.fail(failure.code, failure.message)
      throw run.failure ?? failure
    }
    this.nativeStep = step
    run.beginModelCall(step)
    let cancelled = false
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      start: controller => {
        void this.pump(run, step, signal, part => {
          if (cancelled) return
          try { controller.enqueue(part) } catch { cancelled = true }
        }).finally(() => {
          run.endModelCall()
          if (!cancelled) { try { controller.close() } catch { /* already closed */ } }
        })
      },
      cancel: () => {
        cancelled = true
        run.stop()
      }
    })
    return {
      stream,
      request: { body: { connection: 'claude-plan', runId: run.id, step, model: this.config.cliModel ?? 'default' } }
    }
  }

  async doGenerate(options: LanguageModelV4CallOptions) {
    const { stream, request } = await this.doStream(options)
    const content: LanguageModelV4Content[] = []
    const texts = new Map<string, string>()
    const reasoning = new Map<string, string>()
    let finishReason: LanguageModelV4FinishReason = { unified: 'other', raw: undefined }
    let usage: LanguageModelV4Usage = claudePlanUsage(null, null)
    const reader = stream.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value.type === 'text-delta') texts.set(value.id, (texts.get(value.id) ?? '') + value.delta)
      if (value.type === 'reasoning-delta') reasoning.set(value.id, (reasoning.get(value.id) ?? '') + value.delta)
      if (value.type === 'tool-call') content.push(value)
      if (value.type === 'finish') { finishReason = value.finishReason; usage = value.usage }
      if (value.type === 'error') throw value.error
    }
    const words: LanguageModelV4Content[] = [
      ...[...reasoning.values()].map(text => ({ type: 'reasoning' as const, text })),
      ...[...texts.values()].map(text => ({ type: 'text' as const, text }))
    ]
    return { content: [...words, ...content], finishReason, usage, warnings: [], request }
  }

  private async startRun(options: LanguageModelV4CallOptions): Promise<void> {
    const opening = buildClaudePlanOpening(options.prompt)
    this.tools = prepareClaudePlanTools(options.tools, this.readOnlyTools)
    this.toolsPrint = claudePlanToolsFingerprint(this.tools)
    const runAs = this.config.runAs ?? resolveClaudeRunAsIdentity()
    const executable = this.config.executable ?? await bindClaudePlanExecutable({ runAs })
    // The reply may have ended while the executable was bound: start no run for it (review, Part 3).
    if (this.ended) throw new ClaudePlanRunError('run_ended', 'This reply already ended, so Claude was not asked. Nothing was sent.')
    const run = new ClaudePlanRun({
      executable, runAs,
      cliModel: this.config.cliModel, effort: this.config.effort, alwaysThinking: this.config.alwaysThinking ?? null,
      workingDirectory: this.config.workingDirectory, owner: this.config.owner,
      scriptsDir: this.config.scriptsDir, nodePath: this.config.nodePath, timing: this.config.timing,
      onRawEvent: this.config.onRawEvent
    })
    registerClaudePlanRun(run)
    this.run = run
    this.relayStop(options.abortSignal, run)
    await run.start({ systemPrompt: opening.systemPrompt, content: opening.content, tools: this.tools })
    this.held = { length: options.prompt.length, print: fingerprint(options.prompt) }
  }

  /** A run-wide Stop: each signal the SDK hands a step reaches the run until the run ends (BL-246). */
  private relayStop(signal: AbortSignal | undefined, run: ClaudePlanRun): void {
    if (!signal || this.relayed.has(signal)) return
    this.relayed.add(signal)
    relayAbort({ from: signal, to: run.stopController, reason: (source: AbortSignal) => source.reason, until: run.endedSignal })
  }

  /**
   * A later step: what Claude already holds is unchanged, and what follows is exactly the last
   * step's assistant turn and the results of its calls. Anything else is an addition P3 carries.
   */
  private acceptStep(options: LanguageModelV4CallOptions): void {
    const run = this.run!
    if (run.isEnded) throw run.failure ?? new ClaudePlanRunError('run_ended', 'The Claude plan run has already ended.')
    try {
      if (claudePlanToolsFingerprint(prepareClaudePlanTools(options.tools, this.readOnlyTools)) !== this.toolsPrint) {
        throw new ClaudePlanRunError('tools_changed', 'The tools offered to Claude changed in the middle of this reply, which the Claude plan connection cannot carry yet. Nothing ran.')
      }
      const prompt = options.prompt
      const held = this.held!
      if (prompt.length <= held.length || fingerprint(prompt.slice(0, held.length)) !== held.print) {
        throw new ClaudePlanRunError('unsupported_addition', 'Batshit changed what Claude already read in this reply. On the Claude plan connection an addition goes to Claude between steps, never as an edit, so the reply stopped here. Nothing more was sent.')
      }
      const assistant = prompt[held.length]
      if (assistant?.role !== 'assistant') {
        throw new ClaudePlanRunError('unsupported_addition', 'Batshit added a message before the tool results in this reply, which the Claude plan connection cannot carry yet. Nothing more was sent.')
      }
      const called = assistant.content.filter(part => part.type === 'tool-call').map(part => (part as any).toolCallId as string)
      if (called.length !== this.lastStepCalls.length || !called.every(id => this.lastStepCalls.includes(id))) {
        throw new ClaudePlanRunError('integrity', 'The tool calls Batshit recorded differ from the ones Claude made. Nothing more was sent.')
      }
      const answered = new Set<string>()
      for (const message of prompt.slice(held.length + 1)) {
        if (message.role !== 'tool') {
          throw new ClaudePlanRunError('unsupported_addition', 'Batshit added a message after the tool results (a picture), which the Claude plan connection cannot carry yet. Nothing more was sent.')
        }
        for (const part of message.content) {
          if (part.type !== 'tool-result') {
            throw new ClaudePlanRunError('unsupported_resume', 'An approval answer reached the Claude plan connection, which cannot carry it yet. Nothing ran.')
          }
          if (!this.lastStepCalls.includes(part.toolCallId) || answered.has(part.toolCallId)) {
            throw new ClaudePlanRunError('integrity', 'A tool result in this step belongs to no call Claude made in it. Nothing more was sent.')
          }
          answered.add(part.toolCallId)
          // BL-2368: the SDK refused a call to an unlisted name as an unknown tool; Claude Code answered it itself.
          if (run.isUnlisted(part.toolCallId)) {
            run.confirmUnlistedResult(part.toolCallId, part.output.type === 'error-text' || part.output.type === 'error-json')
            continue
          }
          run.confirmRecordedResult(part.toolCallId, toClaudePlanToolAnswer(part.output), part.output.type === 'error-text')
        }
      }
      if (answered.size !== this.lastStepCalls.length) {
        throw new ClaudePlanRunError('integrity', 'A tool call Claude made in the last step has no result. Nothing more was sent.')
      }
      if (run.isEnded) throw run.failure ?? new ClaudePlanRunError('run_ended', 'The Claude plan run has already ended.')
      this.held = { length: prompt.length, print: fingerprint(prompt) }
      this.clearFormatCaches()
    } catch (error) {
      const failure = error instanceof ClaudePlanRunError ? error : new ClaudePlanRunError('integrity', `Batshit could not read this step: ${error instanceof Error ? error.message : String(error)}`)
      run.fail(failure.code, failure.message)
      throw run.failure ?? failure
    }
  }

  /**
   * D6: a continuation's first step. The prompt was compiled again for the resume (BL-322), so only its
   * tail is checked: the last assistant turn must hold exactly the paused step's calls, and the results
   * after it must answer each once. A result already released is confirmed; a denied call's denial is
   * released to the MCP call still waiting for it; an approved call ran in the SDK's replay through the
   * attached run, before this step.
   */
  private acceptResume(options: LanguageModelV4CallOptions): void {
    const run = this.run!
    this.resuming = false
    if (run.isEnded) throw run.failure ?? new ClaudePlanRunError('run_ended', 'The Claude plan run has already ended.')
    try {
      if (claudePlanToolsFingerprint(prepareClaudePlanTools(options.tools, this.readOnlyTools)) !== this.toolsPrint) {
        throw new ClaudePlanRunError('tools_changed', 'The tools offered to Claude changed while the approval card waited, which the Claude plan connection cannot carry yet. Nothing ran.')
      }
      const prompt = options.prompt
      let at = -1
      for (let index = prompt.length - 1; index >= 0; index--) if (prompt[index].role === 'assistant') { at = index; break }
      const assistant = at < 0 ? null : prompt[at]
      const called: string[] = assistant?.role === 'assistant'
        ? assistant.content.filter(part => part.type === 'tool-call').map(part => (part as { toolCallId: string }).toolCallId)
        : []
      if (called.length !== this.lastStepCalls.length || !called.every(id => this.lastStepCalls.includes(id))) {
        throw new ClaudePlanRunError('integrity', 'The approval resume names other tool calls than the ones Claude made at the card. Nothing ran.')
      }
      const answered = new Set<string>()
      for (const message of prompt.slice(at + 1)) {
        if (message.role !== 'tool') throw new ClaudePlanRunError('unsupported_addition', 'Batshit added a message after the paused step\'s results, which the Claude plan connection cannot carry yet. Nothing more was sent.')
        for (const part of message.content) {
          if (part.type !== 'tool-result') throw new ClaudePlanRunError('unsupported_resume', 'The approval resume carried a part the Claude plan connection cannot read. Nothing ran.')
          if (!this.lastStepCalls.includes(part.toolCallId) || answered.has(part.toolCallId)) {
            throw new ClaudePlanRunError('integrity', 'A result in the approval resume belongs to no call Claude made at the card. Nothing more was sent.')
          }
          answered.add(part.toolCallId)
          // BL-2368: the SDK's refusal survives the resume's compile as an error (`providerMessages`).
          if (run.isUnlisted(part.toolCallId)) {
            run.confirmUnlistedResult(part.toolCallId, part.output.type === 'error-text' || part.output.type === 'error-json')
            continue
          }
          if (!this.awaitingApproval.has(part.toolCallId)) {
            // A call that ran before the card: Claude Code holds and recorded its released result already,
            // and the resume's copy is compiled again from the saved transcript (where an image becomes a
            // note), so it is not compared again (review A M3).
            if (!run.hasAnswer(part.toolCallId)) throw new ClaudePlanRunError('integrity', 'A call that ran before the approval card has no released result. Nothing more was sent.')
            continue
          }
          const answer = toClaudePlanToolAnswer(part.output)
          if (part.output.type === 'execution-denied') run.releaseDenied(part.toolCallId, answer)
          else run.confirmRecordedResult(part.toolCallId, answer, part.output.type === 'error-text')
        }
      }
      if (answered.size !== this.lastStepCalls.length) {
        throw new ClaudePlanRunError('integrity', 'A tool call Claude made at the card has no result in the approval resume. Nothing more was sent.')
      }
      if (run.isEnded) throw run.failure ?? new ClaudePlanRunError('run_ended', 'The Claude plan run has already ended.')
      this.held = { length: prompt.length, print: fingerprint(prompt) }
      this.clearFormatCaches()
    } catch (error) {
      const failure = error instanceof ClaudePlanRunError ? error : new ClaudePlanRunError('integrity', `Batshit could not read the approval resume: ${error instanceof Error ? error.message : String(error)}`)
      run.fail(failure.code, failure.message)
      throw run.failure ?? failure
    }
  }

  /**
   * D3: Claude Code runs a message's write calls one at a time, so a call held at a card blocks the
   * calls after it. The message is offered up to and with its first calls that need approval (a run of
   * them shares one card moment); the rest are carried: offered later with no model call.
   */
  private splitOffered<T extends { id: string; tool: ClaudePlanPreparedTool }>(calls: readonly T[]): { offered: T[]; rest: T[] } {
    const first = calls.findIndex(call => this.decisions.get(call.id) === true)
    if (first < 0) return { offered: [...calls], rest: [] }
    let last = first
    // Adjacent cards share one moment only while each is read-only (Claude Code runs those together). A write
    // card waits alone: Claude Code would not send the next write call until this one is answered, so a
    // denied first card would leave an approved second waiting forever (review A M2).
    if (calls[first].tool.readOnly) {
      while (last + 1 < calls.length && this.decisions.get(calls[last + 1].id) === true && calls[last + 1].tool.readOnly) last += 1
    }
    return { offered: calls.slice(0, last + 1), rest: calls.slice(last + 1) }
  }

  /** D3 carried step: the next calls of the native message, no model call, usage a known zero. */
  private async carriedStep(run: ClaudePlanRun, step: number) {
    // The rules are asked again now: a carried call's card is decided when it is offered (review A M1).
    if (this.needsApproval) {
      try {
        for (const call of this.carried) {
          let input: unknown
          try { input = JSON.parse(call.json.trim() === '' ? '{}' : call.json) } catch { input = undefined }
          this.decisions.set(call.id, await this.needsApproval(call.tool.name, input, call.id))
        }
      } catch (error) {
        const failure = new ClaudePlanRunError('integrity', `Batshit could not check whether a call needs approval: ${error instanceof Error ? error.message : String(error)}`)
        run.fail(failure.code, failure.message)
        throw run.failure ?? failure
      }
    }
    // A Stop or an end while the rules were asked: offer nothing (review A delta N2).
    if (run.isEnded) throw run.failure ?? new ClaudePlanRunError('run_ended', 'The Claude plan run has already ended.')
    const { offered, rest } = this.splitOffered(this.carried)
    this.carried = rest
    this.lastStepCalls = offered.map(call => call.id)
    this.awaitingApproval = new Set(offered.filter(call => this.decisions.get(call.id) === true).map(call => call.id))
    if (this.awaitingApproval.size > 0) this.cardOfferedAt = Date.now()
    this.lastFinish = 'tool-calls'
    const zero = claudePlanUsage({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, { output_tokens: 0, output_tokens_details: { thinking_tokens: 0 } })
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      start: controller => {
        controller.enqueue({ type: 'stream-start', warnings: [] })
        for (const call of offered) controller.enqueue({ type: 'tool-call', toolCallId: call.id, toolName: call.tool.name, input: call.json.trim() === '' ? '{}' : call.json })
        controller.enqueue({ type: 'finish', usage: zero, finishReason: { unified: 'tool-calls', raw: 'carried' } })
        controller.close()
      }
    })
    return { stream, request: { body: { connection: 'claude-plan', runId: run.id, step, carried: true, model: this.config.cliModel ?? 'default' } } }
  }

  /** The step is accepted: its additions go to the run before its next model call is released. */
  private handOver(run: ClaudePlanRun): void {
    const notes = this.pendingNotes
    const words = this.pendingWords
    this.pendingNotes = []
    this.pendingWords = []
    if (notes.length === 0 && words.length === 0) return
    const note = notes.map(item => item.text).join('\n\n')
    if (note.length > CLAUDE_PLAN_HOOK_NOTE_LIMIT) {
      throw new ClaudePlanRunError('addition_too_long', `A note for Claude in this reply (an agent's DM, the list of open skills, or Batshit's note about a misnamed tool) is ${note.length.toLocaleString('en-US')} characters long, and Claude Code passes on at most ${CLAUDE_PLAN_HOOK_NOTE_LIMIT.toLocaleString('en-US')} whole. Batshit stopped the reply rather than let Claude read only part of it. Nothing more was sent.`)
    }
    run.addBetweenSteps(this.nativeStep, { notes: notes.map(item => item.text), userMessages: words.map(item => item.text) })
    if (run.isEnded) throw run.failure ?? new ClaudePlanRunError('integrity', 'Batshit could not hand its additions to Claude Code. Nothing more was sent.')
    const at = new Date().toISOString()
    for (const item of [...notes, ...words]) this.handedOver.push({ ...item, handedAt: at })
    this.awaitingEcho = words
  }

  /**
   * D5 (review S2): Claude Code takes a person's words in when it reads its message queue after the batch
   * hook, and its replay echo says so before the next model call starts. A message that has not arrived by
   * then would reach Claude a step late or never, so the reply stops visibly instead.
   */
  private confirmWordsArrived(run: ClaudePlanRun): ClaudePlanRunError | null {
    const waiting = this.awaitingEcho
    this.awaitingEcho = []
    const at = new Date().toISOString()
    for (const item of waiting) {
      if (!run.takeUserEcho(item.text)) {
        return new ClaudePlanRunError('steer_not_delivered', 'A message sent during this reply did not reach Claude before its next step, so Batshit stopped the reply rather than let Claude go on without it. Send it again.')
      }
      const index = this.handedOver.findIndex(entry => entry.steerId === item.steerId && entry.carrier === 'user_message' && !entry.deliveredAt)
      if (index >= 0) this.handedOver[index] = { ...this.handedOver[index], deliveredAt: at }
    }
    return null
  }

  private async pump(run: ClaudePlanRun, step: number, signal: AbortSignal | undefined, emit: (part: LanguageModelV4StreamPart) => void): Promise<void> {
    emit({ type: 'stream-start', warnings: [] })
    let blocks = new Map<number, BlockState>()
    let startUsage: any = null
    let deltaUsage: any = null
    let stopReason: string | undefined
    let visible = false
    let messageOpen = false
    let pending: Array<{ id: string; tool: ClaudePlanPreparedTool; json: string } | { id: string; unlisted: string; json: string } | { id: string; end: true }> = []
    // Claude Code's latest rate-limit state in this model call (any status), for an untyped refusal.
    let rateLimit: unknown = null
    const failStep = (code: ClaudePlanRunError['code'], message: string) => {
      run.fail(code, message)
      emit({ type: 'error', error: run.failure ?? new ClaudePlanRunError(code, message) })
    }
    const resetAttempt = () => { blocks = new Map(); startUsage = null; deltaUsage = null; stopReason = undefined; pending = [] }

    for (;;) {
      const event = await run.nextEvent()
      if (event === null) {
        emit({ type: 'error', error: signal?.aborted ? signal.reason : run.failure ?? new ClaudePlanRunError('run_ended', 'Claude Code ended before this step finished.') })
        return
      }
      if (event.type === 'system' && event.subtype === 'api_retry') {
        if (visible) return failStep('retry_after_output', 'Claude Code retried a model call after part of it was already shown. Batshit stopped the reply so nothing appears twice.')
        resetAttempt()
        messageOpen = false
        rateLimit = null
        continue
      }
      if (event.type === 'rate_limit_event') {
        rateLimit = event.rate_limit_info ?? null
        continue
      }
      if (event.type === 'result') {
        const failure = claudePlanResultFailure(event, rateLimit)
        return failStep(failure.code, failure.message)
      }
      if (event.type !== 'stream_event' || event.parent_tool_use_id) continue
      const e = event.event
      switch (e?.type) {
        case 'message_start': {
          const undelivered = this.awaitingEcho.length ? this.confirmWordsArrived(run) : null
          if (undelivered) return failStep(undelivered.code, undelivered.message)
          if (messageOpen) {
            if (visible) return failStep('retry_after_output', 'Claude Code started the model call again after part of it was already shown. Batshit stopped the reply so nothing appears twice.')
            resetAttempt()
          }
          messageOpen = true
          startUsage = e.message?.usage ?? null
          emit({ type: 'response-metadata', id: e.message?.id, modelId: e.message?.model ?? this.modelId, timestamp: new Date() })
          break
        }
        case 'content_block_start': {
          const block = e.content_block ?? {}
          const index = Number(e.index)
          if (block.type === 'text') {
            const id = `text-${step}-${index}`
            blocks.set(index, { kind: 'text', id })
            visible = true
            emit({ type: 'text-start', id })
            if (block.text) emit({ type: 'text-delta', id, delta: block.text })
          } else if (block.type === 'thinking') {
            const id = `reasoning-${step}-${index}`
            blocks.set(index, { kind: 'reasoning', id })
            visible = true
            emit({ type: 'reasoning-start', id })
            if (block.thinking) emit({ type: 'reasoning-delta', id, delta: block.thinking })
          } else if (block.type === 'tool_use') {
            const name = String(block.name ?? '')
            const id = String(block.id ?? '')
            if (name === CLAUDE_PLAN_END_CONVERSATION_TOOL) {
              blocks.set(index, { kind: 'end', id })
              break
            }
            if (!id) return failStep('integrity', `Claude asked for ${name || 'a tool'} with no call id. Nothing ran.`)
            const tool = mapClaudePlanWireName(name, this.tools)
            if (!tool) {
              // BL-2368: a name none of Batshit's tools has. Claude Code answers it itself with its own error
              // and runs nothing (the run checks exactly that). The SDK gets the call as from any provider and
              // refuses it as an unknown tool, so the person sees the failed call and the reply goes on.
              blocks.set(index, { kind: 'unlisted', id, name, json: '' })
              visible = true
              emit({ type: 'tool-input-start', id, toolName: name })
              break
            }
            blocks.set(index, { kind: 'tool', id, tool, json: '' })
            visible = true
            emit({ type: 'tool-input-start', id, toolName: tool.name })
          } else {
            blocks.set(index, { kind: 'skip' })
          }
          break
        }
        case 'content_block_delta': {
          const block = blocks.get(Number(e.index))
          const delta = e.delta ?? {}
          if (!block) break
          if (block.kind === 'text' && delta.type === 'text_delta') emit({ type: 'text-delta', id: block.id, delta: String(delta.text ?? '') })
          else if (block.kind === 'reasoning' && delta.type === 'thinking_delta') emit({ type: 'reasoning-delta', id: block.id, delta: String(delta.thinking ?? '') })
          else if ((block.kind === 'tool' || block.kind === 'unlisted') && delta.type === 'input_json_delta') {
            block.json += String(delta.partial_json ?? '')
            emit({ type: 'tool-input-delta', id: block.id, delta: String(delta.partial_json ?? '') })
          }
          break
        }
        case 'content_block_stop': {
          const block = blocks.get(Number(e.index))
          if (!block) break
          if (block.kind === 'text') emit({ type: 'text-end', id: block.id })
          else if (block.kind === 'reasoning') emit({ type: 'reasoning-end', id: block.id })
          else if (block.kind === 'tool' || block.kind === 'unlisted') {
            emit({ type: 'tool-input-end', id: block.id })
            pending.push(block.kind === 'tool' ? { id: block.id, tool: block.tool, json: block.json } : { id: block.id, unlisted: block.name, json: block.json })
          } else if (block.kind === 'end') {
            pending.push({ id: block.id, end: true })
          }
          break
        }
        case 'message_delta':
          stopReason = e.delta?.stop_reason ?? stopReason
          deltaUsage = e.usage ?? deltaUsage
          break
        case 'message_stop': {
          const finishReason = claudePlanFinishReason(stopReason)
          this.lastFinish = finishReason.unified
          // Faye S3 (D7): a message cut at the output limit ends the reply there, as on the API lane (the SDK
          // runs no call of a `length` step). Claude Code would go on by itself: a message with calls has
          // them run (its streaming executor takes each call as its block ends), and one without asks the
          // model again (its output-limit recovery). So nothing is sealed (a call already waiting at the
          // bridge is never admitted), no call is offered, and the run stops before an EndConversation in
          // the same message is honored; send-routed's `output_limit` handling owns what follows.
          if (finishReason.unified === 'length') {
            this.lastStepCalls = []
            this.carried = []
            this.awaitingApproval = new Set()
            emit({ type: 'finish', usage: claudePlanUsage(startUsage, deltaUsage), finishReason })
            run.stop(new ClaudePlanRunError('run_ended', `Claude's reply reached its output limit (${finishReason.raw ?? 'length'}). No call in it ran.`))
            return
          }
          if (pending.some(call => 'end' in call)) {
            run.finish()
            emit({ type: 'error', error: new ClaudePlanRunError('end_conversation', 'Claude chose to end this conversation, so the reply stops here. Nothing else ran. Send a new message to go on.') })
            return
          }
          const calls = pending.filter((call): call is { id: string; tool: ClaudePlanPreparedTool; json: string } => 'tool' in call)
          // BL-2368: Claude Code already answered these itself (nothing ran); no admission, card or carrying.
          const unlisted = pending.filter((call): call is { id: string; unlisted: string; json: string } => 'unlisted' in call)
          const proposals: ClaudePlanProposal[] = []
          for (const call of calls) {
            let input: unknown
            try { input = JSON.parse(call.json.trim() === '' ? '{}' : call.json) } catch { input = undefined }
            proposals.push({ id: call.id, tool: call.tool, input })
          }
          run.seal(step, proposals)
          // A seal that failed (a repeated id) ended the run: offer no call (N3).
          if (run.isEnded) {
            emit({ type: 'error', error: run.failure ?? new ClaudePlanRunError('integrity', 'The Claude plan run ended at this step.') })
            return
          }
          // D3, D6: ask the turn's approval rules once per call, then offer the message up to its first card.
          if (this.needsApproval) {
            try {
              for (const proposal of proposals) this.decisions.set(proposal.id, await this.needsApproval(proposal.tool.name, proposal.input, proposal.id))
            } catch (error) {
              return failStep('integrity', `Batshit could not check whether a call needs approval: ${error instanceof Error ? error.message : String(error)}`)
            }
            if (run.isEnded) {
              emit({ type: 'error', error: run.failure ?? new ClaudePlanRunError('run_ended', 'The Claude plan run ended at this step.') })
              return
            }
          }
          const { offered, rest } = this.splitOffered(calls)
          this.carried = rest
          this.lastStepCalls = [...offered.map(call => call.id), ...unlisted.map(call => call.id)]
          this.awaitingApproval = new Set(offered.filter(call => this.decisions.get(call.id) === true).map(call => call.id))
          if (this.awaitingApproval.size > 0) this.cardOfferedAt = Date.now()
          for (const call of offered) emit({ type: 'tool-call', toolCallId: call.id, toolName: call.tool.name, input: call.json.trim() === '' ? '{}' : call.json })
          for (const call of unlisted) emit({ type: 'tool-call', toolCallId: call.id, toolName: call.unlisted, input: call.json.trim() === '' ? '{}' : call.json })
          // Claude Code's own error names only the wrong name: the step's note names the form tools take here.
          if (unlisted.length > 0) this.pendingNotes.push({ step, carrier: 'batch_note', source: 'unlisted_tool', text: claudePlanUnlistedToolNote(unlisted.map(call => call.unlisted), this.tools) })
          emit({ type: 'finish', usage: claudePlanUsage(startUsage, deltaUsage), finishReason })
          // Claude finished its reply: closing stdin lets Claude Code exit by itself. Any other ending with
          // no calls (a refusal) ends the run by signal (N4).
          if (calls.length === 0 && unlisted.length === 0) {
            this.awaitingApproval = new Set()
            if (finishReason.unified === 'stop') run.finish()
            else run.stop(new ClaudePlanRunError('run_ended', `Claude's reply ended (${finishReason.raw ?? finishReason.unified}).`))
          }
          return
        }
      }
    }
  }

  /** The SDK refused a call before running it: Claude gets the SDK's own error text (`repairToolCall`). */
  readonly repairToolCall = async ({ toolCall, error }: { toolCall: { toolCallId: string }; error: unknown }) => {
    this.run?.refuseBySdk(toolCall.toolCallId, error)
    return null
  }

  /**
   * An automatic approval decision (`'approved'`, `'denied'`): the SDK streams it as an approval request
   * (`isAutomatic`) that send-routed would draw as a card no person answers. The rule throws, so the
   * reply ends with this readable failure.
   */
  refuseApproval(): never {
    const failure = this.run ? this.run.refuseApproval() : new ClaudePlanRunError('unsupported_approval', CLAUDE_PLAN_APPROVAL_REFUSAL)
    // The throw errors the SDK stream outright, so neither `onError` nor `onEnd` runs: the reply ends here.
    this.endReply()
    throw failure
  }

  get lastFinishReason(): LanguageModelV4FinishReason['unified'] | null { return this.lastFinish }
}

/**
 * SA-139 (P0 S8): Claude Code runs in the agent's project folder, so its environment note names the
 * same folder as Batshit's DCM. It is the root the API agent's Bash tool and live file reads use
 * (`resolveBashWorkspaceRoot`: the chat's project, else the Default Project Directory). A chat with
 * no usable project runs in the run-as home, as the managed Claude CLI does; Claude Code has no
 * tools of its own here and its auto memory is off (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`), so that
 * folder only names where it runs. A configured run-as home that does not exist is refused by
 * name (Faye N9): the app user's own home may be unreadable to that user (Docker).
 */
export async function resolveClaudePlanWorkingDirectory(input: {
  userId?: string | null
  projectPath?: string | null
  runAs?: ClaudeRunAsIdentity
}): Promise<string> {
  const root = await resolveBashWorkspaceRoot({ userId: input.userId ?? undefined, projectPath: input.projectPath ?? null })
  if ('workspaceRoot' in root) return root.workspaceRoot
  const runAs = input.runAs ?? resolveClaudeRunAsIdentity()
  if (!runAs.home) return os.homedir()
  const home = await resolveExistingDirectory(runAs.home)
  if (home) return home
  throw new ClaudePlanRunError('startup_refused', `Claude Code's home folder ${runAs.home} does not exist, so Claude Code cannot start in it. Check BATSHIT_CLAUDE_RUN_AS_HOME, or open a project for this chat. Nothing ran.`)
}

/**
 * D12, M4: Claude Code takes no sampling, output limit, stop sequence, response format, forced tool
 * choice or call-level reasoning setting (its effort and Thinking come from admission), so a call
 * that sets one is refused by name before any run starts or step goes on. The API loop sends none
 * for this connection (`buildGenerationSettings`); this catches any other caller.
 */
const UNSUPPORTED_CALL_OPTIONS = ['temperature', 'topP', 'topK', 'presencePenalty', 'frequencyPenalty', 'seed', 'stopSequences', 'maxOutputTokens', 'responseFormat'] as const
function assertClaudePlanCallOptions(options: LanguageModelV4CallOptions): void {
  const set = UNSUPPORTED_CALL_OPTIONS.find(name => {
    const value = (options as Record<string, unknown>)[name]
    if (name === 'responseFormat') return (value as { type?: string } | undefined)?.type === 'json'
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null
  }) ?? (options.toolChoice && options.toolChoice.type !== 'auto' ? 'toolChoice' : undefined)
    ?? (options.reasoning !== undefined && options.reasoning !== 'provider-default' ? 'reasoning' : undefined)
  if (set) throw new ClaudePlanRunError('unsupported_input', `The Claude plan connection cannot apply ${set}. Nothing was sent.`)
}

export function isClaudePlanModel(model: unknown): model is ClaudePlanModel {
  return model instanceof ClaudePlanModel
}

function toJSONValue(value: unknown): unknown {
  if (value === undefined) return null
  const serialized = JSON.stringify(value)
  return serialized === undefined ? null : JSON.parse(serialized)
}

/** The SDK's own default model output for a tool with no `toModelOutput` (`ai` 7.0.119 `createToolModelOutput`). */
function defaultModelOutput(output: unknown) {
  return typeof output === 'string' ? { type: 'text' as const, value: output } : { type: 'json' as const, value: toJSONValue(output) as any }
}

function isAsyncIterable(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && Symbol.asyncIterator in (value as object))
}

/**
 * The SDK's own default download (`ai` 7.0.119 `createDefaultDownloadFunction`), for a run given no
 * guard. It stops with the run (`signal`), so an ended run leaves no download running (review N1).
 */
export function defaultClaudePlanDownload(signal?: AbortSignal): ClaudePlanDownload {
  const one = createDownload()
  return requests => Promise.all(requests.map(request => request.isUrlSupportedByModel ? null : one({ url: request.url, abortSignal: signal })))
}

/**
 * D4 admission before effects, OUTSIDE the readable wrapper: the wait for admission happens before
 * `trackToolExecution` (BL-1959) records a call, so a Stop during the wait never marks a call that
 * never ran as "outcome unknown". The SDK's options pass through unchanged, so the tracker keys on
 * the run's own signal. The model-facing output is formatted once, released to Claude at once, and
 * handed back to the SDK when it asks, so Claude and Batshit's record hold the same bytes.
 */
export function wrapClaudePlanToolSet(tools: Record<string, any>, model: ClaudePlanModel, options: {
  /** The request's guarded download (`experimental_download`); the SDK default when the request sets none. */
  download?: ClaudePlanDownload
} = {}): Record<string, any> {
  const wrapped: Record<string, any> = {}
  const formatted = new Map<string, { output: unknown; value: unknown }>()
  model.registerFormatCache(formatted)
  const guard = options.download
  for (const [name, definition] of Object.entries(tools)) {
    const original = definition?.execute
    if (!definition || typeof definition !== 'object' || typeof original !== 'function') {
      // Faye's BL-2368 read, S1: Claude Code has no client to answer a client-side call, so a tool with no
      // `execute` (client-side or provider-defined) cannot be offered here; refused by name before any model call.
      throw new ClaudePlanRunError('unsupported_tool', `The ${name} tool has no step Batshit runs (it is client-side or provider-defined), which the Claude plan connection cannot offer. Nothing was sent.`)
    }
    // Read-only by registration, never by name: a workflow named `read_file` still runs one at a time.
    if (definition[TYPED_READ_FILE_MARKER] === true) model.markReadOnlyTool(name)
    const format = async (params: { toolCallId: string; input: unknown; output: unknown }) =>
      typeof definition.toModelOutput === 'function' ? await definition.toModelOutput.call(definition, params) : defaultModelOutput(params.output)
    wrapped[name] = {
      ...definition,
      execute: async (input: unknown, options: { toolCallId?: string; abortSignal?: AbortSignal } | undefined) => {
        const run = model.activeRun()
        const id = options?.toolCallId
        // BL-2368: Claude used this tool's bare name, which is no name on this connection: Claude Code answered
        // it as unknown and ran nothing, so nothing runs here either and the SDK records the failed call.
        if (id && run.isUnlisted(id)) throw new Error(claudePlanUnlistedCallFailure(name))
        await run.admit(id, runAbortSignalOf(options))
        let output: unknown
        try {
          output = await original.call(definition, input, options)
        } catch (error) {
          if (run.isEnded || runAbortSignalOf(options)?.aborted) run.abandon(id!)
          else run.release(id!, claudePlanSdkErrorAnswer(error))
          throw error
        }
        if (isAsyncIterable(output)) {
          run.fail('unsupported_tool', `The ${name} tool streams its result, which the Claude plan connection cannot hand to Claude yet. The run was stopped.`)
          throw run.failure
        }
        try {
          const value = await format({ toolCallId: id!, input, output })
          formatted.set(id!, { output, value })
          run.release(id!, await prepareClaudePlanToolAnswer(value as any, guard ?? defaultClaudePlanDownload(run.endedSignal)))
        } catch (error) {
          const failure = error instanceof ClaudePlanRunError ? error : new ClaudePlanRunError('unsupported_input', `Batshit could not prepare the ${name} result for Claude: ${error instanceof Error ? error.message : String(error)}`)
          run.fail(failure.code, failure.message)
          throw run.failure ?? failure
        }
        return output
      },
      toModelOutput: async (params: { toolCallId: string; input: unknown; output: unknown }) => {
        const known = formatted.get(params.toolCallId)
        if (known && known.output === params.output) return known.value
        return format(params)
      }
    }
  }
  return wrapped
}

/**
 * D6: a call whose rule answers `'user-approval'` raises the API lane's own card, and the reply ends there
 * with its run held (`endReplyAtLoopEnd`); the click resumes it. Each answer must agree with the one the
 * adapter split the message on (`reviewApprovalDecision`); an automatic `'approved'` or `'denied'` (which
 * send-routed would draw as a card) is refused. A static rule is treated like a function's answer.
 */
export function wrapClaudePlanApprovals<T extends Record<string, any>>(approvals: T, model: ClaudePlanModel): T {
  // D3: the adapter asks the same rules once per call when its message ends, to split it at the first card.
  model.setApprovalPredicate(async (name, input, toolCallId) => {
    const policy = Object.prototype.hasOwnProperty.call(approvals, name) ? approvals[name] : undefined
    if (policy === undefined) return false
    const status = typeof policy === 'function' ? await policy(input, { toolCallId }) : policy
    const type = typeof status === 'string' ? status : status && typeof status === 'object' ? (status as { type?: unknown }).type : undefined
    return type === 'user-approval'
  })
  const wrapped: Record<string, any> = {}
  for (const [name, policy] of Object.entries(approvals)) {
    // BL-2368: a call Claude Code already answered as unknown (a bare tool name) runs nothing: no card for it.
    wrapped[name] = typeof policy === 'function'
      ? async (input: unknown, options: { toolCallId?: string } | undefined) => model.isUnlistedCall(options?.toolCallId) ? 'not-applicable' : model.reviewApprovalDecision(options?.toolCallId, await policy(input, options))
      : (_input: unknown, options: { toolCallId?: string } | undefined) => model.isUnlistedCall(options?.toolCallId) ? 'not-applicable' : model.reviewApprovalDecision(options?.toolCallId, policy)
  }
  return wrapped as T
}
