<script lang="ts">
  import type { Message } from '$lib/stores/messages.svelte'
  import MessageContent from './MessageContent.svelte'
  import MessageActionsRow from './MessageActionsRow.svelte'
  import { copyTextToClipboard } from '$lib/utils/clipboard'
  import MessageApprovalPanel from './MessageApprovalPanel.svelte'
  import MessageDeleteDialog from './MessageDeleteDialog.svelte'
  import MessageHeader from './MessageHeader.svelte'
  import LoadingIndicator from './LoadingIndicator.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import * as agentStore from '$lib/stores/agents.svelte'
  import { page } from '$app/state'
  import { Button } from '$lib/components/ui/button'
  import { resolveVoiceSettingsForSpeech, voiceService, type VoiceConfig } from '$lib/services/voice'
  import type { VoiceSettings } from '$lib/types/voice'
  import * as messageStore from '$lib/stores/messages.svelte'
  import { getPlaybackState } from '$lib/stores/voicePlayback.svelte'
  import { toast } from 'svelte-sonner'
  import { DatabaseService } from '$lib/services/databaseRedis.client'
  import {
    normalizePrimaryAgentType,
    shouldShowReasoningByDefaultForPrimaryAgent
  } from '$lib/utils/primaryAgentType'
  import { formatToolDisplayName } from '$lib/utils/toolNameFormatter'
  import ClipThumbnailTile from '$lib/components/clips/ClipThumbnailTile.svelte'
  import ClipPreviewDialog from '$lib/components/clips/ClipPreviewDialog.svelte'
  import ReasoningSummaryRenderer from '../renderers/content/ReasoningSummaryRenderer.svelte'
  import PlanSummaryRenderer from '../renderers/content/PlanSummaryRenderer.svelte'
  import { isThinkingIndicator } from '$lib/utils/thinkingIndicator'
  import type { ToolApprovalResponse, ToolApprovalSummary } from '$lib/types/tool-approvals'
  import { api } from '$lib/services/api'
  import { renderMessageToMarkdown } from '$lib/utils/chatMarkdown'
  import {
    flattenLegacyVoiceStyle,
    getProviderOptionsFor,
    normalizeAgentVoiceProfile
  } from '$lib/utils/voiceSchema'
  import { Archive, ChevronDown, TriangleAlert } from '@lucide/svelte'
  import { DEFAULT_AGENT_ICON_REF } from '$lib/icons/iconCatalog'
  import { normalizeIconRef } from '$lib/icons/iconLegacy'

  const APPROVAL_TIMEOUT_MS = 180_000
  
  let { 
    message, 
    messageIndex = 0, 
    totalMessages = 0, 
    agentMessagesFromEnd = 0,
    isWaitingForResponse = false, 
    isWaitingForToolCall = false,
    toolCallName = null,
    sessionId = null,
    isTrimmed = false,
    isCompacted = false,
    thinkingSubject = '',
    planSubject = {},
    voiceSettings
  } = $props<{ 
    message: Message
    messageIndex?: number
    totalMessages?: number
    agentMessagesFromEnd?: number
    isWaitingForResponse?: boolean
    isWaitingForToolCall?: boolean
    toolCallName?: string | null
    sessionId?: string | null
    isTrimmed?: boolean
    isCompacted?: boolean
    thinkingSubject?: string
    planSubject?: { content?: string; items?: any[] }
    voiceSettings?: VoiceSettings
  }>()
  
  const isAI = $derived(message.role === 'assistant')
  const responseFailed = $derived(
    isAI &&
      message.status !== 'in_progress' &&
      (message.metadata as any)?.response_failed === true
  )
  const responseFailureText = $derived.by(() => {
    const raw = (message.metadata as any)?.error_message
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : ''
  })
  const responseFailureKind = $derived.by(() => {
    const kind = (message.metadata as any)?.failure_kind
    return typeof kind === 'string' ? kind : ''
  })
  const isCompactSummary = $derived(Boolean((message.metadata as any)?.contextCompactSummary))
  const compactSummaryMessageCount = $derived.by(() => {
    const value = (message.metadata as any)?.compactedMessageCount
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.round(value))
      : 0
  })
  const isContextExcluded = $derived(isTrimmed || isCompacted)
  const contextExcludedTitle = $derived(
    isCompacted
      ? 'Compacted out of agent context'
      : isTrimmed
        ? 'Trimmed from agent context'
        : undefined
  )
  // Use the agent_id from the message to get the correct agent
  const messageAgent = $derived(message.agent_id ? agentStore.getAgentById(message.agent_id) : null)
  const agent = $derived(messageAgent ?? agentStore.getCurrentAgent())
  const speechVoiceSettings = $derived(
    resolveVoiceSettingsForSpeech(voiceSettings, agent?.voice_profile)
  )
  
  // Check if this is the last AI message (for showing loading states)
  const isLastMessage = $derived(messageIndex === totalMessages - 1)
  const shouldShowToolLoading = $derived(
    isAI && isLastMessage && message.status === 'in_progress' && isWaitingForToolCall
  )
  const showReasoning = $derived(
    isAI &&
      Boolean(
        (
          agent?.show_reasoning ??
          shouldShowReasoningByDefaultForPrimaryAgent(
            normalizePrimaryAgentType(agent as any)
          )
        ) === true
      )
  )
  const thinkingIndicatorActive = $derived(isThinkingIndicator(thinkingSubject))
  const showThinkingIndicator = $derived(
    isAI &&
    thinkingIndicatorActive &&
    message.status === 'in_progress' &&
    !message.content &&
    !isWaitingForToolCall
  )
  const shouldShowLoading = $derived(
    isAI &&
    isLastMessage &&
    !message.content &&
    !isWaitingForToolCall &&
    (isWaitingForResponse || showThinkingIndicator)
  )
  // Show dots animation whenever message is in progress and not waiting for tools
  const shouldShowStreamingDots = $derived(
    isAI && isLastMessage && message.content && message.status === 'in_progress' && !isWaitingForToolCall
  )
  const shouldReserveStreamingStatusSlot = $derived(
    isAI && isLastMessage && message.status === 'in_progress' && !shouldShowLoading
  )
  const toolCallLabel = $derived(toolCallName ? formatToolDisplayName(toolCallName) : '')

  const reasoningSummary = $derived(
    thinkingSubject && !thinkingIndicatorActive
      ? thinkingSubject
      : typeof (message.metadata as any)?.reasoningSummary === 'string'
        ? (message.metadata as any).reasoningSummary
        : ''
  )

  const planItems = $derived(
    Array.isArray(planSubject?.items)
      ? planSubject?.items
      : Array.isArray((message.metadata as any)?.planItems)
        ? (message.metadata as any).planItems
        : []
  )

  const planSummary = $derived(
    planSubject?.content
      ? planSubject.content
      : typeof (message.metadata as any)?.planSummary === 'string'
        ? (message.metadata as any).planSummary
        : ''
  )

  const toolApprovalSummary = $derived(
    (() => {
      const raw = (message.metadata as any)?.toolApprovals
      if (!raw || typeof raw !== 'object') return null
      const approvals = Array.isArray(raw.approvals) ? raw.approvals : []
      return { ...raw, approvals } as ToolApprovalSummary
    })()
  )

  const toolApprovals = $derived(toolApprovalSummary?.approvals ?? [])
  const hasToolApprovals = $derived(isAI && toolApprovals.length > 0)
  const approvalActorName = $derived((agent?.displayName || 'The agent').trim())
  let approvalSubmitting = $state(false)
  let approvalError = $state<string | null>(null)
  let approvalNowMs = $state(Date.now())

  const toolResultsSummary = $derived(
    Array.isArray((message.metadata as any)?.zipControl?.toolResultsSummary)
      ? (message.metadata as any).zipControl.toolResultsSummary
      : Array.isArray((message.metadata as any)?.zipControl?.toolNotes)
        ? (message.metadata as any).zipControl.toolNotes
        : []
  )
  const hasToolResultsSummary = $derived(isAI && toolResultsSummary.length > 0)
  let showToolResultsSummary = $state(false)

  const showPlan = $derived(
    isAI && (planItems.length > 0 || Boolean(planSummary))
  )
  
  // Get user settings from page data
  const userSettings = $derived(page.data.userSettings)

  const agentDisplayName = $derived(agent?.displayName || 'AI')
  const userDisplayName = $derived(userSettings?.display_name || 'Me')
  const agentAvatarUrl = $derived(
    agent?.avatar_url || agent?.avatar || (agent?.avatar_icon_ref ? null : '/assets/batshit_default_AI_Avatar_1.png')
  )
  const agentAvatarIconRef = $derived(
    agent?.avatar_icon_ref ? normalizeIconRef(agent.avatar_icon_ref, DEFAULT_AGENT_ICON_REF) : null
  )
  const userAvatarUrl = $derived(
    userSettings?.avatar_url || (userSettings?.avatar_icon_ref ? null : '/assets/batshit_default_User_Avatar.png')
  )

  function firstString(...values: unknown[]) {
    for (const value of values) {
      if (typeof value !== 'string') continue
      const trimmed = value.trim()
      if (trimmed.length > 0) return trimmed
    }
    return null
  }

  const messageModelBadge = $derived.by(() => {
    if (!isAI) return null

    const metadata = (message.metadata ?? {}) as Record<string, any>
    const runtimeDetails =
      metadata.runtimeDetails && typeof metadata.runtimeDetails === 'object'
        ? metadata.runtimeDetails
        : metadata.runtimeMetadata && typeof metadata.runtimeMetadata === 'object'
          ? metadata.runtimeMetadata
          : {}
    const providerMessageSource =
      metadata.providerMessageSource && typeof metadata.providerMessageSource === 'object'
        ? metadata.providerMessageSource
        : {}
    const agentConnection = agent?.primary_model_connection ?? null

    const storedProvider = firstString(
      providerMessageSource.providerId,
      metadata.providerId,
      metadata.provider_id,
      metadata.primary_model_provider_id,
      metadata.primary_model_provider,
      runtimeDetails.providerId,
      runtimeDetails.provider,
      metadata.provider,
      message.provider
    )
    const fallbackProvider = firstString(
      agent?.primary_model_provider,
      agentConnection?.service,
      agentConnection?.id
    )
    const provider = storedProvider || fallbackProvider

    const storedModelId = firstString(
      metadata.primary_model_effective_id,
      metadata.primary_model_model_id,
      providerMessageSource.modelId,
      metadata.modelId,
      metadata.model_id,
      runtimeDetails.modelId,
      runtimeDetails.modelName,
      metadata.modelName,
      metadata.model,
      metadata.primary_model_name,
      message.model
    )
    const fallbackModelId = firstString(
      agent?.primary_model_name
    )
    const modelId = storedModelId || fallbackModelId

    const storedModelName = firstString(
      metadata.modelName,
      runtimeDetails.modelName,
      metadata.primary_model_model_id,
      metadata.model,
      metadata.primary_model_name,
      message.model
    )
    const fallbackModelName = firstString(
      agent?.primary_model_name,
      modelId
    )
    const modelName = storedModelName || fallbackModelName

    if (!provider || !modelId) return null

    return {
      provider,
      modelId,
      modelName: modelName || modelId,
      title: `${modelName || modelId} via ${provider}`
    }
  })
  
  // Format timestamp
  const timestamp = $derived.by(() => {
    const date = new Date(message.created_at)
    return date.toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit',
      hour12: true 
    })
  })
  
  const playbackState = $derived(getPlaybackState())
  const isSpeaking = $derived(playbackState.activeMessageId === message.id)
  let showDeleteDialog = $state(false)
  let messageClips = $state<{ subsequent: any[], first: any[] }>({ subsequent: [], first: [] })
  let previewClip = $state<any | null>(null)
  let previewOpen = $state(false)

  function openClipPreview(clip: any) {
    previewClip = clip
    previewOpen = true
  }

  function resolveVoiceConfig(): VoiceConfig | undefined {
    const agentVoice = normalizeAgentVoiceProfile(agent?.voice_profile)
    const agentTts = agentVoice?.tts
    if (!agentTts) return undefined
    return {
      provider: agentTts.providerId,
      model: agentTts.modelId,
      voiceId: agentTts.voiceId,
      profileId: agentTts.profileId,
      common: agentTts.common,
      providerOptions: getProviderOptionsFor(agentTts.providerOptions, agentTts.providerId),
      style: flattenLegacyVoiceStyle(agentTts)
    }
  }
  
  function handlePlayPause() {
    if (!isAI) return

    if (isSpeaking) {
      voiceService.stopSpeaking()
      return
    }

    const voiceConfig = resolveVoiceConfig()
    const speechPlanned = voiceService.willSpeakText(message.content, {
      manual: true,
      voiceSettings: speechVoiceSettings
    })
    window.dispatchEvent(
      new CustomEvent('batshit:goon-message', {
        detail: {
          messageId: message.id,
          agentId: message.agent_id ?? null,
          content: message.content,
          speechPlanned
        }
      })
    )
    void voiceService.speak(message.content, {
      voice: voiceConfig,
      voiceSettings: speechVoiceSettings,
      agentId: message.agent_id ?? null,
      messageId: message.id,
      manual: true
    })
  }

  async function handleCopyMarkdown() {
    try {
      const dbService = new DatabaseService()
      const markdown = await renderMessageToMarkdown(message, {
        resolveZip: async (zipId) => {
          try {
            return await api.getZip(zipId)
          } catch (error) {
            console.error('Failed to load zip for markdown copy:', error)
            return null
          }
        },
        resolveClip: async (clipId) => {
          try {
            return await dbService.getClip(clipId)
          } catch (error) {
            console.error('Failed to load clip for markdown copy:', error)
            return null
          }
        }
      })

      await copyTextToClipboard(markdown)
      toast.success('Markdown copied')
    } catch (error) {
      console.error('Failed to copy markdown:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to copy markdown')
    }
  }
  
  function handleDelete() {
    showDeleteDialog = true
  }
  
  async function confirmDelete() {
    const pageData = page.data
    const resolvedSessionId = message.session_id || sessionId
    if (pageData.user && resolvedSessionId) {
      try {
        const dbService = new DatabaseService()
        await dbService.deleteMessage(
          message.id,
          resolvedSessionId,
          pageData.user.id
        )
        messageStore.deleteMessage(message.id)
        showDeleteDialog = false
        toast.success('Message deleted')
      } catch (error) {
        console.error('Failed to delete message from database:', error)
        toast.error('Failed to delete message')
      }
      return
    }

    messageStore.deleteMessage(message.id)
    showDeleteDialog = false
  }

  function formatApprovalInput(input: any): string {
    if (input === null || input === undefined) return ''
    if (typeof input === 'string') return input
    try {
      return JSON.stringify(input, null, 2)
    } catch {
      return String(input)
    }
  }

  function extractCommandFromApproval(approval: any): string {
    const sources = [
      approval?.input,
      approval?.toolCall?.input,
      approval?.toolCall?.args,
      approval?.toolCall?.parameters
    ]

    for (const source of sources) {
      if (!source) continue
      if (typeof source === 'string') {
        const trimmed = source.trim()
        if (!trimmed) continue
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
          try {
            const parsed = JSON.parse(trimmed)
            const nested = extractCommandFromApproval({ input: parsed })
            if (nested) return nested
          } catch {
            // Treat as literal command when JSON parsing fails
          }
        }
        return trimmed
      }

      if (typeof source === 'object') {
        if (typeof source.command === 'string' && source.command.trim()) return source.command.trim()
        if (typeof source.cmd === 'string' && source.cmd.trim()) return source.cmd.trim()
      }
    }

    return ''
  }

  function summarizeBashCommand(command: string): string {
    const trimmed = command.trim()
    if (!trimmed) return 'run a shell command'

    const mkdirQuoted = trimmed.match(/\bmkdir\b(?:\s+-\S+)*\s+["']([^"']+)["']/i)
    if (mkdirQuoted?.[1]) return `create folder \`${mkdirQuoted[1]}\``

    const mkdirBare = trimmed.match(/\bmkdir\b(?:\s+-\S+)*\s+([^\s;&|]+)/i)
    if (mkdirBare?.[1]) return `create folder \`${mkdirBare[1]}\``

    const writeRedirect = trimmed.match(/\b(?:cat|tee|printf|echo)\b[\s\S]*?>\s*([^\s;&|]+)/i)
    if (writeRedirect?.[1]) return `write file \`${writeRedirect[1]}\``

    const deleteTarget = trimmed.match(/\brm\b(?:\s+-\S+)*\s+([^\s;&|]+)/i)
    if (deleteTarget?.[1]) return `delete \`${deleteTarget[1]}\``

    const preview = trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed
    return `run \`${preview}\``
  }

  function describeApproval(approval: any): string {
    const actor = approvalActorName || 'The agent'
    const toolName = (approval?.toolName || '').toLowerCase()
    const command = extractCommandFromApproval(approval)

    if (command && (toolName.includes('bash') || toolName.includes('execute_command'))) {
      return `${actor} wants to ${summarizeBashCommand(command)}.`
    }

    const displayName = formatToolDisplayName(approval?.toolName || 'tool')
    return `${actor} wants to use ${displayName}.`
  }

  function updateToolApprovalStatus(
    approvalId: string,
    status: 'pending' | 'approved' | 'denied' | 'expired'
  ) {
    const summary = toolApprovalSummary
    if (!summary) return
    const approvals = summary.approvals.map((entry) =>
      entry?.approvalId === approvalId ? { ...entry, status, submitted: false } : entry
    )

    messageStore.updateMessage(message.id, {
      metadata: {
        ...(message.metadata ?? {}),
        toolApprovals: {
          ...summary,
          approvals
        }
      }
    })
  }

  function parseTimestampMs(value: unknown): number | null {
    if (typeof value !== 'string' || value.trim().length === 0) return null
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  function resolveApprovalExpiryMs(approval: any): number | null {
    const explicitExpiresAt = parseTimestampMs(approval?.expiresAt)
    if (explicitExpiresAt !== null) return explicitExpiresAt

    const requestedAt = parseTimestampMs(approval?.requestedAt)
    if (requestedAt !== null) return requestedAt + APPROVAL_TIMEOUT_MS

    const messageCreatedAt = parseTimestampMs(message.created_at)
    if (messageCreatedAt !== null) return messageCreatedAt + APPROVAL_TIMEOUT_MS

    return null
  }

  function getApprovalRemainingSeconds(approval: any): number | null {
    if (!approval || approval.status !== 'pending') return null
    const expiresAtMs = resolveApprovalExpiryMs(approval)
    if (expiresAtMs === null) return null
    const remainingMs = expiresAtMs - approvalNowMs
    if (remainingMs <= 0) return 0
    return Math.ceil(remainingMs / 1000)
  }

  async function submitToolApprovals(approvals: any[]) {
    if (!approvals.length) return
    if (approvalSubmitting) return

    approvalSubmitting = true
    approvalError = null

    const unsentApprovals = approvals.filter(
      (entry) =>
        !entry?.submitted &&
        (entry?.status === 'approved' || entry?.status === 'denied' || entry?.status === 'expired')
    )

    if (unsentApprovals.length === 0) {
      approvalSubmitting = false
      return
    }

    const responses: ToolApprovalResponse[] = unsentApprovals.map((entry) => ({
      type: 'tool-approval-response',
      approvalId: entry.approvalId,
      approved: entry.status === 'approved',
      reason:
        entry.status === 'approved'
          ? 'User approved'
          : entry.status === 'expired'
            ? 'Approval expired after 3 minutes'
            : 'User denied'
    }))

    const agentRecord = agent ?? agentStore.getCurrentAgent()
    const session = sessionId || message.session_id

    try {
      const response = await fetch('/api/messages/send-routed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: message.id,
          content: '',
          sessionId: session,
          agentId: agentRecord?.id ?? message.agent_id,
          messages: messageStore.getMessages(),
          agentType: normalizePrimaryAgentType(agentRecord as any),
          webhookUrl: agentRecord?.webhook_url ?? null,
          metadata: {
            ...(message.metadata ?? {}),
            toolApprovalResponse: responses
          }
        })
      })

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => ({}))
        if (response.status === 410 && errorPayload?.code === 'APPROVAL_EXPIRED') {
          const expiredIds = Array.isArray(errorPayload?.approvalIds)
            ? errorPayload.approvalIds
                .map((entry: unknown) => (typeof entry === 'string' ? entry.trim() : ''))
                .filter((entry: string) => entry.length > 0)
            : []

          if (expiredIds.length > 0 && toolApprovalSummary) {
            const expiredSet = new Set(expiredIds)
            const nextApprovals = toolApprovalSummary.approvals.map((entry) =>
              entry && expiredSet.has(entry.approvalId)
                ? {
                    ...entry,
                    status: 'expired',
                    submitted: false,
                    ...(typeof errorPayload?.expiredAt === 'string' ? { expiredAt: errorPayload.expiredAt } : {})
                  }
                : entry
            )
            messageStore.updateMessage(message.id, {
              metadata: {
                ...(message.metadata ?? {}),
                toolApprovals: {
                  ...toolApprovalSummary,
                  approvals: nextApprovals
                }
              }
            })
          }
        }
        throw new Error(errorPayload.error || 'Failed to submit tool approvals')
      }

      const summary = toolApprovalSummary
      if (summary) {
        const sentIds = new Set(unsentApprovals.map((entry) => entry.approvalId))
        const nextApprovals = summary.approvals.map((entry) =>
          sentIds.has(entry?.approvalId) ? { ...entry, submitted: true } : entry
        )
        messageStore.updateMessage(message.id, {
          metadata: {
            ...(message.metadata ?? {}),
            toolApprovals: {
              ...summary,
              approvals: nextApprovals
            }
          }
        })
      }
    } catch (error: any) {
      const messageText = error instanceof Error ? error.message : String(error ?? '')
      approvalError = messageText || 'Failed to submit approvals'
      toast.error(approvalError)
      return
    } finally {
      approvalSubmitting = false
    }
  }

  async function submitClaudeApproval(approvalId: string, approved: boolean) {
    if (!approvalId) return
    if (approvalSubmitting) return

    approvalSubmitting = true
    approvalError = null

    try {
      const response = await fetch('/api/tool-approvals/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approvalId,
          approved,
          reason: approved ? 'User approved' : 'User denied',
          sessionId: sessionId || message.session_id,
          messageId: message.id
        })
      })

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => ({}))
        throw new Error(errorPayload.error || 'Failed to submit approval')
      }
    } catch (error: any) {
      const messageText = error instanceof Error ? error.message : String(error ?? '')
      approvalError = messageText || 'Failed to submit approval'
      toast.error(approvalError)
      return
    } finally {
      approvalSubmitting = false
    }
  }

  async function processExpiredApprovals() {
    const summary = toolApprovalSummary
    if (!summary || approvalSubmitting) return

    const now = Date.now()
    const nowIso = new Date(now).toISOString()
    const approvals = summary.approvals
    const expiredIds = new Set(
      approvals
        .filter((entry) => {
          if (!entry || entry.status !== 'pending' || entry.submitted) return false
          const expiresAtMs = resolveApprovalExpiryMs(entry)
          return expiresAtMs !== null && now >= expiresAtMs
        })
        .map((entry) => entry.approvalId)
    )

    if (expiredIds.size === 0) return

    const nextApprovals = approvals.map((entry) => {
      if (!entry || !expiredIds.has(entry.approvalId)) return entry
      const expiresAtMs = resolveApprovalExpiryMs(entry)
      return {
        ...entry,
        status: 'expired',
        submitted: false,
        expiredAt: nowIso,
        ...(entry.expiresAt
          ? {}
          : {
              expiresAt: new Date(
                expiresAtMs ?? now
              ).toISOString()
            })
      }
    })

    messageStore.updateMessage(message.id, {
      metadata: {
        ...(message.metadata ?? {}),
        toolApprovals: {
          ...summary,
          approvals: nextApprovals
        }
      }
    })

    const allResolved = nextApprovals.every(
      (entry) =>
        entry?.status === 'approved' || entry?.status === 'denied' || entry?.status === 'expired'
    )

    if (allResolved) {
      await submitToolApprovals(nextApprovals)
    }
  }

  async function handleApprovalAction(approvalId: string, approved: boolean) {
    const selectedApproval = toolApprovals.find((entry) => entry?.approvalId === approvalId)
    if (selectedApproval?.status === 'expired') {
      approvalError = 'This approval already expired after 3 minutes. Ask the agent to run it again.'
      toast.error(approvalError)
      return
    }

    updateToolApprovalStatus(approvalId, approved ? 'approved' : 'denied')

    const summary = toolApprovalSummary
    if (!summary) return
    const approvals = summary.approvals.map((entry) =>
      entry?.approvalId === approvalId
        ? { ...entry, status: approved ? 'approved' : 'denied', submitted: false }
        : entry
    )

    const approvalSource =
      summary.source ||
      approvals.find((entry) => entry?.approvalId === approvalId)?.source
    if (approvalSource === 'claude') {
      await submitClaudeApproval(approvalId, approved)
      return
    }

    const allResolved = approvals.every(
      (entry) =>
        entry?.status === 'approved' || entry?.status === 'denied' || entry?.status === 'expired'
    )
    if (allResolved) {
      await submitToolApprovals(approvals)
    }
  }

  $effect(() => {
    if (!hasToolApprovals) return

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null

    const schedule = async () => {
      const summary = toolApprovalSummary
      if (!summary) return

      await processExpiredApprovals()

      const now = Date.now()
      const pendingExpiries = summary.approvals
        .filter((entry) => entry?.status === 'pending' && !entry?.submitted)
        .map((entry) => resolveApprovalExpiryMs(entry))
        .filter((value): value is number => value !== null)

      if (pendingExpiries.length === 0) return

      const nextExpiry = Math.min(...pendingExpiries)
      const delay = Math.max(250, nextExpiry - now + 25)
      timeoutHandle = setTimeout(() => {
        void schedule()
      }, delay)
    }

    void schedule()

    return () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }
    }
  })

  $effect(() => {
    const pendingApprovals = toolApprovals.filter(
      (entry) => entry?.status === 'pending' && !entry?.submitted
    )
    if (pendingApprovals.length === 0) return

    approvalNowMs = Date.now()
    const interval = setInterval(() => {
      approvalNowMs = Date.now()
    }, 1000)

    return () => {
      clearInterval(interval)
    }
  })
  
</script>

{#if isCompactSummary}
  <div
    class="message-row is-compact-summary"
    data-testid="message"
    data-message-id={message.id}
    data-context-compact-summary="true"
  >
    <details class="compact-summary-event">
      <summary class="compact-summary-trigger">
        <span class="compact-summary-icon" aria-hidden="true">
          <Archive />
        </span>
        <span class="compact-summary-copy">
          <span class="compact-summary-title">Context Compact Summary</span>
          <span class="compact-summary-meta">
            {compactSummaryMessageCount > 0
              ? `${compactSummaryMessageCount} message${compactSummaryMessageCount === 1 ? '' : 's'} summarized`
              : 'Older context summarized'}
            · {timestamp}
          </span>
        </span>
        <ChevronDown class="compact-summary-chevron" aria-hidden="true" />
      </summary>
      <div class="compact-summary-body">
        <MessageContent
          content={message.content}
          role="system"
          {messageIndex}
          {totalMessages}
          {agentMessagesFromEnd}
          messageId={message.id}
          metadata={message.metadata}
          agentSettings={agent}
          isStreaming={false}
          {sessionId}
        />
      </div>
    </details>
  </div>
{:else}
<div
  class="message-row {isAI ? 'is-ai' : 'is-user'}"
  class:is-trimmed={isContextExcluded}
  data-trimmed-context={isContextExcluded ? 'true' : undefined}
  data-compacted-context={isCompacted ? 'true' : undefined}
  data-testid="message"
  data-message-id={message.id}
>
  <div
    data-testid="{isAI ? 'ai-response' : 'user-message'}"
    class="message-shell {isAI ? 'is-ai' : 'is-user'}"
  >
    <MessageHeader
      {isAI}
      {agentDisplayName}
      {agentAvatarUrl}
      {agentAvatarIconRef}
      agentAvatarIconFit={agent?.avatar_icon_fit}
      {userDisplayName}
      {userAvatarUrl}
      userAvatarIconRef={userSettings?.avatar_icon_ref}
      userAvatarIconFit={userSettings?.avatar_icon_fit}
      userInitialsSource={userSettings?.display_name || userSettings?.email}
      {timestamp}
      {isSpeaking}
      {messageModelBadge}
    />
    
    <!-- Message bubble with backdrop -->
    <div
      class="message-bubble-backdrop"
      class:is-trimmed={isContextExcluded}
      title={contextExcludedTitle}
    >
      <!-- Clips positioned at top of backdrop -->
      {#if !isAI && messageClips.subsequent.length > 0}
        <div class="clips-container">
          {#each messageClips.subsequent as clip, index}
            <div 
              class="clip-indicator clip-badge"
              data-clip-id={clip.clipId}
              style={`--clip-rotation:${8 + index}deg`}
            >
              <button
                type="button"
                class="clip-badge-mini"
                title={clip.filename}
                aria-label={`Preview ${clip.filename}`}
                onclick={() => openClipPreview(clip)}
              >
                <ClipThumbnailTile
                  clip={clip}
                  size="sm"
                  showPaperclip={true}
                />
              </button>
            </div>
          {/each}
        </div>
      {/if}
      
      <!-- Message bubble (now has a proper class!) -->
      <div class="
        message-bubble
        {isAI 
          ? 'is-ai'
          : 'is-user'}
      ">
        {#if showReasoning && reasoningSummary}
          <div class="message-block-spacer">
            <ReasoningSummaryRenderer
              content={reasoningSummary}
              isStreaming={message.status === 'in_progress'}
            />
          </div>
        {/if}

        {#if showPlan}
          <div class="message-block-spacer">
            <PlanSummaryRenderer
              items={planItems}
              content={planSummary}
              isStreaming={message.status === 'in_progress'}
            />
          </div>
        {/if}

        {#if shouldShowLoading}
          <LoadingIndicator type="dots" text={showThinkingIndicator ? 'Thinking...' : ''} />
        {:else}
          <MessageContent 
            content={message.content} 
            role={message.role} 
            {messageIndex}
            {totalMessages}
            {agentMessagesFromEnd}
            messageId={message.id}
            intermediateSteps={message.intermediateSteps}
            metadata={message.metadata}
            agentSettings={agent}
            isStreaming={message.status === 'in_progress'}
            {sessionId}
            onClipsDetected={(clips: { subsequent: any[], first: any[] }) => messageClips = clips}
          />
        {/if}

        {#if responseFailed && !shouldShowLoading}
          <div class="message-failure-banner" data-testid="message-failure-banner">
            <div class="message-failure-heading">
              <TriangleAlert class="message-failure-icon" aria-hidden="true" />
              <span>
                {responseFailureKind === 'context_exhausted'
                  ? 'This response hit the context limit before completing'
                  : 'This response was cut short by an error'}
              </span>
            </div>
            {#if responseFailureText}
              <p class="message-failure-detail">{responseFailureText}</p>
            {/if}
          </div>
        {/if}

        {#if hasToolResultsSummary && !shouldShowLoading}
          <div class="message-tool-summary">
            {#if showToolResultsSummary}
              <div class="message-tool-summary-panel">
                <div class="message-tool-summary-heading">
                  <span>Tool Results Summary</span>
                  <SettingsInfoMenu
                    ariaLabel="About Tool Results Summary"
                    side="top"
                    align="start"
                    class="message-tool-summary-info-trigger"
                    contentClass="w-72"
                  >
                    Agent-written notes from tool calls. These stay visible when tool results are
                    zipped so the agent can keep useful context.
                  </SettingsInfoMenu>
                </div>
                {#each toolResultsSummary as note, idx (idx)}
                  <div class="message-tool-summary-line">
                    <span class="message-tool-summary-title">
                      {note.toolName || note.toolCallId || 'Tool'}
                    </span>
                    {#if note.summary}
                      : {note.summary}
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
            <button
              type="button"
              class="message-tool-summary-toggle"
              onclick={() => showToolResultsSummary = !showToolResultsSummary}
              aria-expanded={showToolResultsSummary}
              aria-label={showToolResultsSummary ? 'Hide Tool Results Summary' : 'Show Tool Results Summary'}
              title={showToolResultsSummary ? 'Hide Tool Results Summary' : 'Show Tool Results Summary'}
            >
              <ChevronDown class={`message-tool-summary-chevron ${showToolResultsSummary ? 'is-open' : ''}`} />
            </button>
          </div>
        {/if}

        {#if shouldReserveStreamingStatusSlot}
          <div
            class="message-stream-status-slot"
            class:is-empty={!shouldShowToolLoading && !shouldShowStreamingDots}
          >
            {#if shouldShowToolLoading}
              <LoadingIndicator type="tool" text={toolCallLabel ? `Calling ${toolCallLabel}...` : 'Calling tool...'} />
            {:else if shouldShowStreamingDots}
              <LoadingIndicator type="dots" />
            {/if}
          </div>
        {/if}
      </div>

      {#if hasToolApprovals}
        <MessageApprovalPanel
          approvals={toolApprovals}
          {approvalSubmitting}
          {approvalError}
          {describeApproval}
          {formatApprovalInput}
          {getApprovalRemainingSeconds}
          onApprovalAction={handleApprovalAction}
        />
      {/if}
    </div>
    
    <MessageActionsRow
      {isAI}
      {isSpeaking}
      tokens={message.metadata?.tokens}
      onPlayPause={handlePlayPause}
      onCopyMarkdown={handleCopyMarkdown}
      onDelete={handleDelete}
    />
  </div>
</div>
{/if}

<MessageDeleteDialog bind:open={showDeleteDialog} onConfirm={confirmDelete} />
<ClipPreviewDialog bind:open={previewOpen} clip={previewClip} />

<style>
  .message-row {
    display: flex;
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }

  .message-row.is-ai {
    justify-content: flex-start;
  }

  .message-row.is-user {
    justify-content: flex-end;
  }

  .message-row.is-compact-summary {
    justify-content: center;
  }

  .compact-summary-event {
    box-sizing: border-box;
    width: min(100%, 46rem);
    border: 1px solid color-mix(in oklab, var(--border) 76%, transparent);
    border-radius: 8px;
    background: color-mix(in oklab, var(--muted) 24%, transparent);
    color: var(--foreground);
    overflow: hidden;
  }

  .compact-summary-trigger {
    display: grid;
    grid-template-columns: 1.75rem minmax(0, 1fr) 1.5rem;
    align-items: center;
    gap: 0.55rem;
    min-height: 2.7rem;
    padding: 0.55rem 0.7rem;
    cursor: pointer;
    list-style: none;
  }

  .compact-summary-trigger::-webkit-details-marker {
    display: none;
  }

  .compact-summary-icon {
    display: inline-flex;
    width: 1.75rem;
    height: 1.75rem;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    background: color-mix(in oklab, var(--foreground) 9%, transparent);
    color: var(--muted-foreground);
  }

  .compact-summary-icon :global(svg),
  :global(.compact-summary-chevron) {
    width: 0.95rem;
    height: 0.95rem;
  }

  .compact-summary-copy {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 0.12rem;
  }

  .compact-summary-title {
    color: var(--foreground);
    font-size: 0.78rem;
    font-weight: 650;
    line-height: 1.2;
  }

  .compact-summary-meta {
    color: var(--muted-foreground);
    font-size: 0.7rem;
    line-height: 1.2;
  }

  :global(.compact-summary-chevron) {
    color: var(--muted-foreground);
    transition: transform 150ms ease;
  }

  .compact-summary-event[open] :global(.compact-summary-chevron) {
    transform: rotate(180deg);
  }

  .compact-summary-body {
    border-top: 1px solid color-mix(in oklab, var(--border) 64%, transparent);
    padding: 0.75rem 0.85rem 0.85rem;
  }

  .message-shell {
    display: flex;
    box-sizing: border-box;
    flex: 0 1 auto;
    max-width: 80%;
    min-width: 0;
    flex-direction: column;
  }

  .message-shell.is-ai {
    align-items: flex-start;
  }

  .message-shell.is-user {
    align-items: flex-end;
  }

  /* Message bubble backdrop - outer container */
  .message-bubble-backdrop {
    position: relative;
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    padding: 4px;
    border-radius: 0.75rem;
    --backdrop-bg: oklch(1 0 0 / 0.13);
    --backdrop-bg-trimmed: oklch(0.72 0.35 333.46 / 0.13);
    --backdrop-border: none;
    --backdrop-shadow: none;
    background: var(--backdrop-bg);
    border: var(--backdrop-border);
    box-shadow: var(--backdrop-shadow);
  }

  .message-bubble-backdrop.is-trimmed {
    background: var(--backdrop-bg-trimmed);
  }
  
  /* Message bubble - the actual chat bubble */
  .message-bubble {
    position: relative;
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    border-radius: var(--radius);
    padding: 0.5rem 1rem;
    box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.12);
  }

  .message-bubble.is-ai {
    background: var(--message-ai-background);
    color: var(--message-ai-foreground);
  }

  .message-bubble.is-user {
    background: var(--message-user-background);
    color: var(--message-user-foreground);
  }

  .message-block-spacer {
    margin-bottom: 0.5rem;
  }

  .message-stream-status-slot {
    min-height: 2rem;
    display: flex;
    align-items: center;
  }

  .message-stream-status-slot.is-empty {
    pointer-events: none;
    visibility: hidden;
  }

  .message-tool-summary {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin-top: 0.5rem;
  }

  .message-tool-summary-panel {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    border: 1px solid oklch(from var(--border) l c h / 0.6);
    border-radius: var(--radius);
    background: oklch(from var(--muted) l c h / 0.3);
    padding: 0.75rem;
  }

  .message-failure-banner {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin-top: 0.75rem;
    border: 1px solid oklch(from var(--destructive) l c h / 0.4);
    border-radius: var(--radius);
    background: oklch(from var(--destructive) l c h / 0.08);
    padding: 0.625rem 0.75rem;
  }

  .message-failure-heading {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--destructive);
  }

  .message-failure-banner :global(.message-failure-icon) {
    width: 0.875rem;
    height: 0.875rem;
    flex-shrink: 0;
  }

  .message-failure-detail {
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.4;
    color: oklch(from var(--foreground) l c h / 0.75);
    overflow-wrap: anywhere;
  }

  .message-tool-summary-heading {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    color: var(--muted-foreground);
    font-size: 0.72rem;
    font-weight: 650;
    line-height: 1.2;
  }

  .message-tool-summary-toggle {
    display: inline-flex;
    width: 2rem;
    height: 1.2rem;
    align-self: center;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
    opacity: 0.56;
    transition: background-color 150ms ease, color 150ms ease, opacity 150ms ease;
  }

  .message-tool-summary-toggle:hover {
    background: oklch(from var(--muted) l c h / 0.16);
    color: var(--foreground);
    opacity: 0.82;
  }

  :global(.message-tool-summary-chevron) {
    width: 0.95rem;
    height: 0.95rem;
    transition: transform 150ms ease;
  }

  :global(.message-tool-summary-chevron.is-open) {
    transform: rotate(180deg);
  }

  .message-tool-summary-line {
    color: var(--muted-foreground);
    font-size: 0.75rem;
  }

  .message-tool-summary-title {
    color: var(--foreground);
    font-weight: 650;
  }

  :global(.message-delete-confirm-action) {
    background: var(--destructive);
  }

  :global(.message-delete-confirm-action:hover) {
    background: oklch(from var(--destructive) calc(l * 0.9) c h);
  }

  /* Clips container - positioned at top of backdrop */
  .clips-container {
    position: absolute;
    top: -27px;
    left: 18px;
    display: flex;
    flex-direction: row;
    gap: 0.1rem;
    z-index: 10;
    padding: 1px 5px 0;
    background: oklch(1 0 0 / 0.1);
    border-radius: 10px 10px 0 0;
    height: 27px;
  }
  
  /* Clip badge styles - copied from MessageContent */
  .clip-indicator {
    position: relative;
  }
  
  .clip-badge-mini {
    width: 42px;
    height: 42px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 0;
    background: transparent;
    padding: 0;
    color: inherit;
    cursor: pointer;
    transition: all 0.2s ease;
    transform: rotate(var(--clip-rotation, 8deg));
    font-size: 0.875rem;
    position: relative;
  }
  
  .clip-indicator .clip-badge-mini:hover {
    transform: rotate(calc(var(--clip-rotation, 8deg) - 3deg)) scale(1.1) translateY(2px);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  }

  .clip-badge-mini:focus-visible {
    border-radius: 0.85rem;
    outline: 2px solid color-mix(in oklab, var(--foreground) 34%, transparent);
    outline-offset: 3px;
  }
</style>
