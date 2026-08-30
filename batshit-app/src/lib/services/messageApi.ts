// Message API operations for batshit
// Handles sending messages, webhook communication, and message-related operations

import type { Message } from '$lib/stores/messages.svelte'
import { logger } from '$lib/utils/logger'
import type { MCPToolSelections } from '$lib/types/database'
import type { ParameterValue } from '$lib/data/parameter-schemas'
import { resolveModelIds } from '$lib/utils/modelIdResolver'
import {
  filterSettingsForN8N,
  listUnsupportedParameterKeys,
} from '$lib/utils/modelCompatibility'
import { getMatrixEntries } from '$lib/stores/compatibilityMatrix.svelte'
import { extractN8nWebhookError } from '$lib/utils/n8nWebhookResponse'
import { resolveSubagentSlug } from '$lib/utils/subagentSlug'
import { resolveAgentMemoryEnabled } from '$lib/utils/memoryControl'

/**
 * SA-104 P5: chat-surface "memory inserted" stamps for the native n8n lane, keyed by
 * assistant messageId. `sendMessage` awaits the turn-commit BEFORE consuming the
 * webhook response body, so the stamp is always here before the end-event finalize
 * (which can only run after body consumption) asks for it.
 */
const pendingMemoryInsertedByMessageId = new Map<string, Record<string, any>>()

export function consumePendingMemoryInserted(messageId: string): Record<string, any> | null {
  const stamp = pendingMemoryInsertedByMessageId.get(messageId) ?? null
  pendingMemoryInsertedByMessageId.delete(messageId)
  return stamp
}

export interface SendMessagePayload {
  user_message: string
  /** Correlates Batshit messageId ↔ n8n execution for debugging */
  message_id?: string
  /** CamelCase alias for convenience in n8n expressions */
  messageId?: string
  session_id: string
  user_id: string
  agent_id?: string
  agent_display_name?: string
  primary_agent_type?: 'n8n' | 'api' | 'cli'
  primaryAgentType?: 'n8n' | 'api' | 'cli'
  modeId?: string
  originalCreatedAt?: string
  // System prompts - delivered separately from messages for n8n expression fields
  primarySystemPrompt?: string
  subagentPrompts?: Record<string, string>
  subagentDescription?: Record<string, string>
  // Agent settings - included directly in webhook for easy n8n access!
  primary_model_name?: string
  primary_model_provider?: string
  /** SA-017: Explicit normalized model identifiers for n8n expressions */
  primary_model_provider_id?: string
  primary_model_developer_id?: string
  primary_model_model_id?: string
  primary_model_effective_id?: string
  primary_model_parameters?: Record<string, ParameterValue>
  primary_model_parameters_ignored?: string[]
  assignedSubagents?: any[]
  subagentProviders?: Record<string, string | null>
  subagentModels?: Record<string, string | null>
  nativeToolBridge?: Record<string, any>
  selected_cli_tool_ids?: string[]
  selectedCliToolIds?: string[]
  project_path?: string
  projectPath?: string
  resolved_project_path?: string
  resolvedProjectPath?: string
  /** Runtime frontend URL for shared n8n callbacks. */
  batshit_frontend_url?: string
  batshitFrontendUrl?: string
  /** Exact SSE endpoint for legacy/custom n8n callback workflows. */
  batshit_sse_endpoint?: string
  batshitSseEndpoint?: string
  /** Short-lived scoped token for legacy/custom n8n SSE callbacks. */
  batshit_native_tool_token?: string
  batshitNativeToolToken?: string
  batshit_native_tool_header?: string
  batshitNativeToolHeader?: string
  batshit_sse_callback_token?: string
  batshitSseCallbackToken?: string
  batshit_sse_callback_header?: string
  batshitSseCallbackHeader?: string
  batshit_sse_callback_expires_at?: string
  batshitSseCallbackExpiresAt?: string
  /** Artifact completion endpoint for tools/runtime helpers. */
  batshit_artifact_complete_url?: string
  batshitArtifactCompleteUrl?: string
  // Convenience fields for n8n
  chatInput?: unknown
  chatInputText?: string
  batshit_image_inputs?: string[]
  batshitImageInputs?: string[]
  batshit_image_urls?: string[]
  batshitImageUrls?: string[]
  sessionId?: string
}

interface GatewaySelectionResolution {
  resolvedGateways: string[] | null
  defaultGateways: string[] | null
  resolvedToolSelections: MCPToolSelections | null
  gatewayToolMap: Record<string, string[]>
}

const N8N_CALLBACK_AUTH_PAYLOAD_KEYS = [
  'batshit_native_tool_token',
  'batshitNativeToolToken',
  'batshit_native_tool_header',
  'batshitNativeToolHeader',
  'batshit_sse_callback_token',
  'batshitSseCallbackToken',
  'batshit_sse_callback_header',
  'batshitSseCallbackHeader',
  'batshit_sse_callback_expires_at',
  'batshitSseCallbackExpiresAt',
] as const

export function redactN8nCallbackAuthFromPayload<T extends Record<string, any>>(
  payload: T,
): T {
  const redacted = { ...payload }
  for (const key of N8N_CALLBACK_AUTH_PAYLOAD_KEYS) {
    delete redacted[key]
  }
  return redacted as T
}

export function looksLikeNativeAgentStreamResponse(responseText: string): boolean {
  if (!responseText) return false

  return responseText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => {
      if (!line.startsWith('{')) return false
      return /"type"\s*:\s*"(begin|item|chunk|text-delta|finish|end|complete|error)"/.test(line)
    })
}

type N8nNativeChatInputSummary = {
  chatInputText: string
  imageUrls: string[]
}

function collectN8nImageUrl(value: unknown, imageUrls: string[]) {
  if (!value || typeof value !== 'object') return

  const record = value as Record<string, any>
  const directUrl =
    typeof record.url === 'string'
      ? record.url
      : typeof record.image_url?.url === 'string'
        ? record.image_url.url
        : typeof record.imageUrl?.url === 'string'
          ? record.imageUrl.url
          : typeof record.imageUrl === 'string'
            ? record.imageUrl
            : ''

  if (directUrl.trim()) {
    imageUrls.push(directUrl.trim())
  }
}

export function summarizeN8nNativeChatInput(
  chatInput: unknown,
  fallbackText = '',
): N8nNativeChatInputSummary {
  const imageUrls: string[] = []

  if (typeof chatInput === 'string') {
    return {
      chatInputText: chatInput,
      imageUrls,
    }
  }

  if (!Array.isArray(chatInput)) {
    return {
      chatInputText: fallbackText,
      imageUrls,
    }
  }

  const textParts: string[] = []
  for (const part of chatInput) {
    if (typeof part === 'string') {
      if (part.trim()) textParts.push(part)
      continue
    }

    if (!part || typeof part !== 'object') continue
    const record = part as Record<string, any>
    const type = typeof record.type === 'string' ? record.type : ''

    if (type === 'text' && typeof record.text === 'string') {
      if (record.text.trim()) textParts.push(record.text)
      continue
    }

    if (type === 'image_url' || record.image_url || record.imageUrl) {
      collectN8nImageUrl(record, imageUrls)
    }
  }

  return {
    chatInputText: textParts.join('\n\n').trim() || fallbackText,
    imageUrls: Array.from(new Set(imageUrls)),
  }
}

function findBalancedJsonObjectEnd(text: string, startIndex: number): number {
  if (text[startIndex] !== '{') return -1

  let depth = 0
  let inString = false
  let escaping = false

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index]

    if (inString) {
      if (escaping) {
        escaping = false
      } else if (char === '\\') {
        escaping = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === '{') {
      depth += 1
      continue
    }

    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return index + 1
      }
    }
  }

  return -1
}

function looksLikeN8nToolInvocationTracePayload(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false

  const record = value as Record<string, any>
  const action =
    typeof record.action === 'string' && record.action.trim().length > 0
  const ref =
    typeof record.ref === 'string' && record.ref.trim().length > 0
  const id =
    typeof record.id === 'string' && /^call[_-]/i.test(record.id.trim())
  const input = record.input && typeof record.input === 'object'

  return action || ref || (id && input)
}

export function stripN8nToolInvocationTraceText(text: string): string {
  if (!text || !text.includes('Calling ')) return text

  const pattern = /Calling\s+[^{}\r\n]{1,180}?\s+with input:\s*/g
  let cursor = 0
  let result = ''
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    const jsonStart = match.index + match[0].length
    const jsonEnd = findBalancedJsonObjectEnd(text, jsonStart)

    if (jsonEnd < 0) {
      pattern.lastIndex = match.index + 1
      continue
    }

    let parsed: unknown = null
    try {
      parsed = JSON.parse(text.slice(jsonStart, jsonEnd))
    } catch {
      pattern.lastIndex = match.index + 1
      continue
    }

    if (!looksLikeN8nToolInvocationTracePayload(parsed)) {
      pattern.lastIndex = match.index + 1
      continue
    }

    result += text.slice(cursor, match.index)
    cursor = jsonEnd
    pattern.lastIndex = jsonEnd
  }

  if (cursor === 0) return text
  result += text.slice(cursor)
  return result
}

type SendError = Error & {
  code?: string
  details?: string
  status?: number
}

export class MessageApiService {
  constructor(private webhookUrl: string) {}

  private getFrontendRuntimeUrls() {
    if (typeof window === 'undefined' || !window.location?.origin) {
      return {}
    }

    const frontendUrl = window.location.origin.replace(/\/+$/, '')
    const sseEndpoint = `${frontendUrl}/api/sse`
    const artifactCompleteUrl = `${frontendUrl}/api/artifacts/complete`

    return {
      batshit_frontend_url: frontendUrl,
      batshitFrontendUrl: frontendUrl,
      batshit_sse_endpoint: sseEndpoint,
      batshitSseEndpoint: sseEndpoint,
      batshit_artifact_complete_url: artifactCompleteUrl,
      batshitArtifactCompleteUrl: artifactCompleteUrl,
    }
  }

  private async resolveN8nRuntimeCallbackUrls(
    callbackUrls: Partial<SendMessagePayload>,
  ): Promise<Partial<SendMessagePayload>> {
    if (Object.keys(callbackUrls).length === 0) {
      return callbackUrls
    }

    const response = await fetch('/api/messages/n8n-runtime-callbacks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(callbackUrls),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      throw new Error(
        errorText ||
          `Failed to resolve n8n callback URLs for this runtime (${response.status}).`,
      )
    }

    const payload = await response.json()
    const resolved = payload?.callbackUrls
    if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
      throw new Error('Failed to resolve n8n callback URLs for this runtime.')
    }

    return resolved as Partial<SendMessagePayload>
  }

  /**
   * The native n8n lane's clip send-duration consumption — the exact state transition
   * send-routed's consumePostCompileSessionClips applies on managed lanes, through the
   * existing session-authed decrement_durations route action. A failure is loud in the
   * console but never fails the send: the model already received the clip, and an
   * unburned countdown for one turn is the safe direction (the same posture as the
   * memory commit below).
   */
  private async consumePostSendClipDurations(sessionId: string): Promise<void> {
    if (!sessionId) return
    try {
      const response = await fetch('/api/session-clips/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, action: 'decrement_durations' }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        console.error(
          '[MessageAPI] Failed to consume post-send clip durations:',
          payload?.error ?? `HTTP ${response.status}`,
        )
      }
    } catch (error) {
      console.error('[MessageAPI] Failed to consume post-send clip durations:', error)
    }
  }

  /**
   * SA-104 P5 (packet doc §1.9): the native n8n lane's accepted-send memory commit.
   * Runs the same `commitMemoryTurnState` the managed lanes run in send-routed, via
   * the session-authed turn-commit route, and stashes the result for the finalize
   * site's "memory inserted" stamp. A failed commit is loud in the console but never
   * fails the send — the model already has its context; the linger window simply
   * under-ticks one turn (the safe direction).
   */
  private async commitMemoryTurn(
    sessionId: string,
    agentId: string | null,
    currentUserMessage: string,
    assistantMessageId: string,
  ): Promise<void> {
    if (!agentId || !currentUserMessage?.trim()) return
    try {
      const response = await fetch('/api/memory/turn-commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, agentId, currentUserMessage }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        console.error(
          '[MessageAPI] Memory turn commit failed:',
          payload?.error ?? `HTTP ${response.status}`,
        )
        return
      }
      const insertedNew = Array.isArray(payload?.insertedNewIds) ? payload.insertedNewIds : []
      const refreshed = Array.isArray(payload?.refreshedIds) ? payload.refreshedIds : []
      const held = Array.isArray(payload?.heldIds) ? payload.heldIds : []
      const items = Array.isArray(payload?.items) ? payload.items : []
      if (
        payload?.committed === true &&
        insertedNew.length + refreshed.length + held.length > 0
      ) {
        pendingMemoryInsertedByMessageId.set(assistantMessageId, {
          version: 1,
          new: insertedNew.length,
          refreshed: refreshed.length,
          held: held.length,
          ids: [...insertedNew, ...refreshed, ...held],
          // Per-item rows (2026-08-28) power the chip's click-open detail popover.
          ...(items.length > 0 ? { items } : {}),
        })
      }
    } catch (error) {
      console.error('[MessageAPI] Memory turn commit request failed:', error)
    }
  }

  private async createN8nCallbackAuth(
    sessionId: string,
    messageId: string,
    agentId?: string,
    projectPath?: string | null,
  ): Promise<Partial<SendMessagePayload>> {
    const response = await fetch('/api/messages/n8n-callback-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, messageId, agentId, projectPath }),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      throw new Error(
        errorText ||
          `Failed to create scoped n8n callback token (${response.status}).`,
      )
    }

    const payload = await response.json()
    const callbackToken =
      typeof payload?.callbackToken === 'string'
        ? payload.callbackToken.trim()
        : ''
    const headerName =
      typeof payload?.headerName === 'string' && payload.headerName.trim()
        ? payload.headerName.trim()
        : 'x-batshit-callback-token'

    if (!callbackToken) {
      throw new Error('Failed to create scoped n8n callback token.')
    }

    return {
      batshit_native_tool_token: callbackToken,
      batshitNativeToolToken: callbackToken,
      batshit_native_tool_header: 'x-batshit-native-tool-token',
      batshitNativeToolHeader: 'x-batshit-native-tool-token',
      batshit_sse_callback_token: callbackToken,
      batshitSseCallbackToken: callbackToken,
      batshit_sse_callback_header: headerName,
      batshitSseCallbackHeader: headerName,
      ...(typeof payload?.expiresAt === 'string' && payload.expiresAt.trim()
        ? {
            batshit_sse_callback_expires_at: payload.expiresAt.trim(),
            batshitSseCallbackExpiresAt: payload.expiresAt.trim(),
          }
        : {}),
    }
  }

  private buildNativeToolBridgeMetadata() {
    return {
      basePath: '/api/native-tools',
      nodeName: 'Batshit Tools',
      dispatch: '/api/native-tools/dispatch',
      sandboxStatus: '/api/native-tools/sandbox/status',
      auth: {
        tokenHeader: 'x-batshit-native-tool-token',
        tokenSource: 'batshit_native_tool_token',
        userHeader: 'x-batshit-user-id',
      },
      actions: [
        'bash_execute',
        'native_skill',
        'batshit_tool_search',
        'batshit_tool_use',
        'runtime_addon_list',
        'runtime_addon_status',
        'runtime_addon_prepare',
        'runtime_addon_start',
        'runtime_addon_stop',
        'web_search',
      ],
      notes: [
        'Use a single HTTP Request Tool node named "Batshit Tools".',
        'Authenticate with the scoped per-message callback token from the webhook payload, not a long-lived Batshit service token credential.',
        'Always send action + input + context. Context must include primary_agent_type + actor_type + session_id + agent_id.',
        'Fetch Zip is available through batshit_tool_use with ref "fabric:sys.zip.fetch" for n8n Primary Agent calls and is always blocked for subagents.',
        'For subagent calls, context.parent_agent_id is required so backend/policy inheritance can be enforced.',
      ],
      contracts: {
        dispatch: {
          body: {
            userId: '{{batshitInput.user_id}}',
            action: 'bash_execute',
            input: {
              command: 'pwd',
              cwd: 'optional_relative_or_absolute_path_inside_workspace',
              timeoutMs: 30000,
              maxOutputChars: 120000,
            },
            context: {
              session_id: '{{batshitInput.session_id}}',
              message_id: '{{batshitInput.message_id}}',
              agent_id: '{{batshitInput.agent_id}}',
              primary_agent_type: 'n8n',
              actor_type: 'primary',
            },
          },
        },
        actionExamples: {
          native_skill_invoke: {
            action: 'native_skill',
            input: {
              skillId: 'agent_browser',
              action: 'invoke',
            },
          },
          batshit_tool_search_mcp: {
            action: 'batshit_tool_search',
            input: {
              family: 'mcp',
              query: 'postgres',
              limit: 5,
              schemaMode: 'compact',
            },
          },
          batshit_tool_use_mcp: {
            action: 'batshit_tool_use',
            input: {
              ref: 'mcp:mcp__postgres__query',
              input: {
                sql: 'SELECT 1',
              },
            },
          },
          batshit_tool_search_cli: {
            action: 'batshit_tool_search',
            input: {
              family: 'cli',
              query: 'screenshot',
              limit: 5,
            },
          },
          batshit_tool_use_cli: {
            action: 'batshit_tool_use',
            input: {
              ref: 'cli:local_screenshot',
              input: {
                outputPath: '/tmp/example.png',
              },
            },
          },
          batshit_tool_search_artifact: {
            action: 'batshit_tool_search',
            input: {
              family: 'artifact',
              query: 'image generator',
              schemaMode: 'compact',
              limit: 5,
            },
          },
          batshit_tool_use_artifact: {
            action: 'batshit_tool_use',
            input: {
              ref: 'artifact:use.artifact.demo_tool',
              input: {
                prompt: 'Generate a hero image',
              },
            },
          },
          batshit_tool_search_agent_browser: {
            action: 'batshit_tool_search',
            input: {
              family: 'agent_browser',
              query: 'open',
              limit: 5,
            },
          },
          batshit_tool_use_fetch_zip: {
            action: 'batshit_tool_use',
            input: {
              ref: 'fabric:sys.zip.fetch',
              input: {
                zipId: 'zip_id_here',
                includeContent: true,
                maxChars: 16000,
              },
            },
          },
          runtime_addon_prepare: {
            action: 'runtime_addon_prepare',
            input: {
              addonId: 'fbx2vrma',
            },
          },
          runtime_addon_start: {
            action: 'runtime_addon_start',
            input: {
              addonId: 'fbx2vrma',
            },
          },
          web_search: {
            action: 'web_search',
            input: {
              query: 'Batshit release notes',
              maxResults: 5,
            },
          },
          subagent_context: {
            context: {
              session_id: '{{batshitInput.session_id}}',
              message_id: '{{batshitInput.message_id}}',
              agent_id: 'subagent_slug_or_id',
              primary_agent_type: 'n8n',
              actor_type: 'subagent',
              parent_agent_id: '{{batshitInput.agent_id}}',
            },
          },
        },
      },
    }
  }

  private createN8nUnavailableError(reason?: string, status?: number): SendError {
    const error = new Error('n8n is not running or connected.') as SendError
    error.code = 'N8N_UNAVAILABLE'
    error.status = status
    error.details =
      reason?.trim() ||
      'Start n8n, make sure the n8n Primary Agent workflow is active, then try again.'
    return error
  }

  private normalizeN8nWebhookNetworkError(error: unknown): Error {
    if ((error as any)?.name === 'AbortError') return error as Error

    const message =
      error instanceof Error ? error.message : String(error ?? '')
    const causeMessage =
      (error as any)?.cause instanceof Error
        ? (error as any).cause.message
        : typeof (error as any)?.cause?.message === 'string'
          ? (error as any).cause.message
          : ''
    const combined = `${message} ${causeMessage}`.trim()

    if (
      /\b(?:fetch failed|failed to fetch|network error|load failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT)\b/i.test(
        combined,
      )
    ) {
      return this.createN8nUnavailableError(
        'Batshit could not reach the n8n webhook. Start n8n, make sure the workflow is active, then send again.',
      )
    }

    return error instanceof Error ? error : new Error(combined || 'n8n webhook failed.')
  }

  private buildN8nWebhookHttpError(status: number, responseText: string): SendError {
    if (status === 404) {
      return this.createN8nUnavailableError(
        'Batshit reached n8n, but the webhook was not found. Make sure the n8n Primary Agent workflow is active and connected.',
        status,
      )
    }

    let parsed: unknown = null
    if (responseText.trim()) {
      try {
        parsed = JSON.parse(responseText)
      } catch {
        parsed = null
      }
    }

    const workflowError = extractN8nWebhookError(parsed)
    const message =
      workflowError ||
      (responseText.trim()
        ? `n8n workflow failed with HTTP ${status}: ${responseText.trim().slice(0, 500)}`
        : `n8n workflow failed with HTTP ${status}.`)
    const error = new Error(message) as SendError
    error.status = status
    if (responseText.trim()) {
      error.details = responseText.trim().slice(0, 2_000)
    }
    return error
  }

  /**
   * Send a message to the n8n webhook
   */
  async sendMessage(
    content: string,
    sessionId: string,
    userId: string,
    messages: Message[],
    agentId?: string,
    maxTokens: number = 100000,
    agent?: any,
    metadataOverrides: Record<string, any> = {},
    signal?: AbortSignal,
  ): Promise<{ status: string; message_id?: string }> {
    // Use the new Redis-based formatting
    // Exclude the current message (last one) to avoid duplication
    const previousMessages = messages.slice(0, -1)

    // Fetch assigned subagents BEFORE building chat input
    let assignedSubagents: any[] = []
    // Convert Svelte 5 proxy to regular array if needed
    const assignedIds: string[] = agent?.assigned_subagent_ids
      ? Array.from(agent.assigned_subagent_ids)
      : []
    const subagentMetaMap: Record<string, any> = {}

    if (assignedIds.length > 0) {
      try {
        // Fetch all subagents once
        const response = await fetch(`/api/subagents`)
        if (response.ok) {
          const { subagents: allSubagents } = await response.json()

          // Filter to only assigned subagents
          assignedSubagents = assignedIds
            .map((id) => allSubagents.find((sw: any) => sw.id === id))
            .filter((sw) => sw !== null)
            .map((sw) => ({
              id: sw.id,
              slug: sw.slug ?? sw.id,
              name: sw.name,
              displayName: sw.displayName || sw.display_name || sw.name, // Use displayName for UI
              avatar: sw.avatar || sw.avatar_url || null,
              avatar_icon_ref: sw.avatar_icon_ref || null,
              avatar_icon_fit: sw.avatar_icon_fit || null,
              primary_model_provider:
                sw.primary_model_provider || sw.provider || null,
              primary_model_name: sw.primary_model_name || sw.model || null,
              // Determine type based on toggles (matching logic in buildFormattedChatInput)
              type: sw.include_claude_cli
                ? 'claude_cli'
                : sw.include_batshit_subagent
                  ? 'standard_agent'
                  : 'standard_agent',
              description: sw.description,
              // Include toggle fields directly on the subagent object
              include_claude_cli: sw.include_claude_cli || false,
              include_batshit_subagent: sw.include_batshit_subagent || false,
              include_global_prompt: sw.include_global_prompt !== false, // default false for subagents
              system_prompt: sw.system_prompt, // Include at top level for easier access
              settings: {
                system_prompt: sw.system_prompt,
                primary_model_provider: sw.primary_model_provider,
                primary_model_name: sw.primary_model_name,
                primary_model_temperature: sw.primary_model_temperature,
                primary_model_max_tokens: sw.primary_model_max_tokens,
                primary_model_top_p: sw.primary_model_top_p,
                include_global_prompt: sw.include_global_prompt !== false, // default false for subagents
              },
            }))

          // Build metadata map for n8n streaming tool events.
          for (const sw of assignedSubagents) {
            const key = resolveSubagentSlug(sw)
            subagentMetaMap[key] = {
              isSubagent: true,
              toolProvider: 'subagent',
              subagentName: sw.displayName || sw.name || key,
              subagentId: sw.id || key,
              avatarUrl: sw.avatar || null,
              subagentAvatarIconRef: sw.avatar_icon_ref || null,
              subagentAvatarIconFit: sw.avatar_icon_fit || null,
              provider: sw.primary_model_provider ?? null,
              model: sw.primary_model_name ?? null,
            }
            const hyphenKey = key.replace(/_/g, '-')
            subagentMetaMap[hyphenKey] = subagentMetaMap[key]
          }
        }
      } catch (error) {
        console.error('[MessageAPI] Failed to fetch assigned subagents:', error)
      }
    }

    // Build the formatted chat input with assigned subagents
    // Use dynamic import to avoid circular dependency
    const { databaseService } = await import('./databaseRedis')
    let userSettings: any = null
    try {
      if (userId) {
        userSettings = await databaseService.getUserSettings(userId)
      }
    } catch (error) {
      console.warn('[MessageAPI] Failed to load user settings:', error)
    }
    let voiceState:
      | {
          tts?: boolean
          stt?: boolean
          voiceMode?: string
          provider?: string
          guidance?: string[]
        }
      | undefined
    try {
      const response = await fetch('/api/voice/runtime-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: agentId ?? agent?.id ?? null,
          metadata: metadataOverrides ?? {},
        }),
      })
      if (response.ok) {
        const payload = await response.json()
        if (payload?.voiceState && typeof payload.voiceState === 'object') {
          voiceState = payload.voiceState
        }
      }
    } catch (error) {
      console.warn('[MessageAPI] Failed to load voice runtime context:', error)
    }
    const goonsEnabled =
      typeof metadataOverrides?.goonsEnabled === 'boolean'
        ? metadataOverrides.goonsEnabled
        : undefined
    const goonPresentationMode = metadataOverrides?.goonPresentationMode
    const formatted = await databaseService.buildFormattedChatInput(
      sessionId,
      previousMessages,
      agent,
      content, // Current user message (dynamic info injected during compilation)
      assignedSubagents, // Pass subagents to include in system prompt
      userId, // Pass userId for clip fetching
      {
        runtimeFlavor: 'n8n',
        projectPath: metadataOverrides?.projectPath ?? null,
        projectRules: metadataOverrides?.projectRules ?? null,
        fileReferences: metadataOverrides?.fileReferences ?? [],
        voiceState,
        goonsEnabled,
        goonPresentationMode,
        goonsSettings: userSettings?.goons_settings ?? null,
      },
    )

    // SA-005: Tool Vault removed (October 2025)
    // n8n agents should use MCP Client nodes directly for tool access

    const baseMetadata = formatted.structuredInput?.metadata || {}
    const mergedMetadata: Record<string, any> = {
      ...baseMetadata,
      ...(metadataOverrides || {}),
    }

    const chatSelectedGateways = Array.isArray(
      metadataOverrides?.selectedGateways,
    )
      ? metadataOverrides.selectedGateways
      : Array.isArray(metadataOverrides?.selectedMCPs)
        ? metadataOverrides.selectedMCPs
        : undefined

    if (chatSelectedGateways !== undefined) {
      mergedMetadata.selectedGateways = chatSelectedGateways
      mergedMetadata.selectedMCPs = chatSelectedGateways
    }

    if (metadataOverrides?.mcpToolSelections) {
      mergedMetadata.mcpToolSelections = metadataOverrides.mcpToolSelections
    }

    const selectionResolution = await this.resolveGatewaySelections({
      agentId,
      selectedGateways: mergedMetadata.selectedGateways,
      mcpToolSelections: mergedMetadata.mcpToolSelections,
    })

    if (selectionResolution) {
      if (
        selectionResolution.resolvedGateways !== undefined &&
        selectionResolution.resolvedGateways !== null
      ) {
        mergedMetadata.selectedGateways = selectionResolution.resolvedGateways
        mergedMetadata.selectedMCPs = selectionResolution.resolvedGateways
      }
      if (selectionResolution.resolvedToolSelections) {
        mergedMetadata.mcpToolSelections =
          selectionResolution.resolvedToolSelections
      }
      mergedMetadata.defaultMCPGateways = selectionResolution.defaultGateways
      mergedMetadata.gatewayToolMap = selectionResolution.gatewayToolMap
      mergedMetadata.agent = {
        ...(mergedMetadata.agent || {}),
        defaultMCPGateways: selectionResolution.defaultGateways,
      }
    }

    const selectedCliToolIdsSource = Array.isArray(mergedMetadata?.agent?.defaultTools)
      ? mergedMetadata.agent.defaultTools
      : Array.isArray(mergedMetadata?.agent?.default_tools)
        ? mergedMetadata.agent.default_tools
        : Array.isArray(agent?.defaultTools)
          ? agent.defaultTools
          : Array.isArray(agent?.default_tools)
            ? agent.default_tools
            : null
    const selectedCliToolIds =
      selectedCliToolIdsSource?.filter(
        (entry: unknown): entry is string =>
          typeof entry === 'string' && entry.trim().length > 0,
      ) ?? null

    if (selectedCliToolIds && selectedCliToolIds.length > 0) {
      mergedMetadata.selectedCliToolIds = selectedCliToolIds
      mergedMetadata.agent = {
        ...(mergedMetadata.agent || {}),
        defaultTools: selectedCliToolIds,
      }
    }

    mergedMetadata.nativeToolBridge =
      mergedMetadata.nativeToolBridge || this.buildNativeToolBridgeMetadata()

    formatted.structuredInput = {
      ...formatted.structuredInput,
      metadata: mergedMetadata,
    }

    const structuredInputFull = formatted.structuredInput

    const gatewayToolMap = mergedMetadata.gatewayToolMap ?? null

    const subagentModelMap =
      mergedMetadata?.subagentModels &&
      typeof mergedMetadata.subagentModels === 'object'
        ? mergedMetadata.subagentModels
        : {}

    const subagentProviders: Record<string, string | null> = {}
    const subagentModels: Record<string, string | null> = {}

    for (const [subagentKey, modelConfig] of Object.entries(subagentModelMap)) {
      const provider =
        modelConfig &&
        typeof modelConfig === 'object' &&
        'provider' in modelConfig
          ? (modelConfig as any).provider
          : null
      const model =
        modelConfig && typeof modelConfig === 'object' && 'model' in modelConfig
          ? (modelConfig as any).model
          : null

      subagentProviders[subagentKey] = provider ?? null
      subagentModels[subagentKey] = model ?? null
    }

    const structuredInputSnapshot = this.trimStructuredInputForSnapshot(
      structuredInputFull,
      mergedMetadata,
      agent,
      sessionId,
    )

    const resolvedPrimary = agent
      ? resolveModelIds({
          developerId: agent.primary_model_provider,
          modelId: agent.primary_model_name,
          connection: agent.primary_model_connection ?? null,
        })
      : null

    const primarySettings: Record<string, ParameterValue> = {
      ...(agent?.provider_specific_settings ?? {}),
    }
    if (
      agent?.primary_model_temperature !== undefined &&
      agent?.primary_model_temperature !== null
    ) {
      primarySettings.temperature = agent.primary_model_temperature
    }
    if (
      agent?.primary_model_max_tokens !== undefined &&
      agent?.primary_model_max_tokens !== null
    ) {
      primarySettings.maxTokens = agent.primary_model_max_tokens
    }
    if (
      agent?.primary_model_top_p !== undefined &&
      agent?.primary_model_top_p !== null
    ) {
      primarySettings.topP = agent.primary_model_top_p
    }
    if (
      agent?.primary_model_top_k !== undefined &&
      agent?.primary_model_top_k !== null
    ) {
      primarySettings.topK = agent.primary_model_top_k
    }
    if (
      agent?.primary_model_presence_penalty !== undefined &&
      agent?.primary_model_presence_penalty !== null
    ) {
      primarySettings.presencePenalty = agent.primary_model_presence_penalty
    }
    if (
      agent?.primary_model_frequency_penalty !== undefined &&
      agent?.primary_model_frequency_penalty !== null
    ) {
      primarySettings.frequencyPenalty = agent.primary_model_frequency_penalty
    }
    if (
      agent?.primary_model_seed !== undefined &&
      agent?.primary_model_seed !== null
    ) {
      primarySettings.seed = agent.primary_model_seed
    }
    if (Array.isArray(agent?.primary_model_stop_sequences)) {
      primarySettings.stopSequences = agent.primary_model_stop_sequences
    }
    if (
      agent?.primary_model_reasoning_effort !== undefined &&
      agent?.primary_model_reasoning_effort !== null
    ) {
      primarySettings.reasoningEffort = agent.primary_model_reasoning_effort
    }

    const matrixEntries = getMatrixEntries()
    const n8nParameters =
      agent && Object.keys(primarySettings).length
        ? filterSettingsForN8N({
            provider:
              resolvedPrimary?.providerId ??
              agent.primary_model_provider ??
              null,
            modelId:
              resolvedPrimary?.modelId ?? agent.primary_model_name ?? null,
            vercelId:
              resolvedPrimary?.effectiveModelId ??
              agent.primary_model_name ??
              null,
            capabilities: agent.primary_model_capabilities ?? null,
            settings: primarySettings,
            connection: 'n8n',
            matrixEntries,
          })
        : null
    const ignoredParameterKeys =
      agent && Object.keys(primarySettings).length
        ? listUnsupportedParameterKeys({
            provider:
              resolvedPrimary?.providerId ??
              agent.primary_model_provider ??
              null,
            modelId:
              resolvedPrimary?.modelId ?? agent.primary_model_name ?? null,
            vercelId:
              resolvedPrimary?.effectiveModelId ??
              agent.primary_model_name ??
              null,
            capabilities: agent.primary_model_capabilities ?? null,
            settings: primarySettings,
            connection: 'n8n',
            matrixEntries,
          })
        : []

    const n8nRuntimeCallbackUrls = await this.resolveN8nRuntimeCallbackUrls(
      this.getFrontendRuntimeUrls(),
    )
    const chatInput = formatted.structuredInput?.messages?.[0]?.content || content
    const nativeChatInputSummary = summarizeN8nNativeChatInput(chatInput, content)
    const resolvedProjectPath =
      formatted.resolvedProjectPath ??
      formatted.structuredInput?.metadata?.resolvedProjectPath ??
      mergedMetadata?.resolvedProjectPath ??
      metadataOverrides?.projectPath ??
      null

    const payload: SendMessagePayload = {
      user_message: content,
      session_id: sessionId,
      user_id: userId,
      agent_id: agentId,
      primary_agent_type: 'n8n',
      primaryAgentType: 'n8n',
      originalCreatedAt: new Date().toISOString(),
      ...(resolvedProjectPath
        ? {
            project_path: resolvedProjectPath,
            projectPath: resolvedProjectPath,
            resolved_project_path: resolvedProjectPath,
            resolvedProjectPath,
          }
        : {}),
      ...n8nRuntimeCallbackUrls,
      // System prompts - delivered separately for n8n expression fields
      primarySystemPrompt: formatted.primarySystemPrompt,
      subagentPrompts: formatted.subagentPrompts,
      // Only send settings currently used by n8n expressions
      ...(agent
        ? (() => {
            if (!resolvedPrimary) {
              return {
                primary_model_name: agent.primary_model_name,
                primary_model_provider: agent.primary_model_provider,
              }
            }

            return {
              // SA-017: n8n routing expects transport IDs (openrouter/vercel-gateway) + effective IDs.
              primary_model_provider: resolvedPrimary.providerId,
              primary_model_name: resolvedPrimary.effectiveModelId,
              // Extra clarity for n8n expressions (optional but preferred).
              primary_model_provider_id: resolvedPrimary.providerId,
              primary_model_developer_id: resolvedPrimary.developerId,
              primary_model_model_id: resolvedPrimary.modelId,
              primary_model_effective_id: resolvedPrimary.effectiveModelId,
            }
          })()
        : {}),

      nativeToolBridge:
        mergedMetadata?.nativeToolBridge ||
        this.buildNativeToolBridgeMetadata(),
      ...(selectedCliToolIds && selectedCliToolIds.length > 0
        ? {
            selected_cli_tool_ids: selectedCliToolIds,
            selectedCliToolIds: selectedCliToolIds,
          }
        : {}),
      subagentProviders,
      subagentModels,
      primary_model_parameters: n8nParameters ?? {},
      primary_model_parameters_ignored: ignoredParameterKeys,

      // === CONVENIENCE FIELDS FOR N8N ===
      // These make expressions cleaner and more consistent across all nodes

      // Direct access to current user message (works for all 3 AI nodes)
      chatInput,
      chatInputText: nativeChatInputSummary.chatInputText,
      batshit_image_inputs: nativeChatInputSummary.imageUrls,
      batshitImageInputs: nativeChatInputSummary.imageUrls,
      batshit_image_urls: nativeChatInputSummary.imageUrls,
      batshitImageUrls: nativeChatInputSummary.imageUrls,

      // CamelCase version of session_id (n8n typically uses camelCase)
      sessionId: sessionId,
    }

    // Generate standardized messageId via API (Story 6.9b)
    let messageId: string
    try {
      const idResponse = await fetch('/api/messages/generate-id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      const idData = await idResponse.json()
      messageId = idData.id
    } catch (error) {
      logger.error(
        '[MessageAPI] Failed to generate message ID, using fallback:',
        error,
      )
      // Fallback to timestamp-based ID (should never happen)
      messageId = `msg_fallback_${Date.now()}`
    }

    payload.message_id = messageId
    payload.messageId = messageId
    Object.assign(
      payload,
      await this.createN8nCallbackAuth(
        sessionId,
        messageId,
        agentId,
        resolvedProjectPath,
      ),
    )

    const payloadString = JSON.stringify(payload)
    const snapshotPayload = redactN8nCallbackAuthFromPayload(payload)

    // Record execution snapshot so the Execution Viewer mirrors the webhook payload
    try {
      const compileMetadata = structuredInputFull?.metadata || null
      const agentDisplayName =
        agent?.displayName ??
        agent?.display_name ??
        agent?.name ??
        payload.agent_display_name ??
        'n8n Agent'

      const resolvedAgentId = agent?.id ?? agentId ?? null
      const selectedGateways =
        (compileMetadata && Array.isArray(compileMetadata.selectedGateways)
          ? compileMetadata.selectedGateways
          : Array.isArray(compileMetadata?.selectedMCPs)
            ? compileMetadata.selectedMCPs
            : null) || null
      const selectedTools =
        (compileMetadata && Array.isArray(compileMetadata.selectedTools)
          ? compileMetadata.selectedTools
          : null) || null
      const mcpToolSelections =
        compileMetadata && compileMetadata.mcpToolSelections
          ? compileMetadata.mcpToolSelections
          : null
      const selectedCliToolIdsForSnapshot =
        (compileMetadata &&
        Array.isArray((compileMetadata as any).selectedCliToolIds)
          ? (compileMetadata as any).selectedCliToolIds
          : Array.isArray((compileMetadata as any)?.agent?.defaultTools)
            ? (compileMetadata as any).agent.defaultTools
            : Array.isArray((agent as any)?.defaultTools)
              ? (agent as any).defaultTools
              : null) || null

      const defaultGateways =
        (compileMetadata &&
          Array.isArray(compileMetadata.agent?.defaultMCPGateways) &&
          compileMetadata.agent.defaultMCPGateways) ||
        (compileMetadata &&
          Array.isArray(compileMetadata.agent?.default_mcp_gateways) &&
          compileMetadata.agent.default_mcp_gateways) ||
        (Array.isArray((agent as any)?.defaultMCPGateways)
          ? (agent as any).defaultMCPGateways
          : Array.isArray((agent as any)?.default_mcp_gateways)
            ? (agent as any).default_mcp_gateways
            : null)

      const executionMetadata =
        compileMetadata && typeof compileMetadata === 'object'
          ? {
              ...compileMetadata,
              webhookUrl: this.webhookUrl,
              agentSettings: {
                primary_model_provider: payload.primary_model_provider,
                primary_model_name: payload.primary_model_name,
              },
            }
          : {
              webhookUrl: this.webhookUrl,
              agentSettings: {
                primary_model_provider: payload.primary_model_provider,
                primary_model_name: payload.primary_model_name,
              },
            }

      const executionMode = this.webhookUrl.includes('/webhook-test/')
        ? 'test'
        : 'production'
      const runtimeSnapshot = {
        runtimeId: 'n8n' as const,
        providerId:
          typeof payload.primary_model_provider === 'string'
            ? payload.primary_model_provider
            : null,
        connectionId:
          typeof (agent as any)?.primary_model_connection?.id === 'string'
            ? (agent as any).primary_model_connection.id
            : null,
        modelName:
          typeof payload.primary_model_name === 'string'
            ? payload.primary_model_name
            : null,
        transport: 'n8n-webhook' as const,
        status: 'pending' as const,
        metadata: {
          webhookUrl: this.webhookUrl,
          executionMode,
        },
      }

      const snapshotResponse = await fetch(
        `/api/sessions/${sessionId}/execution-log`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: messageId,
            sessionId,
            userId,
            agentId: resolvedAgentId,
            agentName: agentDisplayName,
            agentType: (agent as any)?.agentType || 'n8n',
            createdAt: new Date().toISOString(),
            userMessage: content,
            structuredInput: structuredInputSnapshot,
            webhookStyleInput: [
              {
                headers: { 'content-type': 'application/json' },
                params: {},
                query: {},
                body: snapshotPayload,
                webhookUrl: this.webhookUrl,
                executionMode,
              },
            ],
            webhookInputAvailability: {
              state: 'unavailable',
              source: 'batshit-webhook-wrapper',
              note: 'Exact webhook input is not loaded yet. Use Refresh to replace this stored wrapper with the exact n8n Webhook node output when the matching execution is available.',
            },
            primarySystemPrompt: formatted.primarySystemPrompt,
            subagentPrompts: formatted.subagentPrompts,
            subagentDescription: formatted.subagentDescription,
            compiledMessages: Array.isArray(structuredInputSnapshot?.messages)
              ? structuredInputSnapshot.messages
              : [],
            compileMetadata,
            executionMetadata,
            selectedGateways,
            selectedTools,
            mcpToolSelections,
            selectedCliToolIds: selectedCliToolIdsForSnapshot,
            defaultGateways,
            gatewayToolMap,
            voiceMetadata: undefined,
            assignedSubagents: payload.assignedSubagents ?? undefined,
            runtime: runtimeSnapshot,
          }),
        },
      )
      if (!snapshotResponse.ok) {
        const errorText = await snapshotResponse.text().catch(() => '')
        throw new Error(
          errorText ||
            `Snapshot request failed with status ${snapshotResponse.status}`,
        )
      }
    } catch (snapshotError) {
      logger.warn(
        '[MessageAPI] Failed to record execution snapshot:',
        snapshotError,
      )
    }

    // Send SSE start event before the webhook call so the UI animates immediately.
    // Native n8n streams are consumed from the webhook response and forwarded to SSE below.
    try {
      await fetch('/api/sse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'start',
          sessionId,
          messageId,
          content: '',
        }),
      })
    } catch (sseError) {
      logger.warn('[MessageAPI] Failed to send SSE start event:', sseError)
      // Continue anyway - this is just for the animation
    }

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: payloadString,
        signal,
      })

      if (!response.ok) {
        const responseText = await response.text().catch(() => '')
        throw this.buildN8nWebhookHttpError(response.status, responseText)
      }

      // Clip send-duration consumption for the native n8n lane. Native n8n sends never
      // pass through send-routed, so its consumePostCompileSessionClips sites cannot run
      // here — commit aa2117b81 moved consumption server-side and orphaned this lane
      // (clip-lifecycle.md "Native n8n send-duration consumption"). Same accepted-send
      // boundary as send-routed: the compile already happened and the webhook accepted
      // the send, while n8n run-lock rejection and webhook errors bail out above and
      // never burn a countdown. Ordering matches send-routed: clips first, then memory.
      await this.consumePostSendClipDurations(sessionId)

      // SA-104 P5: accepted-send memory commit for the native n8n lane (the webhook
      // POST was accepted; send-routed never sees native n8n sends — packet doc
      // §1.9). Awaited BEFORE the response body is consumed, so the commit result
      // is always stashed before the end-event finalize can read it. Memory-disabled
      // agents skip the round-trip entirely.
      if (resolveAgentMemoryEnabled(agent)) {
        await this.commitMemoryTurn(sessionId, agentId ?? agent?.id ?? null, content, messageId)
      }

      // Check if response is JSON based on Content-Type header
      // This allows both JSON responses (with "Respond to Webhook" node)
      // and streaming responses (without it) to work
      let data: any = {}
      const contentType = response.headers.get('content-type')

      // Try to get the response text to see what we're dealing with
      const responseText = await response.text()

      if (responseText && looksLikeNativeAgentStreamResponse(responseText)) {
        // Process the NDJSON stream (start event already sent above)
        await this.processNativeAgentStream(
          responseText,
          sessionId,
          messageId,
          subagentMetaMap,
          userSettings?.admin_settings?.n8n_execution_search_limit,
        )
      } else if (
        responseText &&
        contentType &&
        contentType.includes('application/json')
      ) {
          // Traditional JSON response from "Respond to Webhook" node
          try {
            data = JSON.parse(responseText)
            const webhookError = extractN8nWebhookError(data)
            if (webhookError) {
              throw new Error(webhookError)
            }
          } catch (jsonError) {
            if (jsonError instanceof Error && jsonError.message.startsWith('n8n workflow')) {
              throw jsonError
            }
            // Continue anyway - the actual response comes via SSE
          }
      } else if (responseText) {
        // Non-JSON response but has content
      } else {
        // Empty response - that's OK for streaming!
      }

      // Trigger zip activity check after successful message send! 🚀
      // This ensures visual indicators update immediately when buffer thresholds are reached
      window.dispatchEvent(
        new CustomEvent('checkZipActivity', {
          detail: {
            sessionId,
            trigger: 'message_sent',
            timestamp: Date.now(),
          },
        }),
      )

      return {
        status: 'success',
        message_id: data.message_id || messageId,
      }
    } catch (error) {
      console.error('[MessageAPI] Send message error:', error)
      throw this.normalizeN8nWebhookNetworkError(error)
    }
  }

  private async resolveGatewaySelections(params: {
    agentId?: string
    selectedGateways?: string[] | null | undefined
    mcpToolSelections?: MCPToolSelections | null | undefined
  }): Promise<GatewaySelectionResolution | null> {
    if (!params.agentId) {
      return null
    }

    try {
      const response = await fetch('/api/mcp/selections/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: params.agentId,
          selectedGateways: params.selectedGateways ?? null,
          mcpToolSelections: params.mcpToolSelections ?? null,
        }),
      })

      if (!response.ok) {
        const message = await response
          .text()
          .catch(() => 'Failed to resolve MCP selections')
        throw new Error(message || 'Failed to resolve MCP selections')
      }

      return (await response.json()) as GatewaySelectionResolution
    } catch (error) {
      logger.warn('[MessageAPI] Failed to resolve MCP selections:', error)
      return null
    }
  }

  /**
   * SA-013: Trim the structured input down to the minimal fields n8n workflows use.
   * This keeps Execution Viewer snapshots lean without forking the canonical compilation output.
   */
  private trimStructuredInputForSnapshot(
    structuredInput: any,
    mergedMetadata: Record<string, any>,
    agent: any,
    sessionId: string,
  ) {
    const agentHints = mergedMetadata?.agent || agent || {}

    const minimalAgent = {
      id: agentHints.id || agent?.id || null,
      primary_model_provider:
        agentHints.primary_model_provider ||
        agent?.primary_model_provider ||
        null,
      primary_model_name:
        agentHints.primary_model_name || agent?.primary_model_name || null,
      defaultTools: Array.isArray(agentHints.defaultTools)
        ? agentHints.defaultTools
        : Array.isArray(agentHints.default_tools)
          ? agentHints.default_tools
          : Array.isArray(agent?.defaultTools)
            ? agent.defaultTools
            : undefined,
      primary_model_connection:
        agentHints.primary_model_connection ||
        agent?.primary_model_connection ||
        undefined,
    }

    return {
      type: structuredInput?.type || 'batshit_chat_input',
      messages: Array.isArray(structuredInput?.messages)
        ? structuredInput.messages
        : [],
      // clippedItems are already expanded inline for AI; n8n does not use this list.
      metadata: {
        sessionId,
        agent: minimalAgent,
        selectedCliToolIds: Array.isArray(
          (mergedMetadata as any)?.selectedCliToolIds,
        )
          ? (mergedMetadata as any).selectedCliToolIds
          : Array.isArray(agentHints?.defaultTools)
            ? agentHints.defaultTools
            : undefined,
        subagentModels: mergedMetadata?.subagentModels || {},
        nativeToolBridge:
          mergedMetadata?.nativeToolBridge ||
          this.buildNativeToolBridgeMetadata(),
      },
    }
  }

  private buildExecutionViewerTokenStat(
    value: unknown,
    confidence: 'exact' | 'near' | 'estimated' | 'speculative',
    source?: string,
  ) {
    return {
      value:
        typeof value === 'number' && Number.isFinite(value) ? value : null,
      confidence,
      ...(source ? { source } : {}),
    }
  }

  private async patchN8nExecutionSnapshotFromEnd(params: {
    sessionId: string
    messageId: string
    endEvent: Record<string, any> | null | undefined
    n8nExecutionSearchLimit?: number
  }): Promise<{
    intermediateSteps: any[] | null
    zipReferences: any[]
  } | null> {
    const { sessionId, messageId, endEvent, n8nExecutionSearchLimit } = params

    if (!sessionId || !messageId || !endEvent || typeof endEvent !== 'object') {
      return null
    }

    const usageFromEnd =
      (endEvent.usage && typeof endEvent.usage === 'object'
        ? endEvent.usage
        : null) ||
      (endEvent.metadata?.usage && typeof endEvent.metadata.usage === 'object'
        ? endEvent.metadata.usage
        : null)

    const inputTokens =
      typeof usageFromEnd?.inputTokens === 'number'
        ? usageFromEnd.inputTokens
        : typeof usageFromEnd?.promptTokens === 'number'
          ? usageFromEnd.promptTokens
          : typeof usageFromEnd?.prompt_tokens === 'number'
            ? usageFromEnd.prompt_tokens
            : null

    const outputTokens =
      typeof usageFromEnd?.outputTokens === 'number'
        ? usageFromEnd.outputTokens
        : typeof usageFromEnd?.completionTokens === 'number'
          ? usageFromEnd.completionTokens
          : typeof usageFromEnd?.completion_tokens === 'number'
            ? usageFromEnd.completion_tokens
            : null

    const totalTokensRaw =
      typeof usageFromEnd?.totalTokens === 'number'
        ? usageFromEnd.totalTokens
        : typeof usageFromEnd?.total_tokens === 'number'
          ? usageFromEnd.total_tokens
          : null

    const totalTokens =
      typeof totalTokensRaw === 'number'
        ? totalTokensRaw
        : typeof inputTokens === 'number' && typeof outputTokens === 'number'
          ? inputTokens + outputTokens
          : null

    const intermediateSteps = Array.isArray(endEvent.intermediateSteps)
      ? endEvent.intermediateSteps
      : null
    const toolCallsCount = intermediateSteps ? intermediateSteps.length : null
    const hasToolCallsCount = typeof toolCallsCount === 'number'
    const toolCallsConfidence = hasToolCallsCount
      ? toolCallsCount > 0
        ? 'near'
        : 'exact'
      : 'speculative'
    const estimatedCallsCount =
      hasToolCallsCount
        ? toolCallsCount > 0
          ? toolCallsCount + 1
          : 1
        : null
    const callsConfidence =
      hasToolCallsCount
        ? toolCallsCount > 0
          ? 'estimated'
          : 'near'
        : 'speculative'
    const finalContent =
      typeof endEvent.content === 'string' ? endEvent.content : ''

    const usageObj = {
      inputTokens: this.buildExecutionViewerTokenStat(
        inputTokens,
        typeof inputTokens === 'number' ? 'exact' : 'speculative',
        'n8n',
      ),
      outputTokens: this.buildExecutionViewerTokenStat(
        outputTokens,
        typeof outputTokens === 'number' ? 'exact' : 'speculative',
        'n8n',
      ),
      totalTokens: this.buildExecutionViewerTokenStat(
        totalTokens,
        typeof totalTokensRaw === 'number'
          ? 'exact'
          : typeof inputTokens === 'number' && typeof outputTokens === 'number'
            ? 'near'
            : 'speculative',
        'n8n',
      ),
    }

    const responseNotes: string[] = [
      'n8n runs execute inside n8n; Batshit cannot capture per-step provider payloads byte-for-byte.',
    ]

    if (!intermediateSteps) {
      responseNotes.unshift(
        'Tool-call details are unavailable for this run (no intermediateSteps were provided by n8n).',
      )
    }

    if (
      typeof inputTokens !== 'number' &&
      typeof outputTokens !== 'number' &&
      typeof totalTokens !== 'number'
    ) {
      responseNotes.unshift(
        'n8n did not provide usage totals for this run; token counts are unavailable until Batshit hydrates the execution details.',
      )
    }

    try {
      const response = await fetch(`/api/sessions/${sessionId}/execution-log`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: messageId,
          hydrateN8nWebhookInput: true,
          ...(typeof n8nExecutionSearchLimit === 'number' &&
          Number.isFinite(n8nExecutionSearchLimit)
            ? { n8nExecutionSearchLimit }
            : {}),
          patch: {
            llmSummary: {
              callsCount: this.buildExecutionViewerTokenStat(
                estimatedCallsCount,
                callsConfidence,
                'n8n',
              ),
              totalUsage: usageObj,
              breakdownConfidence: hasToolCallsCount
                ? 'estimated'
                : 'speculative',
            },
            intermediateSteps,
            responseSummary: {
              content: {
                value: finalContent,
                confidence: 'exact',
              },
              usage: usageObj,
              toolCallsCount: this.buildExecutionViewerTokenStat(
                toolCallsCount,
                toolCallsConfidence,
                'n8n',
              ),
              notes: responseNotes,
            },
            runtime: {
              status: 'succeeded',
            },
          },
        }),
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => '')
        throw new Error(
          errorText ||
            `Execution Viewer patch failed with status ${response.status}`,
        )
      }

      const data = await response.json().catch(() => null)
      return {
        intermediateSteps: Array.isArray(data?.hydratedIntermediateSteps)
          ? data.hydratedIntermediateSteps
          : null,
        zipReferences: Array.isArray(data?.hydratedZipReferences)
          ? data.hydratedZipReferences
          : [],
      }
    } catch (snapshotError) {
      logger.warn(
        '[MessageAPI] Failed to patch n8n execution snapshot from end event:',
        snapshotError,
      )
      return null
    }
  }

  private sanitizeN8nNativeStreamEvent(event: Record<string, any>) {
    const next = { ...event }
    let hadTextField = false
    let hasRemainingText = false

    for (const key of ['content', 'text', 'delta'] as const) {
      if (typeof next[key] !== 'string') continue
      hadTextField = true
      next[key] = stripN8nToolInvocationTraceText(next[key])
      if (next[key].trim().length > 0) {
        hasRemainingText = true
      }
    }

    return {
      event: next,
      skip:
        hadTextField &&
        !hasRemainingText &&
        ['item', 'chunk', 'text-delta'].includes(String(event.type ?? '')),
    }
  }

  /**
   * Process NDJSON stream from native AI Agent and forward to SSE
   */
  private async forwardNativeAgentSsePayload(payload: Record<string, unknown>, eventLabel: string) {
    const response = await fetch('/api/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      const responseText = await response.text().catch(() => '')
      const suffix = responseText.trim() ? `: ${responseText.trim()}` : ''
      throw new Error(
        `Failed to forward n8n ${eventLabel} event to Batshit SSE (${response.status})${suffix}`
      )
    }
  }

  private async processNativeAgentStream(
    ndjsonText: string,
    sessionId: string,
    messageId: string,
    subagentMetaMap: Record<string, any> = {},
    n8nExecutionSearchLimit?: number,
  ) {
    // Split by newlines to get individual JSON objects.
    // n8n v2 emits multiple begin/end segments when tools are involved (one per step),
    // so we must NOT treat the first `end` as "message complete". We only finalize once
    // we have consumed the full NDJSON response.
    const lines = ndjsonText.trim().split(/\r?\n/)
    let deferredEndEvent: any | null = null

    for (const line of lines) {
      if (!line.trim()) continue

      let event: any
      try {
        event = JSON.parse(line)
      } catch (e) {
        console.error('[MessageAPI] Failed to parse NDJSON line:', line, e)
        continue
      }

      // Forward events to our SSE endpoint
      if (event.type === 'begin') {
        // Skip - we already sent the start event
      } else if (event.type === 'end') {
        // Defer end; n8n may emit multiple end events (one per tool step)
        deferredEndEvent = this.sanitizeN8nNativeStreamEvent(event).event
      } else {
        const sanitized = this.sanitizeN8nNativeStreamEvent(event)
        if (sanitized.skip) continue

        // Forward the raw NDJSON event to SSE handler for canonical mapping + metadata enrichment
        const payload = {
          ...sanitized.event,
          sessionId,
          messageId,
          metadata:
            sanitized.event.metadata ||
            subagentMetaMap[sanitized.event.toolName?.toLowerCase?.() || ''] ||
            undefined,
        }
        await this.forwardNativeAgentSsePayload(payload, sanitized.event.type || event.type || 'stream')
      }
    }

    // Emit exactly one final end event after processing ALL chunks/steps.
    // If n8n ever starts including intermediateSteps in the response, they'll be on the last end.
    const finalEndPayload = {
      ...(deferredEndEvent || { type: 'end' }),
      sessionId,
      messageId,
      metadata: deferredEndEvent?.metadata || undefined,
    }

    const hydratedEndData = await this.patchN8nExecutionSnapshotFromEnd({
      sessionId,
      messageId,
      endEvent: finalEndPayload,
      n8nExecutionSearchLimit,
    })
    if (
      hydratedEndData?.intermediateSteps?.length &&
      !(
        Array.isArray((finalEndPayload as any).intermediateSteps) &&
        (finalEndPayload as any).intermediateSteps.length > 0
      )
    ) {
      ;(finalEndPayload as any).intermediateSteps =
        hydratedEndData.intermediateSteps
    }
    if (hydratedEndData?.zipReferences?.length) {
      const existingRefs = Array.isArray((finalEndPayload as any).zipReferences)
        ? (finalEndPayload as any).zipReferences
        : []
      const seen = new Set<string>()
      ;(finalEndPayload as any).zipReferences = [
        ...existingRefs,
        ...hydratedEndData.zipReferences,
      ].filter((ref: any) => {
        const reference = typeof ref?.reference === 'string' ? ref.reference : ''
        if (!reference || seen.has(reference)) return false
        seen.add(reference)
        return true
      })
    }

    await this.forwardNativeAgentSsePayload(finalEndPayload, 'final end')
  }
}
