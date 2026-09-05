import { randomUUID } from 'crypto'
import { env } from '$env/dynamic/private'
import { redis } from '$lib/server/redis'
import type { SubagentRow, MCPToolSelections } from '$lib/types/database'
import type { ToolApprovalMode } from '$lib/types/tool-approvals'
import type { ModelConnectionInfo } from '$lib/types/savedModels'
import type { DelegatedRunStatus, DelegatedUsage } from '$lib/types/delegation'
import { buildCodexRuntimeSettings } from '$lib/server/services/codexSettings'
import { buildClaudeRuntimeSettings } from '$lib/server/services/claudeSettings'
import { CodexBridge } from '$lib/server/services/codexBridge'
import { ClaudeBridge } from '$lib/server/services/claudeBridge'
import {
  buildAgentProfileId,
  prepareManagedCodexSubagentProfile,
} from '$lib/server/services/codexProfileManager'
import { prepareManagedClaudeSubagentProfile } from '$lib/server/services/claudeProfileManager'
import { resolveNativeToolSettings } from '$lib/server/services/nativeTools'
import {
  resolveCliSubagentExecutableModel,
  resolveCliSubagentRuntime,
  type CliSubagentRuntime,
} from '$lib/server/services/cliSubagentModelResolution'
import {
  buildSkillsCommandsDcmLines,
  getEnabledAgentSlashCapabilities,
} from '$lib/server/services/slashCommandCapabilities'
import {
  getSubagentTypeDisplayLabel,
  isApiSubagentType,
  isCliSubagentType,
  isWorkflowBackedSubagentType,
  normalizeSubagentType,
  type SubagentType,
} from '$lib/utils/subagentType'
import {
  buildSubagentRuntimePrompt,
  buildWorkerRuntimePrompt,
} from '$lib/utils/subagentRuntimePrompt'
import {
  buildCliSubagentRuntimeId,
  resolveSubagentSlug
} from '$lib/utils/subagentSlug'
import { stripLeadingSubagentEchoText } from '$lib/server/services/finalAssistantTextSanitizer'
import { callWorkflow } from '$lib/server/services/workflowExecutor'
import { apiKeyService } from '$lib/services/apiKey.server'
import {
  resolveRuntimeN8nBaseUrl,
  rewriteBatshitCallbackUrlsForN8nRuntime,
  rewriteN8nWebhookUrlForRuntime,
} from '$lib/server/services/runtimeUrlRewrites'
import { createN8nSseCallbackToken } from '$lib/server/services/n8nCallbackTokens'
import {
  appendManagedSubagentDynamicInfo,
  buildManagedSubagentDynamicInfo,
  resolveManagedSubagentScope,
} from '$lib/server/services/subagentRuntimeScope'
import {
  acquireSubagentRunLock,
  buildSubagentThreadKey,
  normalizeSubagentThreadMode,
  releaseSubagentRunLock,
  resetManagedSubagentThread,
  resolveSubagentLockTtlMs,
  resolveSubagentLockWaitMs,
  selectN8nSubagentThreadId,
  stillHoldsSubagentRunLock,
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
  getSubagentTimeoutValidationError,
  normalizeSubagentTimeoutSeconds,
} from '$lib/utils/subagentTimeout'

const MAX_SUBAGENT_MEMORY_MESSAGES = 24

export const DEFAULT_API_SUBAGENT_TIMEOUT_MS = 180_000
export const DEFAULT_N8N_SUBAGENT_TIMEOUT_MS = 180_000
export const DEFAULT_CLI_SUBAGENT_TIMEOUT_MS = 300_000
export const DEFAULT_WORKER_TIMEOUT_MS = 180_000

export type ManagedDelegationType = SubagentType | 'worker'

/**
 * SA-111 P4 (DL-111-09): which KIND of delegated run this is. A worker reuses the same
 * runner, timeout policy, and result shape as a subagent, but it is ephemeral: no stored
 * thread, no serialize lock, and its own runtime prompt.
 */
export type ManagedDelegationKind = 'subagent' | 'worker'

/**
 * How this run treats continuity. `stored` is the SA-111 P2 subagent contract (open the
 * `(session, slug)` thread, persist it while the run still holds its lock). `none` is the
 * worker contract: parallel is the point and a worker has no thread, so it must never
 * touch `subagent_sessions:`, `subagent_thread:`, or the lock.
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
   * SA-111 P4 (DL-111-09/10). `'worker'` runs the same lanes with the worker contract:
   * the `WORKER RUNTIME CONTEXT` prompt, no stored thread, and no serialize lock. Default
   * `'subagent'` — a caller that says nothing gets the existing behaviour exactly.
   */
  delegationKind?: ManagedDelegationKind
  /** Worker-only: the caller's optional role label, shown in the worker's runtime prompt. */
  workerRole?: string | null
  /** Worker-only: the display name of the subagent this worker is a throwaway clone of. */
  workerBaseLabel?: string | null
  /**
   * Worker-only: the slug this run uses for its CLI runtime profile. Workers need their
   * own slot because managed profile files are written non-atomically — three concurrent
   * workers sharing one profile path could read a half-written config. It never reaches a
   * thread or lock key, because a worker has neither.
   */
  delegationSlug?: string
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

export function resolveManagedDelegationTimeoutMs(
  subject: Pick<SubagentRow, 'timeout_seconds'> | null | undefined,
  type: ManagedDelegationType,
): number {
  const overrideSeconds = normalizeSubagentTimeoutSeconds(subject?.timeout_seconds)
  if (overrideSeconds !== undefined) return overrideSeconds * 1_000
  const validationError = getSubagentTimeoutValidationError(subject?.timeout_seconds)
  if (validationError) throw new Error(validationError)

  if (type === 'cli') return DEFAULT_CLI_SUBAGENT_TIMEOUT_MS
  if (type === 'n8n-workflow') return DEFAULT_N8N_SUBAGENT_TIMEOUT_MS
  if (type === 'worker') return DEFAULT_WORKER_TIMEOUT_MS
  return DEFAULT_API_SUBAGENT_TIMEOUT_MS
}

class ManagedSubagentTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Managed Subagent call timed out after ${Math.round(timeoutMs / 1000)} seconds.`)
    this.name = 'ManagedSubagentTimeoutError'
  }
}

function isManagedSubagentTimeoutError(error: unknown): error is ManagedSubagentTimeoutError {
  return error instanceof ManagedSubagentTimeoutError
}

async function executeWithManagedSubagentTimeout<T>(args: {
  timeoutMs: number
  parentAbortSignal?: AbortSignal
  work: (abortSignal: AbortSignal) => Promise<T>
}): Promise<T> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let rejectCancellation: ((error: Error) => void) | null = null
  const cancellation = new Promise<T>((_, reject) => {
    rejectCancellation = reject
  })
  const abortFromParent = () => {
    controller.abort()
    rejectCancellation?.(new Error('Managed Subagent call was cancelled.'))
  }

  if (args.parentAbortSignal?.aborted) {
    abortFromParent()
  } else {
    args.parentAbortSignal?.addEventListener('abort', abortFromParent, {
      once: true,
    })
  }

  timeout = setTimeout(() => {
    rejectCancellation?.(new ManagedSubagentTimeoutError(args.timeoutMs))
    controller.abort()
  }, args.timeoutMs)

  try {
    return await Promise.race([args.work(controller.signal), cancellation])
  } finally {
    if (timeout) clearTimeout(timeout)
    args.parentAbortSignal?.removeEventListener('abort', abortFromParent)
  }
}

function delegatedFailureOutput(args: {
  label: string
  status: Extract<DelegatedRunStatus, 'failed' | 'timed_out'>
  timeoutMs: number
  error?: unknown
}): string {
  if (args.status === 'timed_out') {
    return `${args.label} did not return a complete result within ${Math.round(args.timeoutMs / 1000)} seconds. Treat this call as timed out; do not infer completion from partial work.`
  }

  const reason =
    args.error instanceof Error ? args.error.message : String(args.error ?? 'Unknown error')
  return `${args.label} failed: ${reason}`
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

function unwrapWorkflowSubagentResponseData(value: unknown): unknown {
  if (Array.isArray(value) && value.length === 1) return value[0]
  return value
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
 * runs — but it leaves the wall clock a caller actually experienced unexplained, and a
 * queued call can legitimately take up to twice its Call Timeout (see
 * `resolveSubagentLockWaitMs`). So a non-trivial wait is stated outright rather than left
 * for someone to infer from a stopwatch.
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
  worker?: { lane: 'api' | 'cli'; role?: string | null; baseLabel?: string | null }
): Promise<{ systemPrompt: string; description: string }> {
  let systemPrompt = ''

  try {
    const basePrompt = await redis.get(worker ? 'batshit:worker_prompt' : 'batshit:sub_system_prompt')
    if (basePrompt) {
      systemPrompt = worker
        ? `==== BATSHIT WORKER SYSTEM PROMPT ====\n\n${basePrompt}`
        : `==== BATSHIT SUB-AGENT SYSTEM PROMPT ====\n\n${basePrompt}`
    }

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
        })
      : buildSubagentRuntimePrompt(subagent)
    if (runtimePrompt.trim()) {
      if (systemPrompt) systemPrompt += '\n\n'
      systemPrompt += runtimePrompt
    }

    const subagentId =
      typeof subagent.id === 'string' && subagent.id.trim().length > 0
        ? subagent.id.trim()
        : ''
    if (subagentId && userId) {
      const skillsCommandsLines = buildSkillsCommandsDcmLines(
        await getEnabledAgentSlashCapabilities(userId, subagentId)
      )
      const hasSubagentSkillsCommands = skillsCommandsLines.some((line) =>
        line.startsWith('- /')
      )
      if (hasSubagentSkillsCommands) {
        if (systemPrompt) systemPrompt += '\n\n'
        systemPrompt +=
          `==== SKILLS & PROMPTS (AGENT ACCESS) ====\n\n${skillsCommandsLines.join('\n')}`
      }
    }
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

function resolveBatshitCallbackBaseForN8nWorkflow(): string | null {
  const runtimeEnv = env as Partial<Record<string, string | undefined>>
  return (
    runtimeEnv.BATSHIT_N8N_CALLBACK_BASE_URL?.trim() ||
    runtimeEnv.BATSHIT_FRONTEND_URL?.trim() ||
    runtimeEnv.PUBLIC_BASE_URL?.trim() ||
    runtimeEnv.ORIGIN?.trim() ||
    null
  )
}

function joinCallbackPath(base: string, pathname: string): string {
  try {
    const url = new URL(base)
    url.pathname = pathname
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return `${base.replace(/\/+$/, '')}${pathname}`
  }
}

function cloneProviderSettings(value: Record<string, any> | null | undefined): Record<string, any> {
  if (!value || typeof value !== 'object') {
    return {}
  }
  return structuredClone(value)
}

function buildCliSubagentProviderSettings(
  subagent: SubagentRow,
): Record<string, any> {
  const base = cloneProviderSettings(subagent.provider_specific_settings ?? null)
  const nativeTools =
    base.nativeTools && typeof base.nativeTools === 'object'
      ? { ...base.nativeTools }
      : base.batshitNativeTools && typeof base.batshitNativeTools === 'object'
        ? { ...base.batshitNativeTools }
        : {}

  nativeTools.fetchZipEnabled = false
  nativeTools.batshitToolsEnabled = false

  base.nativeTools = nativeTools
  delete base.batshitNativeTools

  return base
}

function shouldSkipCliSubagentToolResult(toolName?: string | null, dynamic?: boolean): boolean {
  if (dynamic) return true
  const normalized = toolName?.trim().toLowerCase() ?? ''
  return normalized === 'codex_plan_update'
}

async function collectCliSubagentStreamResult(
  streamResult:
    | Awaited<ReturnType<CodexBridge['streamNativeMode']>>
    | Awaited<ReturnType<ClaudeBridge['streamNativeMode']>>,
): Promise<{ output: string; intermediateSteps: any[]; usage: unknown }> {
  const outputChunks: string[] = []
  const intermediateSteps: any[] = []
  let usage: unknown = null
  const detectToolSource =
    typeof (streamResult as any).__detectToolSource === 'function'
      ? (streamResult as any).__detectToolSource
      : () => ({})

  for await (const chunk of (streamResult as any).stream as AsyncIterable<any>) {
    if (!chunk || typeof chunk !== 'object') continue

    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      outputChunks.push(chunk.text)
      continue
    }

    if (chunk.type === 'finish') {
      usage = chunk.totalUsage ?? chunk.usage ?? usage
      continue
    }

    if (chunk.type !== 'tool-result') continue
    if (shouldSkipCliSubagentToolResult(chunk.toolName, chunk.dynamic === true)) {
      continue
    }

    const toolName =
      typeof chunk.toolName === 'string' && chunk.toolName.trim().length > 0
        ? chunk.toolName
        : 'unknown_tool'
    const toolMetadata = detectToolSource(toolName) ?? {}
    intermediateSteps.push({
      toolName,
      toolInput: chunk.args ?? chunk.input ?? {},
      toolOutput: chunk.result ?? chunk.output ?? chunk.data ?? chunk.content ?? null,
      timestamp: Date.now(),
      ...toolMetadata,
      ...(chunk.metadata ?? {}),
    })
  }

  return {
    output: outputChunks.join(''),
    intermediateSteps,
    usage,
  }
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

async function runWorkflowBackedSubagent(
  params: ManagedSubagentExecutionParams,
  subagentType: SubagentType,
  subagentSlug: string,
  systemPrompt: string,
  timeoutMs: number,
): Promise<ManagedSubagentExecutionResult> {
  const startedAt = Date.now()
  const modelId = resolveSubagentModelId(params.subagent, params.parentModelId)
  const provider = params.subagent.primary_model_provider?.trim() || null
  const webhookUrl =
    params.subagent.webhookUrl || params.subagent.webhook_url || params.subagent.workflowName

  if (!webhookUrl) {
    throw new Error(
      `${getSubagentTypeDisplayLabel(subagentType)} is missing a Production Webhook URL.`,
    )
  }

  // SA-111 P2 (DL-111-06): n8n owns the conversation, so the only lever Batshit has is the
  // key. Batshit issues the thread id, the official templates append it to their Redis
  // Chat Memory session key, and `fresh` orphans the previous list to its own sessionTTL.
  const threadSelection = await selectN8nSubagentThreadId({
    sessionId: params.sessionId,
    slug: subagentSlug,
    mode: normalizeSubagentThreadMode(params.thread),
  })
  params.reportThreadOutcome?.(threadSelection.outcome)

  const normalizedParentAgentId = params.parentAgentId ?? null
  let savedN8nApiUrl: string | null = null
  try {
    savedN8nApiUrl = await apiKeyService.retrieve('n8n_api_url', params.userId)
  } catch (error) {
    console.warn('[SubagentRunner] Failed to load n8n API URL for workflow subagent:', error)
  }
  const routedWebhookUrl = rewriteN8nWebhookUrlForRuntime(webhookUrl, savedN8nApiUrl) ?? webhookUrl
  const messageId = `subagent_${randomUUID()}`
  const runtimeN8nBaseUrl = resolveRuntimeN8nBaseUrl(savedN8nApiUrl)
  const callbackBase = resolveBatshitCallbackBaseForN8nWorkflow()
  const callback = await createN8nSseCallbackToken({
    sessionId: params.sessionId,
    messageId,
    userId: params.userId,
    agentId: normalizedParentAgentId,
  })
  const workflowPayload = rewriteBatshitCallbackUrlsForN8nRuntime(
    {
      chatInput: params.chatInput,
      user_id: params.userId,
      userId: params.userId,
      session_id: params.sessionId,
      sessionId: params.sessionId,
      message_id: messageId,
      messageId,
      agent_id: normalizedParentAgentId,
      agentId: normalizedParentAgentId,
      parent_agent_id: normalizedParentAgentId,
      parentAgentId: normalizedParentAgentId,
      primary_agent_id: normalizedParentAgentId,
      primaryAgentId: normalizedParentAgentId,
      project_path: params.projectPath ?? null,
      projectPath: params.projectPath ?? null,
      subagent_id: params.subagent.id,
      subagentId: params.subagent.id,
      subagent_slug: subagentSlug,
      subagent_thread_id: threadSelection.threadId,
      subagentThreadId: threadSelection.threadId,
      subagentPrompts: {
        [subagentSlug]: systemPrompt,
      },
      subagentModel: {
        provider: params.subagent.primary_model_provider ?? null,
        model: params.subagent.primary_model_name ?? params.parentModelId ?? null,
      },
      ...(callbackBase
        ? {
            batshit_frontend_url: joinCallbackPath(callbackBase, ''),
            batshitFrontendUrl: joinCallbackPath(callbackBase, ''),
            batshit_sse_endpoint: joinCallbackPath(callbackBase, '/api/sse'),
            batshitSseEndpoint: joinCallbackPath(callbackBase, '/api/sse'),
            batshit_artifact_complete_url: joinCallbackPath(
              callbackBase,
              '/api/artifacts/complete',
            ),
            batshitArtifactCompleteUrl: joinCallbackPath(callbackBase, '/api/artifacts/complete'),
          }
        : {}),
      batshit_native_tool_token: callback.token,
      batshitNativeToolToken: callback.token,
      batshit_native_tool_header: 'x-batshit-native-tool-token',
      batshitNativeToolHeader: 'x-batshit-native-tool-token',
      batshit_sse_callback_token: callback.token,
      batshitSseCallbackToken: callback.token,
      batshit_sse_callback_header: 'x-batshit-callback-token',
      batshitSseCallbackHeader: 'x-batshit-callback-token',
      batshit_sse_callback_expires_at: callback.expiresAt,
      batshitSseCallbackExpiresAt: callback.expiresAt,
      source: 'batshit-subagent-runner',
    },
    runtimeN8nBaseUrl,
  )

  const result = await callWorkflow(
    {
      id: params.subagent.id,
      name: subagentSlug,
      active: true,
      webhookUrl: routedWebhookUrl,
    },
    workflowPayload,
    {
      sessionId: params.sessionId,
      userId: params.userId,
      timeout: timeoutMs,
      async: false,
      abortSignal: params.abortSignal,
    },
  )

  const responseData = unwrapWorkflowSubagentResponseData(result.data)
  const responseRecord =
    responseData && typeof responseData === 'object' && !Array.isArray(responseData)
      ? (responseData as Record<string, any>)
      : null

  if (!result.success) {
    const status: DelegatedRunStatus = result.timeout ? 'timed_out' : 'failed'
    return {
      output: delegatedFailureOutput({
        label: params.subagent.displayName || subagentSlug,
        status,
        timeoutMs,
        error: result.error || 'Subagent execution failed',
      }),
      intermediateSteps: [],
      subagentType,
      usage: normalizeUsageLike(responseRecord?.usage) ?? null,
      modelId,
      provider,
      durationMs: Math.max(0, Date.now() - startedAt),
      status,
      thread: threadSelection.outcome,
    }
  }

  const output =
    typeof responseRecord?.output === 'string'
      ? responseRecord.output
      : typeof responseData === 'string'
        ? responseData
        : JSON.stringify(responseData ?? {}, null, 2)

  return {
    output,
    intermediateSteps: Array.isArray(responseRecord?.intermediateSteps)
      ? responseRecord.intermediateSteps
      : [],
    subagentType,
    usage: normalizeUsageLike(responseRecord?.usage) ?? null,
    modelId,
    provider,
    durationMs: Math.max(0, Date.now() - startedAt),
    status: 'completed',
    thread: threadSelection.outcome,
  }
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
  params: ManagedSubagentExecutionParams,
  subagentSlug: string,
  systemPrompt: string,
  plan: ThreadPlan,
  timeoutMs: number,
): Promise<ManagedSubagentExecutionResult> {
  const startedAt = Date.now()
  const modelId = resolveSubagentModelId(params.subagent, params.parentModelId)
  if (!modelId) {
    throw new Error('API Subagent needs a model selection or a parent model to inherit.')
  }

  const thread = await openThreadForPlan(params.sessionId, subagentSlug, plan)
  if (thread.outcome) params.reportThreadOutcome?.(thread.outcome)
  const memory = thread.messages
  const messages = [
    ...(systemPrompt.trim().length > 0 ? [{ role: 'system' as const, content: systemPrompt }] : []),
    ...memory.map((entry) => ({
      role: entry.role,
      content: entry.content,
    })),
    { role: 'user' as const, content: params.chatInput },
  ]

  const { VercelAIBrain } = await loadVercelBrainModule()
  const brain = new VercelAIBrain()
  const runMessageId = `subagent-${params.subagent.id}-${randomUUID()}`
  const provider =
    params.subagent.primary_model_provider?.trim() ||
    params.parentConnection?.service?.trim() ||
    null
  let response: Awaited<ReturnType<(typeof brain)['processNativeMode']>>
  try {
    response = await brain.processNativeMode({
      sessionId: params.sessionId,
      messageId: runMessageId,
      userId: params.userId,
      agentId: params.parentAgentId ?? undefined,
      model: modelId,
      connection: params.subagent.primary_model_name?.trim()
        ? undefined
        : (params.parentConnection ?? undefined),
      messages,
      toolsEnabled: true,
      maxToolRounds: 10,
      assignedSubagents: [],
      projectPath: params.projectPath ?? null,
      selectedGateways: params.selectedGateways ?? undefined,
      toolSelections: params.toolSelections ?? undefined,
      selectedCliToolIds: params.selectedCliToolIds ?? undefined,
      dcmDisplaySettings: params.dcmDisplaySettings ?? undefined,
      defaultGateways: params.defaultGateways ?? undefined,
      toolApprovalMode: 'off',
      providerSettings: params.subagent.provider_specific_settings ?? null,
      allowArtifactRuntimeTools: true,
      allowFabricControlTools: false,
      // SA-104 P3: memory tools are PA-only in v1 — subagent memory access is a deferred
      // product decision and memory is PA-owned agent-scoped state (see story Out of Scope).
      memoryControlsEnabled: false,
      abortSignal: params.abortSignal,
    })
  } catch (error) {
    if (params.abortSignal?.aborted && !isManagedSubagentTimeoutError(error)) throw error
    const status: DelegatedRunStatus = isManagedSubagentTimeoutError(error) ? 'timed_out' : 'failed'
    return {
      output: delegatedFailureOutput({
        label: params.subagent.displayName || subagentSlug,
        status,
        timeoutMs,
        error,
      }),
      intermediateSteps: [],
      subagentType: 'api',
      usage: null,
      modelId,
      provider,
      durationMs: Math.max(0, Date.now() - startedAt),
      status,
      thread: thread.outcome,
    }
  }

  const intermediateSteps = Array.isArray(response.intermediateSteps)
    ? response.intermediateSteps
    : []
  const output = stripLeadingSubagentEchoText(response.content ?? '', intermediateSteps)

  captureManagedSubagentForensics({
    lane: 'api',
    params,
    messages,
    usage: response.usage ?? null,
    connectionId: params.subagent.primary_model_name?.trim()
      ? null
      : (params.parentConnection?.id ?? params.parentConnection?.service ?? null),
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

  return {
    output,
    intermediateSteps,
    subagentType: 'api',
    usage: normalizeUsageLike(response.usage) ?? null,
    modelId,
    provider,
    durationMs: Math.max(0, Date.now() - startedAt),
    status: 'completed',
    thread: thread.outcome,
    ...(threadNote ? { threadNote } : {}),
  }
}

async function runCliSubagent(
  params: ManagedSubagentExecutionParams,
  subagentSlug: string,
  systemPrompt: string,
  plan: ThreadPlan,
  timeoutMs: number,
): Promise<ManagedSubagentExecutionResult> {
  const startedAt = Date.now()
  const runtime = resolveCliSubagentRuntime(params.subagent)
  if (!runtime) {
    throw new Error('CLI Subagent model must point to either Codex CLI or Claude CLI.')
  }

  const modelId = resolveCliSubagentExecutableModel(params.subagent, runtime)
  if (!modelId) {
    throw new Error(
      'CLI Subagent needs a real Codex or Claude model in its native CLI defaults. The Saved Model picker only chooses the Codex/Claude lane.',
    )
  }

  const runtimeProviderSettings = buildCliSubagentProviderSettings(params.subagent)
  const nativeSettings = resolveNativeToolSettings(runtimeProviderSettings)
  const thread = await openThreadForPlan(params.sessionId, subagentSlug, plan)
  if (thread.outcome) params.reportThreadOutcome?.(thread.outcome)
  const memory = thread.messages
  const messages = [
    ...(systemPrompt.trim().length > 0 ? [{ role: 'system' as const, content: systemPrompt }] : []),
    ...memory.map((entry) => ({
      role: entry.role,
      content: entry.content,
    })),
    { role: 'user' as const, content: params.chatInput },
  ]

  const runtimeId = buildCliSubagentRuntimeId(subagentSlug)
  const profileId = buildAgentProfileId(runtimeId)
  const profileLabel = `${params.subagent.displayName || subagentSlug} ${
    params.delegationKind === 'worker' ? 'CLI Worker' : 'CLI Subagent'
  }`

  let output = ''
  let intermediateSteps: any[] = []
  let collectedUsage: unknown = null
  const runMessageId = `subagent-${params.subagent.id}-${randomUUID()}`
  const provider = params.subagent.primary_model_provider?.trim() || runtime

  try {
    if (runtime === 'codex') {
      const codexSettings = buildCodexRuntimeSettings(
        params.subagent.codex_settings ?? runtimeProviderSettings,
      )
      codexSettings.profileId = profileId
      codexSettings.model = modelId
      codexSettings.historyPersistence = 'none'
      codexSettings.includeProjectInstructions = true

      const profile = await prepareManagedCodexSubagentProfile({
        userId: params.userId,
        profileId,
        runtimeId,
        label: profileLabel,
        displayName: params.subagent.displayName || subagentSlug,
        slug: subagentSlug,
        providerSettings: runtimeProviderSettings,
        defaultMCPGateways: params.defaultGateways ?? null,
        defaultMCPToolSelections: params.toolSelections ?? null,
        defaultCliToolIds: params.selectedCliToolIds ?? null,
        workingDirectory: params.projectPath ?? null,
        runtimeSettings: codexSettings,
      })

      const bridge = new CodexBridge()
      const result = await bridge.streamNativeMode({
        sessionId: params.sessionId,
        messageId: runMessageId,
        userId: params.userId,
        agentId: runtimeId,
        agentSlug: subagentSlug,
        model: modelId,
        messages,
        toolsEnabled: true,
        selectedGateways: profile.resolvedGateways,
        toolSelections: params.toolSelections ?? undefined,
        selectedCliToolIds: params.selectedCliToolIds ?? undefined,
        defaultGateways: params.defaultGateways ?? undefined,
        gatewayToolMap: profile.gatewayToolMap,
        assignedSubagents: [],
        projectPath: params.projectPath ?? null,
        providerSettings: runtimeProviderSettings,
        codexSettings,
        abortSignal: params.abortSignal,
      })
      const collected = await collectCliSubagentStreamResult(result)
      output = stripLeadingSubagentEchoText(collected.output, collected.intermediateSteps)
      intermediateSteps = collected.intermediateSteps
      collectedUsage = collected.usage
    } else {
      const claudeSettings = buildClaudeRuntimeSettings(
        params.subagent.claude_settings ?? runtimeProviderSettings,
      )
      claudeSettings.profileId = profileId
      claudeSettings.model = modelId
      claudeSettings.includeProjectInstructions = true

      const profile = await prepareManagedClaudeSubagentProfile({
        userId: params.userId,
        profileId,
        runtimeId,
        label: profileLabel,
        displayName: params.subagent.displayName || subagentSlug,
        slug: subagentSlug,
        providerSettings: runtimeProviderSettings,
        defaultMCPGateways: params.defaultGateways ?? null,
        defaultMCPToolSelections: params.toolSelections ?? null,
        defaultCliToolIds: params.selectedCliToolIds ?? null,
        runtimeSettings: claudeSettings,
      })

      const bridge = new ClaudeBridge()
      const result = await bridge.streamNativeMode({
        sessionId: params.sessionId,
        messageId: runMessageId,
        userId: params.userId,
        agentId: runtimeId,
        agentSlug: subagentSlug,
        model: modelId,
        messages,
        toolsEnabled: true,
        selectedGateways: profile.resolvedGateways,
        toolSelections: params.toolSelections ?? undefined,
        selectedCliToolIds: params.selectedCliToolIds ?? undefined,
        defaultGateways: params.defaultGateways ?? undefined,
        gatewayToolMap: profile.gatewayToolMap,
        assignedSubagents: [],
        projectPath: params.projectPath ?? null,
        providerSettings: runtimeProviderSettings,
        claudeSettings,
        abortSignal: params.abortSignal,
      })
      const collected = await collectCliSubagentStreamResult(result)
      output = stripLeadingSubagentEchoText(collected.output, collected.intermediateSteps)
      intermediateSteps = collected.intermediateSteps
      collectedUsage = collected.usage
    }
  } catch (error) {
    if (params.abortSignal?.aborted && !isManagedSubagentTimeoutError(error)) throw error
    const status: DelegatedRunStatus = isManagedSubagentTimeoutError(error) ? 'timed_out' : 'failed'
    return {
      output: delegatedFailureOutput({
        label: params.subagent.displayName || subagentSlug,
        status,
        timeoutMs,
        error,
      }),
      intermediateSteps: [],
      subagentType: 'cli',
      usage: null,
      modelId,
      provider,
      durationMs: Math.max(0, Date.now() - startedAt),
      status,
      thread: thread.outcome,
    }
  }

  captureManagedSubagentForensics({
    lane: runtime,
    params,
    messages,
    usage: collectedUsage,
    connectionId: null,
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

  return {
    output,
    intermediateSteps,
    subagentType: 'cli',
    usage: normalizeUsageLike(collectedUsage) ?? null,
    modelId,
    provider,
    durationMs: Math.max(0, Date.now() - startedAt),
    status: 'completed',
    thread: thread.outcome,
    ...(threadNote ? { threadNote } : {}),
  }
}

export async function executeManagedSubagent(
  params: ManagedSubagentExecutionParams,
): Promise<ManagedSubagentExecutionResult> {
  const storedSubagentType = normalizeSubagentType(params.subagent, params.subagent.subagentType)
  if (storedSubagentType === 'n8n-subnode') {
    throw new Error(
      `${getSubagentTypeDisplayLabel(storedSubagentType)} does not run through the managed subagent runner.`,
    )
  }
  const subagentType: SubagentType = storedSubagentType
  const isWorkerRun = params.delegationKind === 'worker'
  if (isWorkerRun && isWorkflowBackedSubagentType(subagentType)) {
    // DL-111-10: a worker follows the parent's runtime family (API or CLI). An n8n
    // workflow is someone else's runtime with its own memory; there is no throwaway copy
    // of it to make, so refuse rather than invent one.
    throw new Error('A Worker cannot run on the n8n Workflow lane. Clone an API or CLI Subagent instead.')
  }
  const subagentSlug =
    isWorkerRun && params.delegationSlug?.trim()
      ? params.delegationSlug.trim()
      : resolveSubagentSlug(params.subagent)
  const timeoutMs = resolveManagedDelegationTimeoutMs(
    params.subagent,
    isWorkerRun ? 'worker' : subagentType,
  )
  const resolvedScope = await resolveManagedSubagentScope({
    userId: params.userId,
    subagent: params.subagent,
    sessionId: params.sessionId,
    projectPath: params.projectPath ?? null,
  })
  let { systemPrompt } = await compileManagedSubagentSystemPrompt(
    params.subagent,
    params.userId,
    isWorkerRun
      ? {
          lane: isCliSubagentType(subagentType) ? 'cli' : 'api',
          role: params.workerRole ?? null,
          baseLabel: params.workerBaseLabel ?? null,
        }
      : undefined,
  )
  const dynamicInfo = await buildManagedSubagentDynamicInfo({
    userId: params.userId,
    subagent: params.subagent,
    sessionId: params.sessionId,
    projectPath: resolvedScope.projectPath,
  })
  systemPrompt = appendManagedSubagentDynamicInfo(systemPrompt, dynamicInfo)

  let reportedThreadOutcome: SubagentThreadOutcome | null = null
  const resolvedParams: ManagedSubagentExecutionParams = {
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
  // they queue instead. `acquireSubagentRunLock` throws `SubagentBusyError` when the turn
  // never comes; both lanes turn that into a result the model can read.
  //
  // SA-111 P4: a worker takes NO lock and NO thread. Three workers running at once is the
  // whole point, and two clones of one base share a slug — locking them would serialize
  // exactly the parallelism the feature exists to provide.
  const lock = isWorkerRun
    ? null
    : await acquireSubagentRunLock({
        sessionId: params.sessionId,
        slug: subagentSlug,
        subagentLabel: params.subagent.displayName || subagentSlug,
        ttlMs: resolveSubagentLockTtlMs(timeoutMs),
        // How long a lock LIVES and how long other calls QUEUE for it are separate
        // decisions; see `resolveSubagentLockWaitMs` for why the queue budget is a full
        // holder lifetime and what that costs in wall clock.
        waitBudgetMs: resolveSubagentLockWaitMs(timeoutMs),
        abortSignal: params.abortSignal,
      })
  const threadPlan: ThreadPlan = isWorkerRun
    ? { kind: 'none' }
    : { kind: 'stored', mode: normalizeSubagentThreadMode(params.thread), lock }

  const executionStartedAt = Date.now()
  try {
    const result = await executeWithManagedSubagentTimeout({
      timeoutMs,
      parentAbortSignal: params.abortSignal,
      work: async (abortSignal) => {
        const timedParams = { ...resolvedParams, abortSignal }
        if (isApiSubagentType(subagentType)) {
          return runApiSubagent(timedParams, subagentSlug, systemPrompt, threadPlan, timeoutMs)
        }

        if (isCliSubagentType(subagentType)) {
          return runCliSubagent(timedParams, subagentSlug, systemPrompt, threadPlan, timeoutMs)
        }

        if (isWorkflowBackedSubagentType(subagentType)) {
          return runWorkflowBackedSubagent(
            timedParams,
            subagentType,
            subagentSlug,
            systemPrompt,
            timeoutMs,
          )
        }

        throw new Error(
          `${getSubagentTypeDisplayLabel(subagentType)} does not run through the managed subagent runner.`,
        )
      },
    })
    return withQueueWaitNote(result, lock)
  } catch (error) {
    if (!isManagedSubagentTimeoutError(error)) throw error
    const runtime = isCliSubagentType(subagentType)
      ? resolveCliSubagentRuntime(params.subagent)
      : null
    const modelId = runtime
      ? resolveCliSubagentExecutableModel(params.subagent, runtime)
      : resolveSubagentModelId(params.subagent, params.parentModelId)
    const provider =
      params.subagent.primary_model_provider?.trim() ||
      (runtime ?? params.parentConnection?.service?.trim()) ||
      null
    return withQueueWaitNote(
      {
        output: delegatedFailureOutput({
          label: params.subagent.displayName || subagentSlug,
          status: 'timed_out',
          timeoutMs,
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
