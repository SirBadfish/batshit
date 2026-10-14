import { ApiImageInputCollector, readUserInputSources } from '$lib/server/services/imageAddressApiInput'
import { BATSHIT_SERVER_URL as BROWSER_BATSHIT_SERVER_URL } from '$lib/services/apiClient'
import { readTurnMcpGatewaySnapshot, resolveTurnMcpGatewaySelection, type TurnMcpGatewayAuthority } from '$lib/server/services/turnMcpGatewayScope'
import { open, unlink } from 'node:fs/promises'
import { randomInt } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { json, type RequestEvent } from '@sveltejs/kit'
import { commitMemoryTurnState } from '$lib/server/services/memory/memoryRecall'
import { ensureFixedSessionOpenEpisode } from '$lib/server/services/memory/memoryEpisodes'
import type { CurrentMessageFrom } from '$lib/utils/compiledChatTags'
import { isFixedSession, resolveFixedSessionAgentId } from '$lib/utils/fixedSession'
import { logger } from '$lib/utils/logger'
import type { RequestHandler } from './$types'
import {
  DatabaseService,
  type PrecompiledHistory,
} from '$lib/services/databaseRedis.server'
import type {
  AgentRow,
  ChatMessage,
  UserSettingsRow,
} from '$lib/types/database'
import type { ModelCapabilities, SavedModel } from '$lib/types/savedModels'
import type { ParameterValue } from '$lib/data/parameter-schemas'
import { redis } from '$lib/server/redis'
import { InvalidToolInputError, NoSuchToolError, type ModelMessage } from 'ai'
import { ZipDetectionService } from '$lib/server/services/zipDetection'
import {
  createZipFromContent,
  reserveZipId,
  type ZipReference,
} from '$lib/server/zipService'
import { executionViewerService } from '$lib/server/services/executionViewerService'
import { readCliContextReport } from '$lib/server/services/cliContextReportLookup'
import {
  claudeContextCappedByEnvironment, cliContextSettingsKey,
  matchingCliContextReport, reportForCliSnapshot,
  resolveEffectiveAgentCliModel, resolveCliContextWindow
} from '$lib/utils/cliContextWindow'
import {
  approvalResumeReplyTurn,
  attachJevJuiceRecords,
  buildContinuedReplySteps,
  buildGroupSpeakerProvider,
  buildJevJuiceMessageMetadata,
  buildPostTurnCheckTurn,
  buildQuickActionTellProvider,
  buildSemanticRecallTurn,
  buildSkillToolHintProvider,
  buildSmartZipTurn,
  buildUntrustedTextHintProvider,
  composeJevJuiceHintProviders,
  createJevJuiceTurnCollector,
  findContextContinuationTurn,
  type GroupSpeakerProviderInput,
} from '$lib/server/services/typesafe/jevJuiceTurn'
import {
  GROUP_SPEAK_POLICY_SMART,
  buildGroupSpeakerDcmLines,
  buildGroupSpeakerRequest,
  buildGroupSpeakerSelectionMetadata,
  computeGroupSpeakerSelection,
  type GroupSpeakerCandidate,
  type GroupSpeakerOutcome,
  type GroupSpeakerSelectionMetadata,
} from '$lib/server/services/groupSpeaker.jev'
import { judgeNameOfCallRecord } from '$lib/utils/judgeProviders'
import { isSkillInvocationMessage } from '$lib/server/services/skillSessionContext'
import { recordSkippedGroupUserReply } from '$lib/server/services/groupReplySkipped'
import { appendTypesafeCallRecords, buildJevJuiceNote } from '$lib/server/services/typesafe/typesafeEvidence'
import { markInferredRezipsTold, writeInferredUnzips } from '$lib/server/services/zipStateInferred'
import { advanceZipCountdowns } from '$lib/server/services/zipHolds'
import {
  finalizeReplyControl,
  type ReplyControlFinalizeResult,
} from '$lib/server/services/replyControlFinalize'
import {
  REPLY_CONTROL_FINALIZED_FLAG,
  buildReplyControlMetadata,
  extractReplyControl,
  resolveZipToolNotesEnabled,
} from '$lib/utils/replyControl'
import { buildControlErrorRecord } from '$lib/utils/controlTags'
import { markPostTurnRecordTold } from '$lib/server/services/postTurnCheckState'
import type { TypesafeCallRecord } from '$lib/types/typesafe'
import type { ExecutionRuntimeDetails, ExecutionSnapshot, ObservedUsage } from '$lib/types/executionViewer'
import { getTypeZipSettings } from '$lib/utils/toolRenderMap'
import { normalizeAgentBrowserCommandName } from '$lib/utils/toolNameNormalization'
import { bytesToBlob } from '$lib/utils/binary'
import {
  isCliPrimaryAgentType,
  isManagedPrimaryAgentType,
  isN8nPrimaryAgentType,
  normalizePrimaryAgentType,
} from '$lib/utils/primaryAgentType'
import {
  isSubagentCompatibleWithPrimaryAgent,
  normalizeSubagentType,
} from '$lib/utils/subagentType'
import {
  buildClaudeLlmCapture,
  buildCodexLlmCapture,
  buildTokenStat,
  buildTokenUsage,
  buildVercelLlmCapture,
  reportedUsageConfidence,
  sanitizeRuntimeEventLogForCapture,
} from '$lib/server/services/executionViewerLlmCapture'
import {
  buildMeasuredMessagePerformance,
  buildMessagePerformanceFromSteps,
} from '$lib/server/services/messagePerformance'
import {
  buildApiCacheForensicsRecords,
  resolveCacheForensicsExperimentGroup,
} from '$lib/server/services/cacheForensics/apiAdapter'
import { buildCliCacheForensicsRecord } from '$lib/server/services/cacheForensics/cliAdapter'
import {
  createLlmCaptureClaim,
  createStreamStepRecorder,
  isContextExhaustedStreamFailure,
  providerStreamErrorFrom,
} from '$lib/server/services/streamFailureEvidence'
import {
  attachCacheForensicsToSnapshot,
  isCacheForensicsEnabled,
} from '$lib/server/services/cacheForensics/evIntegration'
import {
  StreamEventAdapter,
  type CanonicalStreamEvent,
  type VoiceMetadata,
} from '$lib/server/services/streamEventAdapter'
import { resolveVoiceConfigForMetadata } from '$lib/server/services/voiceService'
import { buildVoiceRuntimeGuidanceForProvider } from '$lib/server/services/voiceRuntimeGuidance'
import {
  prepareManagedHistoryMessages,
  resolveCurrentMessageFrom,
} from '$lib/server/services/sendRoutedHistory'
import { parseJsonLike, normalizeToolArgs } from '$lib/server/services/sseToolNormalization'
import {
  extractUsageFromRawPayload as extractUsageFromRawChunk,
  hasUsageValues,
  mergeUsageLike,
  outputTokensForUsage,
  resolveMessageUsage,
  type ApiUsageLike,
  withHonestLocalCacheUsage,
} from '$lib/server/services/apiProviderUsage'
import type { NativeModeRequest } from '$lib/server/services/vercelBrain'
import { buildDelegatedExecutionSummary } from '$lib/server/services/delegatedRunAccounting'
import {
  initializeKeyspaceNotifications,
  setupSessionMonitoring,
  cleanupSessionMonitoring,
  type VisualIndicatorEvent,
} from '$lib/server/visualIndicatorService'
import { generateMessageId } from '$lib/utils/messageId'
import { buildRuntimeModelSettings } from '$lib/utils/modelSettingsMapper'
import { resolveApiContextBudget } from '$lib/server/services/localApiContextBudget'
import {
  LOCAL_AI_SERVER_DEFINITIONS,
  resolveLocalPromptCacheReporting
} from '$lib/data/localAiServers'
import {
  buildReasoningPersistenceEvidence,
  collectReasoningTextFromFinish,
  extractReasoningTextFromRawChunk,
  ReasoningStreamSourceArbiter,
  resolveTaggedReasoningTagName,
  withReasoningProviderOptions,
} from '$lib/utils/reasoningDisplay'
import {
  buildInterruptedReasoningRecovery,
  readInterruptedReasoningRecovery,
} from '$lib/utils/reasoningRecovery'
import {
  resolveAgentModelFallbacks,
  resolveRuntimeModelSelection,
} from '$lib/utils/modelPresetRuntime'
import { resolveModelIds } from '$lib/utils/modelIdResolver'
import { loadRuntimeModelPreset } from '$lib/server/services/runtimeModelPreset'
import { N8N_ONLY_CONNECTION_IDS } from '$lib/server/constants/modelConnections'
import { N8N_ONLY_PROVIDER_IDS } from '$lib/data/model-compatibility-registry'
import { listLocalAiServers } from '$lib/server/services/localAiServers'
import {
  buildCodexRuntimeSettings,
  resolveCodexTransportLane,
  type CodexRunSettings
} from '$lib/server/services/codexSettings'
import { buildAgentProfileId } from '$lib/server/services/codexProfileManager'
import {
  buildClaudeRuntimeSettings,
  type ClaudeRunSettings
} from '$lib/server/services/claudeSettings'
import { replacePromptVariables } from '$lib/utils/promptVariables'
import { STEER_MISSED_REASON, resolveAgentDmsEnabled } from '$lib/utils/dmControl'
import { resolveAgentJevJudgeToolEnabled } from '$lib/utils/jevJuiceControl'
import { resolveAgentMemoryEnabled } from '$lib/utils/memoryControl'
import { resolveWorkersEnabled } from '$lib/utils/delegationCapabilities'
import { THINKING_INDICATOR } from '$lib/utils/thinkingIndicator'
import { resolveMCPSelections } from '$lib/server/services/mcpSelectionResolver'
import type { MCPSelectionResolution } from '$lib/server/services/mcpSelectionResolver'
import { mcpGatewayService } from '$lib/server/services/mcpGatewayService'
import {
	  getActiveSessionTurn,
	  getActiveStream,
	  registerSessionTurn,
	  releaseSessionTurn,
	  isSessionTurnHeldByAnother,
	  isAnotherRequestRunning,
	  registerStreamAbort,
  clearStreamAbort,
  registerGroupAbort,
  clearGroupAbort,
  isSessionDeleting,
  abandonQueuedSessionTurn,
  claimQueuedSessionTurn,
  noteQueuedSendNotice,
  countQueuedSessionTurns,
  countRunnableQueuedSessionTurns,
  isUserMessageQueued,
  queueSessionTurn,
  revealQueuedUserMessage,
  getQueueCardHold,
  sendWaitingSendNow,
  type SessionTurnEntry,
} from '$lib/server/services/streamAbortRegistry'
import {
  buildQueuedSendKeptAnswer,
  buildQueuedSendOverflowAnswer,
  decideQueuedSend,
  isQueueableSend,
  isSavedUserMessageForSend,
  mergeQueuedSendHistory,
  sentWhileReplyRan,
  QUEUED_SEND_FORWARD_LIMIT_MS,
  resentMessageCreatedAt,
  shouldMoveSentMessageToEnd,
} from '$lib/server/services/queuedSendRules'
import { keepQueuedSendAtEnd } from '$lib/server/services/queuedSendKeeper'
import {
  getWakeAbortSignal,
  getWakeRun,
  isWokenTurnMessage,
} from '$lib/server/services/wakeRunRegistry'
import { publishSessionEvent, publishUserEvent } from '$lib/server/ssePublisher'
import {
  FIRST_IMAGE_ORIGIN_VERSION,
  loadImageOrigins,
  markImageOriginPending,
  writeImageOriginDecision,
} from '$lib/server/services/imageAddressOrigins'
import {
  decideReplyImageOrigins,
  emptyRunDelivery,
  appendCliModelResult,
} from '$lib/server/services/imageAddressTurnRecord'
import {
  composeInPlaceResumeMessage,
  continueResumedSnapshotPatch,
  createApprovalResumeStart,
  mergeResumedMetadata,
  mergeResumedSteps,
  withPriorTypesafeCalls,
  hasUserTurnContent as sendCarriesUserTurn,
  isInPlaceApprovalResume,
  readStoredAssistantRecord,
  resolveFailedTurnContent,
  readObservedUsage,
} from '$lib/server/services/approvalResumeMessage'
import {
  buildApprovalResumeReplay,
  buildReplayableTranscript,
  findPausedApprovalTurn,
} from '$lib/server/services/approvalResumeReplay'
import {
  isApprovalClick,
  waitForCardReplyToFinish,
} from '$lib/server/services/approvalClickWait'
import { answerApprovalsOnce } from '$lib/server/services/approvalAnswerRecord'
import { chatgptPlanAccountId } from '$lib/utils/chatgptPlanConnection'
import { getChatgptPlanRuntime } from '$lib/server/services/chatgptPlanHost'
import { PLAN_AGENT, type PlanLease } from '$lib/server/services/chatgptPlanRuntime'
import { isPlanSelection, assertPlanSettings, chatgptPlanHttpStatus } from '$lib/server/services/chatgptPlanInference'
import { assertPlanApprovalSource } from '$lib/server/services/approvalResumeReplay'
import {
  GROUP_APPROVAL_CLICK_REFUSAL,
  refusesGroupApprovalClick,
} from '$lib/server/services/groupApprovalClick'
import {
  createGroupRoundClipSpend,
  drainGroupRoundThenSpend,
  type GroupRoundClipSpend,
} from '$lib/server/services/groupRoundClipSpend'
import { waitForFinishingTurn } from '$lib/server/services/finishingTurnWait'
import {
  answerWhenTurnAccepted,
  prefersRespondAsync,
  type AcceptTurn,
} from '$lib/server/services/respondAsyncSend'
import { enterBackupRestoreHttpRequest } from '$lib/server/services/backupRestoreService'
import {
  StreamStoppedError,
  isStopError,
  judgeStreamEnd,
} from '$lib/server/services/streamStop'
import { relayAbort } from '$lib/server/services/turnAbortRelay'
import {
  OUTPUT_LIMIT_ERROR_CODE,
  OUTPUT_LIMIT_FAILURE_KIND,
  describeOutputLimitStop,
  isOutputLimitFinish,
  outputLimitFailureMetadata,
} from '$lib/server/services/outputLimitStop'
import {
  SESSION_DELETED_STOP_MESSAGE,
  isStoppedForSessionDelete,
} from '$lib/server/services/sessionDeleteTurnStop'
import {
  attachSteerTransport,
  clearSteerInbox,
  clearSteerRun,
  confirmSteerDelivery,
  drainDeliveredSteers,
  registerSteerRun,
  takeMissedDmSteers,
  takeMissedUserSteers,
  takePendingSteersForDelivery,
  takeUndeliveredSteers,
  refileUndeliveredSteers
} from '$lib/server/services/steerInboxRegistry'
import {
  MAX_STEER_PROMOTIONS,
  followUpTurnMetadata,
  holdSteersForApprovalCard,
  markHeldMessageCardExpired,
  markHeldMessageUnanswered,
  markApprovalCardWithoutAnswer,
  readHeldSteerIdsForHistory,
  publishUnansweredSteers,
  saveSteersWithoutAnswer,
  readHeldSteerIds,
  pickSendFacts,
  promoteSteersToNextTurn,
  readFollowUpHistory,
  readHeldMessageToAnswer
} from '$lib/server/services/steerPromotion'
import {
  APPROVAL_EXPIRED_REASON,
  approvalSummaryIsPending,
  isExpiryOnlyAnswer
} from '$lib/utils/heldForApproval'
import {
  buildSteerPlaceholder,
  resolveSteerability,
  type DeliveredSteer,
  type SteerLane
} from '$lib/utils/steerControl'
import {
  acknowledgeDeliveredDmSteers,
  clearNeedsUserForHumanReply,
  degradeMissedDmSteers
} from '$lib/server/services/dm/dmStore'
import type {
  GroupChatSessionConfig,
  GroupChatSpeakPolicy,
} from '$lib/types/groupChat'
import { GROUP_CHAT_SESSION_DEFAULTS } from '$lib/types/groupChat'
import type {
  ToolApprovalMode,
  ToolApprovalEntry,
  ToolApprovalResponse,
  ToolApprovalSummary,
} from '$lib/types/tool-approvals'
import {
  getInternalBatshitServerAuthHeaders,
  getInternalBatshitServerUrl
} from '$lib/server/services/batshitServerUrls'
import {
  resolveScreenshotUploadModelUrl,
  resolveUploadConfigForScreenshot,
  type ScreenshotUploadConfig,
} from '$lib/server/services/clipUrlResolver'
import {
  buildGroupSystemPromptAddendum,
  buildInterAgentPrompt,
  isAgentAddressed,
  matchesTopic,
  normalizeGroupChatConfig,
  parseLeadingGroupControlFromBuffer,
  stripGroupChatPresentationControls,
  stripRepeatedLeadingGroupControlBlocks,
} from '$lib/server/services/groupChatUtils'
import { resolveNativeBashMapping } from '$lib/server/services/bashCommandMapper'
import { toolStepFailureMessage } from '$lib/utils/toolResultProcessor'
import { toolErrorAsFailedToolResult } from '$lib/server/services/toolErrorPart'
import { collectCompiledImageInputs } from '$lib/server/services/compiledImageInputs'
import {
  MODE4_PRELAUNCH_STYLE,
  resolveMode4MemoryOwner,
} from '$lib/constants/mode4'
import {
  applyImageTransportOverrides,
  classifyLocalImageUrlRuntimeFailure,
  type ImageTransportOverride,
  isLocalProviderId,
} from '$lib/server/services/localImageTransportPolicy'
import {
  IMAGE_INPUT_UNSUPPORTED_CODE,
  buildImageInputUnsupportedMessage,
  classifyImageInputUnsupportedRuntimeFailure,
  modelAllowsImageInput,
} from '$lib/server/services/modelInputCapabilities'
import { stripEphemeralImagesFromProviderMessages } from '$lib/server/services/toolResultImageDelivery'
import {
  decrementSessionClipDurations,
  listActiveClipIds,
  listCountdownClipIds,
  normalizeSessionClipState,
} from '$lib/server/services/sessionClipState'
import { stripLeadingSubagentEchoText } from '$lib/server/services/finalAssistantTextSanitizer'
import { selectFinishZipInput } from '$lib/server/services/managedStreamFinalization'
import {
  REPLY_EVENT_FORWARD_LIMIT,
  closeReplyRecord,
  flushHeldReplyText,
  settlesWithin,
  REPLY_RECORDED_EVENT_TYPES,
  REPLY_SAVED_FROM_OWN_COPY_KEY,
  rebuildRecordedReply,
  takeStreamMadeZipReferences,
  type RecordedReplyEnd,
} from '$lib/server/services/replyStreamRecord'
import { finishReplyEndContent, replyEndZipIds } from '$lib/utils/replyEndContent'
import { SegmentedText } from '$lib/utils/segmentedText'
import { buildClaudeApprovalSummary, joinApprovalSummaries } from '$lib/server/services/claudeApprovalEvents'
import { applyUnavailableWebSearchMetadata } from '$lib/utils/webSearchAvailability'
import { nativeToolService } from '$lib/server/services/nativeTools'
import {
  attachControlApprovalRecords,
  buildControlApprovalResumeContent,
  buildControlApprovalInPlaceAddendum,
  planControlApprovalResumeTurn,
  resolveApprovalResumeGrants,
  settleControlApprovalCard,
  type ResolvedApprovalResumeGrants
} from '$lib/server/services/brokerControlApprovals'
import { markApprovalExpired } from '$lib/server/services/controlApprovals'
import {
  analyzeApprovalState,
  buildApprovalHistoryMessages,
  buildToolApprovalTimeoutAddendum,
  buildControlApprovalEntry,
  readControlApprovalRequestFromToolResult,
  resolveApprovalSummarySource,
  toolResultApprovalRendersCard,
  parseApprovalTimestampMs,
  TOOL_APPROVAL_TIMEOUT_MS,
  type ApprovalStateSnapshot
} from '$lib/server/services/toolApprovalState'
import { normalizeAssignedSubagent } from '$lib/server/services/assignedSubagentNormalization'
import {
  internalServiceHeaders,
  isTrustedInternalRequest,
} from '$lib/server/services/internalRequestAuth'
import { apiKeyService } from '$lib/services/apiKey.server'
import {
} from '$lib/server/services/runtimeUrlRewrites'
import {
  collectTrustedClipIdsFromMetadata,
  extractZipIdFromReference,
  neutralizeAllClipReferenceSyntax,
  neutralizeAllZipReferenceSyntax,
  neutralizeFinishedReplyReferences,
  neutralizeUntrustedClipReferenceSyntax,
} from '$lib/utils/zipReferenceSafety'
import {
  buildPromptBudgetReport,
  resolveBudgetOutputReserve,
} from '$lib/server/services/contextBudgetPreflight'
import {
  CODEX_NATIVE_BASE_OVERHEAD_TOKENS,
  estimateCodexProjectInstructionTokens,
  estimateCodexProjectInstructionChars,
} from '$lib/server/services/contextTokenPreview'
import { CLI_WRAPPER_OVERHEAD_TOKENS } from '$lib/utils/tokenPanel'
import {
  resolveAutoCompactTriggerTokens,
  resolveEffectiveAutoCompactSettings,
} from '$lib/utils/contextCompaction'

type UsageLike = NonNullable<ApiUsageLike>

const PRIMARY_CODEX_PROVIDER_ID = 'openai-codex'
const PRIMARY_CLAUDE_PROVIDER_ID = 'anthropic-claude-cli'
const CODEX_PROVIDER_IDS = new Set(['codex', PRIMARY_CODEX_PROVIDER_ID])
const CLAUDE_PROVIDER_IDS = new Set(['claude-cli', PRIMARY_CLAUDE_PROVIDER_ID])
const CODEX_CONNECTION_ID = 'codex-cli'
const CLAUDE_CONNECTION_ID = 'claude-cli'
const SIMULATED_STREAM_DELAY_MS = 22
const SIMULATED_STREAM_CHUNK_TARGET = 36
// Hard cap on automatic continuations after mid-run context-window exhaustion,
// per user request, so a pathological task can never loop forever.
const MAX_CONTEXT_CONTINUATIONS = 3

/**
 * THE Clip countdown spend: one user message spends one from every countdown (`next message only`,
 * `next N messages`). `onlyClipIds` limits it to those Clips (a group round, BL-600).
 *
 * BL-505 (C2): the spend tells every tab on the chat itself, whoever called it (a send, a promoted
 * steer, a group round), so the Clip box drops a spent Clip without a reload. Only when a countdown
 * was spent: a send with only "until removed" Clips changes nothing a tab shows. The notice cannot
 * fail the send: the spend it reports is already saved.
 */
async function consumePostCompileSessionClips(
  sessionId: string,
  onlyClipIds?: ReadonlySet<string>,
) {
  const stateKey = `session:${sessionId}:clip_state`
  const existingState = await redis.get(stateKey)
  if (!existingState) return

  const currentState = normalizeSessionClipState(sessionId, existingState)
  const spentClipIds = listCountdownClipIds(currentState).filter(
    (clipId) => !onlyClipIds || onlyClipIds.has(clipId),
  )
  const nextState = decrementSessionClipDurations(currentState, onlyClipIds)

  await redis.set(stateKey, nextState)

  const activeKey = `session:${sessionId}:active_clips`
  const activeClipIds = listActiveClipIds(nextState)
  await redis.del(activeKey)
  for (const activeClipId of activeClipIds) {
    await redis.sAdd(activeKey, activeClipId)
  }

  if (spentClipIds.length > 0) {
    try {
      await publishSessionEvent(sessionId, {
        type: 'clip_state_changed',
        source: 'countdown',
      })
    } catch (error) {
      console.warn('[send-routed] Could not tell the chat\'s tabs a Clip countdown was spent:', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

/** BL-600: the chat's Clips that carry a countdown, as a group round's first compile left them. */
async function readCountdownClipIds(sessionId: string): Promise<string[]> {
  return listCountdownClipIds(
    normalizeSessionClipState(sessionId, await redis.get(`session:${sessionId}:clip_state`)),
  )
}

async function collectTrustedClipIdsForSession(
  sessionId: string,
  metadata: unknown,
): Promise<string[]> {
  const ids = new Set(collectTrustedClipIdsFromMetadata(metadata))

  try {
    const state = normalizeSessionClipState(
      sessionId,
      await redis.get(`session:${sessionId}:clip_state`),
    )
    for (const clipId of listActiveClipIds(state)) {
      ids.add(clipId)
    }
  } catch (error) {
    console.warn('[send-routed] Failed to load trusted session clip ids', {
      sessionId,
      error,
    })
  }

  return Array.from(ids)
}

function shouldEnableTools(
  providerId: string | null | undefined,
  capabilities?: ModelCapabilities | null,
): boolean {
  const normalized = providerId?.toLowerCase().trim() ?? ''
  if (capabilities?.tools === false) return false
  if (isLocalProviderId(normalized)) {
    return capabilities?.tools === true
  }
  return true
}

function normalizeImageTransport(value: unknown): ImageTransportOverride {
  if (value === 'url' || value === 'auto') {
    return value
  }
  return 'auto'
}

const DATA_IMAGE_URL_IN_TEXT_REGEX =
  /data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)/gi

/** SA-113 F-P1-5: the wake registry aborts with `wake_timeout` or `wake_stop`; carried verbatim. */
function wakeAbortReason(source: AbortSignal): 'wake_timeout' | 'wake_stop' {
  return source.reason === 'wake_timeout' ? 'wake_timeout' : 'wake_stop'
}

/** A turn's Stop carries its own reason (`user`, or `session_deleted`). */
function sourceAbortReason(source: AbortSignal): unknown {
  return source.reason
}

function createRoutedInputError(
  message: string,
  code: string,
  status = 400,
): Error & { code: string; status: number } {
  const err = new Error(message) as Error & { code: string; status: number }
  err.code = code
  err.status = status
  return err
}

/**
 * BL-965: the agent's record as it is when a turn starts. A turn that starts after a wait (a send
 * in the chat's line, a continuation, a promoted or held turn, a later speaker of a group round)
 * reads it again, so a record made tighter during the wait (Settings, the chat bar, another
 * window) bounds the run, never the older copy the request read when it arrived. The same read
 * as the request's first (`getAgents`, one normalized shape). Null when the agent is gone or is
 * not this user's.
 */
async function readAgentRecordForTurn(userId: string, agentId: string): Promise<AgentRow | null> {
  const row = (await redis.getAgents(userId)).find((candidate) => candidate.id === agentId)
  return row && row.user_id === userId ? row : null
}

/** A follow-up turn of this request whose agent is gone ends visibly on its own message. */
async function readAgentRecordForFollowUpTurn(userId: string, agentId: string): Promise<AgentRow> {
  const row = await readAgentRecordForTurn(userId, agentId)
  if (!row) {
    throw createRoutedInputError(
      'This agent was deleted (or could not be read) before this turn could start, so it did not run.',
      'AGENT_NOT_FOUND',
      404,
    )
  }
  return row
}

function getFailureStatus(error: unknown): number | null {
  const planStatus = chatgptPlanHttpStatus(error)
  if (planStatus !== null) return planStatus
  const status = (error as any)?.status ?? (error as any)?.statusCode
  return typeof status === 'number' && Number.isFinite(status) ? status : null
}

function getFailureCode(error: unknown): string | null {
  const code = (error as any)?.code
  return typeof code === 'string' && code.trim().length > 0
    ? code.trim()
    : null
}

function getFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim()
  }
  const message = String(error ?? '').trim()
  return message || 'The response failed before streaming started.'
}

async function extractFailurePayload(response: Response): Promise<{
  message: string
  details: string | null
  code: string | null
}> {
  const payload = await response.clone().json().catch(() => null)
  const error =
    payload && typeof payload?.error === 'string'
      ? payload.error.trim()
      : ''
  const details =
    payload && typeof payload?.details === 'string'
      ? payload.details.trim()
      : ''
  const code =
    payload && typeof payload?.code === 'string' ? payload.code.trim() : ''

  return {
    message:
      (details && details !== error ? details : error) ||
      'The response failed before streaming started.',
    details: details || null,
    code: code || null,
  }
}

/**
 * BL-775: failures whose record the stream handler already saved before it told the tabs (an
 * approval resume's early start that the model call then failed). The POST's own catch does not
 * save them a second time.
 */
const failuresSavedBeforeThrow = new WeakSet<object>()

class ApprovalResumeAcquisitionError extends Error {
  readonly approvalResumeVersion: number

  constructor(cause: unknown, approvalResumeVersion: number) {
    super(getFailureMessage(cause), { cause })
    this.name = cause instanceof Error ? cause.name : 'Error'
    this.stack = cause instanceof Error ? cause.stack : this.stack
    this.approvalResumeVersion = approvalResumeVersion
    if (cause && typeof cause === 'object') {
      for (const key of ['code', 'status', 'statusCode'] as const) {
        if (key in cause) (this as any)[key] = (cause as any)[key]
      }
    }
  }
}

/** BL-775: why the finalize had no record to rebuild: none was made for this reply. */
const NO_STREAM_RECORD_REASON = 'the reply has no stream record'

/** BL-775: how long a stopped reply's failed save waits before its one retry. */
const STOPPED_REPLY_SAVE_RETRY_MS = 300
/** BL-775: what the tabs are told when a stopped reply could not be saved even on the retry. */
const STOPPED_REPLY_NOT_SAVED_TEXT = 'This reply could not be saved.'

/** The reply-end step's keys (SA-129 P2), the ones `mergeResumedMetadata` joins across a card. */
const REPLY_END_METADATA_KEYS = ['zipControl', 'memorySaves', 'controlErrors', 'zipHolds', REPLY_CONTROL_FINALIZED_FLAG]

/**
 * BL-542: the reply-end record a failed turn keeps: the step's own keys, joined with the part
 * before the card on an in-place resume (`prior`). Only those keys: the rest of the failure record
 * is the failure's.
 *
 * `prior` is the record FROZEN before the resume ran (`approvalResumePrior`), never a fresh read:
 * a finalize save can write the joined record and still throw after it (the list push and the
 * session update come after the write), or a tab can save `end` back first, and joining the
 * joined record again doubles every list (`controlErrors`, `zipHolds`, the notes).
 */
function carriedReplyEndMetadata(
  replyEnd: Record<string, any> | null | undefined,
  prior: { metadata?: unknown } | null,
): Record<string, any> {
  if (!replyEnd || typeof replyEnd !== 'object') return {}
  const joined = prior ? mergeResumedMetadata(prior.metadata, replyEnd) : replyEnd
  const carried: Record<string, any> = {}
  for (const key of REPLY_END_METADATA_KEYS) {
    if (joined[key] !== undefined) carried[key] = joined[key]
  }
  return carried
}

async function persistFailedAssistantTurn(options: {
  sessionId?: string | null
  userId?: string | null
  agentId?: string | null
  messageId?: string | null
  message: string
  details?: string | null
  code?: string | null
  status?: number | null
  metadata?: Record<string, any> | null
  /**
   * An API-lane approval resume writes into the message the card was ON. Its failure keeps
   * the words already there (`resolveFailedTurnContent`) and says so on the user channel,
   * including failures before the versioned resume start reaches watching tabs.
   */
  inPlaceResume?: boolean
  /** Server-minted run version; browser metadata cannot set the expected origin version. */
  imageOriginVersion?: number
  /**
   * The turn failed before its stream sent anything (bug sweep item 2, 2026-09-18): no stream
   * event reaches another tab showing the chat, which showed the user's words with no reply and
   * no error until it reloaded. Said on the user channel so every tab re-reads the chat.
   */
  noStreamEvent?: boolean
  /**
   * BL-542: what the reply-end step stored (`replyControlDone.metadata`) when it ran and both
   * finalize saves then failed. The saves, holds, and notes happened, so the failed record keeps
   * their chips and records; on an in-place resume they are joined with the part before the card
   * (`mergeResumedMetadata`), as the finalize would have joined them.
   */
  replyEndMetadata?: Record<string, any> | null
  /**
   * The part before the card as it was frozen before the resume ran (`approvalResumePrior`), the
   * base `replyEndMetadata` is joined onto; the fresh read below is for the words only.
   */
  replyEndPrior?: { metadata?: unknown } | null
  /**
   * BL-775: the model and provider of the turn, when the caller resolved them. Written on the
   * record as a reply's finalize writes them; when absent, the agent's own named model is used,
   * and when that is absent too they stay unknown.
   */
  model?: string | null
  provider?: string | null
}) {
  const sessionId =
    typeof options.sessionId === 'string' ? options.sessionId.trim() : ''
  const userId = typeof options.userId === 'string' ? options.userId.trim() : ''
  const agentId =
    typeof options.agentId === 'string' ? options.agentId.trim() : ''
  const messageId =
    typeof options.messageId === 'string' ? options.messageId.trim() : ''

  if (!sessionId || !userId || !agentId || !messageId) return

  const now = new Date().toISOString()
  const cleanMessage =
    redactDataImageUrlsInText(
      options.message?.trim() ||
        options.details?.trim() ||
        'The response failed before streaming started.',
    ).value || 'The response failed before streaming started.'
  const cleanDetails =
    typeof options.details === 'string' && options.details.trim().length > 0
      ? redactDataImageUrlsInText(options.details.trim()).value
      : null

  try {
    const inPlaceResume = options.inPlaceResume === true
    const prior = inPlaceResume ? await readStoredAssistantRecord(sessionId, messageId) : null
    const content = resolveFailedTurnContent({
      inPlaceResume,
      errorText: cleanMessage,
      prior,
    })
    // BL-775: the fields a tab's save used to write. The allow-list is always written (a record
    // without it trusts every reference in its text): the zips the kept words name, joined with the
    // part before the card's own list on an in-place resume.
    const priorMetadata =
      prior?.metadata && typeof prior.metadata === 'object' ? (prior.metadata as Record<string, any>) : {}
    // An unknown resumed half must be explicit: Redis shallow-merges omitted metadata keys.
    // Runtime callers pass joined accounting from their frozen prefix. A pre-stream failure
    // has none yet, so continue the record once with an explicitly unknown new half.
    const incomingMetadata = options.metadata ?? {}
    const failureMetadata = inPlaceResume && !Object.prototype.hasOwnProperty.call(incomingMetadata, 'usage')
      ? mergeResumedMetadata(
          (options.replyEndPrior?.metadata ?? prior?.metadata) as Record<string, any> | undefined,
          { ...incomingMetadata, usage: null },
        )
      : incomingMetadata
    const zipIds = Array.from(
      new Set([
        ...(Array.isArray(priorMetadata.zipIds) ? priorMetadata.zipIds.filter((id: unknown) => typeof id === 'string') : []),
        ...replyEndZipIds(content, priorMetadata.zipReferences),
      ]),
    )
    const namedText = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
    let model = namedText(options.model)
    let provider = namedText(options.provider)
    if (!model || !provider) {
      // A writer later in the request (the POST's own catch) knows no model: the record an
      // earlier writer of this turn stored keeps its, else the agent's own named model.
      const stored = (await redis.execute((client) => client.json.get(`message:${sessionId}:${messageId}`))) as
        | Record<string, unknown>
        | null
      model ??= namedText(stored?.model)
      provider ??= namedText(stored?.provider)
    }
    if (!model || !provider) {
      const agentRecord = (await redis.execute((client) => client.json.get(`agent:${agentId}`))) as
        | Record<string, unknown>
        | null
      model ??= namedText(agentRecord?.primary_model_name)
      provider ??= namedText(agentRecord?.primary_model_provider)
    }
    await redis.saveMessage({
      id: messageId,
      session_id: sessionId,
      user_id: userId,
      agent_id: agentId,
      role: 'assistant',
      status: 'error',
      model,
      provider,
      content,
      created_at: now,
      metadata: {
        ...failureMetadata,
        ...carriedReplyEndMetadata(
          options.replyEndMetadata,
          inPlaceResume ? (options.replyEndPrior ?? null) : null,
        ),
        zipIds,
        imageOriginExpected: true,
        // A preparation failure never began a new image-provenance run. The unchanged
        // card text keeps its actual stored version; a real resume supplies its own.
        imageOriginExpectedVersion: options.imageOriginVersion ??
          (Number.isSafeInteger(priorMetadata.imageOriginExpectedVersion) && priorMetadata.imageOriginExpectedVersion >= 1
            ? priorMetadata.imageOriginExpectedVersion : FIRST_IMAGE_ORIGIN_VERSION),
        error_message: cleanMessage,
        response_failed: true,
        failed_at: now,
        ...(cleanDetails && cleanDetails !== cleanMessage
          ? { error_details: cleanDetails }
          : {}),
        ...(options.code ? { error_code: options.code } : {}),
        ...(typeof options.status === 'number'
          ? { http_status: options.status }
          : {}),
      },
    } as Partial<ChatMessage>)
    if (inPlaceResume || options.noStreamEvent === true) {
      await publishUserEvent(userId, {
        type: 'session_messages_changed',
        sessionId,
        reason: inPlaceResume ? 'approval_resume' : 'turn_failed',
      })
    }
  } catch (persistError) {
    console.error('[send-routed] Failed to persist assistant error message:', {
      sessionId,
      messageId,
      error: persistError,
    })
  }
}

function redactDataImageUrlsInText(value: string): {
  value: string
  redactions: number
} {
  if (!value || !value.toLowerCase().includes('data:image/')) {
    return { value, redactions: 0 }
  }

  let redactions = 0
  const sanitized = value.replace(
    DATA_IMAGE_URL_IN_TEXT_REGEX,
    (_fullMatch, mediaType: string, base64Data: string) => {
      redactions += 1
      const approxBytes = Math.max(0, Math.floor((base64Data.length * 3) / 4))
      return `[redacted ${mediaType} data URL (${approxBytes} bytes)]`
    },
  )

  return { value: sanitized, redactions }
}

function findDataImageUrlInTextMessages(
  messages: any[],
): { messageIndex: number; role: string | null } | null {
  for (
    let messageIndex = 0;
    messageIndex < messages.length;
    messageIndex += 1
  ) {
    const message = messages[messageIndex]
    const role = typeof message?.role === 'string' ? message.role : null
    const content = message?.content

    if (typeof content === 'string') {
      if (DATA_IMAGE_URL_IN_TEXT_REGEX.test(content)) {
        DATA_IMAGE_URL_IN_TEXT_REGEX.lastIndex = 0
        return { messageIndex, role }
      }
      DATA_IMAGE_URL_IN_TEXT_REGEX.lastIndex = 0
      continue
    }

    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (typeof part === 'string') {
        if (DATA_IMAGE_URL_IN_TEXT_REGEX.test(part)) {
          DATA_IMAGE_URL_IN_TEXT_REGEX.lastIndex = 0
          return { messageIndex, role }
        }
        DATA_IMAGE_URL_IN_TEXT_REGEX.lastIndex = 0
        continue
      }

      if (part?.type !== 'text' || typeof part?.text !== 'string') continue
      if (DATA_IMAGE_URL_IN_TEXT_REGEX.test(part.text)) {
        DATA_IMAGE_URL_IN_TEXT_REGEX.lastIndex = 0
        return { messageIndex, role }
      }
      DATA_IMAGE_URL_IN_TEXT_REGEX.lastIndex = 0
    }
  }

  return null
}

function hasDataImageUrlInUserTurnContent(content: unknown): boolean {
  if (typeof content === 'string') {
    const result = DATA_IMAGE_URL_IN_TEXT_REGEX.test(content)
    DATA_IMAGE_URL_IN_TEXT_REGEX.lastIndex = 0
    return result
  }

  if (Array.isArray(content)) {
    return content.some((entry) => hasDataImageUrlInUserTurnContent(entry))
  }

  if (!content || typeof content !== 'object') return false
  const candidate = content as Record<string, unknown>

  if (typeof candidate.text === 'string') {
    const result = DATA_IMAGE_URL_IN_TEXT_REGEX.test(candidate.text)
    DATA_IMAGE_URL_IN_TEXT_REGEX.lastIndex = 0
    if (result) return true
  }

  if (typeof candidate.content === 'string') {
    const result = DATA_IMAGE_URL_IN_TEXT_REGEX.test(candidate.content)
    DATA_IMAGE_URL_IN_TEXT_REGEX.lastIndex = 0
    if (result) return true
  }

  return false
}

function sanitizeDataImageUrlsInTextMessages(messages: any[]): {
  redactions: number
} {
  let redactions = 0

  for (const message of messages) {
    const content = message?.content

    if (typeof content === 'string') {
      const sanitized = redactDataImageUrlsInText(content)
      if (sanitized.redactions > 0) {
        message.content = sanitized.value
        redactions += sanitized.redactions
      }
      continue
    }

    if (!Array.isArray(content)) continue
    for (let partIndex = 0; partIndex < content.length; partIndex += 1) {
      const part = content[partIndex]
      if (typeof part === 'string') {
        const sanitized = redactDataImageUrlsInText(part)
        if (sanitized.redactions > 0) {
          content[partIndex] = sanitized.value
          redactions += sanitized.redactions
        }
        continue
      }

      if (part?.type !== 'text' || typeof part?.text !== 'string') continue
      const sanitized = redactDataImageUrlsInText(part.text)
      if (sanitized.redactions > 0) {
        part.text = sanitized.value
        redactions += sanitized.redactions
      }
    }
  }

  return { redactions }
}

function sanitizePayloadForLogs<T>(value: T, keyHint?: string): T {
  const seen = new WeakSet<object>()

  const sanitizeString = (input: string, key?: string): string => {
    const dataUrlSanitized = redactDataImageUrlsInText(input)
    let next = dataUrlSanitized.value
    const base64Key = key
      ? /(base64|localbase64|b64|b64_json|image_data)/i.test(key)
      : false

    if (base64Key) {
      const trimmed = next.trim()
      if (
        trimmed.length > 0 &&
        (isLikelyBase64(trimmed) || trimmed.startsWith('data:'))
      ) {
        const approxBytes = Math.max(0, Math.floor((trimmed.length * 3) / 4))
        return `[redacted base64 payload (${approxBytes} bytes)]`
      }
    }

    return next
  }

  const visit = (node: unknown, key?: string): unknown => {
    if (typeof node === 'string') {
      return sanitizeString(node, key)
    }
    if (!node || typeof node !== 'object') {
      return node
    }
    if (seen.has(node as object)) {
      return node
    }
    seen.add(node as object)

    if (Array.isArray(node)) {
      return node.map((entry) => visit(entry, key))
    }

    const output: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(
      node as Record<string, unknown>,
    )) {
      output[childKey] = visit(childValue, childKey)
    }
    return output
  }

  return visit(value, keyHint) as T
}

async function resolveImageTransportConfig(options: {
  userId: string
  providerId: string | null
  presetId?: string | null
  localServers?: Awaited<ReturnType<typeof listLocalAiServers>> | null
}): Promise<{
  transport: ImageTransportOverride
  imageBaseUrl?: string | null
}> {
  const { userId, providerId, presetId } = options
  if (!providerId || !isLocalProviderId(providerId)) {
    return { transport: 'auto' }
  }

  const localServers =
    options.localServers ??
    (userId ? await listLocalAiServers(userId) : null)
  const server = localServers?.find((entry) => entry.id === providerId) ?? null
  const defaultTransport = server?.imageTransport ?? 'auto'
  const imageBaseUrl = server?.imageBaseUrl ?? null

  let presetTransport: ImageTransportOverride = 'auto'
  if (presetId) {
    try {
      const preset = (await redis.get(`model:${presetId}`)) as SavedModel | null
      presetTransport = normalizeImageTransport(preset?.imageTransport)
    } catch (error) {
      console.warn(
        '[Send-Routed] Failed to load model preset image transport:',
        error,
      )
    }
  }

  const transport =
    presetTransport !== 'auto' ? presetTransport : defaultTransport

  return { transport, imageBaseUrl }
}

function normalizeToolApprovalMode(value: unknown): ToolApprovalMode {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'all') return 'all'
    if (normalized === 'off' || normalized === 'none' || normalized === 'never')
      return 'off'
  }
  if (value === true) return 'all'
  return 'off'
}

/**
 * BL-941 (R5): a CLI run's Tool Approval, with the agent's record as its upper bound. `all` (ask
 * before a tool runs) is tighter than `off`, so the tighter of the send's value and the record's
 * wins; a send that names none leaves the record's.
 */
function tighterToolApprovalMode(sent: unknown, record: unknown): ToolApprovalMode {
  const recordMode = normalizeToolApprovalMode(record)
  if (sent === undefined || sent === null) return recordMode
  return recordMode === 'all' || normalizeToolApprovalMode(sent) === 'all' ? 'all' : 'off'
}

function normalizeToolApprovalResponses(
  value: unknown,
): ToolApprovalResponse[] {
  if (!Array.isArray(value)) return []
  const responses: ToolApprovalResponse[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const approvalId = (entry as any).approvalId || (entry as any).approval_id
    const approved = (entry as any).approved
    if (typeof approvalId !== 'string' || approvalId.trim().length === 0)
      continue
    if (typeof approved !== 'boolean') continue
    const response: ToolApprovalResponse = {
      type: 'tool-approval-response',
      approvalId: approvalId.trim(),
      approved,
    }
    if (typeof (entry as any).reason === 'string') {
      response.reason = (entry as any).reason
    }
    responses.push(response)
  }
  return responses
}

/** One owner, in `toolApprovalState.ts`; aliased because this file reads timestamps well beyond approvals. */
const parseTimestampMs = parseApprovalTimestampMs


function buildInterruptionAddendum(raw: unknown) {
  if (!raw || typeof raw !== 'object') return null

  const record = raw as Record<string, any>
  const note = typeof record.note === 'string' ? record.note.trim() : ''
  const previousMessageId =
    typeof record.previousMessageId === 'string' &&
    record.previousMessageId.trim().length > 0
      ? record.previousMessageId.trim()
      : null

  const lines = [
    '==== INTERRUPTION NOTE ====',
    'The previous response was interrupted by the user while streaming.',
    'Partial output (if any) is preserved in the chat history above.',
  ]

  if (previousMessageId) {
    lines.push(`Previous message id: ${previousMessageId}.`)
  }

  if (note) {
    lines.push(note)
  }

  return lines.join('\n')
}

function buildContextContinuationAddendum(raw: unknown) {
  if (!raw || typeof raw !== 'object') return null

  const record = raw as Record<string, any>
  const attempt = Number.isFinite(record.attempt) ? Number(record.attempt) : null
  const maxAttempts = Number.isFinite(record.maxAttempts)
    ? Number(record.maxAttempts)
    : null
  const previousMessageId =
    typeof record.previousMessageId === 'string' &&
    record.previousMessageId.trim().length > 0
      ? record.previousMessageId.trim()
      : null

  const lines = [
    '==== CONTEXT LIMIT CONTINUATION ====',
    'Your previous response hit the model context window limit mid-task and was stopped.',
    'The partial work, including every completed tool call, is preserved in the chat history above. Do not redo steps that already completed.',
    'Pick the original task back up from exactly where it stopped and continue working. If only a final summary remained, provide it now.',
  ]

  if (previousMessageId) {
    lines.push(`Interrupted message id: ${previousMessageId}.`)
  }

  if (attempt && maxAttempts) {
    lines.push(
      `This is automatic continuation ${attempt} of at most ${maxAttempts} for this user request. Be efficient with remaining context: prefer summarizing over re-reading large files.`,
    )
  }

  return lines.join('\n')
}

async function extractToolApprovalRequests(
  result: any,
): Promise<ToolApprovalEntry[]> {
  try {
    const approvals: ToolApprovalEntry[] = []
    const seenApprovalIds = new Set<string>()
    const resolvedApprovalIds = new Set<string>()
    const partCollections: any[][] = []

    const addParts = (parts: unknown) => {
      if (Array.isArray(parts) && parts.length > 0) {
        partCollections.push(parts as any[])
      }
    }

    const addMessageContents = (messages: unknown) => {
      if (!Array.isArray(messages)) return
      for (const message of messages) {
        addParts((message as any)?.content)
      }
    }

    addParts(await Promise.resolve((result as any)?.content))
    addMessageContents(
      await Promise.resolve((result as any)?.response?.messages),
    )
    addMessageContents(await Promise.resolve((result as any)?.responseMessages))
    addMessageContents(await Promise.resolve((result as any)?.providerMessages))
    addMessageContents(
      await Promise.resolve((result as any)?.providerResponse?.messages),
    )

    const steps = await Promise.resolve((result as any)?.steps)
    if (Array.isArray(steps)) {
      for (const step of steps) {
        addParts((step as any)?.content)
        addMessageContents((step as any)?.response?.messages)
      }
    }

    const resolveToolCallId = (part: any): string => {
      if (typeof part?.toolCallId === 'string') return part.toolCallId
      if (typeof part?.tool_call_id === 'string') return part.tool_call_id
      if (typeof part?.toolCall?.toolCallId === 'string')
        return part.toolCall.toolCallId
      if (typeof part?.tool_call?.toolCallId === 'string')
        return part.tool_call.toolCallId
      return ''
    }

    const resolveApprovalId = (part: any): string => {
      if (typeof part?.approvalId === 'string') return part.approvalId.trim()
      if (typeof part?.approval_id === 'string') return part.approval_id.trim()
      return ''
    }

    const extractToolName = (toolCall: any): string | undefined => {
      return typeof toolCall?.toolName === 'string'
        ? toolCall.toolName
        : typeof toolCall?.tool_name === 'string'
          ? toolCall.tool_name
          : typeof toolCall?.name === 'string'
            ? toolCall.name
            : undefined
    }

    for (const parts of partCollections) {
      for (const part of parts) {
        if (
          part?.type !== 'tool-approval-response' &&
          part?.type !== 'tool_approval_response'
        ) {
          continue
        }
        const approvalId = resolveApprovalId(part)
        if (approvalId) {
          resolvedApprovalIds.add(approvalId)
        }
      }
    }

    for (const parts of partCollections) {
      const toolCallsById = new Map<string, any>()
      for (const part of parts) {
        if (part?.type !== 'tool-call') continue
        const callId = resolveToolCallId(part)
        if (!callId) continue
        toolCallsById.set(callId, {
          toolCallId: callId,
          toolName: part.toolName ?? part.tool_name ?? part.name,
          input: part.input ?? part.args ?? part.parameters,
        })
      }

      for (const part of parts) {
        if (part?.type !== 'tool-approval-request') continue

        const approvalId = resolveApprovalId(part)
        if (
          !approvalId ||
          seenApprovalIds.has(approvalId) ||
          resolvedApprovalIds.has(approvalId)
        )
          continue

        const callId = resolveToolCallId(part)
        const explicitToolCall =
          part.toolCall && typeof part.toolCall === 'object'
            ? part.toolCall
            : part.tool_call && typeof part.tool_call === 'object'
              ? part.tool_call
              : undefined
        const fallbackToolCall = callId ? toolCallsById.get(callId) : undefined
        const toolCall = explicitToolCall ?? fallbackToolCall
        const toolName = extractToolName(toolCall)
        const input =
          toolCall?.input ?? toolCall?.args ?? toolCall?.parameters ?? undefined
        const requestedAt =
          typeof part?.requestedAt === 'string' &&
          part.requestedAt.trim().length > 0
            ? part.requestedAt.trim()
            : new Date().toISOString()
        const requestedAtMs = parseTimestampMs(requestedAt)
        const expiresAtMs =
          typeof part?.expiresAt === 'string' &&
          part.expiresAt.trim().length > 0
            ? parseTimestampMs(part.expiresAt.trim())
            : requestedAtMs !== null
              ? requestedAtMs + TOOL_APPROVAL_TIMEOUT_MS
              : Date.now() + TOOL_APPROVAL_TIMEOUT_MS
        const expiresAt =
          typeof part?.expiresAt === 'string' &&
          part.expiresAt.trim().length > 0
            ? part.expiresAt.trim()
            : new Date(
                expiresAtMs ?? Date.now() + TOOL_APPROVAL_TIMEOUT_MS,
              ).toISOString()

        approvals.push({
          approvalId,
          status: 'pending',
          requestedAt,
          expiresAt,
          toolName,
          toolCall:
            toolCall && typeof toolCall === 'object' ? toolCall : undefined,
          input,
          source: 'vercel',
        })
        seenApprovalIds.add(approvalId)
      }
    }

    return approvals
  } catch (error) {
    console.warn('[Send-Routed] Failed to parse tool approval requests', error)
    return []
  }
}

type RawSubagent = Record<string, any>

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stripToolPartOnlyText(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  const normalized = trimmed.replace(/\s+/g, '')
  const toolPartOnlyPattern =
    /^(?:\[(?:tool-call|tool_call|tool-result|tool_result|tool-approval-request|tool_approval_request|tool-approval-response|tool_approval_response)\])+$/i
  if (toolPartOnlyPattern.test(normalized)) {
    return ''
  }
  return value
}

/**
 * SA-105 P1 (DL-105-05a, AMD-105-04): keep in-turn image bytes out of persisted
 * provider context.
 *
 * The body now lives in the shared `toolResultImageDelivery` helper, which keys
 * on PART SHAPE and the ephemeral marker instead of on tool names. The previous
 * version matched only `native_bash_execute` / `native_agent_browser_use` plus
 * the deprecated `image-*` part types, and that had two teeth: changing Agent
 * Browser's output shape without changing this in the same commit would have
 * silently started persisting screenshot base64, and memory recall — which
 * arrives as `batshit_tool_use` — would never have matched at all.
 *
 * This is the load-bearing boundary, not a nicety: persisted provider messages
 * are replayed into later provider calls on a tool-approval resume (BL-322:
 * every step of the paused reply, `approvalResumeReplay.ts`).
 */
function sanitizeProviderMessagesForPersistence(
  providerMessages: ModelMessage[],
): ModelMessage[] {
  return stripEphemeralImagesFromProviderMessages(providerMessages)
}

function normalizeToolResult(
  raw: any,
  toolName: string | undefined,
  input: Record<string, any>,
) {
  const parsed = parseJsonLike(raw)
  const lowerName = toolName?.toLowerCase() ?? ''

  if (Array.isArray(parsed) && parsed.length > 0) {
    const first = parsed[0]

    if (first?.type === 'coolToolResult' && first?.toolResult !== undefined) {
      return normalizeToolResult(first.toolResult, toolName, input)
    }

    if (first?.type === 'text' && typeof first.text === 'string') {
      return normalizeToolResult(first.text, toolName, input)
    }

    return parsed
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const normalized: Record<string, any> = { ...parsed }

    if (
      input &&
      typeof input === 'object' &&
      !Array.isArray(input) &&
      normalized.Prompt__User_Message_ === undefined &&
      typeof (input as any).Prompt__User_Message_ === 'string'
    ) {
      normalized.Prompt__User_Message_ = (input as any).Prompt__User_Message_
    }

    if (!normalized.filePath) {
      if (typeof normalized.file_path === 'string') {
        normalized.filePath = normalized.file_path
      } else if (typeof normalized.path === 'string') {
        normalized.filePath = normalized.path
      } else if (typeof input.filePath === 'string') {
        normalized.filePath = input.filePath
      }
    }

    if (!normalized.content && typeof normalized.newContent === 'string') {
      normalized.content = normalized.newContent
    }

    if (!normalized.content && typeof normalized.updatedContent === 'string') {
      normalized.content = normalized.updatedContent
    }

    if (
      normalized.input === undefined &&
      input &&
      Object.keys(input).length > 0
    ) {
      normalized.input = input
    }

    return lowerName.includes('web_search')
      ? applyUnavailableWebSearchMetadata(normalized)
      : normalized
  }

  if (typeof parsed === 'string') {
    if (lowerName.endsWith('read_file')) {
      return {
        content: parsed,
        filePath: input.filePath,
      }
    }
  }

  return parsed
}

type ImageOutput = {
  dataUrl?: string
  filePath?: string
  mediaType: string
}

const DEFAULT_IMAGE_MEDIA_TYPE = 'image/png'
const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/
const MAX_LOCAL_IMAGE_OUTPUT_BYTES = 15 * 1024 * 1024
const AGENT_BROWSER_SCREENSHOT_ARTIFACT_TTL_SECONDS = 24 * 60 * 60
const LOCAL_IMAGE_EXT_TO_MEDIA: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
}

async function readLocalImageOutputWithinLimit(filePath: string): Promise<Buffer | null> {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(MAX_LOCAL_IMAGE_OUTPUT_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, MAX_LOCAL_IMAGE_OUTPUT_BYTES + 1, 0)
    if (bytesRead <= 0 || bytesRead > MAX_LOCAL_IMAGE_OUTPUT_BYTES) return null
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function isLikelyBase64(value: string) {
  if (!value) return false
  const trimmed = value.trim()
  if (trimmed.length < 100) return false
  return BASE64_REGEX.test(trimmed)
}

function inferImageMediaTypeFromPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase()
  return LOCAL_IMAGE_EXT_TO_MEDIA[ext] ?? null
}

function isLikelyLocalImagePath(value: string): boolean {
  const mediaType = inferImageMediaTypeFromPath(value)
  return Boolean(mediaType)
}

function normalizeLocalImagePath(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://'))
    return null
  if (trimmed.startsWith('data:')) return null

  if (trimmed.startsWith('attachment:')) {
    const attachmentPath = trimmed.slice('attachment:'.length).trim()
    if (!attachmentPath) return null
    if (
      path.isAbsolute(attachmentPath) ||
      attachmentPath.startsWith('./') ||
      attachmentPath.startsWith('../')
    ) {
      return path.resolve(attachmentPath)
    }
    if (isLikelyLocalImagePath(attachmentPath)) {
      return path.resolve(attachmentPath)
    }
    return null
  }

  if (trimmed.startsWith('file://')) {
    try {
      const parsed = new URL(trimmed)
      const decoded = decodeURIComponent(parsed.pathname)
      return path.resolve(decoded)
    } catch {
      return null
    }
  }

  if (
    path.isAbsolute(trimmed) ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../')
  ) {
    return path.resolve(trimmed)
  }

  // Agent Browser can return relative screenshot paths like "example.com.png".
  if (isLikelyLocalImagePath(trimmed)) {
    return path.resolve(trimmed)
  }

  return null
}

function extractMediaTypeFromDataUrl(value: string) {
  const match = /^data:([^;]+);/i.exec(value)
  return match?.[1] || null
}

function ensureDataUrl(value: string, mediaType?: string) {
  const trimmed = value.trim()
  if (trimmed.startsWith('data:')) {
    return trimmed
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed
  }
  const resolvedType = mediaType || DEFAULT_IMAGE_MEDIA_TYPE
  return `data:${resolvedType};base64,${trimmed}`
}

function isImageToolName(toolName?: string | null) {
  if (!toolName) return false
  const lowered = toolName.toLowerCase()
  return (
    lowered.includes('image_generation') ||
    lowered.includes('image-generation') ||
    lowered.includes('generate_image')
  )
}

function isNativeAgentBrowserUseToolName(toolName?: string | null): boolean {
  if (!toolName) return false
  const normalized = toolName.toLowerCase().trim()
  return (
    normalized === 'native_agent_browser_use' ||
    normalized === 'agent_browser_use'
  )
}

function isNativeBashExecuteToolName(toolName?: string | null): boolean {
  if (!toolName) return false
  const normalized = toolName.toLowerCase().trim()
  return normalized === 'native_bash_execute' || normalized === 'bash_execute'
}

const AGENT_BROWSER_BASH_CHAIN_OPERATOR_REGEX = /\s(?:&&|\|\||;)\s/
const AGENT_BROWSER_BASH_FLAGS_WITH_VALUE = new Set([
  '--cdp',
  '--provider',
  '-p',
  '--executable-path',
  '--session',
  '--profile',
])

type AgentBrowserBashCommandParts = {
  rest: string
}

function unquoteAgentBrowserShellToken(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function isShellIdentifierStart(char: string): boolean {
  return (
    (char >= 'A' && char <= 'Z') ||
    (char >= 'a' && char <= 'z') ||
    char === '_'
  )
}

function isShellIdentifierChar(char: string): boolean {
  return isShellIdentifierStart(char) || (char >= '0' && char <= '9')
}

function skipShellWhitespace(value: string, start: number): number {
  let index = start
  while (index < value.length && /\s/.test(value[index] ?? '')) index += 1
  return index
}

function readShellTokenSpan(
  value: string,
  start: number,
): { token: string; start: number; end: number } | null {
  const tokenStart = skipShellWhitespace(value, start)
  if (tokenStart >= value.length) return null

  let index = tokenStart
  let quote: string | null = null
  while (index < value.length) {
    const char = value[index] ?? ''
    if (quote) {
      if (char === quote) quote = null
      index += 1
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      index += 1
      continue
    }
    if (/\s/.test(char)) break
    index += 1
  }

  return {
    token: unquoteAgentBrowserShellToken(value.slice(tokenStart, index)),
    start: tokenStart,
    end: index,
  }
}

function isEnvironmentAssignmentToken(token: string): boolean {
  const equalsIndex = token.indexOf('=')
  if (equalsIndex <= 0) return false
  const name = token.slice(0, equalsIndex)
  if (!isShellIdentifierStart(name[0] ?? '')) return false
  for (const char of name.slice(1)) {
    if (!isShellIdentifierChar(char)) return false
  }
  return true
}

function parseAgentBrowserBashCommand(
  command: string,
): AgentBrowserBashCommandParts | null {
  let index = 0
  while (index < command.length) {
    const token = readShellTokenSpan(command, index)
    if (!token) return null
    if (!isEnvironmentAssignmentToken(token.token)) break
    index = token.end
  }

  const launcherStartToken = readShellTokenSpan(command, index)
  if (!launcherStartToken) return null

  let launcherEnd = launcherStartToken.end
  if (launcherStartToken.token.toLowerCase() === 'npx') {
    let nextToken = readShellTokenSpan(command, launcherEnd)
    if (nextToken?.token === '-y') {
      launcherEnd = nextToken.end
      nextToken = readShellTokenSpan(command, launcherEnd)
    }
    if (nextToken?.token.toLowerCase() !== 'agent-browser') return null
    launcherEnd = nextToken.end
  } else if (launcherStartToken.token.toLowerCase() !== 'agent-browser') {
    return null
  }

  return {
    rest: command.slice(launcherEnd).trim(),
  }
}

function splitShellWordsForAgentBrowser(value: string): string[] {
  const tokens = value.match(/'[^']*'|"[^"]*"|\S+/g) ?? []
  return tokens.map((token) => unquoteAgentBrowserShellToken(token)).filter((token) => token.length > 0)
}

function splitAgentBrowserCommandAtChainForDetection(commandSegment: string): {
  primary: string
} {
  const trimmed = commandSegment.trim()
  if (!trimmed) return { primary: '' }
  const match = AGENT_BROWSER_BASH_CHAIN_OPERATOR_REGEX.exec(trimmed)
  if (!match || typeof match.index !== 'number' || match.index <= 0) {
    return { primary: trimmed }
  }
  return {
    primary: trimmed.slice(0, match.index).trim(),
  }
}

function findAgentBrowserSubcommandIndexForDetection(tokens: string[]): number {
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    if (!token) return -1
    if (token === '--') {
      return index + 1 < tokens.length ? index + 1 : -1
    }
    if (token.startsWith('--')) {
      const [flag] = token.split('=', 1)
      if (
        AGENT_BROWSER_BASH_FLAGS_WITH_VALUE.has(flag) &&
        !token.includes('=')
      ) {
        index += 2
      } else {
        index += 1
      }
      continue
    }
    if (token.startsWith('-') && token.length > 1) {
      if (token === '-p') {
        index += 2
      } else {
        index += 1
      }
      continue
    }
    return index
  }
  return -1
}

function resolveAgentBrowserBashSubcommand(command: string): string | null {
  const parsedCommand = parseAgentBrowserBashCommand(command)
  if (!parsedCommand) return null
  const rest = parsedCommand.rest
  if (!rest) return null
  const { primary } = splitAgentBrowserCommandAtChainForDetection(rest)
  const tokens = splitShellWordsForAgentBrowser(primary)
  if (tokens.length === 0) return null
  const subcommandIndex = findAgentBrowserSubcommandIndexForDetection(tokens)
  if (subcommandIndex < 0) return null
  const subcommand = tokens[subcommandIndex]?.trim().toLowerCase()
  return subcommand || null
}

function extractAgentBrowserBashCommandCandidate(
  payload: any,
  toolInput?: Record<string, any>,
): string | null {
  const candidates = [
    toolInput?.command,
    toolInput?.innerCommand,
    payload?.requestedCommand,
    payload?.command,
    payload?.innerCommand,
    payload?.mappedToolInput?.command,
    payload?.mappedToolInput?.innerCommand,
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim()
    }
  }

  return null
}

function extractAgentBrowserScreenshotModelVisibility(
  payload: any,
): boolean | null {
  const parsed = parseJsonLike(payload)
  const queue: any[] = [parsed]
  const seen = new Set<any>()

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || seen.has(current)) continue
    seen.add(current)

    if (typeof current !== 'object') continue

    const visibilityCandidates = [
      (current as any).modelVisibleInLoop,
      (current as any).model_visible_in_loop,
      (current as any).modelVisibility,
      (current as any).model_visibility,
    ]

    for (const candidate of visibilityCandidates) {
      if (typeof candidate === 'boolean') {
        return candidate
      }
    }

    queue.push((current as any).agentBrowser)
    queue.push((current as any).screenshot)
    queue.push((current as any).result)
    queue.push((current as any).output)
    queue.push((current as any).data)
    queue.push((current as any).content)
    queue.push((current as any).value)
  }

  return null
}

function isAgentBrowserScreenshotInvocation(
  toolName: string | undefined,
  payload: any,
  toolInput?: Record<string, any>,
): boolean {
  if (isNativeAgentBrowserUseToolName(toolName)) {
    const candidates = [
      toolInput?.toolName,
      payload?.toolName,
      payload?.command,
      payload?.result?.toolName,
      payload?.result?.command,
    ]

    return candidates.some(
      (candidate) =>
        normalizeAgentBrowserCommandName(candidate) === 'screenshot',
    )
  }

  if (!isNativeBashExecuteToolName(toolName)) return false

  const agentBrowserCommandCandidates = [
    payload?.agentBrowser?.command,
    payload?.agentBrowser?.screenshot?.command,
  ]
  if (
    agentBrowserCommandCandidates.some(
      (candidate) =>
        normalizeAgentBrowserCommandName(candidate) === 'screenshot',
    )
  ) {
    return true
  }

  const bashCandidate = extractAgentBrowserBashCommandCandidate(
    payload,
    toolInput,
  )
  if (!bashCandidate) return false
  return (
    normalizeAgentBrowserCommandName(
      resolveAgentBrowserBashSubcommand(bashCandidate),
    ) === 'screenshot'
  )
}

function isHttpImageUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed) return false
  return trimmed.startsWith('https://') || trimmed.startsWith('http://')
}

function extractAgentBrowserScreenshotExternalUrl(payload: any): string | null {
  const parsed = parseJsonLike(payload)
  const queue: any[] = [parsed]
  const seen = new Set<any>()

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || seen.has(current)) continue
    seen.add(current)

    if (typeof current === 'string') {
      if (isHttpImageUrl(current)) {
        return current.trim()
      }
      continue
    }

    if (Array.isArray(current)) {
      for (const entry of current) {
        queue.push(entry)
      }
      continue
    }

    if (typeof current !== 'object') continue

    const directCandidates = [
      (current as any).url,
      (current as any).externalUrl,
      (current as any).external_url,
      (current as any).modelImageUrl,
      (current as any).model_image_url,
      (current as any).imageUrl,
      (current as any).image_url,
      (current as any).screenshotUrl,
      (current as any).screenshot_url,
      (current as any).agentBrowser?.modelImageUrl,
      (current as any).agentBrowser?.screenshot?.modelImageUrl,
    ]

    for (const candidate of directCandidates) {
      if (isHttpImageUrl(candidate)) {
        return candidate.trim()
      }
    }

    queue.push((current as any).result)
    queue.push((current as any).output)
    queue.push((current as any).data)
    queue.push((current as any).content)
    queue.push((current as any).value)
    queue.push((current as any).agentBrowser)
    queue.push((current as any).screenshot)
  }

  return null
}

const TOOL_CALL_ID_PREFIXES = ['call_', 'tool_', 'toolcall_', 'tc_']

function isLikelyToolCallId(value?: string | null) {
  if (!value) return false
  return TOOL_CALL_ID_PREFIXES.some((prefix) => value.startsWith(prefix))
}

function resolveToolCallIdFromEvent(payload: any): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const direct =
    typeof payload.toolCallId === 'string'
      ? payload.toolCallId
      : typeof payload.tool_call_id === 'string'
        ? payload.tool_call_id
        : typeof payload.callId === 'string'
          ? payload.callId
          : typeof payload.call_id === 'string'
            ? payload.call_id
            : undefined
  if (direct) return direct
  const fallback = typeof payload.id === 'string' ? payload.id : undefined
  if (fallback && isLikelyToolCallId(fallback)) {
    return fallback
  }
  return undefined
}

function looksLikeImagePayload(payload: any) {
  if (!payload || typeof payload !== 'object') return false
  return (
    'b64_json' in payload ||
    'base64' in payload ||
    'image' in payload ||
    'images' in payload ||
    'data' in payload
  )
}

function collectImageOutputs(
  payload: any,
  outputs: ImageOutput[],
  mediaType?: string,
) {
  if (payload === null || payload === undefined) return

  if (typeof payload === 'string') {
    const trimmed = payload.trim()
    if (!trimmed) return
    if (trimmed.startsWith('data:image/')) {
      outputs.push({
        dataUrl: trimmed,
        mediaType:
          extractMediaTypeFromDataUrl(trimmed) ||
          mediaType ||
          DEFAULT_IMAGE_MEDIA_TYPE,
      })
      return
    }
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      outputs.push({
        dataUrl: trimmed,
        mediaType: mediaType || DEFAULT_IMAGE_MEDIA_TYPE,
      })
      return
    }
    const localPath = normalizeLocalImagePath(trimmed)
    if (localPath && isLikelyLocalImagePath(localPath)) {
      outputs.push({
        filePath: localPath,
        mediaType:
          mediaType ||
          inferImageMediaTypeFromPath(localPath) ||
          DEFAULT_IMAGE_MEDIA_TYPE,
      })
      return
    }
    if (isLikelyBase64(trimmed)) {
      outputs.push({
        dataUrl: ensureDataUrl(trimmed, mediaType),
        mediaType: mediaType || DEFAULT_IMAGE_MEDIA_TYPE,
      })
    }
    return
  }

  if (Array.isArray(payload)) {
    payload.forEach((entry) => collectImageOutputs(entry, outputs, mediaType))
    return
  }

  if (typeof payload !== 'object') return

  const nextMediaType =
    typeof payload.mediaType === 'string'
      ? payload.mediaType
      : typeof payload.mimeType === 'string'
        ? payload.mimeType
        : typeof payload.content_type === 'string'
          ? payload.content_type
          : mediaType

  if (payload.b64_json) {
    collectImageOutputs(payload.b64_json, outputs, nextMediaType)
  }
  if (payload.base64) {
    collectImageOutputs(payload.base64, outputs, nextMediaType)
  }
  if (payload.image) {
    collectImageOutputs(payload.image, outputs, nextMediaType)
  }
  if (payload.result) {
    collectImageOutputs(payload.result, outputs, nextMediaType)
  }
  if (payload.output) {
    collectImageOutputs(payload.output, outputs, nextMediaType)
  }
  if (payload.url) {
    collectImageOutputs(payload.url, outputs, nextMediaType)
  }
  if (payload.path) {
    collectImageOutputs(payload.path, outputs, nextMediaType)
  }
  if (Array.isArray(payload.images)) {
    collectImageOutputs(payload.images, outputs, nextMediaType)
  }
  if (Array.isArray(payload.data)) {
    collectImageOutputs(payload.data, outputs, nextMediaType)
  }
}

function extractImageOutputs(
  toolName: string | undefined,
  payload: any,
  toolInput?: Record<string, any>,
): ImageOutput[] {
  const shouldInspect =
    isImageToolName(toolName) ||
    looksLikeImagePayload(payload) ||
    isAgentBrowserScreenshotInvocation(toolName, payload, toolInput)
  if (!shouldInspect) return []
  const outputs: ImageOutput[] = []
  collectImageOutputs(payload, outputs)
  const seen = new Set<string>()
  return outputs.filter((output) => {
    const key = output.filePath
      ? `path:${output.filePath}`
      : output.dataUrl
        ? `data:${output.dataUrl.slice(0, 64)}`
        : ''
    if (!key) return false
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const ATTACHMENT_IMAGE_LINK_REGEX = /!\[[^\]]*]\(\s*attachment:[^)]+\s*\)/gi
const ATTACHMENT_LINK_REGEX = /\[([^\]]+)\]\(\s*attachment:[^)]+\s*\)/gi
const ATTACHMENT_URL_REGEX = /\battachment:[^\s)]+/gi
const MARKDOWN_IMAGE_LINK_REGEX = /!\[[^\]]*]\(\s*([^)]+)\s*\)/gi
const WINDOWS_ABSOLUTE_PATH_REGEX = /^[a-z]:[\\/]/i
const AGENT_BROWSER_TEMP_FILE_PREFIX = 'batshit-agent-browser-'
const BATSHIT_RUNTIME_TMP_DIR = path.join(os.homedir(), '.batshit', 'tmp')

function extractMarkdownUrlTarget(rawTarget: string): string {
  const trimmed = rawTarget.trim()
  if (!trimmed) return ''

  let withoutTitle = trimmed
  const firstSpaceIdx = withoutTitle.search(/\s/)
  if (firstSpaceIdx >= 0) {
    withoutTitle = withoutTitle.slice(0, firstSpaceIdx)
  }

  let target = withoutTitle.trim()
  if (target.startsWith('<') && target.endsWith('>')) {
    target = target.slice(1, -1).trim()
  }
  if (
    (target.startsWith('"') && target.endsWith('"')) ||
    (target.startsWith("'") && target.endsWith("'"))
  ) {
    target = target.slice(1, -1).trim()
  }

  return target
}

function isLikelyFilesystemImageTarget(target: string): boolean {
  if (!target) return false
  const normalized = target.trim()
  if (!normalized) return false

  const lower = normalized.toLowerCase()
  if (lower.startsWith('attachment:') || lower.startsWith('file://'))
    return true
  if (WINDOWS_ABSOLUTE_PATH_REGEX.test(normalized)) return true
  if (lower.startsWith('\\\\')) return true

  if (
    lower.startsWith('/var/') ||
    lower.startsWith('/private/') ||
    lower.startsWith('/tmp/') ||
    lower.startsWith('/users/') ||
    lower.startsWith('/volumes/') ||
    lower.startsWith('/home/') ||
    lower.startsWith('/root/')
  ) {
    return true
  }

  const looksRelativeLocalPath =
    lower.startsWith('./') ||
    lower.startsWith('../') ||
    (!lower.startsWith('/') && !lower.includes('://'))

  if (!looksRelativeLocalPath) return false

  const withoutQueryOrFragment = normalized.split(/[?#]/, 1)[0] ?? normalized
  return Boolean(inferImageMediaTypeFromPath(withoutQueryOrFragment))
}

function shouldCleanupAgentBrowserTempScreenshot(
  localPath: string | null,
): boolean {
  if (!localPath) return false
  const normalizedPath = path.resolve(localPath)
  const batshitTempRoot = path.resolve(BATSHIT_RUNTIME_TMP_DIR)
  if (normalizedPath.startsWith(`${batshitTempRoot}${path.sep}`)) {
    return true
  }

  const fileName = path.basename(normalizedPath)
  if (!fileName.startsWith(AGENT_BROWSER_TEMP_FILE_PREFIX)) return false
  const tempRoot = path.resolve(os.tmpdir())
  if (normalizedPath === tempRoot) return false
  return normalizedPath.startsWith(`${tempRoot}${path.sep}`)
}

function stripUnrenderableMarkdownImageReferences(content: string): string {
  if (!content || !content.includes('![')) return content

  const stripped = content.replace(
    MARKDOWN_IMAGE_LINK_REGEX,
    (match, targetRaw) => {
      const target = extractMarkdownUrlTarget(String(targetRaw ?? ''))
      if (!isLikelyFilesystemImageTarget(target)) return match
      return ''
    },
  )

  return stripped
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function stripAttachmentReferences(content: string): string {
  if (!content) return content

  const strippedAttachmentUrls = content
    .replace(ATTACHMENT_IMAGE_LINK_REGEX, '')
    .replace(ATTACHMENT_LINK_REGEX, '$1')
    .replace(ATTACHMENT_URL_REGEX, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return stripUnrenderableMarkdownImageReferences(strippedAttachmentUrls)
}

function fileToImageOutput(file: any): ImageOutput | null {
  if (!file || typeof file !== 'object') return null
  const mediaType =
    typeof file.mediaType === 'string'
      ? file.mediaType
      : typeof file.mimeType === 'string'
        ? file.mimeType
        : DEFAULT_IMAGE_MEDIA_TYPE

  if (!mediaType.startsWith('image/')) {
    return null
  }

  if (file.uint8Array) {
    const buffer = Buffer.from(file.uint8Array)
    return {
      dataUrl: `data:${mediaType};base64,${buffer.toString('base64')}`,
      mediaType,
    }
  }

  if (file.base64) {
    return {
      dataUrl: ensureDataUrl(file.base64, mediaType),
      mediaType,
    }
  }

  return null
}

type PlanItem = { text: string; completed?: boolean }
const PLAN_TOOL_NAME = 'codex_plan_update'

function isPlanUpdateTool(toolName?: string | null): boolean {
  return (toolName || '').toLowerCase() === PLAN_TOOL_NAME
}

function normalizePlanItems(raw: any): PlanItem[] {
  const source = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.items)
      ? raw.items
      : Array.isArray(raw?.item?.items)
        ? raw.item.items
        : Array.isArray(raw?.todo)
          ? raw.todo
          : Array.isArray(raw?.list)
            ? raw.list
            : []

  if (!Array.isArray(source)) return []

  return source
    .map((entry: any) => {
      const text =
        typeof entry?.text === 'string'
          ? entry.text
          : typeof entry?.content === 'string'
            ? entry.content
            : typeof entry?.title === 'string'
              ? entry.title
              : ''
      if (!text) return null
      return {
        text,
        completed: Boolean(entry?.completed),
      }
    })
    .filter(Boolean) as PlanItem[]
}

function formatPlanSummary(items: PlanItem[]): string {
  return items
    .map((item) => `- [${item.completed ? 'x' : ' '}] ${item.text}`)
    .join('\n')
}

function resolveAssignedSubagentIds(agent: AgentRow): string[] {
  if (
    Array.isArray(agent.assignedSubagents) &&
    agent.assignedSubagents.length > 0
  ) {
    return agent.assignedSubagents
  }
  if (
    Array.isArray((agent as any).assigned_subagent_ids) &&
    (agent as any).assigned_subagent_ids.length > 0
  ) {
    return (agent as any).assigned_subagent_ids
  }
  return []
}

async function emitSimulatedChunks(
  content: string,
  emitter: (chunk: string) => Promise<void>,
) {
  if (content.length <= SIMULATED_STREAM_CHUNK_TARGET) {
    await emitter(content)
    return
  }

  const tokens = content.split(/(\s+)/).filter((token) => token.length > 0)
  let buffer = ''

  for (const token of tokens) {
    buffer += token
    if (buffer.length >= SIMULATED_STREAM_CHUNK_TARGET) {
      await emitter(buffer)
      buffer = ''
      await sleep(SIMULATED_STREAM_DELAY_MS)
    }
  }

  if (buffer) {
    await emitter(buffer)
  }
}

async function loadAssignedSubagents(agent: AgentRow): Promise<any[]> {
  const ids = resolveAssignedSubagentIds(agent)
  if (ids.length === 0) {
    return []
  }

  const subagents: any[] = []
  await redis.execute(async (client) => {
    for (const id of ids) {
      try {
        const raw = await client.json.get(`subagent:${id}`)
        if (raw) {
          subagents.push(normalizeAssignedSubagent(raw as RawSubagent))
        }
      } catch (error) {
        console.error(`[send-routed] Failed to load subagent ${id}:`, error)
      }
    }
  })

  const primaryAgentType = normalizePrimaryAgentType(agent)
  const compatibleSubagents = subagents.filter((subagent) =>
    isSubagentCompatibleWithPrimaryAgent(primaryAgentType, subagent)
  )

  if (compatibleSubagents.length !== subagents.length) {
    console.warn('[send-routed] Ignoring incompatible assigned subagents', {
      agentId: agent.id,
      primaryAgentType,
      requested: subagents.length,
      compatible: compatibleSubagents.length,
    })
  }

  return compatibleSubagents
}

interface ParsedToolSteps {
  intermediateSteps: any[]
  accumulatedText: string
}

function isPrecompiledToolStep(step: any): boolean {
  if (!step || typeof step !== 'object') {
    return false
  }
  if (Array.isArray(step.content)) {
    return false
  }
  return Boolean(
    step.toolName ||
    step.tool ||
    step.action?.tool ||
    step.toolInput ||
    step.toolArgs ||
    step.toolResult ||
    step.toolOutput ||
    step.result,
  )
}

function normalizePrecompiledToolStep(step: any): any | null {
  if (!isPrecompiledToolStep(step)) {
    return null
  }

  const toolName = step.toolName || step.tool || step.action?.tool || step.name
  if (typeof toolName !== 'string' || toolName.trim().length === 0) {
    return null
  }

  const rawInput =
    step.toolInput ??
    step.toolArgs ??
    step.input ??
    step.args ??
    step.tool_input ??
    null
  const normalizedInput =
    rawInput !== undefined && rawInput !== null
      ? normalizeToolArgs(rawInput)
      : {}

  const rawResult =
    step.toolResult ??
    step.toolOutput ??
    step.output ??
    step.result ??
    step.tool_result ??
    step.tool_output
  const normalizedResult =
    rawResult !== undefined
      ? normalizeToolResult(rawResult, toolName, normalizedInput)
      : rawResult
  // The step's own error (a lane that named it), or the result's by the stored zip's rules.
  const error =
    step.error ?? toolStepFailureMessage(toolName, normalizedInput, parseJsonLike(normalizedResult))

  return {
    ...step,
    toolName,
    toolInput: normalizedInput,
    toolArgs: normalizedInput,
    toolResult: normalizedResult,
    error,
    timestamp: step.timestamp ?? Date.now(),
    success: error
      ? false
      : typeof step.success === 'boolean'
        ? step.success
        : normalizedResult !== undefined && normalizedResult !== null,
  }
}

function buildIntermediateStepsFromSteps(
  steps: any[] | undefined | null,
): ParsedToolSteps {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { intermediateSteps: [], accumulatedText: '' }
  }

  if (steps.some((step) => isPrecompiledToolStep(step))) {
    const normalized = steps
      .map((step) => normalizePrecompiledToolStep(step))
      .filter((step): step is any => Boolean(step))
    return {
      intermediateSteps: normalized,
      accumulatedText: '',
    }
  }

  let accumulatedText = ''
  const toolCalls: any[] = []
  const toolResults: any[] = []

  for (const step of steps) {
    if (Array.isArray(step?.toolCalls)) {
      toolCalls.push(...step.toolCalls)
    }

    if (Array.isArray(step?.toolResults)) {
      toolResults.push(...step.toolResults)
    }

    if (step?.content && Array.isArray(step.content)) {
      for (const item of step.content) {
        if (item?.type === 'tool-call') {
          toolCalls.push(item)
        } else if (item?.type === 'tool-result') {
          toolResults.push(item)
        } else if (item?.type === 'tool-error') {
          toolResults.push(toolErrorAsFailedToolResult(item))
        } else if (item?.type === 'text') {
          accumulatedText += item.text || ''
        }
      }
    }
  }

  const intermediateSteps: any[] = []

  // Deduplicate tool calls/results by toolCallId (or a stable fallback) to avoid
  // multiple cool_tool zips for a single execution.
  const safeKey = (obj: any) => {
    try {
      return JSON.stringify(obj ?? {})
    } catch {
      return String(obj)
    }
  }

  const seenCallKeys = new Set<string>()
  const uniqueToolCalls: any[] = []
  for (const call of toolCalls) {
    const key =
      call?.toolCallId ||
      `${call?.toolName || 'tool'}:${safeKey(call?.input ?? call?.args)}`
    if (seenCallKeys.has(key)) continue
    seenCallKeys.add(key)
    uniqueToolCalls.push(call)
  }

  const seenResultKeys = new Set<string>()
  const uniqueToolResults: any[] = []
  for (const res of toolResults) {
    const key =
      res?.toolCallId ||
      `${res?.toolName || 'tool'}:${safeKey(res?.output ?? res?.result ?? res?.data ?? res?.content)}`
    if (seenResultKeys.has(key)) continue
    seenResultKeys.add(key)
    uniqueToolResults.push(res)
  }

  uniqueToolCalls.forEach((call) => {
    const matchingResult = uniqueToolResults.find(
      (r) => r.toolCallId === call.toolCallId,
    )
    // Approval-gated runs can end with a tool-call but no tool-result yet.
    // Skip unresolved calls so we don't render a premature cool_tool card/zip
    // that looks like a failed execution before the user responds.
    if (!matchingResult) {
      return
    }

    let metadata = {}
    for (const step of steps) {
      if (Array.isArray(step?.toolCalls)) {
        const matchingToolCall = step.toolCalls.find(
          (tc: any) => tc.toolCallId === call.toolCallId,
        )
        if (matchingToolCall?.metadata) {
          metadata = matchingToolCall.metadata
          break
        }
      }
    }

    const rawInput =
      call.input ??
      call.args ??
      matchingResult?.input ??
      matchingResult?.args ??
      {}

    const input = normalizeToolArgs(rawInput)

    let toolResultRaw =
      matchingResult?.output ??
      matchingResult?.result ??
      matchingResult?.data ??
      matchingResult?.content

    let toolResult = normalizeToolResult(toolResultRaw, call.toolName, input)

    if (
      Array.isArray(toolResult) &&
      toolResult.length > 0 &&
      toolResult[0]?.type === 'coolToolResult' &&
      toolResult[0]?.toolResult
    ) {
      toolResult = normalizeToolResult(
        toolResult[0].toolResult,
        call.toolName,
        input,
      )
    }

    const nativeBashMapping = resolveNativeBashMapping({
      toolName: call.toolName,
      args: input,
      result: toolResult,
    })
    const mappedToolName = nativeBashMapping?.mappedToolName || call.toolName
    const mappedInput = nativeBashMapping?.mappedArgs || input
    const mappedResult =
      nativeBashMapping &&
      toolResult &&
      typeof toolResult === 'object' &&
      !Array.isArray(toolResult)
        ? {
            ...toolResult,
            originalToolName: call.toolName,
            mappedToolName: nativeBashMapping.mappedToolName,
            mappedReason: nativeBashMapping.reason,
          }
        : toolResult
    // The result's failure by the stored zip's rules.
    const error = toolStepFailureMessage(mappedToolName, mappedInput, parseJsonLike(mappedResult))

    intermediateSteps.push({
      toolName: mappedToolName,
      originalToolName: call.toolName,
      toolInput: mappedInput,
      toolArgs: mappedInput,
      toolResult: mappedResult,
      ...(call?.toolCallId ? { toolCallId: call.toolCallId } : {}),
      timestamp: Date.now(),
      ...(metadata as any),
      error,
      success: error ? false : mappedResult !== undefined,
    })
  })

  return { intermediateSteps, accumulatedText }
}

// The request owns plan leases beyond any one inner stream, through failure save,
// sandbox cleanup, request unregister and queued-notice settlement (BL-1055).
type RequestPlanOwner = { leases: Set<PlanLease>; listeners: AbortController; stop?: AbortController }
const requestPlanOwners = new WeakMap<Request, RequestPlanOwner>()

interface BatshitStreamParams {
  content: string
  sessionId: string
  agent: AgentRow
  agentId: string
  messageId?: string
  messages: any[]
  metadata: any
  batshitInput: any
  abortSignal?: AbortSignal
  globalZipSettings?: Record<string, any>
  precompiledHistory?: PrecompiledHistory
  streamMetadata?: Record<string, any>
  systemPromptAddendum?: string
  groupContext?: Record<string, any>
  voiceState?: {
    tts?: boolean
    stt?: boolean
    voiceMode?: string
    provider?: string
    guidance?: string[]
  }
  userSettings?: UserSettingsRow | null
  userId: string
  eventFetch: typeof fetch
  request: Request
  gatewayAuthority?: TurnMcpGatewayAuthority
  consumeSessionClips?: boolean
  /** SA-104 P5: the already-loaded session record (Infinite Session episode opening). */
  sessionRecord?: Record<string, any> | null
  /**
   * SA-120 P3: the group scheduler's Judge Juice speaker decision for THIS speaker — its DCM
   * lines, its Execution Viewer record, and any miss note. The call already happened; the
   * stream only replays the lines through the compiler's provider seam and records them.
   */
  jevJuiceGroupSelection?: GroupSpeakerProviderInput | null
  /**
   * The stop signal of the session-turn registration this run belongs to (2026-09-18). A Stop
   * or a delete that lands while the turn is still setting up has nothing else to abort, so it
   * stops the TURN (`stopSessionTurn`, `stopRunningRequests`); this run carries that into its
   * own controller, with the reason, and the setup checkpoint ends it.
   */
  turnStopSignal?: AbortSignal | null
  /**
   * SA-128 (DP-1): who wrote `content`. The group scheduler passes it per event; every other
   * caller leaves it to `resolveCurrentMessageFrom(metadata)`.
   */
  currentMessageFrom?: CurrentMessageFrom
  /**
   * BL-600: a group member run's part in the round's one Clip spend. The round passes the same
   * spend (`createGroupRoundClipSpend`) to every member; the first member to finish its compile
   * records the Clips it read, and the round spends them once when it ends. Absent on every other
   * run, which spends through `consumeSessionClips`.
   */
  groupRoundClipSpend?: GroupRoundClipSpend | null
}

interface BatshitStreamResult {
  response: Response
  messageId: string
  content: string
  metadata: Record<string, any>
  usage?: Record<string, any>
  /** The run failed but the partial message was already finalized (content + zip refs persisted). Callers must not re-persist an error-only message over it. */
  failureHandled?: boolean
  /** The failure was classified as model context-window exhaustion (eligible for auto-continue). */
  contextExhausted?: boolean
  /**
   * BL-455: the run finished at an approval card that waits for the user. Told to the promotion
   * loop by the run itself, never read back from Redis, where a tab's save can already have
   * changed the card.
   */
  awaitsApproval?: boolean
}

async function handleBatshitAgentStream({
  content,
  sessionId,
  agent,
  agentId,
  messageId: providedMessageId,
  messages,
  metadata,
  batshitInput,
  abortSignal: externalAbortSignal,
  globalZipSettings,
  precompiledHistory,
  streamMetadata,
  systemPromptAddendum,
  groupContext,
  voiceState,
  userSettings,
  userId,
  eventFetch,
  request,
  gatewayAuthority,
  consumeSessionClips = true,
  sessionRecord = null,
  jevJuiceGroupSelection = null,
  turnStopSignal = null,
  currentMessageFrom,
  groupRoundClipSpend = null,
}: BatshitStreamParams): Promise<BatshitStreamResult> {
  const zipDetection = new ZipDetectionService()
  let zipSettingsAgent: Record<string, unknown> | null =
    agent as unknown as Record<string, unknown>
  // SA-104 P5: the accepted-send memory commit result, merged into the finalized
  // assistant message metadata as the chat-surface "memory inserted" affordance.
  let memoryTurnCommit: import('$lib/server/services/memory/memoryRecall').MemoryTurnCommitResult | null =
    null

  let messageId = providedMessageId ?? null
  if (!messageId) {
    messageId = await generateMessageId(sessionId)
  }
  if (!messageId) {
    return {
      response: json(
        { error: 'Failed to generate message ID' },
        { status: 500 },
      ),
      messageId: '',
      content: '',
      metadata: {},
      usage: undefined,
    }
  }

  const imageOriginCliDelivery = emptyRunDelivery(false)
  const imageOriginApiInput = new ApiImageInputCollector()

  // BL-505 (C1): a woken turn spends no Clip countdown, because a countdown counts the user's
  // messages. The server decides which run is the woken turn: the request is the wake primitive's
  // own internal POST, and the wake registry names this run's message as the woken turn's (never
  // `metadata.wake`, which is the caller's word). A steer the user typed during the woken reply,
  // promoted into its own turn by this same request, has its own message id, so it spends as the
  // user's message it is. Decided here, while the woken turn's registration certainly stands.
  const isWokenTurnRun =
    isTrustedInternalRequest(request) && isWokenTurnMessage(sessionId, messageId)

  const streamAbortController = new AbortController()
  const streamAbortSignal = streamAbortController.signal
  // BL-246: every outside signal is relayed through `relayAbort`, and the relays are taken back
  // when this handler's main `try` ends (`turnListeners.abort()` in its `finally`). An inline
  // listener that stayed on `request.signal` kept this whole scope alive after the reply, every
  // model step with its full request body (660 MB after about 25 long chats, then a heap
  // out-of-memory). The early returns above the main `try` leave a relay behind, but before the
  // stream starts it holds only the small stream controller.
  const turnListeners = new AbortController()
  let chatgptPlanLease: PlanLease | undefined
  // Cover setup's early returns and throws as well as stream/finalize writes.
  try {

  // BL-413: the group's signal carries its own reason (`user`, or `session_deleted` when the group
  // chat is deleted), so a member's run knows a deleted chat, as a single-agent run does.
  relayAbort({ from: externalAbortSignal, to: streamAbortController, reason: sourceAbortReason, until: turnListeners.signal })
  relayAbort({ from: request.signal, to: streamAbortController, reason: 'request', until: turnListeners.signal })

  // SA-113 P1 / AMD-113-02 — Stop for a turn Batshit started itself.
  //
  // A woken turn's request is made from inside this process, and the P1 live run measured
  // that aborting that fetch does NOT reach `request.signal` here: the interrupt route
  // reported the abort and the run still finished with a full answer. So the wake
  // registry's controller is wired directly, exactly like group chat's
  // `externalAbortSignal`. It is the SAME controller the interrupt route aborts, so this
  // makes delivery certain rather than adding a second mechanism to keep in step.
  //
  // F-P1-5: the wake registry aborts with `wake_timeout` or `wake_stop`, and that
  // distinction is carried through verbatim so the finalized message can say the hard
  // time limit ended the turn rather than blaming the user.
  relayAbort({
    from: getWakeAbortSignal(sessionId),
    to: streamAbortController,
    reason: wakeAbortReason,
    until: turnListeners.signal,
  })

  // A Stop or a delete that lands while this turn is still setting up has no stream to abort:
  // it stops the turn itself, and this carries it here with its reason (`user`, or
  // `session_deleted`), so the setup checkpoint below ends the run before the provider call.
  // Measured before, in a real page: Stop 150 ms after the send, and the reply ran `sleep 20`
  // to a full answer (2026-09-18, `_local/stopfix-proof/before-page-same-150b.json`).
  relayAbort({ from: turnStopSignal, to: streamAbortController, reason: sourceAbortReason, until: turnListeners.signal })

  /**
   * SA-113 F-P1-5 — who ended this turn. `timeout` only when the wake-up hard time limit
   * fired; everything else is a Stop somebody pressed.
   */
  const resolveInterruptionReason = (): 'user' | 'timeout' =>
    streamAbortSignal.reason === 'wake_timeout' ? 'timeout' : 'user'

  /**
   * A Stop because the chat was deleted (bug sweep, 2026-09-18). Every tab showing the chat saves
   * a finished reply back at `end`, and the save route refuses a chat being deleted, so each tab
   * showed a false "Failed to save message to database". The `end` says so (`chatDeleted`) and
   * the answer carries the same `session_deleted` code a send into a deleted chat gets.
   */
  const stoppedForDeletedChat = (): boolean => isStoppedForSessionDelete(streamAbortSignal.reason)

  const describeInterruption = (): string =>
    isStoppedForSessionDelete(streamAbortSignal.reason)
      ? SESSION_DELETED_STOP_MESSAGE
      : resolveInterruptionReason() === 'timeout'
        ? 'Stream stopped by the wake-up time limit'
        : 'Stream interrupted by user'

  zipDetection.setContext(sessionId, messageId, {
    agent: zipSettingsAgent,
    globalSettings: globalZipSettings,
    messagesFromEnd: 0,
  })

  let selectedTools: string[] | undefined =
    metadata?.selectedTools ?? batshitInput?.metadata?.selectedTools
  let selectedGateways: string[] | undefined =
    metadata?.selectedGateways ??
    metadata?.selectedMCPs ??
    batshitInput?.metadata?.selectedGateways
  let mcpToolSelections =
    metadata?.mcpToolSelections ?? batshitInput?.metadata?.mcpToolSelections

  const assignedSubagents = await loadAssignedSubagents(agent)
  const rawToolApprovalResponse = normalizeToolApprovalResponses(
    metadata?.toolApprovalResponse ??
      metadata?.tool_approval_response ??
      batshitInput?.metadata?.toolApprovalResponse ??
      batshitInput?.metadata?.tool_approval_response,
  )
  const hasUserTurnContent =
    (typeof content === 'string' && content.trim().length > 0) ||
    (Array.isArray(content) && content.length > 0) ||
    (content != null && typeof content !== 'string' && !Array.isArray(content))
  const interruptionContextRaw = (metadata?.interruption ??
    batshitInput?.metadata?.interruption) as Record<string, any> | null
  const interruptionReason =
    typeof interruptionContextRaw?.reason === 'string'
      ? interruptionContextRaw.reason.trim().toLowerCase()
      : ''
  const interruptionHasPreviousMessage =
    typeof interruptionContextRaw?.previousMessageId === 'string' &&
    interruptionContextRaw.previousMessageId.trim().length > 0
  const shouldIgnoreToolApprovalResponse =
    rawToolApprovalResponse.length > 0 && hasUserTurnContent
  if (shouldIgnoreToolApprovalResponse) {
    console.warn(
      '[Send-Routed] Ignoring stale tool approval payload on user turn',
      {
        sessionId,
        messageId,
        approvalCount: rawToolApprovalResponse.length,
      },
    )
  }
  const toolApprovalResponse = shouldIgnoreToolApprovalResponse
    ? []
    : rawToolApprovalResponse
  const toolApprovalMode = normalizeToolApprovalMode(
    metadata?.toolApprovalMode ??
      metadata?.tool_approval_mode ??
      (agent as any)?.tool_approval_mode ??
      (agent as any)?.toolApprovalMode,
  )
  const hasToolApprovalResponse = toolApprovalResponse.length > 0
  const isApprovalResumeWithoutUserTurn =
    hasToolApprovalResponse && !hasUserTurnContent
  const contextContinuationRaw = (metadata?.contextContinuation ??
    batshitInput?.metadata?.contextContinuation) as Record<string, any> | null
  const isContextContinuationRun =
    Boolean(contextContinuationRaw) && !hasUserTurnContent
  const previousMessages = prepareManagedHistoryMessages({
    messages,
    currentUserMessage: content,
    assistantMessageId: providedMessageId,
    preserveAllMessages: hasToolApprovalResponse,
  })
  /**
   * BL-322: an approval resume is the paused call, CONTINUED (`approvalResumeReplay.ts`).
   *
   * It used to compile the paused reply as history with no current message, so the compiler
   * built no `<dynamic_info>` (no tools index, no Clip ids, no zip state, DMs, or memory
   * context) and only the step that asked was replayed. Now it compiles the history BEFORE the
   * paused turn's own message, that message as the current message again, and (below, after
   * the model is resolved) every step the paused run took from the paused message's stored
   * record, frozen here once, before the compile and before any resumed event or browser save.
   * `messageForCompilation` stays empty: it means a NEW user turn, and every side effect of one
   * (Judge Juice calls, the memory commit, the clip countdown) reads it, so a resume spends none.
   */
  const approvalResumePrior = isApprovalResumeWithoutUserTurn
    ? await readStoredAssistantRecord(sessionId, messageId)
    : null
  const pausedApprovalTurn = isApprovalResumeWithoutUserTurn
    ? findPausedApprovalTurn(previousMessages, messageId)
    : null
  if (isApprovalResumeWithoutUserTurn && (!approvalResumePrior || !pausedApprovalTurn)) {
    throw createRoutedInputError(
      'Batshit could not find the reply this approval belongs to, so it did not run it. Ask the agent again.',
      'APPROVAL_RESUME_TURN_MISSING',
      409,
    )
  }
  // The prefix was frozen once, before the compile (`approvalResumePrior`, BL-322).
  const approvalResumeStart = approvalResumePrior ? createApprovalResumeStart(approvalResumePrior) : null

  // BL-474 step 2: this reply's outside pictures are pending (no Load action) until its end decides
  // where each address came from; a reply whose end step fails stays pending. Written for this run's
  // own reply id before the run streams anything. An approval resume is the reply's next end, under
  // its own server-owned version.
  const imageOriginVersion = approvalResumeStart?.version ?? FIRST_IMAGE_ORIGIN_VERSION
  try {
    await markImageOriginPending({ userId, sessionId, messageId, version: imageOriginVersion })
  } catch (pendingError) {
    console.error("[Send-Routed] BL-474: could not mark the reply's pictures pending", {
      sessionId,
      messageId,
      error: pendingError instanceof Error ? pendingError.message : String(pendingError),
    })
  }


  const historyForCompilation = pausedApprovalTurn
    ? pausedApprovalTurn.history
    : previousMessages
  const messageForCompilation =
    isApprovalResumeWithoutUserTurn || isContextContinuationRun
      ? undefined
      : content
  const compileCurrentMessage = pausedApprovalTurn
    ? pausedApprovalTurn.currentText
    : messageForCompilation
  // SA-129 P2 (DL-08): this send's user message counts once toward every temporary hold's
  // countdown, at the accepted-send boundary below; the compile already reads zip state as it
  // will be once it counts (a group run counts it once, at its own start).
  const countsNewUserMessage =
    consumeSessionClips && !isApprovalResumeWithoutUserTurn && !isContextContinuationRun

  const primaryAgentType = normalizePrimaryAgentType(agent)
  const connectionHint =
    agent?.primary_model_connection?.id ||
    agent?.primary_model_connection?.service ||
    null
  const providerHint = (
    agent?.primary_model_provider ||
    ''
  )
    .toLowerCase()
    .trim()
  const isCodexProviderHint =
    CODEX_PROVIDER_IDS.has(providerHint) ||
    connectionHint === CODEX_CONNECTION_ID
  const isClaudeProviderHint =
    CLAUDE_PROVIDER_IDS.has(providerHint) ||
    connectionHint === CLAUDE_CONNECTION_ID
  const runtimeFlavor = isCliPrimaryAgentType(primaryAgentType) && isCodexProviderHint
    ? 'codex'
    : isCliPrimaryAgentType(primaryAgentType) && isClaudeProviderHint
      ? 'claude'
      : isCliPrimaryAgentType(primaryAgentType)
        ? 'codex'
        : 'vercel'

  // SA-120 P1: Judge Juice skill/tool hints ride the DCM tail through a provider the
  // compiler calls once it knows the agent's skills and discoverable refs. The agent's
  // own switch OFF means no provider and no record; group turns get none (P3 owns
  // group judgments); a resume without a user turn has nothing to judge.
  const jevJuiceTurn = createJevJuiceTurnCollector()
  // SA-120 P3: a group speaker chosen (or nearly chosen) by Judge Juice replays the scheduler's
  // decided lines through the same seam; the call itself already happened before this stream.
  // SA-120 P5: smart zip, behind the ONE global switch in `global_zip_settings` (OFF or a
  // group turn: no turn at all). Its open provider answers the compiler's first history pass
  // with the zipped results Batshit opens for THIS message; its tail provider only replays the
  // decided lines; and what the compile opened is stored below, at the accepted-send boundary.
  const jevJuiceSmartZip = jevJuiceGroupSelection
    ? undefined
    : buildSmartZipTurn({
        userId,
        sessionId,
        agent,
        globalZipSettings,
        message: typeof messageForCompilation === 'string' ? messageForCompilation : '',
        isGroupTurn: Boolean(groupContext) || streamMetadata?.groupChat === true,
        collector: jevJuiceTurn,
      })
  // SA-120 P6: the after-reply check, behind two per-agent switches (both OFF, a group turn, or
  // a resume with no user turn: no turn at all). Before the reply it only REPLAYS what was
  // noticed about the previous reply (a Redis read, never a Jev call); the check itself runs
  // once this reply is complete, on the one after-reply site below.
  const jevJuicePostTurnCheck = jevJuiceGroupSelection
    ? undefined
    : buildPostTurnCheckTurn({
        userId,
        sessionId,
        agent,
        message: typeof messageForCompilation === 'string' ? messageForCompilation : '',
        isGroupTurn: Boolean(groupContext) || streamMetadata?.groupChat === true,
        history: historyForCompilation,
      })
  // BL-527: the two after-reply steps judge a WHOLE reply, once, at its successful end. A run with
  // no user turn of its own FINISHES a reply an earlier run began: an API approval resume continues
  // the message the card was on, and a context continuation answers after the run(s) that ran out
  // of room. It gets those two steps alone, built from the request that reply answers, with the
  // parts the earlier runs stored. Nothing of a new user turn runs for it (no provider before the
  // reply, no notes told again, no accepted-send write: `messageForCompilation` stays empty), and
  // the earlier runs ran neither step (a reply waiting at a card, or cut short, is not finished).
  const jevJuiceContinuedReply =
    jevJuiceGroupSelection || !(isApprovalResumeWithoutUserTurn || isContextContinuationRun)
      ? null
      : buildContinuedReplySteps({
          userId,
          sessionId,
          agent,
          globalZipSettings,
          isGroupTurn: Boolean(groupContext) || streamMetadata?.groupChat === true,
          continued:
            pausedApprovalTurn && approvalResumePrior
              ? approvalResumeReplyTurn(pausedApprovalTurn, approvalResumePrior)
              : findContextContinuationTurn(previousMessages, contextContinuationRaw?.previousMessageId),
        })
  // The compiler takes ONE tail provider, so the primary lanes are composed: they start side
  // by side and their lines keep a fixed order (skill and tool hints, then zips, then the
  // notes about the previous reply, then the quick actions Batshit ran by voice since the
  // agent's last reply, then the screen of the message that woke this turn).
  const jevJuiceHintProvider = jevJuiceGroupSelection
    ? buildGroupSpeakerProvider(jevJuiceGroupSelection, jevJuiceTurn)
    : composeJevJuiceHintProviders([
        buildSkillToolHintProvider({
          userId,
          agent,
          message: typeof messageForCompilation === 'string' ? messageForCompilation : '',
          isGroupTurn: Boolean(groupContext) || streamMetadata?.groupChat === true,
          collector: jevJuiceTurn,
        }),
        jevJuiceSmartZip?.hintProvider,
        jevJuicePostTurnCheck?.hintProvider,
        // SA-120 P9: what Batshit did for the user by voice since the agent's last reply, read
        // from the marks the browser stored on the user messages of this request's history.
        // Replay only: no Jev call, no Redis read.
        buildQuickActionTellProvider({
          messages,
          isGroupTurn: Boolean(groupContext) || streamMetadata?.groupChat === true,
        }),
        // SA-120 P7: a WOKEN turn only. The DM that started it was screened when it arrived;
        // this replays a flag as the last lines of the prompt that carries that DM's text. The
        // DM id comes from the wake registry (server-owned), never from the request body.
        buildUntrustedTextHintProvider({
          userId,
          agentId,
          wakeDmId: getWakeRun(sessionId)?.origin?.dmId ?? null,
          message: typeof messageForCompilation === 'string' ? messageForCompilation : '',
          isGroupTurn: Boolean(groupContext) || streamMetadata?.groupChat === true,
          collector: jevJuiceTurn,
        }),
      ])
  // SA-120 P4b: recall by meaning. The compiler hands this provider to the recall engine;
  // its one answer also goes to the memory commit below so compile and commit select alike.
  // Agent switch OFF, memory off, a group turn, or a resume with no user turn: no provider.
  const jevJuiceMemoryRecall = buildSemanticRecallTurn({
    userId,
    agent,
    message: typeof messageForCompilation === 'string' ? messageForCompilation : '',
    isGroupTurn: Boolean(groupContext) || streamMetadata?.groupChat === true,
    collector: jevJuiceTurn,
  })

  const agentMetadata = agent as Record<string, any>
  let gatewayToolMap: Record<string, string[]> = {}
  let defaultGateways: string[] | null = null
  const selectedCliToolIds = Array.isArray(agentMetadata.defaultTools)
    ? agentMetadata.defaultTools
    : Array.isArray(agentMetadata.default_tools)
      ? agentMetadata.default_tools
      : Array.isArray(agent.defaultTools)
        ? agent.defaultTools
        : Array.isArray((agent as any).default_tools)
          ? (agent as any).default_tools
          : undefined
  let preloadedGatewayTools: MCPSelectionResolution['tools'] | null = null
  let preloadedGatewayMetadata: MCPSelectionResolution['toolMetadata'] | null =
    null

  try {
    const authorizedSelection = await resolveTurnMcpGatewaySelection({
      userId,
      agent,
      requestedGateways: selectedGateways,
      authority: gatewayAuthority,
    })
    const selectionResolution = await resolveMCPSelections({
      userId,
      agentId,
      agent,
      agentMetadata,
      selectedGateways: authorizedSelection,
      toolSelections: mcpToolSelections,
      includeGatewayToolMap: isCliPrimaryAgentType(primaryAgentType),
      // CLI runs use the managed helper bridge instead of direct native tool injection.
      isCodexMode: isCliPrimaryAgentType(primaryAgentType),
    })

    selectedGateways = selectionResolution.resolvedGateways
    defaultGateways = selectionResolution.defaultGateways
    mcpToolSelections = selectionResolution.resolvedToolSelections
    gatewayToolMap = selectionResolution.gatewayToolMap
    preloadedGatewayTools = selectionResolution.tools
    preloadedGatewayMetadata = selectionResolution.toolMetadata
  } catch (resolverError) {
    console.error('[Send-Routed] Failed to resolve MCP selections:', resolverError)
    throw createRoutedInputError(
      'Batshit could not resolve the gateways for this turn, so it did not start the agent.',
      'MCP_GATEWAY_SCOPE_UNAVAILABLE',
      503,
    )
  }


  const databaseService = new DatabaseService(eventFetch)

  const formattedInput = await databaseService.buildFormattedChatInput(
    sessionId,
    historyForCompilation,
    agent,
    compileCurrentMessage,
    assignedSubagents,
    userId,
    {
      fetch: eventFetch,
      mcpGatewayScope: selectedGateways ?? [],
      runtimeFlavor,
      // BL-322: a resume compiles the paused send's own project and files, which the browser
      // stored on its message; the click's metadata is the paused REPLY's.
      projectPath: pausedApprovalTurn
        ? pausedApprovalTurn.projectPath
        : (metadata?.projectPath ?? batshitInput?.metadata?.projectPath ?? null),
      projectRules:
        metadata?.projectRules ?? batshitInput?.metadata?.projectRules ?? null,
      fileReferences: pausedApprovalTurn
        ? pausedApprovalTurn.fileReferences
        : (metadata?.fileReferences ??
          batshitInput?.metadata?.fileReferences ??
          []),
      precompiledHistory,
      groupContext,
      voiceState,
      goonsEnabled:
        typeof metadata?.goonsEnabled === 'boolean'
          ? metadata.goonsEnabled
          : undefined,
      goonPresentationMode: metadata?.goonPresentationMode ?? null,
      goonsSettings: userSettings?.goons_settings ?? null,
      jevJuiceHintProvider,
      jevJuiceMemoryRecallProvider: jevJuiceMemoryRecall?.provider,
      jevJuiceSmartZipProvider: jevJuiceSmartZip?.openProvider,
      jevJuiceSmartZipExposedObserver: jevJuiceSmartZip?.exposedObserver,
      currentMessageFrom: pausedApprovalTurn
        ? pausedApprovalTurn.from
        : (currentMessageFrom ?? resolveCurrentMessageFrom({ metadata })),
      currentMessageAt: pausedApprovalTurn?.at ?? undefined,
      // BL-474 step 2: a webhook's wake is read (outside data); a DM, a schedule (an agent can write
      // its text), and every other Batshit-written message keep the compiler's careful default. Every
      // wake carries a DM id, so the wake's own kind decides.
      currentMessageAddressSource:
        !pausedApprovalTurn && isWokenTurnRun &&
        getWakeRun(sessionId)?.userId === userId &&
        getWakeRun(sessionId)?.agentId === agentId &&
        getWakeRun(sessionId)?.origin?.kind === 'webhook'
          ? 'note'
          : undefined,
      countsPendingUserMessage: countsNewUserMessage,
    },
  )

  if (!formattedInput) {
    throw new Error('Failed to build formatted chat input for API or CLI agent')
  }

  // BL-504: only a Clip the compiler marked an image, plus the compiled `image_url` parts; a PDF
  // or document Clip carries its URL as content and is never an image input.
  const collectImages = () =>
    collectCompiledImageInputs(formattedInput?.structuredInput)
  let images: Array<{ url: string }> = []
  try {
    images = collectImages()
  } catch (imageCollectError) {
    console.warn(
      '[Send-Routed] Failed to collect image references from compiled input:',
      imageCollectError,
    )
    images = []
  }

  const interruptionAddendum = buildInterruptionAddendum(interruptionContextRaw)
  const contextContinuationAddendum = buildContextContinuationAddendum(
    contextContinuationRaw,
  )
  const toolApprovalTimeoutAddendum = buildToolApprovalTimeoutAddendum(
    metadata?.expiredToolApprovals ??
      batshitInput?.metadata?.expiredToolApprovals,
  )
  /**
   * SA-116 F-P3-2 — a control approval the user granted on a click that ALSO resumed an
   * SDK-paused call. There is no new user message to carry it (the resume re-enters the
   * run that paused), so it is appended here, already formatted by
   * `buildControlApprovalInPlaceAddendum`.
   */
  const controlApprovalAddendum = (() => {
    const raw =
      metadata?.controlApprovalNotice ??
      batshitInput?.metadata?.controlApprovalNotice
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
  })()
  const mergedSystemPromptAddendum = [
    systemPromptAddendum,
    interruptionAddendum,
    contextContinuationAddendum,
    toolApprovalTimeoutAddendum,
    controlApprovalAddendum,
  ]
    .filter(Boolean)
    .join('\n\n')

  let compiledMessages: any[] = []

  if (formattedInput.primarySystemPrompt || mergedSystemPromptAddendum) {
    const basePrompt = formattedInput.primarySystemPrompt ?? ''
    const mergedPrompt = mergedSystemPromptAddendum
      ? `${basePrompt}\n\n${mergedSystemPromptAddendum}`.trim()
      : basePrompt
    compiledMessages.push({
      role: 'system',
      content: mergedPrompt,
    })
  }

  if (formattedInput.structuredInput?.messages?.length) {
    for (const msg of formattedInput.structuredInput.messages) {
      compiledMessages.push({
        role: msg.role || 'user',
        content: msg.content,
      })
    }
  }

  const compileMetadataBase = formattedInput.structuredInput?.metadata || {}
  const compileMetadata = { ...compileMetadataBase }

  if (!compiledMessages.length) {
    throw new Error('Unable to compile chat messages for Batshit agent')
  }

  const dataImageInTextContext =
    findDataImageUrlInTextMessages(compiledMessages)
  if (dataImageInTextContext) {
    const userTurnHasInlineDataImage = hasDataImageUrlInUserTurnContent(content)
    if (userTurnHasInlineDataImage) {
      throw createRoutedInputError(
        'Inline image data URLs are not allowed in message text. Re-attach the image as an image clip/input so it stays out of text tokens.',
        'IMAGE_DATA_URL_IN_TEXT',
      )
    }

    const sanitizeResult = sanitizeDataImageUrlsInTextMessages(compiledMessages)
    if (sanitizeResult.redactions > 0) {
      console.warn(
        `[send-routed] Redacted ${sanitizeResult.redactions} image data URL(s) from compiled text context.`,
      )
    }

    const remainingDataImageInText =
      findDataImageUrlInTextMessages(compiledMessages)
    if (remainingDataImageInText) {
      throw createRoutedInputError(
        `Image data URLs are not allowed in text context (message ${remainingDataImageInText.messageIndex + 1}${remainingDataImageInText.role ? `, role ${remainingDataImageInText.role}` : ''}). Re-attach the image as an image clip/input so it stays out of text tokens.`,
        'IMAGE_DATA_URL_IN_TEXT',
      )
    }
  }

  const metadataForLogs =
    compileMetadata || metadata || batshitInput?.metadata || {}
  const executionMetadata = {
    ...(compileMetadata || {}),
    ...(metadata || {}),
    ...(batshitInput?.metadata || {}),
  }
  const resolvedCompiledProjectPath =
    formattedInput.resolvedProjectPath ??
    formattedInput.structuredInput?.metadata?.resolvedProjectPath ??
    null
  if (resolvedCompiledProjectPath) {
    executionMetadata.projectPath = resolvedCompiledProjectPath
  }
  if (streamMetadata?.groupChat) {
    executionMetadata.groupChat = {
      groupTurnId:
        streamMetadata?.groupTurnId ?? streamMetadata?.group_turn_id ?? null,
      eventIndex:
        streamMetadata?.eventIndex ??
        streamMetadata?.event_index ??
        streamMetadata?.group_event_index ??
        null,
      groupLayout:
        streamMetadata?.groupLayout ?? streamMetadata?.group_layout ?? null,
      speakPolicy: streamMetadata?.speakPolicy ?? null,
      speakTopics: Array.isArray(streamMetadata?.speakTopics)
        ? streamMetadata.speakTopics
        : null,
      eventType:
        streamMetadata?.eventType ?? streamMetadata?.event_type ?? null,
      eventSourceAgentId:
        streamMetadata?.eventSourceAgentId ??
        streamMetadata?.event_source_agent_id ??
        null,
      eventSourceAgentName:
        streamMetadata?.eventSourceAgentName ??
        streamMetadata?.event_source_agent_name ??
        null,
      driverMode:
        streamMetadata?.driverMode ?? streamMetadata?.driver_mode ?? null,
      driverAgentId:
        streamMetadata?.driverAgentId ??
        streamMetadata?.driver_agent_id ??
        null,
      // SA-120 P3: present only when a `smart` agent was a candidate for this event.
      ...(streamMetadata?.speakerSelection
        ? { speakerSelection: streamMetadata.speakerSelection }
        : {}),
    }
  }

  selectedTools = selectedTools ?? executionMetadata?.selectedTools
  selectedGateways = selectedGateways ?? executionMetadata?.selectedGateways
  mcpToolSelections = mcpToolSelections ?? executionMetadata?.mcpToolSelections

  const requestAgentMetadata =
    executionMetadata?.agent && typeof executionMetadata.agent === 'object'
      ? executionMetadata.agent
      : {}
  executionMetadata.agent = {
    ...requestAgentMetadata,
    ...agentMetadata,
  }

  executionMetadata.gatewayToolMap = gatewayToolMap
  // SA-120 P1 (DL-120-07): every Jev call this turn made becomes an Execution Viewer row.
  attachJevJuiceRecords(executionMetadata, jevJuiceTurn)

  const primaryPresetId =
    agentMetadata.primary_model_preset_id ??
    agent.primary_model_preset_id ??
    null
  const primaryPreset = await loadRuntimeModelPreset(primaryPresetId, 'primary')
  const primarySelection = resolveRuntimeModelSelection({
    preset: primaryPreset,
    presetId: primaryPresetId,
    provider:
      agentMetadata.primary_model_provider ?? agent.primary_model_provider,
    modelId: agentMetadata.primary_model_name ?? agent.primary_model_name,
    connection:
      agentMetadata.primary_model_connection ??
      agent.primary_model_connection ??
      null,
    capabilities:
      agentMetadata.primary_model_capabilities ??
      agent.primary_model_capabilities ??
      null,
    settings: (agentMetadata.provider_specific_settings ??
      agent.provider_specific_settings ??
      null) as Record<string, any> | null,
  })
  const providerSpecificSettings = primarySelection.settings
  const connectionInfo = primarySelection.connection
  if (isPlanSelection(connectionInfo)) {
    assertPlanSettings(providerSpecificSettings)
    const accountId = chatgptPlanAccountId(connectionInfo?.id)
    if (!accountId || primaryAgentType !== 'api') throw createRoutedInputError('Choose this ChatGPT account on an API agent.', 'CHATGPT_PLAN_CONNECTION_INVALID', 409)
    const storedBinding = (approvalResumePrior?.metadata as any)?.providerMessageSource?.planBinding
    chatgptPlanLease = getChatgptPlanRuntime().acquire(userId, accountId, PLAN_AGENT, streamAbortSignal, isApprovalResumeWithoutUserTurn ? storedBinding ?? '' : undefined)
    const requestOwner = requestPlanOwners.get(request)
    if (!requestOwner?.stop) {
      chatgptPlanLease.release()
      throw createRoutedInputError('The ChatGPT request owner is unavailable. Retry the send.', 'CHATGPT_PLAN_OWNER_REQUIRED', 409)
    }
    requestOwner.leases.add(chatgptPlanLease)
    relayAbort({ from: chatgptPlanLease.signal, to: requestOwner.stop, reason: sourceAbortReason, until: requestOwner.listeners.signal })
    relayAbort({ from: chatgptPlanLease.signal, to: streamAbortController, reason: sourceAbortReason, until: turnListeners.signal })
  }
  const connectionIdentifier =
    connectionInfo?.id || connectionInfo?.service || null
  const providerIdentifier = (primarySelection.provider ?? '')
    .toLowerCase()
    .trim()
  const isCodexSelection =
    CODEX_PROVIDER_IDS.has(providerIdentifier) ||
    connectionIdentifier === CODEX_CONNECTION_ID
  const isClaudeSelection =
    CLAUDE_PROVIDER_IDS.has(providerIdentifier) ||
    connectionIdentifier === CLAUDE_CONNECTION_ID
  const isCliMode = isCliPrimaryAgentType(primaryAgentType)
  const isCliProvider = isCliMode && (isCodexSelection || isClaudeSelection)
  const isCodexProvider = isCliProvider && isCodexSelection
  const isClaudeProvider = isCliProvider && isClaudeSelection
  // BL-941 (R5): a Codex or Claude run's Tool Approval is bounded by the agent's record, like its
  // mode and sandbox. An API agent keeps `toolApprovalMode` (the send's value first, then the
  // record's), unchanged.
  const runToolApprovalMode: ToolApprovalMode = isCliProvider
    ? tighterToolApprovalMode(
        metadata?.toolApprovalMode ?? metadata?.tool_approval_mode,
        (agent as any)?.tool_approval_mode ?? (agent as any)?.toolApprovalMode,
      )
    : toolApprovalMode
  const primaryModelHint = (primarySelection.modelId ?? '')
    .toLowerCase()
    .trim()
  const hasModelSelection = Boolean(
    providerIdentifier || connectionIdentifier || primaryModelHint,
  )
  const isCodexModelHint =
    isCodexSelection || primaryModelHint.includes('codex')
  const isClaudeCliModelHint =
    isClaudeSelection || primaryModelHint.includes('claude-cli')
  const isCliModelHint = isCodexModelHint || isClaudeCliModelHint

  if (isCliMode && hasModelSelection && !isCliModelHint) {
    return {
      response: json(
        {
          error: 'CLI agents only support CLI model presets.',
          code: 'cli_mode_only',
        },
        { status: 400 },
      ),
      messageId,
      content: '',
      metadata: {},
      usage: undefined,
    }
  }

  if (!isCliMode && isCliModelHint) {
    return {
      response: json(
        {
          error: 'CLI model presets are only available for CLI agents.',
          code: 'cli_mode_only',
        },
        { status: 400 },
      ),
      messageId,
      content: '',
      metadata: {},
      usage: undefined,
    }
  }

  const nativeRuntime: {
    streamNativeMode: (request: NativeModeRequest) => Promise<any>
  } = await (async () => {
    if (isCodexProvider) {
      const { CodexBridge } = await import('$lib/server/services/codexBridge')
      return new CodexBridge()
    }
    if (isClaudeProvider) {
      const { ClaudeBridge } = await import('$lib/server/services/claudeBridge')
      return new ClaudeBridge()
    }
    const { VercelAIBrain } = await import('$lib/server/services/vercelBrain')
    return new VercelAIBrain()
  })()
  const isN8NOnlyModel =
    (connectionIdentifier &&
      N8N_ONLY_CONNECTION_IDS.has(connectionIdentifier)) ||
    (providerIdentifier && N8N_ONLY_PROVIDER_IDS.has(providerIdentifier))

  if (isN8NOnlyModel) {
    return {
      response: json(
        {
          error:
            'This model preset has no direct Batshit connection and cannot run on an API or CLI agent. Pick a different model, or use it from an n8n tool workflow.',
          code: 'model_not_directly_connectable',
        },
        { status: 400 },
      ),
      messageId,
      content: '',
      metadata: {},
      usage: undefined,
    }
  }

  const runtimeSettings = buildRuntimeModelSettings({
    provider: primarySelection.provider,
    modelId: primarySelection.modelId,
    vercelId: null,
    connection: primarySelection.connection,
    contextWindow: primarySelection.contextWindow,
    capabilities: primarySelection.capabilities,
    settings: providerSpecificSettings as Record<string, ParameterValue> | null,
    // BL-515: an agent that names a preset takes its values from the preset alone; the agent's
    // `primary_model_*` copies are fallbacks only for a record that names no preset.
    fallbacks: resolveAgentModelFallbacks({
      preset: primaryPreset,
      agent: agentMetadata,
    }),
  })
  const primaryCapabilities = primarySelection.capabilities
  const primaryProviderId = primarySelection.provider
  const primaryToolsEnabled = shouldEnableTools(
    primaryProviderId,
    primaryCapabilities,
  )

  if (images.length > 0 && !modelAllowsImageInput(primaryCapabilities)) {
    throw createRoutedInputError(
      buildImageInputUnsupportedMessage({
        imageCount: images.length,
        providerId: primaryProviderId,
        modelId: primarySelection.modelId,
      }),
      IMAGE_INPUT_UNSUPPORTED_CODE,
      422,
    )
  }

  const resolvedVoiceConfig = await resolveVoiceConfigForMetadata({
    userSettings,
    agent,
    metadata: metadataForLogs ?? metadata,
  })

  const voiceMetadata: VoiceMetadata = {
    stt: Boolean(metadata?.stt ?? metadataForLogs?.stt ?? false),
    tts: Boolean(metadata?.tts ?? metadataForLogs?.tts ?? false),
    voiceMode: (metadata?.voiceMode ??
      metadataForLogs?.voiceMode ??
      (metadata?.tts ? 'voice' : 'text')) as VoiceMetadata['voiceMode'],
    realtime: Boolean(metadata?.realtime ?? metadataForLogs?.realtime ?? false),
    provider: resolvedVoiceConfig.provider ?? undefined,
    model: resolvedVoiceConfig.model ?? undefined,
    voiceId: resolvedVoiceConfig.voiceId ?? undefined,
    profileId: resolvedVoiceConfig.profileId ?? undefined,
    common: resolvedVoiceConfig.common ?? undefined,
    providerOptions: resolvedVoiceConfig.providerOptions ?? undefined,
    style: resolvedVoiceConfig.style ?? undefined,
  }

  const runtimeProviderId = isCodexProvider
    ? providerIdentifier && CODEX_PROVIDER_IDS.has(providerIdentifier)
      ? providerIdentifier
      : PRIMARY_CODEX_PROVIDER_ID
    : isClaudeProvider
      ? providerIdentifier && CLAUDE_PROVIDER_IDS.has(providerIdentifier)
        ? providerIdentifier
        : PRIMARY_CLAUDE_PROVIDER_ID
      : providerIdentifier || null
  const showReasoning =
    typeof (agent as any)?.show_reasoning === 'boolean'
      ? Boolean((agent as any).show_reasoning)
      : true
  // BL-941: the sent mode goes in as before; the agent's record is its upper bound.
  const codexRuntimeSettings: CodexRunSettings | null = isCodexProvider
    ? buildCodexRuntimeSettings(
        (agent as any)?.codex_settings ?? providerSpecificSettings,
        {
          permissionMode: metadata?.codexPermissionMode,
        },
      )
    : null
  const claudeRuntimeSettings: ClaudeRunSettings | null = isClaudeProvider
    ? buildClaudeRuntimeSettings(
        (agent as any)?.claude_settings ?? providerSpecificSettings,
        {
          permissionMode: metadata?.claudePermissionMode,
        },
      )
    : null
  if (codexRuntimeSettings && agent?.id) {
    codexRuntimeSettings.profileId = buildAgentProfileId(agent.id)
  }
  if (codexRuntimeSettings) {
    codexRuntimeSettings.reasoningSummary = 'auto'
    codexRuntimeSettings.modelSupportsReasoningSummaries = true
  }
  const mode4Style =
    isCodexProvider || isClaudeProvider
      ? (codexRuntimeSettings?.mode4Style ??
        claudeRuntimeSettings?.mode4Style ??
        MODE4_PRELAUNCH_STYLE)
      : null
  const shouldSimulateStreamingEffect = Boolean(
    isCodexProvider && codexRuntimeSettings?.streamingEffect,
  )

  const runtimeSnapshot: ExecutionRuntimeDetails = {
    runtimeId: isCodexProvider
      ? 'codex'
      : isClaudeProvider
        ? 'claude'
        : 'vercel',
    providerId: runtimeProviderId,
    connectionId: connectionIdentifier || null,
    modelName: null,
    transport: isCodexProvider || isClaudeProvider ? null : 'vercel-sdk',
    status: 'pending',
  }
  let latestCliContext: import('$lib/utils/cliContextWindow').CliContextWindowReport | null = null
  if (mode4Style) {
    runtimeSnapshot.metadata = {
      mode4Style,
      mode4MemoryOwner: resolveMode4MemoryOwner(mode4Style),
      providerSession: {
        configScope:
          codexRuntimeSettings?.configScope ??
          claudeRuntimeSettings?.configScope ??
          null,
        historyPersistence: codexRuntimeSettings?.historyPersistence ?? null,
      },
    }
  }

  const resolvedModelIds = resolveModelIds({
    developerId: primarySelection.provider,
    modelId: primarySelection.modelId,
    effectiveModelId: primarySelection.effectiveModelId,
    connection: primarySelection.connection,
  })
  const effectiveModelId =
    resolvedModelIds?.effectiveModelId ||
    primarySelection.modelId ||
    null
  runtimeSnapshot.modelName = effectiveModelId

  const approvalIds = new Set(
    toolApprovalResponse
      .map((entry) =>
        typeof entry?.approvalId === 'string' ? entry.approvalId.trim() : '',
      )
      .filter(Boolean),
  )

  /**
   * BL-322: the paused call, continued. Its compiled messages are above (the paused turn's own
   * message and `<dynamic_info>`); then every step the paused run took, in order, from the
   * record frozen before the compile; then the answer, which the SDK reads from the LAST
   * message. The replay refuses a record that cannot continue the call (no request for an
   * answered approval, or one another provider or connection wrote) with a 409 the chat shows,
   * and it is built BEFORE the click becomes a grant below, so a refused resume writes nothing.
   */
  const approvalResumeReplay = isApprovalResumeWithoutUserTurn
    ? buildApprovalResumeReplay({
        record: approvalResumePrior,
        approvalIds,
        expected: {
          providerId: providerIdentifier || null,
          connectionId: connectionIdentifier || null,
          planBinding: chatgptPlanLease?.binding ?? null,
        },
      })
    : []
  const approvalResponseMessage: ModelMessage | null = isApprovalResumeWithoutUserTurn
    ? ({ role: 'tool', content: toolApprovalResponse } as ModelMessage)
    : null

  /**
   * SA-116 P2 (DL-116-05, F-P1-4) — turn the click into a grant the run may spend.
   *
   * Resolved BEFORE the model request is built, from the persisted assistant message: which
   * SDK approval belongs to which `toolCallId`, and which `apr_…` record it names. The POST
   * body says only "this approval id, approved or not"; it can never name a different
   * record. `resolveApprovalResumeGrants` also writes the decision, which is the one thing
   * that seeds the scoped voice-engine window DL-116-04 keeps.
   */
  let resolvedControlApprovals: ResolvedApprovalResumeGrants = {
    approved: {},
    denied: {},
  }
  if (hasToolApprovalResponse && sessionId) {
    resolvedControlApprovals = await resolveApprovalResumeGrants({
      userId,
      sessionId,
      messageId,
      responses: toolApprovalResponse,
      mutate: chatgptPlanLease ? write => getChatgptPlanRuntime().mutate(chatgptPlanLease!, write) : undefined,
    })
  }
  const imageOriginCompiledPrefixCount = compiledMessages.length
  const imageOriginReplayUserSources = readUserInputSources((approvalResumePrior?.metadata as any)?.providerUserSources)
  if (approvalResponseMessage) {
    compiledMessages.push(...approvalResumeReplay, approvalResponseMessage)
  }

  const effectiveAutoCompactForPreflight = resolveEffectiveAutoCompactSettings({
    global: userSettings?.global_auto_compact_settings,
    agent: (agent as any)?.auto_compact_settings,
  })
  /**
   * SA-102 P4 (DL-102-04): budget against what the local program is ACTUALLY
   * running or explicitly requested, capped by any smaller positive preset limit.
   *
   * LM Studio held Josh's 27B at 208,384 under a 262,144 ceiling, and Ollama
   * truncates a prompt past its loaded context silently. Every consumer below
   * — the auto-compact trigger, the output reserve, the prompt budget report,
   * and the send-blocking preflight — reads this one number, so correcting it
   * here corrects all of them. When the program cannot report, the preset
   * stands and `source` says why; nothing quietly falls back to the ceiling.
   */
  /**
   * SA-102 P6: one read of the local program records per send, not two.
   *
   * `listLocalAiServers` issues a Redis `json.get` per definition — seven now —
   * and this handler needs the same list twice: here for the context reading and
   * later for image transport. Memoized so the second consumer reuses the first
   * result instead of paying another seven round-trips on the hot path.
   */
  let localAiServersPromise: Promise<Awaited<ReturnType<typeof listLocalAiServers>>> | null =
    null
  const loadLocalAiServersOnce = () => {
    localAiServersPromise ??= listLocalAiServers(userId)
    return localAiServersPromise
  }

  const effectiveContext = await resolveApiContextBudget({
    userId,
    providerId: primaryProviderId,
    modelId: primarySelection.modelId,
    presetContextWindow: primarySelection.contextWindow,
    servers: isLocalProviderId(primaryProviderId) ? await loadLocalAiServersOnce() : undefined,
    requestedContextWindow: primaryProviderId === 'ollama'
      ? ((runtimeSettings.providerOptions?.ollama as Record<string, any> | undefined)?.options?.num_ctx ?? null)
      : null,
  })
  if (effectiveContext.mismatch) {
    console.warn('[Send-Routed] Local context differs from the saved preset', {
      provider: primaryProviderId,
      model: primarySelection.modelId,
      presetContextWindow: effectiveContext.presetContextWindow,
      loadedContextWindow: effectiveContext.loadedContextWindow,
    })
  }
  const cliRuntimeForBudget = isCodexProvider ? 'codex' : isClaudeProvider ? 'claude' : null
  const cliModelForBudget = cliRuntimeForBudget
    ? resolveEffectiveAgentCliModel(
        cliRuntimeForBudget, agentMetadata, primarySelection.settings, primarySelection.modelId
      ) : null
  const cliCapForBudget = isClaudeProvider
    ? claudeContextCappedByEnvironment(cliModelForBudget) : false
  const priorCliContext = cliRuntimeForBudget
    ? await readCliContextReport(sessionId, agentId, cliRuntimeForBudget)
    : { report: null, warning: null, checkedAt: undefined }
  const priorCliReport = priorCliContext.report
  const cliBudgetSettingsKey = cliRuntimeForBudget
    ? cliContextSettingsKey(cliRuntimeForBudget, agentMetadata, primarySelection.contextWindow,
        primarySelection.settings, primarySelection.modelId) : null
  const matchedCliReport = cliRuntimeForBudget ? matchingCliContextReport(priorCliReport, cliBudgetSettingsKey) : null
  const matchingCliReport = matchedCliReport &&
    (!isClaudeProvider || Boolean(matchedCliReport.disableClaude1M) === cliCapForBudget)
      ? matchedCliReport : null
  // Preserve matching historical evidence until this Claude run reports new
  // evidence. Init for the identical concrete model must not downgrade it.
  if (isClaudeProvider && matchingCliReport) {
    latestCliContext = matchingCliReport
    runtimeSnapshot.metadata = { ...(runtimeSnapshot.metadata ?? {}), cliContextWindow: matchingCliReport }
  }
  const promptBudgetContextLimit = priorCliContext.warning ? null : cliRuntimeForBudget
    ? resolveCliContextWindow({
        runtime: cliRuntimeForBudget,
        model: cliModelForBudget,
        presetContextWindow: primarySelection.contextWindow,
        reported: matchingCliReport,
        disableClaude1M: cliCapForBudget
      }).contextWindow
    : effectiveContext.contextLimit
  const promptBudgetAutoCompactTriggerTokens = resolveAutoCompactTriggerTokens(
    effectiveAutoCompactForPreflight,
    promptBudgetContextLimit,
  )
  const promptBudgetOutputReserveTokens = resolveBudgetOutputReserve({
    maxOutputTokens: runtimeSettings.standard.maxTokens ?? null,
    contextLimit: promptBudgetContextLimit,
    reasoningModel: Boolean(primaryCapabilities?.reasoning),
  })
  const [codexProjectInstructionTokens, codexProjectInstructionChars] =
    isCodexProvider
      ? await Promise.all([
          estimateCodexProjectInstructionTokens({
            agent: agent as Record<string, any>,
            projectPath: resolvedCompiledProjectPath,
          }),
          estimateCodexProjectInstructionChars({
            agent: agent as Record<string, any>,
            projectPath: resolvedCompiledProjectPath,
          }),
        ])
      : [0, 0]
  const promptBudget = buildPromptBudgetReport({
    runtime: isCodexProvider ? 'codex' : isClaudeProvider ? 'claude' : 'vercel',
    messages: compiledMessages,
    images,
    contextLimit: promptBudgetContextLimit,
    nativeOverheadTokens: isCodexProvider
      ? CODEX_NATIVE_BASE_OVERHEAD_TOKENS + codexProjectInstructionTokens
      : isClaudeProvider
        ? CLI_WRAPPER_OVERHEAD_TOKENS
        : 0,
    outputReserveTokens: promptBudgetOutputReserveTokens,
    autoCompactTriggerTokens: promptBudgetAutoCompactTriggerTokens,
    extraRuntimeInputChars: codexProjectInstructionChars,
  })
  promptBudget.localContext = effectiveContext.evidence
  executionMetadata.promptBudget = promptBudget
  promptBudget.contextWindowWarning = priorCliContext.warning
  promptBudget.contextWindowCheckedAt = priorCliContext.checkedAt
  if (priorCliContext.warning) {
    promptBudget.contextWindowSettingsKey = cliBudgetSettingsKey
  }

  if (!promptBudget.canSend) {
    throw createRoutedInputError(
      promptBudget.reason,
      'PROMPT_BUDGET_EXCEEDED',
      422,
    )
  }

  let runtimeEventLogBuffer: any[] | null = null
  /**
   * BL-1362: the Batshit Subagent and Worker results Claude Code's own helper model got (the
   * adapter's accounting-only list, filled as the run streams). They count in this reply's
   * `delegated` spend and nowhere else: never its text, steps, zips, cards, or read evidence.
   */
  let helperDelegatedSteps: unknown[] = []
  let runtimeSnapshotPersisted = false

  const persistRuntimeSnapshot = async (
    status: 'succeeded' | 'failed',
    errorMessage?: string,
  ) => {
    if (runtimeSnapshotPersisted) return
    runtimeSnapshotPersisted = true
    runtimeSnapshot.status = status
    runtimeSnapshot.error = errorMessage ?? null

    if (runtimeEventLogBuffer) {
      // SA-105 P3: the raw CLI transport trace is persisted, so it gets the same
      // redaction the LLM captures get. An MCP tool result can now carry image
      // bytes, and the P3 live probe found a delivered recall photo in a real
      // execution log with every other boundary already clean.
      runtimeSnapshot.eventLog = sanitizeRuntimeEventLogForCapture(runtimeEventLogBuffer)
      runtimeSnapshot.eventCount = runtimeEventLogBuffer.length
    }

    try {
      await executionViewerService.updateSnapshot(sessionId, messageId, {
        runtime: runtimeSnapshot,
      })
    } catch (persistError) {
      console.error(
        '[Send-Routed] Failed to persist runtime metadata for execution snapshot:',
        persistError,
      )
    }
  }

  /**
   * BL-321: an approval resume writes into the paused reply's snapshot, and every write of
   * `intermediateSteps` below replaces the list. The paused run's steps are read here, before
   * this run records its own snapshot under the same id, and every write adds this run's steps
   * after them (`withPriorRunSteps`), so the viewer lists them in order instead of rebuilding
   * them from the provider trace as "Partial" rows after the later ones.
   */
  const approvalResumePriorSnapshot = isApprovalResumeWithoutUserTurn
    ? await executionViewerService.getSnapshot(sessionId, messageId)
    : null
  const approvalResumePriorSteps = Array.isArray(approvalResumePriorSnapshot?.intermediateSteps)
    ? approvalResumePriorSnapshot.intermediateSteps
    : []
  const withPriorRunSteps = (steps: unknown): any[] | null =>
    mergeResumedSteps(approvalResumePriorSteps, Array.isArray(steps) ? steps : []) ?? null
  /**
   * BL-525: the same for the run's numbers. Every write of `responseSummary`, `llmSummary`, and
   * `delegated` replaces the stored one, so the resume's finish dropped the paused half's tokens,
   * cost, and Subagent spend from the Token Panel. Each write below is continued from the paused
   * half's snapshot read above (tokens added, both halves' runs; the rule is in
   * `approvalResumeMessage.ts`), always from that frozen read, so a second write never counts the
   * first half twice. Not a resume: the patch as it is.
   */
  const withPriorRunAccounting = (patch: Partial<ExecutionSnapshot>): Partial<ExecutionSnapshot> =>
    continueResumedSnapshotPatch(approvalResumePriorSnapshot, patch)
  if (approvalResumePriorSnapshot) {
    // The paused half's Judge Juice rows first; the resume records its own snapshot over them.
    const typesafeCalls = withPriorTypesafeCalls(
      approvalResumePriorSnapshot.executionMetadata?.typesafeCalls,
      executionMetadata.typesafeCalls,
    )
    if (typesafeCalls.length > 0) executionMetadata.typesafeCalls = typesafeCalls
  }

  try {
    await executionViewerService.recordSnapshot({
      id: messageId,
      sessionId,
      userId,
      agentId,
      agentName: agent.displayName ?? (agent as any).name ?? agent.id,
      agentType: primaryAgentType,
      createdAt: new Date().toISOString(),
      userMessage: pausedApprovalTurn ? pausedApprovalTurn.currentText : content,
      structuredInput: formattedInput.structuredInput,
      primarySystemPrompt: formattedInput.primarySystemPrompt,
      subagentDescription: formattedInput.subagentDescription,
      compiledMessages,
      compileMetadata,
      executionMetadata,
      selectedGateways: selectedGateways ?? null,
      selectedTools: selectedTools ?? null,
      mcpToolSelections: mcpToolSelections ?? null,
      defaultGateways,
      gatewayToolMap,
      voiceMetadata,
      assignedSubagents,
      runtime: runtimeSnapshot,
      // A same-id record merges with the old entry. Until this half reports a complete
      // usage, the joined response/LLM total is unknown, even if the prefix was known.
      ...(approvalResumePriorSnapshot ? withPriorRunAccounting({
        responseSummary: {
          content: { value: '', confidence: 'exact' },
          usage: buildTokenUsage(null, 'estimated'),
          toolCallsCount: buildTokenStat(null, 'estimated'),
        },
        llmSummary: {
          callsCount: buildTokenStat(null, 'speculative'),
          totalUsage: buildTokenUsage(null, 'estimated'),
          breakdownConfidence: 'speculative',
        },
      }) : {}),
    })
  } catch (viewerError) {
    console.error(
      '[Send-Routed] Failed to record execution snapshot:',
      viewerError,
    )
  }

  const sseEndpointUrl = new URL('/api/sse', request.url).toString()
  let forwardedTextChunkToActiveSse = false
  /**
   * BL-775: an event of this reply that `/api/sse` did not record (the forward failed, or it did
   * not answer `success`). The record then has a gap, so the finalize does not save the rebuild:
   * it saves its own full text and says so (`replySavedFromOwnCopy`).
   */
  let replyRecordGap: string | null = null
  /**
   * BL-759: the lane lost its connection mid-answer and started the answer again, and the
   * unfinished first try was taken out of the reply (`case 'text-retract'`). The saved reply says
   * so (`restartedAfterLostConnection`), naming the program.
   */
  let answerRestartedAfterLostConnection = false
  const restartedAnswerProgram = isCodexProvider ? 'Codex' : isClaudeProvider ? 'Claude Code' : 'The agent'
  /**
   * BL-941: the agent's record made this run tighter than the mode its send carried (a group
   * member, an older window). The saved reply says so on every way it ends
   * (`modeLimitedByAgentSettings`): the program, the sent mode, the mode that ran, and for Codex
   * the sandbox that ran.
   */
  const modeLimitedByAgentSettings = codexRuntimeSettings?.modeLimitedByAgentSettings
    ? {
        program: restartedAnswerProgram,
        ...codexRuntimeSettings.modeLimitedByAgentSettings,
        sandbox: codexRuntimeSettings.sandbox,
      }
    : claudeRuntimeSettings?.modeLimitedByAgentSettings
      ? { program: restartedAnswerProgram, ...claudeRuntimeSettings.modeLimitedByAgentSettings }
      : null
  /**
   * BL-775: forwards go one after another (`forwardChain`), so a slow one never lets a later event
   * be recorded before it. Each link settles when its forward answers or when it passes
   * `REPLY_EVENT_FORWARD_LIMIT`, whichever is first. A forward that passes its limit makes the
   * reply a GAP at once (the live copy stalled; the finalize saves its own copy, with the notice),
   * and the chain moves on without it: a later event, `end`, `complete`, and `error` included,
   * never waits for a stuck forward. A forward within its limit is waited for, in order.
   */
  let forwardChain: Promise<void> = Promise.resolve()
  /**
   * How many events of this reply the rebuild reads were forwarded. None (a Stop while the turn was
   * still being set up) means there was nothing to record, so a missing record is not a gap.
   */
  let sentRecordedForwards = 0

  const forwardStreamEvent = async (event: CanonicalStreamEvent) => {
    if (!event?.type) {
      return
    }
    const recordsThisEvent = REPLY_RECORDED_EVENT_TYPES.has(event.type)
    if (recordsThisEvent) sentRecordedForwards += 1
    const previous = forwardChain
    const link = (async () => {
      // `previous` settles by its own limit, and `deliverStreamEvent` settles every failure
      // itself, so a link never rejects and never waits past one forward's limit.
      await previous
      const delivery = deliverStreamEvent(event, recordsThisEvent)
      if (!(await settlesWithin(delivery, REPLY_EVENT_FORWARD_LIMIT.ms))) {
        console.error(
          '[Send-Routed] BL-775: an event forward passed its time limit; the reply is a gap and later events go on without it',
          { sessionId, messageId, type: event.type, limitMs: REPLY_EVENT_FORWARD_LIMIT.ms },
        )
        if (recordsThisEvent && !replyRecordGap) {
          replyRecordGap = `${event.type}: no answer within ${REPLY_EVENT_FORWARD_LIMIT.ms} ms`
        }
      }
    })()
    forwardChain = link
    await link
  }

  const deliverStreamEvent = async (
    event: CanonicalStreamEvent,
    recordsThisEvent: boolean,
  ): Promise<void> => {
    const noteRecordGap = (reason: string) => {
      if (recordsThisEvent && !replyRecordGap) replyRecordGap = `${event.type}: ${reason}`
    }

    const body = {
      ...event,
      sessionId,
      messageId: event.messageId ?? messageId,
    }

    try {
      const response = await eventFetch(sseEndpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-sse-forward': '1',
          ...internalServiceHeaders(),
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errorText = await response
          .text()
          .catch(() => '<failed to read body>')
        console.error('[Send-Routed] SSE forward returned non-OK response', {
          type: event.type,
          status: response.status,
          statusText: response.statusText,
          body: errorText,
        })
        noteRecordGap(`HTTP ${response.status}`)
      } else {
        const responseBody = (await response
          .json()
          .catch(() => null)) as { success?: unknown } | null
        if (event.type === 'chunk' && responseBody?.success === true) {
          forwardedTextChunkToActiveSse = true
        }
        if (responseBody?.success !== true) noteRecordGap('not recorded')
      }
    } catch (err) {
      console.error(
        '[Send-Routed] Failed to forward managed AI stream event to SSE:',
        {
          type: event.type,
          error: err instanceof Error ? err.message : String(err),
        },
      )
      noteRecordGap(err instanceof Error ? err.message : String(err))
    }
  }

  let detectToolSource = (_toolName: string) => ({
    toolProvider: 'unknown',
    toolSource: 'unknown',
  })


  const streamAdapter = new StreamEventAdapter({
    sessionId,
    forward: forwardStreamEvent,
    defaultMetadata: {
      agentId,
      agentType: primaryAgentType,
      agentDisplayName: agent.displayName ?? (agent as any).name ?? agent.id,
      ...(streamMetadata ?? {}),
      ...(approvalResumeStart ? { approvalResumeVersion: approvalResumeStart.version } : {}),
      imageOriginExpected: true,
      imageOriginExpectedVersion: imageOriginVersion,
      providerUserSources: imageOriginReplayUserSources,
    },
    toolMetadataResolver: (toolName) => detectToolSource(toolName),
  })
  streamAdapter.setVoiceMetadata(voiceMetadata)

  const preserveReasoning =
    typeof (agent as any)?.preserve_reasoning === 'boolean'
      ? Boolean((agent as any).preserve_reasoning)
      : false

  let visualCleanup: (() => void) | undefined
  try {
    await initializeKeyspaceNotifications()
    visualCleanup = await setupSessionMonitoring(
      sessionId,
      async (event: VisualIndicatorEvent) => {
        await forwardStreamEvent({
          type: 'zip_activity_change',
          event,
          sessionId,
          timestamp: new Date().toISOString(),
        } as CanonicalStreamEvent)
      },
    )
  } catch (monitorError) {
    console.error(
      '[Send-Routed] Error setting up Redis monitoring:',
      monitorError,
    )
  }

  const finishSummary: {
    text: string
    content: string
    intermediateSteps: any[]
    zipReferences: ZipReference[]
    metadata: Record<string, any>
    usage?: Record<string, any>
    observedUsage?: ObservedUsage
  } = {
    text: '',
    content: '',
    intermediateSteps: [],
    zipReferences: [],
    metadata: {},
  }

  let finalMessagePersisted = false
  let finalizePromise: Promise<void> | null = null
  // BL-775: whether the reply's own text went through the batch `<error>` zip pass.
  let batchZipPassRan = false
  // SA-129 P2: the reply as the model wrote it, control blocks included. The reply-end step
  // stores the cleaned text; the Judge Juice after-reply check still asks what the agent wrote.
  let rawFinishedReply: string | null = null
  // SA-129 P2b (BL-353): the reply-end step's result, kept for a second finalize of the same
  // reply (a save that throws sends the reply through the failure path, which finalizes again):
  // the second run reuses it, so nothing is counted twice, saved twice, or held twice, and the
  // failed record keeps the notes and saves the first run stored.
  let replyControlDone: ReplyControlFinalizeResult | null = null
  // BL-537: whether the step's zip state change has been told to the tabs. A second finalize reuses
  // the step's result and must still tell them once when the first died before its notice.
  let replyControlAnnounced = false
  /**
   * Tells every tab showing the chat that the reply-end step changed its zip state (a hold, a
   * release, a zip action, the countdown, or a step that failed part way), once per reply. It
   * never throws (`publishUserEvent` catches its own errors) and a notice that fails does not fail
   * the reply. Called after the save (and when the save throws, BL-353), and again on the way out
   * of the stream handler, for a first finalize that died before its notice with no second one.
   */
  /**
   * BL-474 step 2: where each picture of the saved reply came from, decided once and written BEFORE
   * `end` (save, decide, then `end`, as BL-775 keeps the record). It judges the text as saved and the
   * text `end` carries, against what this turn delivered to the model. A step that fails leaves the
   * record pending (no Load action) and never fails the reply.
   */
  const decideImageOriginsAtReplyEnd = async (endText: string) => {
    try {
      const stored = await redis.get(`message:${sessionId}:${messageId}`)
      const savedText = typeof (stored as any)?.content === 'string' ? (stored as any).content : null
      if (savedText === null) throw new Error('the saved reply could not be read back')
      const lane = isCodexProvider ? 'codex' : isClaudeProvider ? 'claude' : 'api'
      if (streamAbortSignal.aborted) imageOriginApiInput.poison()
      const run = lane === 'api' ? imageOriginApiInput.run : imageOriginCliDelivery
      const record = decideReplyImageOrigins({
        messageId: messageId as string,
        version: imageOriginVersion,
        lane,
        replyTexts: [savedText, endText],
        // Chat images render on the root page, not under this POST route. Use the renderer's
        // public origin contract; a private Docker service address never proves browser ownership.
        imageSourceContext: { baseUrl: new URL('/', request.url).href, serverUrls: [BROWSER_BATSHIT_SERVER_URL] },
        compiled: lane === 'api' && !imageOriginApiInput.compiledObserved ? null : formattedInput.addressSources ?? null,
        addenda: lane === 'api' && !imageOriginApiInput.compiledObserved ? [] : [mergedSystemPromptAddendum],
        run,
        // API steer provenance comes from the actual converted prompt. A steer taken by
        // prepareStep but never dispatched must not gain provenance through the UI transcript.
        steers: lane === 'api' ? [] : deliveredSteers,
        storedRecords: await loadImageOrigins(sessionId, { messageIds: Array.from(new Set(
          (formattedInput.addressSources?.pieces ?? []).flatMap((piece) =>
            piece.source === 'agent_words' && piece.messageId ? [piece.messageId] : []
          )
        )) }),
      })
      await writeImageOriginDecision({ userId, sessionId, record })
    } catch (originError) {
      console.error('[Send-Routed] BL-474: the reply end could not decide where its pictures came from; they stay pending', {
        sessionId,
        messageId,
        error: originError instanceof Error ? originError.message : String(originError),
      })
    }
  }

  const announceReplyControlZipChange = async () => {
    const source = replyControlDone?.zipStateChanged
    if (!source || replyControlAnnounced) return
    replyControlAnnounced = true
    await publishUserEvent(userId, {
      type: 'zip_state_changed',
      sessionId,
      source,
      opened: [],
      rezipped: [],
    })
  }
  // BL-239: set only when a reply that wrote something stopped at the output limit.
  let replyOutputLimitFailure: ReturnType<typeof outputLimitFailureMetadata> | null = null
  let onFinishResolved = false
  let resolveOnFinish: (() => void) | null = null
  let syncReasoningMetadata = () => {}
  const onFinishPromise = new Promise<void>((resolve) => {
    resolveOnFinish = resolve
  })

  const finalizeAssistantMessage = async (
    context: 'onFinish' | 'postStream' | 'error' = 'onFinish',
  ) => {
    if (context === 'error') imageOriginApiInput.poison()
    if (finalMessagePersisted) {
      logger.debug('[Send-Routed] Finalize skipped - already persisted', {
        sessionId,
        messageId,
        context,
      })
      return
    }

    if (finalizePromise) {
      await finalizePromise
      return
    }

    finalizePromise = (async () => {
      syncReasoningMetadata()
      logger.debug('[Send-Routed] Finalizing assistant message', {
        sessionId,
        messageId,
        context,
        hasContent: Boolean(finishSummary.content),
        hasText: Boolean(finishSummary.text),
        steps: finishSummary.intermediateSteps?.length || 0,
      })

      let endContent = finishSummary.content || finishSummary.text || ''
      if (typeof endContent === 'string') {
        // BL-490: the ONE pass over the whole reply, for every way it ends (finished, stopped,
        // failed). `emitTextChunk` sees one chunk at a time, so a reference the model echoed
        // across two chunks survived it, and the Stop and failure paths saved it raw. Only the
        // reply's own zips stay references; every clip reference is neutralized.
        const sanitizedEndContent = neutralizeFinishedReplyReferences(
          stripAttachmentReferences(endContent),
          finishSummary.zipReferences
            .map((ref) => ref.zipId || extractZipIdFromReference(ref.reference))
            .filter((id): id is string => Boolean(id)),
        )
        if (sanitizedEndContent !== endContent) {
          endContent = sanitizedEndContent
          if (finishSummary.content) {
            finishSummary.content = endContent
          } else if (finishSummary.text) {
            finishSummary.text = endContent
          }
        }
      }
      if (!endContent) {
        console.warn(
          '[Send-Routed] Finalizing assistant message with empty content',
          {
            sessionId,
            messageId,
            context,
            hasFinishSummary: Boolean(
              finishSummary.text || finishSummary.content,
            ),
          },
        )
      }
      // SA-129 P2 (DL-08, BL-234): the reply-end control step, once per reply, here on the
      // server for every lane and every caller: Tool Notes, hold and release, memory saves, the
      // parked zip actions, the countdown, and `controlErrors`. `end` and the saved record carry
      // the cleaned text; `/api/sse`'s `end` strips the same blocks from its rebuild because the
      // metadata flag says so. The chat page only renders.
      const finishedContent = typeof endContent === 'string' ? endContent : ''
      let replyControl: ReplyControlFinalizeResult
      if (replyControlDone) {
        // A second finalize of the same reply (BL-353): the step already ran. Only the words are
        // cleaned again (the failure path may hand in other text); nothing is applied twice, and
        // its zip state change is told at most once (`announceReplyControlZipChange`, BL-537).
        replyControl = {
          ...replyControlDone,
          content: extractReplyControl(finishedContent).cleaned,
        }
      } else {
        rawFinishedReply = finishedContent
        try {
          // Each step inside fails on its own with its own line (BL-353); this does not throw.
          replyControl = await finalizeReplyControl({
            userId,
            sessionId,
            messageId,
            agent: agent as any,
            globalZipSettings,
            content: rawFinishedReply,
            replyZipIds: Array.from(
              new Set(
                finishSummary.zipReferences
                  .map((ref) => ref.zipId || extractZipIdFromReference(ref.reference))
                  .filter((id): id is string => Boolean(id)),
              ),
            ),
            projectPath: resolvedCompiledProjectPath,
            countsAsMessage: !isApprovalResumeWithoutUserTurn,
          })
        } catch (controlError) {
          // Last resort for an error outside every step. What ran before it is unknown, so the
          // line says so instead of claiming nothing was applied; loud on the message and in the
          // next turn's DCM, never silent.
          console.error('[Send-Routed] Reply-end control step failed:', controlError)
          const extraction = extractReplyControl(rawFinishedReply)
          const fallback = buildReplyControlMetadata(extraction, {
            toolNotesEnabled: resolveZipToolNotesEnabled(agent as any, globalZipSettings),
          })
          replyControl = {
            content: extraction.cleaned,
            metadata: {
              [REPLY_CONTROL_FINALIZED_FLAG]: true,
              ...(fallback.zipControl ? { zipControl: fallback.zipControl } : {}),
              controlErrors: [
                ...fallback.controlErrors,
                buildControlErrorRecord(
                  'batshit-tool-notes',
                  `Batshit could not finish this reply's control step: ${
                    controlError instanceof Error ? controlError.message : String(controlError)
                  }`,
                  'Part of it may have been applied. Check Current Zip State and your memories before you ask again.',
                ),
              ],
            },
            // Something may have changed; every tab re-reads the chat's zip state.
            zipStateChanged: 'agent',
            hadMemoryBlock: extraction.memoryBlocks.length > 0,
          }
        }
        replyControlDone = replyControl
      }
      endContent = replyControl.content
      if (finishSummary.content) {
        finishSummary.content = endContent
      } else if (finishSummary.text) {
        finishSummary.text = endContent
      }
      const endMetadataBase =
        Object.keys(finishSummary.metadata).length > 0
          ? finishSummary.metadata
          : {
              model: effectiveModelId ?? primarySelection.modelId,
              agentType: primaryAgentType,
              voice: voiceMetadata,
              selectedTools,
              selectedGateways,
            }
      if (approvalResumeStart) endMetadataBase.approvalResumeVersion = approvalResumeStart.version
      if (finishSummary.observedUsage) {
        endMetadataBase.observedUsage = finishSummary.observedUsage
        endMetadataBase.usage = null
      }
      // SA-129 P2: what the reply-end step stored joins the SAME metadata `end` and the saved
      // record get; control errors from earlier writers are kept, never replaced.
      {
        const { controlErrors: replyControlErrors, ...replyControlMetadata } = replyControl.metadata
        Object.assign(endMetadataBase, replyControlMetadata)
        if (Array.isArray(replyControlErrors) && replyControlErrors.length > 0) {
          const earlier = Array.isArray(endMetadataBase.controlErrors) ? endMetadataBase.controlErrors : []
          // A second finalize of the same reply (BL-353) hands in the first run's records again,
          // and the failure path kept them on this metadata: each line is stored once.
          const seen = new Set(earlier.map((record: unknown) => JSON.stringify(record)))
          endMetadataBase.controlErrors = [
            ...earlier,
            ...replyControlErrors.filter((record: unknown) => !seen.has(JSON.stringify(record))),
          ]
        }
      }
      // BL-239: the failure facts join the SAME metadata the `end` event and the saved record get,
      // so the banner shows live and after a reload; joined, never replacing the base.
      if (replyOutputLimitFailure) Object.assign(endMetadataBase, replyOutputLimitFailure)
      if (finishSummary.zipReferences.length > 0) {
        const trustedZipIds = Array.from(
          new Set(
            finishSummary.zipReferences
              .map((ref) => ref.zipId || extractZipIdFromReference(ref.reference))
              .filter((id): id is string => Boolean(id)),
          ),
        )
        if (trustedZipIds.length > 0) {
          endMetadataBase.zipIds = Array.from(
            new Set([
              ...(Array.isArray(endMetadataBase.zipIds) ? endMetadataBase.zipIds : []),
              ...trustedZipIds,
            ]),
          )
          endMetadataBase.zipReferences = finishSummary.zipReferences
        }
      }
      // SA-114 P1 (DL-114-04): the delivered steers ride the SAME single write as the
      // content that carries their placeholders. It is set here, in `finalizeAssistantMessage`,
      // rather than on the happy path only, so a steer that landed before an interrupt or a
      // failure is still expandable in the record that keeps the partial work.
      if (deliveredSteers.length > 0) {
        endMetadataBase.steers = deliveredSteers.map((steer) => ({
          steerId: steer.steerId,
          text: steer.text,
          at: steer.at,
          step: steer.step,
          lane: steer.lane,
          source: steer.source,
          ...(steer.dmId ? { dmId: steer.dmId } : {}),
          ...(steer.label ? { label: steer.label } : {}),
        }))
      }
      // Preserve the exact pause even if its live end was missed. A later approval
      // click clears the card before its resume runs, so answered alone is not terminal.
      // These ids come only from the actual run owner and delivered user entries.
      if (approvalSummaryIsPending(endMetadataBase.toolApprovals) && endMetadataBase.interrupted !== true && endMetadataBase.response_failed !== true) {
        const pausedSteerIds = [...new Set([
          ...(Array.isArray(streamMetadata?.steerPromoted?.steerIds) ? streamMetadata.steerPromoted.steerIds : []),
          ...deliveredSteers.filter((entry) => entry.source !== 'dm').map((entry) => entry.steerId),
        ])]
        if (pausedSteerIds.length) endMetadataBase.steerPromoted = {
          steerIds: pausedSteerIds, disposition: 'awaiting_approval',
          approvalResumeVersion: approvalResumeStart?.version ?? 0,
        }
      }
      // SA-104 P5: chat-surface "memory inserted" affordance — the accepted-send
      // commit result rides the finalized assistant message. On-my-mind presence is
      // deliberately not stamped (ambient every turn; EV owns that visibility).
      if (
        memoryTurnCommit?.committed &&
        (memoryTurnCommit.insertedNewIds.length > 0 ||
          memoryTurnCommit.refreshedIds.length > 0 ||
          memoryTurnCommit.heldIds.length > 0)
      ) {
        endMetadataBase.memoryInserted = {
          version: 1,
          new: memoryTurnCommit.insertedNewIds.length,
          refreshed: memoryTurnCommit.refreshedIds.length,
          held: memoryTurnCommit.heldIds.length,
          ids: [
            ...memoryTurnCommit.insertedNewIds,
            ...memoryTurnCommit.refreshedIds,
            ...memoryTurnCommit.heldIds,
          ],
          // Per-item rows (2026-08-28) power the chip's click-open detail popover.
          ...(memoryTurnCommit.items.length > 0 ? { items: memoryTurnCommit.items } : {}),
        }
      }
      // SA-120 P1 (DL-120-02 / B6): a Judge Juice miss note or capability-gap chip rides the
      // finalized assistant message, beside the memory chips.
      const jevJuiceMessageMetadata = buildJevJuiceMessageMetadata(jevJuiceTurn)
      if (jevJuiceMessageMetadata) {
        endMetadataBase.jevJuice = jevJuiceMessageMetadata
      }
      // BL-759, BL-941: every way the reply ends (finished, stopped, failed) keeps the notes.
      if (answerRestartedAfterLostConnection) {
        endMetadataBase.restartedAfterLostConnection = { program: restartedAnswerProgram }
      }
      if (modeLimitedByAgentSettings) {
        endMetadataBase.modeLimitedByAgentSettings = modeLimitedByAgentSettings
      }
      const sanitizedEndMetadata = sanitizePayloadForLogs(endMetadataBase)
      const sanitizedIntermediateSteps = sanitizePayloadForLogs(
        finishSummary.intermediateSteps.length > 0
          ? finishSummary.intermediateSteps
          : [],
      )
      const sanitizedEndContent =
        typeof endContent === 'string'
          ? redactDataImageUrlsInText(endContent).value
          : endContent
      const serverZipReferences = finishSummary.zipReferences.filter(
        (ref): ref is ZipReference =>
          typeof ref?.reference === 'string' && ref.reference.length > 0,
      )

      // BL-775: the server owns this reply's saved record, and its text has ONE maker: the stream
      // path, whose events `/api/sse` recorded after its zip detection (`replyStreamRecord.ts`).
      // The rebuild is what every tab shows and what the agent reads next. It is saved FIRST and
      // only then published as `end`, so each reader that acts on `end` finds the record.
      let recordedReply: RecordedReplyEnd | null = null
      // Every forward of this reply has answered or passed its own limit (a gap); from here a late
      // content or tool event is refused by `/api/sse`, so nothing lands after the rebuild.
      await forwardChain
      // The words the zip detector still holds (an `<error>` block that never closed, or a lone
      // start of its tag at the end) join the record NOW, while the reply is open: a closed reply
      // refuses every content event, so written after the close they would be lost from the saved
      // reply and from `end`. No await sits between the flush and the close.
      flushHeldReplyText(sessionId, messageId)
      closeReplyRecord(sessionId, messageId)
      let ownCopyReason: string | null = replyRecordGap
      if (!ownCopyReason) {
        try {
          recordedReply = await rebuildRecordedReply({
            sessionId,
            messageId,
            incomingZipReferences: serverZipReferences,
            intermediateSteps: sanitizedIntermediateSteps as any[],
            endContent: typeof sanitizedEndContent === 'string' ? sanitizedEndContent : '',
            // send-routed serves only managed agents (API and CLI): tool cards are inline.
            inlineCapable: true,
            replyControlFinalized: (sanitizedEndMetadata as any)?.[REPLY_CONTROL_FINALIZED_FLAG] === true,
            // A group speaker's own copy has its Goon cues, emotes and stage directions stripped;
            // the rebuild strips the same, so the stored reply equals it.
            groupChat: streamMetadata?.groupChat === true,
          })
          if (!recordedReply) ownCopyReason = NO_STREAM_RECORD_REASON
        } catch (rebuildError) {
          ownCopyReason = `the rebuild failed: ${
            rebuildError instanceof Error ? rebuildError.message : String(rebuildError)
          }`
        }
      }

      // What the record keeps is exactly what `end` carries: the stream's defaults and voice facts
      // included, as the tab's save used to store them.
      const recordMetadata: Record<string, any> = streamAdapter.composeEventMetadata(
        sanitizedEndMetadata as Record<string, any>,
      )
      recordMetadata.imageOriginExpected = true
      recordMetadata.imageOriginExpectedVersion = imageOriginVersion
      let recordContent: string
      let recordZipReferences: ZipReference[]
      let recordSteps: any[]
      if (recordedReply) {
        recordContent = redactDataImageUrlsInText(recordedReply.content).value
        recordZipReferences = recordedReply.zipReferences
        // This run's steps; an approval resume joins the earlier part's steps once, below.
        recordSteps = recordedReply.ownIntermediateSteps
        recordMetadata.zipIds = recordedReply.zipIds
      } else {
        // Condition 3: a finished reply is never lost. The record could not be had, so this
        // copy of the words is saved, the record says so, and the chat shows a plain notice.
        // Unless nothing was ever streamed (a Stop during setup): then there was nothing to
        // record, so the own copy is the whole reply, and nothing is missing to warn about.
        const nothingWasStreamed =
          sentRecordedForwards === 0 && ownCopyReason === NO_STREAM_RECORD_REASON
        if (!nothingWasStreamed) {
          console.error(
            '[Send-Routed] BL-775: saved the reply from its own copy because its stream record could not be had',
            { sessionId, messageId, reason: ownCopyReason },
          )
        }
        let ownContent = typeof sanitizedEndContent === 'string' ? sanitizedEndContent : ''
        recordZipReferences = [...serverZipReferences]
        if (!batchZipPassRan && ownContent) {
          // The stream path would have zipped its `<error>` blocks; its record is not used, so
          // this copy gets the one batch pass instead.
          const processed = await zipDetection.processFullContent(sessionId, messageId, ownContent, {
            agent: zipSettingsAgent,
            globalSettings: globalZipSettings,
            messagesFromEnd: 0,
          })
          ownContent = processed.content
          recordZipReferences.push(...processed.references)
        }
        recordContent = finishReplyEndContent(ownContent, recordZipReferences)
        recordSteps = sanitizedIntermediateSteps as any[]
        recordMetadata.zipIds = replyEndZipIds(recordContent, recordZipReferences)
        if (recordZipReferences.length > 0) recordMetadata.zipReferences = recordZipReferences
        if (!nothingWasStreamed) recordMetadata[REPLY_SAVED_FROM_OWN_COPY_KEY] = true
      }

      // BL-496, BL-775: the reply's Claude approval cards, as the server recorded them (answered,
      // denied, or expired and why), joined by approval id with its other cards, while the
      // registry still holds them. A tab used to carry them from `end` into its save; an unwatched
      // Claude reply lost them.
      const claudeCards = buildClaudeApprovalSummary(sessionId, messageId)
      if (claudeCards) {
        recordMetadata.toolApprovals = joinApprovalSummaries(recordMetadata.toolApprovals, claudeCards)
      }

      const providerMessageSource =
        recordMetadata.providerMessageSource && typeof recordMetadata.providerMessageSource === 'object'
          ? (recordMetadata.providerMessageSource as Record<string, unknown>)
          : {}
      const firstText = (...values: unknown[]) =>
        values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim()

      const finalMessage: ChatMessage = {
        id: messageId,
        session_id: sessionId,
        user_id: userId,
        agent_id: agentId,
        role: 'assistant',
        // BL-775: `status`, `model`, and `provider` were written only by a tab's save.
        status: 'complete',
        model: firstText(providerMessageSource.modelId, effectiveModelId, primarySelection.modelId),
        provider: firstText(providerMessageSource.providerId, providerIdentifier, primarySelection.provider),
        content: recordContent,
        created_at: new Date().toISOString(),
        intermediateSteps: recordSteps.length > 0 ? recordSteps : undefined,
        metadata: recordMetadata,
      }

      // An API-lane approval resume CONTINUES the message the card was on: its stream starts
      // empty, and `saveMessage` replaces content, so saving it as the whole message dropped
      // the words before the card and any tool run before it (`approvalResumeMessage.ts`).
      if (isApprovalResumeWithoutUserTurn && typeof finalMessage.content === 'string') {
        const priorRecord = approvalResumePrior
        if (priorRecord) {
          const continued = composeInPlaceResumeMessage(priorRecord, {
            content: finalMessage.content,
            metadata: (finalMessage.metadata ?? {}) as Record<string, any>,
            intermediateSteps: finalMessage.intermediateSteps as any[] | undefined,
          })
          // BL-775: the rebuild's text already holds the part before the card (the resume's
          // start carried it), so only its own copy is joined here; joining the rebuild again
          // would put the earlier words in twice. Metadata and steps are joined once either way.
          if (!recordedReply?.continuesEarlierPart) finalMessage.content = continued.content
          finalMessage.metadata = continued.metadata
          finalMessage.intermediateSteps = continued.intermediateSteps
        }
      }

      try {
        await redis.saveMessage(finalMessage)
        // The reply is stored: a later step that throws (a notice, `end`, the snapshot) must not
        // send it through the failure path's second finalize, a second save and a second `end`.
        finalMessagePersisted = true
      } finally {
        // SA-129 P2: the reply-end step changed this chat's zip state (a hold, a release, a zip
        // action, the countdown); every tab showing the chat re-reads it. Told even when the save
        // fails (BL-353): the state changed all the same. Once per reply (BL-537).
        await announceReplyControlZipChange()
      }

      // BL-775 condition 5: the own copy does not name the zips the stream path made for this
      // reply (its record was not used). Those no message names go, with their zip state, so no
      // zip is left without a reference. After the save, so the saved reply's claims count.
      if (!recordedReply) {
        try {
          const streamMade = await takeStreamMadeZipReferences(sessionId, messageId)
          const streamMadeIds = streamMade
            .map((ref) => ref.zipId || extractZipIdFromReference(ref.reference))
            .filter((id): id is string => Boolean(id))
          if (streamMadeIds.length > 0) {
            await redis.removeUnclaimedZipsMadeByMessage(sessionId, messageId, streamMadeIds)
          }
        } catch (orphanError) {
          console.error('[Send-Routed] BL-775: could not remove the stream-made zips of a reply saved from its own copy', {
            sessionId,
            messageId,
            error: orphanError instanceof Error ? orphanError.message : String(orphanError),
          })
        }
      }

      // BL-474 step 2: before `end`, so a tab that shows the ended reply finds its decision.
      await decideImageOriginsAtReplyEnd(finalMessage.content as string)

      // Then `end`: the saved bytes, which `/api/sse` hands to the tabs as they are.
      await streamAdapter.emitEnd({
        content: finalMessage.content as string,
        intermediateSteps: (finalMessage.intermediateSteps as any[] | undefined) ?? [],
        zipReferences: recordZipReferences,
        metadata: (finalMessage.metadata ?? {}) as Record<string, any>,
        savedRecord: true,
      })

      // Reconcile the authoritative saved continuation after live delivery. The versioned
      // start reopens this same id; this notification also recovers tabs that missed it.
      if (isApprovalResumeWithoutUserTurn) {
        // BL-775: the reply is saved and ended; a notice that fails must not fail the reply.
        try {
          await publishUserEvent(userId, {
            type: 'session_messages_changed',
            sessionId,
            reason: 'approval_resume',
          })
        } catch (noticeError) {
          console.error('[Send-Routed] Failed to tell the tabs about a saved approval resume:', noticeError)
        }
      }

      try {
        await executionViewerService.updateSnapshot(sessionId, messageId, {
          reasoningPersistence: buildReasoningPersistenceEvidence({
            showReasoning,
            preserveReasoning,
            reasoningSummary:
              typeof (finalMessage.metadata as any)?.reasoningSummary === 'string'
                ? (finalMessage.metadata as any).reasoningSummary
                : null,
            interruptedReasoningRecovery: readInterruptedReasoningRecovery(finalMessage),
          }),
        })
      } catch (reasoningEvidenceError) {
        console.warn(
          '[Send-Routed] Failed to record reasoning persistence evidence:',
          reasoningEvidenceError,
        )
      }

      zipDetection.deleteSessionBuffers(sessionId)
      finalMessagePersisted = true
    })()

    try {
      await finalizePromise
    } finally {
      finalizePromise = null
    }
  }

  /**
   * BL-775: a stopped reply is saved by the server only (a tab no longer saves it), and `end` is
   * published only after that save. So a save that fails is tried once more after a short wait,
   * and when that fails too the tab is told in plain words instead of a log line alone. Answers
   * whether the reply is stored. A chat deleted mid-reply is gone: its save fails by design.
   */
  const finalizeStoppedReply = async (label: string): Promise<boolean> => {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await finalizeAssistantMessage('error')
        return true
      } catch (saveError) {
        if (stoppedForDeletedChat()) return false
        console.error(`[Send-Routed] ${label} (attempt ${attempt} of 2):`, saveError)
        if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, STOPPED_REPLY_SAVE_RETRY_MS))
      }
    }
    console.error('[Send-Routed] BL-775: a stopped reply could not be saved', { sessionId, messageId })
    try {
      await streamAdapter.emitError({
        error: STOPPED_REPLY_NOT_SAVED_TEXT,
        metadata: { interrupted: true, replyNotSaved: true },
      })
    } catch (emitError) {
      console.error('[Send-Routed] Failed to tell the tabs a stopped reply was not saved:', emitError)
    }
    return false
  }

  // SA-018 (revised): Reasoning summaries stream as metadata (not zips / not message content)
  /**
   * This request's own copy of the reply's text, kept by segment (BL-759): a managed lane may take
   * back a message its vendor never finished (`case 'text-retract'`). The finalize reads it when it
   * saves its own copy (a gap in the stream record), so that copy never holds a fragment either.
   * Batshit's own additions (zip references, steer markers) have no segment and are never removed.
   */
  const streamedReply = new SegmentedText()
  let reasoningActive = false
  let reasoningCaptured = ''
  const reasoningStreamSource = new ReasoningStreamSourceArbiter()
  let thinkingIndicatorEmitted = false
  let planItems: PlanItem[] = []
  let planSummary = ''
  syncReasoningMetadata = () => {
    const visibleMetadata = showReasoning
      ? {
          ...(reasoningCaptured ? { reasoningSummary: reasoningCaptured } : {}),
          ...(planSummary ? { planSummary } : {}),
          ...(planItems.length > 0 ? { planItems } : {}),
        }
      : {}
    const interruptedReasoningRecovery =
      finishSummary.metadata?.interrupted === true
        ? buildInterruptedReasoningRecovery({
            agentId,
            reasoningSummary: reasoningCaptured,
            planSummary,
          })
        : null

    if (Object.keys(visibleMetadata).length === 0 && !interruptedReasoningRecovery) {
      return
    }

    finishSummary.metadata = {
      ...finishSummary.metadata,
      ...visibleMetadata,
      ...(interruptedReasoningRecovery ? { interruptedReasoningRecovery } : {}),
    }
  }
  const streamedToolSteps: any[] = []
  // BL-245: what each model call of this run showed, for a run that never reaches the SDK's
  // finish (it failed mid-stream, or was stopped): its snapshot still gets the calls and the
  // tool steps (`streamFailureEvidence.ts`). ONE writer of the calls: the finish callback and
  // the failure path can both be under way (the loop waits at most 2 s for the callback), and
  // the snapshot merge keeps both writers' rows, so whichever claims first writes them.
  const streamStepRecorder = createStreamStepRecorder()
  const llmCaptureClaim = createLlmCaptureClaim()
  const streamedApprovalRequests = new Map<string, ToolApprovalEntry>()
  const streamedToolCallIds = new Set<string>()
  const streamedToolZipCallIds = new Set<string>()
  const streamedToolZipReferences: ZipReference[] = []
  const reservedToolZipIdsByCallId = new Map<string, string>()
  const streamedToolZipRefsByCallId = new Map<
    string,
    ZipReference[]
  >()
  const imageZipRefsByCallId = new Map<
    string,
    ZipReference[]
  >()
  const imageZipRefsByToolName = new Map<
    string,
    ZipReference[]
  >()
  const imageZipIdsForUi = new Set<string>()
  const toolCallIdByName = new Map<string, string>()
  const toolCallPayloadById = new Map<
    string,
    { toolName?: string; input?: any; toolCall?: Record<string, any> }
  >()
  const emittedImageToolResultIds = new Set<string>()
  let coolToolZipAdapterModule:
    | typeof import('$lib/server/coolToolZipAdapter')
    | null = null
  /**
   * One zip id per tool call, decided when the CALL arrives, so both zip-writing sites
   * (this stream's `tool-result` case and the finish path's pending steps) write the same
   * id for the same call.
   *
   * F-P4-9: it used to accept an id supplied by a caller, for the managed CLI helper's
   * `batshitZipControl` notice. The first reservation always won, so the announced id
   * never matched the saved zip; nothing announces an id to the model any more.
   */
  const reserveToolZipIdForCall = (params: {
    toolCallId?: string | null
    toolName?: string | null
  }): string | undefined => {
    const toolCallId =
      typeof params.toolCallId === 'string' ? params.toolCallId.trim() : ''
    if (!toolCallId) return undefined

    const existing = reservedToolZipIdsByCallId.get(toolCallId)
    if (existing) return existing

    const zipId = reserveZipId('cool_tool')
    reservedToolZipIdsByCallId.set(toolCallId, zipId)
    return zipId
  }
  let ensureStartEmitted: (() => Promise<void>) | null = null
  let controlsEnabled = false
  let controlsResolved = false
  let controlsMode: string = 'responding'
  let controlsPayload: Record<string, any> | null = null
  // BL-759: the group control buffer and what it hands on keep each word's segment.
  let controlsBuffer = new SegmentedText()
  let pendingControlPieces: Array<{ segmentId: string | null; text: string }> = []
  /** The segment whose words decided the group control (BL-759: a retract of it decides again). */
  let controlsResolvedBySegment: string | null = null
  let silentResponse = false
  let rawUsageFromStream: UsageLike | null = null
  const rawUsageByFinishedStep: unknown[] = []
  let streamLocalCacheReporting = resolveLocalPromptCacheReporting(null)
  let lastStreamSteps: any[] | null = null
  let lastStreamText: string | null = null
  let lastResolvedUsage: UsageLike | null = null
  let streamRuntimeError: Error | null = null
  let shouldBreakStream = false
  // BL-239: why the run's LAST model request ended (`finish.finishReason`), and that request's
  // output count (its `finish-step` usage). `length` means it stopped at the output limit.
  let streamFinishReason: unknown = null
  let lastStepOutputTokens: number | null = null

  /**
   * One piece of the reply's text. `segmentId` (BL-759) names the managed lane's segment (the
   * vendor message) it belongs to; it rides on every chunk, so a later retract can take it back.
   */
  const emitTextChunk = async (
    content: string,
    options: { allowZipReferences?: boolean; segmentId?: string | null } = {},
  ) => {
    if (!content) return
    const safeContent = options.allowZipReferences
      ? content
      : neutralizeAllClipReferenceSyntax(neutralizeAllZipReferenceSyntax(content))
    if (ensureStartEmitted) {
      await ensureStartEmitted()
    }
    const segmentId = options.segmentId ?? null
    streamedReply.append(safeContent, segmentId)
    streamedNonSteerContent = true
    if (shouldSimulateStreamingEffect) {
      await emitSimulatedChunks(safeContent, async (simulated) => {
        await streamAdapter.emitChunk({ content: simulated, segmentId })
      })
    } else {
      await streamAdapter.emitChunk({ content: safeContent, segmentId })
    }
  }

  /**
   * The words the group chat's control buffer handed on after its leading control block, each
   * with its segment (BL-759), written as the reply's text.
   */
  const flushPendingControlText = async () => {
    if (pendingControlPieces.length === 0) return
    const pieces = pendingControlPieces
    pendingControlPieces = []
    for (const piece of pieces) {
      await emitTextChunk(piece.text, { segmentId: piece.segmentId })
    }
  }

  const emitPlanUpdate = async (raw: any) => {
    const normalizedItems = normalizePlanItems(raw)
    if (normalizedItems.length === 0) return
    planItems = normalizedItems
    planSummary = formatPlanSummary(normalizedItems)
    await streamAdapter.emitPlanUpdate({
      content: planSummary,
      items: normalizedItems,
      metadata: { source: 'codex', type: 'plan_update' },
    })
  }

  const appendToolZipReference = (reference: string) => {
    if (!reference) return
    const streamed = streamedReply.toString()
    if (streamed && !streamed.endsWith('\n')) {
      streamedReply.append('\n\n')
    }
    streamedReply.append(reference)
    streamedNonSteerContent = true
  }

  /**
   * SA-114 P1 (DL-114-04, DL-114-05) — the steer channel for this turn.
   *
   * A steer may be delivered only inside an ordinary single-agent turn: group chats are
   * interrupt-only in v1 (DL-114-12), and a group member's run is not the user's own turn.
   * `handleBatshitAgentStream` is reached by the group loop as well as the normal send, so
   * the gate lives here, once, rather than at each call site.
   */
  const steerDeliveryEnabled = !groupContext && streamMetadata?.groupChat !== true

  /** Delivered steers, in the order they landed, for `metadata.steers[]` (DL-114-04). */
  const deliveredSteers: DeliveredSteer[] = []
  /**
   * P2: whether this run put its steerability verdict in the steer registry, so the
   * `finally` removes exactly what it added and never another turn's.
   */
  let steerRunRegistered = false
  /**
   * True once real model output has been streamed. `selectFinishZipInput` prefers
   * `streamedReply` whenever it is non-empty, so a turn whose ONLY streamed bytes
   * were steer markers must not beat the SDK's own finish text — the markers are re-added
   * after selection in that case.
   */
  let streamedNonSteerContent = false
  /**
   * How many `finish-step` chunks THIS loop has consumed. The SDK runs ahead of the loop
   * (it can be several chunks into the next step by the time a `tool-result` here has
   * finished its zip write), so "which chunk is in hand" says nothing reliable about
   * where the step boundary sits in `streamedReply`. This count does: a steer
   * delivered after step k is written only once the loop has consumed step k's finish.
   */
  let finishedStepsConsumed = 0

  /**
   * Write every steer the transport just handed to the model into the transcript.
   *
   * Called once per stream iteration, which is what puts the marker exactly where
   * DL-114-04 says it goes: AFTER the tool result's zip placeholder (appended while that
   * `tool-result` chunk was handled) and BEFORE the next text chunk. The marker is a
   * placeholder, not the text — the words live in `metadata.steers[]` and both compilers
   * expand them, the same split the zip family uses.
   *
   * Gated on `finishedStepsConsumed` (F-P1-3): a steer whose delivery step the loop has
   * not yet finished consuming stays in the inbox, so the marker can never land inside
   * the step the model read it after — not between two parallel tool results (measured
   * live on BSMS, 2026-09-10) and not before a fast tool's result while the loop is still
   * writing the previous step. `force` is for the finish path, where every step is over.
   *
   * Nothing here touches the session-turn lock, clip consumption, or the memory linger
   * commit: a delivered steer rides inside a turn that has already paid those once
   * (DL-114-02).
   */
  const drainSteersIntoTranscript = async (force = false) => {
    if (!steerDeliveryEnabled) return
    const drained = drainDeliveredSteers(sessionId, messageId, {
      upToStep: force ? Number.POSITIVE_INFINITY : finishedStepsConsumed,
    })
    if (drained.length === 0) return

    for (const steer of drained) {
      deliveredSteers.push(steer)
      const placeholder = buildSteerPlaceholder(steer.steerId)
      const streamed = streamedReply.toString()
      const prefix = streamed && !streamed.endsWith('\n') ? '\n\n' : ''
      streamedReply.append(`${prefix}${placeholder}`)

      // SA-114 P3 (F-P3-A): the marker has to go out as a CHUNK, not only into
      // `streamedReply`.
      //
      // `/api/sse`'s `end` case does not forward the content it is handed: it REBUILDS the
      // final content from the stream events it recorded (`buildEndContent`), and that
      // rebuild wins whenever it is non-empty. The browser then saves the rebuilt content
      // back over the record. So a marker that never rode a chunk survived the server's own
      // save and was erased a moment later by the client's — which is exactly why P1 and P2
      // could not see this: they drove the route with no browser, so nothing overwrote it.
      //
      // It deliberately does NOT go through `emitTextChunk`: that sets
      // `streamedNonSteerContent`, and a turn whose only streamed bytes were steer markers
      // must still let the SDK's finish text win (the `steerMarkersOnly` branch below).
      if (ensureStartEmitted) {
        await ensureStartEmitted()
      }
      await streamAdapter.emitChunk({ content: `${prefix}${placeholder}` })

      await forwardStreamEvent({
        type: 'steer_delivered',
        sessionId,
        messageId,
        steerId: steer.steerId,
        step: steer.step,
        lane: steer.lane,
        source: steer.source,
      } as CanonicalStreamEvent)
    }

    // SA-114 P4 review (F-P4-2): an `info` DM the model has just read is no longer open.
    // The wake lane closes a delivered note at the end of its turn (SA-115 F-P1-2); a
    // steer hands it over just as surely — the transport confirmed the model has it — so
    // it closes here, at delivery, for the recipient of THIS run. Left open, the same
    // note re-lists on every later turn's roster and sits in the drawer for a week.
    // Assignments and results are untouched: they are work, not notes.
    const deliveredDmSteers = drained.filter((steer) => steer.source === 'dm' && steer.dmId)
    if (deliveredDmSteers.length > 0) {
      await acknowledgeDeliveredDmSteers(deliveredDmSteers, agentId)
    }
  }

  const imageZipSettings = getTypeZipSettings(
    'image',
    zipSettingsAgent,
    globalZipSettings,
  )
  let screenshotUploadConfigCache: ScreenshotUploadConfig | null | undefined = undefined

  const resolveScreenshotUploadConfig = async () => {
    if (screenshotUploadConfigCache !== undefined) {
      return screenshotUploadConfigCache
    }

    screenshotUploadConfigCache = await resolveUploadConfigForScreenshot(
      userSettings,
      {
        onManagedTunnelUnavailable(details) {
          console.warn(
            '[Send-Routed] Managed Cloudflare tunnel unavailable for screenshot upload:',
            {
              sessionId,
              messageId,
              targetUrl: details.targetUrl,
              reason: details.reason,
            },
          )
        },
      },
    )

    return screenshotUploadConfigCache
  }

  const materializeImageOutput = async (
    output: ImageOutput,
  ): Promise<{ content: string; mediaType: string } | null> => {
    if (
      typeof output.dataUrl === 'string' &&
      output.dataUrl.trim().length > 0
    ) {
      const trimmed = output.dataUrl.trim()
      const mediaType =
        extractMediaTypeFromDataUrl(trimmed) ||
        output.mediaType ||
        DEFAULT_IMAGE_MEDIA_TYPE
      return {
        content: trimmed,
        mediaType,
      }
    }

    if (
      typeof output.filePath === 'string' &&
      output.filePath.trim().length > 0
    ) {
      const localPath = path.resolve(output.filePath.trim())
      try {
        const bytes = await readLocalImageOutputWithinLimit(localPath)
        if (!bytes) {
          console.warn('[Send-Routed] Skipping unavailable local image output')
          return null
        }
        const mediaType =
          output.mediaType ||
          inferImageMediaTypeFromPath(localPath) ||
          DEFAULT_IMAGE_MEDIA_TYPE
        return {
          content: `data:${mediaType};base64,${bytes.toString('base64')}`,
          mediaType,
        }
      } catch (error) {
        console.warn('[Send-Routed] Failed to read local image output:', {
          path: localPath,
          error: error instanceof Error ? error.message : String(error),
        })
        return null
      }
    }

    return null
  }

  const createImageZipReference = async (
    output: ImageOutput,
    metadata: Record<string, any> = {},
  ): Promise<{ zipId: string; reference: string } | null> => {
    const screenshotTempPath =
      metadata?.source === 'agent_browser_screenshot' &&
      typeof output.filePath === 'string' &&
      output.filePath.trim().length > 0
        ? path.resolve(output.filePath.trim())
        : null
    try {
      let content: string | null = null
      let mediaType = output.mediaType || DEFAULT_IMAGE_MEDIA_TYPE
      let screenshotMetadata: Record<string, any> = {}

      if (metadata?.source === 'agent_browser_screenshot') {
        const uploadConfig = await resolveScreenshotUploadConfig()
        if (uploadConfig) {
          const localPath =
            typeof output.filePath === 'string' &&
            output.filePath.trim().length > 0
              ? path.resolve(output.filePath.trim())
              : null

          if (localPath) {
            try {
              const bytes = await readLocalImageOutputWithinLimit(localPath)
              if (bytes) {
                const fileName = path.basename(localPath)
                const resolvedMediaType =
                  output.mediaType ||
                  inferImageMediaTypeFromPath(localPath) ||
                  DEFAULT_IMAGE_MEDIA_TYPE

                const formData = new FormData()
                const blob = bytesToBlob(bytes, { type: resolvedMediaType })
                formData.append('file', blob, fileName)
                formData.append('sessionId', sessionId)
                formData.append('userId', userId)
                formData.append(
                  'compressionSettings',
                  JSON.stringify({
                    compress_images: false,
                    force_jpeg: false,
                  }),
                )
                formData.append(
                  'uploadSettings',
                  JSON.stringify({
                    strategy: uploadConfig.strategy,
                    storage_mode: uploadConfig.storageMode,
                    tunnel_url: uploadConfig.tunnelUrl,
                    use_https: uploadConfig.useHttps,
                    tunnel_provider: uploadConfig.tunnelProvider,
                    cloudflared_auto_start: uploadConfig.cloudflaredAutoStart,
                    cloudflared_target_url: uploadConfig.cloudflaredTargetUrl,
                    artifact_source: 'agent_browser_screenshot',
                    skip_clip_persistence: true,
                    artifact_ttl_seconds:
                      AGENT_BROWSER_SCREENSHOT_ARTIFACT_TTL_SECONDS,
                    strategyConfig: {
                      ttlSeconds: AGENT_BROWSER_SCREENSHOT_ARTIFACT_TTL_SECONDS,
                      ephemeral: true,
                    },
                  }),
                )

                const uploadResponse = await fetch(
                  `${getInternalBatshitServerUrl()}/api/upload/single`,
                  {
                    method: 'POST',
                    headers: getInternalBatshitServerAuthHeaders(),
                    body: formData,
                  },
                )
                const uploadPayload = await uploadResponse
                  .json()
                  .catch(() => null)

                if (uploadResponse.ok) {
                  const uploadedFile = uploadPayload?.file
                  const storageMode = String(
                    uploadedFile?.storageMode || '',
                  ).toLowerCase()
                  const resolvedExternalUrl = resolveScreenshotUploadModelUrl(
                    uploadedFile,
                    uploadConfig,
                  )

                  if (resolvedExternalUrl) {
                    content = resolvedExternalUrl
                    mediaType =
                      typeof uploadedFile?.mimetype === 'string'
                        ? uploadedFile.mimetype
                        : resolvedMediaType
                    screenshotMetadata = {
                      artifactTtlSeconds:
                        AGENT_BROWSER_SCREENSHOT_ARTIFACT_TTL_SECONDS,
                      uploadStrategyUsed:
                        uploadedFile?.uploadStrategy || uploadConfig.strategy,
                      uploadStorageMode:
                        storageMode || uploadConfig.storageMode,
                      uploadDisplayUrl:
                        typeof uploadedFile?.displayUrl === 'string'
                          ? uploadedFile.displayUrl
                          : null,
                      uploadExternalUrl: resolvedExternalUrl,
                      fallbackMode: 'url',
                    }
                  } else {
                    screenshotMetadata = {
                      artifactTtlSeconds:
                        AGENT_BROWSER_SCREENSHOT_ARTIFACT_TTL_SECONDS,
                      uploadStrategyUsed:
                        uploadedFile?.uploadStrategy || uploadConfig.strategy,
                      uploadStorageMode:
                        storageMode || uploadConfig.storageMode,
                      fallbackMode: 'data_url',
                    }
                  }
                } else {
                  console.warn(
                    '[Send-Routed] Screenshot upload failed; falling back to data URL zip',
                    {
                      sessionId,
                      messageId,
                      status: uploadResponse.status,
                      error:
                        uploadPayload?.error || uploadPayload?.details || null,
                    },
                  )
                }
              }
            } catch (uploadError) {
              console.warn(
                '[Send-Routed] Screenshot upload path failed; falling back to data URL zip',
                {
                  sessionId,
                  messageId,
                  error:
                    uploadError instanceof Error
                      ? uploadError.message
                      : String(uploadError),
                },
              )
            }
          }
        }
      }

      if (!content) {
        const materialized = await materializeImageOutput(output)
        if (!materialized?.content) return null
        content = materialized.content
        mediaType = materialized.mediaType
        if (metadata?.source === 'agent_browser_screenshot') {
          screenshotMetadata = {
            ...screenshotMetadata,
            artifactTtlSeconds: AGENT_BROWSER_SCREENSHOT_ARTIFACT_TTL_SECONDS,
            fallbackMode: screenshotMetadata?.fallbackMode ?? 'data_url',
          }
        }
      }

      const created = await createZipFromContent(
        content,
        'image',
        sessionId,
        messageId,
        {
          description: 'Generated image',
          mimeType: mediaType,
          bufferSize: imageZipSettings.bufferSize,
          threshold: imageZipSettings.zipThreshold,
          ...metadata,
          ...screenshotMetadata,
        },
      )
      return created || null
    } catch (error) {
      console.error('[Send-Routed] Failed to create image zip:', error)
      return null
    } finally {
      if (shouldCleanupAgentBrowserTempScreenshot(screenshotTempPath)) {
        try {
          await unlink(screenshotTempPath as string)
        } catch (cleanupError) {
          const code =
            cleanupError &&
            typeof cleanupError === 'object' &&
            'code' in cleanupError
              ? String((cleanupError as any).code)
              : null
          if (code !== 'ENOENT') {
            console.warn(
              '[Send-Routed] Failed to cleanup Agent Browser temp screenshot',
              {
                path: screenshotTempPath,
                error:
                  cleanupError instanceof Error
                    ? cleanupError.message
                    : String(cleanupError),
              },
            )
          }
        }
      }
    }
  }

  const emitReasoningAppend = async (content: string) => {
    if (!showReasoning) return
    if (!content) return
    await streamAdapter.emitThinking({
      content,
      metadata: {
        op: 'append',
        kind: 'reasoning_summary',
      },
    })
  }

  const emitReasoningReplace = async (content: string) => {
    if (!showReasoning) return
    await streamAdapter.emitThinking({
      content,
      metadata: {
        op: 'replace',
        kind: 'reasoning_summary',
      },
    })
  }

  const appendReasoningDelta = async (content: string) => {
    if (!content) return
    if (!reasoningActive && reasoningCaptured) {
      reasoningCaptured += '\n\n'
      await emitReasoningAppend('\n\n')
    }
    reasoningActive = true
    reasoningCaptured += content
    await emitReasoningAppend(content)
  }

  const flushRawReasoningFallback = async () => {
    const pending = reasoningStreamSource.flushRawFallback()
    if (pending) {
      await appendReasoningDelta(pending)
    }
  }

  const ensureReasoningSegmentBoundary = async () => {
    if (!reasoningActive) return
    // Treat any boundary (text/tool/finish) as the end of a reasoning segment.
    reasoningActive = false
  }

  const startReasoningSegment = async (initial: string) => {
    reasoningStreamSource.noteNormalizedReasoning()
    if (!reasoningActive && reasoningCaptured) {
      reasoningCaptured += '\n\n'
      await emitReasoningAppend('\n\n')
    }
    reasoningActive = true
    if (initial) {
      reasoningCaptured += initial
      await emitReasoningAppend(initial)
    }
  }

  const replaceReasoningSnapshot = async (content: string, final: boolean) => {
    if (!content) return
    reasoningStreamSource.noteNormalizedReasoning()
    reasoningCaptured = content
    reasoningActive = !final
    await emitReasoningReplace(content)
  }

  const emitThinkingIndicator = async () => {
    if (thinkingIndicatorEmitted) return
    if (streamedReply.length > 0) return
    await streamAdapter.emitThinking({
      content: THINKING_INDICATOR,
      metadata: {
        kind: 'reasoning_indicator',
        op: 'start',
      },
    })
    thinkingIndicatorEmitted = true
  }

  const emitThinkingIndicatorStop = async () => {
    if (!thinkingIndicatorEmitted) return
    await streamAdapter.emitThinking({
      content: '',
      metadata: {
        kind: 'reasoning_indicator',
        op: 'stop',
      },
    })
    thinkingIndicatorEmitted = false
  }

  const handleReasoningIndicator = async () => {
    if (showReasoning) return false
    if (controlsEnabled && !controlsResolved) {
      if (ensureStartEmitted) {
        await ensureStartEmitted()
      }
      await emitThinkingIndicator()
      return true
    }
    if (controlsMode === 'listening') {
      silentResponse = true
      shouldBreakStream = true
      return true
    }
    await flushPendingControlText()
    if (ensureStartEmitted) {
      await ensureStartEmitted()
    }
    await emitThinkingIndicator()
    return true
  }

  type StreamRuntimeSettings = ReturnType<typeof buildRuntimeModelSettings>

  // SA-093 P7: Batshit-measured wall-clock stream timings for the managed CLI
  // lanes, whose fabricated streams carry no SDK performance data. Marks come
  // from the canonical stream loop; the synthetic Codex "thinking" indicator
  // is emitted outside that loop and never counts as first output.
  const measuredStreamTiming = {
    startedAt: null as number | null,
    firstOutputAt: null as number | null,
    toolActiveMs: 0,
    toolWindowStartedAt: null as number | null,
    activeToolCalls: 0,
  }
  const resetMeasuredStreamTiming = () => {
    measuredStreamTiming.startedAt = Date.now()
    measuredStreamTiming.firstOutputAt = null
    measuredStreamTiming.toolActiveMs = 0
    measuredStreamTiming.toolWindowStartedAt = null
    measuredStreamTiming.activeToolCalls = 0
  }
  const markMeasuredFirstOutput = () => {
    if (measuredStreamTiming.firstOutputAt === null) {
      measuredStreamTiming.firstOutputAt = Date.now()
    }
  }
  const markMeasuredToolCallStart = () => {
    markMeasuredFirstOutput()
    measuredStreamTiming.activeToolCalls += 1
    if (measuredStreamTiming.activeToolCalls === 1) {
      measuredStreamTiming.toolWindowStartedAt = Date.now()
    }
  }
  const markMeasuredToolCallEnd = () => {
    if (measuredStreamTiming.activeToolCalls <= 0) return
    measuredStreamTiming.activeToolCalls -= 1
    if (
      measuredStreamTiming.activeToolCalls === 0 &&
      measuredStreamTiming.toolWindowStartedAt !== null
    ) {
      measuredStreamTiming.toolActiveMs +=
        Date.now() - measuredStreamTiming.toolWindowStartedAt
      measuredStreamTiming.toolWindowStartedAt = null
    }
  }
  const measuredToolActiveMsTotal = (at: number) =>
    measuredStreamTiming.toolActiveMs +
    (measuredStreamTiming.toolWindowStartedAt !== null
      ? Math.max(0, at - measuredStreamTiming.toolWindowStartedAt)
      : 0)

  const buildStreamRequest = (
    modelId: string,
    connection: NativeModeRequest['connection'],
    requestProviderId: string | null,
    settings: StreamRuntimeSettings,
    providerSettingsOverride: Record<string, any> | null,
    capabilities: ModelCapabilities | null,
    toolsEnabled: boolean,
    streamMessages: any[] = compiledMessages,
    streamImages: Array<{ url: string }> = images,
  ): NativeModeRequest => {
    streamLocalCacheReporting = resolveLocalPromptCacheReporting(
      connection?.service ?? requestProviderId ?? null,
    )
    const providerOptions = withReasoningProviderOptions(
      Object.keys(settings.providerOptions).length > 0
        ? settings.providerOptions
        : undefined,
      {
        provider: requestProviderId,
        modelId,
        connection,
        capabilities,
        showReasoning,
      },
    )
    const taggedReasoningTagName = resolveTaggedReasoningTagName({
      provider: requestProviderId,
      modelId,
      connection,
      capabilities,
      showReasoning,
    })

    return {
    chatgptPlanLease,
      sessionId,
    messageId,
    agentId,
    agentSlug: agent.slug ?? null,
    // SA-104 P3: primary-agent sends of memory-enabled agents get the sys.memory.* refs.
    memoryControlsEnabled: resolveAgentMemoryEnabled(agent),
    // SA-113 P2 (DL-113-03): the ONE place a primary send turns the sys.dm.* refs on.
    // The guidance block and the DCM roster follow the same rule, so an agent never gets
    // the tools without the instructions or the roster without the tools (DL-113-13).
    dmControlsEnabled: resolveAgentDmsEnabled(agent),
    // SA-115 P2 (DL-115-10): the schedule family rides the SAME per-agent switch, because
    // a schedule's only output is a DM.
    scheduleControlsEnabled: resolveAgentDmsEnabled(agent),
    // SA-120 P2 (DL-120-06): the Judge Juice judgment tool rides its own per-agent switch.
    judgeControlsEnabled: resolveAgentJevJudgeToolEnabled(agent),
    // SA-111 P4 (DL-111-11): the ONE place a primary send turns Workers on. Every
    // delegated run leaves it unset, which is what enforces depth 1.
    workersEnabled: resolveWorkersEnabled(agent),
    // SA-116 P2 (DL-116-05, DL-116-10): the approvals this resume may spend, and whether
    // this is a group member's turn (a group run never registers the risk policy at all —
    // its card would be persisted and then abandoned as the next speaker starts).
    controlApprovals: resolvedControlApprovals,
    groupMemberRun: streamMetadata?.groupChat === true,
    // SA-114 P1 (DL-114-05): the ONE place a run is allowed to deliver a steer. Groups are
    // interrupt-only in v1 (DL-114-12) and a delegated run is not the user's turn
    // (DL-114-09), so both leave this null and the composed hook injects nothing.
    takeSteers: steerDeliveryEnabled
      ? (step: number) =>
          takePendingSteersForDelivery(sessionId, messageId, { step, lane: 'api' })
      : null,
    messages: streamMessages,
    imageOriginInput: { compiledPrefixCount: imageOriginCompiledPrefixCount, userSources: imageOriginReplayUserSources },
    onApiModelInput: isCodexProvider || isClaudeProvider ? undefined : (input) => {
      try { imageOriginApiInput.observe(input) } catch {
        imageOriginApiInput.poison()
        console.error('[Send-Routed] Picture input observation failed; its completeness stays unknown')
      }
    },
    model: modelId,
    mode4Style: mode4Style ?? undefined,
    connection,
    // SA-105 P2 (DL-105-06): the saved model's capabilities travel with the run so
    // the tool-result image lane uses the SAME vision rule as attached clips
    // rather than inventing a second one. Unknown stays allowed; a genuinely
    // text-only model then fails loudly through IMAGE_INPUT_UNSUPPORTED.
    modelCapabilities: capabilities ?? null,
    images: streamImages,
    availableTools: selectedTools?.map((name: string) => ({
      name,
      description: `Tool: ${name}`,
      schema: {},
    })),
    maxToolRounds: 100,
    // SA-102 P1 (DL-102-01): blank means "do not send". A parameter the user
    // left empty is absent from the request body — no substituted default at
    // any layer, so the model's own default applies.
    //
    // `settings.standard` is already the FULL merge: buildRuntimeModelSettings
    // receives the agent-level `primary_model_*` values as
    // its `fallbacks`, applies them only where the preset left a gap, honours
    // isParameterSuppressedForModel, and runs every surviving maxTokens through
    // normalizeRuntimeMaxTokens. A second `?? overrides.x` chain here used to
    // re-add exactly those agent values AFTER suppression had removed them and
    // AFTER the context clamp had run — so it could smuggle a sampler onto a
    // model that rejects it, and `?? 16384` escaped the clamp entirely.
    temperature: settings.standard.temperature,
    maxTokens: settings.standard.maxTokens,
    topP: settings.standard.topP,
    topK: settings.standard.topK,
    presencePenalty: settings.standard.presencePenalty,
    frequencyPenalty: settings.standard.frequencyPenalty,
    seed: settings.standard.seed,
    stopSequences: settings.standard.stopSequences,
    providerOptions,
    providerSettings: providerSettingsOverride ?? null,
    codexSettings: codexRuntimeSettings ?? undefined,
    claudeSettings: claudeRuntimeSettings ?? undefined,
    cliContextSelection: isClaudeProvider ? {
      model: cliModelForBudget,
      presetContextWindow: primarySelection.contextWindow ?? null,
      settingsKey: cliBudgetSettingsKey,
      priorReport: matchingCliReport
    } : undefined,
    toolsEnabled,
    projectPath:
      resolvedCompiledProjectPath ??
      metadata?.projectPath ??
      metadataForLogs?.projectPath ??
      batshitInput?.metadata?.projectPath ??
      null,
    toolSelections: mcpToolSelections,
    selectedCliToolIds,
    selectedGateways,
    preloadedGatewayTools: preloadedGatewayTools ?? undefined,
    preloadedGatewayMetadata: preloadedGatewayMetadata ?? undefined,
    gatewayToolMap,
    assignedSubagents,
    defaultGateways,
    toolApprovalMode: runToolApprovalMode,
    userId,
    abortSignal: streamAbortSignal,
    simulateStreamingEffect: shouldSimulateStreamingEffect,
    taggedReasoningTagName,
    onCliModelResult: isCodexProvider || isClaudeProvider
      ? (delivery) => appendCliModelResult(imageOriginCliDelivery, delivery)
      : undefined,
    onCliContext: isCodexProvider || isClaudeProvider
      ? (report) => {
          latestCliContext = reportForCliSnapshot(
            { ...report, reportedAt: Date.now() }, agentMetadata, primarySelection.contextWindow,
            primarySelection.settings, primarySelection.modelId
          )
          runtimeSnapshot.metadata = {
            ...(runtimeSnapshot.metadata ?? {}), cliContextWindow: latestCliContext
          }
        }
      : undefined,
    onFinish: async ({
      text,
      steps,
      totalUsage,
      usage,
      reasoning,
      responseMessages,
      apiUserSources,
      observedUsage,
    }) => {
      // Keep evidence before awaited presentation work can fail; it is never billable usage.
      if (isCodexProvider) finishSummary.observedUsage = readObservedUsage(observedUsage)
      // SA-093 P7: stamp finish time immediately — the zip/EV work below can
      // take real time and must not inflate measured stream timings.
      const measuredFinishedAt = Date.now()
      // SA-114 P1 (DL-114-04): idempotent, and the reason it is FIRST is ordering — the
      // finish path reads `streamedReply` a few lines down, and a steer delivered
      // at the final step boundary must already be in it. Forced: every step is over on
      // the SDK's side, so the consumed-step gate has nothing left to protect.
      await drainSteersIntoTranscript(true)
      const sanitizedFinishText = stripToolPartOnlyText(text)

      // SA-107 (DL-107-06/07): SDK usage stays authoritative; raw-chunk cache
      // fields fill gaps (flat cached_tokens lanes), and the gateway lane can
      // derive inclusive cache usage from step providerMetadata.
      // SA-102 (DL-102-13): each local response's raw usage is the authority.
      // The SDK maps absent cached_tokens to zero and drops raw at aggregation.
      const resolvedUsage =
        withHonestLocalCacheUsage(
          resolveMessageUsage({
            sdkUsage: totalUsage || usage || undefined,
            rawStreamUsage: rawUsageFromStream ?? undefined,
            steps,
            isGatewayLane: connection?.type === 'vercel-gateway',
          }),
          resolveLocalPromptCacheReporting(
            connection?.service ?? requestProviderId ?? null,
          ),
          Array.isArray(steps) ? steps.map((step: any) => step?.usage?.raw) : [],
        ) ?? undefined
      lastStreamSteps = Array.isArray(steps) ? steps : []
      lastResolvedUsage = resolvedUsage ?? null

      logger.debug('[Send-Routed] Stream finished', {
        sessionId,
        messageId,
        totalTokens: resolvedUsage?.totalTokens,
      })

      if (silentResponse) {
        finishSummary.usage = resolvedUsage
        onFinishResolved = true
        resolveOnFinish?.()
        return
      }

      const parsed = buildIntermediateStepsFromSteps(steps)
      const intermediateSteps =
        streamedToolSteps.length > 0
          ? streamedToolSteps
          : parsed.intermediateSteps
      const filteredSteps = Array.isArray(intermediateSteps)
        ? intermediateSteps.filter(
            (step) =>
              !isPlanUpdateTool(
                step?.toolName ??
                  step?.tool ??
                  step?.originalToolName ??
                  step?.action?.tool,
              ),
          )
        : intermediateSteps
      const subagentEchoCandidates = [
        ...(Array.isArray(parsed.intermediateSteps)
          ? parsed.intermediateSteps
          : []),
        ...(Array.isArray(filteredSteps) ? filteredSteps : []),
      ]
      const normalizedFinishText = stripLeadingSubagentEchoText(
        sanitizedFinishText,
        subagentEchoCandidates,
      )

      lastStreamText = normalizedFinishText || null
      finishSummary.text = normalizedFinishText
      finishSummary.intermediateSteps = filteredSteps
      const delegated = buildDelegatedExecutionSummary([
        ...(Array.isArray(filteredSteps) ? filteredSteps : []),
        ...helperDelegatedSteps,
      ])

      // Safety: if a reasoning segment is still open, treat it as complete now.
      reasoningActive = false

      // Some providers expose reasoning only in the final SDK result.
      if (!reasoningCaptured) {
        const finishReasoning = collectReasoningTextFromFinish(reasoning)
        if (finishReasoning) {
          reasoningStreamSource.noteNormalizedReasoning()
          reasoningCaptured = finishReasoning
          await emitReasoningReplace(finishReasoning)
        }
      }

      // Some providers expose reasoning summaries via steps rather than streaming events.
      // If we didn't capture anything in-stream, try to collect and emit once here.
      if (!reasoningCaptured && Array.isArray(steps)) {
        const collected: string[] = []

        for (const step of steps) {
          const direct =
            typeof (step as any)?.reasoningText === 'string'
              ? String((step as any).reasoningText).trim()
              : ''
          if (direct) {
            collected.push(direct)
            continue
          }

          const parts = (step as any)?.reasoning
          if (Array.isArray(parts)) {
            const joined = parts
              .map((part: any) =>
                typeof part?.text === 'string' ? part.text.trim() : '',
              )
              .filter(Boolean)
              .join('\n')
            if (joined.trim()) {
              collected.push(joined.trim())
            }
          }
        }

        const combined = collected.join('\n\n').trim()
        if (combined) {
          reasoningStreamSource.noteNormalizedReasoning()
          reasoningCaptured = combined
          await emitReasoningReplace(combined)
        }
      }

      const fileOutputs = Array.isArray(streamResult?.files)
        ? streamResult.files
        : []
      if (fileOutputs.length > 0) {
        let fileIndex = 0
        for (const file of fileOutputs) {
          const imageOutput = fileToImageOutput(file)
          if (!imageOutput) continue
          const created = await createImageZipReference(imageOutput, {
            source: 'result_files',
            fileIndex,
          })
          if (!created?.reference) continue
          const refEntry = { reference: created.reference }
          streamedToolZipReferences.push(refEntry)
          const streamed = streamedReply.toString()
          const prefix = streamed && !streamed.endsWith('\n') ? '\n\n' : ''
          await emitTextChunk(`${prefix}${created.reference}`, {
            allowZipReferences: true,
          })
          fileIndex += 1
        }
      }

      // SA-114 P1: `selectFinishZipInput` prefers the streamed content whenever it is
      // non-empty. A turn whose only streamed bytes were steer MARKERS (no text, no tool
      // zip) would therefore beat the SDK's own finish text and lose the reply. In that
      // one case the finish text wins and the markers are re-appended after selection;
      // position is meaningless there because nothing streamed before them.
      const steerMarkersOnly =
        deliveredSteers.length > 0 && !streamedNonSteerContent
      const steerMarkerTail = steerMarkersOnly
        ? deliveredSteers.map((steer) => buildSteerPlaceholder(steer.steerId)).join('\n\n')
        : ''
      const finishZipInput = selectFinishZipInput({
        streamedMessageContent: steerMarkersOnly ? '' : streamedReply.toString(),
        sanitizedFinishText,
        forwardedToActiveSse: forwardedTextChunkToActiveSse
      })
      const baseTextForZipping = stripToolPartOnlyText(finishZipInput.content)

      // BL-775: the batch pass zipped this text; a finalize that saves its own copy must not
      // zip it twice.
      if (finishZipInput.processXmlZips) batchZipPassRan = true
      const inlineProcessed = finishZipInput.processXmlZips
        ? await zipDetection.processFullContent(
            sessionId,
            messageId,
            baseTextForZipping,
            {
              agent: zipSettingsAgent,
              globalSettings: globalZipSettings,
              messagesFromEnd: 0,
            },
          )
        : { content: baseTextForZipping, references: [] }

      let finalContent = inlineProcessed.content
      if (steerMarkerTail) {
        finalContent = finalContent
          ? `${finalContent}\n\n${steerMarkerTail}`
          : steerMarkerTail
      }
      const inlineZipRefs = inlineProcessed.references

      let coolToolZips: ZipReference[] = []
      const pendingToolSteps = Array.isArray(filteredSteps)
        ? filteredSteps.filter((step) => {
            const callId =
              typeof step?.toolCallId === 'string'
                ? step.toolCallId
                : typeof step?.id === 'string'
                  ? step.id
                  : undefined
            if (!callId) return true
            return !streamedToolZipCallIds.has(callId)
          })
        : []
      if (pendingToolSteps.length > 0) {
        const { adaptCoolToolsToZipSystem } =
          await import('$lib/server/coolToolZipAdapter')
        coolToolZips = await adaptCoolToolsToZipSystem(
          pendingToolSteps,
          sessionId,
          messageId,
          zipSettingsAgent || {},
          globalZipSettings,
          {
            reservedZipIdsByToolCallId: reservedToolZipIdsByCallId,
          },
        )
      }

      const allZipRefs = [
        ...inlineZipRefs,
        ...streamedToolZipReferences,
        ...coolToolZips,
      ]

      for (const ref of allZipRefs) {
        if (!finalContent) {
          finalContent = ref.reference
          continue
        }

        if (ref.placeholder && finalContent.includes(ref.placeholder)) {
          finalContent = finalContent.replace(ref.placeholder, ref.reference)
        } else if (ref.reference && !finalContent.includes(ref.reference)) {
          finalContent = `${finalContent} ${ref.reference}`.trim()
        }
      }

      // Providers sometimes emit attachment: URLs that browsers cannot resolve.
      // Strip them from persisted assistant content to avoid render errors/spam.
      if (typeof finalContent === 'string') {
        finalContent = stripAttachmentReferences(finalContent)
        // BL-490: zip and clip references are neutralized in `finalizeAssistantMessage`, once,
        // against `finishSummary.zipReferences` (set to `allZipRefs` below).
        if (streamMetadata?.groupChat === true) {
          finalContent = stripGroupChatPresentationControls(finalContent)
        }
      }

      finishSummary.content = finalContent
      finishSummary.zipReferences = allZipRefs
      finishSummary.metadata = {
        model: primaryModelId,
        agentType: primaryAgentType,
        // SA-107: the chat strip reads this — same resolved value as finishSummary.usage.
        usage: resolvedUsage,
        ...(finishSummary.observedUsage ? { observedUsage: finishSummary.observedUsage, usage: null } : {}),
        steps: steps?.length || 0,
        voice: voiceMetadata,
        selectedTools,
        selectedGateways,
        ...(delegated ? { delegated } : {}),
        ...(imageZipIdsForUi.size > 0
          ? { imageZipIds: Array.from(imageZipIdsForUi) }
          : {}),
      }
      if (Array.isArray(responseMessages) && responseMessages.length > 0) {
        // BL-322: everything the model read after the compiled messages (a resume's replay and
        // answer, then this run's steps with each steer where the model read it), so the next
        // approval resume of this reply replays it whole.
        const stepMessageCounts = (Array.isArray(steps) ? steps : []).map((step: any) =>
          Array.isArray(step?.response?.messages) ? step.response.messages.length : 0,
        )
        let replayableTranscript: ModelMessage[]
        try {
          replayableTranscript = buildReplayableTranscript({
            replay: approvalResumeReplay,
            approvalResponse: approvalResponseMessage,
            responseMessages,
            stepMessageCounts,
            steers: deliveredSteers,
          })
        } catch (transcriptError) {
          // Only when the SDK's steps and messages disagree: the steers cannot be placed, so the
          // transcript is stored without them rather than with them in the wrong place.
          console.error('[Send-Routed] Could not place delivered steers in the stored transcript:', transcriptError)
          replayableTranscript = buildReplayableTranscript({
            replay: approvalResumeReplay,
            approvalResponse: approvalResponseMessage,
            responseMessages,
            stepMessageCounts,
            steers: [],
          })
        }
        const persistedProviderMessages =
          sanitizeProviderMessagesForPersistence(replayableTranscript)
        finishSummary.metadata = {
          ...finishSummary.metadata,
          providerMessages: persistedProviderMessages,
          providerUserSources: readUserInputSources(apiUserSources),
          providerMessageSource: {
            providerId: providerIdentifier || null,
            connectionId: connection?.id || connection?.service || null,
            ...(chatgptPlanLease ? { planBinding: chatgptPlanLease.binding } : {}),
            modelId: typeof modelId === 'string' ? modelId.toLowerCase() : null,
          },
        }
      }

      if (streamMetadata && Object.keys(streamMetadata).length > 0) {
        finishSummary.metadata = {
          ...finishSummary.metadata,
          ...streamMetadata,
        }
      }

      if (controlsEnabled && controlsResolved) {
        const controlsMeta = controlsPayload ?? { mode: controlsMode }
        finishSummary.metadata = {
          ...finishSummary.metadata,
          controls: controlsMeta,
        }
      }

      finishSummary.usage = resolvedUsage
      if (latestCliContext) {
        finishSummary.metadata = { ...finishSummary.metadata, cliContextWindow: latestCliContext }
      }

      // SA-093 P7: persist per-send stream performance for the chat-bar strip.
      // `API` uses the SDK's own measurements; the managed CLI lanes fall back
      // to Batshit-measured wall-clock timings (DL-093-14 per-lane sources).
      // Anything not measured stays absent so the strip renders honest unknowns.
      const performanceMetadata =
        buildMessagePerformanceFromSteps(Array.isArray(steps) ? steps : []) ??
        (isCodexProvider || isClaudeProvider
          ? buildMeasuredMessagePerformance({
              startedAt: measuredStreamTiming.startedAt,
              firstOutputAt: measuredStreamTiming.firstOutputAt,
              finishedAt: measuredFinishedAt,
              toolActiveMs: measuredToolActiveMsTotal(measuredFinishedAt),
              outputTokens:
                typeof resolvedUsage?.outputTokens === 'number'
                  ? resolvedUsage.outputTokens
                  : null,
            })
          : null)
      if (performanceMetadata) {
        finishSummary.metadata = {
          ...finishSummary.metadata,
          performance: performanceMetadata,
        }
      }

      onFinishResolved = true
      resolveOnFinish?.()

      try {
        if (isCodexProvider || isClaudeProvider) {
          const {
            buildCodexPromptFromMessages,
            buildCodexPromptPackageFromMessages,
          } =
            await import('$lib/server/services/codexBridge')
          const sanitizedStreamMessages = sanitizePayloadForLogs(streamMessages)
          const sanitizedStreamImages = sanitizePayloadForLogs(streamImages)
          const sanitizedToolSteps = sanitizePayloadForLogs(
            Array.isArray(intermediateSteps) ? intermediateSteps : [],
          )
          const promptInput = {
            messages: sanitizedStreamMessages as Array<{
              role?: string
              content: any
              name?: string
            }>,
            images: sanitizedStreamImages as Array<{
              url: string
              alt?: string
            }>,
          }
          const codexPromptPackage = isCodexProvider
            ? buildCodexPromptPackageFromMessages(promptInput)
            : null
          const prompt =
            codexPromptPackage?.prompt ??
            buildCodexPromptFromMessages(promptInput)

          const capture = isCodexProvider
            ? buildCodexLlmCapture({
                prompt,
                developerInstructions:
                  codexPromptPackage?.developerInstructions ?? null,
                images: sanitizedStreamImages as Array<{
                  url: string
                  alt?: string
                }>,
                tools: preloadedGatewayTools ?? null,
                toolMetadata: preloadedGatewayMetadata ?? null,
                totalUsage: resolvedUsage ?? null,
              })
            : buildClaudeLlmCapture({
                prompt,
                images: sanitizedStreamImages as Array<{
                  url: string
                  alt?: string
                }>,
                tools: preloadedGatewayTools ?? null,
                toolMetadata: preloadedGatewayMetadata ?? null,
                totalUsage: resolvedUsage ?? null,
              })

          const responseUsageSource = isCodexProvider ? 'codex' : 'claude'
          const responseNotes = isCodexProvider
            ? [
                ...(finishSummary.observedUsage
                  ? ['Codex reported the saved observations before this run ended. Its complete usage and cost remain unknown.']
                  : ['Codex CLI totals are exact when the CLI reports usage, but per-step on-wire payload breakdown is unavailable.']),
              ]
            : [
                'Claude Code CLI totals are exact when the CLI reports usage, but per-step on-wire payload breakdown is unavailable.',
                ...(typeof resolvedUsage?.cachedInputTokens === 'number' ||
                typeof resolvedUsage?.cacheCreationInputTokens === 'number'
                  ? [
                      'Claude prompt caching is active for this run. Input/Total include fresh input plus cache-read and cache-creation tokens.',
                    ]
                  : []),
              ]

          await executionViewerService.updateSnapshot(sessionId, messageId, withPriorRunAccounting({
            llmSummary: capture.llmSummary,
            llmCalls: capture.llmCalls,
            intermediateSteps: withPriorRunSteps(sanitizedToolSteps),
            delegated,
            responseSummary: {
              content: { value: finalContent, confidence: 'exact' },
              // BL-503 / BL-1361: this write is the CLI lanes' one evidence writer, and it also
              // runs for a run that failed, was stopped, or was ended by the context guard (each
              // adapter's `finally` makes the finish callback before the error reaches the catch).
              // Its counts are `exact` only when the CLI reported them (a Claude error `result` can),
              // else unknown.
              usage: buildTokenUsage(
                resolvedUsage ?? null,
                reportedUsageConfidence(resolvedUsage ?? null),
                responseUsageSource,
              ),
              toolCallsCount: buildTokenStat(
                intermediateSteps.length,
                intermediateSteps.length > 0 ? 'near' : 'exact',
                responseUsageSource,
              ),
              notes: responseNotes,
              ...(finishSummary.observedUsage ? { observedUsage: finishSummary.observedUsage } : {}),
            },
          }))

          // SA-093 P4 (managed CLI lanes): opt-in batshit-compiled-boundary
          // forensics. Uses the RAW compiled messages/images/tools — never the
          // log-sanitized copies above, whose lossy redaction could collapse
          // two different requests into one fingerprint.
          if (isCacheForensicsEnabled()) {
            const forensicRecord = buildCliCacheForensicsRecord({
              runtime: isCodexProvider ? 'codex' : 'claude',
              messages: Array.isArray(streamMessages) ? streamMessages : [],
              images: Array.isArray(streamImages)
                ? (streamImages as Array<{ url: string; alt?: string }>)
                : [],
              tools: preloadedGatewayTools ?? null,
              usage: resolvedUsage ?? null,
              agentId,
              connectionId: connection?.id ?? connection?.service ?? null,
              modelId: runtimeSnapshot.modelName ?? primaryModelId ?? null,
              messageId,
              experimentGroup: resolveCacheForensicsExperimentGroup(),
            })
            await attachCacheForensicsToSnapshot({
              sessionId,
              snapshotId: messageId,
              records: [forensicRecord],
            })
          }
        } else {
          // Claimed before anything here awaits: a failure path that runs while this callback
          // is still busy then writes no second set of calls (BL-245 review).
          const ownsLlmCapture = llmCaptureClaim.claim('finish')
          const sanitizedSteps = sanitizePayloadForLogs(
            Array.isArray(steps) ? steps : [],
          )
          const sanitizedToolSteps = sanitizePayloadForLogs(
            Array.isArray(intermediateSteps) ? intermediateSteps : [],
          )
          const capture = buildVercelLlmCapture({
            steps: sanitizedSteps as any[],
            totalUsage: resolvedUsage ?? null,
            finalText: typeof text === 'string' ? text : null,
            providerId: connection?.service ?? requestProviderId ?? null,
          })

          const toolCallsTotal = Array.isArray(steps)
            ? steps.reduce((sum: number, step: any) => {
                const count = Array.isArray(step?.toolCalls)
                  ? step.toolCalls.length
                  : 0
                return sum + count
              }, 0)
            : intermediateSteps.length

          await executionViewerService.updateSnapshot(sessionId, messageId, withPriorRunAccounting({
            ...(ownsLlmCapture
              ? {
                  llmSummary: capture.llmSummary,
                  llmCalls: capture.llmCalls,
                  intermediateSteps: withPriorRunSteps(sanitizedToolSteps),
                }
              : {}),
            delegated,
            responseSummary: {
              content: { value: finalContent, confidence: 'exact' },
              usage: buildTokenUsage(
                resolvedUsage ?? null,
                'exact',
                'provider',
              ),
              toolCallsCount: buildTokenStat(
                toolCallsTotal,
                'exact',
                'vercel ai sdk',
              ),
            },
          }))

          // SA-093 P4 (`API` lane): opt-in provider-request forensics. Uses the
          // RAW steps (never log-sanitized copies — redaction is lossy and
          // could collapse two different requests into one fingerprint).
          if (isCacheForensicsEnabled()) {
            const forensicRecords = buildApiCacheForensicsRecords({
              steps: Array.isArray(steps) ? steps : [],
              agentId,
              connectionId: connection?.id ?? connection?.service ?? null,
              providerId: connection?.service ?? requestProviderId ?? null,
              modelId: primaryModelId ?? null,
              messageId,
              experimentGroup: resolveCacheForensicsExperimentGroup(),
            })
            await attachCacheForensicsToSnapshot({
              sessionId,
              snapshotId: messageId,
              records: forensicRecords,
            })
          }
        }
      } catch (viewerPatchError) {
        console.error(
          '[Send-Routed] Failed to enrich execution snapshot with LLM payload details:',
          viewerPatchError,
        )
      }
    },
    onAbort: ({ steps }) => {
      logger.debug('[Send-Routed] Stream aborted', {
        sessionId,
        messageId,
        stepsCompleted: steps?.length || 0,
      })
      // The SDK never calls `onFinish` after an abort, and it calls this BEFORE the loop reads
      // the abort part (pinned in `aiSdkBaseline.contract.test.ts`). Release the loop's wait for
      // `onFinish`: it held every stopped API reply for its full 2 s (2026-09-18, Stop to `end`
      // measured 2.06 s). Not `onFinishResolved`: `onFinish` did not run.
      resolveOnFinish?.()
    },
    }
  }

  const primaryConnection = primarySelection.connection
  const primaryModelId = isCodexProvider
    ? 'codex/codex-cli'
    : isClaudeProvider
      ? 'claude/claude-cli'
      : effectiveModelId || 'claude-3-5-sonnet-20241022'
  // SA-102 P1 (DL-102-01): the agent-level primary_model_*
  // values are NOT applied a second time here. They already reach the request
  // as `fallbacks` on buildRuntimeModelSettings above, which is the one place
  // that also honours parameter suppression and the context-window clamp.

  const clippedItemsForImages =
    formattedInput.structuredInput?.clippedItems ?? []
  const primaryResolvedForImages = resolveModelIds({
    developerId: primarySelection.provider,
    modelId: primarySelection.modelId,
    effectiveModelId: primarySelection.effectiveModelId,
    connection: primaryConnection,
  })
  const primaryProviderIdForImages =
    primaryResolvedForImages?.providerId ??
    providerIdentifier ??
    primaryConnection?.service ??
    null
  const needsLocalImageConfig = isLocalProviderId(primaryProviderIdForImages)
  const localServerConfigs = needsLocalImageConfig ? await loadLocalAiServersOnce() : null
  const primaryImageConfig = await resolveImageTransportConfig({
    userId,
    providerId: primaryProviderIdForImages,
    presetId: primaryPresetId,
    localServers: localServerConfigs,
  })

  // SA-113 P1 / AMD-113-02 — the setup window.
  //
  // Everything above this point is setup: the compile, the model presets, the bridge
  // import, the Execution Viewer snapshot. On a large prompt that is 3–6 seconds on the
  // API lane and 5–9 on Codex, and until now nothing looked at the abort signal during
  // it. `registerStreamAbort` had not run yet, so a Stop landing in that window reached
  // the interrupt route, found only the session-turn lock, answered `stale_turn_cleared`,
  // and the run carried on to a full answer (P0 spike #7 and #8).
  //
  // Checking here is the last moment before this turn's real side effects — clip
  // consumption and the memory linger commit — so a stopped turn does not spend the
  // user's clips or advance memory state for work it will never do. Everything below is
  // covered by the existing abort handling, because the provider call receives
  // `streamAbortSignal`.
  //
  // This is not wake-specific: a browser Stop during setup hit the same gap.
  // Read through a local so TypeScript does not narrow `streamAbortSignal.aborted` to
  // `false` for the rest of the function; it is a live signal that can flip at any await.
  const abortedDuringSetup = Boolean(streamAbortSignal.aborted)
  if (abortedDuringSetup) {
    const interruptedAt = new Date().toISOString()

    try {
      // No `ensureStartEmitted` here on purpose: nothing has streamed yet at this point,
      // so there is no partial start to close.
      finishSummary.metadata = {
        ...(finishSummary.metadata ?? {}),
        model: effectiveModelId ?? primarySelection.modelId,
        agentType: primaryAgentType,
        interrupted: true,
        interruptionReason: resolveInterruptionReason(),
        interruptedAt,
        interruptedDuringSetup: true,
        ...(stoppedForDeletedChat() ? { chatDeleted: true } : {}),
      }
      // BL-775: the same Stop save as mid-reply (one retry, then `error` in plain words); the
      // reply ends with `complete` only after it was saved, or when its chat was deleted.
      const stoppedReplySaved = await finalizeStoppedReply('Failed to finalize a turn interrupted during setup')
      if (stoppedReplySaved || stoppedForDeletedChat()) {
        await streamAdapter.emitComplete({
          metadata: {
            interrupted: true,
            interruptedAt,
            ...(stoppedForDeletedChat() ? { chatDeleted: true } : {}),
          },
        })
      }
    } catch (setupAbortError) {
      console.error(
        '[Send-Routed] Failed to finalize a turn interrupted during setup:',
        setupAbortError,
      )
    }

    await persistRuntimeSnapshot('failed', describeInterruption())

    return {
      response: json(
        {
          error: describeInterruption(),
          ...(stoppedForDeletedChat() ? { code: 'session_deleted' } : {}),
        },
        { status: 499 },
      ),
      messageId,
      content: '',
      metadata: finishSummary.metadata ?? {},
      usage: undefined,
    }
  }

  let streamResult: any

  /**
   * SA-114 P2 (DL-114-09) — decide once, here, what this run can do about a mid-reply
   * message. The run registry carries the verdict from here and the steer route reads it.
   *
   * Resolved ABOVE the once-per-accepted-send boundary on purpose: clip consumption and the
   * memory linger commit are this turn's real side effects (DL-114-02), and nothing about
   * steering may sit between them and `registerStreamAbort`. It is a pure function of
   * things already resolved, so it costs nothing to do it early.
   *
   * This is the only place that knows all three inputs: the primary agent type, whether
   * this is a group member's run, and — for a `cli` primary — which transport lane the
   * bridge is about to take. `resolveCodexTransportLane` is the SAME function
   * `CodexBridge.createRunner` calls moments later with the same `configScope`, which is
   * what makes the promise the route gives the user and the channel the bridge actually
   * opens one decision rather than two that can drift.
   */
  const steerVerdict = resolveSteerability({
    primaryAgentType,
    isGroupSession: Boolean(groupContext) || streamMetadata?.groupChat === true,
    cli: isCliProvider
      ? {
          provider: isCodexProvider ? 'codex' : isClaudeProvider ? 'claude' : null,
          configScope:
            codexRuntimeSettings?.configScope ?? claudeRuntimeSettings?.configScope ?? null,
          codexTransport: isCodexProvider
            ? resolveCodexTransportLane(
                { configScope: codexRuntimeSettings?.configScope ?? null },
                process.env,
              )
            : null,
        }
      : null,
  })

  // BL-600: the round's first member to get here records the Clips its compile read; the round
  // spends them once, when it ends, so every speaker of the round compiles with a one-time Clip,
  // and a Clip attached for the next message during the round is left for it. Nothing
  // else of a new user message runs for a member: it has `consumeSessionClips: false`, so the
  // block below (the hold count, the memory commit) is skipped, and a group turn builds no Judge
  // Juice lane to commit; the round counted the hold at its start.
  if (groupRoundClipSpend) {
    await groupRoundClipSpend.noteCompiled()
  }

  // BL-330: an approval resume continues a turn that already paid its clip countdown, so it
  // never ticks it again; a one-time clip attached while the card waited belongs to the user's
  // next message.
  if (consumeSessionClips && !isApprovalResumeWithoutUserTurn) {
    // BL-505 (C1, C3): a woken turn read the chat's Clips like every turn (the compile is not
    // changed) and leaves their countdowns to the user's next message.
    if (!isWokenTurnRun) {
      await consumePostCompileSessionClips(sessionId)
    }

    // SA-129 P2 (DL-08): the user's message counts toward every temporary hold's countdown here,
    // once per accepted send, whether or not a chat page is open (BL-234); the page no longer
    // counts. BEFORE Judge Juice's opens below, which start their own count at zero.
    if (countsNewUserMessage) {
      const countdown = await advanceZipCountdowns(sessionId)
      if (countdown.counted.length > 0 || countdown.ended.length > 0) {
        await publishUserEvent(userId, {
          type: 'zip_state_changed',
          sessionId,
          source: 'countdown',
          opened: [],
          rezipped: [],
        })
      }
    }

    // SA-104 P4: the memory linger commit rides the same accepted-send boundary as
    // clip consumption and the same continuation flag (no double-tick on
    // context-exhaustion auto-continues). Approval resumes and continuation runs have
    // no NEW user turn (`messageForCompilation`; a resume recompiles the paused turn's
    // message, BL-322), so they commit nothing; group member sends
    // arrive with consumeSessionClips=false and group recall stays inert in v1.
    // Failures propagate loudly, exactly like clip consumption above.
    if (messageForCompilation && !groupContext) {
      // SA-104 P5: an Infinite (fixed) session keeps one open episode while it is
      // lived in; the accepted send opens it lazily (regular sessions return null
      // untouched). Episode upkeep runs BEFORE the commit so 'episode' linger holds
      // bind to the episode this send belongs to (2026-08-28).
      await ensureFixedSessionOpenEpisode({
        session: sessionRecord,
        sessionId,
        agentId,
      })
      memoryTurnCommit = await commitMemoryTurnState({
        userId,
        agentId,
        sessionId,
        currentUserMessage: messageForCompilation,
        // SA-120 P4b: the compile's own Judge Juice answer, never a second call.
        inferredRecalls: jevJuiceMemoryRecall?.getRecalls(),
      })
    }
  }

  // BL-527: the Judge Juice lanes' writes ride the same accepted-send boundary, for every run whose
  // compile ran them: a new user turn above, and also a managed CLI control-approval resume. That
  // resume is a NEW turn (its user message is the approval) that spends no clip, countdown, or
  // memory commit (`consumeSessionClips` is false, DL-116-08), but its compile opened what Jev
  // chose and told the agent its notes, so the state must match the prompt. An API approval resume
  // and a context continuation built no lane (`messageForCompilation` is empty).
  //
  // SA-120 P5: the zip state the compile used becomes real here and nowhere earlier, on the
  // same accepted-send boundary (a send that never reached it opened nothing). Each write
  // re-reads the state it would replace, so a user or agent action that landed since the
  // compile still wins. What was stored rides the reply's metadata so the tab re-reads zip
  // state; the notice about Batshit's earlier rezips is marked as told. AFTER the countdown
  // above, so its opens start their own count at zero.
  if (jevJuiceSmartZip && messageForCompilation && !groupContext) {
    const opens = jevJuiceSmartZip.getOpens()
    if (opens.length > 0) {
      const stored = await writeInferredUnzips(
        sessionId,
        opens.map((open) => ({
          zipId: open.zipId,
          description: open.description,
          tokens: open.tokens,
          probability: open.probability,
          durationMessages: open.durationMessages,
        })),
      )
      jevJuiceTurn.zips.opened.push(
        ...opens
          .filter((open) => stored.includes(open.zipId))
          .map((open) => ({ zipId: open.zipId, probability: open.probability })),
      )
      // Every tab showing this chat re-reads zip state now, while the reply streams, so the
      // badge shows the Judge Juice mark at once (the reply's metadata is the second trigger).
      if (stored.length > 0) {
        await publishUserEvent(userId, {
          type: 'zip_state_changed',
          sessionId,
          source: 'inferred',
          opened: stored,
          rezipped: [],
        })
      }
    }
    const told = jevJuiceSmartZip.getToldRezipIds()
    if (told.length > 0) await markInferredRezipsTold(sessionId, told)
  }

  // SA-120 P6: the notes about the previous reply were in this send's prompt, and the send was
  // accepted, so they are marked as told here and nowhere earlier (one turn, like
  // `control_errors`; a send that never reached this boundary told nobody).
  if (jevJuicePostTurnCheck && messageForCompilation && !groupContext) {
    const toldMessageId = jevJuicePostTurnCheck.getToldMessageId()
    if (toldMessageId) await markPostTurnRecordTold(sessionId, toldMessageId)
  }

  registerStreamAbort(sessionId, messageId, streamAbortController)

  // SA-114 P2 (DL-114-09): the verdict lands in the steer registry, not on the stream-abort
  // entry — the interrupt path and its registry stay byte-identical through this story
  // (DL-114-15), and DL-114-02 already made "steering gets its own map" the rule.
  registerSteerRun(sessionId, {
    messageId,
    steerable: steerVerdict.steerable,
    reason: steerVerdict.steerable ? null : steerVerdict.reason,
    lane: steerVerdict.steerable ? steerVerdict.lane : null,
  })
  steerRunRegistered = true

  /**
   * A normal API reply can wait for its first visible event before opening the message. An
   * approval resume cannot: it reuses a completed message id, and the provider may spend a long
   * time inside the approved tool before producing another chunk. Open that continuation as soon
   * as its abort/steer run is registered so a joining tab gets the replayed start and Stop state.
   *
   * Build the payload at emission time. Ordinary turns still emit after provider setup; only the
   * in-place, non-group resume takes the early path below.
   */
  let startEmitted = false
  ensureStartEmitted = async () => {
    if (startEmitted) return
    await streamAdapter.emitStart({
      messageId,
      metadata: {
        ...(approvalResumeStart ? { approvalResume: approvalResumeStart } : {}),
        model: primaryModelId,
        selectedTools,
        selectedGateways,
        // SA-114 P2 (DL-114-09): every tab watching this chat learns whether the reply it
        // is looking at can be steered, and why not when it cannot. It rides the session
        // channel's replay buffer, so a tab opened mid-reply gets it too. The steer route
        // is still the backstop — a tab that guessed wrong is refused with this same
        // reason and falls back to an interrupt (DL-114-14).
        steerable: steerVerdict.steerable,
        steerReason: steerVerdict.steerable ? null : steerVerdict.reason,
        steerLane: steerVerdict.steerable ? steerVerdict.lane : null,
      },
    })
    startEmitted = true
  }

  const closeStartedAcquisitionFailure = async (error: unknown) => {
    if (!startEmitted) return
    const interrupted = isStopError(error, [streamAbortSignal, request.signal])
    if (interrupted) {
      const interruptedAt = new Date().toISOString()
      finishSummary.metadata = {
        ...(finishSummary.metadata ?? {}),
        model: effectiveModelId ?? primarySelection.modelId,
        agentType: primaryAgentType,
        interrupted: true,
        interruptionReason: resolveInterruptionReason(),
        interruptedAt,
        ...(stoppedForDeletedChat() ? { chatDeleted: true } : {}),
      }
      // This is the setup-abort rule after a resume start has opened: persist the Stop before
      // complete. The in-place finalizer composes the frozen pre-card prefix and stamps the
      // resume version, while the POST catch recognizes AbortError and writes no false failure.
      if (!(await finalizeStoppedReply('Failed to finalize a stopped early approval resume')) && !stoppedForDeletedChat()) {
        // The tabs were told the reply could not be saved (`error`, a terminal event).
        return
      }
      try {
        await streamAdapter.emitComplete({
          metadata: {
            interrupted: true,
            interruptionReason: resolveInterruptionReason(),
            interruptedAt,
            ...(stoppedForDeletedChat() ? { chatDeleted: true } : {}),
            ...(approvalResumeStart ? { approvalResumeVersion: approvalResumeStart.version } : {}),
          },
        })
      } catch (emitCompleteError) {
        console.error(
          '[Send-Routed] Failed to close a stopped early approval-resume start:',
          emitCompleteError,
        )
      }
      return
    }

    const rawMessage = getFailureMessage(error)
    const safeMessage =
      redactDataImageUrlsInText(rawMessage).value ||
      'The response failed before provider streaming started.'
    const failureMetadata = {
      response_failed: true,
      ...(approvalResumeStart ? { approvalResumeVersion: approvalResumeStart.version } : {}),
    }

    // BL-775: saved first, then the tabs are told, so a tab that reads the chat on `error` finds
    // the failed record. The POST's catch then leaves this failure alone (`failuresSavedBeforeThrow`).
    // A real failure uses terminal error cleanup; an expected Stop above uses complete so it never
    // draws a false provider-error banner.
    await persistFailedAssistantTurn({
      sessionId,
      userId,
      agentId,
      messageId,
      message: rawMessage,
      details:
        error instanceof Error ? error.stack || error.message : String(error ?? ''),
      code: getFailureCode(error),
      status: getFailureStatus(error),
      metadata: { agentType: primaryAgentType, ...failureMetadata,
        ...(streamMetadata?.steerPromoted ? { steerPromoted: streamMetadata.steerPromoted } : {}) },
      inPlaceResume: isApprovalResumeWithoutUserTurn,
      replyEndPrior: approvalResumePrior,
      imageOriginVersion,
      // Reconcile every tab, including one that missed the early start.
      noStreamEvent: true,
      model: effectiveModelId ?? primarySelection.modelId,
      provider: providerIdentifier || primarySelection.provider,
    })
    if (error && typeof error === 'object') failuresSavedBeforeThrow.add(error)
    try {
      await streamAdapter.emitError({
        error: safeMessage,
        metadata: failureMetadata,
      })
    } catch (emitError) {
      console.error(
        '[Send-Routed] Failed to close an early approval-resume start with an error event:',
        emitError,
      )
    }
  }

  const preserveAcquisitionFailureVersion = (error: unknown): unknown =>
    approvalResumeStart
      ? new ApprovalResumeAcquisitionError(error, approvalResumeStart.version)
      : error

  // SA-114 P2 (DL-114-09) — the same verdict on the USER channel, for a turn Batshit started
  // on its own. `requestAgentWakeup` publishes `running` before this request even begins, so
  // it cannot know the transport; this second publish carries it once the run is registered.
  // A chat the user has open learns it from the `start` event instead — the sidebar's copy
  // is what lets a tab that was not watching this chat still label its send button correctly.
  const wakeRunForStatus = getWakeRun(sessionId)
  if (wakeRunForStatus) {
    try {
      await publishUserEvent(wakeRunForStatus.userId, {
        type: 'session_run_status',
        sessionId,
        // F-P3-2: the assistant message this reply is writing. A tab that did not start
        // the reply otherwise learns it only from the `start` event, which the API lane
        // sends with its first chunk — seconds after a steer could already be accepted.
        messageId,
        status: 'running',
        owner: 'server',
        origin: wakeRunForStatus.origin,
        steerable: steerVerdict.steerable,
        steerReason: steerVerdict.steerable ? null : steerVerdict.reason,
      })
    } catch (error) {
      // A live-update channel must never fail the turn it is reporting.
      console.warn('[SA-114] Could not publish steerability for a woken turn:', error)
    }
  }

  try {
    if (
      approvalResumeStart &&
      !groupContext &&
      streamMetadata?.groupChat !== true
    ) {
      await ensureStartEmitted()
    }

    const primaryImagePayload = await applyImageTransportOverrides({
      messages: compiledMessages,
      images,
      clippedItems: clippedItemsForImages,
      transport: primaryImageConfig.transport,
      imageBaseUrl: primaryImageConfig.imageBaseUrl,
      preferRemoteUrl: !isLocalProviderId(primaryProviderIdForImages),
    })
    resetMeasuredStreamTiming()
    streamResult = await nativeRuntime.streamNativeMode(
      buildStreamRequest(
        primaryModelId,
        primaryConnection,
        primaryProviderId ?? null,
        runtimeSettings,
        providerSpecificSettings ?? null,
        primaryCapabilities,
        primaryToolsEnabled,
        primaryImagePayload.messages,
        primaryImagePayload.images,
      ),
    )
  } catch (primaryError) {
    const terminalError = preserveAcquisitionFailureVersion(primaryError)
    await closeStartedAcquisitionFailure(terminalError)
    clearStreamAbort(sessionId, messageId)
    throw terminalError
  }

  try {
    const result = streamResult
    const runtimeInfo = (result as any).__runtimeInfo
    if (runtimeInfo && typeof runtimeInfo === 'object') {
      runtimeSnapshot.transport =
        runtimeInfo.transport ?? runtimeSnapshot.transport
      runtimeSnapshot.sandboxMode =
        runtimeInfo.sandboxMode ?? runtimeSnapshot.sandboxMode
      runtimeSnapshot.allowFileEdits =
        runtimeInfo.allowFileEdits ?? runtimeSnapshot.allowFileEdits
      runtimeSnapshot.allowNetwork =
        runtimeInfo.allowNetwork ?? runtimeSnapshot.allowNetwork
      runtimeSnapshot.workingDirectory =
        runtimeInfo.workingDirectory ?? runtimeSnapshot.workingDirectory
      const runtimeInfoMetadata =
        runtimeInfo.metadata && typeof runtimeInfo.metadata === 'object'
          ? (runtimeInfo.metadata as Record<string, any>)
          : null
      if (runtimeInfoMetadata) {
        runtimeSnapshot.metadata = {
          ...(runtimeSnapshot.metadata ?? {}),
          ...runtimeInfoMetadata,
        }
      }
      runtimeSnapshot.providerId =
        runtimeInfo.providerId ?? runtimeSnapshot.providerId
      runtimeSnapshot.connectionId =
        runtimeInfo.connectionId ?? runtimeSnapshot.connectionId
      runtimeSnapshot.modelName =
        runtimeInfo.modelName ?? runtimeSnapshot.modelName
    } else if (
      (isCodexProvider || isClaudeProvider) &&
      (result as any).__transport &&
      !runtimeSnapshot.transport
    ) {
      const transportHint = (result as any).__transport
      if (isCodexProvider) {
        runtimeSnapshot.transport =
          transportHint === 'sdk'
            ? 'codex-sdk'
            : transportHint === 'app-server'
              ? 'codex-app-server'
              : transportHint === 'exec'
                ? 'codex-exec'
            : transportHint === 'cli'
              ? 'codex-cli'
              : 'unknown'
      } else if (isClaudeProvider) {
        runtimeSnapshot.transport =
          transportHint === 'sdk'
            ? 'claude-sdk'
            : transportHint === 'cli'
              ? 'claude-cli'
              : 'unknown'
      }
    }

    try {
      await executionViewerService.updateSnapshot(sessionId, messageId, {
        runtime: runtimeSnapshot,
      })
    } catch (runtimePatchError) {
      console.error(
        '[Send-Routed] Failed to persist resolved runtime details before streaming:',
        runtimePatchError,
      )
    }

    if (Array.isArray((result as any).__rawEvents)) {
      runtimeEventLogBuffer = (result as any).__rawEvents
    }
    if (Array.isArray((result as any).__helperDelegatedSteps)) {
      helperDelegatedSteps = (result as any).__helperDelegatedSteps
    }

    /**
     * SA-114 P2 (DL-114-06, DL-114-08) — the managed CLI steer channel, if this run has one.
     *
     * Registered HERE and nowhere earlier, because the child process only exists once
     * `streamNativeMode` has resolved. The API lane never sets `__steer`: its hook pulls at
     * the next step instead, so the steer route finds no transport and simply leaves the
     * entry waiting. A Codex run on the `exec` lane sets none either, which is the same
     * refusal `steerVerdict` already gave the user before they could try.
     */
    const steerChannel = (result as any).__steer
    const steerChannelLane = (result as any).__steerLane as SteerLane | null | undefined
    if (
      steerDeliveryEnabled &&
      steerVerdict.steerable &&
      typeof steerChannel === 'function' &&
      (steerChannelLane === 'codex' || steerChannelLane === 'claude')
    ) {
      attachSteerTransport(sessionId, messageId, steerChannelLane, async (payload) => {
        const answer = await steerChannel(payload)
        // Codex answers `{accepted}`; Claude answers a boolean write result. Both mean the
        // same thing here: did the transport TAKE it. Delivery is the echo, which arrives
        // later as a synthetic `steer` chunk in this same stream.
        return typeof answer === 'boolean' ? answer : Boolean(answer?.accepted)
      })
    }

    detectToolSource =
      typeof (result as any).__detectToolSource === 'function'
        ? (result as any).__detectToolSource
        : (_toolName: string) => ({
            toolProvider: 'unknown',
            toolSource: 'unknown',
          })

    controlsEnabled = streamMetadata?.groupChat === true
    controlsResolved = !controlsEnabled
    controlsMode = 'responding'
    controlsPayload = null
    controlsBuffer = new SegmentedText()
    pendingControlPieces = []
    controlsResolvedBySegment = null
    silentResponse = false

    // Codex CLI can take a while before the first chunk; show a UI-only
    // indicator until real reasoning/text/tool events arrive.
    if (isCodexProvider) {
      await ensureStartEmitted()
      await emitThinkingIndicator()
    }

    /**
     * BL-759: what follows the leading control block is the end of the buffer, so each piece keeps
     * its segment and a later retract can still take it back.
     */
    const takeBufferedControlPieces = (rest: string) => {
      const pieces = controlsBuffer.piecesOfSuffix(rest)
      controlsBuffer = new SegmentedText()
      if (pieces) return pieces
      // The parser only cuts the buffer's start; a rest that is not its end is a parser change this
      // code does not know. The words are kept, with no segment, and it is said.
      console.error('[Send-Routed] BL-759: the group control buffer handed on words that are not its end; they keep no segment', {
        sessionId,
        messageId,
      })
      return rest ? [{ segmentId: null, text: rest }] : []
    }

    const resolveControlsFromBuffer = () => {
      if (controlsResolved) return

      const result = parseLeadingGroupControlFromBuffer(controlsBuffer.toString())
      if (result.kind === 'pending') {
        return
      }

      if (result.kind === 'passthrough') {
        controlsResolved = true
        pendingControlPieces = takeBufferedControlPieces(result.content)
        return
      }

      controlsPayload = result.payload
      controlsMode = result.mode
      controlsResolved = true
      pendingControlPieces = takeBufferedControlPieces(result.remaining)
    }

    const stripRepeatedLeadingGroupControls = (content: string) => {
      if (!controlsEnabled || !controlsResolved || !content) return content
      return stripRepeatedLeadingGroupControlBlocks(content)
    }

    shouldBreakStream = false
    for await (const chunk of result.stream) {
      // SA-114 P1 (DL-114-04): anything the transport handed to the model since the last
      // chunk is written into the transcript HERE, before this chunk is processed — which
      // is what places the marker after the tool results that preceded delivery and before
      // the text that answers them. The drain itself only releases a steer once this loop
      // has consumed the `finish-step` of the step it was read after (F-P1-3), because the
      // SDK runs AHEAD of this loop: with two parallel tool calls in one step,
      // `prepareStep` delivered the steer while the loop was still between that step's two
      // `tool-result` chunks (measured live on BSMS, 2026-09-10), and a fast tool can put it
      // even earlier. Counting consumed steps is what makes the position deterministic.
      await drainSteersIntoTranscript()
      streamStepRecorder.observe(chunk)
      switch (chunk.type) {
        case 'text-delta': {
          if ((chunk as any).text) markMeasuredFirstOutput()
          const textChunk = stripRepeatedLeadingGroupControls((chunk as any).text || '')
          // BL-759: a managed lane names the segment (the vendor message) of each text chunk.
          const textSegmentId =
            typeof (chunk as any).segmentId === 'string' && (chunk as any).segmentId
              ? ((chunk as any).segmentId as string)
              : null
          if (textChunk) {
            await flushRawReasoningFallback()
            if (controlsEnabled && !controlsResolved) {
              controlsBuffer.append(textChunk, textSegmentId)
              resolveControlsFromBuffer()
              if (!controlsResolved) {
                break
              }
              controlsResolvedBySegment = textSegmentId

              if (controlsMode === 'listening') {
                silentResponse = true
                shouldBreakStream = true
                break
              }

              if (pendingControlPieces.length > 0) {
                await ensureReasoningSegmentBoundary()
                await flushPendingControlText()
              }
              break
            }

            await ensureReasoningSegmentBoundary()
            await emitTextChunk(textChunk, { segmentId: textSegmentId })
          }
          break
        }
        case 'text-retract': {
          // BL-759: a managed lane took back a message its vendor never finished and started
          // again (Codex's app-server lane after a dropped response stream; the adapter hands the
          // retract on right before the new attempt writes anything). Its words leave this
          // request's own copy and the group control buffer, and `/api/sse` takes them out of the
          // reply's record and tells every tab (`content_reset`). A forward that fails, or one that
          // `/api/sse` answers without success (it could not take the words back exactly), makes
          // the reply a gap: the finalize then saves this copy, already without them.
          const retractedSegmentId =
            typeof (chunk as any).segmentId === 'string' ? ((chunk as any).segmentId as string) : ''
          if (!retractedSegmentId) break
          const removedText = streamedReply.retract(retractedSegmentId)
          controlsBuffer.retract(retractedSegmentId)
          pendingControlPieces = pendingControlPieces.filter(
            (piece) => piece.segmentId !== retractedSegmentId,
          )
          if (controlsEnabled && controlsResolved && controlsResolvedBySegment === retractedSegmentId) {
            // The words taken back decided the group control; the retried answer starts with its
            // own leading block, which must be read again (a `listening` retry stays silent), not
            // streamed as text.
            controlsResolved = false
            controlsMode = 'responding'
            controlsPayload = null
            controlsBuffer = new SegmentedText()
            controlsResolvedBySegment = null
          }
          // Words still held for the group control were never shown: nothing to take back live.
          if (!removedText) break
          answerRestartedAfterLostConnection = true
          await streamAdapter.emitTextRetract({
            segmentId: retractedSegmentId,
            metadata: {
              reason: typeof (chunk as any).reason === 'string' ? (chunk as any).reason : 'retry',
              message: typeof (chunk as any).message === 'string' ? (chunk as any).message : null,
              program: restartedAnswerProgram,
            },
          })
          break
        }
        case 'reasoning': {
          // OpenAI reasoning summaries stream via `part.type === 'reasoning'`
          // with `textDelta` (Vercel AI SDK).
          markMeasuredFirstOutput()
          const handledAsIndicator = await handleReasoningIndicator()
          const delta =
            (chunk as any).textDelta ??
            (chunk as any).text ??
            (chunk as any).delta ??
            (chunk as any).content ??
            ''
          if (handledAsIndicator) {
            if (typeof delta === 'string' && delta) {
              reasoningStreamSource.noteNormalizedReasoning()
              await appendReasoningDelta(delta)
            }
            break
          }
          if (controlsMode === 'listening') {
            silentResponse = true
            shouldBreakStream = true
            break
          }
          await flushPendingControlText()
          await ensureStartEmitted()
          if (typeof delta === 'string' && delta) {
            reasoningStreamSource.noteNormalizedReasoning()
            await appendReasoningDelta(delta)
          }
          break
        }
        case 'reasoning-start':
        case 'reasoning_start': {
          markMeasuredFirstOutput()
          const initial = (chunk as any).text || (chunk as any).content || ''
          const handledAsIndicator = await handleReasoningIndicator()
          if (handledAsIndicator) {
            await startReasoningSegment(typeof initial === 'string' ? initial : '')
            break
          }
          if (controlsMode === 'listening') {
            silentResponse = true
            shouldBreakStream = true
            break
          }
          await flushPendingControlText()
          await ensureStartEmitted()
          await startReasoningSegment(typeof initial === 'string' ? initial : '')
          break
        }
        case 'reasoning-delta':
        case 'reasoning_delta': {
          const delta =
            (chunk as any).text ??
            (chunk as any).delta ??
            (chunk as any).content ??
            ''
          const handledAsIndicator = await handleReasoningIndicator()
          if (handledAsIndicator) {
            if (typeof delta === 'string' && delta) {
              reasoningStreamSource.noteNormalizedReasoning()
              await appendReasoningDelta(delta)
            }
            break
          }
          if (controlsMode === 'listening') {
            silentResponse = true
            shouldBreakStream = true
            break
          }
          await flushPendingControlText()
          await ensureStartEmitted()
          if (typeof delta === 'string' && delta) {
            reasoningStreamSource.noteNormalizedReasoning()
            await appendReasoningDelta(delta)
          }
          break
        }
        case 'reasoning-end':
        case 'reasoning_end': {
          reasoningStreamSource.noteNormalizedReasoning()
          reasoningActive = false
          break
        }
        case 'thinking': {
          const thinkingChunk = chunk as any
          const content =
            typeof thinkingChunk?.content === 'string' ? thinkingChunk.content : ''
          const handledAsIndicator = await handleReasoningIndicator()
          if (handledAsIndicator) {
            await replaceReasoningSnapshot(content, Boolean(thinkingChunk?.final))
            break
          }
          if (controlsMode === 'listening') {
            silentResponse = true
            shouldBreakStream = true
            break
          }
          await flushPendingControlText()
          await ensureStartEmitted()
          if (!content) break

          // Codex emits full reasoning content on each update. Stream as replace events.
          await replaceReasoningSnapshot(content, Boolean(thinkingChunk?.final))
          break
        }
        case 'tool-call': {
          await flushRawReasoningFallback()
          // BL-1358: a Codex plan is shown, so it is output, but it is not a tool window. Its call
          // comes when the plan starts and its results at each update, while real tool calls run
          // in between, so counting it opened and closed real calls' windows.
          if (isPlanUpdateTool((chunk as any).toolName)) markMeasuredFirstOutput()
          else markMeasuredToolCallStart()
          if (controlsMode === 'listening') {
            silentResponse = true
            shouldBreakStream = true
            break
          }
          await flushPendingControlText()
          await ensureStartEmitted()
          await ensureReasoningSegmentBoundary()
          const toolCall = chunk as any
          const rawArgs = toolCall.input ?? toolCall.args ?? {}
          const args = normalizeToolArgs(rawArgs)
          const nativeBashMapping = resolveNativeBashMapping({
            toolName: toolCall.toolName,
            args,
          })
          const emittedToolName =
            nativeBashMapping?.mappedToolName ??
            toolCall.toolName ??
            'unknown_tool'
          const emittedArgs = nativeBashMapping?.mappedArgs ?? args
          const resolvedToolCallId =
            resolveToolCallIdFromEvent(toolCall) ||
            `tool_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`
          if (isPlanUpdateTool(toolCall.toolName)) {
            await emitPlanUpdate(rawArgs)
            break
          }
          if (isImageToolName(toolCall.toolName)) {
            logger.debug('[Send-Routed] Image tool call', {
              sessionId,
              messageId,
              toolName: toolCall.toolName,
              toolCallId: toolCall.toolCallId,
              tool_call_id: toolCall.tool_call_id,
              callId: toolCall.callId,
              id: toolCall.id,
              resolvedToolCallId,
            })
          }
          if (typeof toolCall.toolName === 'string' && resolvedToolCallId) {
            toolCallIdByName.set(toolCall.toolName, resolvedToolCallId)
            if (typeof emittedToolName === 'string') {
              toolCallIdByName.set(emittedToolName, resolvedToolCallId)
            }
          }
          if (resolvedToolCallId) {
            reserveToolZipIdForCall({
              toolCallId: resolvedToolCallId,
              toolName: emittedToolName,
            })
            toolCallPayloadById.set(resolvedToolCallId, {
              toolName: toolCall.toolName ?? emittedToolName,
              input: emittedArgs,
              toolCall: {
                type: 'tool-call',
                toolCallId: resolvedToolCallId,
                toolName: toolCall.toolName ?? emittedToolName,
                input: emittedArgs,
              },
            })
          }
          await streamAdapter.emitToolStart({
            toolCallId: resolvedToolCallId,
            toolName: emittedToolName,
          })
          await streamAdapter.emitToolCall({
            toolCallId: resolvedToolCallId,
            toolName: emittedToolName,
            args: emittedArgs,
          })
          break
        }
        case 'tool-approval-request':
        case 'tool_approval_request': {
          if (controlsMode === 'listening') {
            silentResponse = true
            shouldBreakStream = true
            break
          }
          await flushPendingControlText()
          await ensureStartEmitted()
          await ensureReasoningSegmentBoundary()

          const approval = chunk as any
          const approvalId =
            typeof approval?.approvalId === 'string'
              ? approval.approvalId.trim()
              : typeof approval?.approval_id === 'string'
                ? approval.approval_id.trim()
                : ''
          if (!approvalId) {
            break
          }

          const resolvedToolCallId =
            resolveToolCallIdFromEvent(approval) ||
            (typeof approval?.toolCallId === 'string'
              ? approval.toolCallId
              : undefined) ||
            (typeof approval?.tool_call_id === 'string'
              ? approval.tool_call_id
              : undefined)
          const knownToolCall = resolvedToolCallId
            ? toolCallPayloadById.get(resolvedToolCallId)
            : undefined
          const toolName =
            (typeof approval?.toolName === 'string' &&
            approval.toolName.trim().length > 0
              ? approval.toolName.trim()
              : typeof approval?.tool_name === 'string' &&
                  approval.tool_name.trim().length > 0
                ? approval.tool_name.trim()
                : knownToolCall?.toolName) || undefined
          const input =
            approval?.input ??
            approval?.args ??
            approval?.parameters ??
            knownToolCall?.input
          const toolCall =
            approval?.toolCall ??
            approval?.tool_call ??
            knownToolCall?.toolCall ??
            (toolName
              ? {
                  type: 'tool-call',
                  ...(resolvedToolCallId
                    ? { toolCallId: resolvedToolCallId }
                    : {}),
                  toolName,
                  ...(input !== undefined ? { input } : {}),
                }
              : undefined)
          const requestedAt =
            typeof approval?.requestedAt === 'string' &&
            approval.requestedAt.trim().length > 0
              ? approval.requestedAt.trim()
              : new Date().toISOString()
          const requestedAtMs = parseTimestampMs(requestedAt)
          const expiresAt =
            typeof approval?.expiresAt === 'string' &&
            approval.expiresAt.trim().length > 0
              ? approval.expiresAt.trim()
              : new Date(
                  (requestedAtMs ?? Date.now()) + TOOL_APPROVAL_TIMEOUT_MS,
                ).toISOString()

          await streamAdapter.emitToolApprovalRequest({
            approvalId,
            toolCallId: resolvedToolCallId,
            toolName,
            input,
            toolCall,
            requestedAt,
            expiresAt,
            source: 'vercel',
          })

          streamedApprovalRequests.set(approvalId, {
            approvalId,
            status: 'pending',
            requestedAt,
            expiresAt,
            ...(toolName ? { toolName } : {}),
            ...(toolCall && typeof toolCall === 'object' ? { toolCall } : {}),
            ...(input !== undefined ? { input } : {}),
            source: 'vercel',
          })
          break
        }
        // BL-450: a failed call (a schema-refused call, a missing tool, a thrown `execute`)
        // arrives as a `tool-error` and never as a `tool-result`. It goes through the same
        // path as a failed result, so its card closes, the page lets later words through,
        // and the call gets its zip, step, and Execution Viewer row saying why it failed.
        case 'tool-error':
        case 'tool-result': {
          // BL-1358: a plan result closes no window (see the `tool-call` case).
          if (!isPlanUpdateTool((chunk as any).toolName)) markMeasuredToolCallEnd()
          if (controlsMode === 'listening') {
            silentResponse = true
            shouldBreakStream = true
            break
          }
          await flushPendingControlText()
          await ensureStartEmitted()
          await ensureReasoningSegmentBoundary()
          const toolResult =
            chunk.type === 'tool-error'
              ? toolErrorAsFailedToolResult(chunk as any)
              : (chunk as any)
          if (toolResult?.dynamic) {
            if (isImageToolName(toolResult.toolName)) {
              logger.debug('[Send-Routed] Image tool-result skipped (dynamic)', {
                sessionId,
                messageId,
                toolName: toolResult.toolName,
                toolCallId: toolResult.toolCallId,
              })
            }
            break
          }
          const rawArgs = toolResult.input ?? toolResult.args ?? {}
          const args = normalizeToolArgs(rawArgs)
          if (isPlanUpdateTool(toolResult.toolName)) {
            if (chunk.type === 'tool-error') break
            const planPayload =
              toolResult.output ??
              toolResult.result ??
              toolResult.data ??
              toolResult.content ??
              toolResult.items ??
              rawArgs ??
              args
            await emitPlanUpdate(planPayload)
            break
          }
          let resultPayload = normalizeToolResult(
            toolResult.output ??
              toolResult.result ??
              toolResult.data ??
              toolResult.content,
            toolResult.toolName,
            args,
          )
          const nativeBashMapping = resolveNativeBashMapping({
            toolName: toolResult.toolName,
            args,
            result: resultPayload,
          })
          const emittedToolName =
            nativeBashMapping?.mappedToolName ??
            toolResult.toolName ??
            'unknown_tool'
          const emittedArgs = nativeBashMapping?.mappedArgs ?? args
          if (
            nativeBashMapping &&
            resultPayload &&
            typeof resultPayload === 'object' &&
            !Array.isArray(resultPayload)
          ) {
            resultPayload = {
              ...resultPayload,
              originalToolName: toolResult.toolName,
              mappedToolName: nativeBashMapping.mappedToolName,
              mappedReason: nativeBashMapping.reason,
            }
          }
          const rawToolCallId =
            resolveToolCallIdFromEvent(toolResult) ||
            (typeof toolResult.toolName === 'string'
              ? toolCallIdByName.get(toolResult.toolName) ||
                (typeof emittedToolName === 'string'
                  ? toolCallIdByName.get(emittedToolName)
                  : undefined)
              : undefined)
          const fallbackToolCallId =
            rawToolCallId ||
            `tool_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`

          /**
           * SA-116 DL-116-07 — a control pause that arrived as a tool RESULT.
           *
           * This is the ONE loop every lane feeds, which is why the CLI lanes' card lives
           * here rather than in a bridge: the managed Codex/Claude helper's call has already
           * been made by the time the gate refuses it, so the refusal comes back as an
           * ordinary tool result rather than as an SDK `tool-approval-request`. Registering
           * it in the same map the SDK pause uses means the finish path persists
           * `metadata.toolApprovals` identically — with no tab open too, because the finish
           * path runs regardless of listeners (AMD-113-01).
           *
           * The API lane feeds this loop too, and its own pauses stay OUT of it (F-P3-1):
           * a card made here is answered by a resume turn, while an `api`-lane card is
           * answered by the in-place SDK resume, which can only re-execute an SDK-paused
           * call — a `tool-approval-response` for an id the SDK never issued throws for the
           * whole click. `toolResultApprovalRendersCard` owns that rule.
           */
          const streamedApprovalRequest =
            readControlApprovalRequestFromToolResult(resultPayload)
          if (streamedApprovalRequest && toolResultApprovalRendersCard(streamedApprovalRequest)) {
            streamedApprovalRequests.set(
              streamedApprovalRequest.approvalId,
              buildControlApprovalEntry({
                request: streamedApprovalRequest,
                toolCallId: rawToolCallId ?? null,
                toolName: emittedToolName
              })
            )
            logger.debug('[Send-Routed] Persisting a control approval card from a tool result', {
              sessionId,
              messageId,
              approvalId: streamedApprovalRequest.approvalId,
              controlId: streamedApprovalRequest.controlId,
              lane: streamedApprovalRequest.lane,
            })
          }

          const resolvedMetadata = detectToolSource(toolResult.toolName)
          let toolZipReferences:
            | ZipReference[]
            | undefined = streamedToolZipRefsByCallId.get(fallbackToolCallId)
          let imageZipReferences:
            | ZipReference[]
            | undefined = imageZipRefsByCallId.get(fallbackToolCallId)

          const isImageTool = isImageToolName(toolResult.toolName)
          const isAgentBrowserScreenshot = isAgentBrowserScreenshotInvocation(
            toolResult.toolName,
            resultPayload,
            args,
          )
          const isImageLikeToolResult = isImageTool || isAgentBrowserScreenshot
          if (
            isImageLikeToolResult &&
            emittedImageToolResultIds.has(fallbackToolCallId)
          ) {
            logger.debug('[Send-Routed] Duplicate image tool-result ignored', {
              sessionId,
              messageId,
              toolName: toolResult.toolName,
              toolCallId: fallbackToolCallId,
            })
            break
          }
          const imageOutputs = isAgentBrowserScreenshot
            ? []
            : extractImageOutputs(toolResult.toolName, resultPayload, args)
          const screenshotDisplayUrl = isAgentBrowserScreenshot
            ? extractAgentBrowserScreenshotExternalUrl(resultPayload)
            : null
          const screenshotModelVisibility = isAgentBrowserScreenshot
            ? extractAgentBrowserScreenshotModelVisibility(resultPayload)
            : null
          const screenshotModelVisibleInLoop =
            isAgentBrowserScreenshot &&
            (typeof screenshotModelVisibility === 'boolean'
              ? screenshotModelVisibility
              : Boolean(screenshotDisplayUrl))
          let sanitizedResultPayload: any = resultPayload

          if (isAgentBrowserScreenshot) {
            sanitizedResultPayload = {
              screenshotCaptured: true,
              screenshotUrl: screenshotDisplayUrl,
              command: 'screenshot',
              toolName: toolResult.toolName,
              ephemeral: true,
              historyRetention: 'none',
              modelVisibleInLoop: screenshotModelVisibleInLoop,
              ...(screenshotModelVisibleInLoop
                ? {}
                : {
                    warning:
                      'No screenshot image payload was available for model vision in this loop.',
                  }),
            }
          } else if (imageOutputs.length > 0) {
            if (!imageZipReferences) {
              const createdImageZips: ZipReference[] = []
              for (let i = 0; i < imageOutputs.length; i += 1) {
                const output = imageOutputs[i]
                const created = await createImageZipReference(output, {
                  source: isAgentBrowserScreenshot
                    ? 'agent_browser_screenshot'
                    : 'image_generation',
                  description: isAgentBrowserScreenshot
                    ? 'Agent Browser screenshot'
                    : 'AI-generated image',
                  toolName: toolResult.toolName,
                  toolCallId: fallbackToolCallId,
                  imageIndex: i,
                })
                if (created?.reference) {
                  createdImageZips.push({
                    zipId: created.zipId,
                    reference: created.reference,
                  })
                }
              }

              if (createdImageZips.length > 0) {
                imageZipReferences = createdImageZips
                imageZipRefsByCallId.set(fallbackToolCallId, createdImageZips)
                if (typeof toolResult.toolName === 'string') {
                  imageZipRefsByToolName.set(
                    toolResult.toolName,
                    createdImageZips,
                  )
                }
                streamedToolZipReferences.push(...createdImageZips)
                for (const ref of createdImageZips) {
                  if (isImageTool) {
                    const zipId = ref.zipId || extractZipIdFromReference(ref.reference)
                    if (zipId) imageZipIdsForUi.add(zipId)
                  }
                }
              }
            }

            if (isImageTool) {
              sanitizedResultPayload = {
                imageCount: imageOutputs.length,
                imageZipReferences:
                  imageZipReferences?.map((ref) => ref.reference) ?? [],
                toolName: toolResult.toolName,
              }
            } else if (isAgentBrowserScreenshot) {
              sanitizedResultPayload = {
                screenshotCount: imageOutputs.length,
                screenshotZipReferences:
                  imageZipReferences?.map((ref) => ref.reference) ?? [],
                command: 'screenshot',
                toolName: toolResult.toolName,
              }
            } else {
              sanitizedResultPayload = {
                imageCount: imageOutputs.length,
                imageReferences:
                  imageZipReferences?.map((ref) => ref.reference) ?? [],
                toolName: toolResult.toolName,
              }
            }
          } else if (isImageTool) {
            const fallbackRefs =
              imageZipReferences ??
              (typeof toolResult.toolName === 'string'
                ? imageZipRefsByToolName.get(toolResult.toolName)
                : undefined)
            if (fallbackRefs && fallbackRefs.length > 0) {
              imageZipReferences = fallbackRefs
              sanitizedResultPayload = {
                imageCount: fallbackRefs.length,
                imageZipReferences: fallbackRefs.map((ref) => ref.reference),
                toolName: toolResult.toolName,
              }
              for (const ref of fallbackRefs) {
                const zipId = ref.zipId || extractZipIdFromReference(ref.reference)
                if (zipId) imageZipIdsForUi.add(zipId)
              }
            }
          }

          if (isImageTool) {
            logger.debug('[Send-Routed] Image tool-result processed', {
              sessionId,
              messageId,
              toolName: toolResult.toolName,
              toolCallId: fallbackToolCallId,
              toolCallIdRaw: rawToolCallId,
              tool_call_id: toolResult.tool_call_id,
              toolCallIdField: toolResult.toolCallId,
              id: toolResult.id,
              imageOutputs: imageOutputs.length,
              zipRefs: toolZipReferences?.length ?? 0,
              usedCoolTool:
                !toolZipReferences &&
                !streamedToolZipCallIds.has(fallbackToolCallId),
            })
          } else if (isAgentBrowserScreenshot) {
            logger.debug(
              '[Send-Routed] Agent Browser screenshot tool-result processed',
              {
                sessionId,
                messageId,
                toolName: toolResult.toolName,
                toolCallId: fallbackToolCallId,
                imageOutputs: imageOutputs.length,
                hasExternalUrl: Boolean(screenshotDisplayUrl),
                zipRefs: imageZipReferences?.length ?? 0,
              },
            )
          }

          if (
            !toolZipReferences &&
            !streamedToolZipCallIds.has(fallbackToolCallId)
          ) {
            if (!coolToolZipAdapterModule) {
              coolToolZipAdapterModule =
                await import('$lib/server/coolToolZipAdapter')
            }

            const stepForZip = {
              toolName: emittedToolName,
              originalToolName: toolResult.toolName,
              toolInput: emittedArgs,
              toolArgs: emittedArgs,
              toolResult: sanitizedResultPayload,
              toolCallId: fallbackToolCallId,
              timestamp: new Date().toISOString(),
              metadata: {
                sessionId,
              },
              ...(resolvedMetadata ?? {}),
              ...(toolResult.metadata ?? {}),
            }

            const created =
              await coolToolZipAdapterModule.adaptCoolToolsToZipSystem(
                [stepForZip],
                sessionId,
                messageId,
                zipSettingsAgent || {},
                globalZipSettings,
                {
                  reservedZipIdsByToolCallId: reservedToolZipIdsByCallId,
                },
              )

            if (created.length > 0) {
              toolZipReferences = created
              streamedToolZipReferences.push(...created)
              streamedToolZipCallIds.add(fallbackToolCallId)
              streamedToolZipRefsByCallId.set(fallbackToolCallId, created)
              for (const ref of created) {
                if (typeof ref?.reference === 'string' && ref.reference) {
                  appendToolZipReference(ref.reference)
                }
              }
            }
          }

          const toolResultEvent = await streamAdapter.emitToolResult({
            toolCallId: fallbackToolCallId,
            toolName: emittedToolName,
            args: emittedArgs,
            result: sanitizedResultPayload,
            metadata: toolResult.metadata,
            zipReferences: toolZipReferences,
          })
          if (isImageLikeToolResult) {
            emittedImageToolResultIds.add(fallbackToolCallId)
          }
          const streamedCallId = toolResultEvent.toolCallId
          if (streamedCallId && !streamedToolCallIds.has(streamedCallId)) {
            streamedToolCallIds.add(streamedCallId)
            // This copy is the Execution Viewer's row, the saved message's step, and the `end`
            // event's. The lane's own error (Claude Code's `is_error`, which the zip step above
            // already carries) wins; otherwise the result's, by the stored zip's rules. Both were
            // once overwritten here by the raw result's flag, so a failed Claude or Codex command
            // was a Success row (fp65h).
            const laneError = [toolResult.metadata?.error, toolResultEvent.metadata?.error].find(
              (value): value is string => typeof value === 'string' && value.trim().length > 0,
            )
            const stepError =
              laneError ??
              toolStepFailureMessage(emittedToolName, emittedArgs, parseJsonLike(sanitizedResultPayload))
            streamedToolSteps.push({
              toolName: emittedToolName,
              originalToolName: toolResult.toolName,
              toolInput: emittedArgs,
              toolArgs: emittedArgs,
              toolResult: sanitizedResultPayload,
              toolCallId: streamedCallId,
              timestamp: Date.now(),
              ...(resolvedMetadata ?? {}),
              ...(toolResultEvent.metadata ?? {}),
              ...(toolResult.metadata ?? {}),
              error: stepError,
              success: stepError ? false : sanitizedResultPayload !== undefined,
            })
          }
          await streamAdapter.emitToolEnd({
            toolCallId: streamedCallId,
          })
          break
        }
        case 'raw': {
          const rawChunk = chunk as any
          const extracted = extractUsageFromRawChunk(rawChunk?.rawValue)
          if (extracted) {
            rawUsageFromStream = mergeUsageLike(rawUsageFromStream, extracted)
          }
          const rawReasoning = extractReasoningTextFromRawChunk(
            rawChunk?.rawValue,
          )
          const readyRawFallback = reasoningStreamSource.queueRawFallback(rawReasoning)
          if (readyRawFallback) {
            await appendReasoningDelta(readyRawFallback)
          }
          break
        }
        case 'error': {
          await flushRawReasoningFallback()
          const errorChunk = chunk as any
          const rawError =
            errorChunk?.error ??
            errorChunk?.value ??
            errorChunk?.data ??
            errorChunk?.cause ??
            null
          // BL-245: a provider can send its error as a stream chunk, and a lane whose chunk
          // schema does not take that shape reports a type validation error with the chunk
          // inside it. The chat said "Failed to stream response" around a Zod message; the
          // provider's own sentence is what the user can act on.
          const providerError = providerStreamErrorFrom(rawError)
          let normalizedError: Error
          if (providerError) {
            normalizedError = providerError
          } else if (rawError instanceof Error) {
            normalizedError = rawError
          } else {
            const candidateMessage =
              typeof rawError === 'string' && rawError.trim().length > 0
                ? rawError.trim()
                : typeof rawError?.message === 'string' &&
                    rawError.message.trim().length > 0
                  ? rawError.message.trim()
                  : typeof errorChunk?.error === 'string' &&
                      errorChunk.error.trim().length > 0
                    ? errorChunk.error.trim()
                    : 'Stream failed before producing output'
            normalizedError = new Error(candidateMessage)
          }
          streamRuntimeError = normalizedError
          shouldBreakStream = true
          break
        }
        case 'steer': {
          /**
           * SA-114 P2 — a managed CLI told us the model has the user's mid-reply words.
           *
           * This is the CLI half of F-P1-3, and it is deliberately the mirror image of the
           * API lane's gate rather than a copy of it. The API lane holds a delivered steer
           * until the loop has consumed the `finish-step` of the step it was read after,
           * because the SDK runs AHEAD of this loop and "which chunk is in hand" proves
           * nothing about where the step boundary sits. A CLI stream has no `finish-step`
           * chunks at all — there is no count for such a gate to consume — but it does not
           * need one: the echo arrives IN the stream, 2-6 ms after the tool result that
           * preceded delivery, so its position in the stream IS the position the marker
           * belongs at. Marking delivered here and draining unbounded puts it exactly there.
           * Marking it in the adapter with a step the gate could never reach would instead
           * leave it waiting for the forced finish drain and land it at the very end.
           */
          const steerChunk = chunk as any
          const steerIds = Array.isArray(steerChunk.steerIds) ? steerChunk.steerIds : []
          const echoLane: SteerLane =
            steerChunk.lane === 'codex' || steerChunk.lane === 'claude'
              ? steerChunk.lane
              : 'api'
          if (steerDeliveryEnabled && steerIds.length > 0) {
            confirmSteerDelivery(sessionId, messageId, {
              steerIds,
              step: finishedStepsConsumed,
              lane: echoLane,
            })
            await drainSteersIntoTranscript(true)
          }
          break
        }
        case 'finish-step': {
          // Consumer-owned per-call evidence avoids racing the onFinish callback
          // or treating the last raw usage chunk as a multi-call aggregate.
          rawUsageByFinishedStep.push((chunk as any).usage?.raw)
          lastStepOutputTokens = outputTokensForUsage((chunk as any).usage) ?? null
          // SA-114 (F-P1-3): the loop has now consumed everything this step produced, so
          // a steer delivered at this boundary may be written before the next chunk.
          finishedStepsConsumed += 1
          break
        }
        case 'finish': {
          await flushRawReasoningFallback()
          await ensureReasoningSegmentBoundary()
          const finishChunk = chunk as any
          streamFinishReason = finishChunk.finishReason ?? null
          const usage = withHonestLocalCacheUsage(
            finishChunk.totalUsage || finishChunk.usage || rawUsageFromStream,
            streamLocalCacheReporting,
            rawUsageByFinishedStep,
          )
          if (usage) {
            if (!silentResponse) {
              await ensureStartEmitted()
            }
            await streamAdapter.emitFinish({ usage })
          }
          shouldBreakStream = true
          break
        }
        default:
          break
      }

      if (shouldBreakStream) {
        break
      }
    }

    // SA-114 P1: a steer delivered at the LAST step boundary has no following chunk to
    // ride on, so drain once more here. `onFinish` drains first as well, because the SDK's
    // finish callback and this loop's tail can complete in either order and the marker has
    // to be in `streamedReply` before the finish path reads it. Forced: the loop
    // has consumed every chunk, so every step is over.
    await drainSteersIntoTranscript(true)

    // Keep the raw fallback consumer-owned. The SDK finish callback can run
    // ahead of queued stream parts; flushing there could append raw reasoning
    // before the matching normalized part reaches this loop.
    await flushRawReasoningFallback()

    if (!onFinishResolved) {
      await Promise.race([
        onFinishPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ])
    }

    // A stopped stream is interrupted, whatever else it ended with (`streamStop.ts`). The SDK can
    // end an aborted stream normally, with its `abort` part; judged like a finished reply below,
    // a Stop was logged as a provider failure (the rejected `steps`, then "empty response").
    const streamEnd = judgeStreamEnd({
      stopped: streamAbortSignal.aborted,
      runtimeError: streamRuntimeError,
    })
    if (streamEnd.kind === 'stopped') throw new StreamStoppedError()
    if (streamEnd.kind === 'failed') throw streamEnd.error

    const respondedApprovalIds = new Set(
      toolApprovalResponse
        .map((entry) =>
          typeof entry?.approvalId === 'string' ? entry.approvalId.trim() : '',
        )
        .filter(Boolean),
    )
    const toolApprovalRequests = (
      await extractToolApprovalRequests(result)
    ).filter((entry) => {
      const approvalId =
        typeof entry?.approvalId === 'string' ? entry.approvalId.trim() : ''
      return !approvalId || !respondedApprovalIds.has(approvalId)
    })
    /**
     * SA-116 P2 (AMD-116-01) — the ONE place a pending approval record is created.
     *
     * This is where the card entry is persisted, and it already holds everything the record
     * needs: the SDK approval id, the `toolCallId`, the model's input, and the assistant
     * message id. The per-tool `toolApproval` policy deliberately writes NOTHING, because
     * the SDK asks it again on the approval resume for the same call id — a policy that
     * wrote would create a second record for one call.
     *
     * Entries that are not broker calls (Bash, `native_skill` script runs) pass through
     * untouched; they are the Bash approval flow, which has no consent record.
     */
    const withControlRecords = async (
      approvals: ToolApprovalEntry[],
    ): Promise<ToolApprovalEntry[]> =>
      sessionId
        ? await attachControlApprovalRecords({
            userId,
            agentId: agentId || null,
            sessionId,
            messageId,
            approvals,
          })
        : approvals

    if (toolApprovalRequests.length > 0) {
      const approvalSummary: ToolApprovalSummary = {
        mode: runToolApprovalMode,
        approvals: await withControlRecords(toolApprovalRequests),
        source: 'vercel',
      }
      finishSummary.metadata = {
        ...(finishSummary.metadata ?? {}),
        toolApprovals: approvalSummary,
      }
    } else if (streamedApprovalRequests.size > 0) {
      const pendingStreamedApprovals = Array.from(
        streamedApprovalRequests.values(),
      ).filter((entry) => {
        const approvalId =
          typeof entry?.approvalId === 'string' ? entry.approvalId.trim() : ''
        return !approvalId || !respondedApprovalIds.has(approvalId)
      })
      if (pendingStreamedApprovals.length > 0) {
        const approvals = await withControlRecords(pendingStreamedApprovals)
        const approvalSummary: ToolApprovalSummary = {
          mode: runToolApprovalMode,
          approvals,
          source: resolveApprovalSummarySource(approvals),
        }
        finishSummary.metadata = {
          ...(finishSummary.metadata ?? {}),
          toolApprovals: approvalSummary,
        }
      }
    } else if (respondedApprovalIds.size > 0) {
      // Redis saveMessage merges existing + incoming metadata for same message id.
      // Explicitly clear stale approval cards after a successful response so
      // previously pending entries cannot reappear on refresh.
      finishSummary.metadata = {
        ...(finishSummary.metadata ?? {}),
        toolApprovals: null,
      }
    }

    if (
      !hasUsageValues(lastResolvedUsage) &&
      hasUsageValues(rawUsageFromStream)
    ) {
      const fallbackUsage = rawUsageFromStream as UsageLike
      if (!finishSummary.usage) {
        finishSummary.usage = fallbackUsage
      }

      if (!isCliProvider) {
        try {
          const sanitizedToolSteps = sanitizePayloadForLogs(
            Array.isArray(finishSummary.intermediateSteps)
              ? finishSummary.intermediateSteps
              : [],
          )
          const capture = buildVercelLlmCapture({
            steps: lastStreamSteps ?? [],
            totalUsage: fallbackUsage ?? null,
            finalText: lastStreamText,
            providerId:
              primaryConnection?.service ??
              primaryProviderId ??
              null,
          })

          const stepsForCount = Array.isArray(lastStreamSteps)
            ? lastStreamSteps
            : streamedToolSteps
          const toolCallsTotal = stepsForCount.reduce(
            (sum: number, step: any) => {
              const count = Array.isArray(step?.toolCalls)
                ? step.toolCalls.length
                : 0
              return sum + count
            },
            0,
          )

          await executionViewerService.updateSnapshot(sessionId, messageId, withPriorRunAccounting({
            llmSummary: capture.llmSummary,
            llmCalls: capture.llmCalls,
            intermediateSteps: withPriorRunSteps(sanitizedToolSteps),
            responseSummary: {
              content: {
                value: finishSummary.content || finishSummary.text || '',
                confidence: 'exact',
              },
              usage: buildTokenUsage(
                fallbackUsage ?? null,
                'near',
                'raw-chunk',
              ),
              toolCallsCount: buildTokenStat(
                toolCallsTotal,
                'exact',
                'vercel ai sdk',
              ),
              notes: [
                'Usage totals sourced from raw stream chunk (provider did not return usage in the finish event).',
              ],
            },
          }))
        } catch (viewerPatchError) {
          console.error(
            '[Send-Routed] Failed to backfill execution snapshot usage from raw chunk:',
            viewerPatchError,
          )
        }
      }
    }

    const hasVisibleAssistantOutput =
      Boolean(
        (
          finishSummary.content ||
          finishSummary.text ||
          streamedReply.toString() ||
          ''
        ).trim(),
      ) ||
      finishSummary.zipReferences.length > 0 ||
      streamedToolZipReferences.length > 0 ||
      finishSummary.intermediateSteps.length > 0 ||
      streamedToolSteps.length > 0 ||
      streamedApprovalRequests.size > 0 ||
      Boolean(finishSummary.metadata?.toolApprovals)

    if (!silentResponse && !hasVisibleAssistantOutput) {
      const emptyCompletionUsage =
        finishSummary.usage ??
        lastResolvedUsage ??
        rawUsageFromStream ??
        streamAdapter.getUsage() ??
        null
      const typedEmptyCompletionUsage = hasUsageValues(emptyCompletionUsage)
        ? (emptyCompletionUsage as UsageLike)
        : null
      if (!finishSummary.usage && typedEmptyCompletionUsage) {
        finishSummary.usage = typedEmptyCompletionUsage
      }
      const outputTokens = outputTokensForUsage(typedEmptyCompletionUsage)
      // BL-239: a request that spent the whole output limit (thinking counts) wrote nothing; that
      // is the limit, not an empty answer from the provider.
      if (isOutputLimitFinish(streamFinishReason)) {
        throw createRoutedInputError(
          describeOutputLimitStop({
            outputTokens: lastStepOutputTokens ?? outputTokens ?? null,
            wroteReply: false,
          }),
          OUTPUT_LIMIT_ERROR_CODE,
          502,
        )
      }
      const tokenNote =
        outputTokens === 0
          ? ' The provider reported 0 output tokens.'
          : ''
      throw createRoutedInputError(
        `The model provider returned an empty response.${tokenNote}`,
        'PROVIDER_EMPTY_RESPONSE',
        502,
      )
    }

    if (silentResponse) {
      await emitThinkingIndicatorStop()
      await streamAdapter.emitComplete({
        metadata: {
          silent: true,
          ...(controlsMode ? { controlsMode } : {}),
          ...(controlsMode === 'listening'
            ? { silentReason: 'listening' }
            : {}),
        },
      })
    } else {
      // BL-239: a reply that wrote something and then stopped at the output limit is saved as a
      // failed turn of its own kind, with its words and tool work kept.
      if (isOutputLimitFinish(streamFinishReason)) {
        replyOutputLimitFailure = outputLimitFailureMetadata(
          describeOutputLimitStop({ outputTokens: lastStepOutputTokens, wroteReply: true }),
        )
      }
      await finalizeAssistantMessage('postStream')
      await streamAdapter.emitComplete()
    }

    await persistRuntimeSnapshot('succeeded')

    // SA-120 P5: smart zip's after-reply step. The reply is complete and on screen, so this
    // never delays the user: Jev is asked which still-open tool results the agent is done
    // with, those are zipped (`source: 'inferred'`), every tab is told, and the row is
    // appended to this reply's snapshot. AFTER the snapshot's own last write, so nothing
    // overwrites the row. It never throws, and a silent reply has nothing to judge.
    //
    // SA-120 P6: the after-reply check runs on this SAME site, beside smart zip's step: Jev is
    // asked whether the reply claims something the turn did not do (and about repeated
    // wording), what it notices is stored per message and told to every tab, and the reply is
    // NEVER edited. The two steps judge side by side; their Execution Viewer rows are appended
    // one writer at a time (`appendRowsAfter`), because appending is a read-modify-write.
    //
    // BL-527: both steps judge a FINISHED reply, once. A reply that stopped at an approval card
    // has not ended (its resume ends it, and judges it then, whole; a resume is a second finalize
    // of the same message), and a reply cut at the output limit never finished, so neither step
    // runs for those. `awaitsApproval` below is the same decision. A run that finishes a reply an
    // earlier run began (an API approval resume, a context continuation) runs the steps it was
    // given for that (`jevJuiceContinuedReply`), with the parts the earlier runs stored.
    const replyAwaitsApproval = approvalSummaryIsPending(finishSummary.metadata?.toolApprovals)
    const afterReplySmartZip = jevJuiceSmartZip ?? jevJuiceContinuedReply?.smartZip
    const afterReplyCheck = jevJuicePostTurnCheck ?? jevJuiceContinuedReply?.postTurnCheck
    if (
      !silentResponse &&
      !replyAwaitsApproval &&
      !replyOutputLimitFailure &&
      (afterReplySmartZip || afterReplyCheck)
    ) {
      // The reply as the model wrote it: the after-reply check asks whether it tried a memory
      // save, which the stored (cleaned) text no longer shows (SA-129 P2).
      const finishedReply = rawFinishedReply ?? (finishSummary.content || finishSummary.text || '')
      const newZipIds = (finishSummary.zipReferences ?? [])
        .map((reference) => reference?.zipId)
        .filter((zipId): zipId is string => typeof zipId === 'string' && zipId.length > 0)
      const earlierParts = jevJuiceContinuedReply?.earlierParts ?? []
      const smartZipStep = afterReplySmartZip
        ? afterReplySmartZip.runPostTurn({ messageId, reply: finishedReply, newZipIds, earlierParts })
        : Promise.resolve([])
      const postTurnCheckStep = afterReplyCheck
        ? afterReplyCheck.runPostTurn({
            messageId,
            reply: finishedReply,
            newZipIds,
            toolSteps:
              streamedToolSteps.length > 0
                ? streamedToolSteps
                : Array.isArray(finishSummary.intermediateSteps)
                  ? finishSummary.intermediateSteps
                  : [],
            awaitingApproval: replyAwaitsApproval,
            earlierParts,
            appendRowsAfter: smartZipStep,
          })
        : Promise.resolve(null)
      await Promise.all([smartZipStep, postTurnCheckStep])
    }

    const response = json({
      success: true,
      messageId,
      silent: silentResponse,
      usage: finishSummary.usage ?? streamAdapter.getUsage(),
    })

    return {
      response,
      messageId,
      content: silentResponse
        ? ''
        : finishSummary.content || finishSummary.text || '',
      metadata: finishSummary.metadata ?? {},
      usage: finishSummary.usage ?? streamAdapter.getUsage(),
      awaitsApproval: replyAwaitsApproval,
    }
  } catch (error: any) {
    const isAbortError = isStopError(error, [streamAbortSignal, request.signal])
    if (isAbortError) {
      logger.debug('[Send-Routed] Stream stopped', {
        sessionId,
        messageId,
        reason: streamAbortSignal.reason ?? null,
      })
    } else {
      console.error('[Send-Routed] Batshit agent streaming error:', error)
    }

    // BL-245: the model calls this run made, and its tool steps, as the stream showed them. The
    // SDK's finish, which writes them for a finished run, never comes for a run that failed or
    // was stopped mid-stream, and the snapshot kept none: a user could not see what a failed
    // reply cost or did. A call that never finished has its usage unknown, never zero, and the
    // run's total is unknown too. API lane only: the CLI lanes' calls are not steps. Written
    // only if the finish callback has not claimed the calls (it may still be busy writing them).
    if (!isCliProvider) {
      const recordedSteps = streamStepRecorder.steps(isAbortError ? 'interrupted' : 'error')
      if (recordedSteps.length > 0 && llmCaptureClaim.claim('failure')) {
        try {
          const capture = buildVercelLlmCapture({
            steps: sanitizePayloadForLogs(recordedSteps) as any[],
            totalUsage: null,
            finalText: null,
            providerId:
              primaryConnection?.service ??
              primaryProviderId ??
              null,
          })
          const sanitizedToolSteps = sanitizePayloadForLogs(streamedToolSteps)
          await executionViewerService.updateSnapshot(sessionId, messageId, withPriorRunAccounting({
            llmCalls: capture.llmCalls,
            llmSummary: capture.llmSummary,
            intermediateSteps: withPriorRunSteps(sanitizedToolSteps),
            // BL-525: a resume that failed or was stopped after it called the model has an unknown
            // half, so the message's usage is unknown too; left alone, the paused half's summary
            // (which the Token Panel reads first) would stand for the whole message, exact.
            ...(approvalResumePriorSnapshot?.responseSummary
              ? {
                  responseSummary: {
                    content: { value: '', confidence: 'exact' as const },
                    usage: buildTokenUsage(null, 'estimated'),
                    toolCallsCount: buildTokenStat(null, 'estimated'),
                  },
                }
              : {}),
          }))
        } catch (captureError) {
          console.error(
            '[Send-Routed] Failed to keep the model calls of a failed run in its execution snapshot:',
            captureError,
          )
        }
      }
    }

    // BL-525: the finish callback is the only writer of `delegated`, and it never comes for a run
    // that failed or was stopped mid-stream, so a Subagent or Worker that ran (and was billed)
    // before the failure or the Stop was missing from the Token Panel's delegated spend. Built
    // here from the tool steps the stream showed, on every lane, for the snapshot and for the
    // record the Stop and failure paths below save.
    const failedRunDelegated = onFinishResolved
      ? null
      : buildDelegatedExecutionSummary([...streamedToolSteps, ...helperDelegatedSteps])
    if (failedRunDelegated) {
      try {
        await executionViewerService.updateSnapshot(
          sessionId,
          messageId,
          withPriorRunAccounting({ delegated: failedRunDelegated }),
        )
      } catch (delegatedError) {
        console.error(
          '[Send-Routed] Failed to keep the delegated runs of a stopped or failed run in its execution snapshot:',
          delegatedError,
        )
      }
    }

    const normalizedErrorMessage =
      error instanceof Error ? error.message : String(error ?? 'Unknown error')
    const localImageFailure = classifyLocalImageUrlRuntimeFailure({
      errorMessage: normalizedErrorMessage,
      providerId: providerIdentifier || null,
      connectionId: connectionIdentifier || null,
    })
    const imageInputFailure = classifyImageInputUnsupportedRuntimeFailure({
      errorMessage: normalizedErrorMessage,
      providerId: providerIdentifier || null,
      modelId: effectiveModelId || null,
    })
    const surfacedErrorMessage =
      localImageFailure?.userMessage ??
      imageInputFailure?.userMessage ??
      normalizedErrorMessage
    // A provider error chunk's own code counts too (BL-245 review): its sentence alone can say
    // nothing the classifier knows while its code says `context_length_exceeded`.
    const contextExhausted = isContextExhaustedStreamFailure(error)

    if (isAbortError) {
      const interruptedAt = new Date().toISOString()

      try {
        if (ensureStartEmitted) {
          await ensureStartEmitted()
        }
        // A raw-only provider may have one delayed fallback chunk waiting when
        // the user stops the stream. Capture it before the recovery block is rendered.
        await flushRawReasoningFallback()

        if (
          !finishSummary.content &&
          !finishSummary.text &&
          streamedReply.length > 0
        ) {
          finishSummary.content =
            streamMetadata?.groupChat === true
              ? stripGroupChatPresentationControls(streamedReply.toString())
              : streamedReply.toString()
        }

        if (
          finishSummary.zipReferences.length === 0 &&
          streamedToolZipReferences.length > 0
        ) {
          finishSummary.zipReferences = [...streamedToolZipReferences]
        }

        const baseAbortMetadata = {
          model: effectiveModelId ?? primarySelection.modelId,
          agentType: primaryAgentType,
          voice: voiceMetadata,
          selectedTools,
          selectedGateways,
        }

        finishSummary.metadata = {
          ...baseAbortMetadata,
          ...(finishSummary.metadata ?? {}),
          ...(failedRunDelegated ? { delegated: failedRunDelegated } : {}),
          interrupted: true,
          interruptionReason: resolveInterruptionReason(),
          interruptedAt,
          ...(stoppedForDeletedChat() ? { chatDeleted: true } : {}),
        }

      } catch (abortFinalizeError) {
        console.error(
          '[Send-Routed] Failed to finalize interrupted stream:',
          abortFinalizeError,
        )
      }
      // BL-775: the finalize publishes `end` only after its save. A save that failed twice has
      // told the tabs with `error`; a chat deleted mid-reply sends no `end`, and `complete` still
      // ends the reply in every tab.
      const stoppedReplySaved = await finalizeStoppedReply('Failed to finalize interrupted stream')
      if (stoppedReplySaved || stoppedForDeletedChat()) {
        try {
          await streamAdapter.emitComplete({
            metadata: {
              interrupted: true,
              interruptedAt,
              ...(stoppedForDeletedChat() ? { chatDeleted: true } : {}),
            },
          })
        } catch (abortCompleteError) {
          console.error('[Send-Routed] Failed to send the interrupted stream’s complete event:', abortCompleteError)
        }
      }

      await persistRuntimeSnapshot('failed', describeInterruption())

      return {
        response: json(
          {
            error: describeInterruption(),
            ...(stoppedForDeletedChat() ? { code: 'session_deleted' } : {}),
          },
          { status: 499 },
        ),
        messageId,
        content: finishSummary.content || finishSummary.text || '',
        metadata: finishSummary.metadata ?? {},
        usage: finishSummary.usage ?? undefined,
      }
    }

    const errorStatus = getFailureStatus(error)
    const errorCode =
      localImageFailure?.code ??
      imageInputFailure?.code ??
      getFailureCode(error) ??
      null
    const failureUsage =
      finishSummary.usage ??
      lastResolvedUsage ??
      rawUsageFromStream ??
      null
    const failureRuntimeMetadata = {
      ...(approvalResumeStart ? { approvalResumeVersion: approvalResumeStart.version } : {}),
      provider: providerIdentifier || null,
      connection: connectionIdentifier || null,
      model: effectiveModelId || null,
      runtimeId: isCodexProvider
        ? 'codex'
        : isClaudeProvider
          ? 'claude'
          : 'api',
      agentType: primaryAgentType,
      voice: voiceMetadata,
      selectedTools,
      selectedGateways,
      ...(hasUsageValues(failureUsage) ? { usage: failureUsage } : {}),
      ...(isApprovalResumeWithoutUserTurn && !hasUsageValues(failureUsage) ? { usage: null } : {}),
      ...(finishSummary.observedUsage ? { observedUsage: finishSummary.observedUsage, usage: null } : {}),
      // BL-239: both failure writers below spread this, so an output-limit stop keeps its kind
      // on the partial record and on the empty one alike.
      ...(errorCode === OUTPUT_LIMIT_ERROR_CODE ? { failure_kind: OUTPUT_LIMIT_FAILURE_KIND } : {}),
      // BL-958 (c), BL-941: the empty record keeps the reply's notes too, not only the finalize.
      ...(answerRestartedAfterLostConnection
        ? { restartedAfterLostConnection: { program: restartedAnswerProgram } }
        : {}),
      ...(modeLimitedByAgentSettings ? { modeLimitedByAgentSettings } : {}),
    }

    const joinedFailureAccounting = isApprovalResumeWithoutUserTurn && approvalResumePrior
      ? mergeResumedMetadata(approvalResumePrior.metadata, failureRuntimeMetadata)
      : failureRuntimeMetadata
    // Carry only usage accounting to the POST's repeated failure save. Reply-end keys
    // belong to the finalize/failure writer; a prior-only copy would overwrite its join.
    const failureAccountingMetadata: Record<string, any> = { ...failureRuntimeMetadata }
    for (const key of ['usage', 'observedUsage'] as const) {
      if (Object.prototype.hasOwnProperty.call(joinedFailureAccounting, key)) {
        failureAccountingMetadata[key] = joinedFailureAccounting[key]
      }
    }

    // A failed stream must never erase work the user already received. When the
    // run produced any content or tool results before dying (e.g. context-window
    // exhaustion mid-task), finalize the partial message exactly like the
    // user-interrupt path does — content, tool zips, and zipIds intact — and
    // carry the failure in metadata instead of replacing the message body.
    const redactedErrorMessage =
      redactDataImageUrlsInText(surfacedErrorMessage).value || surfacedErrorMessage
    const redactedErrorDetails =
      normalizedErrorMessage && normalizedErrorMessage !== surfacedErrorMessage
        ? redactDataImageUrlsInText(normalizedErrorMessage).value
        : null
    const hasPartialStreamedWork =
      Boolean(streamedReply.toString().trim()) ||
      Boolean(showReasoning && (reasoningCaptured.trim() || planSummary.trim())) ||
      streamedToolZipReferences.length > 0 ||
      Boolean(finishSummary.content) ||
      Boolean(finishSummary.text) ||
      finishSummary.zipReferences.length > 0

    let partialWorkPersisted = false
    if (hasPartialStreamedWork) {
      try {
        if (ensureStartEmitted) {
          await ensureStartEmitted()
        }

        if (
          !finishSummary.content &&
          !finishSummary.text &&
          streamedReply.length > 0
        ) {
          finishSummary.content =
            streamMetadata?.groupChat === true
              ? stripGroupChatPresentationControls(streamedReply.toString())
              : streamedReply.toString()
        }

        if (
          finishSummary.zipReferences.length === 0 &&
          streamedToolZipReferences.length > 0
        ) {
          finishSummary.zipReferences = [...streamedToolZipReferences]
        }

        finishSummary.metadata = {
          ...(finishSummary.metadata ?? {}),
          ...failureRuntimeMetadata,
          ...(failedRunDelegated ? { delegated: failedRunDelegated } : {}),
          model: effectiveModelId ?? primarySelection.modelId,
          response_failed: true,
          error_message: redactedErrorMessage,
          failed_at: new Date().toISOString(),
          ...(contextExhausted ? { failure_kind: 'context_exhausted' } : {}),
          ...(redactedErrorDetails ? { error_details: redactedErrorDetails } : {}),
          ...(errorCode ? { error_code: errorCode } : {}),
          ...(typeof errorStatus === 'number' ? { http_status: errorStatus } : {}),
        }

        await finalizeAssistantMessage('error')
        partialWorkPersisted = true
      } catch (partialFinalizeError) {
        console.error(
          '[Send-Routed] Failed to finalize partial content for failed stream:',
          partialFinalizeError,
        )
      }
    }

    // BL-775: saved first, then the tabs are told, so a tab that reads the chat on `error` finds
    // the failed record.
    if (!partialWorkPersisted) {
      await persistFailedAssistantTurn({
        sessionId,
        userId,
        agentId,
        messageId,
        message: surfacedErrorMessage,
        details: normalizedErrorMessage,
        code: errorCode,
        status: errorStatus,
        metadata: { ...failureAccountingMetadata,
          ...(streamMetadata?.steerPromoted ? { steerPromoted: streamMetadata.steerPromoted } : {}) },
        inPlaceResume: isApprovalResumeWithoutUserTurn,
        imageOriginVersion,
        // BL-542: the reply-end step ran and both finalize saves failed; its saves, holds, and
        // notes happened, so the failed record keeps them. (Written by the finalize closure, so
        // TypeScript's flow analysis still reads the `null` it started as.)
        replyEndMetadata: (replyControlDone as ReplyControlFinalizeResult | null)?.metadata ?? null,
        replyEndPrior: approvalResumePrior,
        model: effectiveModelId ?? primarySelection.modelId,
        provider: providerIdentifier || primarySelection.provider,
      })
    }

    try {
      await streamAdapter.emitError({
        error: surfacedErrorMessage,
        metadata: {
          provider: providerIdentifier || null,
          connection: connectionIdentifier || null,
          model: effectiveModelId || null,
          ...(localImageFailure || imageInputFailure
            ? { code: (localImageFailure ?? imageInputFailure)?.code }
            : {}),
        },
      })
    } catch (emitError) {
      console.error(
        '[Send-Routed] Failed to broadcast stream error event:',
        emitError,
      )
    }

    if (errorCode === 'PROVIDER_EMPTY_RESPONSE' || errorCode === OUTPUT_LIMIT_ERROR_CODE) {
      await persistRuntimeSnapshot('failed', normalizedErrorMessage)
      return {
        response: json(
          {
            error: surfacedErrorMessage,
            code: errorCode,
          },
          { status: errorStatus ?? 502 },
        ),
        messageId,
        content: '',
        metadata: failureAccountingMetadata,
        usage: hasUsageValues(failureUsage)
          ? (failureUsage as UsageLike)
          : undefined,
        failureHandled: partialWorkPersisted,
        contextExhausted,
      }
    }

    if (error instanceof Error && error.message?.includes('API key')) {
      await persistRuntimeSnapshot('failed', normalizedErrorMessage)
      // SA-102 P5 (DL-102-09): a local program refusing a key is a different
      // problem from a missing cloud provider key, and the generic message sent
      // users hunting in the wrong place. Josh's oMLX answered 401 for weeks.
      const localProgram = LOCAL_AI_SERVER_DEFINITIONS.find(
        (definition) =>
          definition.id ===
          (connectionInfo?.service ?? primarySelection.provider ?? '').trim().toLowerCase(),
      )
      const apiKeyErrorMessage = localProgram
        ? `${localProgram.label} refused the request because of its API key. Add or correct the key for ${localProgram.label} under Settings -> API Keys -> Local AI, or turn its key check off in ${localProgram.label}.`
        : 'AI provider API key not configured for API or CLI agents'
      return {
        response: json(
        { error: apiKeyErrorMessage },
          { status: 500 },
        ),
        messageId,
        content: '',
        metadata: failureAccountingMetadata,
        usage: undefined,
        failureHandled: partialWorkPersisted,
        contextExhausted,
      }
    }

    if (localImageFailure) {
      await persistRuntimeSnapshot('failed', normalizedErrorMessage)
      return {
        response: json(
          {
            error: 'Local image URL rejected by runtime',
            details: surfacedErrorMessage,
            code: localImageFailure.code,
          },
          { status: 422 },
        ),
        messageId,
        content: '',
        metadata: failureAccountingMetadata,
        usage: undefined,
        failureHandled: partialWorkPersisted,
        contextExhausted,
      }
    }

    if (imageInputFailure) {
      await persistRuntimeSnapshot('failed', normalizedErrorMessage)
      return {
        response: json(
          {
            error: surfacedErrorMessage,
            details: normalizedErrorMessage,
            code: imageInputFailure.code,
          },
          { status: 422 },
        ),
        messageId,
        content: '',
        metadata: failureAccountingMetadata,
        usage: undefined,
        failureHandled: partialWorkPersisted,
        contextExhausted,
      }
    }

    await persistRuntimeSnapshot('failed', normalizedErrorMessage)
    return {
      response: json(
        {
          error: chatgptPlanHttpStatus(error) !== null ? surfacedErrorMessage : 'Failed to stream response',
          details: surfacedErrorMessage,
          ...(chatgptPlanHttpStatus(error) !== null && errorCode ? { code: errorCode } : {}),
        },
        { status: chatgptPlanHttpStatus(error) ?? 500 },
      ),
      messageId,
      content: '',
      metadata: failureAccountingMetadata,
      usage: undefined,
      failureHandled: partialWorkPersisted,
      contextExhausted,
    }
  } finally {
    // BL-246: take back every abort relay first, so nothing outside keeps this scope alive.
    turnListeners.abort()
    zipDetection.deleteSessionBuffers(sessionId)
    // SA-114 P2: the run's steerability verdict and its CLI channel die with the turn that
    // owned them. Scoped by message id, like every other cleanup in this file, so a request
    // unwinding late cannot remove a newer turn's registration.
    if (steerRunRegistered) clearSteerRun(sessionId, messageId)
    clearStreamAbort(sessionId, messageId)
    try {
      if (visualCleanup) {
        try {
          await visualCleanup()
        } finally {
          await cleanupSessionMonitoring(sessionId)
        }
      }
    } finally {
      // BL-537: a first finalize that ran the reply-end step and died before its notice, with no
      // second finalize after it (a failure with no words to keep), still tells the tabs, once.
      await announceReplyControlZipChange()
    }
  }
  } finally { turnListeners.abort() }
}

/**
 * SA-120 P3: what Jev reads about a group agent — its description, else the first
 * non-empty line of its system prompt (the constants module clips it). Disclosed in the
 * preset's own copy and in UserDocs as the text that leaves the machine.
 */
function resolveGroupSpeakerAbout(agent: AgentRow): string | null {
  const description =
    typeof agent.description === 'string' ? agent.description.trim() : ''
  if (description) return description
  const prompt = typeof agent.system_prompt === 'string' ? agent.system_prompt : ''
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return firstLine ?? null
}

/**
 * SA-120 P3 (DL-120-07): a follow-up Judge Juice skipped entirely has no speaker message of
 * its own, so its record is appended to the previous speaker's Execution Viewer snapshot
 * (the message the follow-up event came from). No snapshot means a logged missing row,
 * never a hidden one.
 */
async function recordSkippedGroupFollowup(
  sessionId: string,
  sourceMessageId: string | null,
  record: TypesafeCallRecord,
): Promise<void> {
  if (!sourceMessageId) {
    console.warn(
      '[Judge Juice] group follow-up skipped with no previous speaker message to record it on',
      { sessionId },
    )
    return
  }
  try {
    const attached = await appendTypesafeCallRecords(sessionId, sourceMessageId, [record])
    if (!attached) {
      console.warn(
        '[Judge Juice] group follow-up skipped: no Execution Viewer snapshot to attach the record to',
        { sessionId, sourceMessageId },
      )
    }
  } catch (error) {
    console.error(
      '[Judge Juice] group follow-up skipped: failed to attach the Execution Viewer record:',
      error,
    )
  }
}

async function handleGroupChatStream({
  content,
  sessionId,
  agent,
  agentId,
  messages,
  metadata,
  batshitInput,
  globalZipSettings,
  voiceState,
  userSettings,
  userDisplayName,
  userId,
  eventFetch,
  request,
  gatewayAuthority,
  groupConfig,
  userMessageId = null,
  turnStopSignal = null,
}: BatshitStreamParams & {
  groupConfig: GroupChatSessionConfig
  userDisplayName?: string
  userMessageId?: string | null
}): Promise<Response> {
  const normalizedConfig = normalizeGroupChatConfig(groupConfig)
  if (!normalizedConfig?.enabled) {
    const result = await handleBatshitAgentStream({
      content,
      sessionId,
      agent,
      agentId,
      messages,
      metadata,
      batshitInput,
      globalZipSettings,
      voiceState,
      userSettings,
      userId,
      eventFetch,
      request,
      gatewayAuthority,
      turnStopSignal,
    })
    return result.response
  }

  const groupAbortController = new AbortController()
  registerGroupAbort(sessionId, groupAbortController)
  // A Stop or a delete that landed before this group run registered stopped the turn itself;
  // every speaker's run listens to the group's controller, so it is carried there. BL-246: the
  // relay is taken back when the group run ends (`groupListeners.abort()` in its `finally`).
  const groupListeners = new AbortController()
  relayAbort({ from: turnStopSignal, to: groupAbortController, reason: sourceAbortReason, until: groupListeners.signal })

  try {
    const allAgents = await redis.getAgents(userId)
    const agentById = new Map(allAgents.map((row) => [row.id, row]))
    const maxAgents =
      normalizedConfig.max_agents ?? GROUP_CHAT_SESSION_DEFAULTS.max_agents ?? 4
    const uniqueAgentIds = Array.from(
      new Set(normalizedConfig.agent_ids),
    ).slice(0, maxAgents)

    const groupAgents = uniqueAgentIds
      .map((id) => agentById.get(id))
      .filter((row): row is AgentRow => Boolean(row))

    if (!groupAgents.some((row) => row.id === agentId)) {
      groupAgents.unshift(agent)
      if (groupAgents.length > maxAgents) {
        groupAgents.pop()
      }
    }

    const eligibleAgents = groupAgents.filter((row) =>
      isManagedPrimaryAgentType(normalizePrimaryAgentType(row)),
    )

    if (eligibleAgents.length < 2) {
      return json(
        { error: 'Group chat requires at least 2 API or CLI agents.' },
        { status: 400 },
      )
    }

    // SA-129 P2 (DL-08): the user's message counts toward every temporary hold's countdown once,
    // here, before any member compiles; each member's reply counts at its own reply end.
    // BL-412: only for a round that runs, so after the refusal above and not after a Stop or a
    // delete that already landed (the relay above carried it into the group's signal).
    if (!groupAbortController.signal.aborted) {
      const countdown = await advanceZipCountdowns(sessionId)
      if (countdown.counted.length > 0 || countdown.ended.length > 0) {
        await publishUserEvent(userId, {
          type: 'zip_state_changed',
          sessionId,
          source: 'countdown',
          opened: [],
          rezipped: [],
        })
      }
    }

    // BL-600: the Clip countdown is spent once for this user message, when the round has ended
    // and only for the Clips its first compile read (`createGroupRoundClipSpend`), so a "next
    // message only" Clip reaches every speaker of the round. A group chat is never woken, so no
    // woken-turn check is needed here (`agentWakeups.ts`, `session_is_group`).
    const groupRoundClipSpend = createGroupRoundClipSpend({
      readCountdownClipIds: () => readCountdownClipIds(sessionId),
      spend: (clipIds) => consumePostCompileSessionClips(sessionId, clipIds),
    })

    const groupTurnId = crypto.randomUUID()
    const maxFollowupsTotal =
      normalizedConfig.max_followups_total ??
      GROUP_CHAT_SESSION_DEFAULTS.max_followups_total ??
      5
    const driverMode = normalizedConfig.driver_mode === true
    const driverAgentId =
      driverMode &&
      normalizedConfig.driver_agent_id &&
      eligibleAgents.some((row) => row.id === normalizedConfig.driver_agent_id)
        ? normalizedConfig.driver_agent_id
        : driverMode
          ? (eligibleAgents[0]?.id ?? null)
          : null
    const resolvedUserName = userDisplayName?.trim() || userId
    const agentOrder = eligibleAgents.map((row) => row.id)
    const agentDisplayNames = Object.fromEntries(
      eligibleAgents.map((row) => [row.id, row.displayName || row.id]),
    )
    const speakPolicies: Record<
      string,
      { speak_policy: GroupChatSpeakPolicy; speak_topics: string[] }
    > = {}
    for (const agentRow of eligibleAgents) {
      const settings = normalizedConfig.agent_settings?.[agentRow.id] ?? {}
      speakPolicies[agentRow.id] = {
        speak_policy: (settings.speak_policy ??
          'balanced') as GroupChatSpeakPolicy,
        speak_topics: Array.isArray(settings.speak_topics)
          ? settings.speak_topics
          : [],
      }
    }
    const groupContextBase = {
      agentOrder,
      agentDisplayNames,
      currentAgentId: null,
      userDisplayName: resolvedUserName,
      speakPolicies,
      driverMode,
      driverAgentId,
      maxFollowupsTotal,
    }
    const normalizeSharedTools = (value: unknown) => {
      if (!Array.isArray(value)) return []
      return value
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry) => entry.length > 0)
    }

    const groupSharedTools = normalizeSharedTools(normalizedConfig.shared_tools)
    const sharedGlobalZipSettings = globalZipSettings

    const fullMessages = Array.isArray(messages) ? messages : []
    const baseHistoryMessages = fullMessages.slice(0, -1)
    const initialUserMessage = fullMessages[fullMessages.length - 1] ?? {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      session_id: sessionId,
      agent_id: agentId,
      user_id: userId,
      created_at: new Date().toISOString(),
      timestamp: new Date().toISOString(),
    }
    // The body names a candidate id only. The no-reply writer verifies the actual saved
    // owner/role/content and list membership before using it; never use the invented fallback.
    const sourceUserMessageId = userMessageId || null
    let replySkipped = false
    let replyOutcome: 'skipped' | 'unconfirmed' | null = null
    let replyRunsStarted = 0

    const assistantHistory: ChatMessage[] = []

    const sanitizeGroupHistoryMessage = (message: ChatMessage): ChatMessage => {
      if (message?.role !== 'assistant') return message
      const rawContent = typeof message.content === 'string' ? message.content : ''
      const cleanedContent = stripGroupChatPresentationControls(rawContent)
      return cleanedContent === rawContent ? message : { ...message, content: cleanedContent }
    }

    type GroupChatEvent = {
      type: 'user' | 'agent'
      content: string
      eventIndex: number
      sourceAgentId?: string
      sourceAgentName?: string
      /** SA-120 P3: the previous speaker's message id, where a skipped follow-up's Jev record lands. */
      sourceMessageId?: string
    }

    const pendingEvents: GroupChatEvent[] = [
      { type: 'user', content, eventIndex: 1 },
    ]
    let totalFollowups = 0
    let scheduledFollowups = 0
    let eventIndex = 1
    let queueRunning = false

    // BL-208: on the user's own event the user message IS the current message, so it is not
    // history as well; every later event sees it as history before the replies to it.
    const buildHistoryMessages = (event: GroupChatEvent) => [
      ...baseHistoryMessages.map(sanitizeGroupHistoryMessage),
      ...(event.type === 'user' ? [] : [initialUserMessage]),
      ...assistantHistory,
    ]

    const buildEventPrompt = (event: GroupChatEvent) =>
      event.type === 'user'
        ? event.content
        : buildInterAgentPrompt({
            sourceAgentName: event.sourceAgentName,
            message: event.content,
          })

    const canScheduleFollowup = () => {
      if (maxFollowupsTotal <= 0) {
        return true
      }
      if (maxFollowupsTotal > 0 && totalFollowups >= maxFollowupsTotal) {
        return false
      }
      if (
        maxFollowupsTotal > 0 &&
        totalFollowups + scheduledFollowups >= maxFollowupsTotal
      ) {
        return false
      }
      return true
    }

    const scheduleEvent = async (event: GroupChatEvent) => {
      if (groupAbortController.signal.aborted) {
        return
      }

      const historyMessages = buildHistoryMessages(event)
      const eventPrompt = buildEventPrompt(event)

      const assistantContextText = assistantHistory
        .map((message) => message.content)
        .filter(Boolean)
        .join('\n\n')

      const candidates: Array<{
        agent: AgentRow
        agentName: string
        speakPolicy: GroupChatSpeakPolicy
        speakTopics: string[]
        isDriver: boolean
        isFollowupEvent: boolean
      }> = []

      for (const agentRow of eligibleAgents) {
        if (event.type === 'agent' && event.sourceAgentId === agentRow.id) {
          continue
        }

        const isFollowupEvent = event.type === 'agent'
        const policyRecord = speakPolicies[agentRow.id] ?? {
          speak_policy: 'balanced' as GroupChatSpeakPolicy,
          speak_topics: [],
        }
        const speakPolicy = policyRecord.speak_policy
        const speakTopics = policyRecord.speak_topics
        const agentName = agentRow.displayName || agentRow.id
        const isDriver = driverMode && driverAgentId === agentRow.id

        const topicContext = [eventPrompt, assistantContextText]
          .filter(Boolean)
          .join('\n\n')
        if (!isDriver) {
          if (
            speakPolicy === 'only_when_asked' &&
            !isAgentAddressed(topicContext, agentName, [
              agentRow.id,
              agentRow.slug ?? '',
            ])
          ) {
            continue
          }
          if (
            speakPolicy === 'topic_only' &&
            !matchesTopic(topicContext, speakTopics)
          ) {
            continue
          }
        }
        if (isFollowupEvent && !canScheduleFollowup()) {
          continue
        }

        candidates.push({
          agent: agentRow,
          agentName,
          speakPolicy,
          speakTopics,
          isDriver,
          isFollowupEvent,
        })
      }

      if (candidates.length === 0) return

      const pickRandom = <T>(list: T[]) => list[randomInt(list.length)]
      const addressedCandidates =
        event.type === 'user'
          ? candidates.filter((candidate) =>
              isAgentAddressed(eventPrompt, candidate.agentName, [
                candidate.agent.id,
                candidate.agent.slug ?? '',
              ]),
            )
          : []
      const driverCandidate =
        driverMode && driverAgentId
          ? (candidates.find(
              (candidate) => candidate.agent.id === driverAgentId,
            ) ?? null)
          : null

      // SA-120 P3: Judge Juice is asked only when a `smart` candidate exists AND today's rules
      // do not already decide the speaker (explicit beats inferred, DL-120-04): exactly
      // one addressed agent or an eligible driver. Several names still forbid silence,
      // while Jev may choose among those named candidates. A lone unaddressed Smart candidate still
      // needs the call, on either event type: it can be skipped (AMD-120-09). Jev never sees the
      // candidates the preset rules above already excluded.
      const rulesDecide =
        Boolean(driverCandidate) ||
        (event.type === 'user' &&
          addressedCandidates.length === 1)
      const selectionCandidates = addressedCandidates.length > 1 && !driverCandidate
        ? addressedCandidates
        : candidates
      const smartCandidatePresent = selectionCandidates.some(
        (candidate) => candidate.speakPolicy === GROUP_SPEAK_POLICY_SMART,
      )
      let jevOutcome: GroupSpeakerOutcome | null = null
      let groupCallAlreadyRecorded = false
      let eligible = selectionCandidates
      if (smartCandidatePresent && !rulesDecide) {
        // Jev receives text only. Never treat unseen files/media/skills/Clip delivery as
        // evidence that the user needs no answer. Read state without compiling/consuming it;
        // an unreadable state is uncertain and therefore cannot authorize silence.
        let allowUserNoReply = true
        if (event.type === 'user') {
          const hasInput = (value: unknown) => value != null && (!Array.isArray(value) || value.length > 0)
          allowUserNoReply = addressedCandidates.length === 0 && !batshitInput && !isSkillInvocationMessage(event.content) &&
            collectTrustedClipIdsFromMetadata(metadata).length === 0 &&
            !['fileReferences', 'clipIds', 'attachments', 'images', 'files', 'skills', 'skillInvocation'].some((key) => hasInput(metadata?.[key]))
          if (allowUserNoReply) {
            try {
              const clipState = await redis.get(`session:${sessionId}:clip_state`)
              allowUserNoReply = clipState == null || (Array.isArray(clipState.clips) && clipState.clips.length === 0)
            } catch {
              allowUserNoReply = false
            }
          }
        }
        const request = buildGroupSpeakerRequest({
          eventType: event.type,
          message: event.content,
          allowUserNoReply,
          spokeLast:
            event.type === 'user'
              ? `the user (${resolvedUserName})`
              : `${event.sourceAgentName ?? 'another agent'} (an agent in this group)`,
          earlierThisTurn: assistantHistory.map((message) => ({
            name:
              agentDisplayNames[message.agent_id ?? ''] ??
              message.agent_id ??
              'an agent',
            content: typeof message.content === 'string' ? message.content : '',
          })),
          candidates: selectionCandidates.map(
            (candidate): GroupSpeakerCandidate => ({
              agentId: candidate.agent.id,
              name: candidate.agentName,
              about: resolveGroupSpeakerAbout(candidate.agent),
              preset: candidate.speakPolicy,
              topics: candidate.speakTopics,
            }),
          ),
        })
        if (request) {
          jevOutcome = await computeGroupSpeakerSelection({
            userId,
            request,
            signal: groupAbortController.signal,
          })
          if (groupAbortController.signal.aborted) return
          if (jevOutcome.decision) {
            const remainingIds = new Set(
              jevOutcome.decision.remaining.map((reading) => reading.agentId),
            )
            eligible = selectionCandidates.filter((candidate) =>
              remainingIds.has(candidate.agent.id),
            )
            if (eligible.length === 0) {
              if (event.type === 'agent') {
                // A follow-up still owns the previous speaker's snapshot.
                await recordSkippedGroupFollowup(sessionId, event.sourceMessageId ?? null, jevOutcome.record)
                return
              }
              // A user event has no speaker or stream. Save its own verified receipt and EV
              // entry before ending it. Only a definitively refused stamp may use the rules;
              // an uncertain mutation ends with no agent so a late stamp cannot contradict a reply.
              const recorded = await recordSkippedGroupUserReply({
                userId, sessionId, messageId: sourceUserMessageId, content: event.content,
                groupTurnId, eventIndex: event.eventIndex, outcome: jevOutcome,
                signal: groupAbortController.signal,
              })
              groupCallAlreadyRecorded = recorded.evidenceRecorded
              if (groupAbortController.signal.aborted) return
              if (recorded.outcome === 'stopped') return
              if (recorded.outcome === 'skipped' || recorded.outcome === 'unconfirmed') {
                replySkipped = recorded.outcome === 'skipped'
                replyOutcome = recorded.outcome
                await publishUserEvent(userId, { type: 'session_messages_changed', sessionId, reason: recorded.outcome === 'skipped' ? 'group_reply_skipped' : 'group_reply_unconfirmed' })
                return
              }
              const record = {
                ...jevOutcome.record,
                decision: `${jevOutcome.record.decision?.replace('→ user reply skipped', '→ no reply proposed')}; skip receipt refused → usual rules`,
              }
              // SA-120 P10b: the note names the judge whose answer could not be saved (its call row knows it).
              jevOutcome = { decision: null, record, note: {
                feature: 'group_speaker', status: 'not_applied', reason: 'receipt_not_saved', at: record.at,
                ...(record.provider ? { provider: record.provider } : {})
              } }
              eligible = selectionCandidates
            }
          }
        }
      }
      const jevPickedAgentId = jevOutcome?.decision?.picked?.agentId ?? null

      let selected = eligible.length === 1 ? eligible[0] : null
      if (!selected && addressedCandidates.length === 1) {
        selected = addressedCandidates[0]
      }
      if (!selected && driverCandidate) {
        selected = driverCandidate
      }
      if (!selected && jevPickedAgentId) {
        selected =
          eligible.find((candidate) => candidate.agent.id === jevPickedAgentId) ??
          null
      }
      if (!selected) {
        // BL-1287: a rules fallback for several names must not pick an unnamed member.
        const namedEligible = eligible.filter((candidate) => addressedCandidates.includes(candidate))
        selected = pickRandom(namedEligible.length > 0 ? namedEligible : eligible)
      }

      const speakerSelection: GroupSpeakerSelectionMetadata | null = jevOutcome
        ? jevOutcome.note?.reason === 'receipt_not_saved'
          ? { by: 'rules', reason: 'receipt_not_saved', skipped: [] }
          : buildGroupSpeakerSelectionMetadata(jevOutcome, selected.agent.id)
        : null
      const jevJuiceGroupSelection: GroupSpeakerProviderInput | null = jevOutcome
        ? {
            lines: jevOutcome.decision
              ? buildGroupSpeakerDcmLines(jevOutcome.decision, selected.agent.id, judgeNameOfCallRecord(jevOutcome.record))
              : [],
            record: groupCallAlreadyRecorded ? null : jevOutcome.record,
            note: jevOutcome.note,
          }
        : null

      // BL-965: the round read its members when it began; each speaker's record is read again
      // when its turn starts, so a member made tighter during the round (Settings, the chat bar)
      // runs with its record as it is now. A member deleted during the round (or that can no
      // longer be read, or is no longer an API or CLI agent) does not run: its turn is saved as a
      // failed reply that says so, nothing is counted, and no event follows.
      const agentRow = await readAgentRecordForTurn(userId, selected.agent.id)
      if (!agentRow || !isManagedPrimaryAgentType(normalizePrimaryAgentType(agentRow))) {
        console.warn('[GroupChat] A speaker was deleted or changed during the round; it does not run.', {
          sessionId,
          agentId: selected.agent.id,
        })
        if (jevOutcome && !groupCallAlreadyRecorded) {
          await recordSkippedGroupFollowup(sessionId, event.sourceMessageId ?? null, jevOutcome.record)
        }
        const failedSpeakerMessageId =
          (await generateMessageId(sessionId)) ?? `msg_${crypto.randomUUID()}`
        await persistFailedAssistantTurn({
          sessionId,
          userId,
          agentId: selected.agent.id,
          messageId: failedSpeakerMessageId,
          message: `${selected.agentName} was deleted or changed before its turn in this round, so it did not answer.`,
          noStreamEvent: true,
          code: 'AGENT_NOT_FOUND',
          status: 404,
          metadata: {
            agentType: normalizePrimaryAgentType(selected.agent),
            groupChat: true,
            groupTurnId,
            group_turn_id: groupTurnId,
            group_event_index: event.eventIndex,
            eventType: event.type,
            failedSpeakerAgentId: selected.agent.id,
            failedSpeakerName: selected.agentName,
          },
        })
        return
      }
      const agentName = selected.agentName
      const speakPolicy = selected.speakPolicy
      const speakTopics = selected.speakTopics
      const isDriver = selected.isDriver
      const isFollowupEvent = selected.isFollowupEvent
      const selectedMessageId =
        (await generateMessageId(sessionId)) ?? `msg_${crypto.randomUUID()}`

      const perAgentMetadata = {
        ...(metadata ?? {}),
        agent: agentRow,
      }
      const groupPromptRaw = normalizedConfig.group_system_prompt?.trim()
      const groupPromptBlock = groupPromptRaw
        ? `==== GROUP CHAT CUSTOM PROMPT ====\n\n${replacePromptVariables(
            groupPromptRaw,
            agentRow,
          )}`.trim()
        : null
      const systemPromptAddendum = [
        groupPromptBlock,
        buildGroupSystemPromptAddendum({
          agentName,
          policy: speakPolicy,
          topics: speakTopics,
          eventIndex: event.eventIndex,
          driverMode,
          driverAgentName: driverAgentId
            ? (eligibleAgents.find((row) => row.id === driverAgentId)
                ?.displayName ?? driverAgentId)
            : null,
          isDriver,
        }),
      ]
        .filter(Boolean)
        .join('\n\n')

      const syntheticUserMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: eventPrompt,
        session_id: sessionId,
        agent_id: agentRow.id,
        user_id: userId,
        created_at: new Date().toISOString(),
        timestamp: new Date().toISOString(),
        metadata: {
          group_turn_id: groupTurnId,
          group_event_index: event.eventIndex,
          group_event_type: event.type,
        },
      }

      const agentMessages = [...historyMessages, syntheticUserMessage]

      const streamMetadata = {
        groupChat: true,
        groupTurnId,
        group_turn_id: groupTurnId,
        eventIndex: event.eventIndex,
        group_event_index: event.eventIndex,
        groupLayout: normalizedConfig.layout,
        group_layout: normalizedConfig.layout,
        speakPolicy,
        speakTopics,
        eventType: event.type,
        eventSourceAgentId: event.sourceAgentId ?? null,
        eventSourceAgentName: event.sourceAgentName ?? null,
        driverMode,
        driverAgentId,
        driver_mode: driverMode,
        driver_agent_id: driverAgentId,
        // SA-120 P3: who chose this speaker and whom Judge Juice skipped (only when the lane ran).
        ...(speakerSelection ? { speakerSelection } : {}),
      }

      if (isFollowupEvent) {
        scheduledFollowups += 1
      }

      const groupContext = {
        ...groupContextBase,
        currentAgentId: agentRow.id,
      }

      const databaseService = new DatabaseService(eventFetch)
      const sharedHistory = await databaseService.prepareGroupHistory(
        sessionId,
        historyMessages,
        agentRow,
        userId,
        {
          fetch: eventFetch,
          groupContext,
          groupToolSharing: {
            currentAgentId: agentRow.id,
            sharedTools: groupSharedTools,
          },
        },
      )
      const sharedZipSettings =
        sharedHistory.globalZipSettings ?? sharedGlobalZipSettings

      replyRunsStarted += 1
      const streamPromise = handleBatshitAgentStream({
        content: eventPrompt,
        sessionId,
        agent: agentRow,
        agentId: agentRow.id,
        messageId: selectedMessageId,
        messages: agentMessages,
        metadata: perAgentMetadata,
        batshitInput,
        abortSignal: groupAbortController.signal,
        globalZipSettings: sharedZipSettings,
        precompiledHistory: sharedHistory,
        streamMetadata,
        systemPromptAddendum,
        groupContext,
        voiceState,
        userSettings,
        userId,
        eventFetch,
        request,
        gatewayAuthority,
        consumeSessionClips: false,
        groupRoundClipSpend,
        jevJuiceGroupSelection,
        currentMessageFrom: resolveCurrentMessageFrom({
          metadata,
          groupEventType: event.type,
        }),
      })

      try {
        const result = await streamPromise
        const groupContent = stripGroupChatPresentationControls(result?.content ?? '')
        if (groupContent.trim()) {
          assistantHistory.push({
            id: result.messageId,
            session_id: sessionId,
            user_id: userId,
            // BL-209: the SPEAKER's id. The stream result carries no agent id, and the
            // request's `agentId` is the chat's agent, so a later speaker in this same
            // round would read this reply as its own (`<assistant>`, SA-128).
            agent_id: agentRow.id,
            role: 'assistant',
            content: groupContent,
            created_at: new Date().toISOString(),
            metadata: result.metadata,
          })

          if (isFollowupEvent) {
            totalFollowups += 1
          }

          if (maxFollowupsTotal <= 0 || totalFollowups < maxFollowupsTotal) {
            eventIndex += 1
            pendingEvents.push({
              type: 'agent',
              content: groupContent,
              eventIndex,
              sourceAgentId: agentRow.id,
              sourceAgentName: agentName,
              sourceMessageId: result.messageId,
            })
          }
        }
      } catch (error) {
        console.warn('[GroupChat] Agent stream failed.', {
          agentId: agentRow.id,
          agentName,
          messageId: selectedMessageId,
          error,
        })
        if (!groupAbortController.signal.aborted) {
          await persistFailedAssistantTurn({
            sessionId,
            userId,
            agentId: agentRow.id,
            messageId: selectedMessageId,
            message: getFailureMessage(error),
            // API setup may fail before any start/error event exists for spectators.
            noStreamEvent: true,
            details:
              error instanceof Error
                ? error.stack || error.message
                : String(error ?? ''),
            code: getFailureCode(error),
            status: getFailureStatus(error),
            metadata: {
              agentType: normalizePrimaryAgentType(agentRow),
              groupChat: true,
              groupTurnId,
              group_turn_id: groupTurnId,
              group_event_index: event.eventIndex,
              eventType: event.type,
              failedSpeakerAgentId: agentRow.id,
              failedSpeakerName: agentName,
            },
          })
        }
      } finally {
        if (isFollowupEvent) {
          scheduledFollowups = Math.max(0, scheduledFollowups - 1)
        }
      }
    }

    const drainQueue = async () => {
      if (queueRunning) return
      queueRunning = true
      while (pendingEvents.length > 0) {
        if (groupAbortController.signal.aborted) {
          break
        }
        const nextEvent = pendingEvents.shift()
        if (nextEvent) {
          await scheduleEvent(nextEvent)
        }
      }
      queueRunning = false
    }

    // BL-600: the round's last speaker is known only now, so its one Clip spend comes here.
    await drainGroupRoundThenSpend(drainQueue, groupRoundClipSpend)

    return json({
      success: true,
      groupTurnId,
      replySkipped,
      replyOutcome,
      userMessageId: sourceUserMessageId,
      noReplyStream: replyRunsStarted === 0,
      eventsProcessed: eventIndex,
      followupsCompleted: totalFollowups,
    })
  } finally {
    groupListeners.abort()
    clearGroupAbort(sessionId)
  }
}

/**
 * The chat is being deleted, or was deleted while this request waited (2026-09-18). The same
 * answer a send gets for a chat that is gone; the code tells the two apart for a reader.
 */
function sessionDeletedResponse() {
  return json(
    {
      error: 'Session not found or unauthorized',
      code: 'session_deleted',
      details: 'This chat was deleted.',
    },
    { status: 404 },
  )
}

/**
 * BL-4 — post a chat event to `/api/sse` for every tab on the chat: a queued send's bubble, the
 * message it saved coming back at the end, and its promotion. The steer route's own shape
 * (addressed by `request.url`: this only runs inside a send the user's own browser made), and
 * never able to fail the send it reports on. Bounded (BL-204): the send's later events and its
 * final answer wait for its "Queued" forward, so a forward that never answered held the chat.
 */
async function forwardQueuedSendEvent(
  request: Request,
  event: Record<string, unknown>,
): Promise<void> {
  try {
    await fetch(new URL('/api/sse', request.url).toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-sse-forward': '1',
        ...internalServiceHeaders(),
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(QUEUED_SEND_FORWARD_LIMIT_MS),
    })
  } catch (error) {
    console.warn('[BL-4] Could not forward a queued send event to SSE:', {
      type: event.type,
      sessionId: event.sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * A browser send is answered once the server owns its turn (2026-09-18).
 *
 * The page awaited this request until the whole turn was over, so each running reply held one
 * of the browser's six HTTP/1.1 connections to this server, shared by every tab: five replies at
 * once froze every other request, Stop included (`_local/sconn-proof/fivetabs-before.json`). A
 * send that asks (`Prefer: respond-async`) is answered `202 {turnId}` the moment its session-turn
 * lock is registered, the turn runs on here exactly as before, and its final answer reaches the
 * tab over the live hub (`respondAsyncSend.ts`, `turnOutcomeRegistry.ts`). Every refusal before
 * the lock is still the direct answer. A send that does not ask (a woken turn, the voice turn
 * route, artifact share, the dev smoke runner) is answered at the end of the turn, as always.
 */
export const POST: RequestHandler = async (event) => {
  if (!prefersRespondAsync(event.request)) {
    return handleSendRoutedRequest(event)
  }
  return answerWhenTurnAccepted(
    (acceptTurn) => handleSendRoutedRequest(event, acceptTurn),
    { holdWork: enterBackupRestoreHttpRequest },
  )
}

async function handleSendRoutedRequest(
  { request, fetch: eventFetch, locals }: RequestEvent,
  acceptTurn: AcceptTurn | null = null,
): Promise<Response> {
  // BL-4: a queued send's "Queued" forward, fired before it waits and never awaited there. Every
  // answer this request gives waits for it (the `finally` at the end), so the sending tab's
  // `turn_over` never overtakes the `steer_queued` it answers: a way out that did not wait (the
  // chat or the message deleted while it waited, a delete that cancelled the line) left a
  // Queued bubble on screen for a send that was already over (BL-202).
  let queuedNoticeSent: Promise<void> | null = null
  const planOwner: RequestPlanOwner = { leases: new Set(), listeners: new AbortController() }
  requestPlanOwners.set(request, planOwner)
  try {
    const body = await request.json()
    const {
      content: rawContent,
      sessionId,
      agentId,
      messageId: requestedMessageId = null,
      messages,
      agentType, // Story 6.8d: Extract agentType instead of mode
      batshitInput = null,
      metadata = null,
      userId: requestedUserId = null,
      // BL-4: the id of the user message the page saved before it posted this send.
      userMessageId: requestedUserMessageId = null,
    } = body
    let content =
      typeof rawContent === 'string'
        ? neutralizeAllZipReferenceSyntax(rawContent)
        : rawContent

    const internalRequest = isTrustedInternalRequest(request)
    const internalUserId =
      internalRequest && typeof requestedUserId === 'string'
        ? requestedUserId.trim()
        : ''
    const resolvedUserId = locals.user?.id ?? internalUserId

    if (!resolvedUserId) {
      return json({ error: 'Unauthorized' }, { status: 401 })
    }

    const approvalResponse = normalizeToolApprovalResponses(
      metadata?.toolApprovalResponse ?? metadata?.tool_approval_response,
    )
    const hasApprovalResponse = approvalResponse.length > 0
    let approvalResponseForStream = approvalResponse

    // BL-713: Send now on a message waiting in the chat's line names it by id (`userMessageId`);
    // its bubble may show no words (a Clip alone), so it needs none of its own.
    const waitingSendNowRequest = body?.waitingSendNow === true
    if ((!content && !hasApprovalResponse && !waitingSendNowRequest) || !sessionId || !agentId) {
      return json(
        {
          error:
            'Missing required fields: content (or tool approval response), sessionId, and agentId are required',
        },
        { status: 400 },
      )
    }

    // Get the agent to verify ownership and get agentType
    // Use Redis directly instead of DatabaseService to avoid circular API calls
    const agents = await redis.getAgents(resolvedUserId)
    const firstReadAgent = agents.find((a) => a.id === agentId)

    if (!firstReadAgent) {
      return json({ error: 'Agent not found' }, { status: 404 })
    }

    if (firstReadAgent.user_id !== resolvedUserId) {
      return json({ error: 'Unauthorized to use this agent' }, { status: 403 })
    }
    // BL-965: read again under the chat's lock and before each later turn of this request.
    let agent: AgentRow = firstReadAgent

    let globalZipSettings: Record<string, any> | undefined
    let userDisplayName: string | undefined
    let userSettings: UserSettingsRow | null = null
    try {
      userSettings = await redis.getUserSettings(resolvedUserId)
      globalZipSettings = userSettings?.global_zip_settings || undefined
      userDisplayName =
        typeof userSettings?.displayName === 'string'
          ? userSettings.displayName.trim()
          : undefined
    } catch (error) {
      console.error('[send-routed] Failed to load user zip settings:', error)
    }

    // Resolve the primary-agent type from the request override, else the stored record.
    const finalAgentType = normalizePrimaryAgentType(agent, agentType)

    // SA-106 DL-106-03: the `n8n` primary-agent type is retired. Any send that resolves
    // to it fails loudly here — before the session-turn lock, clip consumption, memory
    // commit, or any compile — so a stray record can never half-run. Both the resolved
    // type AND the stored record are checked: `agentType` arrives from the request body
    // and outranks the record (primaryAgentType.ts), so checking only the resolved value
    // would let a client override its way past the guard on a retired agent.
    if (
      isN8nPrimaryAgentType(finalAgentType) ||
      isN8nPrimaryAgentType(normalizePrimaryAgentType(agent))
    ) {
      return json(
        {
          error: 'The n8n Primary Agent type was removed from Batshit.',
          code: 'primary_agent_type_retired',
          details:
            'This agent uses the retired n8n Primary Agent type. Delete this agent and create an API or CLI agent instead. n8n is still fully supported as a tool platform: n8n tool workflows and n8n Workflow Subagents are unchanged.',
        },
        { status: 409 },
      )
    }

    // Load session metadata for group chat configuration
    const session = await redis.getSession(sessionId)
    if (!session || session.user_id !== resolvedUserId) {
      return json(
        { error: 'Session not found or unauthorized' },
        { status: 404 },
      )
    }
    // SA-113 F-SEC-1b — a reply from the user clears "needs you" on every open DM whose
    // woken turn landed in THIS chat. Keyed on the DM's own `delivery.sessionId`, NOT on the
    // session carrying an origin: a "One at a time" wake lands in a chat the user started,
    // which has no origin (F-P5b-1). Only a DM-enabled agent's sends pay the one inbox
    // read. `metadata.wake` marks the wake primitive's own POST, which is the one send here
    // that is NOT the user.
    //
    // Fire-and-forget with its own catch: a badge that failed to clear must never be able to
    // fail the send it was reporting on.
    const sendingAgent = agents.find((candidate) => candidate.id === agentId)
    if (!metadata?.wake && sendingAgent && resolveAgentDmsEnabled(sendingAgent)) {
      void clearNeedsUserForHumanReply(agentId, sessionId).catch((error) => {
        console.warn('[Agent DMs] Could not clear a "needs you" stamp after a user reply:', error)
      })
    }
    const fixedSessionAgentId = resolveFixedSessionAgentId(session)
    if (fixedSessionAgentId && fixedSessionAgentId !== agentId) {
      const fixedAgentExists = agents.some((candidate) => candidate.id === fixedSessionAgentId)
      return json(
        {
          error: fixedAgentExists
            ? 'This Infinite Session belongs to a different agent.'
            : 'This Infinite Session\'s saved agent no longer exists.',
          code: fixedAgentExists
            ? 'FIXED_SESSION_AGENT_MISMATCH'
            : 'FIXED_SESSION_AGENT_MISSING',
          details: fixedAgentExists
            ? `Switch back to agent ${fixedSessionAgentId} before continuing this Infinite Session.`
            : 'Delete this Infinite Session or restore its saved agent before continuing. Batshit will not silently attach a different agent.'
        },
        { status: 409 }
      )
    }
    if (typeof content === 'string') {
      content = neutralizeUntrustedClipReferenceSyntax(content, {
        trustedClipIds: await collectTrustedClipIdsForSession(sessionId, metadata),
      })
    }
    const rawGroupMeta = session?.metadata?.group_chat ?? null
    let groupConfig: GroupChatSessionConfig | null = null
    const groupId =
      rawGroupMeta &&
      typeof rawGroupMeta === 'object' &&
      typeof rawGroupMeta.group_id === 'string'
        ? rawGroupMeta.group_id
        : null

    if (groupId) {
      const group = await redis.getGroup(groupId)
      if (group && group.user_id === resolvedUserId) {
        groupConfig = normalizeGroupChatConfig({
          enabled: true,
          agent_ids: group.agent_ids,
          agent_settings: group.agent_settings,
          group_system_prompt: group.group_system_prompt,
          max_followups_total: group.max_followups_total,
          max_agents: group.max_agents,
          driver_mode: group.driver_mode,
          driver_agent_id: group.driver_agent_id,
          shared_tools: group.shared_tools,
          zip_settings: group.zip_settings,
        })
      }
    }

    // SA-104 P5 (DL-104-12): Infinite Sessions refuse group entry — the server-side
    // backstop behind the group-picker guard and the fixed-transition group check.
    if (groupConfig && isFixedSession(session)) {
      return json(
        {
          error: 'Infinite Sessions do not support group chat.',
          code: 'FIXED_SESSION_GROUP_UNSUPPORTED',
          details:
            'This chat is an Infinite Session (one agent, one ongoing conversation). Use a regular session for group chat.',
        },
        { status: 409 },
      )
    }

	    const sessionTurnKind = groupConfig ? 'group' : 'single'
    // An Approve or Deny click belongs to the reply that raised its card, and that reply
    // keeps this lock through its after-reply work while the card is already on screen. So
    // the click waits for it rather than being refused as a second turn — never for a lock
    // that is itself answering an approval (`approvalClickWait.ts`). ABOVE the check, so the
    // check and the registration below stay one synchronous block.
    const approvalClick = isApprovalClick({
      approvalResponseCount: approvalResponse.length,
      content,
    })
    const gatewayAuthority: TurnMcpGatewayAuthority = {
      humanSelection: Boolean(locals.user?.id) && !internalRequest &&
        !request.headers.has('x-batshit-agent-token') && !approvalClick,
      ...(approvalClick ? {
        resumedScope: readTurnMcpGatewaySnapshot(
          typeof requestedMessageId === 'string'
            ? await executionViewerService.getSnapshot(sessionId, requestedMessageId)
            : null,
          { userId: resolvedUserId, sessionId, agentId },
        ),
      } : {}),
    }
    // BL-455: the message a click's card is on. The words the user typed before the card are held
    // under this id, and this request answers them when the resumed reply is over. Only for the
    // user's own click (Faye, 2026-09-27): the page's automatic Deny of an expired card ends the card
    // and its tool call and nothing more (`isExpiryOnlyAnswer`; the held message says so instead).
    const cardMessageId =
      approvalClick && typeof requestedMessageId === 'string' && requestedMessageId.trim()
        ? requestedMessageId.trim()
        : null
    const expiryOnlyAnswer = approvalClick && isExpiryOnlyAnswer(approvalResponse)
    const answeredCardMessageId = expiryOnlyAnswer ? null : cardMessageId
    // BL-410: a group chat never resumes an approval. Refused before the click waits, takes the
    // turn lock, is recorded, or reaches the group runner (where it started a new round and spent
    // the Clip and hold countdowns), so a card from before the fix spends nothing.
    // The same test as the group dispatch below: a "group" of fewer than two runs single-agent.
    const groupRunnerSession = Boolean(
      groupConfig && Array.isArray(groupConfig.agent_ids) && groupConfig.agent_ids.length >= 2,
    )
    if (refusesGroupApprovalClick({ groupSession: groupRunnerSession, approvalClick })) {
      return json(GROUP_APPROVAL_CLICK_REFUSAL, { status: 409 })
    }
    // BL-4 (the line, below): only the page's own ordinary send may wait in it. BL-713: Send now
    // names a message already waiting in the line; its bubble may show no words (a Clip alone),
    // and the message it names is what counts.
    const namedUserMessageId =
      typeof requestedUserMessageId === 'string' ? requestedUserMessageId.trim() : ''
    const queueableSend = isQueueableSend({
      prefersRespondAsync: acceptTurn !== null,
      approvalClick,
      hasUserContent: sendCarriesUserTurn(content) || waitingSendNowRequest,
      userMessageId: namedUserMessageId,
      wake: metadata?.wake,
    })
    if (approvalClick) {
      const clickWait = await waitForCardReplyToFinish(sessionId, requestedMessageId)
      if (clickWait !== 'no_wait') {
        logger.debug('[Send-Routed] Approval click waited for the reply that raised its card', {
          sessionId,
          messageId: requestedMessageId,
          outcome: clickWait,
        })
      }
    } else if (queueableSend && sentWhileReplyRan(messages, requestedMessageId)) {
      // BL-906 (b): made while its tab still drew the reply (its history holds that reply as a
      // placeholder; its own reply placeholder does not count), so it belongs behind that reply. It joins the line below even if the reply's
      // request is only finishing, and a card that reply raised holds it there (BL-713). Waiting
      // here instead, it would meet a free chat and run beside the card, or end the line's hold.
    } else {
      // Anything else that is not a click — a message the browser queued behind the reply, a
      // send from another tab, a woken turn, a voice turn — waits for a turn that is only
      // FINISHING (its reply is over, its request is doing its after-reply work) instead of
      // being refused as a second turn (`finishingTurnWait.ts`). Never for a click: its own
      // wait above refuses to wait behind another click on the same card.
      const finishWait = await waitForFinishingTurn(sessionId)
      if (finishWait !== 'no_wait') {
        logger.debug('[Send-Routed] A new turn waited for the previous one to finish', {
          sessionId,
          messageId: requestedMessageId,
          outcome: finishWait,
        })
      }
    }
    // BL-4 — a send that meets another turn waits for it instead of being refused.
    //
    // The page saves the user's message BEFORE it posts. A send from another tab in the first
    // seconds of a reply (before that reply's first event, so the tab could not know) was
    // refused below, and its words stayed in the chat unanswered. The page's own ordinary send
    // (it asked to be answered early and names the message it saved) now waits in the chat's
    // line and runs as itself when the chat is free (`queuedSendRules.ts`); a send over the cap
    // gets today's refusal, and its words still land after the replies ahead of them. The saved
    // message is read first; from the decision to the enqueue nothing awaits, the rule the lock
    // check below keeps. The wait sits ABOVE that check, like the waits above: the line hands
    // this send the lock in the same step that frees it, and the send claims it there.
    // Approval clicks, woken turns, and callers that wait for their own turn's end are refused
    // as they always were.
    let handedTurn: SessionTurnEntry | null = null
    let queuedUserMessageId: string | null = null
    const savedUserMessage = queueableSend
      ? await redis.execute((client) =>
          client.json.get(`message:${sessionId}:${namedUserMessageId}`),
        )
      : null
    const namesSavedUserMessage =
      queueableSend &&
      isSavedUserMessageForSend(savedUserMessage, {
        sessionId,
        userId: resolvedUserId,
        userMessageId: namedUserMessageId,
      })
    // BL-713 — Send now on a send that waits in the chat's line (its bubble offers it while the
    // line holds for an approval card, in every tab). It adds no second entry: the waiting send's
    // own request runs the turn. The hold ends, and the line runs in order.
    if (namesSavedUserMessage && isUserMessageQueued(sessionId, namedUserMessageId)) {
      const sentNow = sendWaitingSendNow(sessionId, namedUserMessageId)
      if (sentNow.waiting) {
        if (sentNow.endedCardHold) {
          await forwardQueuedSendEvent(request, {
            type: 'queued_send_hold',
            sessionId,
            heldForApprovalCard: null,
          })
        }
        return json(
          { accepted: true, queuedSend: { userMessageId: namedUserMessageId, waiting: true } },
          { status: 202 },
        )
      }
    }
    // The same button pressed a second time, or in a second tab, after the send already ran (or
    // was kept): nothing to do, and it must never run the send again (BL-714's class).
    if (waitingSendNowRequest) {
      return json(
        {
          error: 'This message is no longer waiting.',
          code: 'queued_send_not_waiting',
          details: 'It already went, or it was kept unanswered at the end of the chat.',
        },
        { status: 409 },
      )
    }
    if (
      namesSavedUserMessage &&
      !isUserMessageQueued(sessionId, namedUserMessageId) &&
      !isSessionDeleting(sessionId)
    ) {
      const queueDecision = decideQueuedSend({
        lockHeld: Boolean(getActiveSessionTurn(sessionId)),
        queuedTurns: countQueuedSessionTurns(sessionId),
        runnableQueuedTurns: countRunnableQueuedSessionTurns(sessionId),
      })
      if (queueDecision !== 'free') {
        // The bubble is filed under the reply this send waits behind, so that reply's own end
        // (or Stop) settles it in every tab, and its replay buffer shows it to a tab opened now.
        const runningReplyId =
          getActiveStream(sessionId)?.messageId ?? getActiveSessionTurn(sessionId)?.messageId ?? null
        const queuedAssistantMessageId =
          typeof requestedMessageId === 'string' && requestedMessageId.trim().length > 0
            ? requestedMessageId.trim()
            : null
        // A send over the cap is answered now and its message moves later, detached from any
        // request, so it holds the backup-restore gate itself until that move is done. While a
        // restore drains it gets no hold, and its words stay where they were saved.
        const releaseKeepWork = queueDecision === 'overflow' ? enterBackupRestoreHttpRequest() : null
        if (queueDecision === 'overflow' && !releaseKeepWork) {
          return json(buildQueuedSendOverflowAnswer({ keptInLine: false }), { status: 409 })
        }
        const queuedTurn = queueSessionTurn(sessionId, {
          kind: sessionTurnKind,
          messageId: queuedAssistantMessageId,
          userMessageId: namedUserMessageId,
          ...(queueDecision === 'overflow' ? { keep: 'overflow' as const } : {}),
        })
        // Every way out of here before this send takes the chat (an early return, a throw) lets
        // its place go: still waiting, it leaves the line; handed and not taken, its registration
        // is released (`abandonQueuedSessionTurn`). Nothing on a timer does it for the request.
        let tookTheChat = false
        try {
          const forwardSessionEvent = (event: Record<string, unknown>) =>
            forwardQueuedSendEvent(request, event)
          if (queueDecision === 'overflow') {
            // Answered now, and kept in its place in the line: when its turn comes, its words
            // move to the end of the chat, unanswered, after the replies ahead of them.
            tookTheChat = true
            void queuedTurn.outcome.then(async (handover) => {
              try {
                if (handover.kind === 'keep' && claimQueuedSessionTurn(sessionId, handover.entry)) {
                  await keepQueuedSendAtEnd({
                    sessionId,
                    userId: resolvedUserId,
                    userMessageId: namedUserMessageId,
                    entry: handover.entry,
                    forwardSessionEvent,
                  })
                } else {
                  abandonQueuedSessionTurn(sessionId, queuedTurn)
                }
              } finally {
                releaseKeepWork?.()
              }
            })
            return json(buildQueuedSendOverflowAnswer(), { status: 409 })
          }
          // The server owns this send from here: it will run, or be kept at the end of the chat.
          acceptTurn?.({ sessionId, userId: resolvedUserId })
          // Every tab shows the "Queued" bubble. Not awaited: the chat may be handed to this send
          // while the forward is still in flight, and the send must be waiting for it then (the
          // second review). Its later events wait for this one instead (`queuedNoticeSent`), so
          // every tab hears them in order.
          queuedNoticeSent = forwardSessionEvent({
            type: 'steer_queued',
            sessionId,
            ...(runningReplyId ? { messageId: runningReplyId } : {}),
            steerId: namedUserMessageId,
            text: typeof content === 'string' ? content : '',
            at: new Date().toISOString(),
            deliver: 'end',
            queuedSend: {
              userMessageId: namedUserMessageId,
              assistantMessageId: queuedAssistantMessageId,
            },
          }).then(() =>
            // BL-713: this new message ended the line's hold at an approval card, so the sends
            // before it go now: every tab stops saying they wait for the card, after this bubble.
            queuedTurn.endedCardHold
              ? forwardSessionEvent({ type: 'queued_send_hold', sessionId, heldForApprovalCard: null })
              : undefined,
          )
          // A Stop's "Not sent" for this send goes to the tabs after this bubble (BL-203).
          noteQueuedSendNotice(sessionId, queuedTurn.queueId, queuedNoticeSent)
          const handover = await queuedTurn.outcome
          if (handover.kind === 'cancelled') {
            tookTheChat = true
            return sessionDeletedResponse()
          }
          if (handover.kind === 'keep') {
            if (claimQueuedSessionTurn(sessionId, handover.entry)) {
              tookTheChat = true
              // BL-713: every tab turns this send's bubble into its "Not sent" receipt, after its
              // "Queued" bubble and before its words come back at the end of the chat. A Stop's
              // receipt is the interrupt route's (sent at the Stop); every other reason is said
              // here, by the send itself: nothing else announces an approval card's bound, the
              // page's expiry Deny, or a restore. (Shutdown's own notice may arrive twice; the
              // tabs ignore a bubble that is already a receipt.)
              const keptNotice =
                handover.reason === 'stopped'
                  ? queuedNoticeSent
                  : Promise.resolve(queuedNoticeSent).then(() =>
                      forwardSessionEvent({
                        type: 'queued_send_dropped',
                        sessionId,
                        userMessageIds: [namedUserMessageId],
                        reason: handover.reason,
                      }),
                    )
              await keepQueuedSendAtEnd({
                sessionId,
                userId: resolvedUserId,
                userMessageId: namedUserMessageId,
                entry: handover.entry,
                forwardSessionEvent,
                after: keptNotice,
              })
            }
            return json(buildQueuedSendKeptAnswer(handover.reason), { status: 409 })
          }
          // Handed the lock in the same step that freed it: take it now. Nothing awaits from
          // here to the registration below, so no delete or Stop can land in between.
          if (claimQueuedSessionTurn(sessionId, handover.entry)) {
            tookTheChat = true
            handedTurn = handover.entry
            queuedUserMessageId = namedUserMessageId
          }
        } finally {
          if (!tookTheChat) abandonQueuedSessionTurn(sessionId, queuedTurn)
        }
      }
    }
    // A chat being deleted takes no new turn: its delete is stopping the turn it had and sweeps
    // the chat once that turn's request is done (`sessionDeleteTurnStop.ts`). Read here, in the
    // same synchronous block as the lock check and the registration.
    if (isSessionDeleting(sessionId)) {
      return sessionDeletedResponse()
    }
    const activeSessionTurn = getActiveSessionTurn(sessionId)
    if (activeSessionTurn && activeSessionTurn !== handedTurn) {
      return json(
        {
          error: 'Another response is already in progress for this session.',
          code: 'session_turn_in_progress',
          details:
            activeSessionTurn.kind === 'group'
              ? 'A group-chat turn is still running for this chat.'
              : 'A response is still running for this chat.',
        },
        { status: 409 },
      )
    }

    const sessionTurnRegistration = registerSessionTurn(
      sessionId,
      sessionTurnKind,
      typeof requestedMessageId === 'string' && requestedMessageId.trim().length > 0
        ? requestedMessageId.trim()
        : null,
      { answersApproval: approvalClick },
      handedTurn,
    )
	    if (!sessionTurnRegistration.ok) {
      if (sessionTurnRegistration.reason === 'session_deleting') {
        return sessionDeletedResponse()
      }
	      return json(
        {
          error: 'Another response is already in progress for this session.',
          code: 'session_turn_in_progress',
          details:
            sessionTurnRegistration.reason === 'turn_in_progress' &&
            sessionTurnRegistration.existing.kind === 'group'
              ? 'A group-chat turn is still running for this chat.'
              : 'A response is still running for this chat.',
        },
        { status: 409 },
	      )
	    }
    // This request's own lock, by its registration: the `finally` releases exactly this one.
    // A message id cannot stand in for it — an Approve click resumes in place, into the
    // card's own message id (`releaseSessionTurn`).
    const sessionTurnId = sessionTurnRegistration.entry.turnId
    const turnStopSignal = sessionTurnRegistration.entry.stop.signal
    planOwner.stop = sessionTurnRegistration.entry.stop
    // The server owns this turn now. A send that asked (`Prefer: respond-async`) is answered
    // here and its request lets go of the browser's connection; everything below runs as it
    // always did, and its final answer is kept for the tab (`respondAsyncSend.ts`).
    acceptTurn?.({ sessionId, userId: resolvedUserId })
    // BL-713: how this request ends, for the chat's line, told to the registry in the same step
    // that frees the lock (the `finally`). The message of a pending approval card this request's
    // last run stopped at (from the run's own finish, never read back from Redis), and whether
    // this click's answer was recorded.
    let endedAtApprovalCardMessageId: string | null = null
    let clickAnswerRecorded = false
    let requestStopped = false
    // Set once this click told the tabs the hold ended (after the re-read under the lock).
    let holdEndForwarded = false

    try {
      // The chat was read before the waits above. A delete that found no turn may have swept it
      // and ended its mark while this request waited, so it is read again under the lock; from
      // here on a delete waits for this request (`sessionDeleteTurnStop.ts`). The `finally`
      // below lets the lock go.
      if (!(await redis.getSession(sessionId))) {
        return sessionDeletedResponse()
      }
      // The pre-run sweep removes this chat's sandboxes even while a command runs in one. A
      // request whose lock went may still run (the line hands the chat on at most 30 s after a
      // lock went, BL-4), and this turn holds the lock now, so it asks whether any OTHER request
      // of the chat still runs and stands aside if so (BL-198). This turn's own run-end sweep, or
      // the last request out, cleans up after both.
      if (isAnotherRequestRunning(sessionId, sessionTurnId)) {
        console.warn(
          '[Send-Routed] Skipped the pre-run sandbox sweep: an earlier request of this chat still runs',
          { sessionId },
        )
      } else {
        try {
          const sandboxCleanupWarnings =
            await nativeToolService.cleanupExecutionSandboxesForSession(sessionId)
          if (sandboxCleanupWarnings.length > 0) {
            console.warn(
              '[Send-Routed] sandbox pre-run cleanup warnings:',
              {
                sessionId,
                warnings: sandboxCleanupWarnings,
              },
            )
          }
        } catch (sandboxCleanupError) {
          console.error(
            '[Send-Routed] sandbox pre-run cleanup failed:',
            sandboxCleanupError,
          )
        }
      }

      // BL-965: the agent was read before the waits above too (the chat's line, a card's reply
      // finishing, another turn finishing), so it is read again under the lock, after the
      // pre-run sweep: this turn runs with the record as it is now. A record made tighter while
      // the send waited bounds it (BL-941); a deleted agent runs nothing. A send that did not
      // wait reads the same record.
      const agentUnderLock = await readAgentRecordForTurn(resolvedUserId, agentId)
      if (!agentUnderLock) {
        if (queuedUserMessageId) {
          // A send the line handed the chat: every tab's "Queued" bubble becomes its "Not sent"
          // receipt (after that bubble), and its words come back at the end of the chat,
          // unanswered, the line's own keep path. The keeper lets the lock go.
          const keptUserMessageId = queuedUserMessageId
          const forwardSessionEvent = (event: Record<string, unknown>) =>
            forwardQueuedSendEvent(request, event)
          const keptNotice = Promise.resolve(queuedNoticeSent).then(() =>
            forwardSessionEvent({
              type: 'queued_send_dropped',
              sessionId,
              userMessageIds: [keptUserMessageId],
              reason: 'agent_deleted',
            }),
          )
          await keepQueuedSendAtEnd({
            sessionId,
            userId: resolvedUserId,
            userMessageId: keptUserMessageId,
            entry: sessionTurnRegistration.entry,
            forwardSessionEvent,
            after: keptNotice,
          })
          return json(buildQueuedSendKeptAnswer('agent_deleted'), { status: 409 })
        }
        return json({ error: 'Agent not found' }, { status: 404 })
      }
      agent = agentUnderLock

      // BL-713: this click answers the card the chat's line held for; the sends waiting there now
      // wait for this click's reply, like any turn's, so the tabs stop saying they wait for the card.
      // After the re-read under the lock: a chat being deleted takes no work, this event included.
      if (sessionTurnRegistration.endedCardHold) {
        holdEndForwarded = true
        await forwardQueuedSendEvent(request, {
          type: 'queued_send_hold',
          sessionId,
          heldForApprovalCard: null,
        })
      }
      // BL-4: the history this turn compiles. A message another send saved and is still
      // waiting to send is not part of the conversation yet, from any source.
      let turnMessages: any[] = (Array.isArray(messages) ? messages : []).filter(
        (message: any) =>
          !(typeof message?.id === 'string' && isUserMessageQueued(sessionId, message.id)),
      )
      if (queuedUserMessageId) {
        // A send the line handed the chat to. The message it saved sits above the reply it
        // waited for (a reply is added to the chat when it is finalized), so it moves to the
        // end now, shows again, and every tab turns its "Queued" bubble into that message. The
        // browser's history is from the moment the user pressed Enter, without the reply it
        // waited for: the turn keeps that view and adds what the chat stored meanwhile.
        const movedUserMessage = await redis.moveMessageToEnd(sessionId, queuedUserMessageId)
        revealQueuedUserMessage(sessionId, queuedUserMessageId)
        if (!movedUserMessage) {
          // Deleted in another tab while it waited: there is nothing left to answer.
          return json(
            {
              error: 'This message was deleted before its turn.',
              code: 'queued_send_missing',
            },
            { status: 404 },
          )
        }
        // After the "Queued" bubble, so every tab hears the two in order.
        await queuedNoticeSent
        await forwardQueuedSendEvent(request, {
          type: 'user_message',
          sessionId,
          message: movedUserMessage,
        })
        await forwardQueuedSendEvent(request, {
          type: 'steer_promoted',
          sessionId,
          steerIds: [queuedUserMessageId],
        })
        turnMessages = mergeQueuedSendHistory({
          requestHistory: Array.isArray(messages) ? messages : [],
          storedRecent: await redis.getRecentMessages(sessionId, 300),
          userMessageId: queuedUserMessageId,
          isStillQueued: (messageId) =>
            typeof messageId === 'string' && isUserMessageQueued(sessionId, messageId),
        })
      } else if (namesSavedUserMessage) {
        // A send of a message already in the chat (Send now on a kept message's receipt) goes
        // where a new message would: after what its tab knew had been said since, dated when
        // its tab sent it. A fresh send's message is the newest its tab knows and stays where
        // it was saved, before any message another tab saved a moment later.
        const listKey = `messages:${sessionId}`
        const idsAfter = (await redis.execute(async (client) => {
          const position = await client.lPos(listKey, namedUserMessageId, { RANK: -1 })
          return typeof position === 'number' ? client.lRange(listKey, position + 1, -1) : []
        })) as string[]
        if (
          shouldMoveSentMessageToEnd({
            idsAfter,
            requestHistory: messages,
            userMessageId: namedUserMessageId,
            isStillQueued: (messageId) =>
              typeof messageId === 'string' && isUserMessageQueued(sessionId, messageId),
          })
        ) {
          const requestCopy = (Array.isArray(messages) ? messages : []).find(
            (message: any) => message?.id === namedUserMessageId,
          )
          const movedUserMessage = await redis.moveMessageToEnd(sessionId, namedUserMessageId, {
            createdAt: resentMessageCreatedAt(requestCopy, (savedUserMessage as any)?.created_at),
          })
          if (movedUserMessage) {
            await publishUserEvent(resolvedUserId, {
              type: 'session_messages_changed',
              sessionId,
              reason: 'queued_send_moved',
            })
          }
        }
      }

      const hasUserTurnContent =
        (typeof content === 'string' && content.trim().length > 0) ||
        (Array.isArray(content) && content.length > 0) ||
        (content != null &&
          typeof content !== 'string' &&
          !Array.isArray(content))

      let approvalTimeoutNotices: ApprovalStateSnapshot['newlyExpired'] = []
      let expiredApprovalNoticesFromResponses: Array<{
        approvalId: string
        toolName?: string
        expiredAt: string
        timeoutSeconds: number
      }> = []

      if (
        isManagedPrimaryAgentType(finalAgentType) &&
        (hasApprovalResponse || hasUserTurnContent)
      ) {
        let persistedMessages: ChatMessage[] = []
        try {
          // The newest 300, where the cards are: `getMessages` reads the FIRST 300, so on a
          // longer chat no card was ever checked for its three minutes (bug sweep, 2026-09-18).
          persistedMessages = await redis.getRecentMessages(sessionId, 300)
        } catch (error) {
          console.warn(
            '[Send-Routed] Failed to load persisted messages for approval timeout checks',
            {
              sessionId,
              error,
            },
          )
        }

        const approvalHistoryMessages = buildApprovalHistoryMessages(
          turnMessages,
          persistedMessages,
        )
        const approvalState = analyzeApprovalState(approvalHistoryMessages)
        approvalTimeoutNotices = approvalState.newlyExpired

        /**
         * SA-116 P2 — a card that timed out retires its consent record with it.
         *
         * The card expires after three minutes; the record lives 24 hours so the CLI lanes
         * can answer it later (DL-116-06). Leaving an API-lane record `pending` after its
         * card expired would let a much later retry of the same call find it through
         * `findApprovedMatch` — except it never can, because a pending record is not an
         * approved one. Marking it `expired` is about honesty in the record and the audit,
         * not about closing a hole. It never fails the turn.
         */
        for (const notice of approvalState.newlyExpired) {
          if (!notice.controlApprovalId) continue
          try {
            await markApprovalExpired(notice.controlApprovalId)
          } catch (error) {
            console.warn('[SA-116] Could not mark an approval record expired', {
              sessionId,
              approvalId: notice.controlApprovalId,
              error,
            })
          }
        }

        if (approvalState.updates.length > 0) {
          for (const update of approvalState.updates) {
            try {
              await redis.updateMessage(
                update.messageId,
                sessionId,
                { metadata: update.metadata },
                resolvedUserId,
              )
            } catch (error) {
              console.warn(
                '[Send-Routed] Failed to persist expired approval metadata update',
                {
                  sessionId,
                  messageId: update.messageId,
                  error,
                },
              )
            }
          }
        }

        if (hasApprovalResponse) {
          const expiredApprovalRecordMap = new Map<
            string,
            { approvalId: string; toolName?: string; expiresAt?: string; timeoutSeconds: number }
          >()

          for (const response of approvalResponse) {
            const approvalId =
              typeof response.approvalId === 'string'
                ? response.approvalId.trim()
                : ''
            if (!approvalId) continue
            const record = approvalState.byId.get(approvalId)
            if (!record || record.status !== 'expired') continue
            expiredApprovalRecordMap.set(approvalId, {
              approvalId,
              toolName: record.toolName,
              expiresAt: record.expiresAt,
              timeoutSeconds: record.timeoutSeconds,
            })
          }

          const expiredApprovalRecords = Array.from(
            expiredApprovalRecordMap.values(),
          )
          expiredApprovalNoticesFromResponses = expiredApprovalRecords.map(
            (entry) => ({
              approvalId: entry.approvalId,
              toolName: entry.toolName,
              expiredAt: new Date().toISOString(),
              // The card's own wait, never the default alone.
              timeoutSeconds: entry.timeoutSeconds,
            }),
          )

          if (expiredApprovalRecordMap.size > 0) {
            approvalResponseForStream = approvalResponse.map((entry) => {
              const approvalId =
                typeof entry.approvalId === 'string'
                  ? entry.approvalId.trim()
                  : ''
              if (!approvalId || !expiredApprovalRecordMap.has(approvalId)) {
                return entry
              }

              return {
                ...entry,
                approved: false,
                reason: APPROVAL_EXPIRED_REASON,
              }
            })
          }

          const hasLateApproveAttempt = approvalResponse.some((entry) => {
            const approvalId =
              typeof entry.approvalId === 'string'
                ? entry.approvalId.trim()
                : ''
            if (!approvalId) return false
            return (
              expiredApprovalRecordMap.has(approvalId) &&
              entry.approved === true
            )
          })

          if (hasLateApproveAttempt) {
            console.warn(
              '[Send-Routed] Late approval converted to deny due to timeout',
              {
                sessionId,
                agentId,
                expiredApprovalIds: expiredApprovalRecords.map(
                  (entry) => entry.approvalId,
                ),
              },
            )
          }

          // An approval is answered ONCE (bug sweep, 2026-09-18). Recorded on the card's own
          // message under this click's lock and before the resumed run starts, so a resume
          // that fails or is stopped after the command ran can never run it a second time;
          // a click naming an answered approval is refused (`approvalAnswerRecord.ts`).
          let approvalPlanLease: PlanLease | undefined
          let approvalAnswer: Awaited<ReturnType<typeof answerApprovalsOnce>>
          approvalAnswer = await answerApprovalsOnce({
            userId: resolvedUserId,
            sessionId,
            messageId: requestedMessageId,
            responses: approvalResponseForStream,
            beforeRecord: async record => {
              const preset = await loadRuntimeModelPreset(agent.primary_model_preset_id, 'primary')
              const selection = resolveRuntimeModelSelection({ preset, presetId: agent.primary_model_preset_id, connection: agent.primary_model_connection ?? null })
              if (isPlanSelection(selection.connection)) {
                const accountId = chatgptPlanAccountId(selection.connection?.id)
                if (!accountId || normalizePrimaryAgentType(agent) !== 'api') throw createRoutedInputError('Choose this ChatGPT account on an API agent.', 'CHATGPT_PLAN_CONNECTION_INVALID', 409)
                const storedBinding = (record.metadata as any)?.providerMessageSource?.planBinding
                approvalPlanLease = getChatgptPlanRuntime().acquire(resolvedUserId, accountId, PLAN_AGENT, turnStopSignal ?? undefined, storedBinding ?? '')
                const owner = requestPlanOwners.get(request)
                if (!owner?.stop) { approvalPlanLease.release(); throw createRoutedInputError('ChatGPT approval has no request owner.', 'CHATGPT_PLAN_CONNECTION_INVALID', 409) }
                owner.leases.add(approvalPlanLease)
                relayAbort({ from: approvalPlanLease.signal, to: owner.stop, reason: sourceAbortReason, until: owner.listeners.signal })
              }
              assertPlanApprovalSource(record, { connectionId: selection.connection?.id ?? selection.connection?.service ?? null, planBinding: approvalPlanLease?.binding ?? null })
            },
            mutate: write => approvalPlanLease ? getChatgptPlanRuntime().mutate(approvalPlanLease, write) : write(),
          })
          if (!approvalAnswer.ok) {
            if (approvalAnswer.reason === 'already_answered') {
              return json(
                {
                  error: 'This approval was already answered.',
                  code: 'approval_already_answered',
                  details:
                    'Each approval runs once. Ask the agent again if you want it to run again.',
                  approvalIds: approvalAnswer.approvalIds,
                },
                { status: 409 },
              )
            }
            console.error('[Send-Routed] Could not record an approval answer', {
              sessionId,
              messageId: requestedMessageId,
              error: approvalAnswer.error,
            })
            return json(
              {
                error: 'Batshit could not record this approval, so it did not run it.',
                code: 'approval_record_failed',
                details: 'Try again.',
              },
              { status: 503 },
            )
          }
          clickAnswerRecorded = true
          // BL-455: the page's own Deny of an expired card releases nothing. The words held for it
          // say so now, before the resume runs, in every tab.
          if (expiryOnlyAnswer && cardMessageId) {
            await markHeldMessageCardExpired({
              sessionId,
              userId: resolvedUserId,
              cardMessageId,
              eventFetch,
              request,
            })
          }
        }
      }

      const expiredToolApprovalsForAddendum = (() => {
        const combined = [
          ...approvalTimeoutNotices,
          ...expiredApprovalNoticesFromResponses,
        ]
        if (combined.length === 0) return []
        const byId = new Map<string, (typeof combined)[number]>()
        for (const entry of combined) {
          if (!entry?.approvalId) continue
          byId.set(entry.approvalId, entry)
        }
        return Array.from(byId.values())
      })()

      const metadataForStream =
        isManagedPrimaryAgentType(finalAgentType)
          ? {
              ...(metadata && typeof metadata === 'object' ? metadata : {}),
              ...(hasApprovalResponse
                ? { toolApprovalResponse: approvalResponseForStream }
                : {}),
              ...(expiredToolApprovalsForAddendum.length > 0
                ? { expiredToolApprovals: expiredToolApprovalsForAddendum }
                : {}),
            }
          : metadata
      // One rule for a run's voice state, from the metadata it runs with. BL-455: a follow-up turn in
      // a click's request runs with the paused send's facts, not the card's, so it asks again.
      const resolveVoiceStateFor = async (
        source: Record<string, any> | null | undefined,
      ) => {
        const resolvedVoiceConfig = await resolveVoiceConfigForMetadata({
          userSettings,
          agent,
          metadata: source,
        })
        const tts = Boolean(source?.tts ?? false)
        const stt = Boolean(source?.stt ?? false)
        const guidance = resolvedUserId
          ? await buildVoiceRuntimeGuidanceForProvider(
              resolvedUserId,
              resolvedVoiceConfig.provider,
              userSettings?.voice_settings,
            )
          : []
        return {
          stt,
          tts,
          voiceMode: (source?.voiceMode ?? (tts ? 'voice' : 'text')) as string,
          provider: resolvedVoiceConfig.provider ?? undefined,
          guidance: guidance.length > 0 ? guidance : undefined,
        }
      }
      const resolvedVoiceState =
        isManagedPrimaryAgentType(finalAgentType)
          ? await resolveVoiceStateFor(
              (metadataForStream ?? metadata) as Record<string, any> | null | undefined,
            )
          : undefined

      /**
       * BL-455 review (D1) — the send a follow-up turn of this request belongs to.
       *
       * An ordinary send's follow-ups (a promoted message) run with the send's own metadata, as
       * always. A CLICK posts the paused REPLY's metadata (the card's message: no project, no voice
       * mode), so its follow-ups (the held words, a promoted message, a CLI Deny's held turn) run
       * with the facts of the user message that raised the card, recovered the way the resume
       * recovers its project (`findPausedApprovalTurn`, from Redis), plus the approval mode the
       * click carries. The gateway scope stays the click's own (`gatewayAuthority`), untouched.
       * Every server-written user message keeps these facts too (`pickSendFacts`), so a card raised
       * by a promoted or held turn finds them the same way.
       */
      let followUpSendFacts: Promise<Record<string, unknown>> | null = null
      const resolveFollowUpSendFacts = (): Promise<Record<string, unknown>> => {
        followUpSendFacts ??= (async () => {
          if (!cardMessageId) return pickSendFacts(metadataForStream)
          const pausedTurn = findPausedApprovalTurn(
            await readFollowUpHistory(sessionId),
            cardMessageId,
          )
          const clickApprovalMode = (metadataForStream as Record<string, any> | null)?.toolApprovalMode
          return {
            ...pickSendFacts(pausedTurn?.currentMessage?.metadata),
            ...(clickApprovalMode ? { toolApprovalMode: clickApprovalMode } : {}),
          }
        })()
        return followUpSendFacts
      }
      /** A follow-up turn's metadata: the send's facts (a held message's own first), no run keys. */
      const buildFollowUpMetadata = async (
        steerIds: string[],
        ownSendFacts: Record<string, unknown> = {},
      ): Promise<Record<string, any>> =>
        cardMessageId
          ? followUpTurnMetadata({ ...(await resolveFollowUpSendFacts()), ...ownSendFacts }, steerIds)
          : followUpTurnMetadata(metadataForStream, steerIds)

      /**
       * SA-116 P3 (DL-116-08) — Approve on a lane that cannot be resumed in place.
       *
       * The API lane re-executes the very SDK call the user paused. A managed Codex or
       * Claude run has nothing left to un-pause: the helper's refusal already came back, the
       * agent already spoke about it, and the turn already ended. So the click starts an
       * ORDINARY next turn whose first message says what was approved, and the agent's retry
       * finds the `approved` record waiting for it. That works after any delay and with no
       * tab open, which a blocking wait inside the helper could never do.
       *
       * `planControlApprovalResumeTurn` returns null for a normal API-lane click, so nothing
       * below this point changes for the lane P2 shipped.
       */
      // Post-click preparation belongs to the answered card until an actual successor run
      // takes ownership. A failed strict read is visible through the same failure writer.
      type ManagedRun = { messageId: string | undefined; inPlaceResume: boolean; steerIds?: string[] }
      let runInProgress: ManagedRun | null = clickAnswerRecorded && cardMessageId
        ? { messageId: cardMessageId, inPlaceResume: true } : null
      let lastRun: ManagedRun = runInProgress ?? { messageId: undefined, inPlaceResume: false }
      let pendingPromotionIds: string[] = []
      const runFinished = (result: { response: Response; metadata?: unknown }) => {
        requestStopped ||= result.response.status === 499 || (result.metadata as any)?.interrupted === true
        if (runInProgress) lastRun = runInProgress
        runInProgress = null
      }
      try {
      let controlApprovalResumeContent: string | null = null
      let controlApprovalResumeIds: string[] = []
      let controlApprovalInPlaceAddendum: string | null = null
      // BL-455: a CLI-lane Deny with words held for its card runs them as this request's turn.
      let heldAnswerAfterDeny: Awaited<ReturnType<typeof readHeldMessageToAnswer>> = null
      if (hasApprovalResponse && isManagedPrimaryAgentType(finalAgentType)) {
        const resumePlan = await planControlApprovalResumeTurn({
          userId: resolvedUserId,
          sessionId,
          messageId: requestedMessageId,
          responses: approvalResponseForStream,
        })
        if (resumePlan?.mode === 'in-place') {
          /**
           * F-P3-2 — one click answered a card the SDK resume owns AND one it does not.
           *
           * The in-place resume wins, because only it can re-execute the call the SDK
           * paused. The card is therefore NOT cleared here: `resolveApprovalResumeGrants`
           * still has to read it off the persisted message when the run starts, and that
           * run's finish path clears the whole summary afterwards. The other record was
           * already decided by the planner, so nothing is lost; it travels into the
           * resumed model's request as an addendum, the same way a tool-approval timeout
           * does, and the model's retry spends it.
           */
          await settleControlApprovalCard({
            userId: resolvedUserId,
            sessionId,
            messageId: resumePlan.cardMessageId || (requestedMessageId ?? ''),
            denied: resumePlan.denied,
            clearCard: false,
          })
          controlApprovalInPlaceAddendum =
            buildControlApprovalInPlaceAddendum(resumePlan)
        } else if (resumePlan) {
          // Clear the spent card first. It is done whether or not a turn follows, because a
          // denial must not leave a button the user can press again — and the denial's
          // one-turn `control_errors` line is written in the same act.
          await settleControlApprovalCard({
            userId: resolvedUserId,
            sessionId,
            messageId: resumePlan.cardMessageId || (requestedMessageId ?? ''),
            denied: resumePlan.denied,
          })

          if (resumePlan.approved.length === 0) {
            // Deny starts NO turn (DL-116-08). The agent is told on its next typed turn
            // through the DCM line just written; starting a turn to say "no" would spend
            // the user's money to tell an agent something it will read anyway.
            //
            // BL-455: unless the user already typed that next turn. Words typed while the reply
            // ran are held for this card, and with no resume on this lane there is nothing else
            // to wait for: they are answered now, as their own turn, and that turn reads the
            // denial's DCM line.
            heldAnswerAfterDeny = answeredCardMessageId
              ? await readHeldMessageToAnswer({
                  sessionId,
                  cardMessageId: resumePlan.cardMessageId || answeredCardMessageId,
                })
              : null
            if (!heldAnswerAfterDeny) {
              if (clickAnswerRecorded && cardMessageId) await markApprovalCardWithoutAnswer({
                sessionId, userId: resolvedUserId, cardMessageId, eventFetch, request,
                reason: expiryOnlyAnswer ? 'approval_expired' : 'approval_denied' })
              return json({
                success: true,
                approvalResume: 'denied',
                deniedCount: resumePlan.denied.length,
              })
            }
          } else {
            controlApprovalResumeContent = buildControlApprovalResumeContent(resumePlan.approved)
            controlApprovalResumeIds = resumePlan.approved.map((item) => item.recordId)
          }
        }
      }

      // API and CLI agents use the managed streaming path.
      if (isManagedPrimaryAgentType(finalAgentType)) {
        const hasGroupConfig = Boolean(
          groupConfig &&
          Array.isArray(groupConfig.agent_ids) &&
          groupConfig.agent_ids.length >= 2,
        )
        const shouldUseGroup = hasGroupConfig

        if (shouldUseGroup && groupConfig) {
          return await handleGroupChatStream({
            content,
            sessionId,
            agent,
            agentId,
            messages: turnMessages,
            metadata: metadataForStream,
            batshitInput,
            globalZipSettings,
            voiceState: resolvedVoiceState,
            userSettings,
            userDisplayName,
            userId: resolvedUserId,
            eventFetch,
            request,
            gatewayAuthority,
            groupConfig,
            userMessageId: namedUserMessageId || null,
            turnStopSignal,
          })
        }

        let managedAssistantMessageId =
          typeof requestedMessageId === 'string' &&
          requestedMessageId.trim().length > 0
            ? requestedMessageId.trim()
            : undefined
        let managedContent: any = content
        let managedMessages: any[] = turnMessages
        let managedMetadata: any = metadataForStream
        // Never import this authority from request/body metadata. Card records are
        // server-owned assistant records; held words are read from the server's hold.
        let trustedFirstRunSteerIds: string[] = []
        if (cardMessageId && clickAnswerRecorded) {
          const card = await readStoredAssistantRecord(sessionId, cardMessageId)
          const cardMetadata = card?.metadata as Record<string, any> | undefined
          const promotedIds = cardMetadata?.steerPromoted?.steerIds
          const deliveredIds = Array.isArray(cardMetadata?.steers)
            ? cardMetadata.steers.filter((entry: any) => entry?.source !== 'dm').map((entry: any) => entry.steerId) : []
          trustedFirstRunSteerIds = [...new Set([
            ...(Array.isArray(promotedIds) ? promotedIds : []), ...deliveredIds,
            ...(controlApprovalResumeContent !== null ? await readHeldSteerIds({ sessionId, cardMessageId }) : []),
          ].filter((id): id is string => typeof id === 'string'))]
        }

        if (controlApprovalResumeContent !== null) {
          // The user message first, so the two ids read in the order they appear in the
          // chat. Then a NEW assistant id, because `requestedMessageId` names the message
          // the card was ON — reusing it would overwrite the turn the user just approved.
          const resumeUserMessageId = await generateMessageId(sessionId)
          const resumeAssistantMessageId = await generateMessageId(sessionId)
          if (!resumeAssistantMessageId) {
            // No successor exists yet: the existing answered-card failure owner
            // must record this refusal for its delivered/promoted Voice ids too.
            throw new Error('Could not start the approval resume turn.')
          }
          const now = new Date().toISOString()
          const resumeUserMessage = {
            id: resumeUserMessageId ?? `msg_${crypto.randomUUID()}`,
            session_id: sessionId,
            user_id: resolvedUserId,
            agent_id: agentId,
            role: 'user' as const,
            status: 'complete',
            content: controlApprovalResumeContent,
            created_at: now,
            metadata: {
              // DL-116-08: NO `metadata.wake`. This is a typed-style user turn, which is
              // what lets `clearNeedsUserForHumanReply` clear a woken chat's *Needs you*
              // and what makes the woken-turn gate read the chat as human from here on.
              approvalResume: { approvalIds: controlApprovalResumeIds },
            },
          }

          try {
            await redis.saveMessage(resumeUserMessage as any)
          } catch (error) {
            console.error(
              '[SA-116] Could not persist the approval resume message:',
              error,
            )
            throw error
          }

          // Show it in the chat the same way a woken turn's message appears. No top-level
          // messageId: the replay buffer is keyed on the ASSISTANT id.
          try {
            await eventFetch(new URL('/api/sse', request.url).toString(), {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-internal-sse-forward': '1',
                ...internalServiceHeaders(),
              },
              body: JSON.stringify({
                type: 'user_message',
                sessionId,
                message: resumeUserMessage,
              }),
            })
          } catch (error) {
            console.warn(
              '[SA-116] Could not forward the approval resume message to SSE:',
              error,
            )
          }

          managedAssistantMessageId = resumeAssistantMessageId
          managedContent = controlApprovalResumeContent
          // History re-read from Redis so the turn sees the cleared card and the message
          // just written, rather than the browser's copy from before the click.
          try {
            managedMessages = await redis.getRecentMessages(sessionId, 300)
          } catch (error) {
            console.error(
              '[SA-116] Could not reload history for an approval resume turn:',
              error,
            )
            throw error
          }
          const {
            toolApprovalResponse: _resumeApprovals,
            tool_approval_response: _resumeApprovalsSnake,
            expiredToolApprovals: _resumeExpired,
            ...restResumeMetadata
          } = (metadataForStream ?? {}) as Record<string, any>
          managedMetadata = {
            ...restResumeMetadata,
            approvalResume: { approvalIds: controlApprovalResumeIds },
          }
        }

        let firstRunVoiceState = resolvedVoiceState
        if (heldAnswerAfterDeny) {
          // BL-455: a CLI Deny whose card held the user's words. They are this request's turn, an
          // ordinary accepted send in a promotion's shape: a new assistant id, the history re-read
          // from Redis, the send's own facts, and none of the click's approval keys.
          trustedFirstRunSteerIds = [...new Set([...trustedFirstRunSteerIds, ...heldAnswerAfterDeny.steerIds])]
          managedAssistantMessageId = heldAnswerAfterDeny.assistantMessageId
          managedContent = heldAnswerAfterDeny.content
          managedMessages = heldAnswerAfterDeny.history
          managedMetadata = await buildFollowUpMetadata(
            heldAnswerAfterDeny.steerIds,
            heldAnswerAfterDeny.sendFacts,
          )
          firstRunVoiceState = await resolveVoiceStateFor(managedMetadata)
        }

        // An API-lane approval resume writes into the message the card was ON — this
        // request's own `messageId`. The same rule the stream handler applies
        // (`isApprovalResumeWithoutUserTurn`); a CLI control resume above is a NEW turn, and so
        // is the held message a CLI Deny answers.
        const managedRunIsInPlaceApprovalResume =
          heldAnswerAfterDeny === null &&
          isInPlaceApprovalResume({
            approvalResponseCount: approvalResponseForStream.length,
            content,
            controlResumeContent: controlApprovalResumeContent,
          })

        // The API in-place resume recompiles BEFORE the card, so its full browser history
        // cannot claim the words after it. Only an ordinary/new run actually includes them.
        if (!managedRunIsInPlaceApprovalResume) {
          trustedFirstRunSteerIds = [...new Set([...trustedFirstRunSteerIds,
            ...await readHeldSteerIdsForHistory(sessionId, managedMessages)])]
        }

        if (controlApprovalInPlaceAddendum) {
          // F-P3-2: the decision the click made off the SDK's lane, carried into the run
          // the SDK is about to resume. It rides the same channel the tool-approval
          // timeout notice does — a metadata field the compiler turns into a system-prompt
          // addendum — so nothing about the resume itself changes.
          managedMetadata = {
            ...(managedMetadata && typeof managedMetadata === 'object'
              ? managedMetadata
              : {}),
            controlApprovalNotice: controlApprovalInPlaceAddendum,
          }
        }

        // BL-523: the run in progress, which is where a failure of THIS request is written. The
        // request can run several turns (the first, a context continuation, a promoted steer or
        // queued message), each with its own assistant message. A follow-up that threw before its
        // stream opened (over budget, a picture on a text-only model, a compile failure) used to
        // write its error onto the FIRST run's message, a reply that had already finished: its
        // words became the error sentence, and the follow-up got no reply at all. Only the first
        // run can be an in-place approval resume; every follow-up is a new message. Between runs
        // (a run returned, the next has not started) no run is in progress: a throw there (the
        // promotion's own work) belongs to no reply, and must not land on the one that finished.
        // `lastRun` is the run whose result `streamResult` holds, for the POST's `!ok` writer.
        runInProgress = { messageId: managedAssistantMessageId,
          inPlaceResume: managedRunIsInPlaceApprovalResume, steerIds: trustedFirstRunSteerIds }
        lastRun = runInProgress
          let streamResult = await handleBatshitAgentStream({
            content: managedContent,
            sessionId,
            agent,
            agentId,
            messageId: managedAssistantMessageId,
            messages: managedMessages,
            metadata: managedMetadata,
            streamMetadata: trustedFirstRunSteerIds.length > 0 ? { steerPromoted: { steerIds: trustedFirstRunSteerIds } } : undefined,
            batshitInput,
            globalZipSettings,
            voiceState: firstRunVoiceState,
            userSettings,
            userId: resolvedUserId,
            eventFetch,
            request,
            gatewayAuthority,
            turnStopSignal,
            sessionRecord: session,
            // DL-116-08: parity with the API lane's approval resume, which commits
            // nothing — the clips and the memory linger belong to the turn the user
            // approved, not to the click that unblocked it.
            consumeSessionClips: controlApprovalResumeContent === null,
          })
          runFinished(streamResult)

          // Auto-continue after mid-run context-window exhaustion: the failed
          // run's partial message (content + tool zips) is already finalized in
          // history, so a fresh run — recompiled from persisted history where
          // tool results live as compact zip refs — can pick the task back up.
          // Bounded by MAX_CONTEXT_CONTINUATIONS per user request; single-agent
          // managed sends only (group chat keeps its own turn semantics).
          let continuationAttempt = 0
          while (
            streamResult.contextExhausted === true &&
            streamResult.failureHandled === true &&
            continuationAttempt < MAX_CONTEXT_CONTINUATIONS &&
            request.signal?.aborted !== true
          ) {
            continuationAttempt++
            const previousMessageId = streamResult.messageId
            logger.debug(
              '[Send-Routed] Auto-continuing after context-window exhaustion',
              {
                sessionId,
                agentId,
                attempt: continuationAttempt,
                maxAttempts: MAX_CONTEXT_CONTINUATIONS,
                previousMessageId,
              },
            )

            let persistedHistory: ChatMessage[] = []
            try {
              // The newest 300, which end with the reply that just ran out of room.
              // `getMessages` reads the FIRST 300, so on a longer chat the continuation was
              // compiled from the start of the chat (bug sweep, 2026-09-18).
              persistedHistory = await redis.getRecentMessages(sessionId, 300)
            } catch (historyError) {
              console.error(
                '[Send-Routed] Auto-continue stopped: could not reload persisted history',
                { sessionId, error: historyError },
              )
              break
            }

            // BL-137: the continuation is the same reply under a new id, so the steers the
            // user sent into the run that ran out of room, filed under that run's id and never
            // handed over, move to it first: its boundaries deliver them and its end promotes
            // what is left. Left behind, the promotion (the last run's id) missed them and the
            // `finally` cleared them.
            const continuationMessageId = await generateMessageId(sessionId)
            if (!continuationMessageId) {
              console.error(
                '[Send-Routed] Auto-continue stopped: could not create the continuation message id',
                { sessionId },
              )
              break
            }
            refileUndeliveredSteers(sessionId, previousMessageId, continuationMessageId)

            const baseContinuationMetadata = (() => {
              if (!metadataForStream || typeof metadataForStream !== 'object') {
                return {}
              }
              const {
                toolApprovalResponse: _approvals,
                tool_approval_response: _approvalsSnake,
                expiredToolApprovals: _expired,
                interruption: _interruption,
                ...rest
              } = metadataForStream as Record<string, any>
              return rest
            })()

            runInProgress = { messageId: continuationMessageId, inPlaceResume: false }
            // BL-965: this turn starts after the last one ended: the record as it is now.
            agent = await readAgentRecordForFollowUpTurn(resolvedUserId, agentId)
            streamResult = await handleBatshitAgentStream({
              content: '',
              sessionId,
              agent,
              agentId,
              messageId: continuationMessageId,
              messages: persistedHistory,
              metadata: {
                ...baseContinuationMetadata,
                contextContinuation: {
                  attempt: continuationAttempt,
                  maxAttempts: MAX_CONTEXT_CONTINUATIONS,
                  previousMessageId,
                },
              },
              batshitInput,
              globalZipSettings,
              voiceState: resolvedVoiceState,
              userSettings,
              userId: resolvedUserId,
              eventFetch,
              request,
              gatewayAuthority,
              turnStopSignal,
              consumeSessionClips: false,
            })
            runFinished(streamResult)
          }

          if (answeredCardMessageId && !streamResult.awaitsApproval && !streamResult.response.ok &&
            !isSessionTurnHeldByAnother(sessionId, sessionTurnId)) {
            await markHeldMessageUnanswered({ sessionId, userId: resolvedUserId, cardMessageId: answeredCardMessageId,
              reason: streamResult.response.status === 499 ? 'stopped' : 'reply_failed', eventFetch, request })
          }

          // SA-114 P1 (DL-114-07) — an undelivered steer becomes the next turn.
          //
          // A reply with no tool boundary left (a plain text answer, or an agent already
          // wrapping up) cannot carry a steer inside it. Rather than dropping it or
          // leaving it to a tab that may already be closed, the SERVER sends it as the
          // user's next message and runs the follow-up turn here, in-process — the same
          // shape the context-exhaustion auto-continue above uses, and the same
          // server-written user message SA-116's approval resume writes.
          //
          // The promoted turn is an ORDINARY accepted send: clips consumed once, memory
          // linger committed once, no `metadata.wake` (a human typed it, so a woken chat
          // reads as human from here on).
          let steerPromotions = 0
          // BL-455: an Approve or Deny click answers the message held for its card (below), once. A
          // CLI Deny that ran the held message as its first turn has answered it already.
          let heldAnswerChecked = heldAnswerAfterDeny !== null
          while (steerPromotions < MAX_STEER_PROMOTIONS) {
            const interrupted =
              streamResult.response.status === 499 ||
              (streamResult.metadata as any)?.interrupted === true
            // Stop means stop: the client still holds what it typed and re-sends it as a
            // normal message. Promoting here would answer a reply the user cancelled.
            if (interrupted) {
              if (answeredCardMessageId && !isSessionTurnHeldByAnother(sessionId, sessionTurnId)) {
                await markHeldMessageUnanswered({ sessionId, userId: resolvedUserId, cardMessageId: answeredCardMessageId,
                  reason: 'stopped', eventFetch, request })
              }
              break
            }

            // DL-114-13: only the USER's steers are taken here. A DM that could not land
            // degrades to `wait` and shows on the next turn's roster — an agent's text must
            // never start a user turn — and it stays in the inbox so the `finally` below can
            // find it and stamp it. P1 took everything and filtered afterwards, which left
            // the degrade nothing to read.
            const promotable = takeUndeliveredSteers(
              sessionId,
              streamResult.messageId,
              { source: 'user' },
            )

            pendingPromotionIds = promotable.map((entry) => entry.steerId)
            // BL-455: a reply that stopped at an approval card has not ended; it waits for the
            // user, and the words wait with it. They become one saved user message that names the
            // card's message, and no turn runs beside the card (`holdSteersForApprovalCard`). The
            // click's request answers it when the resumed reply ends.
            if (streamResult.awaitsApproval === true) {
              if (promotable.length > 0) {
                await holdSteersForApprovalCard({
                  sessionId,
                  userId: resolvedUserId,
                  agentId,
                  steers: promotable,
                  cardMessageId: streamResult.messageId,
                  cardVersion: Number.isSafeInteger((streamResult.metadata as any)?.approvalResumeVersion)
                    ? (streamResult.metadata as any).approvalResumeVersion : 0,
                  eventFetch,
                  request,
                  sendFacts: await resolveFollowUpSendFacts(),
                })
                pendingPromotionIds = []
              }
              break
            }

            let nextTurn: {
              content: string
              assistantMessageId: string
              history: ChatMessage[]
              steerIds: string[]
              /** A held message's own send facts; a promotion's come from the request. */
              sendFacts: Record<string, unknown>
            } | null = null
            if (promotable.length > 0) {
              steerPromotions += 1
              const promoted = await promoteSteersToNextTurn({
                sessionId,
                userId: resolvedUserId,
                agentId,
                steers: promotable,
                eventFetch,
                request,
                sendFacts: await resolveFollowUpSendFacts(),
              })
              if (!promoted) {
                await publishUnansweredSteers({ sessionId, steerIds: promotable.map((entry) => entry.steerId), reason: 'promotion_failed', eventFetch, request })
                pendingPromotionIds = []
                break
              }
              nextTurn = {
                ...promoted,
                steerIds: [...new Set([...promotable.map((entry) => entry.steerId),
                  ...await readHeldSteerIdsForHistory(sessionId, promoted.history)])],
                sendFacts: {},
              }
            } else {
              // BL-455: the click's resumed reply ended normally with no new card and nothing new
              // typed into it: answer the message held for this card, if no reply follows it yet
              // (a send the line kept at the card may stand after it, BL-905), the way a promotion
              // is answered. Once, only after a run that
              // succeeded, and only while this request still holds the chat (a Stop in the gap
              // after the reply clears the lock: Stop means stop). A refused or failed resume, a
              // stopped one schedules no answer; its exact held record is marked below.
              // A later message still must not be treated as this request's answer.
              if (
                heldAnswerChecked ||
                !answeredCardMessageId ||
                !streamResult.response.ok ||
                getActiveSessionTurn(sessionId)?.turnId !== sessionTurnId
              ) {
                if (!heldAnswerChecked && answeredCardMessageId && streamResult.response.ok &&
                  !isSessionTurnHeldByAnother(sessionId, sessionTurnId)) {
                  await markHeldMessageUnanswered({ sessionId, userId: resolvedUserId, cardMessageId: answeredCardMessageId,
                    reason: turnStopSignal?.aborted || requestStopped ? 'stopped' : 'reply_failed', eventFetch, request })
                }
                break
              }
              heldAnswerChecked = true
              nextTurn = await readHeldMessageToAnswer({
                sessionId,
                cardMessageId: answeredCardMessageId,
              })
              if (!nextTurn) {
                // No answer was scheduled (including id allocation failure). Only the
                // exact still-unanswered hold can be marked; older answered holds stay intact.
                await markHeldMessageUnanswered({ sessionId, userId: resolvedUserId, cardMessageId: answeredCardMessageId,
                  reason: 'reply_failed', eventFetch, request })
                break
              }
              steerPromotions += 1
            }

            // The user's words, run as their send ran: no `wake` or `source` from the run before, and
            // in a click's request the paused send's facts, not the card's (`buildFollowUpMetadata`).
            runInProgress = { messageId: nextTurn.assistantMessageId, inPlaceResume: false, steerIds: nextTurn.steerIds }
            pendingPromotionIds = []
            const nextMetadata = await buildFollowUpMetadata(nextTurn.steerIds, nextTurn.sendFacts)
            // BL-965: this turn starts after the last one ended: the record as it is now.
            agent = await readAgentRecordForFollowUpTurn(resolvedUserId, agentId)
            streamResult = await handleBatshitAgentStream({
              content: nextTurn.content,
              sessionId,
              agent,
              agentId,
              messageId: nextTurn.assistantMessageId,
              messages: nextTurn.history,
              metadata: nextMetadata,
              streamMetadata: { steerPromoted: { steerIds: nextTurn.steerIds } },
              batshitInput,
              globalZipSettings,
              voiceState: cardMessageId ? await resolveVoiceStateFor(nextMetadata) : resolvedVoiceState,
              userSettings,
              userId: resolvedUserId,
              eventFetch,
              request,
              gatewayAuthority,
              turnStopSignal,
              sessionRecord: session,
            })
            runFinished(streamResult)
          }

          // The bound above is a safety net, not a product limit — but if it ever fires,
          // "nothing you typed is lost" still has to hold. The remaining text is written
          // into the chat as an ordinary unanswered user message rather than being cleared
          // with the inbox, and the error says a chain this long means something is wrong.
          if (steerPromotions >= MAX_STEER_PROMOTIONS) {
            const stranded = takeUndeliveredSteers(
              sessionId,
              streamResult.messageId,
              { source: 'user' },
            )
            if (stranded.length > 0) {
              pendingPromotionIds = stranded.map((entry) => entry.steerId)
              console.error(
                '[SA-114] Steer promotion chain hit its bound; the remaining message is saved unanswered',
                {
                  sessionId,
                  steerIds: stranded.map((entry) => entry.steerId),
                  promotions: steerPromotions,
                },
              )
              if (streamResult.awaitsApproval === true) {
                // BL-455: the last run stopped at a card, so they wait for it like any others.
                await holdSteersForApprovalCard({
                  sessionId,
                  userId: resolvedUserId,
                  agentId,
                  steers: stranded,
                  cardMessageId: streamResult.messageId,
                  cardVersion: Number.isSafeInteger((streamResult.metadata as any)?.approvalResumeVersion)
                    ? (streamResult.metadata as any).approvalResumeVersion : 0,
                  eventFetch,
                  request,
                  sendFacts: await resolveFollowUpSendFacts(),
                })
              } else {
                await saveSteersWithoutAnswer({
                  sessionId,
                  userId: resolvedUserId,
                  agentId,
                  steers: stranded,
                  eventFetch,
                  request,
                  sendFacts: await resolveFollowUpSendFacts(),
                })
              }
              pendingPromotionIds = []
            }
          }

          if (
            !streamResult.response.ok &&
            streamResult.response.status !== 499 &&
            streamResult.failureHandled !== true
          ) {
            const failurePayload = await extractFailurePayload(
              streamResult.response,
            )
            await persistFailedAssistantTurn({
              sessionId,
              userId: resolvedUserId,
              agentId,
              messageId: streamResult.messageId || lastRun.messageId,
              message: failurePayload.message,
              details: failurePayload.details,
              code: failurePayload.code,
              status: streamResult.response.status,
              metadata: {
                ...(streamResult.metadata ?? {}),
                agentType: finalAgentType,
                ...(lastRun.steerIds?.length ? { steerPromoted: { steerIds: lastRun.steerIds } } : {}),
              },
              inPlaceResume: lastRun.inPlaceResume,
              // Refused before its stream opened: no other tab has heard anything.
              noStreamEvent: true,
            })
          }
          // BL-713: the last run stopped at a card that waits for the user; the chat's line holds
          // for it when this request lets go (the `finally`).
          endedAtApprovalCardMessageId =
            streamResult.awaitsApproval === true && typeof streamResult.messageId === 'string'
              ? streamResult.messageId
              : null
          return streamResult.response
      }
      throw new Error(`send-routed reached an unsupported primary agent type: ${finalAgentType}`)
        } catch (streamError) {
          const isAbortError =
            (streamError as any)?.name === 'AbortError' ||
            request.signal?.aborted === true
          requestStopped ||= isAbortError
          const failureAlreadySaved =
            typeof streamError === 'object' &&
            streamError !== null &&
            failuresSavedBeforeThrow.has(streamError)
          if (!isAbortError && !failureAlreadySaved) {
            await persistFailedAssistantTurn({
              sessionId,
              userId: resolvedUserId,
              agentId,
              // BL-523: the run that threw, never an earlier run of this request.
              messageId: runInProgress?.messageId,
              inPlaceResume: runInProgress?.inPlaceResume === true,
              imageOriginVersion: streamError instanceof ApprovalResumeAcquisitionError ? streamError.approvalResumeVersion : undefined,
              message: getFailureMessage(streamError),
              details:
                streamError instanceof Error
                  ? streamError.stack || streamError.message
                  : String(streamError ?? ''),
              code: getFailureCode(streamError),
              status: getFailureStatus(streamError),
              metadata: {
                agentType: finalAgentType,
                ...(runInProgress?.steerIds?.length ? { steerPromoted: { steerIds: runInProgress.steerIds } } : {}),
                ...(runInProgress?.inPlaceResume === true &&
                streamError instanceof ApprovalResumeAcquisitionError
                  ? { approvalResumeVersion: streamError.approvalResumeVersion }
                  : {}),
              },
              // Reconcile the authoritative saved failure in every tab, including one that
              // missed the terminal event from an early approval-resume start.
              noStreamEvent: true,
            })
          }
          await publishUnansweredSteers({ sessionId, steerIds: pendingPromotionIds,
            reason: isAbortError ? 'stopped' : 'promotion_failed', eventFetch, request })
          if (answeredCardMessageId && !isSessionTurnHeldByAnother(sessionId, sessionTurnId)) {
            await markHeldMessageUnanswered({ sessionId, userId: resolvedUserId, cardMessageId: answeredCardMessageId,
              reason: isAbortError ? 'stopped' : 'reply_failed', eventFetch, request })
          }
          throw streamError
        }
    } finally {
      // The run-end sweep removes this chat's sandboxes even while a command runs in one,
      // because it assumes the chat's run is over. That is true while this request still has
      // the chat (or nobody does). If another turn holds it now — this lock was taken as an
      // orphan, or cleared by a Stop — the sweep would kill that turn's commands, and that
      // turn already swept on its way in. Measured live before the lock fix: an old reply's
      // sweep killed a newer turn's approved command (`_local/lock-prune-proof/`).
      if (!isSessionTurnHeldByAnother(sessionId, sessionTurnId)) {
        try {
          const sandboxCleanupWarnings =
            await nativeToolService.cleanupExecutionSandboxesForSession(sessionId)
          if (sandboxCleanupWarnings.length > 0) {
            console.warn(
              '[Send-Routed] sandbox post-run cleanup warnings:',
              {
                sessionId,
                warnings: sandboxCleanupWarnings,
              },
            )
          }
        } catch (sandboxCleanupError) {
          console.error(
            '[Send-Routed] sandbox post-run cleanup failed:',
            sandboxCleanupError,
          )
        }
      } else {
        console.warn(
          '[Send-Routed] Skipped the run-end sandbox sweep: another turn holds this chat now',
          { sessionId },
        )
      }
	      // SA-114 P1 (DL-114-02): the steer inbox is cleared beside the session-turn lock,
	      // so a finished request never leaves accepted text behind. Everything promotable
	      // has already been taken by the promotion loop above; what remains here is either
	      // a DM steer that degrades to `wait` (DL-114-13) or a steer on a turn the user
	      // stopped, which the client still holds and re-sends itself.
	      //
	      // Scoped like the lock release below (F-P1-1): a turn stopped during setup can
	      // unwind this `finally` AFTER a retry has registered its own stream and accepted
	      // steers for it, and an unscoped clear would drop that live turn's text after
	      // the route already answered 202. This request's own streams are gone by now
	      // (`handleBatshitAgentStream` clears each in its own `finally`), so whatever
	      // stream is live belongs to someone else and its mail is kept.
	      const steerKeepMessageId = getActiveStream(sessionId)?.messageId ?? null
	      // SA-114 P4 (DL-114-13): a DM steer is never promoted, so the end of the turn is
	      // where it goes back to being an ordinary inbox item. It is read HERE, before the
	      // clear below, because after that there is nothing left to read — and with the same
	      // `keepMessageId`, so it degrades exactly what the clear is about to delete.
	      // Awaited inside the `finally` on purpose: the response has already been returned,
	      // and the alternative is a floating promise racing the next request's enqueue.
	      const missedDmSteers = takeMissedDmSteers(sessionId, {
	        keepMessageId: steerKeepMessageId,
	      })
	      if (missedDmSteers.length > 0) {
	        await degradeMissedDmSteers(missedDmSteers, STEER_MISSED_REASON)
	      }
        const missedUserSteers = takeMissedUserSteers(sessionId, { keepMessageId: steerKeepMessageId })
        await publishUnansweredSteers({ sessionId, steerIds: missedUserSteers.map((entry) => entry.steerId),
          reason: turnStopSignal?.aborted || requestStopped ? 'stopped' : 'reply_failed', eventFetch, request })
	      clearSteerInbox(sessionId, {
	        keepMessageId: steerKeepMessageId,
	      })
	      // SA-113 P1: release only THIS request's lock. A turn stopped during setup can
	      // have its lock cleared by the interrupt route (or the orphan prune) and a retry
	      // can already own a new one by the time this `finally` unwinds; an unowned
	      // release would then cancel the live turn's lock. It releases by REGISTRATION
	      // (2026-09-18), not by message id: an Approve click registers under the card's own
	      // message id, so the reply that raised the card, released by id, deleted the
	      // click's lock and a second click on the same card ran the command again.
	      // BL-713: and it says how it ended, so a line of waiting sends holds at a card this
	      // request stopped at (never a turn beside the card), keeps its sends after the page's own
	      // Deny of an expired card, or goes on after the user's click, in the same step.
	      releaseSessionTurn(sessionId, sessionTurnId, {
	        approvalCardMessageId: endedAtApprovalCardMessageId,
	        answeredApproval:
	          approvalClick && clickAnswerRecorded ? { expiryOnly: expiryOnlyAnswer } : null,
	      })
	      const cardHold = getQueueCardHold(sessionId)
	      // A hold this request's last run started, or the one a refused click put back after it
	      // told the tabs the hold had ended.
	      if (cardHold && (cardHold.messageId === endedAtApprovalCardMessageId || holdEndForwarded)) {
	        // Every tab: the waiting sends wait for the user's answer to this card.
	        await forwardQueuedSendEvent(request, {
	          type: 'queued_send_hold',
	          sessionId,
	          heldForApprovalCard: { messageId: cardHold.messageId },
	        })
	      }
	    }
  } catch (error) {
    console.error('Error in send-routed endpoint:', error)
    const status = getFailureStatus(error) ?? 500
    const details = error instanceof Error ? error.message : String(error)
    const code =
      typeof (error as any)?.code === 'string' ? (error as any).code : null
    const errorMessage = status >= 500 ? 'Failed to send message' : details

    return json(
      {
        error: errorMessage,
        ...(code ? { code } : {}),
        details,
      },
      { status },
    )
  } finally {
    // Bounded: the forward has its own time limit (`forwardQueuedSendEvent`), and never throws.
    try { if (queuedNoticeSent) await queuedNoticeSent }
    finally {
      planOwner.listeners.abort()
      for (const lease of planOwner.leases) lease.release()
      requestPlanOwners.delete(request)
    }
  }
}
