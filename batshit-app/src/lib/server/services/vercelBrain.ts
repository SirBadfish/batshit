import { buildPromptBudgetReport } from './contextBudgetPreflight'
import { applySkillDcmUpdate, readSkillDcmUpdate, type SkillDcmUpdate } from './skillDcmUpdate'
import type { P5ApiOriginalRun } from './appActions/mcp/originalTask'
import { steerInputSource, type UserInputSource, type ApiInputObservation } from './imageAddressApiInput'
/**
 * Vercel AI SDK Brain Service - API runtime Native AI Orchestration
 * Story 5.7: Clean streaming architecture with direct provider access
 *
 * CRITICAL: API runtime ONLY - Not used by n8n agents (they use n8n Chat Models)
 * CRITICAL: NO backward compatibility needed - zero users
 * CRITICAL: Preserves multimodal as structured image inputs, never raw image text
 * CRITICAL: Uses existing compileForAI() without modification
 */

import {
  streamText,
  tool,
  dynamicTool,
  isStepCount,
  extractReasoningMiddleware,
  wrapLanguageModel,
  type LanguageModel,
  type ModelMessage,
  type Experimental_DownloadFunction
} from 'ai'
import { logger } from '$lib/utils/logger'
import { normalizeToolNameForAiSdkKey } from '$lib/utils/toolNameNormalization'
import { createOpenAI } from '@ai-sdk/openai'
import { createHash } from 'crypto'
import { z } from 'zod'
import { ProviderManager, resolveProviderAccess } from '$lib/server/services/providers'
import { isOutputLimitFinish } from '$lib/server/services/outputLimitStop'
import {
  buildEphemeralImageUserMessage,
  createEphemeralImageRegistry,
  resolveToolResultImageDelivery,
  type EphemeralImageRegistry,
  type EphemeralImageRegistryEntry,
  type ToolResultImageLane
} from '$lib/server/services/toolResultImageDelivery'
import type { ThinkRequest, ThoughtResponse } from '$lib/types/aiBrain'
import type { AgentDcmDisplaySettings } from '$lib/types/database'
import type { ModelCapabilities, ModelConnectionInfo } from '$lib/types/savedModels'
import type { ToolApprovalMode } from '$lib/types/tool-approvals'
import type { Mode4Style } from '$lib/constants/mode4'
import { env } from '$env/dynamic/private'
import { v4 as uuidv4 } from 'uuid'
import type { GatewayMetadata, ToolMetadataMap } from './mcpGatewayTypes'
import { redis } from '$lib/server/redis' // Story 6.8: Load agent assigned workflows
import { nativeToolService, type NativeToolApprovalPolicy } from './nativeTools'
import { isNativeToolName } from './nativeToolConstants'
import { runAbortSignalOf, trackToolExecution } from './lateToolResults'
import { compileClipReferencesForAiView } from '$lib/utils/clipAiView'
import { buildSteerInjectionText, type DeliveredSteer } from '$lib/utils/steerControl'
import { toOwnedBytes } from '$lib/utils/binary'
import { executeManagedSubagent } from '$lib/server/services/subagentRunner'
import {
  delegatedRunStopCondition,
  reportDelegatedStreamPart,
  type DelegatedRunProgress,
} from './delegatedRunWatch'
import {
  isSubagentBusyError,
  normalizeSubagentThreadMode
} from '$lib/server/services/subagentThreads'
import { isRetiredSubagentType, normalizeSubagentType, type SubagentType } from '$lib/utils/subagentType'
import { resolveSubagentSlug } from '$lib/utils/subagentSlug'
import { isOpenAIReasoningParameterRestrictedModelId } from '$lib/utils/parameterFilter'
import { collectReasoningTextFromFinish } from '$lib/utils/reasoningDisplay'
import { fingerprintRegisteredTools } from './toolDefinitionFingerprint'
import {
  captureApiUtilities, isApiUtilityInnerExecution, isApiSkillUtilityFormatting, isGuardedApiUtilityOutput, markApiUtilityCandidate, markApiUtilityGuardedFormatter, pruneUnusedUtilityBrokers, readApiUtilities,
  type ApiUtilityScope
} from './apiUtilityRuntime'
import { agentSetupCache, type PreparedAgentSetup } from './agentSetupCache'
import {
  applyApiPromptCachePolicy,
  placeToolLoopTailMarker,
  type ToolLoopTailMarker
} from '$lib/server/services/apiPromptCachePolicy'
import { normalizeUsageLike, withHonestLocalCacheUsage } from '$lib/server/services/apiProviderUsage'
import { resolveLocalPromptCacheReporting } from '$lib/data/localAiServers'
import { StreamStoppedError, isStopError, judgeStreamEnd } from '$lib/server/services/streamStop'
import { relayAbort } from '$lib/server/services/turnAbortRelay'
import { providerStreamErrorFrom } from '$lib/server/services/streamFailureEvidence'
import { stepContentReachedToolBoundary, toolErrorAsFailedToolResult } from './toolErrorPart'
import { findCommandModelCapture } from './commandModelCaptureLookup'
import { guardToolModelText, type ToolModelResultContext } from './toolModelResultGuard'
import { estimateTokens } from '$lib/utils/tokens'
import { TOOL_RESULT_TOO_LARGE_TOKENS } from '$lib/utils/toolResultSizeGuard'
import type { PlanLease } from './chatgptPlanRuntime'
import { isPlanSelection, planModelForLease, planClientTools, planProviderOptions, assertPlanSettings } from './chatgptPlanInference'
import { isClaudePlanConnection, isClaudePlanSelection } from '$lib/utils/claudePlanConnection'
import { ClaudePlanRunError } from './claudePlanProtocol'
import { ClaudePlanError, admitClaudePlanSelection, claudePlanNotWiredError, type ClaudePlanConsumer } from './claudePlanAdmission'
import type { ClaudePlanModel } from './claudePlanModel'
import { guardResponsesTerminal } from './responsesTerminalGuard'
import { createGatewayStreamFormatCheck } from './providers/gatewayStreamFormat'

/**
 * BL-452: the error a delegated run's `error` stream part carries, as an Error with the
 * provider's own sentence. The part's `error` is `unknown` (AI SDK 7 `TextStreamErrorPart`):
 * an `APICallError` / `RetryError` for a failed request, a `StreamProviderError` for a mid-stream
 * failure (since ai 7.0.80 the SDK turns the provider's object, Anthropic's
 * `{ type: 'overloaded_error', message }`, into one with the same message and the object in
 * `.data`), or a type validation error wrapping the provider's chunk (BL-245,
 * `providerStreamErrorFrom`).
 */
function delegatedStreamErrorFrom(rawError: unknown): Error {
  const providerError = providerStreamErrorFrom(rawError)
  if (providerError) return providerError
  if (rawError instanceof Error) return rawError
  const message =
    typeof rawError === 'string' && rawError.trim().length > 0
      ? rawError.trim()
      : typeof (rawError as { message?: unknown } | null)?.message === 'string' &&
          ((rawError as { message: string }).message.trim().length > 0)
        ? (rawError as { message: string }).message.trim()
        : 'The model call failed without a reason.'
  return new Error(message, { cause: rawError })
}

/**
 * Subagent tool metadata (Story 6.7c)
 * Metadata for workflows that are registered as subagents
 */
interface SubagentToolMetadata {
  isSubagent: true
  subagentName: string
  subagentId: string
  subagentType: SubagentType
  workflowId: string
  webhookUrl: string | null
  avatarUrl?: string
  provider?: string | null
  model?: string | null
}

class ApiToolNameCollisionError extends Error {
  readonly code = 'API_TOOL_NAME_COLLISION'
  constructor(name: string) {
    super(`The assigned Subagent SDK tool name "${name}" collides with an existing tool. Nothing was sent.`)
    this.name = 'ApiToolNameCollisionError'
  }
}

/**
 * Tool source metadata maps (Story 6.4, Story 6.7c, SA-005)
 * Cached during tool loading for O(1) detection performance
 * SA-005: Removed toolVaultTools (Tool Vault removed October 2025)
 */
interface ToolSourceMaps {
  gatewayTools: Map<string, GatewayMetadata>
  subagentTools: Map<string, SubagentToolMetadata>  // Story 6.7c: Subagent metadata
}

/**
 * Metadata for a tool execution (Story 6.4, Story 6.7c, Story 6.8)
 * Matches IntermediateStep interface fields
 */
interface ToolExecutionMetadata {
  toolProvider?:
    | 'batshit-server'
    | 'n8n-workflow'
    | 'mcp'
    | 'subagent'
    | 'llm-native'
    | 'unknown'  // Story 6.7c: Added 'subagent'
  toolSource?:
    | 'direct-attachment'
    | 'workflow-webhook'
    | 'mcp-gateway'
    | 'mode3-workflow'
    | 'native-tool'
    | 'provider-native'
    | 'unknown'  // Story 6.7c: Added 'mode3-workflow'
  executionTime?: number
  success?: boolean
  // Gateway context
  gatewayId?: string
  gatewayName?: string
  gatewayType?: 'docker' | 'n8n-mcp-trigger' | 'n8n-instance-mcp' | 'n8n-mcp-client' | 'custom' | 'stdio'
  mcpServerName?: string
  // Workflow context
  webhookUrl?: string
  // Subagent context (Story 6.4 AC4, Story 6.7c, Story 6.8)
  isSubagent?: boolean
  subagentName?: string
  subagentId?: string  // Story 6.7c: Added subagentId
  subagentType?: string  // Story 6.7c: Added subagentType
  agentName?: string
}

type ImageUrlPolicy = 'auto' | 'external_only'

const GEMINI_FILE_CACHE_PREFIX = 'gemini:file-uri'
const GEMINI_FILE_CACHE_TTL_SECONDS = 60 * 60

type GeminiFileCacheEntry = {
  fileUri: string
  mediaType?: string
  displayName?: string
  createdAt?: string
}

function stringifyForToolModelOutput(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    const json = JSON.stringify(value ?? null, null, 2)
    return typeof json === 'string' ? json : String(value ?? '')
  } catch {
    return String(value ?? '')
  }
}

/**
 * One model-facing shape for every API tool result: a JSON output becomes pretty-printed
 * text, because that is what this lane has always sent the model. Text and content outputs
 * pass through untouched.
 *
 * F-P4-9: this used to append a reserved zip id and "Use this exact zipId in unzip/zip
 * controls". That notice is gone on every lane. The one model-facing handle for a
 * current-response tool result is the `tool_result_N` alias the zip-control prompt teaches;
 * older zips keep their real ids. Announcing an id here also meant announcing one for
 * memory tools, which are never zipped at all (DL-104-17), so an agent that fetched it got
 * `not_found`.
 */
function toReadableToolModelOutput(modelOutput: any): any {
  if (!modelOutput || typeof modelOutput !== 'object') {
    return { type: 'text', value: stringifyForToolModelOutput(modelOutput) }
  }

  if (modelOutput.type === 'json' || modelOutput.type === 'error-json') {
    return { type: 'text', value: stringifyForToolModelOutput(modelOutput.value) }
  }

  return modelOutput
}

function buildDefaultToolModelOutput(output: unknown): any {
  return typeof output === 'string'
    ? { type: 'text', value: output }
    : { type: 'json', value: output ?? null }
}

/** The SDK's content variant can mix text and image/file blocks. Only readable text counts. */
async function guardReadableToolModelOutput(
  modelOutput: any,
  context: ToolModelResultContext
): Promise<any> {
  if (!modelOutput || typeof modelOutput !== 'object') return modelOutput
  if ((modelOutput.type === 'text' || modelOutput.type === 'error-text') &&
      typeof modelOutput.value === 'string') {
    if (estimateTokens(modelOutput.value) < TOOL_RESULT_TOO_LARGE_TOKENS) return modelOutput
    return { ...modelOutput, value: await guardToolModelText(modelOutput.value, context) }
  }
  if (modelOutput.type !== 'content' || !Array.isArray(modelOutput.value)) return modelOutput

  const parts = modelOutput.value as Array<any>
  const readableParts = parts.flatMap((part) => {
    if (part?.type === 'text' && typeof part.text === 'string') return [part.text]
    if (part?.type === 'file' && part.data?.type === 'text' &&
        typeof part.data.text === 'string') return [part.data.text]
    return []
  })
  if (readableParts.length === 0) return modelOutput
  const readableText = readableParts.join('\n')
  if (estimateTokens(readableText) < TOOL_RESULT_TOO_LARGE_TOKENS) return modelOutput

  const cutText = await guardToolModelText(readableText, context)
  let inserted = false
  const cutParts = parts.flatMap((part) => {
    const isText = part?.type === 'text' && typeof part.text === 'string'
    const isInlineFileText = part?.type === 'file' && part.data?.type === 'text' &&
      typeof part.data.text === 'string'
    if (!isText && !isInlineFileText) return [part]
    if (inserted) return []
    inserted = true
    // Preserve all media blocks and top-level options. A cut inline text file becomes a
    // text notice so the model does not receive the unbounded original file body.
    return [{ type: 'text', text: cutText, ...(part.providerOptions ? { providerOptions: part.providerOptions } : {}) }]
  })
  return { ...modelOutput, value: cutParts }
}

type ApiStreamCustody = { run: P5ApiOriginalRun; consumerConsumed: boolean; finishKnown: boolean;
  owner: typeof import('./appActions/mcp/originalTask') }
const p5ApiStreams = new WeakMap<object, ApiStreamCustody>(), p5ApiRuns = new WeakMap<object, ApiStreamCustody>()

/**
 * The App Actions P5 pictures held for this run. A resumed held Claude plan run already gave Claude these pictures
 * inside the held step's MCP results (every tool picture rides there on that connection), so they are taken from the
 * original task and never sent again; any other run gets them as first-step user messages (SA-139 D6, D8, P3 Part 4
 * review B S1).
 */
export function moveP5ImagesForRun(
  owner: Pick<typeof import('./appActions/mcp/originalTask'), 'moveP5ApiToolImages'>,
  run: P5ApiOriginalRun, registry: EphemeralImageRegistry, lane: ToolResultImageLane, resumesHeldClaudePlanRun: boolean
): { ids: string[]; deferred: string[] } {
  if (!resumesHeldClaudePlanRun) return owner.moveP5ApiToolImages(run, registry, lane)
  owner.moveP5ApiToolImages(run, createEphemeralImageRegistry(), lane)
  return { ids: [], deferred: [] }
}
/** Actual route supplies the actual SDK result after consuming its finish/usage.
 * A run handle/body/boolean cannot fabricate an SDK result association. */
export function observeP5ApiConsumedStream(result: object): void {
  const fact = p5ApiStreams.get(result)
  if (!fact) throw new Error('The actual API SDK stream owner is unavailable.')
  fact.consumerConsumed = true; fact.owner.notifyP5ApiStreamSettlement(fact.run)
}
export function readP5ApiStreamSettlement(run: P5ApiOriginalRun) {
  const fact = p5ApiRuns.get(run)
  return fact ? Object.freeze({ consumerConsumed: fact.consumerConsumed, finishKnown: fact.finishKnown }) : undefined
}

/** SA-137 Round 2 follow-up: the last check before a provider request, and its confirmation. */
export interface ModelDispatchGate {
  beforeRequest(): Promise<void>
  requestSent(): void
}

export type PreparedApiToolset = Readonly<{ fingerprint: string; brokerAvailable: boolean; toolsRegistered: boolean; apiUtilityScope: ApiUtilityScope }>

export interface NativeModeRequest extends ThinkRequest {
  /** Actual Primary native read-to-model delivery owner; absent on delegated runs. */
  skillReadDelivery?: import('./skillReadDelivery').SkillReadDelivery
  refreshOpenSkills?: () => Promise<SkillDcmUpdate | undefined>
  /** The route's existing resolved context/output reserve; never a new hint cap. */
  skillContextBudget?: { contextLimit: number | null; outputReserveTokens: number }
  /** Opaque server-prepared registration; no HTTP/model input can mint it. */
  preparedApiToolset?: PreparedApiToolset
  /** Prepared by the sole compiler from server-owned live setup. */
  agentSetup?: PreparedAgentSetup
  mcpOriginalPreparation?: import('./appActions/mcp/originalTask').P5OriginalPreparation
  mcpApiPart?: import('./appActions/mcp/originalTask').P5ApiReplyPart
  /** Fixed route receives an actual opaque association, not a readiness certificate. */
  onP5ApiRun?: (run: P5ApiOriginalRun) => void
  /** Server-owned request capability; never accepted from an HTTP body. */
  chatgptPlanLease?: PlanLease
  /** Constructed by send-routed from its compile and persisted server replay, never body metadata. */
  imageOriginInput?: { compiledPrefixCount: number; userSources: UserInputSource[] }
  onApiModelInput?: (input: ApiInputObservation) => void
  /**
   * SA-137 Round 2 follow-up: `beforeRequest` is awaited right before each provider request leaves
   * (innermost, before `onApiModelInput` observes it); a throw sends nothing and the stream fails
   * with that error. `requestSent` runs once that request's `doStream` resolved, so an attempt the
   * SDK retries after a failed send is checked again. Set by send-routed only, from its turn's
   * `LiveFileReadTurn`.
   */
  modelDispatchGate?: ModelDispatchGate

  /** Internal delegated-run owner; a Worker belongs to its parent, not its own virtual id. */
  processOwner?: { userId: string; kind: 'agent' | 'subagent'; id: string }
  /** Actual delegated record's Bash grant, before preset settings are merged. */
  delegatedBashEnabled?: boolean
  /** The delegated record's materialized typed-file grant; missing/null is unavailable. */
  delegatedTypedFileToolsValue?: boolean | null
  /**
   * Delegation limits (2026-10-24): `processNativeMode` only. The run's stall guard hears every
   * stream part through this (`delegatedRunWatch.ts`); absent, nothing watches the run.
   */
  delegatedProgress?: DelegatedRunProgress
  /**
   * Delegation limits (2026-10-24): `processNativeMode` only. The Subagent's optional tool-step
   * limit, counted in tool calls; null or absent runs until the model stops calling tools. The
   * streaming path keeps `maxToolRounds`.
   */
  delegatedMaxToolSteps?: number | null
  /**
   * SA-105 P2 (DL-105-06): the saved model's capabilities, so the tool-result
   * image lane uses the same vision rule as attached clips. Optional and
   * unknown-means-allowed, matching the clip posture.
   */
  modelCapabilities?: ModelCapabilities | null
  mode4Style?: Mode4Style
  agentId?: string
  toolsEnabled?: boolean
  maxToolRounds?: number
  selectedGateways?: string[] // Story 5.22: List of selected MCP Gateway IDs from chat bar
  toolSelections?: import('$lib/types/database').MCPToolSelections // Story 5.23: Per-tool selections from chat bar
  selectedCliToolIds?: string[]
  dcmDisplaySettings?: AgentDcmDisplaySettings | null
  allowArtifactRuntimeTools?: boolean
  allowFabricControlTools?: boolean
  /** SA-133: admitted primary API reply settings; delegated runs leave these absent. */
  whiteboardControlsEnabled?: boolean
  whiteboardSettingsSnapshot?: import('$lib/utils/reasoningRetention').ResolvedReasoningRetention
  /** SA-137: the API Primary's resolved `live_file_reads`; its Bash proves its reads for a later refresh. */
  liveFileReadsEnabled?: boolean
  /** This turn runs Refreshed File Reads (the compile's `refreshedFileReadsTurn`); it shapes `edit_file`'s text. */
  refreshedFileReadsTurn?: boolean
  /** SA-104 P3: PRIMARY runs of memory-enabled agents; subagent runner leaves it false. */
  memoryControlsEnabled?: boolean
  /** SA-113 P2 (DL-113-03): PRIMARY actor + agent `dms_enabled`. */
  dmControlsEnabled?: boolean
  /** SA-115 P2 (DL-115-10): PRIMARY actor + agent `dms_enabled`. */
  scheduleControlsEnabled?: boolean
  /** SA-120 P2 (DL-120-06): PRIMARY actor + agent `jev_juice_judge_tool`. */
  judgeControlsEnabled?: boolean
  /**
   * SA-111 P4 (DL-111-11/12): PRIMARY runs of workers-enabled agents. The subagent runner
   * leaves it false, which is what keeps delegation depth at one level.
   */
  workersEnabled?: boolean
  /**
   * SA-116 P2 (DL-116-05, DL-116-10): the approvals the user clicked, keyed by the SDK
   * `toolCallId` of the paused call, and whether this is a group member's turn (a group run
   * never registers the risk-approval policy). Both are resolved by send-routed from server
   * state — never from anything the browser posts back.
   */
  controlApprovals?: {
    approved?: Record<string, { kind: 'sdk' | 'resume'; approvalId: string; toolCallId?: string }> | null
    denied?: Record<string, { controlTitle?: string | null }> | null
  } | null
  groupMemberRun?: boolean
  /**
   * BL-75 — whose skill access governs this run's `native_skill` loads, when that is not
   * `agentId`. Set only by `subagentRunner.ts`: to the Subagent's (or a `base` Worker's) record
   * id, or a built-in Worker's `worker_…` id. The same id builds the run's `skills_commands`
   * list, so a skill it lists is a skill it can load, and nothing more. A Subagent run passes
   * the PARENT as `agentId`, so that cannot stand in for it.
   */
  scopeAgentId?: string | null
  /**
   * SA-114 P1 (DL-114-05): takes every steer waiting for this turn and marks it delivered.
   *
   * Only send-routed's PRIMARY API turn supplies it. A subagent run, a Worker, a group
   * member's turn, and an artifact completion all leave it unset, which is what keeps the
   * user's mid-reply words inside the turn they were typed into (DL-114-09).
   */
  takeSteers?: ((step: number) => DeliveredSteer[]) | null
  gatewayToolMap?: Record<string, string[]> | null
  preloadedGatewayTools?: ToolMetadataMap['tools']
  preloadedGatewayMetadata?: ToolMetadataMap['metadata']
  assignedSubagents?: any[] // Preloaded subagent metadata from send-routed (avoids Redis round-trip)
  defaultGateways?: string[] | null // Agent-level MCP gateway defaults (null = load all)
  toolApprovalMode?: ToolApprovalMode
  abortSignal?: AbortSignal
  topP?: number
  topK?: number
  presencePenalty?: number
  frequencyPenalty?: number
  seed?: number
  stopSequences?: string[]
  providerOptions?: Record<string, Record<string, any>>
  connection?: ModelConnectionInfo | null
  /**
   * SA-139 (D11): the consumer a Claude plan selection runs as (`primary`, `subagent`, `worker`). A
   * caller that names none is refused by central admission before any process starts.
   */
  claudePlanConsumer?: ClaudePlanConsumer | null
  /** SA-139 (S4, BL-515): the sampling fields of a RAW selection only, never a preset-backed agent's leftovers. */
  claudePlanSampling?: Readonly<object> | null
  /**
   * SA-139 D6: this reply's approval-resume version (send-routed's `approvalResumeVersion`, 0 for a
   * first reply). With the session and message ids it keys the run held at a card; absent on paths that
   * raise no card (delegated runs), which then never hold.
   */
  claudePlanApprovalVersion?: number | null
  /** SA-139 D6: the held run the approval click claimed, continued by this reply. */
  claudePlanHeld?: { run: import('./claudePlanRun').ClaudePlanRun; state: import('./claudePlanRunRegistry').ClaudePlanHeldState } | null
  /**
   * SA-139 D6, D8 (P3 Part 4 review B S1): this request continues a held Claude plan run (its click claimed one),
   * known when the tools are prepared, before the claim reaches `claudePlanHeld`.
   */
  claudePlanResumesHeldRun?: boolean
  providerSettings?: Record<string, any> | null
  projectPath?: string | null
  taggedReasoningTagName?: 'think' | null
  onFinish?: (params: {
    text: string
    usage?: any
    steps?: any[]
    totalUsage?: any
    reasoning?: string[]
    responseMessages?: ModelMessage[]
    apiUserSources?: UserInputSource[]
    /** BL-474 step 2: pictures handed to the model in a synthetic message during the run. */
    imageInputsRegistered?: number
  }) => void | Promise<void>
  onAbort?: (params: { steps?: any[] }) => void
}

/**
 * Vercel AI Brain Service for API runtime
 * Clean, direct streaming with Vercel AI SDK
 * Uses ProviderManager for all provider management
 */
export class VercelAIBrain {
  private providerManager: ProviderManager

  constructor() {
    logger.debug('[VercelBrain API] Initializing clean Vercel AI Brain for API runtime')
    this.providerManager = new ProviderManager()
  }

  /**
   * Gives every executable API tool the one model-facing output shape this lane has always
   * sent (`toReadableToolModelOutput`). A tool's own `toModelOutput` still runs first; a
   * tool without one gets the SDK's default shape, which this normalizes the same way.
   *
   * F-P4-9: it never reserves or announces a card zip id. BL-494 may name a separately
   * retained raw copy only after the server has saved it.
   */
  private wrapToolsWithReadableModelOutput(
    tools: Record<string, any>,
    context: Omit<ToolModelResultContext, 'toolName'>,
    skillReadDelivery?: import('./skillReadDelivery').SkillReadDelivery
  ): Record<string, any> {
    const wrappedTools: Record<string, any> = {}
    for (const [toolName, toolDefinition] of Object.entries(tools)) {
      if (
        !toolDefinition ||
        typeof toolDefinition !== 'object' ||
        (toolDefinition as any).type === 'provider'
      ) {
        wrappedTools[toolName] = toolDefinition
        continue
      }

      const originalExecute = (toolDefinition as any).execute
      const originalToModelOutput = (toolDefinition as any).toModelOutput
      if (typeof originalExecute !== 'function' && typeof originalToModelOutput !== 'function') {
        wrappedTools[toolName] = toolDefinition
        continue
      }

      const deliveredReads = new WeakMap<object, { key: string; value: unknown }>()
      const formatKey = (params: { toolCallId: string; input: unknown; output: unknown }) =>
        JSON.stringify([params.toolCallId, params.input, params.output])
      const wrapped = {
        ...toolDefinition,
        // BL-1959: a Stop during the call drops its result from the SDK's stream; send-routed's
        // stream wrapper hands it on from here (`lateToolResults.ts`). The call itself is unchanged.
        ...(typeof originalExecute === 'function'
          ? {
              execute: (input: unknown, options: { toolCallId?: string; abortSignal?: AbortSignal } | undefined) => {
                const original = originalExecute.call(toolDefinition, input, options)
                const inner = isApiUtilityInnerExecution(options)
                // The SDK emits its raw tool-result before calling toModelOutput at finish-step.
                // A native skill therefore finishes the SAME final formatter/guard/admission here,
                // before execute resolves; its later SDK formatting reuses that exact result.
                const value = skillReadDelivery && !inner ? Promise.resolve(original).then(async output => {
                  if (skillReadDelivery.owns(output)) {
                    if (!options?.toolCallId) throw new Error('The actual skill invocation id is unavailable. Nothing was delivered.')
                    await wrapped.toModelOutput({ toolCallId: options.toolCallId, input, output })
                  }
                  return output
                }) : original
                if (!inner) trackToolExecution(runAbortSignalOf(options), options?.toolCallId, toolName, input, value)
                return value
              }
            }
          : {}),
        toModelOutput: async (params: {
          toolCallId: string
          input: unknown
          output: unknown
        }) => {
          const receipt = params.output && typeof params.output === 'object' ? deliveredReads.get(params.output) : undefined
          if (receipt) {
            if (receipt.key !== formatKey(params)) throw new Error('The delivered skill result changed during SDK replay. Nothing was sent.')
            return receipt.value
          }
          const modelOutput =
            typeof originalToModelOutput === 'function'
              ? await originalToModelOutput.call(toolDefinition, params)
              : buildDefaultToolModelOutput(params.output)
          const finish = async (before: unknown, after: unknown) => {
            // Captured utility formatting is nested inside the broker's actual formatter.
            // Only the outer SDK invocation names its real persisted producer/input.
            if (!isApiSkillUtilityFormatting(params)) {
              await skillReadDelivery?.delivered({ ...params, toolName, before, after })
              if (skillReadDelivery?.owns(params.output)) deliveredReads.set(params.output as object, { key: formatKey(params), value: after })
            }
            return after
          }
          if (isGuardedApiUtilityOutput(modelOutput)) return finish(modelOutput, modelOutput)

          const memoryResult = toolName === 'native_batshit_tool_use' &&
            params.output !== null && typeof params.output === 'object' &&
            (params.output as any).family === 'fabric' &&
            /^sys\.memory\.[a-z0-9_-]+$/.test((params.output as any).target ?? '')
          const captured = findCommandModelCapture(params.output)
          if (captured && Math.ceil(captured.originalTextChars / 4) >= TOOL_RESULT_TOO_LARGE_TOKENS) {
            const cut = await guardToolModelText(captured.text, {
              ...context, toolName, originalTextChars: captured.originalTextChars
            })
            const readable = toReadableToolModelOutput(modelOutput)
            if (readable?.type === 'content' && Array.isArray(readable.value)) {
              return finish(readable, { ...readable, value: [{ type: 'text', text: cut }, ...readable.value.filter((part: any) =>
                part?.type !== 'text' && !(part?.type === 'file' && part.data?.type === 'text'))] })
            }
            return finish(readable, { ...readable, type: readable?.type === 'error-text' ? 'error-text' : 'text', value: cut })
          }
          const before = toReadableToolModelOutput(modelOutput)
          return finish(before, await guardReadableToolModelOutput(
            before, { ...context, toolName, ...(memoryResult ? { memoryResult: true } : {}) }
          ))
        }
      }
      markApiUtilityGuardedFormatter(wrapped.toModelOutput)
      wrappedTools[toolName] = wrapped
    }

    return wrappedTools
  }

  private logPromptCachePolicy(
    metadata: ReturnType<typeof applyApiPromptCachePolicy>['metadata']
  ) {
    if (metadata.omitted.length > 0) {
      logger.warn('[VercelBrain API] Prompt cache option omitted', {
        provider: metadata.provider,
        modelId: metadata.modelId,
        omitted: metadata.omitted
      })
    }

    logger.debug('[VercelBrain API] Prompt cache policy', {
      enabled: metadata.enabled,
      provider: metadata.provider,
      modelId: metadata.modelId,
      transport: metadata.transport,
      stablePrefixHash: metadata.stablePrefixHash,
      stablePrefixParts: metadata.stablePrefixParts,
      applied: metadata.applied,
      preserved: metadata.preserved,
      providerOptionKeys: metadata.providerOptionKeys,
      // History cache blocks (2026-10-21) and BL-184's lifetime, for live diagnosis.
      historyParts: metadata.historyParts,
      cacheTtl: metadata.cacheTtl
    })
  }

  /**
   * Process API runtime native AI request with clean streaming
   * CRITICAL: Uses existing compileForAI() output directly
   * CRITICAL: Workflows become simple async tools
   */
  async processNativeMode(request: NativeModeRequest): Promise<ThoughtResponse> {
    const startTime = Date.now()
    const delegatedMaxToolSteps =
      typeof request.delegatedMaxToolSteps === 'number' && request.delegatedMaxToolSteps > 0
        ? request.delegatedMaxToolSteps
        : null
    // The model loop's own signal: the runner's (Stop, the time limit) relayed in, plus the
    // run's own abort when it ends early on a failed model call, so the SDK's loop, the
    // provider request, and any running tool are cancelled rather than left suspended.
    // `runOver` removes the relay's listener when the run ends (BL-246).
    const runController = new AbortController()
    const runOver = new AbortController()
    let claudePlan: ClaudePlanWiring | null = null
    relayAbort({
      from: request.chatgptPlanLease?.signal ?? request.abortSignal,
      to: runController,
      reason: (source: AbortSignal) => source.reason,
      until: runOver.signal,
    })

    logger.debug('[VercelBrain API] Processing native mode request', {
      sessionId: request.sessionId,
      model: request.model,
      messageCount: request.messages?.length
    })

    try {
      // Validate messages
      if (request.chatgptPlanLease) assertPlanSettings(request.providerSettings)
      if (!request.messages || request.messages.length === 0) {
        throw new Error('No messages provided to processNativeMode()')
      }
      claudePlan = await this.prepareClaudePlanModel(request)

      // Get model instance from ProviderManager
      const model = await this.getModel(
        request.model,
        request.connection,
        request.userId,
        request.taggedReasoningTagName,
        undefined,
        request.chatgptPlanLease,
        undefined,
        undefined,
        claudePlan?.model,
      )

      // Convert messages - uses existing compilation!
      // NEW (SA-002): Pass sessionId and userId for clip resolution
      const baseMessages = await this.convertMessages(
        request.messages,
        request.images,
        request.sessionId,
        request.userId
      )
      const { messages, fileUris: geminiFileUris } = await this.convertGeminiFileParts(
        baseMessages,
        request
      )
      this.logGeminiPayloadSummary('process', messages, request, geminiFileUris)

      // Build tools from the request's tool selection
      // Story 6.4: Also get metadata maps for tool source detection
      const { tools: toolsForRequest, maps: toolMaps, approvals: toolApprovals, images: ephemeralImages } = await this.consumeApiToolset(request)

      const runtimeProviderId = this.resolveRuntimeProviderId(
        request.model,
        request.connection,
      )
      const cachePolicy = applyApiPromptCachePolicy({
        modelId: request.model,
        providerId: runtimeProviderId,
        connection: request.connection ?? null,
        sessionId: request.sessionId,
        agentId: request.agentId ?? null,
        userId: request.userId ?? null,
        messages,
        tools: toolsForRequest,
        providerOptions: request.providerOptions,
      })
      this.logPromptCachePolicy(cachePolicy.metadata)

      const downloadGuard = await this.resolveDownloadHandler(request, geminiFileUris)

      // Clean streaming with Vercel AI SDK
      const result = await streamText({
        model,
        messages: cachePolicy.messages,
        // Every system-role entry in `messages` originates from Batshit's own
        // server-side compiler, never from untrusted content (SA-098 D1), so the
        // v7 system-in-messages guard is relaxed to preserve Batshit's prompt
        // order and provider cache anchoring on the compiled payload.
        allowSystemInMessages: true,
        ...claudePlanToolOptions(claudePlan, cachePolicy.tools, toolApprovals, downloadGuard),
        // Delegation limits (Josh, 2026-10-24, decision 3): a delegated run has no tool-step
        // limit unless its Subagent sets one. It used to stop at 10 rounds (SA-062).
        stopWhen: delegatedRunStopCondition(delegatedMaxToolSteps),
        ...this.buildGenerationSettings(request),
        providerOptions: request.chatgptPlanLease ? planProviderOptions(cachePolicy.providerOptions) : cachePolicy.providerOptions,
        // SA-107: per-session cache-affinity headers (xAI/Baseten/Fireworks direct lanes).
        ...(cachePolicy.headers ? { headers: cachePolicy.headers } : {}),
        ...(downloadGuard ? { experimental_download: downloadGuard } : {}),
        // BL-449: the runner's signal, which fires on the parent's Stop and on the Subagent time
        // limit. Without it a stopped or timed-out run went on calling the model and running
        // tools after the parent had been answered, and a tool that runs a process never heard
        // the Stop (the SDK hands this signal to every tool's `options.abortSignal`).
        abortSignal: runController.signal,
        // The same composed hook the streaming path registers (SA-114 P1). A delegated run
        // (API Subagent or Worker) never takes a steer (DL-114-09), so it composes SA-105's
        // synthetic image lane with BL-77's tool-loop cache point only. BL-183: before this,
        // the hook was registered only on the image lane, so a delegated tool loop re-sent
        // its whole conversation at the full input price on every step. It returns
        // `undefined` whenever neither has anything to add, so a run with no images on a
        // lane without Anthropic cache control sends byte-identical requests. BL-1976: the
        // cache point starts on the first model call.
        prepareStep: this.buildTurnPrepareStep({
          ephemeralImages: ephemeralImages ?? null,
          takeSteers: null,
          toolLoopProviderOptions: cachePolicy.stepProviderOptions ?? null,
          toolLoopTailMarker: cachePolicy.toolLoopTailMarker
            ? { marker: cachePolicy.toolLoopTailMarker, firstLoopIndex: cachePolicy.messages.length }
            : null
        })
      })

      // Process the full response
      let content = ''
      const intermediateSteps: ThoughtResponse['intermediateSteps'] = []
      // BL-452: a failed model call (a 429, an overloaded provider) reaches the loop as an
      // `error` part and the stream then closes normally; the FIRST one is the run's failure.
      let streamRuntimeError: Error | null = null
      // The SDK can end an aborted stream normally, with its `abort` part (`streamStop.ts`).
      let sawAbortPart = false
      // BL-1782: the same rule as send-routed's loop, from the one shared helper.
      const gatewayStreamFormatCheck = createGatewayStreamFormatCheck()
      // Delegation limits: the tool calls made so far, and how many tools Batshit runs that the
      // last finished step called, so a run the step limit stopped is told apart from one that
      // finished. The AI SDK keeps looping on exactly those calls, not on the finish reason,
      // which some providers report as `stop` on a step that called tools.
      let toolCallCount = 0
      let stepClientToolCalls = 0
      let lastStepClientToolCalls = 0
      // BL-2356: why the last model call stopped (`length` is its output limit).
      let lastStepFinishReason: unknown = null

      // Collect the full response (AI SDK 7: `stream` replaces `fullStream`)
      streamLoop: for await (const part of result.stream) {
        if (request.delegatedProgress) reportDelegatedStreamPart(request.delegatedProgress, part)
        if (part.type === 'start-step') stepClientToolCalls = 0
        if (part.type === 'tool-call') {
          toolCallCount += 1
          if (part.providerExecuted !== true) stepClientToolCalls += 1
        }
        if (part.type === 'finish-step') { lastStepClientToolCalls = stepClientToolCalls; lastStepFinishReason = part.finishReason }
        // A step that finished with no readable reason while a tool call Batshit runs got no
        // result, error or card ends the run, as the first `error` part does below.
        const streamFormatFailure = gatewayStreamFormatCheck.observe(part)
        if (streamFormatFailure) {
          streamRuntimeError = streamFormatFailure
          runController.abort(streamRuntimeError)
          break streamLoop
        }
        switch (part.type) {
          case 'text-delta':
            content += part.text
            break

          case 'tool-result':
          case 'tool-error': {
            // BL-611: a call that FAILED (arguments its schema refused, a tool that does not
            // exist, an `execute` that threw) arrives as a `tool-error` part. It is recorded as
            // the failed result the chat's loop records since BL-450, so the delegated run's
            // record keeps the call and why it failed instead of dropping it.
            const toolPart = part.type === 'tool-error' ? toolErrorAsFailedToolResult(part as any) : part
            // Story 6.4: Record intermediate step with complete metadata
            const toolName = (toolPart as any)?.toolName
            if (typeof toolName === 'string') {
              const toolInput = (toolPart as any).input ?? (toolPart as any).args ?? {}
              const toolOutput = (toolPart as any).output ?? (toolPart as any).result

              // Detect tool source and get metadata
              const toolMetadata = this.detectMode3ToolSource(toolName, toolMaps)

              // Build enhanced intermediate step with metadata
              intermediateSteps.push({
                toolName,
                toolInput: toolInput as Record<string, any>,
                toolOutput,
                timestamp: Date.now(),
                // Story 6.4: Inject all metadata fields
                ...toolMetadata
                // Note: success indicator removed - not part of IntermediateStep interface
              })
            }
            break
          }

          case 'error':
            // The first error ends the run, as it ends the streaming path's loop (send-routed's
            // `shouldBreakStream`): a non-final error part (a missing text part, a tool call
            // that did not parse) must not go on to call the model and run tools. Leaving the
            // loop only suspends the SDK (its stream is a tee), so the run is aborted too.
            streamRuntimeError = delegatedStreamErrorFrom(part.error)
            runController.abort(streamRuntimeError)
            break streamLoop

          case 'abort':
            sawAbortPart = true
            break

          default:
            // Ignore other event types (start, start-step, text-start, text-end, finish-step, etc.)
            // Vercel AI SDK sends many event types - we only need the ones above
            break
        }
      }

      // Judged BEFORE the result's usage or steps are read: a Stop is a Stop whatever else the
      // stream reported, and a failed run throws the provider's own error, never the partial
      // words as a finished answer (the runner would stamp them completed) and never the SDK's
      // generic "No output generated" that `result.usage` rejects with after a first-step failure.
      const streamEnd = judgeStreamEnd({
        stopped: sawAbortPart || request.abortSignal?.aborted === true,
        runtimeError: streamRuntimeError,
      })
      if (streamEnd.kind === 'stopped') throw new StreamStoppedError()
      if (streamEnd.kind === 'failed') throw streamEnd.error

      // The step limit ended the loop when the step that reached it still called tools Batshit
      // runs (so the SDK would have gone on); a model that answered on that step finished.
      // BL-2356: the last model call stopped at its output limit, so the run's last words may be cut
      // off; it comes back marked, as a Primary reply's does (BL-239), never as a finished run. The SDK
      // runs no call of a `length` step (`isToolExecutionAllowedFinishReason`), so that step's calls
      // never ran and the output limit, not the step limit, is what stopped the run.
      const outputLimitReached = isOutputLimitFinish(lastStepFinishReason)
      const stepLimitReached =
        !outputLimitReached &&
        delegatedMaxToolSteps !== null &&
        toolCallCount >= delegatedMaxToolSteps &&
        lastStepClientToolCalls > 0

      // Get usage information
      const localCacheReporting = resolveLocalPromptCacheReporting(runtimeProviderId)
      const sdkUsage = await result.usage
      const usage = normalizeUsageLike(withHonestLocalCacheUsage(
        sdkUsage,
        localCacheReporting,
        localCacheReporting == null
          ? undefined
          : (await result.steps).map((step) => step.usage.raw),
      ))
      const totalTokens = usage?.totalTokens
      const promptTokens = usage?.inputTokens
      const completionTokens = usage?.outputTokens

      // Verify multimodal efficiency
      if (request.images?.length && typeof promptTokens === 'number' && promptTokens > 0) {
        const estimatedImageTokens = request.images.length * 765
        logger.debug('[VercelBrain API] Multimodal token check:', {
          imageCount: request.images.length,
          expectedTokens: estimatedImageTokens,
          actualPromptTokens: promptTokens,
          efficiency: Math.round((estimatedImageTokens / promptTokens) * 100) + '%'
        })
      }

      const thoughtResponse: ThoughtResponse = {
        content,
        intermediateSteps: intermediateSteps.length > 0 ? intermediateSteps : undefined,
        modelUsed: request.model,
        ...(usage
          ? {
              usage: {
                ...(typeof promptTokens === 'number' ? { promptTokens } : {}),
                ...(typeof completionTokens === 'number' ? { completionTokens } : {}),
                ...(typeof totalTokens === 'number' ? { totalTokens } : {}),
                imageTokens: request.images?.length ? request.images.length * 765 : undefined,
                ...(typeof usage.cachedInputTokens === 'number'
                  ? { cachedInputTokens: usage.cachedInputTokens }
                  : {}),
                ...(typeof usage.cacheCreationInputTokens === 'number'
                  ? { cacheCreationInputTokens: usage.cacheCreationInputTokens }
                  : {})
              }
            }
          : {}),
        metadata: {
          provider: this.getProviderName(request.model),
          latency: Date.now() - startTime,
          cached: typeof usage?.cachedInputTokens === 'number' && usage.cachedInputTokens > 0,
          fallbackUsed: false,
          mode: 'native' // Mark as API runtime
        },
        ...(stepLimitReached && delegatedMaxToolSteps !== null
          ? { delegatedStepLimitReached: { limit: delegatedMaxToolSteps, toolCalls: toolCallCount } }
          : {}),
        ...(outputLimitReached ? { delegatedOutputLimitReached: true as const } : {})
      }

      // Clean up MCP clients after streaming
      try {
        const { cleanupMCPClients } = await import('./dockerMCPIntegration')
        await cleanupMCPClients(request.userId, request.sessionId)
      } catch (cleanupError) {
        console.error('[VercelBrain] Error cleaning up MCP clients:', cleanupError)
      }

      // Call user's onFinish if provided
      if (request.onFinish) {
        await request.onFinish({
          text: content,
          usage: usage
            ? {
                ...(typeof totalTokens === 'number' ? { totalTokens } : {}),
                ...(typeof promptTokens === 'number' ? { promptTokens } : {}),
                ...(typeof completionTokens === 'number' ? { completionTokens } : {})
              }
            : undefined,
          steps: intermediateSteps
        })
      }

      return thoughtResponse

    } catch (error: any) {
      const stopped = isStopError(error, [request.abortSignal])
      if (!stopped) console.error('[VercelBrain API] Error in processNativeMode:', error)

      // Ensure cleanup even on error
      try {
        const { cleanupMCPClients } = await import('./dockerMCPIntegration')
        await cleanupMCPClients(request.userId, request.sessionId)
      } catch (cleanupError) {
        console.error('[VercelBrain] Error cleaning up MCP clients on error:', cleanupError)
      }

      // A Stop (the parent's, or the Subagent time limit) stays a Stop, never a provider failure.
      if (stopped) throw error instanceof StreamStoppedError ? error : new StreamStoppedError()
      // SA-139: a Claude plan refusal or run failure keeps its own code and words (review S2).
      if (error instanceof ClaudePlanError || error instanceof ClaudePlanRunError) throw error

      // Handle specific error types. BL-452: thrown as Errors that keep the provider's own
      // sentence. The only caller (`subagentRunner.runApiSubagent`) reports `error.message` to
      // the parent; the plain objects these used to be read as "[object Object]", and the rate
      // limit one replaced the provider's reason with a generic sentence.
      if (error.message?.includes('API key')) {
        throw Object.assign(new Error(`Authentication failed for provider: ${error.message}`, { cause: error }), {
          code: 'PROVIDER_AUTH_ERROR'
        })
      }

      if (error.message?.includes('rate limit')) {
        throw Object.assign(new Error(`Provider rate limit exceeded: ${error.message}`, { cause: error }), {
          code: 'RATE_LIMIT'
        })
      }

      throw error
    } finally {
      // D10: a delegated run's Claude Code run ends with `processNativeMode`, whatever ended the loop.
      claudePlan?.model.endReply()
      runOver.abort()
    }
  }

  /**
   * Detect tool source and generate metadata (Story 6.4, SA-005)
   * Priority: batshit-server by name → MCP Gateway → Subagents → Workflows → Unknown
   * SA-005: Removed Tool Vault from priority list (Tool Vault removed October 2025)
   *
   * @param toolName - Name of the tool that was executed
   * @param toolMaps - Cached metadata maps from buildToolsForMode3()
   * @returns Metadata object with tool provider, source, and context
   */
  private detectMode3ToolSource(
    toolName: string,
    toolMaps: ToolSourceMaps
  ): ToolExecutionMetadata {
    // PRIORITY 0: Batshit native tools (Roadmap Lane A)
    if (isNativeToolName(toolName) || toolName.startsWith('native_')) {
      return {
        toolProvider: 'batshit-server',
        toolSource: 'native-tool',
        mcpServerName: 'batshit-native'
      }
    }

    // ========================================
    // PRIORITY 1: Check if tool is batshit-server by name (handles gateway prefixes)
    // ========================================
    const batshitServerTools = [
      'batshit_server_read_file',
      'batshit_server_overwrite_file',
      'batshit_server_edit_file',
      'batshit_server_list_files',
      'batshit_server_execute_command',
      'batshit_server_search_files'
    ]

    // Check if tool name ends with any batshit-server tool (handles gateway prefixes like "My_Gateway_batshit_server_read_file")
    const matchedBatshitServerTool = batshitServerTools.find(tool => toolName.endsWith(tool))

    if (matchedBatshitServerTool) {
      // Detect if it has gateway prefix (tool name is longer than just the base tool name)
      const hasGatewayPrefix = toolName !== matchedBatshitServerTool
      const toolSource = hasGatewayPrefix ? 'mcp-gateway' : 'direct-attachment'

      logger.debug(`[Tool Source Detection] batshit-server tool detected: ${toolName} (source: ${toolSource})`)

      return {
        toolProvider: 'batshit-server',
        toolSource: toolSource,
        mcpServerName: 'batshit-server'
      }
    }

    // Priority 2: Check if it's an MCP Gateway tool
    const gatewayMetadata = toolMaps.gatewayTools.get(toolName)
    if (gatewayMetadata) {
      return {
        toolProvider: 'mcp',  // Fixed: was 'mcp-gateway', should be 'mcp'
        toolSource: 'mcp-gateway',
        gatewayId: gatewayMetadata.gatewayId,
        gatewayName: gatewayMetadata.gatewayName,
        gatewayType: gatewayMetadata.gatewayType,
        mcpServerName: gatewayMetadata.mcpServerName
      }
    }

    // Priority 2.5: Provider-native LLM tools (Responses API / model-native tools)
    const providerNativeTools = new Set([
      'image_generation',
      'web_search',
      'web_search_preview',
      'file_search',
      'code_interpreter',
      'computer_use'
    ]);
    if (providerNativeTools.has(toolName.toLowerCase())) {
      return {
        toolProvider: 'llm-native',
        toolSource: 'provider-native'
      }
    }

    // Priority 3: Check if it's a Subagent tool (Story 6.7c, 6.8e)
    // CRITICAL: Check subagents BEFORE workflows (more specific → more general)
    // Subagents are workflows but need special metadata (isSubagent, subagentName, etc.)
    logger.debug(`[API Runtime] Checking if ${toolName} is a subagent...`, {
      hasSubagentToolsMap: !!toolMaps.subagentTools,
      subagentToolsMapSize: toolMaps.subagentTools?.size || 0,
      allSubagentToolNames: Array.from(toolMaps.subagentTools?.keys() || [])
    })

    const subagentMetadata = toolMaps.subagentTools?.get(toolName)
    if (subagentMetadata) {
      logger.debug(`[API Runtime] ✅ Subagent detected: ${toolName}`, {
        subagentName: subagentMetadata.subagentName,
        subagentType: subagentMetadata.subagentType
      })

      return {
        toolProvider: 'subagent',
        toolSource: 'mode3-workflow',
        isSubagent: true,
        subagentName: subagentMetadata.subagentName,
        subagentId: subagentMetadata.subagentId,
        subagentType: subagentMetadata.subagentType,
        webhookUrl: subagentMetadata.webhookUrl ?? undefined
      }
    }

    logger.debug(`[API Runtime] ❌ Tool ${toolName} NOT found in subagentTools map`)

    // SA-005: Tool Vault check removed (Tool Vault removed October 2025)

    // Fallback: Unknown tool source (should rarely happen)
    console.warn(`[VercelBrain API] Unknown tool source for: ${toolName}`)
    return {
      toolProvider: 'unknown',
      toolSource: 'unknown'
    }
  }

  /**
   * Convert messages to Vercel AI SDK format
   * CRITICAL: Preserves message compilation exactly - NO modifications!
   * NEW: Supports clip placeholders for Batshit agents (SA-002)
   */
  private async convertMessages(
    messages: ThinkRequest['messages'],
    images?: ThinkRequest['images'],
    sessionId?: string,
    userId?: string
  ): Promise<ModelMessage[]> {
    const coreMessages: ModelMessage[] = []
    let imagesProcessed = false
    const activeClipIds = await this.loadActiveClipIds(sessionId ?? null)
    const isModelMessageContent = (content: unknown): content is Array<{ type: string }> => {
      if (!Array.isArray(content) || content.length === 0) return false
      const hasTypedParts = content.every(
        (part) => part && typeof part === 'object' && typeof (part as any).type === 'string'
      )
      if (!hasTypedParts) return false

      const hasOpenAiImageUrl = content.some((part) => {
        const typed = part as any
        return typed?.type === 'image_url' || typed?.image_url
      })

      return !hasOpenAiImageUrl
    }

    for (const msg of messages) {
      if (
        msg &&
        typeof msg === 'object' &&
        isModelMessageContent((msg as any).content) &&
        !(msg as any).tool_calls &&
        (msg.role === 'assistant' || msg.role === 'tool' || msg.role === 'user' || msg.role === 'system')
      ) {
        coreMessages.push({
          role: msg.role as 'system' | 'user' | 'assistant' | 'tool',
          content: (msg as any).content,
          ...((msg as any).providerOptions ? { providerOptions: (msg as any).providerOptions } : {})
        })
        continue
      }
      // Handle multimodal content for user messages
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        const normalizedContent: any[] = []
        // SA-109: this array branch wins whenever an image clip is attached, so
        // before SA-109 it was the one path that shipped raw `{{batshit-clip:…}}`
        // to the model verbatim. Text parts are normalized here too.
        const normalizeClipSyntax = (text: string) =>
          text.includes('{{batshit-clip')
            ? compileClipReferencesForAiView(text, activeClipIds)
            : text
        for (const part of msg.content as any[]) {
          if (typeof part === 'string') {
            normalizedContent.push({ type: 'text', text: normalizeClipSyntax(part) })
          } else if (part?.type === 'text') {
            normalizedContent.push({ type: 'text', text: normalizeClipSyntax(part.text ?? '') })
          } else if (part?.type === 'image_url' && part.image_url?.url) {
            normalizedContent.push({ type: 'image', image: part.image_url.url })
          } else if (part?.type === 'image' && part.image) {
            normalizedContent.push({ type: 'image', image: part.image })
          } else if (part?.type === 'tool-result' || part?.type === 'tool-call') {
            normalizedContent.push(part)
          }
        }
        coreMessages.push({
          role: 'user',
          content: normalizedContent.length > 0 ? normalizedContent : [{ type: 'text', text: '' }]
        })
      } else if (msg.role === 'user' && images?.length && !imagesProcessed) {
        // Build multimodal content array
        const content: any[] = [
          { type: 'text', text: msg.content }
        ]

        // Add images as structured image inputs so bytes never enter text context.
        for (const image of images) {
          content.push({
            type: 'image',
            image: image.url
          })
        }

        coreMessages.push({
          role: 'user',
          content
        })

        imagesProcessed = true // Only add images to first user message
      } else if (msg.role === 'user' && sessionId && userId) {
        // SA-109 (DL-109-10): clip CONTENT is delivered once, by the canonical
        // compiler, in `<clipped_items>`. This lane used to
        // resolve the same placeholders a second time and append every text
        // clip's body again, so every text clip reached the model twice on the
        // no-image path. It is now syntax normalization only — defense in depth
        // for message shapes that never went through `buildFormattedChatInput`
        // (e.g. a managed subagent's task text), using the same rules as the
        // compiler: attached clips leave no marker, departed clips leave a Clip
        // Log. Raw `{{batshit-clip:…}}` must never reach a model on any lane.
        const textContent = typeof msg.content === 'string' ? msg.content : ''
        coreMessages.push({
          role: 'user',
          content: textContent.includes('{{batshit-clip')
            ? compileClipReferencesForAiView(textContent, activeClipIds)
            : msg.content
        })
      } else if (msg.role === 'tool') {
        // Tool result message
        if (Array.isArray((msg as any).content)) {
          coreMessages.push({
            role: 'tool',
            content: (msg as any).content,
            ...((msg as any).providerOptions ? { providerOptions: (msg as any).providerOptions } : {})
          })
        } else {
          coreMessages.push({
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: (msg as any).tool_call_id || '',
                toolName: (msg as any).name || '',
                result: msg.content
              } as any
            ]
          })
        }
      } else if (msg.role === 'assistant' && msg.tool_calls) {
        // Assistant message with tool calls
        coreMessages.push({
          role: 'assistant',
          content: [
            { type: 'text', text: msg.content || '' },
            ...msg.tool_calls.map(tc => ({
              type: 'tool-call' as const,
              toolCallId: tc.id,
              toolName: tc.function.name,
              args: JSON.parse(tc.function.arguments)
            } as any))
          ]
        })
      } else {
        // Regular text message
        coreMessages.push({
          role: msg.role as 'system' | 'user' | 'assistant',
          content: msg.content
        })
      }
    }

    return coreMessages
  }

  /**
   * Build tools for API runtime - combines MCP tools and subagents
   * Story 5.22: Now uses unified MCP Gateway Discovery
   * Story 5.23: Supports per-tool selection filtering
   * Story 6.4: Returns metadata maps for tool source detection
   * SA-005: Tool Vault removed (October 2025)
   * CRITICAL: Direct execution only
   */
  private readonly preparedApiToolsets = new WeakMap<PreparedApiToolset, {
    binding: string; original: NativeModeRequest['mcpOriginalPreparation']; part: NativeModeRequest['mcpApiPart']; claimed: boolean
    signal: NativeModeRequest['abortSignal']; lease: NativeModeRequest['chatgptPlanLease']
    skillReadDelivery: NativeModeRequest['skillReadDelivery']
    tools: Record<string, any> | undefined; maps: ToolSourceMaps
    approvals: Record<string, NativeToolApprovalPolicy>; images: EphemeralImageRegistry | null
    carried: string[]; deferred: string[]; p5ApiRun: P5ApiOriginalRun | undefined
    p5Owner: typeof import('./appActions/mcp/originalTask') | undefined
  }>()

  private toolRegistrationBinding(request: NativeModeRequest): string {
    const fields: Array<keyof NativeModeRequest> = [
      'userId', 'agentId', 'sessionId', 'messageId', 'model', 'connection', 'toolsEnabled',
      'providerSettings', 'selectedGateways', 'toolSelections',
      'selectedCliToolIds', 'assignedSubagents', 'defaultGateways', 'toolApprovalMode', 'groupMemberRun',
      'scopeAgentId', 'memoryControlsEnabled', 'whiteboardControlsEnabled', 'whiteboardSettingsSnapshot',
      'liveFileReadsEnabled', 'refreshedFileReadsTurn', 'dmControlsEnabled', 'scheduleControlsEnabled',
      'judgeControlsEnabled', 'workersEnabled', 'projectPath', 'dcmDisplaySettings',
      'allowArtifactRuntimeTools', 'allowFabricControlTools', 'delegatedBashEnabled', 'delegatedTypedFileToolsValue',
      'controlApprovals', 'processOwner', 'modelCapabilities'
    ]
    return createHash('sha256').update(JSON.stringify(fields.map(field => [field, request[field] ?? null]))).digest('hex')
  }

  /** Prepare the actual registrations before the sole compiler finalizes its cached setup. */
  async prepareApiToolset(request: NativeModeRequest): Promise<PreparedApiToolset> {
      const p5Owner = request.mcpApiPart ? await import('./appActions/mcp/originalTask') : undefined
      const previousApiWork = p5Owner?.p5OriginalRequestForPreparation(request.mcpOriginalPreparation)
      if (previousApiWork) await p5Owner!.refreshP5OriginalRequest(previousApiWork)
      const p5ApiRun = p5Owner?.associateP5ApiOriginalRun(request.mcpOriginalPreparation, request.mcpApiPart, {
        userId: request.userId, agentId: request.agentId, sessionId: request.sessionId, replyId: request.messageId,
        signal: request.abortSignal, delegated: request.groupMemberRun === true || !!request.scopeAgentId
      })
      if (p5ApiRun) request.onP5ApiRun?.(p5ApiRun)
      const toolsEnabled = request.toolsEnabled !== false
      let toolsForRequest: Record<string, any> | undefined
      let toolApprovalsForRequest: Record<string, NativeToolApprovalPolicy> = {}
      let toolMaps: ToolSourceMaps = {
        gatewayTools: new Map<string, GatewayMetadata>(),
        subagentTools: new Map<string, SubagentToolMetadata>()
      }
      // SA-105 P2: this is the STREAMING path — the one real chat sends take.
      // Wiring only the non-streaming `processNativeMode` left the synthetic
      // lane dead in production, which is exactly what the live recall probe
      // caught before this was fixed.
      let ephemeralImagesForRequest: EphemeralImageRegistry | null = null
      let initialImageToolIds: string[] = [], imageDeferrals: string[] = []
      let bindApiUtilityScope: ((scope?: ApiUtilityScope) => void) | undefined
      let utilityBrokerOnly = false

      if (toolsEnabled) {
        // Story 6.4: Get BOTH tools AND toolMaps for metadata injection
        const { tools, maps, toolApprovals, ephemeralImages, initialImageToolIds: carried, imageDeferrals: deferredImages,
          bindApiUtilityScope: bindUtilities, utilityBrokerOnly: utilitiesOnly } = await this.buildToolsForMode3(
          request.sessionId,
          request.userId,
          request.selectedGateways,
          request.toolSelections,
          request.agentId,
          {
            assignedSubagents: request.assignedSubagents,
            defaultGateways: request.defaultGateways ?? null
          },
          request.preloadedGatewayTools ?? null,
          request.preloadedGatewayMetadata ?? null,
          request.toolApprovalMode,
          {
            providerSettings: request.providerSettings ?? null,
            processOwner: request.processOwner,
            delegatedBashEnabled: request.delegatedBashEnabled,
            delegatedTypedFileToolsValue: request.delegatedTypedFileToolsValue,
            projectPath: request.projectPath ?? null,
            selectedCliToolIds: request.selectedCliToolIds,
            dcmDisplaySettings: request.dcmDisplaySettings ?? null,
            allowArtifactRuntimeTools: request.allowArtifactRuntimeTools,
            allowFabricControlTools: request.allowFabricControlTools,
            memoryControlsEnabled: request.memoryControlsEnabled,
            whiteboardControlsEnabled: request.whiteboardControlsEnabled,
            whiteboardSettingsSnapshot: request.whiteboardSettingsSnapshot,
            liveFileReadsEnabled: request.liveFileReadsEnabled === true,
            refreshedFileReadsTurn: request.refreshedFileReadsTurn === true,
            dmControlsEnabled: request.dmControlsEnabled,
            scheduleControlsEnabled: request.scheduleControlsEnabled,
            judgeControlsEnabled: request.judgeControlsEnabled,
            workersEnabled: request.workersEnabled,
            controlApprovals: request.controlApprovals ?? null,
            groupMemberRun: request.groupMemberRun === true,
            scopeAgentId: request.scopeAgentId ?? null,
            parentModelId: request.model ?? null,
            parentConnection: request.connection ?? null,
            parentCapabilities: request.modelCapabilities ?? null,
            parentMessageId: request.messageId ?? null,
            p5ApiRun,
            claudePlanResumesHeldRun: request.claudePlanResumesHeldRun === true,
            skillReadDelivery: request.scopeAgentId ? undefined : request.skillReadDelivery,
            abortSignal: request.abortSignal
          }
        )
        toolMaps = maps
        toolsForRequest = request.chatgptPlanLease ? planClientTools(tools, request.chatgptPlanLease) : tools
        toolApprovalsForRequest = toolApprovals
        ephemeralImagesForRequest = ephemeralImages
        initialImageToolIds = carried; imageDeferrals = deferredImages
        bindApiUtilityScope = bindUtilities; utilityBrokerOnly = utilitiesOnly === true

        const openaiTools = await this.buildOpenAITools(request)
        if (openaiTools) {
          toolsForRequest = this.mergeToolSets(toolsForRequest, openaiTools)
        }
      } else {
        logger.debug('[VercelBrain API] Tools disabled for this request')
      }

      const utilityIdentity = { userId: request.userId ?? '', agentId: request.agentId,
        sessionId: request.sessionId, messageId: request.messageId, scopeAgentId: request.scopeAgentId, abortSignal: request.abortSignal }
      const utilities = captureApiUtilities({ identity: utilityIdentity,
        tools: toolsForRequest, approvals: toolApprovalsForRequest })
      const utilityCount = readApiUtilities(utilities.scope, utilityIdentity).length
      if (utilityCount && !bindApiUtilityScope) throw new Error('The native API utility binding is unavailable. Nothing was sent.')
      if (utilityCount && (typeof utilities.tools?.native_batshit_tool_search?.execute !== 'function' ||
          typeof utilities.tools?.native_batshit_tool_use?.execute !== 'function')) {
        throw new Error('The eligible API utility broker is unavailable. Nothing was sent.')
      }
      bindApiUtilityScope?.(utilities.scope)
      toolsForRequest = utilities.tools
      if (utilityBrokerOnly && !utilityCount && toolsForRequest) {
        const removed = pruneUnusedUtilityBrokers(toolsForRequest, utilityIdentity)
        for (const name of removed) delete toolApprovalsForRequest[name]
      }
      const prepared = Object.freeze({ fingerprint: fingerprintRegisteredTools(toolsForRequest), apiUtilityScope: utilities.scope,
        brokerAvailable: Boolean(toolsForRequest?.native_batshit_tool_search && toolsForRequest?.native_batshit_tool_use),
        toolsRegistered: Object.keys(toolsForRequest ?? {}).length > 0 })
      this.preparedApiToolsets.set(prepared, {
        binding: this.toolRegistrationBinding(request), original: request.mcpOriginalPreparation,
        signal: request.abortSignal, lease: request.chatgptPlanLease, skillReadDelivery: request.skillReadDelivery,
        part: request.mcpApiPart, claimed: false, tools: toolsForRequest, maps: toolMaps,
        approvals: toolApprovalsForRequest, images: ephemeralImagesForRequest,
        carried: initialImageToolIds, deferred: imageDeferrals, p5ApiRun, p5Owner
      })
      return prepared
  }

  private async consumeApiToolset(request: NativeModeRequest) {
    const prepared = request.preparedApiToolset ?? await this.prepareApiToolset(request)
    const record = this.preparedApiToolsets.get(prepared)
    if (!record || record.claimed || record.binding !== this.toolRegistrationBinding(request) ||
        record.original !== request.mcpOriginalPreparation || record.part !== request.mcpApiPart ||
        record.signal !== request.abortSignal || record.lease !== request.chatgptPlanLease || record.skillReadDelivery !== request.skillReadDelivery) {
      throw new Error('The prepared API tool owner changed. Nothing was sent.')
    }
    if (fingerprintRegisteredTools(record.tools) !== prepared.fingerprint) throw new Error('The registered API tool definitions changed before dispatch. Nothing was sent.')
    if (request.abortSignal?.aborted) throw request.abortSignal.reason ?? new Error('Stopped before API tool dispatch.')
    record.claimed = true
    return record
  }

  private async buildToolsForMode3(
    sessionId?: string,
    userId?: string,
    selectedGateways?: string[],
    toolSelections?: import('$lib/types/database').MCPToolSelections,
    agentId?: string,
    agentContext?: {
      assignedSubagents?: any[]
      defaultGateways?: string[] | null
    },
    preloadedGatewayTools?: ToolMetadataMap['tools'] | null,
    preloadedGatewayMetadata?: ToolMetadataMap['metadata'] | null,
    toolApprovalMode?: ToolApprovalMode,
    nativeContext?: {
      providerSettings?: Record<string, any> | null
      processOwner?: NativeModeRequest['processOwner']
      delegatedBashEnabled?: boolean
      delegatedTypedFileToolsValue?: boolean | null
      projectPath?: string | null
      selectedCliToolIds?: string[]
      dcmDisplaySettings?: AgentDcmDisplaySettings | null
      allowArtifactRuntimeTools?: boolean
      allowFabricControlTools?: boolean
      whiteboardControlsEnabled?: boolean
      whiteboardSettingsSnapshot?: NativeModeRequest['whiteboardSettingsSnapshot']
      liveFileReadsEnabled?: boolean
      refreshedFileReadsTurn?: boolean
      memoryControlsEnabled?: boolean
      /** SA-113 P2 (DL-113-03): PRIMARY actor + agent `dms_enabled`. */
      dmControlsEnabled?: boolean
      scheduleControlsEnabled?: boolean
      /** SA-120 P2 (DL-120-06): PRIMARY actor + agent `jev_juice_judge_tool`. */
      judgeControlsEnabled?: boolean
      /** SA-111 P4: primary-agent sends only; every delegated run leaves it false. */
      workersEnabled?: boolean
      /** SA-116 P2: send-routed's resolved approval grants and the group-run flag. */
      controlApprovals?: NativeModeRequest['controlApprovals']
      groupMemberRun?: boolean
      /** BL-75: whose skill access governs `native_skill` here, when not `agentId`. */
      scopeAgentId?: string | null
      parentModelId?: string | null
      parentConnection?: ModelConnectionInfo | null
      /** SA-105 P2 (DL-105-06): saved-model capabilities for the image lane gate. */
      parentCapabilities?: ModelCapabilities | null
      /** SA-093 P4: parent send's message id so subagent forensics can land on its snapshot. */
      parentMessageId?: string | null
      p5ApiRun?: P5ApiOriginalRun
      claudePlanResumesHeldRun?: boolean
      skillReadDelivery?: NativeModeRequest['skillReadDelivery']
      abortSignal?: AbortSignal
    }
  ): Promise<{
    bindApiUtilityScope?: (scope?: ApiUtilityScope) => void
    utilityBrokerOnly?: boolean
    tools: Record<string, any> | undefined
    maps: ToolSourceMaps
    toolApprovals: Record<string, NativeToolApprovalPolicy>
    /** SA-105 P2: non-null only on `synthetic_user` lanes. */
    ephemeralImages: EphemeralImageRegistry | null
    initialImageToolIds: string[]
    imageDeferrals: string[]
  }> {
    const tools: Record<string, any> = {}
    const toolApprovals: Record<string, NativeToolApprovalPolicy> = {}
    let bindApiUtilityScope: ((scope?: ApiUtilityScope) => void) | undefined
    let utilityBrokerOnly = false
    // SA-105 P2: resolved below when native tools are built, then handed back to
    // the caller. SA-114 P1 (DL-114-05) made `prepareStep` unconditional, so this registry
    // no longer decides WHETHER the hook exists — only whether the image half of it has
    // anything to inject.
    let ephemeralImages: EphemeralImageRegistry | null = null
    let initialImageToolIds: string[] = []
    let imageDeferrals: string[] = []
    let fetchZipAllowed = false

    // Story 6.4, 6.7c, SA-005: Track metadata for O(1) detection
    const toolMaps: ToolSourceMaps = {
      gatewayTools: new Map<string, GatewayMetadata>(),
      subagentTools: new Map<string, SubagentToolMetadata>()  // Story 6.7c: Subagent metadata
    }

    // Roadmap Lane A: Curated Batshit native tools for API runtime.
    // These do not require user MCP setup and are available whenever tools are enabled.
    if (userId) {
      try {
        // SA-105 (DL-105-06): resolve the run's tool-result image delivery lane
        // ONCE, here, where the provider id and model id are already known, and
        // hand it to the tool layer. `nativeTools` otherwise knows nothing about
        // which provider it is talking to, which is why an Agent Browser
        // screenshot used to be serialized as base64 TEXT on providers whose
        // tool results cannot carry an image.
        //
        // Capabilities are deliberately not threaded yet: `modelAllowsImageInput`
        // treats unknown capabilities as allowed (the same posture attached clips
        // use), so omitting them cannot widen the lane. P2 threads them when the
        // recall path needs the full DL-105-06 resolution.
        const imageDelivery = resolveToolResultImageDelivery({
          providerId: this.resolveRuntimeProviderId(
            nativeContext?.parentModelId ?? '',
            nativeContext?.parentConnection ?? null
          ),
          modelId: nativeContext?.parentModelId ?? null,
          capabilities: nativeContext?.parentCapabilities ?? null
        })
        // Only a text-only lane needs the synthetic channel, so only it gets a
        // registry. SA-114 P1 (DL-114-05): the hook itself is now registered on every
        // streaming run, and DL-105-13's parity promise becomes the stricter one — the
        // composed hook returns `undefined`, the SDK's own "change nothing" answer,
        // whenever neither images nor steers have anything pending, so a run with neither
        // still sends byte-identical requests.
        if (imageDelivery.lane === 'synthetic_user' || nativeContext?.p5ApiRun) {
          ephemeralImages = createEphemeralImageRegistry()
          if (nativeContext?.p5ApiRun) {
            const owner = await import('./appActions/mcp/originalTask')
            owner.bindP5ApiToolImages(nativeContext.p5ApiRun, ephemeralImages)
            const moved = moveP5ImagesForRun(owner, nativeContext.p5ApiRun, ephemeralImages, imageDelivery.lane, nativeContext.claudePlanResumesHeldRun === true)
            initialImageToolIds = moved.ids; imageDeferrals = moved.deferred
          }
        }

        const nativeToolSet = await nativeToolService.buildMode3NativeTools({
          p5ApiRun: nativeContext?.p5ApiRun,
          skillReadDelivery: nativeContext?.scopeAgentId ? undefined : nativeContext?.skillReadDelivery,
          abortSignal: nativeContext?.abortSignal,
          userId,
          agentId: agentId ?? null,
          processOwner: nativeContext?.processOwner,
          delegatedBashEnabled: nativeContext?.delegatedBashEnabled,
          delegatedTypedFileToolsValue: nativeContext?.delegatedTypedFileToolsValue,
          sessionId,
          messageId: nativeContext?.parentMessageId ?? undefined,
          selectedGateways,
          toolSelections,
          selectedCliToolIds: nativeContext?.selectedCliToolIds,
          dcmDisplaySettings: nativeContext?.dcmDisplaySettings ?? null,
          allowArtifactRuntimeTools: nativeContext?.allowArtifactRuntimeTools,
          allowFabricControlTools: nativeContext?.allowFabricControlTools,
          memoryControlsEnabled: nativeContext?.memoryControlsEnabled,
          whiteboardControlsEnabled: nativeContext?.whiteboardControlsEnabled,
          whiteboardSettingsSnapshot: nativeContext?.whiteboardSettingsSnapshot,
          liveFileReadsEnabled: nativeContext?.liveFileReadsEnabled === true,
          refreshedFileReadsTurn: nativeContext?.refreshedFileReadsTurn === true,
          dmControlsEnabled: nativeContext?.dmControlsEnabled,
          scheduleControlsEnabled: nativeContext?.scheduleControlsEnabled,
          judgeControlsEnabled: nativeContext?.judgeControlsEnabled,
          projectPath: nativeContext?.projectPath ?? null,
          providerSettings: nativeContext?.providerSettings ?? null,
          toolApprovalMode,
          // SA-116 P2: the click, and whether a card could ever be answered here.
          controlApprovals: nativeContext?.controlApprovals ?? null,
          groupMemberRun: nativeContext?.groupMemberRun === true,
          scopeAgentId: nativeContext?.scopeAgentId ?? null,
          imageDelivery,
          ephemeralImages,
          // SA-111 P4 (DL-111-09): the worker tool exists only on a primary send. Every
          // other caller of this builder — subagents, workers, artifacts — leaves
          // `workersEnabled` unset, which is what enforces depth 1 (DL-111-12).
          workers: nativeContext?.workersEnabled
            ? {
                enabled: true,
                parentMessageId: nativeContext?.parentMessageId ?? null,
                parentModelId: nativeContext?.parentModelId ?? null,
                parentConnection: nativeContext?.parentConnection ?? null,
                assignedSubagents: agentContext?.assignedSubagents ?? null,
                defaultGateways: agentContext?.defaultGateways ?? null,
                abortSignal: nativeContext?.abortSignal
              }
            : null
        })
        Object.assign(tools, nativeToolSet.tools)
        Object.assign(toolApprovals, nativeToolSet.toolApprovals)
        fetchZipAllowed = nativeToolSet.fetchZipAvailable === true
        bindApiUtilityScope = nativeToolSet.bindApiUtilityScope
        utilityBrokerOnly = nativeToolSet.utilityBrokerOnly === true
      } catch (error) {
        console.error('[VercelBrain API] Failed to build native tools:', error)
        throw error
      }
    }

    // SA-005: Tool Vault loading removed (Tool Vault removed October 2025)

    const processAssignedSubagents = async (subagents: any[]) => {
      const candidates = Array.isArray(subagents) ? subagents : []
      if (candidates.length === 0) {
        return
      }

      // SA-139 R2/R5 (D14): a removed Subagent type (n8n, or the CLI Subagent) is never offered as a tool.
      const managedSubagents = candidates.filter((subagent) =>
        !isRetiredSubagentType(normalizeSubagentType(subagent, subagent?.subagentType))
      )

      if (managedSubagents.length !== candidates.length) {
        console.warn(
          `[API Runtime] Filtered ${candidates.length - managedSubagents.length} Subagent record(s) of a removed type.`
        )
      }

      for (const subagent of managedSubagents) {
        try {
          const subagentType = normalizeSubagentType(subagent, subagent?.subagentType)
          if (isRetiredSubagentType(subagentType)) continue
          const webhookUrl = subagent.webhookUrl || subagent.webhook_url || subagent.workflowName

          const baseName = subagent.id || subagent.name || subagent.displayName || 'subagent'
          const sanitizedName = normalizeToolKey(baseName)
          if (!sanitizedName || Object.hasOwn(tools, sanitizedName)) {
            throw new ApiToolNameCollisionError(sanitizedName)
          }

          // BL-2190: the tool needs only the subagent's description. Compiling the run's whole
          // prompt here read its base prompt and skills on every turn, and a base prompt that
          // cannot be read now fails the CALL (a readable failed result), never this tool list.
          const compiledDescription = typeof subagent.description === 'string' ? subagent.description : ''

          const workflowTool = dynamicTool({
            description: compiledDescription || subagent.description || `Execute ${subagent.displayName || baseName} subagent`,
            inputSchema: z.object({
              chatInput: z.string().describe('Message to send to the subagent'),
              // SA-111 P2 (DL-111-04). Optional so an agent that says nothing gets Josh's
              // chosen default: a clean thread every call.
              thread: z
                .enum(['fresh', 'resume'])
                .optional()
                .describe(
                  "Thread control. 'fresh' (default) starts a clean thread and DISCARDS this subagent's stored thread in this chat. 'resume' continues where the last call left off."
                )
            }),
            execute: async (input) => {
              const baseInput = typeof input === 'object' && input !== null ? { ...input } : {}
              const normalizedUserId =
                (baseInput as any).user_id ??
                (baseInput as any).userId ??
                userId ??
                null
              const normalizedSessionId =
                (baseInput as any).session_id ??
                (baseInput as any).sessionId ??
                sessionId ??
                null
              // The model's input is the Subagent's task, never its parent authority.
              const normalizedParentAgentId = agentId ?? null
              if (!normalizedUserId || !normalizedSessionId) {
                return 'Subagent execution is missing required user/session context.'
              }

              try {
                const result = await executeManagedSubagent({
                  userId: normalizedUserId,
                  sessionId: normalizedSessionId,
                  chatInput: (baseInput as any).chatInput ?? '',
                  subagent: {
                    ...subagent,
                    subagentType
                  },
                  parentAgentId: normalizedParentAgentId,
                  parentMessageId: nativeContext?.parentMessageId ?? null,
                  projectPath: nativeContext?.projectPath ?? null,
                  selectedGateways,
                  toolSelections,
                  selectedCliToolIds: nativeContext?.selectedCliToolIds,
                  dcmDisplaySettings: nativeContext?.dcmDisplaySettings ?? null,
                  defaultGateways: agentContext?.defaultGateways ?? null,
                  toolApprovalMode: 'off',
                  parentModelId: nativeContext?.parentModelId ?? null,
                  parentConnection: nativeContext?.parentConnection ?? null,
                  thread: normalizeSubagentThreadMode((baseInput as any).thread),
                  abortSignal: nativeContext?.abortSignal
                })

                return {
                  kind: 'subagent',
                  // Delegation limits: a run its step limit stopped did its work and is not a
                  // failed call; `status` and the note at the top of its output say it is partial.
                  success: result.status === 'completed' || result.status === 'partial',
                  subagentName: subagent.displayName || subagent.name || sanitizedName,
                  subagentType: result.subagentType,
                  output: result.output,
                  intermediateSteps: result.intermediateSteps,
                  usage: result.usage,
                  modelId: result.modelId,
                  provider: result.provider,
                  durationMs: result.durationMs,
                  status: result.status,
                  thread: result.thread,
                  ...(result.threadNote ? { threadNote: result.threadNote } : {})
                }
              } catch (error) {
                // SA-111 P2 (DL-111-05): a same-subagent collision is an expected, explicit
                // outcome the model can act on — call a different specialist, or wait. Every
                // other failure still throws so it surfaces as a real tool error.
                if (!isSubagentBusyError(error)) throw error
                return {
                  kind: 'subagent',
                  success: false,
                  error: 'subagent_busy',
                  subagentName: subagent.displayName || subagent.name || sanitizedName,
                  subagentType,
                  output: error.message,
                  intermediateSteps: [],
                  usage: null,
                  modelId:
                    subagent.primary_model_name ?? subagent.settings?.primary_model_name ?? null,
                  provider:
                    subagent.primary_model_provider ??
                    subagent.settings?.primary_model_provider ??
                    null,
                  durationMs: 0,
                  status: 'failed',
                  thread: null
                }
              }
            }
          })

          const subMeta: SubagentToolMetadata = {
            isSubagent: true,
            subagentName: subagent.displayName || subagent.name || sanitizedName,
            subagentId: subagent.id || sanitizedName,
            subagentType,
            workflowId: subagent.id || subagent.workflowName || subagent.webhookUrl || sanitizedName,
            webhookUrl: webhookUrl || null,
            avatarUrl: (subagent as any).avatar || (subagent as any).avatarUrl || undefined,
            provider: subagent.primary_model_provider ?? subagent.settings?.primary_model_provider ?? null,
            model: subagent.primary_model_name ?? subagent.settings?.primary_model_name ?? null
          }

          tools[sanitizedName] = markApiUtilityCandidate(workflowTool, 'subagent', {
            userId: userId ?? '', agentId, sessionId, messageId: nativeContext?.parentMessageId,
            scopeAgentId: nativeContext?.scopeAgentId, abortSignal: nativeContext?.abortSignal
          }, { slug: resolveSubagentSlug(subagent), isSubagent: true, subagentId: subMeta.subagentId,
            subagentName: subMeta.subagentName, subagentType: subMeta.subagentType, subagentAvatar: subMeta.avatarUrl })

          toolMaps.subagentTools.set(sanitizedName, subMeta)

          logger.debug(
            `[VercelBrain API] Subagent ready: ${sanitizedName} (${subagent.displayName || baseName})`,
            { webhookUrl: webhookUrl || 'none', subagentId: subagent.id }
          )
        } catch (error) {
          if (error instanceof ApiToolNameCollisionError) throw error
          console.error(
            `[API Runtime] Error loading subagent ${subagent.displayName || subagent.id}:`,
            error
          )
        }
      }
    }

    // A provided list is the authority, an empty one included: a Subagent or Worker run passes
    // `[]` (depth 1; its `agentId` is the PARENT, whose record must not be read here), and a
    // primary send passes its compatible list. Only a caller that passes no list reads the record.
    const providedSubagents = Array.isArray(agentContext?.assignedSubagents)
      ? agentContext.assignedSubagents
      : null

    if (providedSubagents) {
      if (providedSubagents.length > 0) {
        await processAssignedSubagents(providedSubagents)
      }
    } else if (agentId && userId) {
      try {
        const agent = await redis.get(`agent:${agentId}`)
        const subagentIds =
          agent?.assignedSubagents ||
          (agent as any)?.assigned_subagent_ids ||
          []

        if (subagentIds.length > 0) {
          logger.debug(`[VercelBrain API] Loading ${subagentIds.length} assigned subagents for agent ${agentId}`)

          const allSubagents = await this.loadSubagentsByIds(subagentIds, userId)
          if (allSubagents.length === 0) {
            console.warn('[VercelBrain API] Loaded subagents but none were compatible with this managed runtime')
          } else {
            await processAssignedSubagents(allSubagents)
          }
        } else {
          logger.debug(`[VercelBrain API] No assigned subagents found for agent ${agentId}`)
        }
      } catch (error) {
        if (error instanceof ApiToolNameCollisionError) throw error
        console.error('[VercelBrain API] Failed to load assigned subagents:', error)
      }
    }

    // Dynamic MCP-only runtime: direct gateway tool injection is disabled.
    // Kept only for compatibility with preloaded maps (which are expected to be empty).
    if (preloadedGatewayTools && Object.keys(preloadedGatewayTools).length > 0) {
      Object.assign(tools, preloadedGatewayTools)
      if (preloadedGatewayMetadata) {
        toolMaps.gatewayTools = preloadedGatewayMetadata
      }
    }

    // Debug: Log tool names being sent to the LLM for validation
    if (Object.keys(tools).length > 0) {
      logger.debug('[VercelBrain API] Final tools being sent to LLM:', {
        toolNames: Object.keys(tools),
        toolCount: Object.keys(tools).length
      })

      // Validate tool names against OpenAI pattern
      const invalidNames = Object.keys(tools).filter(name => !/^[a-zA-Z0-9_-]+$/.test(name))
      if (invalidNames.length > 0) {
        console.error('[VercelBrain API] INVALID TOOL NAMES detected:', invalidNames)
      }
    }

    const wrappedTools = this.wrapToolsWithReadableModelOutput(tools, {
      userId: userId ?? '',
      sessionId: sessionId ?? '',
      messageId: nativeContext?.parentMessageId ?? '',
      agentId: agentId ?? '',
      fetchZipAllowed
    }, nativeContext?.skillReadDelivery)

    // Story 6.4: Return both tools and metadata maps for detection
    return {
      tools: Object.keys(wrappedTools).length > 0 ? wrappedTools : undefined,
      maps: toolMaps,
      toolApprovals,
      bindApiUtilityScope, utilityBrokerOnly,
      ephemeralImages, initialImageToolIds, imageDeferrals
    }
  }

  private async getProviderManagerForUser(userId?: string | null) {
    if (!userId) {
      return this.providerManager
    }

    try {
      return await ProviderManager.createForUser(userId)
    } catch (error) {
      console.warn('[VercelBrain API] Falling back to default ProviderManager for user', userId, error)
      return this.providerManager
    }
  }

  /**
   * SA-139 (D1, D3): a Claude plan selection runs on the user's own Claude Code. Central admission
   * (P1) comes first, before any process or provider client; its output is all the run reads
   * (`cliModel`, `effort`, `alwaysThinking`), so other saved keys never reach Claude Code. The
   * modules load on demand, keeping Claude Code's status reader out of this module's import graph.
   */
  private async prepareClaudePlanModel(request: NativeModeRequest): Promise<ClaudePlanWiring | null> {
    // D6: a held run the click claimed ends with any continuation that does not take it (review A S3).
    try {
      const wiring = await this.prepareClaudePlanModelUnguarded(request)
      if (!wiring) request.claudePlanHeld?.run.stop()
      return wiring
    } catch (error) {
      request.claudePlanHeld?.run.stop()
      throw error
    }
  }

  private async prepareClaudePlanModelUnguarded(request: NativeModeRequest): Promise<ClaudePlanWiring | null> {
    if (!isClaudePlanSpelling(request.connection)) return null
    // Faye S10: the named consumer and the run's kind must agree, since the owner kind, the sweeps
    // and the delegated step cap key on it; a mislabelled caller never runs as the other kind.
    const consumer = request.claudePlanConsumer
    // A delegated run is one `subagentRunner.ts` started: it names the run's process owner;
    // send-routed's Primary turn does not.
    const delegated = request.processOwner != null
    // Compact runs through its own summary path (`summaryGeneration.ts`, SA-139 P4), never this loop (review N5).
    if (consumer === 'compact') throw new ClaudePlanError('consumer_unsupported', 'Compact does not run through the reply loop. Nothing ran.')
    if ((consumer === 'primary' && delegated) || ((consumer === 'subagent' || consumer === 'worker') && !delegated)) {
      throw new ClaudePlanError('consumer_unsupported', `This Claude plan run was named a ${consumer} run but ${delegated ? 'is' : 'is not'} a delegated run. Nothing ran.`)
    }
    const [{ readClaudePlanReadiness }, runtime] = await Promise.all([import('./claudePlanReadiness'), import('./claudePlanModel')])
    return this.admitClaudePlanModel(request, delegated, readClaudePlanReadiness, runtime)
  }

  private async admitClaudePlanModel(
    request: NativeModeRequest,
    delegated: boolean,
    readClaudePlanReadiness: typeof import('./claudePlanReadiness').readClaudePlanReadiness,
    runtime: typeof import('./claudePlanModel')
  ): Promise<ClaudePlanWiring> {
    const admission = await admitClaudePlanSelection({
      connection: request.connection,
      modelId: request.model,
      settings: request.providerSettings ?? null,
      sampling: claudePlanSamplingToCheck(request.claudePlanSampling),
      consumer: request.claudePlanConsumer ?? 'unnamed',
      readiness: () => readClaudePlanReadiness()
    })
    const model = new runtime.ClaudePlanModel({
      modelId: admission.modelId,
      cliModel: admission.cliModel,
      effort: admission.effort,
      alwaysThinking: admission.alwaysThinking,
      owner: { userId: request.userId ?? null, sessionId: request.sessionId ?? null, agentId: request.agentId ?? null, kind: delegated ? 'delegated' : 'primary' },
      workingDirectory: await runtime.resolveClaudePlanWorkingDirectory({ userId: request.userId, projectPath: request.projectPath }),
      // D6: a Primary reply can end at a card; its run is then held under (chat, reply, version).
      ...(!delegated && request.sessionId && request.messageId && Number.isSafeInteger(request.claudePlanApprovalVersion)
        ? { holdKey: { sessionId: request.sessionId, replyId: request.messageId, version: String(request.claudePlanApprovalVersion) } } : {}),
      ...(request.claudePlanHeld ? { held: request.claudePlanHeld } : {})
    })
    return { model, runtime }
  }

  /**
   * Get model instance - delegates to ProviderManager
   * Includes fallback support and caching
   */
  private async getModel(
    modelName: string,
    connection?: ModelConnectionInfo | null,
    userId?: string | null,
    taggedReasoningTagName?: NativeModeRequest['taggedReasoningTagName'],
    observeInput?: (params: { prompt: unknown; tools?: readonly any[] }) => void,
    planLease?: PlanLease,
    dispatchGate?: ModelDispatchGate,
    setup?: PreparedAgentSetup,
    claudePlan?: ClaudePlanModel | null,
  ): Promise<LanguageModel> {
    const transport = connection?.type
    const service = connection?.service ?? undefined
    // SA-139: any Claude plan spelling (id or service) runs only on its admitted model, never through
    // ProviderManager (an id-only selection would otherwise reach the paid Anthropic key).
    if (isClaudePlanSpelling(connection) && !claudePlan) throw claudePlanNotWiredError()
    let model: LanguageModel = claudePlan ? claudePlan : isPlanSelection(connection) ? planModelForLease(planLease, userId, connection, modelName) : (await this.getProviderManagerForUser(userId)).getModel(modelName, {
      transport,
      service,
      connectionId: connection?.id
    })
    if (!claudePlan && !isPlanSelection(connection) && typeof model === 'object' && model.specificationVersion === 'v4') model = guardResponsesTerminal(model)
    if (observeInput || dispatchGate || setup) {
      if (typeof model === 'object' && model !== null && model.specificationVersion === 'v4') {
        // Innermost: observe the exact provider-call parameters, before output-only middleware.
        // SA-137: the last authority check runs first, so a refused request is never sent or observed.
        model = wrapLanguageModel({ model, middleware: {
          specificationVersion: 'v4',
          wrapStream: async ({ params, doStream }) => {
            if (dispatchGate) await dispatchGate.beforeRequest()
            if (setup) agentSetupCache.commit(setup)
            if (observeInput) {
              try { observeInput(params) } catch {
                console.error('[VercelBrain API] Picture input observer failed; no delivery evidence is available')
                try { observeInput({ prompt: undefined }) } catch { /* Observation never fails the request. */ }
              }
            }
            const calledAt = Date.now()
            const streamed = await doStream()
            dispatchGate?.requestSent()
            if (setup) {
              try { agentSetupCache.modelCalled(setup, calledAt) } catch {
                // The request already left. A retired cache owner cannot publish
                // activity, and cache bookkeeping cannot erase a delivered reply.
              }
            }
            return streamed
          }
        } })
      } else {
        if (dispatchGate) {
          // No middleware can hold this request back, so it is not sent at all.
          throw new Error('Batshit could not check file sharing right before this model request, so it sent nothing. This model needs an AI SDK v4 provider.')
        }
        observeInput?.({ prompt: undefined })
        console.error('[VercelBrain API] Picture input observation requires a v4 model; its record stays incomplete')
      }
    }
    if (!taggedReasoningTagName) return model

    if (
      typeof model !== 'object' ||
      model === null ||
      model.specificationVersion !== 'v4'
    ) {
      throw new Error(
        `[VercelBrain API] Tagged reasoning extraction requires an AI SDK provider specification v4 model instance for "${modelName}" (got "${(model as any)?.specificationVersion ?? 'unknown'}"). A mixed AI SDK major / provider-package tree is not supported — every @ai-sdk provider must be on its AI SDK 7 major.`,
      )
    }

    return wrapLanguageModel({
      model,
      middleware: extractReasoningMiddleware({
        tagName: taggedReasoningTagName,
      }),
    })
  }

  /**
   * Extract provider name from model name
   * Delegates to ProviderManager's internal logic
   */
  private getProviderName(modelName: string): string {
    // Parse model name to extract provider
    const parsed = modelName.includes('/')
      ? modelName.split('/')[0]
      : modelName.includes('claude') ? 'anthropic'
      : modelName.includes('gpt') ? 'openai'
      : modelName.includes('gemini') ? 'google'
      : modelName.includes('llama') || modelName.includes('mixtral') ? 'groq'
      : modelName.includes('mistral') ? 'mistral'
      : 'anthropic' // Default fallback

    return parsed
  }

  /**
   * SA-105 P2 (DL-105-03) — the synthetic image lane.
   *
   * Some providers serialize a tool result's `content` output with
   * `JSON.stringify`, which turns an image into base64 TEXT: expensive, and
   * unreadable to the model. On those lanes `toModelOutput` registers the bytes
   * instead of returning them, and this hook appends them as one ordinary user
   * message before the next step — the shape every vision model already reads.
   *
   * Three properties were confirmed live on ai@7.0.77: the injected message
   * reaches the model, it carries forward to later steps, and it never appears
   * in `response.messages` — so it cannot reach the persistence write on its own.
   * The strip in `send-routed` still covers it as defence in depth.
   */
  private buildEphemeralImagePrepareStep(registry: EphemeralImageRegistry, initialToolIds: readonly string[] = [], deferrals: readonly string[] = []) {
    let initial = true
    return ({ messages, steps }: { messages: any[]; steps: any[] }) => {
      const previous = steps[steps.length - 1]
      const initialIds = initial ? initialToolIds : []
      const initialDeferrals = initial ? deferrals : []
      initial = false
      if (!previous && initialIds.length === 0 && initialDeferrals.length === 0) return undefined

      const pending: EphemeralImageRegistryEntry[] = []
      const completed = (previous?.content ?? []).filter((part: any) => part?.type === 'tool-result').map((part: any) => part.toolCallId)
      for (const id of new Set([...initialIds, ...completed])) {
        const entry = registry.take(id)
        // Native images already travel in that step's real tool result. Taking
        // custody prevents a later original handoff from replaying them.
        if (entry && entry.deliveryLane !== 'tool_result') pending.push(entry)
      }
      if (pending.length === 0 && initialDeferrals.length === 0) return undefined

      // Each entry names its own purpose (recalled memory media, an Agent
      // Browser screenshot, …): the hook is feature-neutral and must not
      // describe every image as a memory (SA-105 P5, DL-105-11).
      const injected = pending
        .map((entry) =>
          buildEphemeralImageUserMessage({
            source: entry.source,
            purpose: entry.purpose ?? null,
            images: entry.images
          })
        )
        .filter((message): message is NonNullable<typeof message> => message !== null)
      if (initialDeferrals.length) injected.push({ role: 'user', content: [{ type: 'text', text: initialDeferrals.join('\n') }] })
      if (injected.length === 0) return undefined

      return { messages: [...messages, ...injected] }
    }
  }

  /**
   * SA-114 P1 (DL-114-05) — the ONE `prepareStep` an API run registers.
   *
   * Before this story the hook existed only on SA-105's text-only image lanes, which is
   * why DL-105-13 could promise "call shape unchanged" for every other run. It is now
   * registered on EVERY streaming run, and the promise becomes the stricter one it should
   * always have been: the hook is always present and returns `undefined` — the SDK's own
   * "change nothing" answer — whenever neither feature has anything pending. A run with no
   * images and no steers therefore sends byte-identical requests, which is what the
   * updated parity test pins.
   *
   * Order is deliberate: ephemeral images first (they belong to the tool result that just
   * finished), then the steer, so the user's mid-reply words are the last thing the model
   * reads before its next step.
   *
   * P0 measured the three properties this depends on, live on `ai@7.0.77`: the injected
   * message reaches the model, it carries forward to later steps, and it never appears in
   * `response.messages` — so Batshit, not the SDK, owns persisting it (DL-114-04). P0 also
   * measured that `stepNumber === steps.length`, and that a reply with NO tool step calls
   * this hook exactly once (with `steps` empty), which is why a steer typed during a
   * text-only reply can only be promoted (DL-114-07).
   *
   * BL-77 adds the tool loop's cache point: on every step, the hook also returns
   * `toolLoopProviderOptions` (the cache policy's `stepProviderOptions`) as that step's
   * `providerOptions`. The SDK merges them into that one step's call options — unlike
   * returned messages, they are not carried forward — and the provider sends them as the
   * request-level cache point Anthropic places on the last block, so each step reads the
   * previous step's whole request from the cache instead of paying for it again. It is not
   * a message: nothing is added to, moved in, or removed from what the model reads, and a
   * steer stays the last thing it reads. Lanes without Anthropic cache control get no
   * options, so their requests are unchanged.
   *
   * BL-1976 (Josh, 2026-10-21): the point starts on the FIRST step. Until then it started on the
   * second, so a one-step reply paid no write nobody reads, but every longer reply was billed the
   * whole step-start message (history, open zips, the DCM) fresh on its first call and then wrote
   * it on the second (SA-126's saved usage: 1,306 of 1,306 later calls read the call before
   * from the third call on). Now the first call writes it and the second reads it; a one-step
   * reply pays one write nobody reads. An approval resume follows the same rule (BL-200 kept
   * it from the second call, because a resume then recompiled the one user message and its
   * first-call point was read only inside the run): its first call writes, its second reads.
   *
   * BL-183: `processNativeMode` (API Subagents and Workers) registers this same hook with
   * `takeSteers: null`.
   *
   * BL-185: on OpenRouter the tail point is not a call option but an explicit marker on the
   * last message's last part (`toolLoopTailMarker`), because OpenRouter's Amazon Bedrock route
   * accepts the request-level field and ignores it. It is placed LAST, after the images and the
   * steer, so it lands on whatever the model reads last. Returned messages are carried to the
   * next step, so `placeToolLoopTailMarker` strips the previous step's marker first: a request
   * carries the system point and one tail point, and the SDK's own response objects, which
   * send-routed saves and replays, are never marked (only copies are). On the first step there
   * is no loop message yet, so a copy of the step-start message (the last one Batshit compiled,
   * kept here as the first step received it) takes the marker, and the next step puts the
   * original back (BL-1976).
   */
  private buildTurnPrepareStep(options: {
    ephemeralImages: EphemeralImageRegistry | null
    initialImageToolIds?: readonly string[]
    imageDeferrals?: readonly string[]
    /**
     * Takes every steer waiting for THIS turn and marks it delivered, or returns `[]`.
     * send-routed supplies it for primary API turns only: a subagent, a Worker, or an
     * artifact completion is not the user's turn, so it never receives one (DL-114-09).
     */
    takeSteers: ((step: number) => DeliveredSteer[]) | null
    /** BL-77: the cache policy's `stepProviderOptions`, or null on lanes that get none. */
    toolLoopProviderOptions: Record<string, Record<string, any>> | null
    /**
     * BL-185: the cache policy's `toolLoopTailMarker` and the number of messages Batshit compiled
     * (never marked), or null on lanes that get none.
     */
    toolLoopTailMarker: { marker: ToolLoopTailMarker; firstLoopIndex: number } | null
    registerUserSource?: (source: UserInputSource) => void
    refreshOpenSkills?: () => Promise<SkillDcmUpdate | undefined>
    registerDcmUpdate?: (update: SkillDcmUpdate) => void
    checkSkillContext?: (messages: any[]) => void
    /**
     * SA-139 P3 Part 2 (D5, D9): the reply's Claude plan model. Once Claude Code holds the compiled
     * opening, a skill update and the steers are handed to it explicitly (append-only, between steps),
     * and the SDK prompt is left as Claude Code read it.
     */
    claudePlan?: ClaudePlanModel | null
  }) {
    const images = options.ephemeralImages
      ? this.buildEphemeralImagePrepareStep(options.ephemeralImages, options.initialImageToolIds, options.imageDeferrals)
      : null
    const toolLoopProviderOptions = options.toolLoopProviderOptions
    const toolLoopTailMarker = options.toolLoopTailMarker
    // BL-1976: the last compiled message, as the first step received it (see the marker above).
    let stepStart: any = null

    return async ({ messages, steps }: { messages: any[]; steps: any[] }) => {
      const update = await options.refreshOpenSkills?.()
      const native = options.claudePlan?.holdsOpening ? options.claudePlan : null
      if (update && native) {
        // Not a prompt edit, so not registered as one (the picture-address record would expect the edited
        // prompt); the note reaches that record as one of the run's native pieces (review B S1).
        native.addSkillUpdate(readSkillDcmUpdate(update).context)
      } else if (update) {
        messages = applySkillDcmUpdate(messages, update)
        if (stepStart) {
          const content = typeof stepStart.content === 'string' ? stepStart.content : Array.isArray(stepStart.content)
            ? stepStart.content.filter((part: any) => part?.type === 'text').map((part: any) => part.text).join('') : ''
          if (content.includes(readSkillDcmUpdate(update).before)) stepStart = applySkillDcmUpdate([stepStart], update)[0]
        }
        options.registerDcmUpdate?.(update)
      }
      if (toolLoopTailMarker && steps.length === 0) stepStart = messages[toolLoopTailMarker.firstLoopIndex - 1] ?? null
      const base = images ? images({ messages, steps }) : undefined
      const injected: any[] = base ? [...base.messages] : [...messages]
      let changed = Boolean(base) || (Boolean(update) && !native)

      const previous = steps[steps.length - 1]
      // A steer lands at a TOOL boundary and nowhere else — that is the promise the whole
      // story rests on, and it is the same rule both CLI lanes follow. A step that
      // produced no tool result means the model has stopped calling tools and the reply is
      // about to end, so anything still waiting is promoted instead.
      // BL-450: a step whose call failed (a `tool-error`) is a tool boundary too.
      const previousHadToolResult = stepContentReachedToolBoundary(previous?.content)

      if (options.takeSteers && previousHadToolResult) {
        const steers = options.takeSteers(steps.length)
        if (steers.length > 0) {
          options.registerUserSource?.(steerInputSource(steers))
          if (native) {
            native.addSteers(steers)
          } else {
            injected.push({
              role: 'user',
              content: [{ type: 'text', text: buildSteerInjectionText(steers) }]
            })
            changed = true
          }
        }
      }

      // Complete newly-opened guidance is never silently cut to fit a later model call.
      // Use the SAME resolved model limit/reserve as accepted-send preflight. On the Claude plan
      // connection the check counts what the native run holds (D5): the prompt plus every addition.
      options.checkSkillContext?.(native ? [...injected, ...native.nativeAdditionsForBudget()] : injected)

      // BL-77: a fresh copy per step, so the SDK's per-step merge never shares Batshit's object.
      // BL-1976: every step, the first included.
      const providerOptions = toolLoopProviderOptions ? structuredClone(toolLoopProviderOptions) : undefined

      // BL-185: last, so the marker lands on whatever the model reads last (a steer included).
      let stepMessages = injected
      if (toolLoopTailMarker) {
        stepMessages = placeToolLoopTailMarker(
          injected,
          toolLoopTailMarker.firstLoopIndex,
          toolLoopTailMarker.marker,
          stepStart
        )
        // It hands back the same array when it had nothing to mark.
        if (stepMessages !== injected) changed = true
      }

      if (!changed && !providerOptions) return undefined
      return {
        ...(changed ? { messages: stepMessages } : {}),
        ...(providerOptions ? { providerOptions } : {})
      }
    }
  }

  private resolveRuntimeProviderId(
    modelName: string,
    connection?: ModelConnectionInfo | null
  ): string {
    const connectionType = connection?.type ?? null
    const connectionId = (connection?.id ?? '').trim().toLowerCase()
    const service = (connection?.service ?? '').trim()

    if (connectionType === 'openrouter' || connectionId === 'openrouter') {
      return 'openrouter'
    }
    if (connectionType === 'vercel-gateway' || connectionId === 'vercel-gateway') {
      return 'vercel-gateway'
    }
    if (connectionType === 'direct') {
      if (service) return service
      if (connectionId.startsWith('direct:')) {
        const parsed = connectionId.slice('direct:'.length)
        if (parsed) return parsed
      }
    }

    return this.getProviderName(modelName)
  }

  private async loadActiveClipIds(sessionId?: string | null): Promise<Set<string> | null> {
    if (!sessionId) return null

    try {
      const state = await redis.get(`session:${sessionId}:clip_state`)
      if (!state || !Array.isArray((state as any).clips)) {
        return new Set()
      }
      const active = (state as any).clips
        .filter((clip: any) => clip?.clipId)
        .map((clip: any) => clip.clipId)
      return new Set(active)
    } catch (error) {
      console.warn('[VercelBrain API] Failed to load session clip state:', error)
      return new Set()
    }
  }

  private hasImageInputs(
    messages: ThinkRequest['messages'],
    images?: ThinkRequest['images']
  ): boolean {
    if (Array.isArray(images) && images.length > 0) return true
    if (!Array.isArray(messages)) return false

    for (const msg of messages) {
      const content = (msg as any)?.content
      if (Array.isArray(content)) {
        for (const part of content) {
          if (!part || typeof part !== 'object') continue
          if (part.type === 'image' || part.type === 'image_url' || part.type === 'file') return true
          if (part.image_url?.url || part.image || part.data) return true
        }
      }
    }

    return false
  }

  private async resolveImageUrlPolicy(_userId?: string | null): Promise<ImageUrlPolicy> {
    return 'auto'
  }

  private async downloadExternalAsset(url: URL): Promise<{ data: Uint8Array; mediaType: string | undefined }> {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to download asset: ${response.status} ${response.statusText}`)
    }
    const buffer = await response.arrayBuffer()
    const mediaType = response.headers.get('content-type') ?? undefined
    return { data: new Uint8Array(buffer), mediaType }
  }

  private async resolveDownloadHandler(
    request: NativeModeRequest,
    allowList?: Set<string>
  ): Promise<Experimental_DownloadFunction | undefined> {
    const allowUrls = allowList ?? new Set<string>()
    const hasImages = this.hasImageInputs(request.messages, request.images)
    const hasAllowList = allowUrls.size > 0

    if (!hasImages && !hasAllowList) {
      return undefined
    }

    const policy = await this.resolveImageUrlPolicy(request.userId)
    const externalOnly = policy === 'external_only'

    if (!externalOnly && !hasAllowList) {
      return undefined
    }

    const providerLabel = this.getProviderName(request.model ?? '')

    return async (requests) => {
      if (!Array.isArray(requests) || requests.length === 0) return []

      const dataUrl = requests.find((entry) => entry.url?.protocol === 'data:')
      if (externalOnly && dataUrl) {
        throw new Error(
          'Image URLs are set to External Only, but a local/base64 image was attached. ' +
            'Re-upload with External Only storage or switch Clip storage to Local.'
        )
      }

      const results: Array<{ data: Uint8Array; mediaType: string | undefined } | null> = []

      for (const entry of requests) {
        const url = entry.url.toString()
        if (allowUrls.has(url)) {
          results.push(null)
          continue
        }

        if (entry.isUrlSupportedByModel) {
          results.push(null)
          continue
        }

        if (externalOnly) {
          throw new Error(
            `Image URLs are set to External Only, but the active provider (${providerLabel}) ` +
              'does not accept external image URLs. Switch to a provider/transport that supports URL inputs ' +
              'or change Clip storage to Local.'
          )
        }

        const downloaded = await this.downloadExternalAsset(entry.url)
        results.push(downloaded)
      }

      return results
    }
  }

  private isGeminiDirect(request: NativeModeRequest): boolean {
    const transport = request.connection?.type ?? 'direct'
    if (transport !== 'direct') return false
    const provider = this.getProviderName(request.model ?? '').toLowerCase()
    return provider === 'google'
  }

  private logGeminiPayloadSummary(
    stage: string,
    messages: ModelMessage[],
    request: NativeModeRequest,
    fileUris: Set<string>
  ) {
    if (!this.isGeminiDirect(request)) return
    if (!this.hasImageInputs(request.messages, request.images)) return

    const summarizePart = (part: any) => {
      if (!part || typeof part !== 'object') {
        return { type: typeof part }
      }

      const entry: Record<string, any> = {
        type: part.type,
        mediaType: part.mediaType
      }

      if (part.type === 'text') {
        entry.textLength = typeof part.text === 'string' ? part.text.length : 0
        return entry
      }

      if (part.type === 'file' || part.type === 'image') {
        const data = part.type === 'image' ? part.image : part.data
        if (data instanceof URL) {
          entry.dataKind = 'url'
          entry.url = data.toString().slice(0, 180)
          entry.protocol = data.protocol
        } else if (typeof data === 'string') {
          entry.dataKind = 'string'
          entry.prefix = data.slice(0, 32)
          entry.length = data.length
        } else if (data instanceof Uint8Array) {
          entry.dataKind = 'bytes'
          entry.byteLength = data.byteLength
        } else if (data instanceof ArrayBuffer) {
          entry.dataKind = 'arraybuffer'
          entry.byteLength = data.byteLength
        } else {
          entry.dataKind = typeof data
        }
        return entry
      }

      return entry
    }

    const summaries = messages.map((message, index) => {
      if (Array.isArray(message.content)) {
        return {
          index,
          role: message.role,
          partCount: message.content.length,
          parts: message.content.map(summarizePart)
        }
      }
      return {
        index,
        role: message.role,
        contentType: typeof message.content,
        contentLength: typeof message.content === 'string' ? message.content.length : undefined
      }
    })

    logger.debug('[VercelBrain API] Gemini payload summary', {
      stage,
      model: request.model,
      policy: undefined,
      providerOptions: request.providerOptions?.google ?? undefined,
      fileUriCount: fileUris.size,
      fileUris: Array.from(fileUris).map((uri) => uri.slice(0, 180)),
      messages: summaries
    })
  }

  /**
   * SA-102 P2: the OTHER half of the reasoning-model prefix trap.
   *
   * This used to infer the provider from the MODEL NAME alone
   * (`getProviderName`, which returns 'openai' for anything containing "gpt"),
   * so a local model served as `gpt-5-local-gguf` on a direct llama.cpp
   * connection was treated as OpenAI: `buildGenerationSettings` dropped its
   * temperature, top_p and both penalties, and `buildOpenAITools` tried to
   * attach OpenAI's hosted tools to it. Moving local runtimes off
   * `createOpenAI` fixed the SDK's half of the trap (the `system` role is no
   * longer rewritten to `developer`); this fixes Batshit's half.
   *
   * The connection's service is authoritative when it names one — a model
   * NAMED gpt-5 served by llama.cpp is not OpenAI. Model-name inference
   * survives only as the last resort, for a direct connection that names
   * neither a service nor a `direct:<service>` id, which is how legacy presets
   * behaved before and after.
   */
  private isOpenAIDirect(request: NativeModeRequest): boolean {
    const transport = request.connection?.type ?? 'direct'
    if (transport !== 'direct') return false
    return (
      this.resolveRuntimeProviderId(
        request.model ?? '',
        request.connection ?? null
      ).toLowerCase() === 'openai'
    )
  }

  private buildGenerationSettings(request: NativeModeRequest): Record<string, unknown> {
    // Explicit user settings are checked at the owning selection boundary.
    // Operational API defaults (including max output) are not plan wire fields;
    // the Claude plan (SA-139 D12) has no sampling or output-limit wire at all.
    if (request.chatgptPlanLease || isClaudePlanSpelling(request.connection)) return {}
    const settings: Record<string, unknown> = {}

    if (typeof request.maxTokens === 'number') {
      settings.maxOutputTokens = request.maxTokens
    }

    const omitSamplingControls =
      this.isOpenAIDirect(request) &&
      isOpenAIReasoningParameterRestrictedModelId(request.model ?? '')

    if (omitSamplingControls) {
      const omitted = [
        ['temperature', request.temperature],
        ['topP', request.topP],
        ['topK', request.topK],
        ['presencePenalty', request.presencePenalty],
        ['frequencyPenalty', request.frequencyPenalty],
        ['seed', request.seed],
        ['stopSequences', request.stopSequences]
      ]
        .filter(([, value]) => value !== undefined)
        .map(([name]) => name)

      if (omitted.length > 0) {
        logger.debug('[VercelBrain API] Omitted unsupported OpenAI reasoning sampling settings', {
          model: request.model,
          omitted
        })
      }

      return settings
    }

    if (typeof request.temperature === 'number') {
      settings.temperature = request.temperature
    }
    if (typeof request.topP === 'number') {
      settings.topP = request.topP
    }
    if (typeof request.topK === 'number') {
      settings.topK = request.topK
    }
    if (typeof request.presencePenalty === 'number') {
      settings.presencePenalty = request.presencePenalty
    }
    if (typeof request.frequencyPenalty === 'number') {
      settings.frequencyPenalty = request.frequencyPenalty
    }
    if (typeof request.seed === 'number') {
      settings.seed = request.seed
    }
    if (Array.isArray(request.stopSequences)) {
      settings.stopSequences = request.stopSequences
    }

    return settings
  }

  private resolveOpenAISettings(providerSettings?: Record<string, any> | null): Record<string, any> {
    if (!providerSettings || typeof providerSettings !== 'object') {
      return {}
    }
    const nested = (providerSettings as any).openai
    if (nested && typeof nested === 'object') {
      return { ...(providerSettings as Record<string, any>), ...(nested as Record<string, any>) }
    }
    return providerSettings as Record<string, any>
  }

  private parseBooleanSetting(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase()
      if (['true', 'enabled', 'on', 'yes'].includes(normalized)) return true
      if (['false', 'disabled', 'off', 'no'].includes(normalized)) return false
    }
    return undefined
  }

  private getOpenAIToolToggle(settings: Record<string, any>, ...keys: string[]): boolean | undefined {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(settings, key)) {
        const parsed = this.parseBooleanSetting(settings[key])
        if (parsed !== undefined) return parsed
      }
    }
    return undefined
  }

  private coerceStringArray(value: unknown): string[] {
    if (!value) return []
    if (Array.isArray(value)) {
      return value
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry) => entry.length > 0)
    }
    if (typeof value === 'string') {
      return value
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    }
    return []
  }

  private parseDataUrl(dataUrl: string): { data: Uint8Array; mediaType: string } | null {
    if (!dataUrl.startsWith('data:')) return null
    const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl)
    if (!match) return null
    const mediaType = match[1] || 'application/octet-stream'
    const base64 = match[2] || ''
    try {
      const buffer = Buffer.from(base64, 'base64')
      return { data: new Uint8Array(buffer), mediaType }
    } catch (error) {
      return null
    }
  }

  private normalizeGeminiFileUri(uri: string): string {
    if (uri.startsWith('files/')) {
      return `https://generativelanguage.googleapis.com/v1beta/${uri}`
    }
    return uri
  }

  private async fetchGeminiFileMetadata(
    apiKey: string,
    fileName: string
  ): Promise<{ name?: string; uri?: string; state?: string; error?: any; mimeType?: string }> {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}`, {
      headers: {
        'x-goog-api-key': apiKey
      }
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Gemini Files API get failed: ${response.status} ${detail}`)
    }

    const payload = await response.json().catch(() => ({}))
    const file = payload?.file ?? {}
    return {
      name: typeof file?.name === 'string' ? file.name : undefined,
      uri: typeof file?.uri === 'string' ? file.uri : undefined,
      state: typeof file?.state === 'string' ? file.state : undefined,
      error: file?.error,
      mimeType: typeof file?.mimeType === 'string' ? file.mimeType : undefined
    }
  }

  private async waitForGeminiFileActive(options: {
    apiKey: string
    name?: string
    uri?: string
    state?: string
  }): Promise<{ name?: string; uri: string }> {
    const { apiKey } = options
    let name = options.name
    let uri = options.uri
    let state = options.state

    if (!name && uri) {
      try {
        const parsed = new URL(uri)
        const match = parsed.pathname.match(/\/files\/[^/]+/)
        if (match) {
          name = match[0].replace(/^\/+/, '')
        }
      } catch {
        name = undefined
      }
    }

    if (state === 'ACTIVE' && uri) {
      return { name, uri: this.normalizeGeminiFileUri(uri) }
    }

    const maxAttempts = 6
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (!name) break

      const info = await this.fetchGeminiFileMetadata(apiKey, name)
      state = info.state
      uri = info.uri ?? uri

      if (state === 'ACTIVE' && uri) {
        return { name, uri: this.normalizeGeminiFileUri(uri) }
      }

      if (state === 'FAILED') {
        const errorDetail = info.error ? ` (${JSON.stringify(info.error)})` : ''
        throw new Error(`Gemini file processing failed${errorDetail}`)
      }

      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
    }

    if (uri) {
      return { name, uri: this.normalizeGeminiFileUri(uri) }
    }

    throw new Error('Gemini file is still processing. Please retry.')
  }

  private isGeminiFileUri(url: URL): boolean {
    const hostname = url.hostname.toLowerCase()
    const pathSegments = url.pathname.split('/').filter(Boolean)
    return hostname === 'generativelanguage.googleapis.com' && pathSegments.includes('files')
  }

  private hashBytes(data: Uint8Array): string {
    return createHash('sha256').update(data).digest('hex')
  }

  private buildGeminiFileCacheKey(source: string): string {
    const sourceHash = createHash('sha256').update(source).digest('hex')
    return `${GEMINI_FILE_CACHE_PREFIX}:v2:${sourceHash}`
  }

  private async readGeminiFileCache(cacheKey: string): Promise<GeminiFileCacheEntry | null> {
    try {
      const cached = await redis.get(cacheKey)
      if (!cached || typeof cached !== 'object') return null
      const entry = cached as GeminiFileCacheEntry
      if (!entry.fileUri || typeof entry.fileUri !== 'string') return null
      return entry
    } catch (error) {
      console.warn('[VercelBrain API] Failed to read Gemini file cache:', error)
      return null
    }
  }

  private async writeGeminiFileCache(cacheKey: string, entry: GeminiFileCacheEntry): Promise<void> {
    try {
      await redis.execute(async (client) => {
        await client.set(cacheKey, JSON.stringify(entry), { EX: GEMINI_FILE_CACHE_TTL_SECONDS })
      })
    } catch (error) {
      console.warn('[VercelBrain API] Failed to write Gemini file cache:', error)
    }
  }

  private async uploadGeminiFile(options: {
    data: Uint8Array
    mediaType: string
    displayName: string
    apiKey: string
  }): Promise<string> {
    const { data, mediaType, displayName, apiKey } = options
    const startResponse = await fetch('https://generativelanguage.googleapis.com/upload/v1beta/files', {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(data.byteLength),
        'X-Goog-Upload-Header-Content-Type': mediaType,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        file: {
          display_name: displayName
        }
      })
    })

    if (!startResponse.ok) {
      const detail = await startResponse.text().catch(() => '')
      throw new Error(`Gemini Files API start upload failed: ${startResponse.status} ${detail}`)
    }

    const uploadUrl = startResponse.headers.get('x-goog-upload-url')
    if (!uploadUrl) {
      throw new Error('Gemini Files API did not return an upload URL')
    }

    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Length': String(data.byteLength),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize'
      },
      body: toOwnedBytes(data)
    })

    if (!uploadResponse.ok) {
      const detail = await uploadResponse.text().catch(() => '')
      throw new Error(`Gemini Files API upload failed: ${uploadResponse.status} ${detail}`)
    }

    const payload = await uploadResponse.json().catch(() => ({}))
    const fileName = payload?.file?.name
    const fileUri = payload?.file?.uri
    const fileState = payload?.file?.state

    const resolved = await this.waitForGeminiFileActive({
      apiKey,
      name: typeof fileName === 'string' ? fileName : undefined,
      uri: typeof fileUri === 'string' ? fileUri : undefined,
      state: typeof fileState === 'string' ? fileState : undefined
    })

    if (!resolved.uri) {
      throw new Error('Gemini Files API upload succeeded but no file uri was returned')
    }

    return String(resolved.uri)
  }

  private async convertGeminiFileParts(
    messages: ModelMessage[],
    request: NativeModeRequest
  ): Promise<{ messages: ModelMessage[]; fileUris: Set<string> }> {
    if (!this.isGeminiDirect(request)) {
      return { messages, fileUris: new Set() }
    }

    const access = await resolveProviderAccess(request.userId)
    const apiKey = access.apiKeys.google
    if (!apiKey) {
      console.warn('[VercelBrain API] Gemini direct selected but no Google API key found')
      return { messages, fileUris: new Set() }
    }

    const policy = await this.resolveImageUrlPolicy(request.userId)
    const forceExternal = policy === 'external_only'
    const fileUris = new Set<string>()
    const updated: ModelMessage[] = []

    for (const message of messages) {
      if (message.role !== 'user' || !Array.isArray(message.content)) {
        updated.push(message)
        continue
      }

      let changed = false
      const nextContent: any[] = []

      for (const part of message.content as any[]) {
        if (!part || typeof part !== 'object') {
          nextContent.push(part)
          continue
        }

        if (part.type !== 'image' && part.type !== 'file') {
          nextContent.push(part)
          continue
        }

        const rawData = part.type === 'image' ? part.image : part.data
        const isImagePart = part.type === 'image'
        let mediaType = part.mediaType

        let url: URL | null = null
        let data: Uint8Array | null = null

        if (rawData instanceof URL) {
          url = rawData
        } else if (typeof rawData === 'string') {
          if (rawData.startsWith('data:')) {
            const parsed = this.parseDataUrl(rawData)
            if (parsed) {
              data = parsed.data
              mediaType = mediaType || parsed.mediaType
            }
          } else if (/^https?:\/\//i.test(rawData)) {
            try {
              url = new URL(rawData)
            } catch {
              url = null
            }
          }
        } else if (rawData instanceof Uint8Array) {
          data = rawData
        } else if (rawData instanceof ArrayBuffer) {
          data = new Uint8Array(rawData)
        } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(rawData)) {
          data = new Uint8Array(rawData)
        }

        let cacheKey: string | null = null
        let cacheHit: GeminiFileCacheEntry | null = null

        if (url) {
          if (this.isGeminiFileUri(url)) {
            fileUris.add(url.toString())
            nextContent.push(part)
            continue
          }

          cacheKey = this.buildGeminiFileCacheKey(`url:${url.toString()}`)
          cacheHit = await this.readGeminiFileCache(cacheKey)

          if (cacheHit?.fileUri) {
            const mimeType = mediaType || cacheHit.mediaType || 'application/octet-stream'
            const nextPart = {
              ...part,
              ...(part.type === 'image'
                ? { image: new URL(cacheHit.fileUri), mediaType: mimeType }
                : { data: new URL(cacheHit.fileUri), mediaType: mimeType })
            }

            fileUris.add(cacheHit.fileUri)
            nextContent.push(nextPart)
            changed = true
            continue
          }

          const downloaded = await this.downloadExternalAsset(url)
          data = downloaded.data
          if (!mediaType || mediaType === 'image/*') {
            mediaType = downloaded.mediaType || mediaType
          }
        }

        if (!data) {
          nextContent.push(part)
          continue
        }

        const resolvedMediaType =
          mediaType && mediaType !== 'image/*'
            ? mediaType
            : isImagePart
              ? 'image/jpeg'
              : undefined

        if (!forceExternal && url === null && data) {
          // Inline bytes are allowed for structured image/file parts.
          const inlinePart = {
            ...part,
            ...(part.type === 'image' ? { image: data } : { data }),
            ...(resolvedMediaType ? { mediaType: resolvedMediaType } : {})
          }
          nextContent.push(inlinePart)
          changed = true
          continue
        }

        const displayName =
          (url?.pathname.split('/').pop() || '') ||
          (typeof part.filename === 'string' ? part.filename : '') ||
          'batshit-upload'
        const mimeType = resolvedMediaType ?? 'application/octet-stream'

        if (!cacheKey) {
          const dataHash = this.hashBytes(data)
          cacheKey = this.buildGeminiFileCacheKey(`data:${dataHash}:${mimeType}`)
          cacheHit = await this.readGeminiFileCache(cacheKey)
        }

        if (cacheHit?.fileUri) {
          const nextPart = {
            ...part,
            ...(part.type === 'image'
              ? { image: new URL(cacheHit.fileUri), mediaType: mimeType }
              : { data: new URL(cacheHit.fileUri), mediaType: mimeType })
          }
          fileUris.add(cacheHit.fileUri)
          nextContent.push(nextPart)
          changed = true
          continue
        }

        const fileUri = await this.uploadGeminiFile({
          data,
          mediaType: mimeType,
          displayName,
          apiKey
        })

        fileUris.add(fileUri)
        if (cacheKey) {
          await this.writeGeminiFileCache(cacheKey, {
            fileUri,
            mediaType: mimeType,
            displayName,
            createdAt: new Date().toISOString()
          })
        }

        const nextPart = {
          ...part,
          ...(part.type === 'image'
            ? { image: new URL(fileUri), mediaType: mimeType }
            : { data: new URL(fileUri), mediaType: mimeType })
        }

        nextContent.push(nextPart)
        changed = true
      }

      updated.push(changed ? { ...message, content: nextContent } : message)
    }

    return { messages: updated, fileUris }
  }

  private shouldEnableOpenAIImageTool(
    modelName: string,
    connection?: ModelConnectionInfo | null,
    providerSettings?: Record<string, any> | null
  ): boolean {
    const openaiSettings = this.resolveOpenAISettings(providerSettings)
    const explicit = this.getOpenAIToolToggle(
      openaiSettings,
      'openaiImageGenerationTool',
      'openai_image_generation_tool',
      'enable_image_generation_tool',
      'image_generation_tool'
    )
    if (explicit !== undefined) return explicit

    const transport = connection?.type ?? 'direct'
    if (transport !== 'direct') return false

    return modelName.toLowerCase().includes('gpt-5')
  }

  private async getOpenAIClient(userId?: string | null) {
    try {
      const access = await resolveProviderAccess(userId)
      const apiKey = access.apiKeys.openai
      if (!apiKey) {
        return null
      }

      return createOpenAI({ apiKey })
    } catch (error) {
      console.warn('[VercelBrain API] Failed to initialize OpenAI client:', error)
      return null
    }
  }

  private async buildOpenAITools(
    request: NativeModeRequest
  ): Promise<Record<string, any> | null> {
    if (!this.isOpenAIDirect(request)) return null

    const openai = await this.getOpenAIClient(request.userId)
    if (!openai) {
      console.warn('[VercelBrain API] OpenAI tools requested but no API key was found')
      return null
    }

    const settings = this.resolveOpenAISettings(request.providerSettings)
    const additions: Record<string, any> = {}

    if (this.shouldEnableOpenAIImageTool(request.model, request.connection, request.providerSettings)) {
      additions.image_generation = openai.tools.imageGeneration({
        outputFormat: 'webp'
      })
    }

    const webSearchEnabled = this.getOpenAIToolToggle(
      settings,
      'openaiWebSearchTool',
      'openai_web_search_tool',
      'webSearchTool',
      'web_search_tool',
      'enable_web_search_tool'
    )
    if (webSearchEnabled === true) {
      const options: Record<string, any> = {}
      const contextSize =
        settings.openaiWebSearchContextSize ??
        settings.openai_web_search_context_size ??
        settings.webSearchContextSize ??
        settings.web_search_context_size
      if (typeof contextSize === 'string' && contextSize.trim().length > 0) {
        options.searchContextSize = contextSize
      }
      const externalAccess = this.parseBooleanSetting(
        settings.openaiWebSearchExternalAccess ??
          settings.openai_web_search_external_access ??
          settings.webSearchExternalAccess ??
          settings.web_search_external_access
      )
      if (externalAccess !== undefined) {
        options.externalWebAccess = externalAccess
      }
      const userLocation =
        settings.openaiWebSearchUserLocation ??
        settings.openai_web_search_user_location ??
        settings.webSearchUserLocation ??
        settings.web_search_user_location
      if (userLocation && typeof userLocation === 'object') {
        options.userLocation = userLocation
      }
      additions.web_search = openai.tools.webSearch(options)
    }

    const fileSearchEnabled = this.getOpenAIToolToggle(
      settings,
      'openaiFileSearchTool',
      'openai_file_search_tool',
      'fileSearchTool',
      'file_search_tool',
      'enable_file_search_tool'
    )
    if (fileSearchEnabled === true) {
      const vectorStoreIds = this.coerceStringArray(
        settings.openaiFileSearchVectorStoreIds ??
          settings.openai_file_search_vector_store_ids ??
          settings.fileSearchVectorStoreIds ??
          settings.file_search_vector_store_ids
      )
      if (vectorStoreIds.length === 0) {
        console.warn(
          '[VercelBrain API] OpenAI file search enabled but no vectorStoreIds were provided'
        )
      } else {
        const options: {
          vectorStoreIds: string[]
          maxNumResults?: number
          filters?: Record<string, any>
          ranking?: Record<string, any>
        } = { vectorStoreIds }
        const maxResults =
          settings.openaiFileSearchMaxResults ??
          settings.openai_file_search_max_results ??
          settings.fileSearchMaxResults ??
          settings.file_search_max_results
        if (typeof maxResults === 'number' && Number.isFinite(maxResults)) {
          options.maxNumResults = Math.max(1, Math.floor(maxResults))
        }
        const filters =
          settings.openaiFileSearchFilters ??
          settings.openai_file_search_filters ??
          settings.fileSearchFilters ??
          settings.file_search_filters
        if (filters && typeof filters === 'object') {
          options.filters = filters
        }
        const ranking =
          settings.openaiFileSearchRanking ??
          settings.openai_file_search_ranking ??
          settings.fileSearchRanking ??
          settings.file_search_ranking
        if (ranking && typeof ranking === 'object') {
          options.ranking = ranking
        }
        additions.file_search = openai.tools.fileSearch(options as any)
      }
    }

    const codeInterpreterEnabled = this.getOpenAIToolToggle(
      settings,
      'openaiCodeInterpreterTool',
      'openai_code_interpreter_tool',
      'codeInterpreterTool',
      'code_interpreter_tool',
      'enable_code_interpreter_tool'
    )
    if (codeInterpreterEnabled === true) {
      const options: Record<string, any> = {}
      const container =
        settings.openaiCodeInterpreterContainer ??
        settings.openai_code_interpreter_container ??
        settings.codeInterpreterContainer ??
        settings.code_interpreter_container
      if (container) {
        options.container = container
      }
      additions.code_interpreter = openai.tools.codeInterpreter(options)
    }

    return Object.keys(additions).length > 0 ? additions : null
  }

  private async getOpenAIImageTool(
    userId?: string | null,
    openaiClient?: ReturnType<typeof createOpenAI> | null
  ) {
    try {
      const openai = openaiClient ?? (await this.getOpenAIClient(userId))
      if (!openai) return null
      return openai.tools.imageGeneration({
        outputFormat: 'webp'
      })
    } catch (error) {
      console.warn('[VercelBrain API] Failed to prepare OpenAI image tool:', error)
      return null
    }
  }

  private mergeToolSets(
    base: Record<string, any> | undefined,
    additions: Record<string, any>
  ): Record<string, any> {
    const merged = { ...(base ?? {}) }
    for (const [name, toolDef] of Object.entries(additions)) {
      if (merged[name]) {
        console.warn(
          `[VercelBrain API] Skipping built-in tool '${name}' because a tool with that name already exists`
        )
        continue
      }
      merged[name] = toolDef
    }
    return merged
  }

  /**
   * List all available models for UI population
   * Delegates to ProviderManager
   */
  listAvailableModels() {
    return this.providerManager.listAvailableModels()
  }

  /**
   * Stream response for API runtime - returns the streamText result for SSE
   * Clean streaming with Vercel AI SDK
   */
  async streamNativeMode(request: NativeModeRequest) {
    logger.debug('[VercelBrain API] Starting stream for native mode', {
      sessionId: request.sessionId,
      model: request.model,
      hasAbortSignal: !!request.abortSignal
    })

    // D10: a failure after the stream started never reaches the stream's own end hooks.
    let claudePlanOnFailure: ClaudePlanModel | null = null
    try {
      if (request.chatgptPlanLease) assertPlanSettings(request.providerSettings)
      const claudePlan = await this.prepareClaudePlanModel(request)
      claudePlanOnFailure = claudePlan?.model ?? null
      let imageInputContext: Omit<ApiInputObservation, 'promptMessages' | 'toolDefinitions'> | null = null
      const model = await this.getModel(
        request.model,
        request.connection,
        request.userId,
        request.taggedReasoningTagName,
        request.onApiModelInput ? (params) => request.onApiModelInput!({
          ...(imageInputContext ?? { compiledMessages: [], compiledPrefixCount: -1, initialSystem: null, userSources: [] }),
          promptMessages: params.prompt,
          toolDefinitions: params.tools,
          // SA-139 D5: what a Claude plan run reads natively between steps (review B M2).
          ...(claudePlan ? { nativeAdditions: claudePlan.model.nativeAdditionPieces() } : {})
        }) : undefined,
        request.chatgptPlanLease,
        request.modelDispatchGate,
        request.agentSetup,
        claudePlan?.model,
      )
      // NEW (SA-002): Pass sessionId and userId for clip resolution
      const baseMessages = await this.convertMessages(
        request.messages,
        request.images,
        request.sessionId,
        request.userId
      )
      const { messages, fileUris: geminiFileUris } = await this.convertGeminiFileParts(
        baseMessages,
        request
      )
      this.logGeminiPayloadSummary('stream', messages, request, geminiFileUris)
      const preparedTools = await this.consumeApiToolset(request)
      const { tools: toolsForRequest, maps: toolMaps, approvals: toolApprovalsForRequest,
        images: ephemeralImagesForRequest, carried: initialImageToolIds, deferred: imageDeferrals,
        p5ApiRun, p5Owner } = preparedTools
      // Story 6.4: Wrap the SDK onEnd callback to inject metadata into steps.
      // AI SDK 7 semantics: event.usage is the AGGREGATE across all steps (what
      // v6 called totalUsage); last-step numbers live on event.finalStep.usage.
      // Batshit's internal onFinish contract keeps totalUsage = run aggregate.
      const skillDcmUpdates: SkillDcmUpdate[] = []
      const apiUserSources = [...(request.imageOriginInput?.userSources ?? [])]
      const registerUserSource = (source: UserInputSource) => {
        if (!apiUserSources.some((known) => known.textHash === source.textHash && JSON.stringify(known.spans) === JSON.stringify(source.spans))) apiUserSources.push(source)
      }
      const p5StreamCustody: ApiStreamCustody | undefined = p5ApiRun ? { run: p5ApiRun, owner: p5Owner!, consumerConsumed: false, finishKnown: false } : undefined
      const wrappedOnEnd = request.onFinish || p5StreamCustody ? async ({ text, steps, usage, totalUsage, responseMessages: eventResponseMessages, finalStep }: any) => {
        const responseMessages =
          Array.isArray(eventResponseMessages) && eventResponseMessages.length > 0
            ? eventResponseMessages
            : Array.isArray(finalStep?.response?.messages) && finalStep.response.messages.length > 0
              ? finalStep.response.messages
              : undefined

        // Inject metadata into each step
        const enhancedSteps = steps?.map((step: any) => {
          // For each toolCall in the step, enhance with metadata
          if (step.toolCalls && Array.isArray(step.toolCalls)) {
            return {
              ...step,
              toolCalls: step.toolCalls.map((toolCall: any) => {
                const metadata = this.detectMode3ToolSource(toolCall.toolName, toolMaps)
                return {
                  ...toolCall,
                  metadata // Attach metadata to toolCall
                }
              })
            }
          }
          return step
        })

        // Call original onFinish with only the parameters defined in NativeModeRequest
        const finishReasoning = collectReasoningTextFromFinish(
          finalStep?.reasoningText ?? finalStep?.reasoning
        )
        const aggregateUsage = usage ?? totalUsage
        if (request.onFinish) await request.onFinish({
          text,
          steps: enhancedSteps,
          totalUsage: aggregateUsage,
          usage: aggregateUsage,
          reasoning: finishReasoning ? [finishReasoning] : undefined,
          responseMessages,
          apiUserSources,
          imageInputsRegistered: ephemeralImagesForRequest?.registered() ?? 0
        })
        if (p5StreamCustody) { p5StreamCustody.finishKnown = true; p5StreamCustody.owner.notifyP5ApiStreamSettlement(p5StreamCustody.run) }
      } : undefined

      const runtimeProviderId = this.resolveRuntimeProviderId(
        request.model,
        request.connection,
      )
      const cachePolicy = applyApiPromptCachePolicy({
        modelId: request.model,
        providerId: runtimeProviderId,
        connection: request.connection ?? null,
        sessionId: request.sessionId,
        agentId: request.agentId ?? null,
        userId: request.userId ?? null,
        messages,
        tools: toolsForRequest,
        providerOptions: request.providerOptions,
      })
      this.logPromptCachePolicy(cachePolicy.metadata)

      const downloadGuard = await this.resolveDownloadHandler(request, geminiFileUris)

      // Copy only the immutable text projection needed by provenance. Do not retain image bytes
      // or let prepareStep's replacement list redefine which compiled text was dispatched.
      const compiledMessages = Object.freeze(cachePolicy.messages.map((message) => Object.freeze({
        role: message.role,
        content: typeof message.content === 'string' ? message.content : Object.freeze(
          message.content.filter((part: any) => part.type === 'text').map((part: any) => Object.freeze({ type: 'text', text: part.text }))
        )
      })))
      imageInputContext = {
        compiledMessages,
        compiledPrefixCount: cachePolicy.messages.length === request.messages.length
          ? request.imageOriginInput?.compiledPrefixCount ?? -1 : -1,
        initialSystem: compiledMessages.filter((message) => message.role === 'system'),
        userSources: apiUserSources,
        skillDcmUpdates
      }

      if (p5ApiRun) {
        p5Owner!.assertP5ApiRunCurrent(p5ApiRun)
        if (p5Owner!.p5ApiRunMustPause(p5ApiRun)) throw new Error('The original API management boundary ended before model dispatch.')
      }
      const result = await streamText({
        model,
        messages: cachePolicy.messages,
        // Every system-role entry in `messages` originates from Batshit's own
        // server-side compiler, never from untrusted content (SA-098 D1), so the
        // v7 system-in-messages guard is relaxed to preserve Batshit's prompt
        // order and provider cache anchoring on the compiled payload.
        allowSystemInMessages: true,
        ...claudePlanToolOptions(claudePlan, cachePolicy.tools, toolApprovalsForRequest, downloadGuard),
        // SDK evaluates ALL predicates concurrently. This private boolean NEVER awaits a flight.
        stopWhen: p5ApiRun
          ? [isStepCount(request.maxToolRounds || 10), () => {
              const pause = p5Owner!.p5ApiRunMustPause(p5ApiRun)
              if (pause) p5Owner!.holdP5ApiToolImages(p5ApiRun)
              return pause
            }]
          : isStepCount(request.maxToolRounds || 10),
        ...this.buildGenerationSettings(request),
        providerOptions: request.chatgptPlanLease ? planProviderOptions(cachePolicy.providerOptions) : cachePolicy.providerOptions,
        // SA-107: per-session cache-affinity headers (xAI/Baseten/Fireworks direct lanes).
        ...(cachePolicy.headers ? { headers: cachePolicy.headers } : {}),
        abortSignal: request.abortSignal, // Forward abort signal
        // Raw chunks feed the OpenAI-compatible reasoning_content lane; request
        // bodies feed Execution Viewer evidence (v7 excludes them by default).
        include: { rawChunks: true, requestBody: true },
        ...(downloadGuard ? { experimental_download: downloadGuard } : {}),
        onStepEnd: ({ text, toolCalls, toolResults, finishReason }) => {
          if (p5ApiRun) p5Owner!.observeP5ApiStepTools(p5ApiRun, (toolResults ?? []).map(item => item.toolCallId))
          logger.debug('[VercelBrain API] Step completed', {
            hasText: !!text,
            toolCallCount: toolCalls?.length || 0,
            toolResultCount: toolResults?.length || 0,
            finishReason
          })

          // Debugging fix (Oct 13): Enhance tool calls with metadata during streaming
          // This ensures send-routed has metadata when building intermediateSteps
          if (toolCalls && Array.isArray(toolCalls)) {
            toolCalls.forEach((toolCall: any) => {
              const metadata = this.detectMode3ToolSource(toolCall.toolName, toolMaps)
              // Attach metadata directly to toolCall so send-routed can find it
              toolCall.metadata = metadata

              logger.debug('[VercelBrain API] Enhanced toolCall with metadata:', {
                toolName: toolCall.toolName,
                metadata
              })
            })
          }
        },
        // D10: the Claude plan run ends with the reply's loop (a normal end, the step cap, a Stop or
        // an error). A consumer that stops reading is SA-139 P2 Part 3's (send-routed's finalize,
        // tested there); until then the idle backstop ends that run.
        onEnd: claudePlan ? async (event: any) => {
          try { await wrappedOnEnd?.(event) } finally { claudePlan.model.endReplyAtLoopEnd() }
        } : wrappedOnEnd,
        onAbort: claudePlan ? (event: any) => {
          claudePlan.model.endReply()
          request.onAbort?.(event)
        } : request.onAbort,
        ...(claudePlan ? { onError: ({ error }: { error: unknown }) => {
          claudePlan.model.endReply()
          console.error('[VercelBrain API] Claude plan stream error:', error)
        } } : {}),
        // SA-114 P1 (DL-114-05): ONE composed hook, always registered — SA-105's synthetic
        // image lane first, then the steer. It returns `undefined` when neither has
        // anything pending, so a run with no images and no steers is unchanged. BL-77: on
        // lanes that take Anthropic cache control it also adds the tool loop's cache point
        // on every step, the first included (BL-1976; not a message on direct Anthropic).
        prepareStep: this.buildTurnPrepareStep({
          ephemeralImages: ephemeralImagesForRequest, initialImageToolIds, imageDeferrals,
          takeSteers: request.takeSteers ?? null,
          registerUserSource: request.onApiModelInput ? registerUserSource : undefined,
          refreshOpenSkills: request.refreshOpenSkills,
          registerDcmUpdate: update => { skillDcmUpdates.push(update) },
          claudePlan: claudePlan?.model ?? null,
          checkSkillContext: request.skillContextBudget && request.skillReadDelivery ? stepMessages => {
            if (!request.skillReadDelivery!.hasReads()) return
            const report = buildPromptBudgetReport({ runtime: 'vercel', messages: stepMessages,
              contextLimit: request.skillContextBudget!.contextLimit,
              outputReserveTokens: request.skillContextBudget!.outputReserveTokens })
            if (!report.canSend) throw new Error(`The complete opened-skill guidance and tool reply do not fit this model context. ${report.reason}`)
          } : undefined,
          toolLoopProviderOptions: cachePolicy.stepProviderOptions ?? null,
          toolLoopTailMarker: cachePolicy.toolLoopTailMarker
            ? { marker: cachePolicy.toolLoopTailMarker, firstLoopIndex: cachePolicy.messages.length }
            : null
        })
      })

      if (p5StreamCustody) { p5ApiStreams.set(result, p5StreamCustody); p5ApiRuns.set(p5StreamCustody.run, p5StreamCustody) }

      // Return the full result for SSE conversion
      ;(result as any).__toolMaps = toolMaps
      // SA-139 (D10): send-routed's request finalize ends this reply's Claude plan run as a backstop.
      ;(result as any).__claudePlanModel = claudePlan?.model ?? null
      ;(result as any).__detectToolSource = (toolName: string) => this.detectMode3ToolSource(toolName, toolMaps)
      ;(result as any).__runtimeInfo = {
        runtimeId: 'vercel',
        providerId: runtimeProviderId,
        connectionId: request.connection?.id || request.connection?.service || null,
        modelName: request.model ?? null,
        transport: 'vercel-sdk',
        metadata: {
          promptCachePolicy: cachePolicy.metadata
        },
        promptCachePolicy: cachePolicy.metadata
      }
      return result
    } catch (error: any) {
      claudePlanOnFailure?.endReply()
      console.error('[VercelBrain API] Error in streamNativeMode:', error)
      throw error
    }
  }

  private async loadSubagentsByIds(
    subagentIds: string[],
    userId: string
  ): Promise<Array<import('$lib/types/database').SubagentRow>> {
    const subagents: Array<import('$lib/types/database').SubagentRow> = []

    for (const id of subagentIds) {
      try {
        const subagent = await redis.json.get(`subagent:${id}`)
        if (subagent) {
          subagents.push(subagent)
        } else {
          console.warn(`[API Runtime] Subagent not found: ${id}`)
        }
      } catch (error) {
        console.error(`[API Runtime] Error loading subagent ${id}:`, error)
      }
    }

    return subagents
  }
}

function normalizeToolKey(name: string) {
  return normalizeToolNameForAiSdkKey(name);
}

type ClaudePlanWiring = { model: ClaudePlanModel; runtime: typeof import('./claudePlanModel') }

/**
 * The raw selection's sampling copies admission checks. An empty list (a stop-sequence list the user
 * left empty) is blank: blank sends nothing, so it is never refused as a setting (review nit, Part 3).
 */
function claudePlanSamplingToCheck(sampling?: Readonly<object> | null): Record<string, unknown> | null {
  if (!sampling) return null
  return Object.fromEntries(Object.entries(sampling).filter(([, value]) => !(Array.isArray(value) && value.length === 0)))
}

/**
 * Any spelling of the Claude plan connection (review N6): P1's selection check, plus a service field
 * that carries the connection id's spelling (`claude-plan:local`, `direct:claude-plan`). Every one
 * reaches admission, which refuses an inconsistent spelling; none reaches ProviderManager.
 */
function isClaudePlanSpelling(connection?: ModelConnectionInfo | null): boolean {
  return isClaudePlanSelection(connection) || isClaudePlanConnection(connection?.service)
}

/**
 * SA-139 (D4): the Claude plan's admission wrapper goes on the OUTERMOST layer, outside the readable
 * wrapper (`wrapToolsWithReadableModelOutput`, which tracks each execution for BL-1959), so a Stop
 * during the admission wait records no call that never ran. `repairToolCall` hands Claude the SDK's
 * own error text for a call it refused before running; an approval card refuses visibly until P3.
 * Every other connection gets exactly what it got before.
 */
function claudePlanToolOptions(
  claudePlan: ClaudePlanWiring | null,
  tools: Record<string, any> | undefined,
  approvals: Record<string, any>,
  download: unknown
): Record<string, unknown> {
  const hasApprovals = Object.keys(approvals).length > 0
  if (!claudePlan) return { tools, ...(hasApprovals ? { toolApproval: approvals } : {}) }
  const { model, runtime } = claudePlan
  return {
    tools: tools ? runtime.wrapClaudePlanToolSet(tools, model, download ? { download: download as any } : {}) : tools,
    ...(hasApprovals ? { toolApproval: runtime.wrapClaudePlanApprovals(approvals, model) } : {}),
    repairToolCall: model.repairToolCall
  }
}
