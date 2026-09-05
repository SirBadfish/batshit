<script lang="ts">
  import * as Sheet from '$lib/components/ui/sheet'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import * as Switch from '$lib/components/ui/switch'
  import { Button } from '$lib/components/ui/button'
  import JSONViewer from '$lib/components/ui/JSONViewer.svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { ChevronDown, RefreshCcw } from '@lucide/svelte'
  import { getUserSettings } from '$lib/stores/userSettings.svelte'
  import { approximateTokenCount } from '$lib/utils/tokenCounter'
  import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
  import {
    truncateExecutionViewerBase64,
    truncateExecutionViewerBase64InValue
  } from '$lib/utils/executionViewerBase64'
  import {
    buildExecutionToolActivityEntries,
    type ExecutionToolActivityEntry,
  } from './executionViewerToolActivity'
  import type {
    ExecutionAvailabilityLevel,
    ExecutionFieldAvailability,
    ExecutionRuntimeDetails,
    ExecutionConfidenceLevel,
    ExecutionLlmCall,
    ExecutionReasoningPersistence,
    ExecutionTokenStat,
    ExecutionTokenUsage,
    ExecutionSnapshot
  } from '$lib/types/executionViewer'

  let {
    open = $bindable(false),
    sessionId
  } = $props<{
    open?: boolean
    sessionId?: string | null
  }>()

  let loading = $state(false)
  let error = $state<string | null>(null)
  let snapshots = $state<ExecutionSnapshot[]>([])
  let selectedId = $state<string | null>(null)
  let truncateBase64 = $state(true)

  const currentSnapshot = $derived(
    (() => {
      if (snapshots.length === 0) return null
      if (selectedId) {
        const match = snapshots.find((entry) => entry.id === selectedId)
        if (match) return match
      }
      return snapshots[0]
    })()
  ) as ExecutionSnapshot | null

  const formattedOptions = $derived(
    (() => {
      return snapshots.map((entry, index) => ({
        id: entry.id,
        label: `${formatTimestamp(entry.createdAt)} • ${entry.agentName || 'Agent'}${
          entry.executionMetadata?.groupChat ? ' • Group Chat' : ''
        }${index === 0 ? ' (latest)' : ''}`
      }))
    })()
  ) as Array<{ id: string; label: string }>

  // SA-104 P4: inserted-memory visibility (structuredInput.metadata.memoryContext,
  // written by the compilation path for memory-enabled agents).
  const memoryContextMeta = $derived.by<Record<string, any> | null>(() => {
    const meta = (currentSnapshot?.structuredInput as Record<string, any> | undefined)?.metadata
      ?.memoryContext
    return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : null
  })

  const groupMeta = $derived.by<Record<string, any> | null>(() => {
    const meta = currentSnapshot?.executionMetadata?.groupChat
    return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : null
  })

  const formatGroupTurnId = (id?: string | null) => {
    if (!id || typeof id !== 'string') return null
    return id.length > 10 ? `${id.slice(0, 8)}…` : id
  }

  const formatSpeakPolicy = (policy?: string | null) => {
    if (!policy || typeof policy !== 'string') return null
    return policy.replace(/_/g, ' ')
  }

  type ExecutionViewerModeKind = 'vercel' | 'codex' | 'claude' | 'unknown'
  type UsageDetailEntry = {
    key: string
    label: string
    stat: ExecutionTokenStat | null
    unavailableText: string
  }

  const runtimeDetails = $derived.by<ExecutionRuntimeDetails | null>(
    () => currentSnapshot?.runtime ?? null
  )
  const modeKind = $derived.by<ExecutionViewerModeKind>(() => {
    const primaryAgentType = normalizePrimaryAgentType(undefined, currentSnapshot?.agentType)
    if (runtimeDetails?.runtimeId === 'codex') return 'codex'
    if (runtimeDetails?.runtimeId === 'claude') return 'claude'
    if (primaryAgentType === 'api') return 'vercel'
    return 'unknown'
  })
  const runtimeMetadata = $derived.by<Record<string, any> | null>(() => {
    const metadata = runtimeDetails?.metadata
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : null
  })
  const runtimeMode4Style = $derived.by<string | null>(() => {
    const value = runtimeMetadata?.mode4Style
    return typeof value === 'string' && value.trim().length > 0 ? value : null
  })
  const runtimeMode4MemoryOwner = $derived.by<string | null>(() => {
    const value = runtimeMetadata?.mode4MemoryOwner
    return typeof value === 'string' && value.trim().length > 0 ? value : null
  })
  const runtimeProviderSession = $derived.by<Record<string, any> | null>(() => {
    const value = runtimeMetadata?.providerSession
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  })
  const runtimeProviderSessionConfigScope = $derived.by<string | null>(() => {
    const value = runtimeProviderSession?.configScope
    return typeof value === 'string' && value.trim().length > 0 ? value : null
  })
  const runtimeProviderSessionHistoryPersistence = $derived.by<string | null>(() => {
    const value = runtimeProviderSession?.historyPersistence
    return typeof value === 'string' && value.trim().length > 0 ? value : null
  })
  const runtimeProviderSessionId = $derived.by<string | null>(() => {
    const value = runtimeProviderSession?.sessionId
    return typeof value === 'string' && value.trim().length > 0 ? value : null
  })
  const hasRuntimeMode4Details = $derived.by<boolean>(
    () =>
      Boolean(runtimeMode4Style) ||
      Boolean(runtimeMode4MemoryOwner) ||
      Boolean(runtimeProviderSessionConfigScope) ||
      Boolean(runtimeProviderSessionHistoryPersistence) ||
      Boolean(runtimeProviderSessionId)
  )

  const llmSummary = $derived(currentSnapshot?.llmSummary ?? null)
  const snapshotLlmCalls = $derived(currentSnapshot?.llmCalls ?? null)
  const snapshotIntermediateSteps = $derived(
    Array.isArray(currentSnapshot?.intermediateSteps) ? currentSnapshot?.intermediateSteps : null,
  )
  const responseSummary = $derived(currentSnapshot?.responseSummary ?? null)
  const delegated = $derived(currentSnapshot?.delegated ?? null)
  const reasoningPersistence = $derived(currentSnapshot?.reasoningPersistence ?? null)
  // SA-106: webhook input was an n8n-Primary-only snapshot surface. Old stored
  // snapshots may still carry an explicit availability record, so it is still read;
  // nothing produces a new one.
  const webhookInputAvailability = $derived.by<ExecutionFieldAvailability | null>(() => {
    const explicit = currentSnapshot?.webhookInputAvailability
    return explicit && typeof explicit === 'object' ? explicit : null
  })

  let selectedCallIndex = $state<number | null>(null)
  let selectedToolActivityIndex = $state<number | null>(null)

	  const rawSnapshotRequest = $derived.by(() => {
	    const snapshot = currentSnapshot
	    if (!snapshot) return null

	    const {
	      llmSummary: _llmSummary,
	      llmCalls: _llmCalls,
	      intermediateSteps: _intermediateSteps,
	      responseSummary: _responseSummary,
	      delegated: _delegated,
	      runtime: runtimeRaw,
	      ...rest
	    } = snapshot

	    const runtime =
	      runtimeRaw && typeof runtimeRaw === 'object' && !Array.isArray(runtimeRaw)
	        ? { ...runtimeRaw, eventLog: undefined }
	        : runtimeRaw

	    return {
	      ...rest,
	      ...(runtime ? { runtime } : {})
	    }
	  })

	  const rawProviderResponses = $derived.by(() => {
	    const calls = Array.isArray(currentSnapshot?.llmCalls) ? currentSnapshot!.llmCalls : null
	    if (!calls) return null

	    const entries = calls
	      .map((call) => {
	        const raw = (call as any)?.rawResponsePayload
	        if (!raw) return null
	        return { call: call.index, response: raw }
	      })
	      .filter((entry): entry is { call: number; response: any } => Boolean(entry))

	    return entries.length > 0 ? entries : null
	  })

	  const compiledMessagesForDisplay = $derived.by<any[]>(() => {
	    const raw = currentSnapshot?.compiledMessages
	    if (!Array.isArray(raw)) return []

	    return raw.filter((msg) => {
	      const roleRaw = msg?.role
	      const role = typeof roleRaw === 'string' ? roleRaw.toLowerCase() : ''
	      return role !== 'system' && role !== 'developer'
	    })
	  })


		  const userSettings = $derived(getUserSettings())

	  function emptyTokenUsage(
	    confidence: ExecutionConfidenceLevel,
	    source?: string
	  ): ExecutionTokenUsage {
	    const tokenStat = (value: number | null): ExecutionTokenStat => ({
	      value,
	      confidence,
	      ...(source ? { source } : {})
	    })

	    return {
	      inputTokens: tokenStat(null),
	      outputTokens: tokenStat(null),
	      totalTokens: tokenStat(null)
	    }
	  }

	  function formatCompiledMessagesPlainText(messages: any[]): string {
	    const roleLabel = (role: unknown, msg: any): string => {
	      const normalized = typeof role === 'string' ? role.toLowerCase() : ''
	      if (normalized === 'user') return 'User'
	      if (normalized === 'assistant') return 'Assistant'
	      if (normalized === 'tool') {
	        const toolName =
	          (typeof msg?.name === 'string' ? msg.name : null) ||
	          (typeof msg?.toolName === 'string' ? msg.toolName : null) ||
	          null
	        return toolName ? `Tool (${toolName})` : 'Tool'
	      }

	      if (typeof role === 'string' && role.trim().length > 0) {
	        return role.trim().replace(/^\w/, (ch) => ch.toUpperCase())
	      }

	      return 'Message'
	    }

	    const partToText = (part: any): string => {
	      if (part == null) return ''
	      if (typeof part === 'string') return part
	      if (typeof part === 'number' || typeof part === 'boolean') return String(part)

	      if (typeof part === 'object') {
	        const text =
	          typeof part.text === 'string'
	            ? part.text
	            : typeof part.content === 'string'
	              ? part.content
	              : null
	        if (text !== null) return text

	        const imageUrl =
	          part?.image_url?.url ?? part?.image_url ?? part?.image ?? part?.url ?? null
	        if (typeof imageUrl === 'string' && imageUrl.trim().length > 0) {
	          return `[image: ${imageUrl}]`
	        }

	        if (typeof part.type === 'string' && part.type.trim().length > 0) {
	          return `[${part.type}]`
	        }

	        try {
	          return JSON.stringify(part, null, 2)
	        } catch {
	          return String(part)
	        }
	      }

	      return String(part)
	    }

	    const contentToText = (content: any): string => {
	      if (content == null) return ''
	      if (typeof content === 'string') return content
	      if (Array.isArray(content)) {
	        return content
	          .map(partToText)
	          .filter((entry) => entry.trim().length > 0)
	          .join('')
	      }

	      return partToText(content)
	    }

	    const blocks = (Array.isArray(messages) ? messages : [])
	      .map((msg) => {
	        const label = roleLabel(msg?.role, msg)
	        const body = contentToText(msg?.content)
	        return `${label}:\n${body}`.trimEnd()
	      })
	      .filter((block) => block.trim().length > 0)

	    return blocks.join('\n\n')
	  }

	  const compiledMessagesPlainText = $derived.by(() =>
	    formatCompiledMessagesPlainText(compiledMessagesForDisplay)
	  )

	  const toolActivityEntries = $derived.by<ExecutionToolActivityEntry[]>(() =>
	    buildExecutionToolActivityEntries({
        steps: snapshotIntermediateSteps,
        llmCalls: snapshotLlmCalls,
      })
	  )

	  const toolCallsCountFromSummary = $derived.by<number | null>(() => {
	    const value = responseSummary?.toolCallsCount?.value
	    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null
	  })

	  const toolActivityUnavailableNote = $derived.by<string | null>(() => {
	    if (toolActivityEntries.length > 0) return null

	    if (typeof toolCallsCountFromSummary === 'number' && toolCallsCountFromSummary > 0) {
	      return `This run reported ${toolCallsCountFromSummary} tool call${
	        toolCallsCountFromSummary === 1 ? '' : 's'
	      }, but no per-tool payloads were captured for the viewer.`
	    }

	    return null
	  })

		  // SA-106: the n8n synthesis branch is gone. n8n Primary runs executed inside n8n,
		  // so the viewer reconstructed per-call rows from execution data; API and CLI runs
		  // capture real per-call payloads, so the stored calls are used as-is.
		  const effectiveLlmCalls = $derived.by<ExecutionLlmCall[] | null>(() => {
	    const calls = Array.isArray(snapshotLlmCalls) ? snapshotLlmCalls : null
	    return calls && calls.length > 0 ? calls : null
	  })

	  const selectedCall = $derived.by(() => {
	    if (!Array.isArray(effectiveLlmCalls) || selectedCallIndex === null) return null
	    return effectiveLlmCalls.find((call) => call.index === selectedCallIndex) ?? null
	  })

	  const selectedToolActivity = $derived.by(() => {
	    if (!Array.isArray(toolActivityEntries) || selectedToolActivityIndex === null) return null
	    return toolActivityEntries.find((entry) => entry.index === selectedToolActivityIndex) ?? null
	  })

	  $effect(() => {
	    if (!currentSnapshot) {
	      selectedCallIndex = null
	      selectedToolActivityIndex = null
	      return
	    }

	    if (Array.isArray(effectiveLlmCalls) && effectiveLlmCalls.length > 0) {
	      if (
	        selectedCallIndex === null ||
	        !effectiveLlmCalls.some((call) => call.index === selectedCallIndex)
	      ) {
	        selectedCallIndex = effectiveLlmCalls[0].index
	      }
	    } else {
	      selectedCallIndex = null
	    }

	    if (toolActivityEntries.length > 0) {
	      if (
	        selectedToolActivityIndex === null ||
	        !toolActivityEntries.some((entry) => entry.index === selectedToolActivityIndex)
	      ) {
	        selectedToolActivityIndex = toolActivityEntries[0].index
	      }
	    } else {
	      selectedToolActivityIndex = null
	    }
	  })

  function confidenceLabel(level: ExecutionConfidenceLevel): string {
    switch (level) {
      case 'exact':
        return 'Exact'
      case 'near':
        return 'Near'
      case 'estimated':
        return 'Estimated'
      case 'speculative':
        return 'Speculative'
      default:
        return 'Unknown'
    }
  }

  function confidenceClasses(level: ExecutionConfidenceLevel): string {
    switch (level) {
      case 'exact':
        return 'execution-viewer-confidence-exact'
      case 'near':
        return 'execution-viewer-confidence-near'
      case 'estimated':
        return 'execution-viewer-confidence-estimated'
      case 'speculative':
        return 'execution-viewer-confidence-speculative'
      default:
        return 'execution-viewer-confidence-muted'
    }
  }

  function availabilityLabel(level: ExecutionAvailabilityLevel): string {
    if (level === 'unavailable') return 'Unavailable'
    if (level === 'not-applicable') return 'Not applicable'
    return confidenceLabel(level)
  }

  function availabilityClasses(level: ExecutionAvailabilityLevel): string {
    if (level === 'unavailable' || level === 'not-applicable') {
      return 'execution-viewer-confidence-muted'
    }
    return confidenceClasses(level)
  }

  function llmCoverageSummary(kind: ExecutionViewerModeKind): string {
    switch (kind) {
      case 'vercel':
        return 'API-agent runs capture the strongest per-call truth surface: exact provider request/response metadata when the SDK exposes it, with explicit near labels when Batshit has to backfill totals from raw stream chunks.'
      case 'codex':
        return 'Codex CLI runs expose reliable overall usage totals and runtime metadata, but the CLI does not expose the raw on-wire provider response payload or an exact per-step provider-call breakdown. Use Tool Activity below for the per-tool payload trail.'
      case 'claude':
        return 'Claude CLI runs expose reliable overall usage totals and runtime metadata, but the CLI does not expose the raw on-wire provider response payload or an exact per-step provider-call breakdown. Use Tool Activity below for the per-tool payload trail. When Claude prompt caching is active, Input/Total include fresh input plus cache-read and cache-creation tokens.'
      default:
        return 'Execution Viewer shows the best truth Batshit captured for this run, with explicit confidence labels where the runtime did not expose exact data.'
    }
  }

  function llmCallUnavailableMessage(kind: ExecutionViewerModeKind): string {
    switch (kind) {
      case 'codex':
        return 'Per-call billed payload details are unavailable because Codex CLI did not expose a reconstructable provider-call breakdown for this run.'
      case 'claude':
        return 'Per-call billed payload details are unavailable because Claude Code CLI did not expose a reconstructable provider-call breakdown for this run.'
      case 'vercel':
        return 'Per-call billed payload details were not captured for this API-agent run.'
      default:
        return 'Per-call billed payload details are unavailable for this run.'
    }
  }

  function runtimeSectionNote(kind: ExecutionViewerModeKind): string {
    switch (kind) {
      case 'vercel':
        return 'API-agent runs use the Vercel AI SDK. Provider/model metadata is captured directly, while shell-style runtime fields only appear when the runtime actually exposes them.'
      case 'codex':
        return 'Codex CLI runtime metadata comes from Batshit plus the Codex bridge. Missing fields below mean the CLI did not expose them for this run.'
      case 'claude':
        return 'Claude CLI runtime metadata comes from Batshit plus the Claude bridge. Missing fields below mean the CLI did not expose them for this run.'
      default:
        return 'Runtime metadata is shown when Batshit or the underlying runtime exposed it for this run.'
    }
  }

  function runtimeUnavailableMessage(kind: ExecutionViewerModeKind): string {
    switch (kind) {
      case 'vercel':
        return 'This API-agent run did not record runtime metadata.'
      case 'codex':
        return 'This Codex run did not record runtime metadata.'
      case 'claude':
        return 'This Claude run did not record runtime metadata.'
      default:
        return 'Runtime metadata is unavailable for this run.'
    }
  }

  function rawProviderResponsesUnavailableMessage(kind: ExecutionViewerModeKind): string {
    switch (kind) {
      case 'codex':
        return 'Codex CLI does not expose raw provider response objects for this run.'
      case 'claude':
        return 'Claude Code CLI does not expose raw provider response objects for this run.'
      case 'vercel':
        return 'The provider did not return raw response objects for this run.'
      default:
        return 'Raw provider response objects are unavailable for this run.'
    }
  }

  function unavailableForUsageDetail(
    kind: ExecutionViewerModeKind,
    detail: 'cachedInputTokens' | 'cacheCreationInputTokens' | 'reasoningTokens'
  ): string {
    if (kind === 'codex' || kind === 'claude') {
      return 'Not reported by the CLI for this run.'
    }
    if (detail === 'cachedInputTokens') {
      return 'Provider did not report cache-read tokens for this run.'
    }
    if (detail === 'cacheCreationInputTokens') {
      return 'Provider did not report cache-creation tokens for this run.'
    }
    return 'Provider did not report reasoning tokens for this run.'
  }

  function usageDetailEntries(
    usage: ExecutionTokenUsage | null | undefined,
    kind: ExecutionViewerModeKind
  ): UsageDetailEntry[] {
    return [
      {
        key: 'inputTokens',
        label: 'Input',
        stat: usage?.inputTokens ?? null,
        unavailableText: 'No input-token total captured for this run.'
      },
      {
        key: 'outputTokens',
        label: 'Output',
        stat: usage?.outputTokens ?? null,
        unavailableText: 'No output-token total captured for this run.'
      },
      {
        key: 'totalTokens',
        label: 'Total',
        stat: usage?.totalTokens ?? null,
        unavailableText: 'No total-token value captured for this run.'
      },
      {
        key: 'cachedInputTokens',
        label: 'Cached input',
        stat: usage?.cachedInputTokens ?? null,
        unavailableText: unavailableForUsageDetail(kind, 'cachedInputTokens')
      },
      {
        key: 'cacheCreationInputTokens',
        label: 'Cache creation',
        stat: usage?.cacheCreationInputTokens ?? null,
        unavailableText: unavailableForUsageDetail(kind, 'cacheCreationInputTokens')
      },
      {
        key: 'reasoningTokens',
        label: 'Reasoning',
        stat: usage?.reasoningTokens ?? null,
        unavailableText: unavailableForUsageDetail(kind, 'reasoningTokens')
      }
    ]
  }

  function formatOptionalValue(
    value: string | null | undefined,
    unavailableText: string
  ): string {
    return typeof value === 'string' && value.trim().length > 0 ? value : unavailableText
  }

  function formatRuntimeCapability(
    value: boolean | undefined,
    unavailableText: string
  ): string {
    if (value === true) return 'Allowed'
    if (value === false) return 'Blocked'
    return unavailableText
  }

  function runtimeFieldUnavailable(
    kind: ExecutionViewerModeKind,
    field:
      | 'transport'
      | 'sandbox'
      | 'fileEdits'
      | 'network'
      | 'workingDirectory'
      | 'providerSession'
      | 'runtimeEvents'
  ): string {
    switch (field) {
      case 'transport':
        return 'Not reported by the runtime.'
      case 'sandbox':
        if (kind === 'vercel') return 'Not applicable to Vercel SDK runs.'
        return 'Not reported by the CLI runtime.'
      case 'fileEdits':
      case 'network':
        if (kind === 'vercel') return 'Not applicable to Vercel SDK runs.'
        return 'Not reported by the CLI runtime.'
      case 'workingDirectory':
        if (kind === 'vercel') return 'Not used by Vercel SDK runs.'
        return 'Not reported by the CLI runtime.'
      case 'providerSession':
        if (kind === 'vercel') return 'Vercel SDK runs do not use a provider CLI session.'
        return 'Provider session details were not reported for this run.'
      case 'runtimeEvents':
        return 'No runtime event log was captured for this run.'
      default:
        return 'Unavailable for this run.'
    }
  }

  function formatSandbox(mode?: string | null): string | null {
    switch (mode) {
      case 'danger-full-access':
        return 'Danger · Full access'
      case 'workspace-write':
        return 'Workspace write'
      case 'read-only':
        return 'Read-only'
      default:
        return null
    }
  }

  function formatRuntimeEventsSummary(
    details: ExecutionRuntimeDetails | null,
    kind: ExecutionViewerModeKind
  ): string {
    const eventCount =
      typeof details?.eventCount === 'number'
        ? details.eventCount
        : Array.isArray(details?.eventLog)
          ? details.eventLog.length
          : null

    if (typeof eventCount === 'number' && eventCount > 0) {
      return `${eventCount.toLocaleString()} captured`
    }

    return runtimeFieldUnavailable(kind, 'runtimeEvents')
  }

  function formatTokenValue(value: number | null): string {
    if (typeof value !== 'number') return '—'
    return value.toLocaleString()
  }

  function toolActivityStatusClasses(status: ExecutionToolActivityEntry['status']): string {
    if (status === 'error') {
      return 'execution-viewer-tool-status-error'
    }
    if (status === 'partial') {
      return 'execution-viewer-tool-status-partial'
    }
    return 'execution-viewer-tool-status-success'
  }

  function toolActivityStatusLabel(status: ExecutionToolActivityEntry['status']): string {
    if (status === 'error') return 'Error'
    if (status === 'partial') return 'Partial'
    return 'Success'
  }

  function formatDuration(value: number | null | undefined): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
    if (value < 1000) return `${Math.max(0, Math.trunc(value))} ms`
    return `${(value / 1000).toFixed(1)} s`
  }

  function delegatedTokenTotal(usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null): number | null {
    if (typeof usage?.totalTokens === 'number') return usage.totalTokens
    if (
      typeof usage?.inputTokens === 'number' &&
      typeof usage?.outputTokens === 'number'
    ) {
      return usage.inputTokens + usage.outputTokens
    }
    return null
  }

  function delegatedStatusLabel(status: 'completed' | 'failed' | 'timed_out'): string {
    if (status === 'timed_out') return 'Timed out'
    if (status === 'failed') return 'Failed'
    return 'Completed'
  }

  function delegatedStatusClasses(status: 'completed' | 'failed' | 'timed_out'): string {
    return status === 'completed'
      ? 'execution-viewer-tool-status-success'
      : 'execution-viewer-tool-status-error'
  }

  function tokenBadgeText(label: string, stat: ExecutionTokenStat): string {
    return `${label}: ${formatTokenValue(stat.value)}`
  }

  function hasAnyToken(usage: ExecutionTokenUsage | null | undefined): boolean {
    return Boolean(
      usage &&
        (typeof usage.inputTokens?.value === 'number' ||
          typeof usage.outputTokens?.value === 'number' ||
          typeof usage.totalTokens?.value === 'number')
    )
  }

  function displayViewerText(value: string): string {
    return truncateExecutionViewerBase64(value, { enabled: truncateBase64 })
  }

  function displayViewerData<T>(value: T): T {
    return truncateExecutionViewerBase64InValue(value, { enabled: truncateBase64 })
  }

	  function formatRuntimeName(runtime: ExecutionRuntimeDetails): string {
	    // SA-106: `n8n` left ExecutionRuntimeId, but snapshots recorded before the
	    // retirement are still valid stored data. Label them honestly rather than
	    // letting them fall through and claim to be a Vercel run.
	    if ((runtime.runtimeId as string) === 'n8n') {
	      return 'n8n Workflow (retired)'
	    }
	    if (runtime.runtimeId === 'codex') {
	      return 'Codex CLI (GPT Plus/Pro)'
	    }
	    if (runtime.runtimeId === 'claude') {
	      return 'Claude Code CLI (Pro/Max)'
	    }
    return 'Vercel AI SDK'
  }

	  function formatTransport(runtime: ExecutionRuntimeDetails): string | null {
	    switch (runtime.transport) {
	      case 'codex-sdk':
	        return 'SDK'
	      case 'codex-cli':
	        return 'CLI'
	      case 'codex-app-server':
	        return 'App-server'
	      case 'codex-exec':
	        return 'Exec'
	      case 'claude-sdk':
	        return 'SDK'
	      case 'claude-cli':
	        return 'CLI'
	      case 'vercel-sdk':
	        return 'SDK'
	      default:
	        return null
	    }
	  }

  function formatMode4Style(style?: string | null): string {
    switch (style) {
      case 'cr':
        return 'Batshit managed'
      case 'cli':
        return 'Provider-native CLI'
      default:
        return style ?? 'Unknown'
    }
  }

  function formatMode4MemoryOwner(memoryOwner?: string | null): string {
    switch (memoryOwner) {
      case 'batshit':
        return 'Batshit'
      case 'provider':
        return 'Provider CLI'
      default:
        return memoryOwner ?? 'Unknown'
    }
  }

  async function loadSnapshots(options: { defaultToLatest?: boolean } = {}) {
    const { defaultToLatest = false } = options

    if (!sessionId) {
      snapshots = []
      selectedId = null
      return
    }

    loading = true
    error = null

    try {
      const response = await fetch(`/api/sessions/${sessionId}/execution-log`)
      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: 'Failed to load execution log' }))
        throw new Error(data.error || 'Failed to load execution log')
      }

      const data = await response.json()
      const entries: ExecutionSnapshot[] = Array.isArray(data.entries) ? data.entries : []
      snapshots = entries

      if (entries.length > 0) {
        const latestId = entries[0].id
        if (defaultToLatest) {
          selectedId = latestId
        } else if (!selectedId || !entries.some((entry) => entry.id === selectedId)) {
          selectedId = latestId
        }
      } else {
        selectedId = null
      }
    } catch (err: any) {
      error = err?.message || 'Failed to load execution data'
    } finally {
      loading = false
    }
  }

  async function refresh() {
    await loadSnapshots()
  }

  async function clearSnapshots() {
    if (!sessionId) return

    try {
      const response = await fetch(`/api/sessions/${sessionId}/execution-log`, {
        method: 'DELETE'
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: 'Failed to clear execution log' }))
        throw new Error(data.error || 'Failed to clear execution log')
      }

      await loadSnapshots({ defaultToLatest: true })
    } catch (err: any) {
      error = err?.message || 'Failed to clear execution data'
    }
  }

  function formatTimestamp(timestamp: string): string {
    const date = new Date(timestamp)
    if (Number.isNaN(date.getTime())) return timestamp
    return date.toLocaleString()
  }

  function formatRelative(timestamp: string): string {
    const date = new Date(timestamp)
    if (Number.isNaN(date.getTime())) return timestamp
    return date.toLocaleTimeString()
  }

  function handleSelectionChange(event: Event) {
    const target = event.currentTarget as HTMLSelectElement
    selectedId = target.value
  }

  const selectId = 'execution-viewer-run'

  let openOverview = $state(true)
  let openRuntime = $state(true)
  let openLlmCalls = $state(true)
  let openWebhookInput = $state(false)
  let openPrimaryPrompt = $state(false)
  let openMemoryContext = $state(false)
  let openCompiledMessages = $state(false)
  let openResponse = $state(false)
  let openDelegated = $state(true)
  let openRawEvents = $state(false)
  let openRawSnapshotRequest = $state(false)
  let openRawProviderResponses = $state(false)

  let wasOpen = $state(false)

  $effect(() => {
    if (open && !wasOpen) {
      wasOpen = true
      loadSnapshots({ defaultToLatest: true })
    } else if (!open && wasOpen) {
      wasOpen = false
    }
  })

  const reasoningPersistenceText = (value: ExecutionReasoningPersistence) => {
    const recoveryText =
      value.recoveryStatus === 'pending'
        ? ` Batshit captured ${Math.max(0, value.recoveryCharacterCount ?? 0).toLocaleString()} characters of unfinished reasoning/plan for interruption recovery. The same agent receives that exact block on its next request regardless of Display or Preserve, and it expires after that agent completes a successful turn.`
        : ''
    if (value.userHistoryStatus === 'saved') {
      const agentHistoryText =
        value.agentHistoryStatus === 'included'
          ? 'Preserve Reasoning was on for this run. If it remains on, later Compiled Messages for this agent include the saved reasoning.'
          : 'Preserve Reasoning was off, so it stays out of later Compiled Messages.'
      return `Reasoning: Saved for chat display (${value.characterCount.toLocaleString()} characters) and survives refresh. ${agentHistoryText}${recoveryText}`
    }
    if (value.userHistoryStatus === 'not-emitted') {
      return `Reasoning: Display Reasoning was on, but this model emitted no visible reasoning summary.${recoveryText}`
    }
    return `Reasoning: Display Reasoning was off, so no reasoning summary was shown or saved in the visible chat.${recoveryText}`
  }
</script>

<Sheet.Root bind:open>
  <Sheet.Content side="right" class="execution-viewer-sheet">
    <Sheet.Header class="execution-viewer-header">
      <Sheet.Title class="execution-viewer-title">Execution Viewer</Sheet.Title>
      <Sheet.Description class="execution-viewer-muted-copy">
        Inspect the compiled system prompt, structured payload, and metadata sent to the agent for the most recent requests.
      </Sheet.Description>
    </Sheet.Header>

    <div class="execution-viewer-body">
      {#if loading && snapshots.length === 0}
        <div class="execution-viewer-loading">
          Loading execution data...
        </div>
      {:else if error}
        <div class="execution-viewer-error">
          {error}
        </div>
      {:else if snapshots.length === 0}
        <div class="execution-viewer-empty">
          Execution data will appear after you send a message to this agent during the current session.
        </div>
      {:else if currentSnapshot}
        <div class="execution-viewer-run-row">
          <label class="execution-viewer-eyebrow" for={selectId}>Run</label>
          <select
            id={selectId}
            class="execution-viewer-run-select"
            bind:value={selectedId}
            onchange={handleSelectionChange}
          >
            {#each formattedOptions as option}
              <option value={option.id}>{option.label}</option>
            {/each}
          </select>
          <span class="execution-viewer-helper">{formatRelative(currentSnapshot.createdAt)}</span>
          <div class="execution-viewer-base64-toggle">
            <Switch.Root
              id="execution-viewer-truncate-base64"
              checked={truncateBase64}
              onCheckedChange={(checked) => (truncateBase64 = checked === true)}
            />
            <label
              class="execution-viewer-base64-toggle-label"
              for="execution-viewer-truncate-base64"
            >
              Truncate base64
            </label>
          </div>
          <div class="execution-viewer-flex-spacer"></div>
          <Button variant="outline" size="sm" onclick={refresh} disabled={loading}>
            Refresh
          </Button>
          <Button variant="ghost" size="sm" onclick={clearSnapshots} disabled={loading}>
            Clear Log
          </Button>
        </div>

        <Collapsible.Root bind:open={openOverview}>
          <Collapsible.Trigger class="execution-viewer-section-trigger">
            <div class="execution-viewer-section-label">
              <span class="execution-viewer-section-heading">Overview</span>
              <span class="execution-viewer-helper">High-level request metadata</span>
            </div>
            <ChevronDown class="execution-viewer-section-chevron" data-open={openOverview} />
          </Collapsible.Trigger>
          <Collapsible.Content class="execution-viewer-section-content">
            <div class="execution-viewer-card execution-viewer-stack-md">
              <div class="execution-viewer-grid-2">
                <div class="execution-viewer-stack-xs">
                  <div class="execution-viewer-eyebrow">Agent</div>
                  <div class="execution-viewer-value-row">
                    {currentSnapshot.agentName}
                    {#if currentSnapshot.agentType}
                      <Badge variant="outline" class="execution-viewer-confidence-badge execution-viewer-confidence-muted">
                        {currentSnapshot.agentType}
                      </Badge>
                    {/if}
                  </div>
                </div>
                <div class="execution-viewer-stack-xs">
                  <div class="execution-viewer-eyebrow">Captured</div>
                  <div class="execution-viewer-value">{formatTimestamp(currentSnapshot.createdAt)}</div>
                </div>
              </div>

              {#if currentSnapshot.userMessage}
                <div class="execution-viewer-stack-xs">
                  <div class="execution-viewer-eyebrow">User message</div>
                  <div class="execution-viewer-message-preview">
                    {displayViewerText(currentSnapshot.userMessage)}
                  </div>
                </div>
              {/if}

              {#if groupMeta}
                <div class="execution-viewer-stack-xs">
                  <div class="execution-viewer-eyebrow">Group chat</div>
                  <div class="execution-viewer-wrap-row">
                    {#if typeof groupMeta.eventIndex === 'number'}
                      <Badge variant="secondary">Event {groupMeta.eventIndex}</Badge>
                    {/if}
                    {#if formatGroupTurnId(groupMeta.groupTurnId)}
                      <Badge variant="outline">Turn {formatGroupTurnId(groupMeta.groupTurnId)}</Badge>
                    {/if}
                    {#if formatSpeakPolicy(groupMeta.speakPolicy)}
                      <Badge variant="outline">{formatSpeakPolicy(groupMeta.speakPolicy)}</Badge>
                    {/if}
                    {#if groupMeta.groupLayout}
                      <Badge variant="outline">{groupMeta.groupLayout}</Badge>
                    {/if}
                  </div>
                  {#if Array.isArray(groupMeta.speakTopics) && groupMeta.speakTopics.length > 0}
                    <div class="execution-viewer-helper">
                      Topics: {groupMeta.speakTopics.join(', ')}
                    </div>
                  {/if}
                </div>
              {/if}

              <div class="execution-viewer-grid-2">
                <div class="execution-viewer-stack-xs">
                  <div class="execution-viewer-eyebrow">Selected gateways</div>
                  {#if currentSnapshot.selectedGateways && currentSnapshot.selectedGateways.length > 0}
                    <div class="execution-viewer-wrap-row">
                      {#each currentSnapshot.selectedGateways as gateway}
                        <Badge variant="outline">{gateway}</Badge>
                      {/each}
                    </div>
                  {:else}
                    <div class="execution-viewer-muted-copy">Agent defaults</div>
                  {/if}
                </div>
                <div class="execution-viewer-stack-xs">
                  <div class="execution-viewer-eyebrow">Selected tools</div>
                  {#if currentSnapshot.selectedTools && currentSnapshot.selectedTools.length > 0}
                    <div class="execution-viewer-wrap-row">
                      {#each currentSnapshot.selectedTools as tool}
                        <Badge variant="outline">{tool}</Badge>
                      {/each}
                    </div>
                  {:else}
                    <div class="execution-viewer-muted-copy">No explicit per-tool filters</div>
                  {/if}
                </div>
              </div>
            </div>
          </Collapsible.Content>
        </Collapsible.Root>

        <Collapsible.Root bind:open={openRuntime}>
          <Collapsible.Trigger class="execution-viewer-section-trigger">
            <div class="execution-viewer-section-label">
              <span class="execution-viewer-section-heading">Runtime</span>
              <span class="execution-viewer-helper">Provider + execution metadata for this run</span>
            </div>
            <ChevronDown class="execution-viewer-section-chevron" data-open={openRuntime} />
          </Collapsible.Trigger>
          <Collapsible.Content class="execution-viewer-section-content">
            <div class="execution-viewer-card execution-viewer-stack-md">
              <div class="execution-viewer-note">
                {runtimeSectionNote(modeKind)}
              </div>

              {#if runtimeDetails}
                <div class="execution-viewer-grid-2">
                  <div class="execution-viewer-stack-xs">
                    <div class="execution-viewer-eyebrow">Runtime</div>
                    <div class="execution-viewer-wrap-row execution-viewer-text-sm">
                      <span class="execution-viewer-value">{formatRuntimeName(runtimeDetails)}</span>
                      <Badge variant="outline">
                        {formatOptionalValue(
                          formatTransport(runtimeDetails),
                          runtimeFieldUnavailable(modeKind, 'transport')
                        )}
                      </Badge>
                      {#if runtimeDetails.status}
                        <Badge
                          variant={runtimeDetails.status === 'failed' ? 'destructive' : 'secondary'}
                        >
                          {runtimeDetails.status}
                        </Badge>
                      {/if}
                    </div>
                  </div>
                  <div class="execution-viewer-stack-xs">
                    <div class="execution-viewer-eyebrow">Provider</div>
                    <div class="execution-viewer-text-sm">
                      {formatOptionalValue(runtimeDetails.providerId, 'Provider was not recorded.')}
                      {#if runtimeDetails.connectionId}
                        <span class="execution-viewer-muted"> · {runtimeDetails.connectionId}</span>
                      {/if}
                    </div>
                    <div class="execution-viewer-helper">
                      Model: {formatOptionalValue(runtimeDetails.modelName, 'Model was not recorded.')}
                    </div>
                  </div>
                </div>

	                <div class="execution-viewer-grid-2">
	                  <div class="execution-viewer-stack-xs">
	                    <div class="execution-viewer-eyebrow">CLI policy</div>
	                    {#if (modeKind === 'codex' || modeKind === 'claude') && hasRuntimeMode4Details}
	                      <div class="execution-viewer-wrap-row">
	                        {#if runtimeMode4Style}
	                          <Badge variant="outline">Style: {formatMode4Style(runtimeMode4Style)}</Badge>
	                        {/if}
                        {#if runtimeMode4MemoryOwner}
                          <Badge variant="outline">
                            Memory owner: {formatMode4MemoryOwner(runtimeMode4MemoryOwner)}
                          </Badge>
                        {/if}
                      </div>
                    {:else}
                      <div class="execution-viewer-muted-copy">
                        {modeKind === 'codex' || modeKind === 'claude'
                          ? 'CLI policy metadata was not reported for this run.'
                          : 'Not applicable to this mode.'}
                      </div>
                    {/if}
	                  </div>
	                  <div class="execution-viewer-stack-xs">
	                    <div class="execution-viewer-eyebrow">Provider session</div>
	                    {#if (modeKind === 'codex' || modeKind === 'claude') && hasRuntimeMode4Details}
	                      <div class="execution-viewer-provider-session">
	                        <div>
	                          Config scope:
	                          <code>{formatOptionalValue(runtimeProviderSessionConfigScope, 'Unavailable')}</code>
	                        </div>
	                        <div>
	                          History persistence:
	                          <code>{formatOptionalValue(runtimeProviderSessionHistoryPersistence, 'Unavailable')}</code>
	                        </div>
	                        <div>
	                          Session ID:
	                          <code class="execution-viewer-break-all">{formatOptionalValue(runtimeProviderSessionId, 'Unavailable')}</code>
	                        </div>
	                      </div>
	                    {:else}
	                      <div class="execution-viewer-muted-copy">
	                        {runtimeFieldUnavailable(modeKind, 'providerSession')}
	                      </div>
	                    {/if}
	                  </div>
	                </div>

                <div class="execution-viewer-grid-2">
                  <div class="execution-viewer-stack-xs">
                    <div class="execution-viewer-eyebrow">Sandbox</div>
                    <div class="execution-viewer-text-sm">
                      {formatOptionalValue(
                        formatSandbox(runtimeDetails.sandboxMode),
                        runtimeFieldUnavailable(modeKind, 'sandbox')
                      )}
                    </div>
                    <div class="execution-viewer-wrap-row execution-viewer-helper">
                      <span>
                        File edits:
                        {formatRuntimeCapability(
                          runtimeDetails.allowFileEdits,
                          runtimeFieldUnavailable(modeKind, 'fileEdits')
                        )}
                      </span>
                      <span>
                        Network:
                        {formatRuntimeCapability(
                          runtimeDetails.allowNetwork,
                          runtimeFieldUnavailable(modeKind, 'network')
                        )}
                      </span>
                    </div>
                  </div>
	                  <div class="execution-viewer-stack-xs">
	                    <div class="execution-viewer-eyebrow">Working directory</div>
	                    {#if runtimeDetails.workingDirectory}
	                      <code class="execution-viewer-code-block">
	                        {runtimeDetails.workingDirectory}
	                      </code>
	                    {:else}
	                      <div class="execution-viewer-muted-copy">
	                        {runtimeFieldUnavailable(modeKind, 'workingDirectory')}
	                      </div>
	                    {/if}
	                  </div>
                </div>

                <div class="execution-viewer-stack-xs">
                  <div class="execution-viewer-eyebrow">Runtime events</div>
                  <div class="execution-viewer-muted-copy">
                    {formatRuntimeEventsSummary(runtimeDetails, modeKind)}
                  </div>
                </div>

                {#if runtimeDetails.error}
                  <div class="execution-viewer-error execution-viewer-error-compact">
                    {runtimeDetails.error}
                  </div>
                {/if}
              {:else}
                <div class="execution-viewer-muted-copy">{runtimeUnavailableMessage(modeKind)}</div>
              {/if}
            </div>
          </Collapsible.Content>
        </Collapsible.Root>

        <div class="execution-viewer-stack-lg">
          <div class="execution-viewer-eyebrow">Billed Input/Output</div>

          <Collapsible.Root bind:open={openLlmCalls}>
            <Collapsible.Trigger class="execution-viewer-section-trigger execution-viewer-section-trigger-strong">
              <div class="execution-viewer-section-label">
                <div class="execution-viewer-inline-row">
	                  <span class="execution-viewer-section-heading">LLM Calls</span>
                  {#if llmSummary}
                    <Badge
                      variant="outline"
                      class={`execution-viewer-confidence-badge ${confidenceClasses(llmSummary.breakdownConfidence)}`}
                    >
                      {confidenceLabel(llmSummary.breakdownConfidence)}
                    </Badge>
                  {/if}
                </div>
                <span class="execution-viewer-helper">
                  Exact for API agents (Vercel). Best-effort for CLI agents.
                </span>
              </div>
              <div class="execution-viewer-inline-row">
                {#if llmSummary}
                  <Badge
                    variant="outline"
                    class={`execution-viewer-confidence-badge ${confidenceClasses(llmSummary.callsCount.confidence)}`}
                  >
                    Calls: {formatTokenValue(llmSummary.callsCount.value)}
                  </Badge>
                {/if}
                {#if llmSummary && hasAnyToken(llmSummary.totalUsage)}
                  <Badge
                    variant="outline"
                    class={`execution-viewer-confidence-badge ${confidenceClasses(llmSummary.totalUsage.inputTokens.confidence)}`}
                  >
                    {tokenBadgeText('Input', llmSummary.totalUsage.inputTokens)}
                  </Badge>
                  <Badge
                    variant="outline"
                    class={`execution-viewer-confidence-badge ${confidenceClasses(llmSummary.totalUsage.outputTokens.confidence)}`}
                  >
                    {tokenBadgeText('Output', llmSummary.totalUsage.outputTokens)}
                  </Badge>
                  <Badge
                    variant="outline"
                    class={`execution-viewer-confidence-badge ${confidenceClasses(llmSummary.totalUsage.totalTokens.confidence)}`}
                  >
                    {tokenBadgeText('Total', llmSummary.totalUsage.totalTokens)}
                  </Badge>
                {/if}
                <ChevronDown class="execution-viewer-section-chevron" data-open={openLlmCalls} />
              </div>
            </Collapsible.Trigger>
            <Collapsible.Content class="execution-viewer-section-content">
              <div class="execution-viewer-panel execution-viewer-stack-lg">
                <div class="execution-viewer-note execution-viewer-note-raised">
                  {llmCoverageSummary(modeKind)}
                </div>

                {#if llmSummary}
                  <div class="execution-viewer-stats-grid execution-viewer-stats-grid-six">
                    {#each usageDetailEntries(llmSummary.totalUsage, modeKind) as detail}
                      <div class="execution-viewer-stat-card">
                        <div class="execution-viewer-stat-label">
                          {detail.label}
                        </div>
                        {#if typeof detail.stat?.value === 'number'}
                          <div class="execution-viewer-stat-row">
                            <span class="execution-viewer-stat-value">{formatTokenValue(detail.stat.value)}</span>
                            <Badge
                              variant="outline"
                              class={`execution-viewer-confidence-badge ${confidenceClasses(detail.stat.confidence)}`}
                            >
                              {confidenceLabel(detail.stat.confidence)}
                            </Badge>
                          </div>
                        {:else}
                          <div class="execution-viewer-stat-unavailable">{detail.unavailableText}</div>
                        {/if}
                      </div>
                    {/each}
                  </div>
                {/if}

                {#if Array.isArray(effectiveLlmCalls) && effectiveLlmCalls.length > 0}
                  <div class="execution-viewer-table-wrap">
                    <table class="execution-viewer-table">
                      <thead class="execution-viewer-table-head">
                        <tr>
                          <th class="execution-viewer-table-heading">Call</th>
                          <th class="execution-viewer-table-heading">Input</th>
                          <th class="execution-viewer-table-heading">Output</th>
                          <th class="execution-viewer-table-heading">Tools</th>
                          <th class="execution-viewer-table-heading">Finish</th>
                        </tr>
                      </thead>
                      <tbody>
                        {#each effectiveLlmCalls as call}
                          <tr
                            class="execution-viewer-table-row" data-selected={selectedCallIndex === call.index}
                            onclick={() => (selectedCallIndex = call.index)}
                          >
                            <td class="execution-viewer-table-primary-cell">Call {call.index}</td>
                            <td class="execution-viewer-table-cell">
                              <Badge
                                variant="outline"
                                class={`execution-viewer-confidence-badge ${confidenceClasses(call.usage.inputTokens.confidence)}`}
                              >
                                {formatTokenValue(call.usage.inputTokens.value)}
                              </Badge>
                            </td>
                            <td class="execution-viewer-table-cell">
                              <Badge
                                variant="outline"
                                class={`execution-viewer-confidence-badge ${confidenceClasses(call.usage.outputTokens.confidence)}`}
                              >
                                {formatTokenValue(call.usage.outputTokens.value)}
                              </Badge>
                            </td>
                            <td class="execution-viewer-table-muted-cell">
                              {call.toolCallsCount ?? '—'}
                            </td>
                            <td class="execution-viewer-table-muted-cell">
                              {call.finishReason ?? '—'}
                            </td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  </div>

                  {#if selectedCall}
                    <div class="execution-viewer-stack-lg">
                      <div class="execution-viewer-card execution-viewer-stack-md">
                        <div class="execution-viewer-wrap-row">
                          <div class="execution-viewer-value">Call {selectedCall.index} Input (Billed)</div>
                          <Badge
                            variant="outline"
                            class={`execution-viewer-confidence-badge ${confidenceClasses(selectedCall.requestConfidence)}`}
                          >
                            Request: {confidenceLabel(selectedCall.requestConfidence)}
                          </Badge>
                        </div>

                        {#if selectedCall.notes?.length}
                          <div class="execution-viewer-stack-xs execution-viewer-helper">
                            {#each selectedCall.notes as note}
                              <div>• {note}</div>
                            {/each}
                          </div>
                        {/if}

                        <div class="execution-viewer-json-pane execution-viewer-json-pane-tall">
                          <JSONViewer data={displayViewerData(selectedCall.requestPayload)} />
                        </div>
                      </div>

                      <div class="execution-viewer-card execution-viewer-stack-sm">
                        <div class="execution-viewer-wrap-row">
                          <div class="execution-viewer-value">Call {selectedCall.index} Output (Billed)</div>
                          <Badge
                            variant="outline"
                            class={`execution-viewer-confidence-badge ${confidenceClasses(selectedCall.responseConfidence ?? 'speculative')}`}
                          >
                            Output: {confidenceLabel(selectedCall.responseConfidence ?? 'speculative')}
                          </Badge>
                        </div>
                        <div class="execution-viewer-json-pane">
                          <JSONViewer
                            data={displayViewerData(
                              selectedCall.responsePayload ?? {
                                note:
                                  'Billed output payload unavailable for this call. See Response → Final Output for what you see in chat.'
                              }
                            )}
                          />
                        </div>
                      </div>
                    </div>
                  {/if}

                  <div class="execution-viewer-stack-md">
                    <div class="execution-viewer-wrap-row">
                      <div class="execution-viewer-value">Tool Activity</div>
                      <Badge variant="outline" class="execution-viewer-confidence-badge execution-viewer-confidence-muted">
                        {toolActivityEntries.length > 0
                          ? `${toolActivityEntries.length} captured`
                          : toolCallsCountFromSummary
                            ? `${toolCallsCountFromSummary} reported`
                            : 'None reported'}
                      </Badge>
                      <Badge
                        variant="outline"
                        class={`execution-viewer-confidence-badge ${confidenceClasses('estimated')}`}
                      >
                        Tokens: Estimated
                      </Badge>
                    </div>

                    <div class="execution-viewer-helper">
                      Tool token counts below estimate the prompt-facing tool transcript Batshit sends back to the agent. They are not provider-billed LLM token counts.
                    </div>

                    {#if toolActivityEntries.length > 0}
                      <div class="execution-viewer-table-wrap">
                        <table class="execution-viewer-table">
                          <thead class="execution-viewer-table-head">
                            <tr>
                              <th class="execution-viewer-table-heading">Step</th>
                              <th class="execution-viewer-table-heading">Tool</th>
                              <th class="execution-viewer-table-heading">Prompt tokens</th>
                              <th class="execution-viewer-table-heading">Duration</th>
                              <th class="execution-viewer-table-heading">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {#each toolActivityEntries as entry}
                              <tr
                                class="execution-viewer-table-row" data-selected={selectedToolActivityIndex === entry.index}
                                onclick={() => (selectedToolActivityIndex = entry.index)}
                              >
                                <td class="execution-viewer-table-primary-cell">Tool {entry.index}</td>
                                <td class="execution-viewer-table-cell">
                                  <div class="execution-viewer-value">{entry.displayName}</div>
                                  {#if entry.displayName !== entry.rawToolName}
                                    <div class="execution-viewer-helper">{entry.rawToolName}</div>
                                  {/if}
                                </td>
                                <td class="execution-viewer-table-cell">
                                  <Badge
                                    variant="outline"
                                    class={`execution-viewer-confidence-badge ${confidenceClasses(entry.tokenConfidence)}`}
                                  >
                                    {formatTokenValue(entry.tokenEstimate)}
                                  </Badge>
                                </td>
                                <td class="execution-viewer-table-muted-cell">
                                  {formatDuration(entry.durationMs)}
                                </td>
                                <td class="execution-viewer-table-cell">
                                  <Badge
                                    variant="outline"
                                    class={`execution-viewer-confidence-badge ${toolActivityStatusClasses(entry.status)}`}
                                  >
                                    {toolActivityStatusLabel(entry.status)}
                                  </Badge>
                                </td>
                              </tr>
                            {/each}
                          </tbody>
                        </table>
                      </div>

                      {#if selectedToolActivity}
                        <div class="execution-viewer-stack-lg">
                          <div class="execution-viewer-card execution-viewer-stack-md">
                            <div class="execution-viewer-wrap-row">
                              <div class="execution-viewer-value">
                                Tool {selectedToolActivity.index} Input
                              </div>
                              <Badge
                                variant="outline"
                                class={`execution-viewer-confidence-badge ${confidenceClasses(selectedToolActivity.tokenConfidence)}`}
                              >
                                Prompt tokens: {formatTokenValue(selectedToolActivity.tokenEstimate)}
                              </Badge>
                              <Badge
                                variant="outline"
                                class={`execution-viewer-confidence-badge ${toolActivityStatusClasses(selectedToolActivity.status)}`}
                              >
                                {toolActivityStatusLabel(selectedToolActivity.status)}
                              </Badge>
                            </div>

                            {#if selectedToolActivity.notes.length > 0}
                              <div class="execution-viewer-stack-xs execution-viewer-helper">
                                {#each selectedToolActivity.notes as note}
                                  <div>• {note}</div>
                                {/each}
                              </div>
                            {/if}

                            <div class="execution-viewer-json-pane">
                              <JSONViewer data={displayViewerData(selectedToolActivity.input)} />
                            </div>
                          </div>

                          <div class="execution-viewer-card execution-viewer-stack-sm">
                            <div class="execution-viewer-wrap-row">
                              <div class="execution-viewer-value">
                                Tool {selectedToolActivity.index} Output
                              </div>
                              <Badge variant="outline" class="execution-viewer-confidence-badge execution-viewer-confidence-muted">
                                Duration: {formatDuration(selectedToolActivity.durationMs)}
                              </Badge>
                            </div>
                            <div class="execution-viewer-json-pane">
                              <JSONViewer data={displayViewerData(selectedToolActivity.output)} />
                            </div>
                          </div>
                        </div>
                      {/if}
                    {:else if toolActivityUnavailableNote}
                      <div class="execution-viewer-note">
                        {toolActivityUnavailableNote}
                      </div>
                    {:else}
                      <div class="execution-viewer-note">
                        No tool activity was captured for this run.
                      </div>
                    {/if}
                  </div>
                {:else}
                  <div class="execution-viewer-muted-copy">
                    {llmCallUnavailableMessage(modeKind)}
                  </div>
                {/if}
              </div>
            </Collapsible.Content>
          </Collapsible.Root>
        </div>

        <div class="execution-viewer-stack-lg">
          <div class="execution-viewer-eyebrow">Request</div>

          <Collapsible.Root bind:open={openPrimaryPrompt} disabled={!currentSnapshot.primarySystemPrompt}>
            <Collapsible.Trigger class="execution-viewer-section-trigger execution-viewer-section-trigger-disabled">
              <div class="execution-viewer-section-label">
                <span class="execution-viewer-section-heading">PA System Prompt</span>
                <span class="execution-viewer-helper">Compiled system prompt for the Primary Agent</span>
              </div>
              <ChevronDown class="execution-viewer-section-chevron" data-open={openPrimaryPrompt} />
            </Collapsible.Trigger>
            <Collapsible.Content class="execution-viewer-section-content">
              {#if currentSnapshot.primarySystemPrompt}
                <pre class="execution-viewer-pre execution-viewer-pre-tall">
{displayViewerText(currentSnapshot.primarySystemPrompt)}
                </pre>
              {/if}
            </Collapsible.Content>
          </Collapsible.Root>

          <Collapsible.Root bind:open={openMemoryContext} disabled={!memoryContextMeta}>
            <Collapsible.Trigger class="execution-viewer-section-trigger execution-viewer-section-trigger-disabled">
              <div class="execution-viewer-section-label">
                <span class="execution-viewer-section-heading">Memory Context</span>
                <span class="execution-viewer-helper">Memories inserted into this run</span>
              </div>
              <ChevronDown class="execution-viewer-section-chevron" data-open={openMemoryContext} />
            </Collapsible.Trigger>
            <Collapsible.Content class="execution-viewer-section-content">
              {#if memoryContextMeta}
                <div class="execution-viewer-card execution-viewer-stack-md">
                  <div class="execution-viewer-grid-2">
                    <div class="execution-viewer-stack-xs">
                      <div class="execution-viewer-eyebrow">Awareness</div>
                      <div class="execution-viewer-value-row">
                        {memoryContextMeta.onMyMind?.count ?? 0} entr{(memoryContextMeta.onMyMind?.count ?? 0) === 1 ? 'y' : 'ies'} (~{memoryContextMeta.onMyMind?.tokenEstimate ?? 0} tokens{(memoryContextMeta.onMyMind?.truncatedCount ?? 0) > 0 ? `, ${memoryContextMeta.onMyMind.truncatedCount} over budget` : ''})
                      </div>
                    </div>
                    <div class="execution-viewer-stack-xs">
                      <div class="execution-viewer-eyebrow">Linger Window</div>
                      <div class="execution-viewer-value-row">
                        {memoryContextMeta.lingerWindowTurns ?? 0} turn{(memoryContextMeta.lingerWindowTurns ?? 0) === 1 ? '' : 's'}
                      </div>
                    </div>
                  </div>
                  {#if memoryContextMeta.timeAwareness}
                    <div class="execution-viewer-stack-xs">
                      <div class="execution-viewer-eyebrow">Time Awareness</div>
                      <div class="execution-viewer-helper">{memoryContextMeta.timeAwareness}</div>
                    </div>
                  {/if}
                  <div class="execution-viewer-stack-xs">
                    <div class="execution-viewer-eyebrow">Inserted Memories</div>
                    {#if Array.isArray(memoryContextMeta.inserts) && memoryContextMeta.inserts.length > 0}
                      {#each memoryContextMeta.inserts as insert}
                        <div class="execution-viewer-value-row">
                          {insert.status === 'new' ? '✅' : insert.status === 'refreshed' ? '✳️' : '🟢'}
                          [{insert.source}{Array.isArray(insert.matchedTerms) && insert.matchedTerms.length > 0 ? ` "${insert.matchedTerms.join('", "')}"` : ''} | {insert.lane} | {insert.id} | importance {insert.importance}] {insert.gist}
                        </div>
                      {/each}
                    {:else}
                      <div class="execution-viewer-helper">No memories were inserted for this run.</div>
                    {/if}
                  </div>
                  {#if Array.isArray(memoryContextMeta.moreAvailable) && memoryContextMeta.moreAvailable.length > 0}
                    <div class="execution-viewer-stack-xs">
                      <div class="execution-viewer-eyebrow">More Available</div>
                      {#each memoryContextMeta.moreAvailable as note}
                        <div class="execution-viewer-helper">{note}</div>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}
            </Collapsible.Content>
          </Collapsible.Root>

          <Collapsible.Root bind:open={openCompiledMessages} disabled={!currentSnapshot.compiledMessages || currentSnapshot.compiledMessages.length === 0}>
            <Collapsible.Trigger class="execution-viewer-section-trigger execution-viewer-section-trigger-disabled">
              <div class="execution-viewer-section-label">
                <span class="execution-viewer-section-heading">Compiled Messages</span>
                <span class="execution-viewer-helper">Chat history + current message (no system prompt)</span>
              </div>
              <ChevronDown class="execution-viewer-section-chevron" data-open={openCompiledMessages} />
            </Collapsible.Trigger>
            <Collapsible.Content class="execution-viewer-section-content">
              <div class="execution-viewer-json-pane execution-viewer-json-pane-tall">
                <pre class="execution-viewer-pre execution-viewer-pre-plain">
{displayViewerText(compiledMessagesPlainText || 'No compiled messages captured for this run.')}
                </pre>
              </div>
            </Collapsible.Content>
          </Collapsible.Root>
        </div>

        {#if delegated && delegated.runs.length > 0}
          <div class="execution-viewer-stack-lg execution-viewer-section-block">
            <div class="execution-viewer-eyebrow">Delegation</div>

            <Collapsible.Root bind:open={openDelegated}>
              <Collapsible.Trigger class="execution-viewer-section-trigger">
                <div class="execution-viewer-section-label">
                  <span class="execution-viewer-section-heading">Delegated runs</span>
                  <span class="execution-viewer-helper">
                    Subagent and worker usage billed inside this parent response
                  </span>
                </div>
                <div class="execution-viewer-inline-row">
                  <Badge variant="outline" class="execution-viewer-confidence-badge execution-viewer-confidence-exact">
                    Runs: {delegated.totals.runs}
                  </Badge>
                  <ChevronDown class="execution-viewer-section-chevron" data-open={openDelegated} />
                </div>
              </Collapsible.Trigger>
              <Collapsible.Content class="execution-viewer-section-content">
                <div class="execution-viewer-table-wrap">
                  <table class="execution-viewer-table">
                    <thead class="execution-viewer-table-head">
                      <tr>
                        <th class="execution-viewer-table-heading">Run</th>
                        <th class="execution-viewer-table-heading">Type</th>
                        <th class="execution-viewer-table-heading">Model</th>
                        <th class="execution-viewer-table-heading">Tokens</th>
                        <th class="execution-viewer-table-heading">Duration</th>
                        <th class="execution-viewer-table-heading">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each delegated.runs as run, index}
                        <tr class="execution-viewer-table-row">
                          <td class="execution-viewer-table-primary-cell">
                            <div class="execution-viewer-value">{run.name}</div>
                            <div class="execution-viewer-helper">{run.kind} {index + 1}</div>
                          </td>
                          <td class="execution-viewer-table-cell">
                            <div class="execution-viewer-value">{run.type}</div>
                            {#if run.thread}
                              <div class="execution-viewer-helper">Thread: {run.thread}</div>
                            {/if}
                          </td>
                          <td class="execution-viewer-table-cell">
                            <div class="execution-viewer-value">{run.model ?? 'Unknown'}</div>
                            <div class="execution-viewer-helper">{run.provider ?? 'Unknown provider'}</div>
                          </td>
                          <td class="execution-viewer-table-cell">
                            {formatTokenValue(delegatedTokenTotal(run.usage))}
                          </td>
                          <td class="execution-viewer-table-muted-cell">
                            {formatDuration(run.durationMs)}
                          </td>
                          <td class="execution-viewer-table-cell">
                            <Badge
                              variant="outline"
                              class={`execution-viewer-confidence-badge ${delegatedStatusClasses(run.status)}`}
                            >
                              {delegatedStatusLabel(run.status)}
                            </Badge>
                          </td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
                {#if delegated.totals.usageUnknownRuns > 0}
                  <div class="execution-viewer-note execution-viewer-note-sm">
                    {delegated.totals.usageUnknownRuns} delegated {delegated.totals.usageUnknownRuns === 1 ? 'run did' : 'runs did'} not report usage. Unknown values are not counted as zero.
                  </div>
                {/if}
              </Collapsible.Content>
            </Collapsible.Root>
          </div>
        {/if}

        <div class="execution-viewer-stack-lg execution-viewer-section-block">
          <div class="execution-viewer-eyebrow">Response</div>

          <Collapsible.Root bind:open={openResponse}>
            <Collapsible.Trigger class="execution-viewer-section-trigger">
              <div class="execution-viewer-section-label">
                <div class="execution-viewer-inline-row">
                  <span class="execution-viewer-section-heading">Final Output (What you see)</span>
                  {#if responseSummary}
                    <Badge
                      variant="outline"
                      class={`execution-viewer-confidence-badge ${confidenceClasses(responseSummary.content.confidence)}`}
                    >
                      {confidenceLabel(responseSummary.content.confidence)}
                    </Badge>
                  {/if}
                </div>
                <span class="execution-viewer-helper">Final assistant output + usage totals</span>
              </div>
              <div class="execution-viewer-inline-row">
                {#if responseSummary && hasAnyToken(responseSummary.usage)}
                  <Badge
                    variant="outline"
                    class={`execution-viewer-confidence-badge ${confidenceClasses(responseSummary.usage.inputTokens.confidence)}`}
                  >
                    {tokenBadgeText('Input', responseSummary.usage.inputTokens)}
                  </Badge>
                  <Badge
                    variant="outline"
                    class={`execution-viewer-confidence-badge ${confidenceClasses(responseSummary.usage.outputTokens.confidence)}`}
                  >
                    {tokenBadgeText('Output', responseSummary.usage.outputTokens)}
                  </Badge>
                  <Badge
                    variant="outline"
                    class={`execution-viewer-confidence-badge ${confidenceClasses(responseSummary.usage.totalTokens.confidence)}`}
                  >
                    {tokenBadgeText('Total', responseSummary.usage.totalTokens)}
                  </Badge>
                {/if}
                <ChevronDown class="execution-viewer-section-chevron" data-open={openResponse} />
              </div>
            </Collapsible.Trigger>
            <Collapsible.Content class="execution-viewer-section-content">
              {#if responseSummary}
                <div class="execution-viewer-stack-md">
                  <div class="execution-viewer-stats-grid execution-viewer-stats-grid-five">
                    {#each usageDetailEntries(responseSummary.usage, modeKind) as detail}
                      <div class="execution-viewer-stat-card">
                        <div class="execution-viewer-stat-label">
                          {detail.label}
                        </div>
                        {#if typeof detail.stat?.value === 'number'}
                          <div class="execution-viewer-stat-row">
                            <span class="execution-viewer-stat-value">{formatTokenValue(detail.stat.value)}</span>
                            <Badge
                              variant="outline"
                              class={`execution-viewer-confidence-badge ${confidenceClasses(detail.stat.confidence)}`}
                            >
                              {confidenceLabel(detail.stat.confidence)}
                            </Badge>
                          </div>
                        {:else}
                          <div class="execution-viewer-stat-unavailable">{detail.unavailableText}</div>
                        {/if}
                      </div>
                    {/each}
                  </div>

                  {#if reasoningPersistence}
                    <div class="execution-viewer-note execution-viewer-note-sm">
                      {reasoningPersistenceText(reasoningPersistence)}
                    </div>
                  {/if}

                  <div class="execution-viewer-json-pane execution-viewer-json-pane-tall">
                    {#if typeof responseSummary.content?.value === 'string'}
                      <pre class="execution-viewer-response-pre">
{displayViewerText(responseSummary.content.value)}
                      </pre>
                    {:else}
                      <JSONViewer data={displayViewerData(responseSummary.content?.value ?? null)} />
                    {/if}
                  </div>

                  {#if Array.isArray(responseSummary.notes) && responseSummary.notes.length > 0}
                    <div class="execution-viewer-note execution-viewer-stack-xs">
                      {#each responseSummary.notes as note}
                        <div>• {note}</div>
                      {/each}
                    </div>
                  {/if}
                </div>
              {:else}
                <div class="execution-viewer-note execution-viewer-note-sm">
                  No final response summary was captured for this run.
                </div>
              {/if}
            </Collapsible.Content>
          </Collapsible.Root>
        </div>

	        <div class="execution-viewer-stack-lg execution-viewer-section-block">
	          <div class="execution-viewer-eyebrow">Debug</div>

	          {#if rawSnapshotRequest}
	            <Collapsible.Root bind:open={openRawSnapshotRequest}>
	              <Collapsible.Trigger class="execution-viewer-section-trigger execution-viewer-section-trigger-debug">
	                <div class="execution-viewer-section-label">
	                  <span class="execution-viewer-section-heading">Raw Snapshot Request (Debug)</span>
	                  <span class="execution-viewer-helper">Request-side snapshot (what Batshit prepared)</span>
	                </div>
	                <ChevronDown class="execution-viewer-section-chevron" data-open={openRawSnapshotRequest} />
	              </Collapsible.Trigger>
	              <Collapsible.Content class="execution-viewer-section-content">
	                <div class="execution-viewer-json-pane execution-viewer-json-pane-tall">
	                  <JSONViewer data={rawSnapshotRequest} />
	                </div>
	              </Collapsible.Content>
	            </Collapsible.Root>
	          {/if}

		          {#if rawProviderResponses}
		            <Collapsible.Root bind:open={openRawProviderResponses}>
	              <Collapsible.Trigger class="execution-viewer-section-trigger execution-viewer-section-trigger-debug">
	                <div class="execution-viewer-section-label">
	                  <span class="execution-viewer-section-heading">Raw Provider Responses (Debug)</span>
	                  <span class="execution-viewer-helper">Exact per-call provider response objects (API agents)</span>
	                </div>
	                <ChevronDown class="execution-viewer-section-chevron" data-open={openRawProviderResponses} />
	              </Collapsible.Trigger>
	              <Collapsible.Content class="execution-viewer-section-content">
	                <div class="execution-viewer-json-pane execution-viewer-json-pane-tall">
	                  <JSONViewer data={rawProviderResponses} />
	                </div>
		              </Collapsible.Content>
		            </Collapsible.Root>
              {:else}
                <div class="execution-viewer-note">
                  {rawProviderResponsesUnavailableMessage(modeKind)}
                </div>
		          {/if}

	          {#if runtimeDetails?.eventLog?.length}
	            <Collapsible.Root bind:open={openRawEvents}>
	              <Collapsible.Trigger class="execution-viewer-section-trigger execution-viewer-section-trigger-debug">
	                <div class="execution-viewer-section-label">
	                  <span class="execution-viewer-section-heading">Raw Runtime Events (Debug)</span>
	                  <span class="execution-viewer-helper">
	                    Runtime event log ({runtimeDetails.eventLog.length})
	                  </span>
	                </div>
	                <ChevronDown class="execution-viewer-section-chevron" data-open={openRawEvents} />
	              </Collapsible.Trigger>
	              <Collapsible.Content class="execution-viewer-section-content">
	                <div class="execution-viewer-json-pane execution-viewer-json-pane-tall">
	                  <JSONViewer data={displayViewerData(runtimeDetails.eventLog)} />
	                </div>
	              </Collapsible.Content>
	            </Collapsible.Root>
            {:else}
              <div class="execution-viewer-note">
                {runtimeFieldUnavailable(modeKind, 'runtimeEvents')}
              </div>
	          {/if}
        </div>
      {/if}
    </div>
  </Sheet.Content>
</Sheet.Root>

<style>
  :global(.execution-viewer-sheet) {
    display: flex;
    width: 100%;
    max-width: min(48rem, 100vw);
    flex-direction: column;
  }

  :global(.execution-viewer-header) {
    border-bottom: 1px solid var(--border);
    padding: 16px 24px;
  }

  :global(.execution-viewer-title) {
    font-size: 1.25rem;
    line-height: 1.35;
  }

  .execution-viewer-body,
  .execution-viewer-stack-lg,
  .execution-viewer-stack-md,
  .execution-viewer-stack-sm,
  .execution-viewer-stack-xs,
  .execution-viewer-section-label,
  .execution-viewer-provider-session,
  .execution-viewer-muted-copy {
    display: flex;
    flex-direction: column;
  }

  .execution-viewer-body {
    flex: 1 1 0;
    gap: 16px;
    overflow-y: auto;
    padding: 20px 24px;
  }

  .execution-viewer-stack-lg {
    gap: 16px;
  }

  .execution-viewer-stack-md {
    gap: 12px;
  }

  .execution-viewer-stack-sm {
    gap: 8px;
  }

  .execution-viewer-stack-xs,
  .execution-viewer-provider-session,
  .execution-viewer-muted-copy {
    gap: 4px;
  }

  .execution-viewer-loading,
  .execution-viewer-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--muted-foreground);
    font-size: 0.875rem;
  }

  .execution-viewer-loading {
    height: 12rem;
  }

  .execution-viewer-empty {
    border: 1px dashed var(--border);
    border-radius: 6px;
    padding: 32px 16px;
    text-align: center;
  }

  .execution-viewer-error {
    border: 1px solid oklch(from var(--destructive) l c h / 0.4);
    border-radius: 6px;
    background: oklch(from var(--destructive) l c h / 0.1);
    color: var(--destructive);
    padding: 12px 16px;
    font-size: 0.875rem;
  }

  .execution-viewer-error-compact {
    padding: 8px 12px;
  }

  .execution-viewer-run-row,
  .execution-viewer-wrap-row,
  .execution-viewer-inline-row,
  .execution-viewer-value-row,
  .execution-viewer-stat-row,
  .execution-viewer-run-row {
    flex-wrap: wrap;
    gap: 12px;
  }

  .execution-viewer-base64-toggle {
    display: flex;
    min-height: 32px;
    align-items: center;
    gap: 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: oklch(from var(--muted) l c h / 0.18);
    padding: 4px 8px;
  }

  .execution-viewer-base64-toggle-label {
    color: var(--muted-foreground);
    font-size: 0.75rem;
    line-height: 1.2;
    white-space: nowrap;
  }

  .execution-viewer-wrap-row {
    flex-wrap: wrap;
    gap: 8px;
  }

  .execution-viewer-inline-row,
  .execution-viewer-value-row,
  .execution-viewer-stat-row {
    gap: 8px;
  }

  .execution-viewer-stat-row {
    flex-wrap: wrap;
    min-width: 0;
  }

  .execution-viewer-stat-value {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .execution-viewer-flex-spacer {
    flex: 1 1 0;
  }

  .execution-viewer-eyebrow,
  .execution-viewer-stat-label {
    color: var(--muted-foreground);
    font-size: 0.75rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .execution-viewer-run-select {
    height: 32px;
    border: 1px solid var(--input);
    border-radius: 6px;
    background: var(--background);
    padding-inline: 8px;
    font-size: 0.875rem;
  }

  .execution-viewer-run-select:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px oklch(from var(--ring) l c h / 0.5);
  }

  :global(.execution-viewer-section-trigger) {
    display: flex;
    width: 100%;
    align-items: center;
    justify-content: space-between;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: oklch(from var(--accent) l c h / 0.3);
    padding: 8px 12px;
    text-align: left;
    transition: background-color 0.16s ease;
  }

  :global(.execution-viewer-section-trigger-strong) {
    background: oklch(from var(--accent) l c h / 0.4);
  }

  :global(.execution-viewer-section-trigger-debug) {
    background: oklch(from var(--accent) l c h / 0.2);
  }

  :global(.execution-viewer-section-trigger:hover) {
    background: var(--accent);
  }

  :global(.execution-viewer-section-trigger:disabled),
  :global(.execution-viewer-section-trigger-disabled:disabled) {
    opacity: 0.5;
  }

  .execution-viewer-section-heading {
    font-weight: 600;
  }

  .execution-viewer-helper,
  .execution-viewer-muted-copy,
  .execution-viewer-muted,
  .execution-viewer-table-muted-cell,
  .execution-viewer-stat-unavailable,
  .execution-viewer-note,
  .execution-viewer-helper,
  .execution-viewer-note,
  .execution-viewer-stat-unavailable {
    font-size: 0.75rem;
  }

  :global(.execution-viewer-section-content) {
    padding-top: 12px;
  }

  :global(.execution-viewer-section-chevron) {
    width: 16px;
    height: 16px;
    transition: transform 0.16s ease;
  }

  :global(.execution-viewer-section-chevron[data-open="true"]) {
    transform: rotate(180deg);
  }

  .execution-viewer-card,
  .execution-viewer-panel,
  .execution-viewer-note,
  .execution-viewer-message-preview,
  .execution-viewer-code-block,
  .execution-viewer-stat-card,
  .execution-viewer-table-wrap,
  .execution-viewer-json-pane,
  .execution-viewer-pre,
  .execution-viewer-card,
  .execution-viewer-panel,
  .execution-viewer-note,
  .execution-viewer-stat-card,
  .execution-viewer-table-wrap,
  .execution-viewer-json-pane,
  .execution-viewer-pre,
  .execution-viewer-card {
    background: oklch(from var(--background) l c h / 0.4);
    padding: 12px;
  }

  .execution-viewer-panel,
  .execution-viewer-note {
    border-color: oklch(from var(--border) l c h / 0.6);
    background: oklch(from var(--muted) l c h / 0.1);
    padding: 8px 12px;
  }

  .execution-viewer-note-raised {
    background: oklch(from var(--background) l c h / 0.6);
  }

  .execution-viewer-note-sm,
  .execution-viewer-text-sm,
  .execution-viewer-muted-copy {
    font-size: 0.875rem;
  }

  .execution-viewer-grid-2,
  .execution-viewer-stats-grid {
    display: grid;
    gap: 12px;
  }

  .execution-viewer-stats-grid {
    gap: 8px;
  }

  @media (min-width: 768px) {
    .execution-viewer-grid-2 {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .execution-viewer-stats-grid-five {
      grid-template-columns: repeat(5, minmax(0, 1fr));
    }

    .execution-viewer-stats-grid-six {
      grid-template-columns: repeat(6, minmax(0, 1fr));
    }
  }

  .execution-viewer-value,
  .execution-viewer-stat-value,
  .execution-viewer-table-primary-cell {
    font-weight: 500;
  }

  .execution-viewer-message-preview,
  .execution-viewer-code-block {
    background: oklch(from var(--muted) l c h / 0.4);
    padding: 8px 12px;
  }

  .execution-viewer-message-preview {
    font-size: 0.875rem;
    line-height: 1.6;
  }

  .execution-viewer-break-all {
    word-break: break-all;
  }

  .execution-viewer-code-block,
  .execution-viewer-pre {
    font-size: 0.75rem;
  }

  .execution-viewer-stat-card {
    background: oklch(from var(--background) l c h / 0.5);
    padding: 8px 12px;
  }

  .execution-viewer-table-wrap {
    overflow-x: auto;
    background: var(--background);
  }

  .execution-viewer-table {
    width: 100%;
    font-size: 0.875rem;
    border-collapse: collapse;
  }

  .execution-viewer-table-head {
    border-bottom: 1px solid var(--border);
    background: oklch(from var(--muted) l c h / 0.2);
    color: var(--muted-foreground);
    font-size: 0.75rem;
  }

  .execution-viewer-table-heading,
  .execution-viewer-table-primary-cell,
  .execution-viewer-table-cell,
  .execution-viewer-table-muted-cell {
    padding: 8px 12px;
    text-align: left;
  }

  .execution-viewer-table-heading {
    font-weight: 500;
  }

  .execution-viewer-table-row {
    cursor: pointer;
    border-bottom: 1px solid var(--border);
    transition: background-color 0.16s ease;
  }

  .execution-viewer-table-row:last-child {
    border-bottom: 0;
  }

  .execution-viewer-table-row:hover {
    background: oklch(from var(--muted) l c h / 0.3);
  }

  .execution-viewer-table-row[data-selected="true"] {
    background: oklch(from var(--muted) l c h / 0.6);
  }

  .execution-viewer-json-pane {
    max-height: 20rem;
    overflow-y: auto;
    background: oklch(from var(--muted) l c h / 0.1);
    padding: 12px;
  }

  .execution-viewer-json-pane-tall {
    max-height: 24rem;
  }

  .execution-viewer-pre {
    overflow-y: auto;
    background: oklch(from var(--muted) l c h / 0.1);
    padding: 12px;
    white-space: pre-wrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    line-height: 1.6;
  }

  .execution-viewer-pre-tall {
    max-height: 24rem;
  }

  .execution-viewer-pre-plain {
    border: 0;
    background: transparent;
    padding: 0;
  }

  .execution-viewer-response-pre {
    white-space: pre-wrap;
    font-size: 0.875rem;
    line-height: 1.6;
  }

  @media (min-width: 640px) {
  }

  :global(.execution-viewer-button-icon-leading) {
    width: 14px;
    height: 14px;
    margin-right: 8px;
  }

  .execution-viewer-section-block {
    padding-top: 8px;
  }

  :global(.execution-viewer-confidence-badge) {
    border-width: 1px;
    border-style: solid;
    font-size: 0.6875rem;
    font-weight: 400;
    max-width: 100%;
    white-space: normal;
  }

  :global(.execution-viewer-confidence-exact),
  :global(.execution-viewer-tool-status-success) {
    border-color: oklch(0.67 0.13 151 / 0.36);
    background: oklch(0.67 0.13 151 / 0.11);
    color: oklch(0.76 0.12 151);
  }

  :global(.execution-viewer-confidence-near) {
    border-color: oklch(0.73 0.14 132 / 0.36);
    background: oklch(0.73 0.14 132 / 0.11);
    color: oklch(0.78 0.12 132);
  }

  :global(.execution-viewer-confidence-estimated),
  :global(.execution-viewer-tool-status-partial) {
    border-color: oklch(0.75 0.13 85 / 0.36);
    background: oklch(0.75 0.13 85 / 0.11);
    color: oklch(0.82 0.12 85);
  }

  :global(.execution-viewer-confidence-speculative) {
    border-color: oklch(0.72 0.14 55 / 0.36);
    background: oklch(0.72 0.14 55 / 0.11);
    color: oklch(0.8 0.12 55);
  }

  :global(.execution-viewer-confidence-muted) {
    border-color: var(--border);
    background: oklch(from var(--muted) l c h / 0.3);
    color: var(--muted-foreground);
  }

  :global(.execution-viewer-tool-status-error) {
    border-color: oklch(from var(--destructive) l c h / 0.4);
    background: oklch(from var(--destructive) l c h / 0.1);
    color: var(--destructive);
  }
</style>
