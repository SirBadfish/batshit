import { randomUUID } from 'crypto'
import { chatgptPlanAccountId } from '$lib/utils/chatgptPlanConnection'
import { CLAUDE_PLAN_SERVICE, isClaudePlanSelection } from '$lib/utils/claudePlanConnection'
import { getChatgptPlanRuntime } from './chatgptPlanHost'
import { PLAN_AGENT, type PlanLease } from './chatgptPlanRuntime'
import { isPlanSelection, assertPlanSettings } from './chatgptPlanInference'
import { redis } from '$lib/server/redis'
import { readPackagedCoreSystemPromptDefault } from '$lib/server/services/systemPromptRegistry'
import type { SubagentRow, MCPToolSelections } from '$lib/types/database'
import type { ToolApprovalMode } from '$lib/types/tool-approvals'
import type { ModelConnectionInfo } from '$lib/types/savedModels'
import type { DelegatedRunStatus, DelegatedUsage } from '$lib/types/delegation'
import { resolveNativeToolSettings } from '$lib/server/services/nativeTools'
import type { ApiUtilityScope } from './apiUtilityRuntime'
import { agentTypedFileToolsValue } from '$lib/server/services/typedFileTools'
import {
  retiredSubagentRefusal,
  SUBAGENT_TYPE_RETIRED_CODE,
  type RetiredSubagentRefusal,
  type SubagentType,
} from '$lib/utils/subagentType'
import {
  buildSubagentRuntimePrompt,
  buildWorkerRuntimePrompt,
} from '$lib/utils/subagentRuntimePrompt'
import { resolveSubagentSlug } from '$lib/utils/subagentSlug'
import { stripLeadingSubagentEchoText } from '$lib/server/services/finalAssistantTextSanitizer'
import {
  appendManagedSubagentDynamicInfo,
  prepareManagedSubagentDynamicInfo,
  resolveManagedSubagentScope,
} from '$lib/server/services/subagentRuntimeScope'
import {
  acquireSubagentRunLock,
  buildSubagentThreadKey,
  normalizeSubagentThreadMode,
  releaseSubagentRunLock,
  resetManagedSubagentThread,
  stillHoldsSubagentRunLock,
  SubagentCallCancelledError,
  type SubagentRunLockHandle,
  type SubagentThreadMode,
  type SubagentThreadOutcome,
} from '$lib/server/services/subagentThreads'
import { resolveCacheForensicsExperimentGroup } from '$lib/server/services/cacheForensics/apiAdapter'
import {
  buildManagedSubagentCacheForensicsRecord,
  type ManagedSubagentForensicsLane,
} from '$lib/server/services/cacheForensics/subagentAdapter'
import {
  appendSubagentCacheForensicsRecord,
  isCacheForensicsEnabled,
} from '$lib/server/services/cacheForensics/evIntegration'
import { normalizeUsageLike } from '$lib/server/services/apiProviderUsage'
import {
  resolveApiSubagentModel,
  SubagentModelSelectionError,
  type ApiSubagentModel,
} from '$lib/server/services/subagentModelSelection'
import { RuntimeModelPresetError } from '$lib/server/services/runtimeModelPreset'
import { isModelSettingRefusal } from '$lib/utils/anthropicThinkingGuard'
import {
  SubagentDeletedError,
  beginSubagentRun,
  type SubagentRunHandle,
} from '$lib/server/services/subagentRunRegistry'
import { settleSubagentRunWork } from '$lib/server/services/subagentRunSettle'
import {
  formatDelegationDuration,
  getSubagentTimeoutValidationError,
  normalizeSubagentTimeoutSeconds,
} from '$lib/utils/subagentTimeout'
import {
  getSubagentMaxToolStepsValidationError,
  normalizeSubagentMaxToolSteps,
} from '$lib/utils/subagentToolSteps'
import {
  DELEGATED_RUN_STALL_MS,
  UNWATCHED_DELEGATED_RUN,
  createDelegatedStallWatch,
  type DelegatedRunProgress,
} from '$lib/server/services/delegatedRunWatch'

const MAX_SUBAGENT_MEMORY_MESSAGES = 24

/**
 * SA-111 P4 (DL-111-09): which KIND of delegated run this is. A worker reuses the same
 * runner, limits policy, and result shape as a subagent, but it is ephemeral: no stored
 * thread, no serialize lock, and its own runtime prompt.
 */
export type ManagedDelegationKind = 'subagent' | 'worker'

/**
 * How this run treats continuity. `stored` is the SA-111 P2 subagent contract (open the
 * `(session, slug)` thread, persist it while the run still holds its lock). `none` is the
 * worker contract: parallel is the point and a worker has no thread, so it must never
 * touch `subagent_sessions:` or the lock.
 */
type ThreadPlan =
  | { kind: 'stored'; mode: SubagentThreadMode; lock: SubagentRunLockHandle | null }
  | { kind: 'none' }

type ManagedSubagentMemoryMessage = {
  role: 'user' | 'assistant'
  content: string
}

export type ManagedSubagentExecutionParams = {
  userId: string
  sessionId: string
  chatInput: string
  subagent: SubagentRow
  parentAgentId?: string | null
  /** Parent send's message id — enables SA-093 forensics on the parent snapshot. */
  parentMessageId?: string | null
  projectPath?: string | null
  selectedGateways?: string[] | null
  toolSelections?: MCPToolSelections | null
  selectedCliToolIds?: string[] | null
  defaultGateways?: string[] | null
  toolApprovalMode?: ToolApprovalMode
  parentModelId?: string | null
  parentConnection?: ModelConnectionInfo | null
  dcmDisplaySettings?: import('$lib/types/database').AgentDcmDisplaySettings | null
  /**
   * SA-111 P2 (DL-111-04). `fresh` (the default) discards any stored thread for this
   * `(session, subagent)` and starts empty; `resume` continues it.
   */
  thread?: SubagentThreadMode
  /** Internal observer used to keep timeout results honest after the thread is opened. */
  reportThreadOutcome?: (outcome: SubagentThreadOutcome) => void
  abortSignal?: AbortSignal
  /**
   * SA-111 P4 (DL-111-09/10). `'worker'` runs the same lane with the worker contract:
   * the `WORKER RUNTIME CONTEXT` prompt, no stored thread, and no serialize lock. Default
   * `'subagent'` — a caller that says nothing gets the existing behaviour exactly.
   */
  delegationKind?: ManagedDelegationKind
  /** Worker-only: the caller's optional role label, shown in the worker's runtime prompt. */
  workerRole?: string | null
  /** Worker-only: the display name of the subagent this worker is a throwaway clone of. */
  workerBaseLabel?: string | null
  /**
   * Worker-only: the slug this run is known by (`worker_<agent>_<position in the batch>`). It
   * never reaches a thread or lock key, because a worker has neither.
   */
  delegationSlug?: string
}

/**
 * What the lane receives once `executeManagedSubagent` has resolved the run's scope. The fields
 * here are the runner's own, never a caller's.
 */
type ResolvedManagedSubagentParams = ManagedSubagentExecutionParams & {
  /** Delegation limits: the stall guard's progress sink, set by the runner around the lane. */
  delegatedProgress?: DelegatedRunProgress
  /** Delegation limits: the record's tool-step limit (decision 3), or null for none. */
  maxToolSteps?: number | null
}

export type ManagedSubagentExecutionResult = {
  output: string
  intermediateSteps: any[]
  subagentType: SubagentType
  usage: DelegatedUsage | null
  modelId: string | null
  provider: string | null
  durationMs: number
  status: DelegatedRunStatus
  /**
   * What the thread actually did this call (DL-111-04). `null` for a worker run, which has
   * no stored thread at all — an honest absence rather than a made-up `'fresh'`.
   */
  thread: SubagentThreadOutcome | null
  /**
   * Present only when something honest needs saying about the thread — today, that the run
   * outlived its own lock so its exchanges were NOT saved rather than overwriting a newer
   * call's thread.
   */
  threadNote?: string
}

/**
 * Delegation limits (Josh, 2026-10-24, decisions 1, 4 and 5) — this runner is the only owner of
 * the time policy. A Subagent or Worker run has NO time limit unless its record sets
 * `timeout_seconds` (10 s to 24 h): it runs until it is done, Stop always ends it, and the stall
 * guard (`DELEGATED_RUN_STALL_MS`) stops one that shows no progress. A built-in Worker's record
 * has no limit fields (its Primary has none to give); a `base` clone carries its Subagent's.
 * `null` means no limit. A saved value outside the range fails the call loudly, never a quiet
 * fallback to "none".
 */
export function resolveManagedDelegationTimeoutMs(
  subject: Pick<SubagentRow, 'timeout_seconds'> | null | undefined,
): number | null {
  const overrideSeconds = normalizeSubagentTimeoutSeconds(subject?.timeout_seconds)
  if (overrideSeconds !== undefined) return overrideSeconds * 1_000
  const validationError = getSubagentTimeoutValidationError(subject?.timeout_seconds)
  if (validationError) throw new Error(validationError)
  return null
}

/**
 * Decision 3: no tool-step limit unless the record sets `max_tool_steps`; at a set limit the run
 * is stopped and returns its work so far, marked `partial`. `null` means no limit.
 */
export function resolveManagedDelegationMaxToolSteps(
  subject: Pick<SubagentRow, 'max_tool_steps'> | null | undefined,
): number | null {
  const steps = normalizeSubagentMaxToolSteps(subject?.max_tool_steps)
  if (steps !== undefined) return steps
  const validationError = getSubagentMaxToolStepsValidationError(subject?.max_tool_steps)
  if (validationError) throw new Error(validationError)
  return null
}

/**
 * The call ended on one of the runner's own limits: the Subagent's set time limit (`deadline`)
 * or the stall guard (`stall`). Both answer `timed_out` with a sentence naming which.
 */
class ManagedSubagentTimeoutError extends Error {
  constructor(
    readonly reason: 'deadline' | 'stall',
    readonly limitMs: number,
  ) {
    super(
      reason === 'stall'
        ? `Managed Subagent call showed no progress for ${formatDelegationDuration(limitMs / 1000)}.`
        : `Managed Subagent call timed out after ${formatDelegationDuration(limitMs / 1000)}.`,
    )
    this.name = 'ManagedSubagentTimeoutError'
  }
}

function isManagedSubagentTimeoutError(error: unknown): error is ManagedSubagentTimeoutError {
  return error instanceof ManagedSubagentTimeoutError
}

/**
 * Run one call under its limits. The work gets one signal that fires on the caller's Stop, the
 * set deadline, or the stall guard, and a progress sink the lane reports its stream to. `stallMs`
 * is null for a lane with no progress signal; `timeoutMs` is null when the Subagent sets no time
 * limit.
 */
async function executeWithManagedSubagentLimits<T>(args: {
  timeoutMs: number | null
  stallMs: number | null
  parentAbortSignal?: AbortSignal
  /**
   * The run lock's `lostSignal`: the lock lapsed (Batshit could not refresh it for a whole TTL)
   * and another call may hold it now, so this one stops rather than share its working folder.
   */
  lockLostSignal?: AbortSignal
  label?: string
  work: (abortSignal: AbortSignal, progress: DelegatedRunProgress) => Promise<T>
}): Promise<T> {
  // A call stopped before its lane started (a Stop, or its Subagent's delete, during the
  // setup or while it queued for the lock) never starts the lane: the lane would still open
  // the thread for a call nobody is waiting for (BL-287).
  if (args.parentAbortSignal?.aborted) {
    throw new SubagentCallCancelledError()
  }
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let rejectCancellation: ((error: Error) => void) | null = null
  const cancellation = new Promise<T>((_, reject) => {
    rejectCancellation = reject
  })
  const abortFromParent = () => {
    controller.abort()
    rejectCancellation?.(new SubagentCallCancelledError())
  }
  const endOnLimit = (error: ManagedSubagentTimeoutError) => {
    rejectCancellation?.(error)
    controller.abort()
  }

  const abortFromLostLock = () => {
    controller.abort()
    rejectCancellation?.(
      new Error(
        `${args.label ?? 'This Subagent call'} lost its turn: Batshit could not keep its run lock alive, so another call to it in this chat may have started. Batshit stopped this call so the two never work in one folder at once, and its thread is not saved over the newer one.`,
      ),
    )
  }

  args.parentAbortSignal?.addEventListener('abort', abortFromParent, {
    once: true,
  })
  if (args.lockLostSignal?.aborted) abortFromLostLock()
  else args.lockLostSignal?.addEventListener('abort', abortFromLostLock, { once: true })

  if (args.timeoutMs !== null) {
    const timeoutMs = args.timeoutMs
    timeout = setTimeout(() => endOnLimit(new ManagedSubagentTimeoutError('deadline', timeoutMs)), timeoutMs)
  }
  const stallMs = args.stallMs
  const watch =
    stallMs !== null
      ? createDelegatedStallWatch({
          stallMs,
          onStall: () => endOnLimit(new ManagedSubagentTimeoutError('stall', stallMs)),
        })
      : null

  try {
    return await Promise.race([args.work(controller.signal, watch ?? UNWATCHED_DELEGATED_RUN), cancellation])
  } finally {
    if (timeout) clearTimeout(timeout)
    watch?.dispose()
    args.parentAbortSignal?.removeEventListener('abort', abortFromParent)
    args.lockLostSignal?.removeEventListener('abort', abortFromLostLock)
  }
}

/**
 * BL-75 — the id whose skill access governs this delegated run's `native_skill`: the same id
 * its `skills_commands` list is built for (the Subagent's record id, a `base` Worker's base id,
 * or a built-in Worker's `worker_…` id). The run's `agentId` cannot stand in for it: it is the
 * PARENT. A record with no id has no list, so the run fails loudly instead of borrowing the
 * parent's skills.
 *
 * The same id judges the run's artifact allowlists in its in-process broker (BL-186), the id
 * its DCM index lists them by.
 */
function requireDelegatedSkillScopeId(subagent: SubagentRow): string {
  const id = typeof subagent.id === 'string' ? subagent.id.trim() : ''
  if (!id) {
    throw new Error('This delegated run has no subagent id, so Batshit cannot decide which skills it may load.')
  }
  return id
}

function delegatedFailureOutput(args: {
  label: string
  status: Extract<DelegatedRunStatus, 'failed' | 'timed_out'>
  error?: unknown
}): string {
  if (args.status === 'timed_out') {
    const limit = isManagedSubagentTimeoutError(args.error) ? args.error : null
    if (limit?.reason === 'stall') {
      return `${args.label} showed no progress for ${formatDelegationDuration(limit.limitMs / 1000)} (no model output, no tool call starting, no tool result), so Batshit stopped it. Time inside a running tool call counts as progress, so this was silence, not a slow tool. Treat this call as stopped; do not infer completion from partial work.`
    }
    const within = limit ? ` within its time limit of ${formatDelegationDuration(limit.limitMs / 1000)}` : ''
    return `${args.label} did not return a complete result${within}. Treat this call as timed out; do not infer completion from partial work.`
  }

  const reason =
    args.error instanceof Error ? args.error.message : String(args.error ?? 'Unknown error')
  return `${args.label} failed: ${reason}`
}

/**
 * Decision 3: what the caller reads when a set tool-step limit stopped the run. The run's own
 * words come after the note, unchanged; the thread keeps only the run's own words. BL-2218: so
 * the resume instruction says to pass back what the tool steps did, since a run cut off before
 * any prose leaves its thread an empty answer.
 */
function partialNextStep(resumable: boolean): string {
  return resumable
    ? 'Its thread keeps your task and its own words, not its tool results, so to continue, call it again with thread "resume" and say what its tool steps (listed with this result) already did and what is left.'
    : 'A Worker cannot be resumed; start a new one with what is left to do.'
}

function partialBody(note: string, output: string, empty = '(It wrote no answer before the limit; its tool steps are listed with this result.)'): string {
  const body = output.trim()
  return body ? `${note}\n\n${body}` : `${note}\n\n${empty}`
}

function stepLimitPartialOutput(args: {
  label: string
  limit: number
  output: string
  resumable: boolean
}): string {
  return partialBody(`[Partial result: ${args.label} reached its limit of ${args.limit} tool step${
    args.limit === 1 ? '' : 's'
  } before it finished, so Batshit stopped it. What follows is its work so far and may be incomplete. ${partialNextStep(args.resumable)}]`, args.output)
}

/**
 * BL-2356: the run's last model call stopped at its output limit, so its last words may be cut off. The
 * same model and settings can be cut at the same point again, so the advice is to continue in smaller parts.
 */
function outputLimitPartialOutput(args: { label: string; output: string; resumable: boolean }): string {
  const next = args.resumable
    ? 'Its thread keeps your task and its own words, so to continue, call it again with thread "resume" and ask it to go on from where it was cut off, or to answer in smaller parts; the same limit applies again.'
    : 'A Worker cannot be resumed; start a new one with what is left, and ask for a shorter answer or smaller parts, since the same limit applies.'
  return partialBody(`[Partial result: ${args.label} stopped at its model's output limit before it finished, so its last words may be cut off. What follows is its work so far and may be incomplete. ${next}]`,
    args.output, '(It reached the limit before it wrote an answer; any tool steps it took are listed with this result.)')
}

/**
 * The brain import stays dynamic to break the `vercelBrain -> nativeTools -> subagentRunner`
 * require cycle, but it is loaded ONCE and shared. SA-111 P4 made that matter: three
 * workers now start at the same instant, and three simultaneous first-time dynamic imports
 * of the same module is work with no benefit.
 */
let vercelBrainModule: Promise<typeof import('./vercelBrain')> | null = null
function loadVercelBrainModule() {
  vercelBrainModule ??= import('./vercelBrain')
  return vercelBrainModule
}

function subagentMemoryKey(sessionId: string, slug: string) {
  return buildSubagentThreadKey(sessionId, slug)
}

function normalizeMemoryEntries(
  value: unknown
): ManagedSubagentMemoryMessage[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null
      const role =
        (entry as Record<string, unknown>).role === 'assistant'
          ? 'assistant'
          : (entry as Record<string, unknown>).role === 'user'
            ? 'user'
            : null
      const content = (entry as Record<string, unknown>).content
      if (!role || typeof content !== 'string' || content.trim().length === 0) {
        return null
      }
      return {
        role,
        content: content.trim(),
      }
    })
    .filter((entry): entry is ManagedSubagentMemoryMessage => entry !== null)
    .slice(-MAX_SUBAGENT_MEMORY_MESSAGES)
}

async function loadSubagentMemory(
  sessionId: string,
  slug: string
): Promise<ManagedSubagentMemoryMessage[]> {
  try {
    const stored = await redis.json.get(subagentMemoryKey(sessionId, slug))
    return normalizeMemoryEntries(stored)
  } catch (error) {
    console.warn('[SubagentRunner] Failed to load subagent memory:', error)
    return []
  }
}

async function persistSubagentMemory(
  sessionId: string,
  slug: string,
  previousMessages: ManagedSubagentMemoryMessage[],
  newMessages: ManagedSubagentMemoryMessage[]
) {
  const nextMessages = [...previousMessages, ...newMessages].slice(
    -MAX_SUBAGENT_MEMORY_MESSAGES
  )

  await redis.json.set(subagentMemoryKey(sessionId, slug), '$', nextMessages)
}

/**
 * SA-111 P2 (DL-111-04): open the thread this call runs under. `fresh` deletes the stored
 * exchanges BEFORE the run, so an interrupted fresh call still leaves a genuinely reset
 * thread rather than a half-old one.
 */
async function openManagedSubagentThread(
  sessionId: string,
  slug: string,
  mode: SubagentThreadMode
): Promise<{ messages: ManagedSubagentMemoryMessage[]; outcome: SubagentThreadOutcome }> {
  if (mode === 'fresh') {
    await resetManagedSubagentThread(sessionId, slug)
    return { messages: [], outcome: 'fresh' }
  }

  const messages = await loadSubagentMemory(sessionId, slug)
  return {
    messages,
    outcome: messages.length > 0 ? 'resumed' : 'resumed-empty',
  }
}

/**
 * A queued call's `durationMs` is measured from inside its lane, AFTER it takes the lock, so
 * it reports the run and not the wait. That is the right number for spend and for comparing
 * runs — but it leaves the wall clock a caller actually experienced unexplained, and a queued
 * call waits as long as the call ahead of it runs (the lock lives while its holder's heartbeat
 * does, `subagentThreads.ts`). So a non-trivial wait is stated outright rather than left for
 * someone to infer from a stopwatch.
 */
const QUEUE_WAIT_NOTE_FLOOR_MS = 1_000

function buildQueueWaitNote(waitedMs: number): string {
  return `This call waited ${Math.round(
    waitedMs / 1000
  )}s for its turn behind another call to the same subagent before it started; the reported duration covers only the run. Batshit runs one call per subagent at a time so their thread stays intact — use Workers for work that should genuinely run in parallel.`
}

function withQueueWaitNote(
  result: ManagedSubagentExecutionResult,
  lock: SubagentRunLockHandle | null
): ManagedSubagentExecutionResult {
  if (!lock || lock.waitedMs < QUEUE_WAIT_NOTE_FLOOR_MS) return result
  const queueNote = buildQueueWaitNote(lock.waitedMs)
  return {
    ...result,
    threadNote: result.threadNote ? `${queueNote} ${result.threadNote}` : queueNote,
  }
}

const THREAD_NOT_SAVED_NOTE =
  'This run outlived its own in-flight lock, so its exchange was NOT saved to the subagent thread — a newer call to the same subagent owns that thread now. A later resume will not include this exchange.'

/**
 * SA-111 P2 (DL-111-05): write the thread only while we still hold the turn. Losing the
 * lock means another call already started on this `(session, subagent)`; persisting anyway
 * would silently erase its exchange, which is the exact race this lock exists to stop.
 */
async function commitManagedSubagentThread(args: {
  sessionId: string
  slug: string
  previousMessages: ManagedSubagentMemoryMessage[]
  newMessages: ManagedSubagentMemoryMessage[]
  lock?: SubagentRunLockHandle | null
}): Promise<string | undefined> {
  if (args.lock && !(await stillHoldsSubagentRunLock(args.lock))) {
    console.warn(
      `[SubagentRunner] Lost the in-flight lock for ${args.slug} during the run; skipping thread persist to avoid overwriting a newer call.`
    )
    return THREAD_NOT_SAVED_NOTE
  }

  await persistSubagentMemory(
    args.sessionId,
    args.slug,
    args.previousMessages,
    args.newMessages
  )
  return undefined
}

/**
 * SA-139 R2/R5 (D14): a Subagent of a removed type (an n8n type, or the CLI Subagent: Claude Code
 * CLI, or Codex CLI before it), or a `base` Worker clone of one. It never runs and never runs as
 * another type; the call answers with this readable refusal before the run registers, takes its
 * lock, opens its thread or writes anything.
 */
export class RetiredSubagentError extends Error {
  readonly code = SUBAGENT_TYPE_RETIRED_CODE

  constructor(refusal: RetiredSubagentRefusal) {
    super(`${refusal.error} ${refusal.details}`)
    this.name = 'RetiredSubagentError'
  }
}

export function isRetiredSubagentError(error: unknown): error is RetiredSubagentError {
  return error instanceof RetiredSubagentError
}

/**
 * BL-2190: a delegated run's base prompt (`batshit:sub_system_prompt`, or `batshit:worker_prompt`
 * for a Worker) cannot be read. The runner answers the call with a `failed` result naming the
 * reason; it never runs the model without its Batshit prompt.
 */
export class DelegatedSystemPromptUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DelegatedSystemPromptUnavailableError'
  }
}

/**
 * BL-2190: the BL-230 rule the Primary prompts follow (`loadPrimarySystemPrompt`), for a delegated
 * run. The raw string (the facade's `redis.get` answers null for ANY error, so a failed read looked
 * like a missing key, and an absent key compiled no base prompt at all); an absent or blank key
 * compiles the packaged default without writing; a failed read, or a packaged default that cannot
 * be read, throws `DelegatedSystemPromptUnavailableError`, outside the compile's catch-all below.
 */
async function loadDelegatedBasePrompt(key: 'batshit:sub_system_prompt' | 'batshit:worker_prompt'): Promise<string> {
  let stored: string | null
  try {
    const value = await redis.execute((client) => client.get(key))
    stored = value === null || value === undefined ? null : String(value)
  } catch (error) {
    throw new DelegatedSystemPromptUnavailableError(
      `SYSTEM_PROMPT_UNAVAILABLE: Batshit could not read ${key}, so this call did not run: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  if (stored?.trim()) return stored
  try {
    return await readPackagedCoreSystemPromptDefault(key)
  } catch (error) {
    throw new DelegatedSystemPromptUnavailableError(
      `SYSTEM_PROMPT_UNAVAILABLE: ${key} is ${stored === null ? 'missing' : 'blank'} and its packaged default could not be read, so this call did not run: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

export async function compileManagedSubagentSystemPrompt(
  subagent: SubagentRow,
  userId: string,
  /**
   * SA-111 P4 (DL-111-10). Present only for a worker run: it swaps the base prompt for
   * `batshit:worker_prompt` and the `SUBAGENT RUNTIME CONTEXT` block for
   * `WORKER RUNTIME CONTEXT`. A `base` clone keeps everything else about its subagent —
   * custom prompt, skills — because that is what "a copy of one of your named specialists"
   * means; only the two pieces that would be FALSE for a throwaway run are replaced.
   */
  worker?: { lane: 'api'; role?: string | null; baseLabel?: string | null }
): Promise<{ systemPrompt: string; description: string }> {
  // BL-2190: read first and outside the catch-all, so a failure stops the call visibly.
  const basePrompt = await loadDelegatedBasePrompt(worker ? 'batshit:worker_prompt' : 'batshit:sub_system_prompt')
  let systemPrompt = worker
    ? `==== BATSHIT WORKER SYSTEM PROMPT ====\n\n${basePrompt}`
    : `==== BATSHIT SUB-AGENT SYSTEM PROMPT ====\n\n${basePrompt}`

  try {

    // DL-111-10: a worker gets no global custom prompt, no clips, and no project files
    // beyond the inherited project path. That holds for a `base` clone too — the clone
    // inherits the specialist, not the user's global identity text.
    if (subagent.include_global_prompt && !worker) {
      try {
        const userSettings = await redis.getUserSettings(userId)
        const globalPrompt = userSettings?.global_custom_system_prompt || ''
        if (globalPrompt) {
          if (systemPrompt) systemPrompt += '\n\n'
          systemPrompt += `==== GLOBAL CUSTOM SYSTEM PROMPT ====\n\n${globalPrompt}`
        }
      } catch (error) {
        console.error('[SubagentRunner] Error loading global prompt:', error)
      }
    }

    if (subagent.system_prompt) {
      if (systemPrompt) systemPrompt += '\n\n'
      systemPrompt += `==== SUBAGENT CUSTOM SYSTEM PROMPT ====\n\n${subagent.system_prompt}`
    }

    const runtimePrompt = worker
      ? buildWorkerRuntimePrompt({
          lane: worker.lane,
          role: worker.role ?? null,
          baseLabel: worker.baseLabel ?? null,
          limits: subagent,
        })
      : buildSubagentRuntimePrompt(subagent)
    if (runtimePrompt.trim()) {
      if (systemPrompt) systemPrompt += '\n\n'
      systemPrompt += runtimePrompt
    }

    // The run's scoped dynamic-info appendix owns its one skills catalog.
    // Registration/description compilation must not read or duplicate it here.
  } catch (error) {
    console.error('[SubagentRunner] Error compiling subagent system prompt:', error)
  }

  return {
    systemPrompt,
    description: subagent.description ?? '',
  }
}

function resolveSubagentModelId(
  subagent: SubagentRow,
  parentModelId?: string | null
): string | null {
  const ownModel = subagent.primary_model_name?.trim() || subagent.model?.trim()
  if (ownModel) return ownModel
  const fallbackModel = parentModelId?.trim()
  return fallbackModel && fallbackModel.length > 0 ? fallbackModel : null
}

/**
 * SA-093 P4: opt-in forensics for a completed managed subagent run. The record
 * fingerprints the subagent's OWN compiled contract and lands on the parent
 * send's Execution Viewer snapshot. Fire-and-forget and never throws — a
 * missing parent message id or snapshot means honest absence, not invention.
 */
function captureManagedSubagentForensics(args: {
  lane: ManagedSubagentForensicsLane
  params: ManagedSubagentExecutionParams
  messages: unknown[]
  usage: unknown
  connectionId: string | null
  modelId: string | null
  runMessageId: string
}): void {
  try {
    if (!isCacheForensicsEnabled()) return
    const parentMessageId = args.params.parentMessageId?.trim()
    if (!parentMessageId) return

    const record = buildManagedSubagentCacheForensicsRecord({
      lane: args.lane,
      messages: args.messages,
      usage: args.usage,
      subagentId: args.params.subagent.id ?? null,
      connectionId: args.connectionId,
      modelId: args.modelId,
      runMessageId: args.runMessageId,
      parentMessageId,
      experimentGroup: resolveCacheForensicsExperimentGroup(),
    })

    void appendSubagentCacheForensicsRecord({
      sessionId: args.params.sessionId,
      parentMessageId,
      record,
    })
  } catch (error) {
    console.error(
      '[SubagentRunner] Cache-forensics capture failed (run unaffected):',
      error instanceof Error ? error.message : error,
    )
  }
}

/** Builds a run's system prompt once its thread outcome is known (null: a Worker, no thread line). */
type SystemPromptForThread = {
  prepareApi?: (apiUtilityScope: ApiUtilityScope) => Promise<void>
  render: (thread: SubagentThreadOutcome | null) => string
}

/**
 * SA-111 P4: open whatever continuity this run is entitled to. A worker plan (`none`)
 * starts empty and reports no thread outcome, because a worker genuinely has no thread —
 * reporting `'fresh'` would claim a stored thread was reset when none existed.
 */
async function openThreadForPlan(
  sessionId: string,
  slug: string,
  plan: ThreadPlan,
): Promise<{ messages: ManagedSubagentMemoryMessage[]; outcome: SubagentThreadOutcome | null }> {
  if (plan.kind === 'none') return { messages: [], outcome: null }
  return openManagedSubagentThread(sessionId, slug, plan.mode)
}

async function runApiSubagent(
  params: ResolvedManagedSubagentParams,
  subagentSlug: string,
  systemPromptFor: SystemPromptForThread,
  plan: ThreadPlan,
): Promise<ManagedSubagentExecutionResult> {
  const startedAt = Date.now()
  // BL-266: the Subagent's own model runs through the connection its preset names, the way a
  // primary's does; no model of its own means the parent's model and the parent's connection.
  // Resolved before the thread opens, so a refusal (an own model saved without a preset) leaves
  // a stored thread exactly as it was and comes back as a failed run the parent can read.
  let selection: ApiSubagentModel
  try {
    selection = await resolveApiSubagentModel({
      subagent: params.subagent,
      parentModelId: params.parentModelId,
      parentConnection: params.parentConnection,
    })
  } catch (error) {
    if (
      !(error instanceof SubagentModelSelectionError) &&
      !(error instanceof RuntimeModelPresetError) &&
      // A model setting the model refuses (anthropicThinkingGuard.ts) is the user's to change.
      !isModelSettingRefusal(error)
    ) {
      throw error
    }
    return {
      output: delegatedFailureOutput({
        label: params.subagent.displayName || subagentSlug,
        status: 'failed',
        error,
      }),
      intermediateSteps: [],
      subagentType: 'api',
      usage: null,
      modelId: resolveSubagentModelId(params.subagent, params.parentModelId),
      provider: (isClaudePlanSelection(params.subagent.primary_model_connection) ? CLAUDE_PLAN_SERVICE : null) || params.subagent.primary_model_provider?.trim() || null,
      durationMs: Math.max(0, Date.now() - startedAt),
      status: 'failed',
      thread: null,
    }
  }
  const modelId = selection.modelId
  const runtimeSettings = selection.runtimeSettings
  let planLease: PlanLease | undefined
  try {
  if (isPlanSelection(selection.connection)) {
    assertPlanSettings(selection.settings)
    const accountId = chatgptPlanAccountId(selection.connection?.id)
    if (!accountId) throw new Error('Choose the connected ChatGPT account again.')
    planLease = getChatgptPlanRuntime().acquire(params.userId, accountId, PLAN_AGENT, params.abortSignal)
  }

  const { VercelAIBrain } = await loadVercelBrainModule()
  const brain = new VercelAIBrain()
  const runMessageId = `subagent-${params.subagent.id}-${randomUUID()}`
  // SA-139: a delegated run on the Claude plan records its own connection, never a paid preset's
  // provider (cost and the Execution Viewer read it).
  const provider = planLease ? 'chatgpt-plan' : isClaudePlanSelection(selection.connection) ? CLAUDE_PLAN_SERVICE : selection.provider
  let response: Awaited<ReturnType<(typeof brain)['processNativeMode']>>
  let messages: Parameters<typeof brain.processNativeMode>[0]['messages'] = []
  let thread: Awaited<ReturnType<typeof openThreadForPlan>> | undefined
  let memory: Awaited<ReturnType<typeof openThreadForPlan>>['messages'] = []
  try {
    const request: Parameters<typeof brain.processNativeMode>[0] = {
      sessionId: params.sessionId,
      messageId: runMessageId,
      userId: params.userId,
      // The PARENT: the identity gate, approvals and the audit keep it (BL-187). The run's own
      // id rides `scopeAgentId` and governs its skills (BL-75) and artifact allowlists (BL-186).
      agentId: params.parentAgentId ?? undefined,
      // Physical commands retire with the actual Subagent; a Worker belongs to its parent.
      // This is separate from agentId's long-standing audit and approval identity.
      processOwner: {
        userId: params.userId,
        kind: params.delegationKind === 'worker' ? 'agent' : 'subagent',
        id: params.delegationKind === 'worker' ? params.parentAgentId! : params.subagent.id,
      },
      // A preset may override provider settings for inference, but never this Subagent's
      // own command grant. The parent supplies project and approval context only.
      delegatedBashEnabled: resolveNativeToolSettings(params.subagent.provider_specific_settings ?? null).bashEnabled,
      // Its materialized explicit typed-file choice remains independent of model preset settings.
      delegatedTypedFileToolsValue: agentTypedFileToolsValue(params.subagent.provider_specific_settings ?? null),
      scopeAgentId: requireDelegatedSkillScopeId(params.subagent),
      model: modelId,
      connection: selection.connection ?? undefined,
      chatgptPlanLease: planLease,
      messages: [],
      toolsEnabled: true,
      // Delegation limits (decisions 2 and 3): the stall guard hears every stream part, and the
      // run has no tool-step limit unless its record sets one (it stopped at 10 rounds before).
      delegatedProgress: params.delegatedProgress,
      delegatedMaxToolSteps: params.maxToolSteps ?? null,
      assignedSubagents: [],
      projectPath: params.projectPath ?? null,
      selectedGateways: params.selectedGateways ?? undefined,
      toolSelections: params.toolSelections ?? undefined,
      selectedCliToolIds: params.selectedCliToolIds ?? undefined,
      dcmDisplaySettings: params.dcmDisplaySettings ?? undefined,
      defaultGateways: params.defaultGateways ?? undefined,
      toolApprovalMode: 'off',
      providerSettings: selection.settings,
      // SA-139 (D11): a Claude plan selection runs as this kind of delegated run. A Subagent's own
      // model always names a preset and an inherited one sends no values, so no raw sampling.
      claudePlanConsumer: params.delegationKind === 'worker' ? 'worker' : 'subagent',
      claudePlanSampling: null,
      // BL-800: the model call is built from these request fields, not from `providerSettings`
      // (that is the tool scope). `runtimeSettings` is the preset's values through the mapper a
      // primary's send uses, so blank is undefined (nothing is sent), zero is real, and a value
      // the model rejects is already out; `processNativeMode` reads them as `send-routed`'s
      // `buildStreamRequest` does.
      temperature: runtimeSettings.standard.temperature,
      maxTokens: runtimeSettings.standard.maxTokens,
      topP: runtimeSettings.standard.topP,
      topK: runtimeSettings.standard.topK,
      presencePenalty: runtimeSettings.standard.presencePenalty,
      frequencyPenalty: runtimeSettings.standard.frequencyPenalty,
      seed: runtimeSettings.standard.seed,
      stopSequences: runtimeSettings.standard.stopSequences,
      providerOptions:
        Object.keys(runtimeSettings.providerOptions).length > 0
          ? runtimeSettings.providerOptions
          : undefined,
      allowArtifactRuntimeTools: true,
      allowFabricControlTools: false,
      // SA-104 P3: memory tools are PA-only in v1 — subagent memory access is a deferred
      // product decision and memory is PA-owned agent-scoped state (see story Out of Scope).
      memoryControlsEnabled: false,
      // SA-113 P2 (DL-113-11): subagents and Workers never see `sys.dm.*`. A DM is
      // addressed to an agent; a delegated run has no inbox and no identity of its own.
      dmControlsEnabled: false,
      // SA-115 P2 (DL-115-10): and never `sys.schedule.*`. A delegated run is over in a
      // moment; it has no business creating something that outlives it and keeps spending.
      scheduleControlsEnabled: false,
      // SA-120 P2 (DL-120-06): and never `sys.judge.ask` — the primary judges for it.
      judgeControlsEnabled: false,
      abortSignal: params.abortSignal,
    }
    request.preparedApiToolset = await brain.prepareApiToolset(request)
    if (!systemPromptFor.prepareApi) throw new Error('The delegated API prompt preparation is unavailable. Nothing was sent.')
    await systemPromptFor.prepareApi(request.preparedApiToolset.apiUtilityScope)
    params.abortSignal?.throwIfAborted()
    if (plan.kind === 'stored' && (!plan.lock || plan.lock.lost || !(await stillHoldsSubagentRunLock(plan.lock)))) {
      throw new SubagentCallCancelledError('The Subagent lost its original thread lock during preparation. Nothing was run.')
    }
    // The ownership read above awaits. The same Stop/limit/lost-lock signal
    // must still admit the mutation immediately before opening a fresh thread.
    params.abortSignal?.throwIfAborted()
    // Admission/index failures leave an existing thread untouched. A genuinely
    // admitted fresh call still resets before running, as it always did.
    thread = await openThreadForPlan(params.sessionId, subagentSlug, plan)
    if (thread.outcome) params.reportThreadOutcome?.(thread.outcome)
    memory = thread.messages
    const systemPrompt = systemPromptFor.render(thread.outcome)
    messages = [
      ...(systemPrompt.trim() ? [{ role: 'system' as const, content: systemPrompt }] : []),
      ...memory.map(entry => ({ role: entry.role, content: entry.content })),
      { role: 'user' as const, content: params.chatInput }
    ]
    request.messages = messages
    response = await brain.processNativeMode(request)
  } catch (error) {
    if (params.abortSignal?.aborted && !isManagedSubagentTimeoutError(error)) throw error
    const status: DelegatedRunStatus = isManagedSubagentTimeoutError(error) ? 'timed_out' : 'failed'
    return {
      output: delegatedFailureOutput({
        label: params.subagent.displayName || subagentSlug,
        status,
        error,
      }),
      intermediateSteps: [],
      subagentType: 'api',
      usage: null,
      modelId,
      provider,
      durationMs: Math.max(0, Date.now() - startedAt),
      status,
      thread: thread?.outcome ?? null,
    }
  }
  if (!thread) throw new Error('The delegated API thread was not prepared.')

  const intermediateSteps = Array.isArray(response.intermediateSteps)
    ? response.intermediateSteps
    : []
  const output = stripLeadingSubagentEchoText(response.content ?? '', intermediateSteps)

  captureManagedSubagentForensics({
    lane: 'api',
    params,
    messages,
    usage: response.usage ?? null,
    connectionId: selection.connection?.id ?? selection.connection?.service ?? null,
    modelId,
    runMessageId,
  })

  const threadNote =
    plan.kind === 'stored'
      ? await commitManagedSubagentThread({
          sessionId: params.sessionId,
          slug: subagentSlug,
          previousMessages: memory,
          newMessages: [
            { role: 'user', content: params.chatInput },
            { role: 'assistant', content: output },
          ],
          lock: plan.lock,
        })
      : undefined

  // Decision 3: a set tool-step limit that stopped the run returns the work so far, marked; so does
  // a last model call cut at its output limit (BL-2356).
  const stepLimit = response.delegatedStepLimitReached
  const outputLimit = !stepLimit && response.delegatedOutputLimitReached === true
  const label = params.subagent.displayName || subagentSlug
  return {
    output: stepLimit
      ? stepLimitPartialOutput({ label, limit: stepLimit.limit, output, resumable: plan.kind === 'stored' })
      : outputLimit ? outputLimitPartialOutput({ label, output, resumable: plan.kind === 'stored' }) : output,
    intermediateSteps,
    subagentType: 'api',
    usage: normalizeUsageLike(response.usage) ?? null,
    modelId,
    provider,
    durationMs: Math.max(0, Date.now() - startedAt),
    status: stepLimit || outputLimit ? 'partial' : 'completed',
    thread: thread.outcome,
    ...(threadNote ? { threadNote } : {}),
  }
  } finally { planLease?.release() }
}

export async function executeManagedSubagent(
  params: ManagedSubagentExecutionParams,
): Promise<ManagedSubagentExecutionResult> {
  // SA-139 R2/R5 (D14): a removed Subagent type never runs, and never runs as another type. The
  // same refusal covers a `base` Worker cloned from one. Nothing of the run has happened yet.
  const retired = retiredSubagentRefusal(params.subagent)
  if (retired) throw new RetiredSubagentError(retired)
  const subagentType: SubagentType = 'api'
  const isWorkerRun = params.delegationKind === 'worker'
  const subagentSlug =
    isWorkerRun && params.delegationSlug?.trim()
      ? params.delegationSlug.trim()
      : resolveSubagentSlug(params.subagent)
  // Decisions 1, 3 and 5: the record's own limits or none. A built-in Worker's record carries
  // none; a `base` clone carries its Subagent's.
  const timeoutMs = resolveManagedDelegationTimeoutMs(params.subagent)
  const maxToolSteps = resolveManagedDelegationMaxToolSteps(params.subagent)
  const label = params.subagent.displayName || subagentSlug

  // BL-287: a Subagent's own run is registered before anything else of it happens, and stays
  // registered until its call is done AND its lane's work has settled, so the Subagent's delete
  // can stop it the way a Stop does and wait for it. A Subagent that is being deleted, or whose
  // record is gone (a turn that loaded it before its delete), does not start. A Worker is never
  // registered: it has no thread or lock, and a built-in Worker has no record at all. A record
  // with no id fails in its lane, loudly (`requireDelegatedSkillScopeId`).
  const registeredSubagentId =
    !isWorkerRun && typeof params.subagent.id === 'string' ? params.subagent.id.trim() : ''
  const runHandle = registeredSubagentId
    ? await beginSubagentRun({ userId: params.userId, subagentId: registeredSubagentId, label })
    : null
  const abortSignal = !runHandle
    ? params.abortSignal
    : params.abortSignal
      ? AbortSignal.any([params.abortSignal, runHandle.signal])
      : runHandle.signal
  try {
    return await runManagedSubagentCall(params, {
      subagentType,
      isWorkerRun,
      subagentSlug,
      timeoutMs,
      maxToolSteps,
      label,
      abortSignal,
      runHandle,
    })
  } catch (error) {
    if (runHandle?.stoppedForDelete()) throw new SubagentDeletedError(label)
    throw error
  } finally {
    runHandle?.end()
  }
}

/** The model and provider a call that failed outside its lane names in its result. */
function resolveFailedRunModel(
  params: ManagedSubagentExecutionParams,
): { modelId: string | null; provider: string | null } {
  const modelId = resolveSubagentModelId(params.subagent, params.parentModelId)
  const provider =
    (isClaudePlanSelection(params.subagent.primary_model_connection) ? CLAUDE_PLAN_SERVICE : null) ||
    params.subagent.primary_model_provider?.trim() ||
    (isClaudePlanSelection(params.parentConnection) ? CLAUDE_PLAN_SERVICE : params.parentConnection?.service?.trim()) ||
    null
  return { modelId, provider }
}

/** The run itself, once `executeManagedSubagent` has registered it (BL-287). */
async function runManagedSubagentCall(
  params: ManagedSubagentExecutionParams,
  run: {
    subagentType: SubagentType
    isWorkerRun: boolean
    subagentSlug: string
    /** The record's time limit, or null for none (decision 1). */
    timeoutMs: number | null
    /** The record's tool-step limit, or null for none (decision 3). */
    maxToolSteps: number | null
    label: string
    /** The caller's stop signal, and for a registered run its delete's too. */
    abortSignal: AbortSignal | undefined
    runHandle: SubagentRunHandle | null
  },
): Promise<ManagedSubagentExecutionResult> {
  const { subagentType, isWorkerRun, subagentSlug, timeoutMs, maxToolSteps, label, abortSignal, runHandle } = run
  const compileStartedAt = Date.now()
  const resolvedScope = await resolveManagedSubagentScope({
    userId: params.userId,
    subagent: params.subagent,
    sessionId: params.sessionId,
    projectPath: params.projectPath ?? null,
  })
  let basePrompt: string
  try {
    ;({ systemPrompt: basePrompt } = await compileManagedSubagentSystemPrompt(
      params.subagent,
      params.userId,
      isWorkerRun
        ? {
            lane: 'api',
            role: params.workerRole ?? null,
            baseLabel: params.workerBaseLabel ?? null,
          }
        : undefined,
    ))
  } catch (error) {
    if (!(error instanceof DelegatedSystemPromptUnavailableError)) throw error
    // BL-2190: no base prompt, no run. The parent reads why, as it reads any failed call;
    // nothing ran, so no lock was taken and the thread is untouched.
    return {
      output: delegatedFailureOutput({ label, status: 'failed', error }),
      intermediateSteps: [],
      subagentType,
      usage: null,
      ...resolveFailedRunModel(params),
      durationMs: Math.max(0, Date.now() - compileStartedAt),
      status: 'failed',
      thread: null,
    }
  }
  // BL-81: the DCM index is built from THIS resolved scope and the lane's own final tool
  // registrations, so the tools the run is shown are exactly the tools it may use.
  const dynamicInfoOptions = {
    userId: params.userId,
    subagent: params.subagent,
    sessionId: params.sessionId,
    projectPath: resolvedScope.projectPath,
    scope: resolvedScope,
  }
  // Prepared by the lane once its registrations are known (`prepareApi`).
  let renderDynamicInfo: ((thread: SubagentThreadOutcome | null) => string) | undefined
  // Decision 11: the `<dynamic_info>` names the call's thread outcome, which the lane knows only
  // once its thread is open, so the lane builds its system prompt from this (a Worker: null).
  const systemPromptFor: SystemPromptForThread = {
    prepareApi: async apiUtilityScope => {
      if (renderDynamicInfo) throw new Error('The delegated API prompt was already prepared.')
      if (!apiUtilityScope) throw new Error('The delegated API utility registrations are unavailable. Nothing was sent.')
      renderDynamicInfo = await prepareManagedSubagentDynamicInfo({ ...dynamicInfoOptions, apiUtilityScope,
        apiAuditAgentId: params.parentAgentId })
    },
    render: thread => {
      if (!renderDynamicInfo) throw new Error('The delegated prompt is unavailable. Nothing was sent.')
      return appendManagedSubagentDynamicInfo(basePrompt, renderDynamicInfo(thread))
    }
  }

  let reportedThreadOutcome: SubagentThreadOutcome | null = null
  const resolvedParams: ResolvedManagedSubagentParams = {
    ...params,
    projectPath: resolvedScope.projectPath,
    selectedGateways: resolvedScope.resolvedGateways,
    toolSelections: resolvedScope.defaultMcpToolSelections ?? undefined,
    selectedCliToolIds: resolvedScope.resolvedCliToolIds,
    defaultGateways: resolvedScope.defaultMcpGateways,
    dcmDisplaySettings: resolvedScope.dcmDisplaySettings,
    reportThreadOutcome: (outcome) => {
      reportedThreadOutcome = outcome
      params.reportThreadOutcome?.(outcome)
    },
  }

  // SA-111 P2 (DL-111-05): one call per `(session, subagent)` at a time. Calls to DIFFERENT
  // subagents stay fully parallel — AI SDK v7 runs a step's tool calls through
  // `Promise.all`, and that concurrency is the point. Two calls to the SAME subagent would
  // both load → run → persist and the last writer would erase the other exchange (F7), so
  // they queue instead.
  //
  // Delegation limits (2026-10-24): a call has no time limit by default, so the lock no longer
  // lives as long as one call may. It lives a short TTL the holder refreshes while it runs (a
  // heartbeat, `subagentThreads.ts`), so a crashed holder frees it within seconds, and a queued
  // call waits while that heartbeat lives, until the user's Stop.
  //
  // SA-111 P4: a worker takes NO lock and NO thread. Workers running at once is the whole
  // point, and two clones of one base share a slug — locking them would serialize exactly the
  // parallelism the feature exists to provide.
  const lock = isWorkerRun
    ? null
    : await acquireSubagentRunLock({
        sessionId: params.sessionId,
        slug: subagentSlug,
        subagentLabel: label,
        abortSignal,
      })
  const threadPlan: ThreadPlan = isWorkerRun
    ? { kind: 'none' }
    : { kind: 'stored', mode: normalizeSubagentThreadMode(params.thread), lock }

  const executionStartedAt = Date.now()
  try {
    const result = await executeWithManagedSubagentLimits({
      timeoutMs,
      // Decision 2: the lane reports its stream to the stall guard.
      stallMs: DELEGATED_RUN_STALL_MS,
      parentAbortSignal: abortSignal,
      lockLostSignal: lock?.lostSignal,
      label,
      work: (laneSignal, progress) => {
        // BL-287: after a Stop (or the delete, or a limit) the call answers at once, but the
        // lane unwinds after that. The run stays registered until the lane is over, within a
        // bound (`subagentRunSettle.ts`).
        const timedParams: ResolvedManagedSubagentParams = {
          ...resolvedParams,
          abortSignal: laneSignal,
          delegatedProgress: progress,
          maxToolSteps,
        }
        const running = runApiSubagent(timedParams, subagentSlug, systemPromptFor, threadPlan)
        if (runHandle) {
          const settlement = settleSubagentRunWork({ work: running, cliProcesses: [], stopSignal: laneSignal, label })
          runHandle.track(settlement.completion, { retry: settlement.retryCleanup })
        }
        return running
      },
    })
    return withQueueWaitNote(result, lock)
  } catch (error) {
    if (!isManagedSubagentTimeoutError(error)) throw error
    const { modelId, provider } = resolveFailedRunModel(params)
    return withQueueWaitNote(
      {
        output: delegatedFailureOutput({
          label,
          status: 'timed_out',
          error,
        }),
        intermediateSteps: [],
        subagentType,
        usage: null,
        modelId,
        provider,
        durationMs: Math.max(0, Date.now() - executionStartedAt),
        status: 'timed_out',
        thread: isWorkerRun
          ? null
          : (reportedThreadOutcome ??
            (normalizeSubagentThreadMode(params.thread) === 'fresh' ? 'fresh' : 'resumed-empty')),
      },
      lock
    )
  } finally {
    await releaseSubagentRunLock(lock)
  }
}
