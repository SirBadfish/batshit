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
import {
  buildEphemeralImageUserMessage,
  createEphemeralImageRegistry,
  resolveToolResultImageDelivery,
  type EphemeralImageRegistry,
  type EphemeralImageRegistryEntry
} from '$lib/server/services/toolResultImageDelivery'
import type { ThinkRequest, ThoughtResponse } from '$lib/types/aiBrain'
import type { AgentDcmDisplaySettings } from '$lib/types/database'
import type { ModelCapabilities, ModelConnectionInfo } from '$lib/types/savedModels'
import type { CodexRuntimeSettings } from '$lib/types/codex'
import type { ClaudeRuntimeSettings } from '$lib/types/claude'
import type { ToolApprovalMode } from '$lib/types/tool-approvals'
import type { Mode4Style } from '$lib/constants/mode4'
import { env } from '$env/dynamic/private'
import { v4 as uuidv4 } from 'uuid'
import type { GatewayMetadata, ToolMetadataMap } from './mcpGatewayTypes'
import { getSubagentByWorkflowName } from './subagentRegistry' // Story 6.7c: Subagent registry lookup
import { redis } from '$lib/server/redis' // Story 6.8: Load agent assigned workflows
import { nativeToolService, type NativeToolApprovalPolicy } from './nativeTools'
import { isNativeToolName } from './nativeToolConstants'
import { compileClipReferencesForAiView } from '$lib/utils/clipAiView'
import { toOwnedBytes } from '$lib/utils/binary'
import {
  compileManagedSubagentSystemPrompt,
  executeManagedSubagent
} from '$lib/server/services/subagentRunner'
import { normalizeSubagentType, type SubagentType } from '$lib/utils/subagentType'
import { isOpenAIReasoningParameterRestrictedModelId } from '$lib/utils/parameterFilter'
import { collectReasoningTextFromFinish } from '$lib/utils/reasoningDisplay'
import { applyApiPromptCachePolicy } from '$lib/server/services/apiPromptCachePolicy'
import { normalizeUsageLike } from '$lib/server/services/apiProviderUsage'

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

/**
 * Tool source metadata maps (Story 6.4, Story 6.7c, SA-005)
 * Cached during tool loading for O(1) detection performance
 * SA-005: Removed toolVaultTools (Tool Vault removed October 2025)
 */
interface ToolSourceMaps {
  workflowTools: Map<string, { webhookUrl: string }>
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

function buildZipControlNotice(zipId: string): string {
  return [
    'Batshit zip control:',
    `zipId: ${zipId}`,
    'Use this exact zipId in unzip/zip controls if this tool result should stay expanded or change zip state. Use zip IDs only.'
  ].join('\n')
}

function appendZipControlNoticeToModelOutput(modelOutput: any, zipId: string): any {
  const notice = buildZipControlNotice(zipId)
  if (!modelOutput || typeof modelOutput !== 'object') {
    return {
      type: 'text',
      value: [stringifyForToolModelOutput(modelOutput), notice].filter(Boolean).join('\n\n')
    }
  }

  if (modelOutput.type === 'text' || modelOutput.type === 'error-text') {
    return {
      ...modelOutput,
      value: [String(modelOutput.value ?? ''), notice].filter(Boolean).join('\n\n')
    }
  }

  if (modelOutput.type === 'content' && Array.isArray(modelOutput.value)) {
    return {
      ...modelOutput,
      value: [
        ...modelOutput.value,
        {
          type: 'text',
          text: notice
        }
      ]
    }
  }

  if (modelOutput.type === 'json' || modelOutput.type === 'error-json') {
    return {
      type: 'text',
      value: [stringifyForToolModelOutput(modelOutput.value), notice].filter(Boolean).join('\n\n')
    }
  }

  return modelOutput
}

function buildDefaultToolModelOutput(output: unknown): any {
  return typeof output === 'string'
    ? { type: 'text', value: output }
    : { type: 'json', value: output ?? null }
}

export interface NativeModeRequest extends ThinkRequest {
  /**
   * SA-105 P2 (DL-105-06): the saved model's capabilities, so the tool-result
   * image lane uses the same vision rule as attached clips. Optional and
   * unknown-means-allowed, matching the clip posture.
   */
  modelCapabilities?: ModelCapabilities | null
  mode4Style?: Mode4Style
  agentId?: string // Story 6.8: Agent ID for loading assigned workflows
  agentSlug?: string | null
  toolsEnabled?: boolean
  maxToolRounds?: number
  availableWorkflows?: string[] // List of workflow IDs that can be called as tools
  selectedGateways?: string[] // Story 5.22: List of selected MCP Gateway IDs from chat bar
  toolSelections?: import('$lib/types/database').MCPToolSelections // Story 5.23: Per-tool selections from chat bar
  selectedCliToolIds?: string[]
  dcmDisplaySettings?: AgentDcmDisplaySettings | null
  allowArtifactRuntimeTools?: boolean
  allowFabricControlTools?: boolean
  /** SA-104 P3: PRIMARY runs of memory-enabled agents; subagent runner leaves it false. */
  memoryControlsEnabled?: boolean
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
  providerSettings?: Record<string, any> | null
  reserveToolZipId?: (params: {
    toolCallId: string
    toolName?: string
    input?: unknown
  }) => string | undefined
  registerReservedToolZipId?: (params: {
    toolCallId: string
    toolName?: string
    zipId: string
  }) => string | undefined
  codexSettings?: CodexRuntimeSettings | null
  claudeSettings?: ClaudeRuntimeSettings | null
  projectPath?: string | null
  simulateStreamingEffect?: boolean
  taggedReasoningTagName?: 'think' | null
  onFinish?: (params: {
    text: string
    usage?: any
    steps?: any[]
    totalUsage?: any
    reasoning?: string[]
    responseMessages?: ModelMessage[]
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

  private wrapToolsWithZipControlNotices(
    tools: Record<string, any>,
    reserveToolZipId?: NativeModeRequest['reserveToolZipId']
  ): Record<string, any> {
    if (!reserveToolZipId) return tools

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

      wrappedTools[toolName] = {
        ...toolDefinition,
        ...(typeof originalExecute === 'function'
          ? {
              execute: (input: unknown, options: any) => {
                const toolCallId =
                  typeof options?.toolCallId === 'string' ? options.toolCallId : ''
                if (toolCallId) {
                  reserveToolZipId({ toolCallId, toolName, input })
                }
                return originalExecute.call(toolDefinition, input, options)
              }
            }
          : {}),
        toModelOutput: async (params: {
          toolCallId: string
          input: unknown
          output: unknown
        }) => {
          const zipId =
            typeof params.toolCallId === 'string' && params.toolCallId.trim()
              ? reserveToolZipId({
                  toolCallId: params.toolCallId,
                  toolName,
                  input: params.input
                })
              : undefined
          const modelOutput =
            typeof originalToModelOutput === 'function'
              ? await originalToModelOutput.call(toolDefinition, params)
              : buildDefaultToolModelOutput(params.output)

          return zipId
            ? appendZipControlNoticeToModelOutput(modelOutput, zipId)
            : modelOutput
        }
      }
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
      providerOptionKeys: metadata.providerOptionKeys
    })
  }

  /**
   * Process API runtime native AI request with clean streaming
   * CRITICAL: Uses existing compileForAI() output directly
   * CRITICAL: Workflows become simple async tools
   */
  async processNativeMode(request: NativeModeRequest): Promise<ThoughtResponse> {
    const startTime = Date.now()

    logger.debug('[VercelBrain API] Processing native mode request', {
      sessionId: request.sessionId,
      model: request.model,
      messageCount: request.messages?.length,
      hasTools: !!request.availableTools,
      hasWorkflows: !!request.availableWorkflows
    })

    try {
      // Validate messages
      if (!request.messages || request.messages.length === 0) {
        throw new Error('No messages provided to processNativeMode()')
      }

      // Get model instance from ProviderManager
      const model = await this.getModel(
        request.model,
        request.connection,
        request.userId,
        request.taggedReasoningTagName,
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

      // Build tools from both regular tools and workflows
      // Story 6.4: Also get metadata maps for tool source detection
      // Story 6.8: Now includes agentId for loading assigned workflows
      const { tools, maps: toolMaps, toolApprovals, ephemeralImages } = await this.buildToolsForMode3(
        request.availableTools,
        request.availableWorkflows,
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
          projectPath: request.projectPath ?? null,
          selectedCliToolIds: request.selectedCliToolIds,
          memoryControlsEnabled: request.memoryControlsEnabled,
          parentModelId: request.model ?? null,
          parentConnection: request.connection ?? null,
          parentCapabilities: request.modelCapabilities ?? null,
          parentMessageId: request.messageId ?? null,
          reserveToolZipId: request.reserveToolZipId,
          abortSignal: request.abortSignal
        }
      )

      let toolsForRequest = tools
      const openaiTools = await this.buildOpenAITools(request)
      if (openaiTools) {
        toolsForRequest = this.mergeToolSets(toolsForRequest, openaiTools)
      }

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
        tools: cachePolicy.tools,
        ...(Object.keys(toolApprovals).length > 0 ? { toolApproval: toolApprovals } : {}),
        stopWhen: isStepCount(request.maxToolRounds || 10), // Multi-round tool execution
        ...this.buildGenerationSettings(request),
        providerOptions: cachePolicy.providerOptions,
        // SA-107: per-session cache-affinity headers (xAI/Baseten/Fireworks direct lanes).
        ...(cachePolicy.headers ? { headers: cachePolicy.headers } : {}),
        ...(downloadGuard ? { experimental_download: downloadGuard } : {}),
        // SA-105 P2 (DL-105-03): on lanes whose tool results serialize as text,
        // images recalled during this run are appended as ONE user message for
        // the next step. Present only when a registry exists — i.e. only on
        // `synthetic_user` lanes — so no other run's call shape changes.
        ...(ephemeralImages
          ? { prepareStep: this.buildEphemeralImagePrepareStep(ephemeralImages) }
          : {})
      })

      // Process the full response
      let content = ''
      const intermediateSteps: ThoughtResponse['intermediateSteps'] = []

      // Collect the full response (AI SDK 7: `stream` replaces `fullStream`)
      for await (const part of result.stream) {
        switch (part.type) {
          case 'text-delta':
            content += part.text
            break

          case 'tool-result': {
            // Story 6.4: Record intermediate step with complete metadata
            const toolName = (part as any)?.toolName
            if (typeof toolName === 'string') {
              const toolInput = (part as any).input ?? (part as any).args ?? {}
              const toolOutput = (part as any).output ?? (part as any).result

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

          default:
            // Ignore other event types (start, start-step, text-start, text-end, finish-step, etc.)
            // Vercel AI SDK sends many event types - we only need text-delta and tool-result
            break
        }
      }

      // Get usage information
      const usage = normalizeUsageLike(await result.usage)
      const totalTokens = usage?.totalTokens || 0
      const promptTokens = usage?.inputTokens || 0
      const completionTokens = usage?.outputTokens || 0

      // Verify multimodal efficiency
      if (request.images?.length && promptTokens > 0) {
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
        usage: {
          promptTokens,
          completionTokens,
          totalTokens,
          imageTokens: request.images?.length ? request.images.length * 765 : undefined,
          ...(typeof usage?.cachedInputTokens === 'number'
            ? { cachedInputTokens: usage.cachedInputTokens }
            : {}),
          ...(typeof usage?.cacheCreationInputTokens === 'number'
            ? { cacheCreationInputTokens: usage.cacheCreationInputTokens }
            : {})
        },
        metadata: {
          provider: this.getProviderName(request.model),
          latency: Date.now() - startTime,
          cached: typeof usage?.cachedInputTokens === 'number' && usage.cachedInputTokens > 0,
          fallbackUsed: false,
          mode: 'native' // Mark as API runtime
        }
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
          usage: {
            totalTokens,
            promptTokens,
            completionTokens
          },
          steps: intermediateSteps
        })
      }

      return thoughtResponse

    } catch (error: any) {
      console.error('[VercelBrain API] Error in processNativeMode:', error)

      // Ensure cleanup even on error
      try {
        const { cleanupMCPClients } = await import('./dockerMCPIntegration')
        await cleanupMCPClients(request.userId, request.sessionId)
      } catch (cleanupError) {
        console.error('[VercelBrain] Error cleaning up MCP clients on error:', cleanupError)
      }

      // Handle specific error types
      if (error.message?.includes('API key')) {
        throw {
          code: 'PROVIDER_AUTH_ERROR',
          message: `Authentication failed for provider: ${error.message}`
        }
      }

      if (error.message?.includes('rate limit')) {
        throw {
          code: 'RATE_LIMIT',
          message: 'Provider rate limit exceeded'
        }
      }

      throw error
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

    // Priority 4: Check if it's a Workflow tool
    // AFTER subagent check - workflows are more general category
    // Regular n8n workflows as tools (not subagents)
    const workflowMetadata = toolMaps.workflowTools.get(toolName)
    if (workflowMetadata) {
      return {
        toolProvider: 'n8n-workflow',
        toolSource: 'workflow-webhook',
        webhookUrl: workflowMetadata.webhookUrl
      }
    }

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
        // compiler, under `CLIPPED ITEMS (USER UPLOADS)`. This lane used to
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
   * Build tools for API runtime - combines MCP tools, workflows, and subagents
   * Story 5.22: Now uses unified MCP Gateway Discovery
   * Story 5.23: Supports per-tool selection filtering
   * Story 6.4: Returns metadata maps for tool source detection
   * Story 6.8: Loads assigned workflows from agent settings
   * SA-005: Tool Vault removed (October 2025)
   * CRITICAL: Workflows become simple async functions
   * CRITICAL: Direct execution only
   * CRITICAL: If regularTools is provided with names, it acts as a filter for which tools to include
   */
  private async buildToolsForMode3(
    regularTools?: ThinkRequest['availableTools'],
    workflows?: string[],
    sessionId?: string,
    userId?: string,
    selectedGateways?: string[],
    toolSelections?: import('$lib/types/database').MCPToolSelections,
    agentId?: string, // Story 6.8: Agent ID for loading assigned workflows
    agentContext?: {
      assignedSubagents?: any[]
      defaultGateways?: string[] | null
    },
    preloadedGatewayTools?: ToolMetadataMap['tools'] | null,
    preloadedGatewayMetadata?: ToolMetadataMap['metadata'] | null,
    toolApprovalMode?: ToolApprovalMode,
    nativeContext?: {
      providerSettings?: Record<string, any> | null
      projectPath?: string | null
      selectedCliToolIds?: string[]
      dcmDisplaySettings?: AgentDcmDisplaySettings | null
      allowArtifactRuntimeTools?: boolean
      allowFabricControlTools?: boolean
      memoryControlsEnabled?: boolean
      parentModelId?: string | null
      parentConnection?: ModelConnectionInfo | null
      /** SA-105 P2 (DL-105-06): saved-model capabilities for the image lane gate. */
      parentCapabilities?: ModelCapabilities | null
      /** SA-093 P4: parent send's message id so subagent forensics can land on its snapshot. */
      parentMessageId?: string | null
      reserveToolZipId?: NativeModeRequest['reserveToolZipId']
      abortSignal?: AbortSignal
    }
  ): Promise<{
    tools: Record<string, any> | undefined
    maps: ToolSourceMaps
    toolApprovals: Record<string, NativeToolApprovalPolicy>
    /** SA-105 P2: non-null only on `synthetic_user` lanes. */
    ephemeralImages: EphemeralImageRegistry | null
  }> {
    const tools: Record<string, any> = {}
    const toolApprovals: Record<string, NativeToolApprovalPolicy> = {}
    // SA-105 P2: resolved below when native tools are built, then handed back to
    // the caller so the streamText call can register `prepareStep` for exactly
    // the runs that need it.
    let ephemeralImages: EphemeralImageRegistry | null = null

    // Story 6.4, 6.7c, SA-005: Track metadata for O(1) detection
    const toolMaps: ToolSourceMaps = {
      workflowTools: new Map<string, { webhookUrl: string }>(),
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
        // registry — and therefore only it gets `prepareStep` registered on the
        // streamText call below. Every other run's SDK call shape stays exactly
        // as it was (DL-105-13 parity).
        if (imageDelivery.lane === 'synthetic_user') {
          ephemeralImages = createEphemeralImageRegistry()
        }

        const nativeToolSet = await nativeToolService.buildMode3NativeTools({
          userId,
          agentId: agentId ?? null,
          sessionId,
          selectedGateways,
          toolSelections,
          selectedCliToolIds: nativeContext?.selectedCliToolIds,
          dcmDisplaySettings: nativeContext?.dcmDisplaySettings ?? null,
          allowArtifactRuntimeTools: nativeContext?.allowArtifactRuntimeTools,
          allowFabricControlTools: nativeContext?.allowFabricControlTools,
          memoryControlsEnabled: nativeContext?.memoryControlsEnabled,
          projectPath: nativeContext?.projectPath ?? null,
          providerSettings: nativeContext?.providerSettings ?? null,
          toolApprovalMode,
          imageDelivery,
          ephemeralImages
        })
        Object.assign(tools, nativeToolSet.tools)
        Object.assign(toolApprovals, nativeToolSet.toolApprovals)
      } catch (error) {
        console.error('[VercelBrain API] Failed to build native tools:', error)
      }
    }

    // SA-005: Tool Vault loading removed (Tool Vault removed October 2025)

    const processAssignedSubagents = async (subagents: any[]) => {
      const candidates = Array.isArray(subagents) ? subagents : []
      if (candidates.length === 0) {
        return
      }

      const managedSubagents = candidates.filter((subagent) => {
        const subagentType = normalizeSubagentType(subagent, subagent?.subagentType)
        return subagentType !== 'n8n-subnode'
      })

      if (managedSubagents.length !== candidates.length) {
        const filtered = candidates.length - managedSubagents.length
        if (filtered > 0) {
          console.warn(`[API Runtime] Filtered ${filtered} retired n8n Subnode Subagent record(s).`)
        }
      }

      for (const subagent of managedSubagents) {
        try {
          const subagentType = normalizeSubagentType(subagent, subagent?.subagentType)
          if (subagentType === 'n8n-subnode') continue
          const webhookUrl = subagent.webhookUrl || subagent.webhook_url || subagent.workflowName

          const baseName = subagent.id || subagent.name || subagent.displayName || 'subagent'
          const sanitizedName = normalizeToolKey(baseName)

          const { description: compiledDescription } =
            await compileManagedSubagentSystemPrompt(subagent, userId || 'default')

          const workflowTool = dynamicTool({
            description: compiledDescription || subagent.description || `Execute ${subagent.displayName || baseName} subagent`,
            inputSchema: z.object({
              chatInput: z.string().describe('Message to send to the subagent')
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
              const normalizedParentAgentId =
                (baseInput as any).parent_agent_id ??
                (baseInput as any).parentAgentId ??
                (baseInput as any).primary_agent_id ??
                (baseInput as any).primaryAgentId ??
                (baseInput as any).agent_id ??
                (baseInput as any).agentId ??
                agentId ??
                null
              if (!normalizedUserId || !normalizedSessionId) {
                return 'Subagent execution is missing required user/session context.'
              }

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
                abortSignal: nativeContext?.abortSignal
              })

              return {
                output: result.output,
                intermediateSteps: result.intermediateSteps
              }
            }
          })

          tools[sanitizedName] = workflowTool

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

          toolMaps.subagentTools.set(sanitizedName, subMeta)

          logger.debug(
            `[VercelBrain API] Subagent ready: ${sanitizedName} (${subagent.displayName || baseName})`,
            { webhookUrl: webhookUrl || 'none', subagentId: subagent.id }
          )
        } catch (error) {
          console.error(
            `[API Runtime] Error loading subagent ${subagent.displayName || subagent.id}:`,
            error
          )
        }
      }
    }

    const providedSubagents = Array.isArray(agentContext?.assignedSubagents)
      ? agentContext?.assignedSubagents ?? null
      : null

    if (providedSubagents?.length) {
      if (providedSubagents.length === 0) {
        console.warn('[VercelBrain API] No compatible subagents in provided list; skipping subagent tool registration')
      } else {
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

    // Regular tools are already filtered from frontend, no need to add more

    // Add workflow tools if provided
    // Story 5.11: Updated to use new signature with dynamic discovery
    if (workflows && workflows.length > 0) {
      const { loadWorkflowTools } = await import('./workflowTools')
      const subagentToolNames = new Set<string>(toolMaps.subagentTools.keys())
      const isSubagentToolName = (name: string) => {
        if (subagentToolNames.has(name)) return true
        const normalized = name.replace(/-/g, '_')
        if (subagentToolNames.has(normalized)) return true
        const hyphenated = name.replace(/_/g, '-')
        if (subagentToolNames.has(hyphenated)) return true
        return false
      }

      // If regularTools is provided, it's the explicit selection from chat bar
      if (regularTools !== undefined) {
        if (regularTools.length > 0) {
          const selectedToolNames = regularTools.map(t => t.name)

          const workflowTools = await loadWorkflowTools(
            userId,
            sessionId,
            workflows
          )

          // Filter workflow tools based on selection
          for (const [toolName, toolDef] of Object.entries(workflowTools)) {
            if (isSubagentToolName(toolName)) {
              continue
            }
            if (selectedToolNames.includes(toolName)) {
              tools[toolName] = toolDef
              // Story 6.4: Track workflow metadata (webhookUrl if available)
              const webhookUrl = (toolDef as any).webhookUrl || (toolDef as any).metadata?.webhookUrl
              if (webhookUrl) {
                toolMaps.workflowTools.set(toolName, { webhookUrl })
              }
            }
          }
        } else {
          // regularTools is empty array - NO tools selected, include NONE
          logger.debug(`[VercelBrain API] No tools selected - excluding all workflow tools`)
        }
      } else {
        // No filter provided - include all workflow tools
        const workflowTools = await loadWorkflowTools(
          userId,
          sessionId,
          workflows
        )
        // Story 6.4: Track all workflow metadata
        for (const [toolName, toolDef] of Object.entries(workflowTools)) {
          if (isSubagentToolName(toolName)) {
            continue
          }
          tools[toolName] = toolDef
          const webhookUrl = (toolDef as any).webhookUrl || (toolDef as any).metadata?.webhookUrl
          if (webhookUrl) {
            toolMaps.workflowTools.set(toolName, { webhookUrl })
          }
        }
      }

      // Story 6.7c: Check workflows against subagent registry
      // CRITICAL: Only check if userId is available (session-scoped caching)
      if (userId && toolMaps.workflowTools.size > 0) {
        for (const [workflowName, workflowMeta] of toolMaps.workflowTools.entries()) {
          // Check if this workflow is a registered subagent
          const subagentMetadata = await getSubagentByWorkflowName(workflowName, userId)

          if (subagentMetadata) {
            // This workflow is a registered subagent - store enhanced metadata
            toolMaps.subagentTools.set(workflowName, {
              isSubagent: true,
              subagentName: subagentMetadata.displayName,
              subagentId: subagentMetadata.id,
              subagentType: 'n8n-workflow',
              workflowId: workflowName,  // Using workflow name as ID
              webhookUrl: workflowMeta.webhookUrl
            })

            logger.debug(`[VercelBrain API] Subagent detected: ${workflowName} (${subagentMetadata.displayName})`)
          }
        }
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

    const wrappedTools = this.wrapToolsWithZipControlNotices(
      tools,
      nativeContext?.reserveToolZipId
    )

    // Story 6.4: Return both tools and metadata maps for detection
    return {
      tools: Object.keys(wrappedTools).length > 0 ? wrappedTools : undefined,
      maps: toolMaps,
      toolApprovals,
      ephemeralImages
    }
  }

  /**
   * Convert regular n8n tools to Vercel format
   * These are simple tools that don't need workflow execution
   */
  private convertRegularTools(
    n8nTools: ThinkRequest['availableTools']
  ): Record<string, any> {
    const tools: Record<string, any> = {}

    if (!n8nTools) return tools

    for (const n8nTool of n8nTools) {
      // Build a simple tool schema
      const inputSchema = this.extractToolSchema(n8nTool)

      // Use the tool() wrapper function from Vercel AI SDK
      tools[n8nTool.name] = tool({
        description: n8nTool.description || `Execute ${n8nTool.name}`,
        inputSchema: inputSchema,
        execute: async (args: any) => {
          logger.debug(`[VercelBrain API] Executing tool ${n8nTool.name}`, {
            argKeys: args && typeof args === 'object' ? Object.keys(args) : []
          })

          // Mock implementation - replace with actual tool execution
          return {
            success: true,
            result: `Tool ${n8nTool.name} executed with args: ${JSON.stringify(args)}`,
            timestamp: Date.now()
          }
        }
      })
    }

    return tools
  }

  /**
   * Extract tool schema from various formats
   * Handles Zod, JSON Schema, and other formats
   */
  private extractToolSchema(tool: any): z.ZodSchema<any> {
    // Try different schema formats
    const sourceSchema = tool.schema || tool.parameters || tool.inputSchema || {}

    // Build a simple Zod schema
    const schemaProps: Record<string, z.ZodTypeAny> = {}

    if (sourceSchema.properties && typeof sourceSchema.properties === 'object') {
      // JSON Schema format
      for (const [key, prop] of Object.entries(sourceSchema.properties as any)) {
        const propSchema = prop as any
        let zodType: z.ZodTypeAny = z.string() // default

        if (propSchema.type === 'number') zodType = z.number()
        else if (propSchema.type === 'boolean') zodType = z.boolean()
        else if (propSchema.type === 'array') zodType = z.array(z.any())
        else if (propSchema.type === 'object') zodType = z.object({})

        if (propSchema.description) {
          zodType = zodType.describe(propSchema.description)
        }

        // Check if optional
        if (!sourceSchema.required?.includes(key)) {
          zodType = zodType.optional()
        }

        schemaProps[key] = zodType
      }
    }

    // If no properties extracted, create a simple schema
    if (Object.keys(schemaProps).length === 0) {
      return z.object({ input: z.string().optional() })
    }

    return z.object(schemaProps)
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
   * Get model instance - delegates to ProviderManager
   * Includes fallback support and caching
   */
  private async getModel(
    modelName: string,
    connection?: ModelConnectionInfo | null,
    userId?: string | null,
    taggedReasoningTagName?: NativeModeRequest['taggedReasoningTagName'],
  ): Promise<LanguageModel> {
    const manager = await this.getProviderManagerForUser(userId)
    const transport = connection?.type
    const service = connection?.service ?? undefined
    const model = manager.getModel(modelName, {
      transport,
      service
    })
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
  private buildEphemeralImagePrepareStep(registry: EphemeralImageRegistry) {
    return ({ messages, steps }: { messages: any[]; steps: any[] }) => {
      const previous = steps[steps.length - 1]
      if (!previous) return undefined

      const pending: EphemeralImageRegistryEntry[] = []
      for (const part of previous.content ?? []) {
        if (part?.type !== 'tool-result') continue
        const entry = registry.take(part.toolCallId)
        if (entry) pending.push(entry)
      }
      if (pending.length === 0) return undefined

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
      if (injected.length === 0) return undefined

      return { messages: [...messages, ...injected] }
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

    try {
      const model = await this.getModel(
        request.model,
        request.connection,
        request.userId,
        request.taggedReasoningTagName,
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
      const toolsEnabled = request.toolsEnabled !== false
      let toolsForRequest: Record<string, any> | undefined
      let toolApprovalsForRequest: Record<string, NativeToolApprovalPolicy> = {}
      let toolMaps: ToolSourceMaps = {
        workflowTools: new Map<string, { webhookUrl: string }>(),
        gatewayTools: new Map<string, GatewayMetadata>(),
        subagentTools: new Map<string, SubagentToolMetadata>()
      }
      // SA-105 P2: this is the STREAMING path — the one real chat sends take.
      // Wiring only the non-streaming `processNativeMode` left the synthetic
      // lane dead in production, which is exactly what the live recall probe
      // caught before this was fixed.
      let ephemeralImagesForRequest: EphemeralImageRegistry | null = null

      if (toolsEnabled) {
        // Story 6.4: Get BOTH tools AND toolMaps for metadata injection
        // Story 6.8: Now includes agentId for loading assigned workflows
        const { tools, maps, toolApprovals, ephemeralImages } = await this.buildToolsForMode3(
          request.availableTools,
          request.availableWorkflows,
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
            projectPath: request.projectPath ?? null,
            selectedCliToolIds: request.selectedCliToolIds,
            dcmDisplaySettings: request.dcmDisplaySettings ?? null,
            allowArtifactRuntimeTools: request.allowArtifactRuntimeTools,
            allowFabricControlTools: request.allowFabricControlTools,
            memoryControlsEnabled: request.memoryControlsEnabled,
            parentModelId: request.model ?? null,
            parentConnection: request.connection ?? null,
            parentCapabilities: request.modelCapabilities ?? null,
            parentMessageId: request.messageId ?? null,
            reserveToolZipId: request.reserveToolZipId,
            abortSignal: request.abortSignal
          }
        )
        toolMaps = maps
        toolsForRequest = tools
        toolApprovalsForRequest = toolApprovals
        ephemeralImagesForRequest = ephemeralImages

        const openaiTools = await this.buildOpenAITools(request)
        if (openaiTools) {
          toolsForRequest = this.mergeToolSets(toolsForRequest, openaiTools)
        }
      } else {
        logger.debug('[VercelBrain API] Tools disabled for this request')
      }

      // Story 6.4: Wrap the SDK onEnd callback to inject metadata into steps.
      // AI SDK 7 semantics: event.usage is the AGGREGATE across all steps (what
      // v6 called totalUsage); last-step numbers live on event.finalStep.usage.
      // Batshit's internal onFinish contract keeps totalUsage = run aggregate.
      const wrappedOnEnd = request.onFinish ? async ({ text, steps, usage, totalUsage, responseMessages: eventResponseMessages, finalStep }: any) => {
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
        await request.onFinish!({
          text,
          steps: enhancedSteps,
          totalUsage: aggregateUsage,
          usage: aggregateUsage,
          reasoning: finishReasoning ? [finishReasoning] : undefined,
          responseMessages
        })
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

      const result = await streamText({
        model,
        messages: cachePolicy.messages,
        // Every system-role entry in `messages` originates from Batshit's own
        // server-side compiler, never from untrusted content (SA-098 D1), so the
        // v7 system-in-messages guard is relaxed to preserve Batshit's prompt
        // order and provider cache anchoring on the compiled payload.
        allowSystemInMessages: true,
        tools: cachePolicy.tools,
        ...(Object.keys(toolApprovalsForRequest).length > 0
          ? { toolApproval: toolApprovalsForRequest }
          : {}),
        stopWhen: isStepCount(request.maxToolRounds || 10),
        ...this.buildGenerationSettings(request),
        providerOptions: cachePolicy.providerOptions,
        // SA-107: per-session cache-affinity headers (xAI/Baseten/Fireworks direct lanes).
        ...(cachePolicy.headers ? { headers: cachePolicy.headers } : {}),
        abortSignal: request.abortSignal, // Forward abort signal
        // Raw chunks feed the OpenAI-compatible reasoning_content lane; request
        // bodies feed Execution Viewer evidence (v7 excludes them by default).
        include: { rawChunks: true, requestBody: true },
        ...(downloadGuard ? { experimental_download: downloadGuard } : {}),
        onStepEnd: ({ text, toolCalls, toolResults, finishReason }) => {
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
        onEnd: wrappedOnEnd,
        onAbort: request.onAbort,
        // SA-105 P2 (DL-105-03): the synthetic image lane on the streaming path.
        ...(ephemeralImagesForRequest
          ? { prepareStep: this.buildEphemeralImagePrepareStep(ephemeralImagesForRequest) }
          : {})
      })

      // Return the full result for SSE conversion
      ;(result as any).__toolMaps = toolMaps
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
