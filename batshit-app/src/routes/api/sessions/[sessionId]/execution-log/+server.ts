import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import { executionViewerService } from '$lib/server/services/executionViewerService'
import { adaptCoolToolsToZipSystem } from '$lib/server/coolToolZipAdapter'
import { redactWebhookStyleInput } from '$lib/server/services/executionViewerRedaction'
import { fetchN8nExecutionInsights } from '$lib/server/services/n8nExecutionWebhookInspector'
import {
  buildTokenStat,
  buildTokenUsage,
} from '$lib/server/services/executionViewerLlmCapture'
import { env } from '$env/dynamic/private'
import { apiKeyService } from '$lib/services/apiKey.server'
import type { ExecutionRuntimeDetails } from '$lib/types/executionViewer'
import type { ExecutionSnapshot } from '$lib/types/executionViewer'
import type { ExecutionFieldAvailability } from '$lib/types/executionViewer'
import { approximateTokenCount } from '$lib/utils/tokenCounter'

type HydratedZipReference = {
  zipId?: string
  placeholder?: string
  reference: string
}

function dedupeZipReferences(refs: HydratedZipReference[]): HydratedZipReference[] {
  const unique: HydratedZipReference[] = []
  const seen = new Set<string>()

  for (const ref of refs) {
    if (!ref?.reference || seen.has(ref.reference)) continue
    seen.add(ref.reference)
    unique.push(ref)
  }

  return unique
}

function extractZipIdFromReference(reference: string): string | null {
  const match = reference.match(/\{\{batshit-zip:([^:}]+)(?::::[^}]*)?\}\}/)
  return match ? match[1] : null
}

function extractZipIdsFromReferences(refs: HydratedZipReference[]): string[] {
  return Array.from(
    new Set(
      refs
        .map((ref) => ref.zipId || extractZipIdFromReference(ref.reference))
        .filter((id): id is string => Boolean(id)),
    ),
  )
}

function extractCoolToolReferencesFromMessage(message: any): HydratedZipReference[] {
  const refs: HydratedZipReference[] = []
  const metadataRefs = Array.isArray(message?.metadata?.zipReferences)
    ? message.metadata.zipReferences
    : []

  for (const entry of metadataRefs) {
    const reference =
      typeof entry === 'string'
        ? entry
        : typeof entry?.reference === 'string'
          ? entry.reference
          : ''
    if (reference.includes('batshit-zip:cool_tool_')) {
      refs.push({
        zipId:
          typeof entry?.zipId === 'string'
            ? entry.zipId
            : typeof entry?.zip_id === 'string'
              ? entry.zip_id
              : extractZipIdFromReference(reference) ?? undefined,
        reference
      })
    }
  }

  const content = typeof message?.content === 'string' ? message.content : ''
  const regex = /\{\{batshit-zip:cool_tool_[^}]+\}\}/g
  let match: RegExpExecArray | null = null
  while ((match = regex.exec(content)) !== null) {
    refs.push({ zipId: extractZipIdFromReference(match[0]) ?? undefined, reference: match[0] })
  }

  return dedupeZipReferences(refs)
}

function mergeZipReferenceContent(
  content: string,
  refs: HydratedZipReference[],
): string {
  const uniqueRefs = dedupeZipReferences(refs)
  if (uniqueRefs.length === 0) return content

  let body = typeof content === 'string' ? content : ''
  for (const ref of uniqueRefs) {
    body = body.replaceAll(ref.reference, '')
    if (ref.placeholder) {
      body = body.replaceAll(ref.placeholder, '')
    }
  }

  const zipSection = uniqueRefs.map((ref) => ref.reference).join('\n\n')
  body = body.replace(/\n{3,}/g, '\n\n').trim()
  return body ? `${zipSection}\n\n${body}`.trim() : zipSection
}

function removeUnavailableIntermediateStepNote(notes: unknown): unknown {
  if (!Array.isArray(notes)) return notes
  return notes.filter(
    (note) =>
      typeof note !== 'string' ||
      !note.includes('Tool-call details are unavailable for this run'),
  )
}

export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = locals.user?.id
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sessionId = params.sessionId
  if (!sessionId) {
    return json({ error: 'Session ID is required' }, { status: 400 })
  }

  const session = await redis.getSession(sessionId)
  if (!session || session.user_id !== userId) {
    return json({ error: 'Session not found' }, { status: 404 })
  }

  const entries = await executionViewerService.getSnapshots(sessionId)
  return json({ entries })
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const userId = locals.user?.id
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sessionId = params.sessionId
  if (!sessionId) {
    return json({ error: 'Session ID is required' }, { status: 400 })
  }

  const session = await redis.getSession(sessionId)
  if (!session || session.user_id !== userId) {
    return json({ error: 'Session not found' }, { status: 404 })
  }

  let payload: any
  try {
    payload = await request.json()
  } catch {
    return json({ error: 'Invalid JSON payload' }, { status: 400 })
  }

  if (!payload || typeof payload !== 'object') {
    return json({ error: 'Invalid payload' }, { status: 400 })
  }

  const {
    id,
    agentId = null,
    agentName,
    agentType,
    createdAt,
    userMessage,
    structuredInput,
    primarySystemPrompt,
    subagentPrompts,
    subagentDescription,
    compiledMessages,
    compileMetadata,
    executionMetadata,
    webhookStyleInput,
    webhookInputAvailability,
    llmSummary,
    llmCalls,
    intermediateSteps,
    responseSummary,
    selectedGateways,
    selectedTools,
    mcpToolSelections,
    defaultGateways,
    gatewayToolMap,
    voiceMetadata,
    assignedSubagents,
    availableWorkflows,
    runtime,
  } = payload

  if (!id || typeof id !== 'string') {
    return json({ error: 'Snapshot ID is required' }, { status: 400 })
  }

  const safeAgentName =
    typeof agentName === 'string' && agentName.trim().length > 0
      ? agentName
      : 'Agent'

  const runtimeDetails: ExecutionRuntimeDetails | undefined =
    runtime && typeof runtime === 'object' ? runtime : undefined
  const webhookInputState: ExecutionFieldAvailability | null =
    webhookInputAvailability && typeof webhookInputAvailability === 'object'
      ? webhookInputAvailability
      : Array.isArray(webhookStyleInput) &&
          webhookStyleInput.length > 0 &&
          agentType === 'n8n'
        ? {
            state: 'unavailable',
            source: 'batshit-webhook-wrapper',
            note: 'Exact webhook input is not loaded yet. Use Refresh to replace this stored wrapper with the exact n8n Webhook node output when the matching execution is available.',
          }
        : null

  await executionViewerService.recordSnapshot({
    id,
    sessionId,
    userId,
    agentId: typeof agentId === 'string' ? agentId : null,
    agentName: safeAgentName,
    agentType: typeof agentType === 'string' ? agentType : undefined,
    createdAt:
      typeof createdAt === 'string' ? createdAt : new Date().toISOString(),
    userMessage: typeof userMessage === 'string' ? userMessage : undefined,
    structuredInput,
    primarySystemPrompt,
    subagentPrompts,
    subagentDescription,
    compiledMessages,
    compileMetadata,
    executionMetadata,
    webhookStyleInput: Array.isArray(webhookStyleInput)
      ? (redactWebhookStyleInput(webhookStyleInput) as any[])
      : null,
    webhookInputAvailability: webhookInputState,
    llmSummary: llmSummary ?? null,
    llmCalls: Array.isArray(llmCalls) ? llmCalls : null,
    intermediateSteps: Array.isArray(intermediateSteps) ? intermediateSteps : null,
    responseSummary: responseSummary ?? null,
    selectedGateways: Array.isArray(selectedGateways) ? selectedGateways : null,
    selectedTools: Array.isArray(selectedTools) ? selectedTools : null,
    mcpToolSelections: mcpToolSelections ?? null,
    defaultGateways: Array.isArray(defaultGateways) ? defaultGateways : null,
    gatewayToolMap: gatewayToolMap ?? null,
    voiceMetadata: voiceMetadata ?? undefined,
    assignedSubagents: Array.isArray(assignedSubagents)
      ? assignedSubagents
      : undefined,
    availableWorkflows: Array.isArray(availableWorkflows)
      ? availableWorkflows
      : undefined,
    runtime: runtimeDetails,
  })

  return json({ success: true })
}

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  const userId = locals.user?.id
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sessionId = params.sessionId
  if (!sessionId) {
    return json({ error: 'Session ID is required' }, { status: 400 })
  }

  const session = await redis.getSession(sessionId)
  if (!session || session.user_id !== userId) {
    return json({ error: 'Session not found' }, { status: 404 })
  }

  let payload: any
  try {
    payload = await request.json()
  } catch {
    return json({ error: 'Invalid JSON payload' }, { status: 400 })
  }

  const snapshotId = payload?.id
  const patch = payload?.patch
  const hydrateN8nWebhookInput = payload?.hydrateN8nWebhookInput === true
  const n8nExecutionSearchLimitRaw = payload?.n8nExecutionSearchLimit

  if (!snapshotId || typeof snapshotId !== 'string') {
    return json({ error: 'Snapshot ID is required' }, { status: 400 })
  }

  if (!patch || typeof patch !== 'object') {
    return json({ error: 'Patch object is required' }, { status: 400 })
  }

  const allowed: Partial<ExecutionSnapshot> = {}
  let hydratedWebhookInput = false
  let hydratedTokenUsage = false
  let toolSchemaTokenEstimate: number | null = null
  let hydrationError: string | null = null
  let hydratedIntermediateSteps: any[] | null = null
  let hydratedZipReferences: HydratedZipReference[] = []
  let hydratedZipIds: string[] = []
  let hydratedMessage = false

  const currentSnapshots = await executionViewerService.getSnapshots(sessionId)
  const current =
    currentSnapshots.find((entry) => entry.id === snapshotId) ?? null

  if (hydrateN8nWebhookInput) {
    try {
      // Prefer the per-user n8n API key stored in Redis (Settings → API Keys). Env is a fallback for dev only.
      const apiKey =
        (await apiKeyService
          .retrieve('n8n_api_key', userId)
          .catch(() => null)) || env.N8N_API_KEY
      if (!apiKey) {
        hydrationError =
          'n8n API key is not configured (Settings → API Keys → n8n API key).'
      } else {
        const resolvedLimit = (() => {
          if (
            n8nExecutionSearchLimitRaw === undefined ||
            n8nExecutionSearchLimitRaw === null
          ) {
            return undefined
          }

          const parsed =
            typeof n8nExecutionSearchLimitRaw === 'number'
              ? n8nExecutionSearchLimitRaw
              : typeof n8nExecutionSearchLimitRaw === 'string'
                ? Number.parseInt(n8nExecutionSearchLimitRaw, 10)
                : NaN

          if (!Number.isFinite(parsed)) return undefined

          const clamped = Math.max(1, Math.min(250, parsed))
          return clamped
        })()

        const expectedWebhookUrl =
          typeof current?.executionMetadata?.webhookUrl === 'string'
            ? current.executionMetadata.webhookUrl
            : typeof current?.executionMetadata?.webhookURL === 'string'
              ? current.executionMetadata.webhookURL
              : null

        const insights = await fetchN8nExecutionInsights({
          userId,
          sessionId,
          messageId: snapshotId,
          expectedWebhookUrl,
          ...(typeof resolvedLimit === 'number'
            ? { limit: resolvedLimit }
            : {}),
        })

        if (
          Array.isArray(insights?.webhookStyleInput) &&
          insights.webhookStyleInput.length > 0
        ) {
          allowed.webhookStyleInput = insights.webhookStyleInput
          patch.webhookInputAvailability = {
            state: 'exact',
            source: 'n8n-webhook-node',
            note: 'Loaded from the matching n8n execution.',
          }
          hydratedWebhookInput = true
        } else {
          patch.webhookInputAvailability = {
            state: 'unavailable',
            source: 'n8n API',
            note: 'No matching n8n execution was found for exact webhook input.',
          }
        }

        const tokenUsagesRaw = Array.isArray(insights?.tokenUsages)
          ? insights.tokenUsages
          : []
            const intermediateStepsRaw = (() => {
              const fromInsights = Array.isArray(
                (insights as any)?.intermediateSteps?.steps,
              )
                ? ((insights as any).intermediateSteps.steps as any[])
                : null

              if (Array.isArray(fromInsights) && fromInsights.length > 0) {
                return fromInsights
              }

              if (Array.isArray(patch.intermediateSteps) && patch.intermediateSteps.length > 0) {
                return patch.intermediateSteps as any[]
              }

              if (Array.isArray(current?.intermediateSteps) && current.intermediateSteps.length > 0) {
                return current.intermediateSteps as any[]
              }

              return null
            })()

        if (Array.isArray(intermediateStepsRaw) && intermediateStepsRaw.length > 0) {
          patch.intermediateSteps = intermediateStepsRaw
          hydratedIntermediateSteps = intermediateStepsRaw
          if (patch.responseSummary && typeof patch.responseSummary === 'object') {
            patch.responseSummary = {
              ...patch.responseSummary,
              notes: removeUnavailableIntermediateStepNote(
                patch.responseSummary.notes,
              ),
            }
          }
        }

        if (tokenUsagesRaw.length > 0 && current?.agentId) {
          const exactTokenUsages = tokenUsagesRaw.filter(
            (entry) => entry.kind === 'tokenUsage',
          )
          const estimateTokenUsages = tokenUsagesRaw.filter(
            (entry) => entry.kind === 'tokenUsageEstimate',
          )

          const preferredKind =
            exactTokenUsages.length > 0
              ? 'tokenUsage'
              : estimateTokenUsages.length > 0
                ? 'tokenUsageEstimate'
                : null
          const preferred =
            preferredKind === 'tokenUsage'
              ? exactTokenUsages
              : preferredKind === 'tokenUsageEstimate'
                ? estimateTokenUsages
                : []

          if (preferredKind && preferred.length > 0) {
            const confidence =
              preferredKind === 'tokenUsage' ? 'exact' : 'estimated'

            const toolsTokenEstimate = async () => {
              if (preferredKind !== 'tokenUsageEstimate') {
                return {
                  tokens: 0,
                  toolCount: 0,
                  toolDefinitions: [] as Array<Record<string, any>>,
                  error: null as string | null,
                }
              }

              // Dynamic MCP-only mode resolves gateway schemas on demand via find/use,
              // so static preloaded schema token estimation is no longer applicable.
              return {
                tokens: 0,
                toolCount: 0,
                toolDefinitions: [] as Array<Record<string, any>>,
                error: null as string | null,
              }
            }

            const toolEstimate = await toolsTokenEstimate()
            toolSchemaTokenEstimate =
              toolEstimate.tokens > 0 ? toolEstimate.tokens : null

            const normalizeToolArgsForBilledOutput = (raw: any): any => {
              if (raw == null) return {}
              if (typeof raw === 'string') {
                try {
                  return JSON.parse(raw)
                } catch {
                  return raw
                }
              }
              return raw
            }

            const toolCallsForBilledOutput = (() => {
              if (!Array.isArray(intermediateStepsRaw))
                return [] as Array<Record<string, any>>

              return intermediateStepsRaw
                .map((step) => {
                  if (!step || typeof step !== 'object') return null

                  const toolName =
                    typeof (step as any).toolName === 'string'
                      ? (step as any).toolName
                      : typeof (step as any).tool === 'string'
                        ? (step as any).tool
                        : typeof (step as any).action?.tool === 'string'
                          ? (step as any).action.tool
                          : null

                  if (!toolName || toolName.trim().length === 0) return null

                  const rawArgs =
                    (step as any).toolArgs ??
                    (step as any).toolInput ??
                    (step as any).action?.toolInput ??
                    (step as any).action?.tool_input ??
                    (step as any).args ??
                    (step as any).input ??
                    null

                  const toolCallId =
                    typeof (step as any).toolCallId === 'string'
                      ? (step as any).toolCallId
                      : typeof (step as any).action?.toolCallId === 'string'
                        ? (step as any).action.toolCallId
                        : null

                  return {
                    name: toolName,
                    args: normalizeToolArgsForBilledOutput(rawArgs),
                    ...(toolCallId ? { toolCallId } : {}),
                  }
                })
                .filter(
                  (
                    entry,
                  ): entry is {
                    name: string
                    args: any
                    toolCallId?: string
                  } => Boolean(entry),
                )
            })()

            const estimateIntermediateStepTokenDelta = (step: any): number => {
              if (!step || typeof step !== 'object') return 0

              // Direct tool-step shape: { toolArgs, toolResult }
              const toolArgs = (step as any).toolArgs
              const toolResult =
                (step as any).toolResult ?? (step as any).toolResults
              if (toolArgs !== undefined || toolResult !== undefined) {
                const toolName =
                  typeof (step as any).toolName === 'string'
                    ? (step as any).toolName
                    : ''
                const toolCallId =
                  typeof (step as any).toolCallId === 'string'
                    ? (step as any).toolCallId
                    : ''

                const safeArgs = (() => {
                  try {
                    return JSON.stringify(toolArgs ?? null)
                  } catch {
                    return String(toolArgs ?? '')
                  }
                })()

                const safeResult =
                  typeof toolResult === 'string'
                    ? toolResult
                    : (() => {
                        try {
                          return JSON.stringify(toolResult ?? null)
                        } catch {
                          return String(toolResult ?? '')
                        }
                      })()

                const inputText = `${toolName} ${toolCallId} ${safeArgs}`.trim()
                const outputText =
                  `${toolName} ${toolCallId} ${safeResult}`.trim()

                return (
                  approximateTokenCount(inputText) +
                  approximateTokenCount(outputText)
                )
              }

              // n8n AI Agent shape: { action: { messageLog[0].kwargs.content }, observation }
              const action = (step as any).action
              const observation = (step as any).observation
              if (action && typeof action === 'object') {
                const messageLog = Array.isArray((action as any).messageLog)
                  ? (action as any).messageLog
                  : []
                const contentFromKwargs = messageLog.find?.(
                  (entry: any) => typeof entry?.kwargs?.content === 'string',
                )?.kwargs?.content

                const inputText =
                  typeof contentFromKwargs === 'string'
                    ? contentFromKwargs
                    : (() => {
                        const tool =
                          typeof (action as any).tool === 'string'
                            ? (action as any).tool
                            : ''
                        const toolCallId =
                          typeof (action as any).toolCallId === 'string'
                            ? (action as any).toolCallId
                            : ''
                        const toolInput = (action as any).toolInput ?? null
                        try {
                          return `${tool} ${toolCallId} ${JSON.stringify(toolInput)}`.trim()
                        } catch {
                          return `${tool} ${toolCallId}`.trim()
                        }
                      })()

                const outputText =
                  typeof observation === 'string'
                    ? observation
                    : (() => {
                        try {
                          return JSON.stringify(observation ?? null)
                        } catch {
                          return String(observation ?? '')
                        }
                      })()

                return (
                  approximateTokenCount(inputText) +
                  approximateTokenCount(outputText)
                )
              }

              return 0
            }

            const toolStepTokenDeltas =
              preferredKind === 'tokenUsageEstimate' &&
              Array.isArray(intermediateStepsRaw)
                ? intermediateStepsRaw.map((step) =>
                    estimateIntermediateStepTokenDelta(step),
                  )
                : []

            const hasToolStepDeltas = toolStepTokenDeltas.some(
              (value) => typeof value === 'number' && value > 0,
            )

            const sumIfAllNumbers = (
              values: Array<number | null>,
            ): number | null => {
              if (values.length === 0) return null
              if (values.some((value) => typeof value !== 'number')) return null
              return values.reduce<number>(
                (sum, value) => sum + (value as number),
                0,
              )
            }

            const totalPromptTokensRaw = sumIfAllNumbers(
              preferred.map((call) => call.promptTokens),
            )
            const totalCompletionTokens = sumIfAllNumbers(
              preferred.map((call) => call.completionTokens),
            )
            const totalTokensRaw = sumIfAllNumbers(
              preferred.map((call) => call.totalTokens),
            )

            const totalPromptTokens =
              preferredKind === 'tokenUsageEstimate' &&
              toolEstimate.tokens > 0 &&
              typeof totalPromptTokensRaw === 'number'
                ? totalPromptTokensRaw + toolEstimate.tokens
                : totalPromptTokensRaw

            const totalTokens =
              preferredKind === 'tokenUsageEstimate' &&
              toolEstimate.tokens > 0 &&
              typeof totalTokensRaw === 'number'
                ? totalTokensRaw + toolEstimate.tokens
                : totalTokensRaw

            const usageFromN8nTotals = buildTokenUsage(
              {
                inputTokens: totalPromptTokens ?? undefined,
                outputTokens: totalCompletionTokens ?? undefined,
                totalTokens: totalTokens ?? undefined,
              },
              confidence,
              preferredKind === 'tokenUsage'
                ? 'n8n tokenUsage'
                : toolEstimate.tokens > 0
                  ? 'n8n tokenUsageEstimate + Batshit tool schema estimate'
                  : 'n8n tokenUsageEstimate',
            )

            const baseLlmSummary =
              (typeof patch.llmSummary === 'object'
                ? patch.llmSummary
                : null) ??
              (typeof current?.llmSummary === 'object'
                ? current.llmSummary
                : null)

            const fallbackLlmSummary = {
              callsCount: buildTokenStat(null, 'speculative', 'n8n'),
              totalUsage: usageFromN8nTotals,
              breakdownConfidence: 'speculative' as const,
            }

            patch.llmSummary = {
              ...(baseLlmSummary ?? fallbackLlmSummary),
              totalUsage: usageFromN8nTotals,
            }

            const baseResponseSummary =
              (typeof patch.responseSummary === 'object'
                ? patch.responseSummary
                : null) ??
              (typeof current?.responseSummary === 'object'
                ? current.responseSummary
                : null)

            const toolCallsCountFromSnapshot =
              typeof baseResponseSummary?.toolCallsCount?.value === 'number' &&
              Number.isFinite(baseResponseSummary.toolCallsCount.value)
                ? Math.max(
                    0,
                    Math.trunc(baseResponseSummary.toolCallsCount.value),
                  )
                : null

            const toolCallsCountFromN8n =
              typeof insights?.intermediateSteps?.toolCallsCount === 'number' &&
              Number.isFinite(insights.intermediateSteps.toolCallsCount)
                ? Math.max(
                    0,
                    Math.trunc(insights.intermediateSteps.toolCallsCount),
                  )
                : null

            const resolvedToolCallsCount =
              toolCallsCountFromN8n ?? toolCallsCountFromSnapshot

            const currentCallsCountRaw = (baseLlmSummary?.callsCount?.value ??
              fallbackLlmSummary.callsCount.value) as unknown
            const currentCallsCount =
              typeof currentCallsCountRaw === 'number' &&
              Number.isFinite(currentCallsCountRaw)
                ? Math.max(1, Math.trunc(currentCallsCountRaw))
                : null

            const inferredCallsCountFromTools =
              typeof resolvedToolCallsCount === 'number'
                ? resolvedToolCallsCount + 1
                : 0

            const callsCount = currentCallsCount
              ? Math.max(
                  currentCallsCount,
                  preferred.length,
                  inferredCallsCountFromTools,
                )
              : Math.max(preferred.length, inferredCallsCountFromTools)
            const responseText =
              typeof baseResponseSummary?.content?.value === 'string'
                ? baseResponseSummary.content.value
                : null

            const requestPayload: Record<string, any> = {
              systemPrompt: current?.primarySystemPrompt ?? null,
              messages: Array.isArray(current?.compiledMessages)
                ? current.compiledMessages
                : null,
            }

            const notes: string[] = [
              'This is a best-effort reconstruction for n8n runs; Batshit cannot capture the exact provider payload byte-for-byte.',
              'Tools attached directly to n8n nodes may be missing from the tool list.',
            ]

            const sourceLabel = (() => {
              if (preferredKind === 'tokenUsage') return 'n8n tokenUsage'

              if (hasToolStepDeltas && toolEstimate.tokens > 0) {
                return 'n8n tokenUsageEstimate + Batshit tool schema estimate + intermediateSteps tool I/O (estimate)'
              }

              if (hasToolStepDeltas) {
                return 'n8n tokenUsageEstimate + intermediateSteps tool I/O (estimate)'
              }

              return toolEstimate.tokens > 0
                ? 'n8n tokenUsageEstimate + Batshit tool schema estimate'
                : 'n8n tokenUsageEstimate'
            })()

            const llmCalls: any[] = []
            let previousInputTokens: number | null = null

            for (let idx = 0; idx < callsCount; idx += 1) {
              const tokenEntry = preferred[idx] ?? null
              const basePromptTokens = tokenEntry?.promptTokens ?? null
              const baseCompletionTokens = tokenEntry?.completionTokens ?? null

              const toolAdjustment =
                preferredKind === 'tokenUsageEstimate' &&
                toolEstimate.tokens > 0 &&
                idx === 0
                  ? toolEstimate.tokens
                  : 0

              const inputTokensAdjusted: number | undefined = (():
                | number
                | undefined => {
                if (idx === 0) {
                  return typeof basePromptTokens === 'number'
                    ? basePromptTokens + toolAdjustment
                    : undefined
                }

                if (
                  preferredKind === 'tokenUsageEstimate' &&
                  hasToolStepDeltas &&
                  typeof previousInputTokens === 'number'
                ) {
                  const delta =
                    typeof toolStepTokenDeltas[idx - 1] === 'number'
                      ? toolStepTokenDeltas[idx - 1]
                      : null
                  return typeof delta === 'number'
                    ? previousInputTokens + delta
                    : previousInputTokens
                }

                return typeof basePromptTokens === 'number'
                  ? basePromptTokens
                  : undefined
              })()

              if (typeof inputTokensAdjusted === 'number') {
                previousInputTokens = inputTokensAdjusted
              }

              const outputTokensAdjusted =
                typeof baseCompletionTokens === 'number'
                  ? baseCompletionTokens
                  : undefined

              const toolCallsForCall =
                toolCallsForBilledOutput.length > idx
                  ? [toolCallsForBilledOutput[idx]]
                  : []

              const callNotes =
                preferredKind === 'tokenUsageEstimate' &&
                toolEstimate.tokens > 0 &&
                idx === 0
                  ? [
                      ...notes,
                      `n8n returned tokenUsageEstimate; Batshit added ~${toolEstimate.tokens.toLocaleString()} input tokens for tool definitions (estimate).`,
                    ]
                  : preferredKind === 'tokenUsageEstimate' &&
                      hasToolStepDeltas &&
                      idx > 0
                    ? [
                        ...notes,
                        'Call input tokens estimated as: previous call input + tool args + tool result (from intermediateSteps).',
                      ]
                    : notes

              llmCalls.push({
                index: idx + 1,
                runtime: 'n8n' as const,
                usage: buildTokenUsage(
                  {
                    inputTokens: inputTokensAdjusted,
                    outputTokens: outputTokensAdjusted,
                  },
                  confidence,
                  sourceLabel,
                ),
                requestPayload,
                requestConfidence:
                  typeof current?.primarySystemPrompt === 'string' &&
                  Array.isArray(current?.compiledMessages)
                    ? idx === 0
                      ? 'near'
                      : 'estimated'
                    : 'estimated',
                responsePayload:
                  toolCallsForCall.length > 0
                    ? { response: '', toolCalls: toolCallsForCall }
                    : idx === callsCount - 1
                      ? { response: responseText ?? '' }
                      : { response: '' },
                responseConfidence: 'speculative',
                finishReason: null,
                toolCallsCount:
                  idx === 0 && typeof resolvedToolCallsCount === 'number'
                    ? resolvedToolCallsCount
                    : undefined,
                notes: callNotes,
              })
            }

            patch.llmCalls = llmCalls

            const usageFromCalls = (() => {
              if (llmCalls.length === 0) return null

              const callInputTokens = llmCalls.map(
                (call) => call?.usage?.inputTokens?.value ?? null,
              )
              const callOutputTokens = llmCalls.map(
                (call) => call?.usage?.outputTokens?.value ?? null,
              )

              const totalInputTokens = sumIfAllNumbers(callInputTokens)
              if (typeof totalInputTokens !== 'number') return null

              const totalOutputTokens = sumIfAllNumbers(callOutputTokens)
              const totalTokens =
                typeof totalInputTokens === 'number' &&
                typeof totalOutputTokens === 'number'
                  ? totalInputTokens + totalOutputTokens
                  : null

              return buildTokenUsage(
                {
                  inputTokens: totalInputTokens ?? undefined,
                  outputTokens: totalOutputTokens ?? undefined,
                  totalTokens: totalTokens ?? undefined,
                },
                confidence,
                sourceLabel,
              )
            })()

            const resolvedTotalUsage =
              preferredKind === 'tokenUsageEstimate' &&
              hasToolStepDeltas &&
              usageFromCalls
                ? usageFromCalls
                : usageFromN8nTotals

            patch.llmSummary = {
              ...(patch.llmSummary ?? {}),
              callsCount: buildTokenStat(
                callsCount,
                confidence === 'exact' ? 'near' : 'estimated',
                'n8n',
              ),
              totalUsage: resolvedTotalUsage,
              breakdownConfidence:
                confidence === 'exact' ? 'near' : 'estimated',
            }

            if (
              baseResponseSummary &&
              typeof baseResponseSummary === 'object'
            ) {
              const notes = Array.isArray((baseResponseSummary as any).notes)
                ? [...(baseResponseSummary as any).notes].filter(
                    (note) =>
                      note !==
                      'n8n did not provide usage totals for this run; token counts are unavailable.',
                  )
                : []

              if (preferredKind === 'tokenUsage') {
                notes.push(
                  'Usage totals loaded from n8n execution data (tokenUsage).',
                )
              } else if (preferredKind === 'tokenUsageEstimate') {
                if (toolEstimate.tokens > 0) {
                  notes.push(
                    `n8n returned tokenUsageEstimate; Batshit added ~${toolEstimate.tokens.toLocaleString()} input tokens for tool definitions (estimate).`,
                  )
                } else if (
                  toolEstimate.toolCount === 0 &&
                  !toolEstimate.error
                ) {
                  notes.push(
                    hasToolStepDeltas
                      ? 'n8n returned tokenUsageEstimate; tool definitions were unavailable for adjustment.'
                      : 'n8n returned tokenUsageEstimate; Dynamic MCP tools resolve schemas on demand, so no static tool-definition adjustment was applied.',
                  )
                } else {
                  notes.push(
                    'n8n returned tokenUsageEstimate; tool definitions were unavailable for adjustment.',
                  )
                }

                if (hasToolStepDeltas) {
                  notes.push(
                    'Call 2+ input tokens estimated using intermediateSteps: previous call input + tool args + tool result.',
                  )
                }
              }

              if (toolEstimate.error) {
                notes.push(`Tool schema estimate failed: ${toolEstimate.error}`)
              }

              const toolCallsCountStat =
                typeof toolCallsCountFromN8n === 'number'
                  ? buildTokenStat(
                      toolCallsCountFromN8n,
                      'exact',
                      'n8n execution',
                    )
                  : (baseResponseSummary as any).toolCallsCount

              const withToolCallNote =
                typeof toolCallsCountFromN8n === 'number'
                  ? [
                      ...notes,
                      'Tool-call count loaded from n8n execution data (intermediateSteps).',
                    ]
                  : notes

              const uniqueNotes = [...new Set(withToolCallNote)]

              patch.responseSummary = {
                ...(baseResponseSummary as any),
                usage: resolvedTotalUsage,
                ...(toolCallsCountStat
                  ? { toolCallsCount: toolCallsCountStat }
                  : {}),
                notes: uniqueNotes,
              }
            }

            hydratedTokenUsage = true
          }
        }
      }
    } catch (err) {
      hydrationError =
        (err as any)?.message || 'Failed to refresh webhook input from n8n API'
      console.warn(
        '[ExecutionLog] Failed to refresh webhook input from n8n API',
        err,
      )
    }
  }

  if (
    (!hydratedIntermediateSteps || hydratedIntermediateSteps.length === 0) &&
    Array.isArray(patch.intermediateSteps) &&
    patch.intermediateSteps.length > 0
  ) {
    hydratedIntermediateSteps = patch.intermediateSteps
  }

  if (hydratedIntermediateSteps && hydratedIntermediateSteps.length > 0) {
    try {
      const existingMessage = await redis.execute((client) =>
        client.json.get(`message:${sessionId}:${snapshotId}`),
      ) as any
      const existingCoolToolRefs = extractCoolToolReferencesFromMessage(existingMessage)

      if (existingCoolToolRefs.length > 0) {
        hydratedZipReferences = existingCoolToolRefs
      } else {
        const agentSettings = current?.agentId
          ? ((await redis.execute((client) =>
              client.json.get(`agent:${current.agentId}`),
            )) as Record<string, any> | null)
          : null
        const userSettings = await redis.getUserSettings(userId).catch(() => null)
        hydratedZipReferences = dedupeZipReferences(
          await adaptCoolToolsToZipSystem(
            hydratedIntermediateSteps,
            sessionId,
            snapshotId,
            agentSettings ?? {},
            userSettings?.global_zip_settings,
          ),
        )
      }

      hydratedZipIds = extractZipIdsFromReferences(hydratedZipReferences)

      if (
        existingMessage &&
        existingMessage.role === 'assistant' &&
        hydratedZipReferences.length > 0
      ) {
        const existingMetadata =
          existingMessage.metadata &&
          typeof existingMessage.metadata === 'object' &&
          !Array.isArray(existingMessage.metadata)
            ? existingMessage.metadata
            : {}
        const existingZipRefs = Array.isArray(existingMetadata.zipReferences)
          ? existingMetadata.zipReferences
          : []
        const existingZipIds = Array.isArray(existingMetadata.zipIds)
          ? existingMetadata.zipIds.filter(
              (id: unknown): id is string => typeof id === 'string' && id.trim().length > 0,
            )
          : []
        const mergedZipReferences = dedupeZipReferences([
          ...existingZipRefs
            .map((entry: any) =>
              typeof entry === 'string'
                ? { zipId: extractZipIdFromReference(entry) ?? undefined, reference: entry }
                : typeof entry?.reference === 'string'
                  ? {
                      ...entry,
                      zipId:
                        typeof entry.zipId === 'string'
                          ? entry.zipId
                          : typeof entry.zip_id === 'string'
                            ? entry.zip_id
                            : extractZipIdFromReference(entry.reference) ?? undefined,
                    }
                  : null,
            )
            .filter((entry: HydratedZipReference | null): entry is HydratedZipReference =>
              Boolean(entry?.reference),
            ),
          ...hydratedZipReferences,
        ])
        const mergedZipIds = Array.from(
          new Set([
            ...existingZipIds,
            ...extractZipIdsFromReferences(mergedZipReferences),
          ]),
        )
        const responseContent =
          typeof patch.responseSummary?.content?.value === 'string'
            ? patch.responseSummary.content.value
            : ''
        const nextContent = mergeZipReferenceContent(
          existingMessage.content || responseContent,
          hydratedZipReferences,
        )

        await redis.updateMessage(
          snapshotId,
          sessionId,
          {
            content: nextContent,
            intermediateSteps: hydratedIntermediateSteps,
            metadata: {
              ...existingMetadata,
              zipIds: mergedZipIds,
              zipReferences: mergedZipReferences,
            },
          } as any,
          userId,
        )
        hydratedMessage = true
      }
    } catch (error) {
      console.warn('[ExecutionLog] Failed to hydrate n8n Cool Tool zips', error)
    }
  }

  if ('webhookStyleInput' in patch) {
    allowed.webhookStyleInput = Array.isArray(patch.webhookStyleInput)
      ? (redactWebhookStyleInput(patch.webhookStyleInput) as any[])
      : null
  }

  if ('llmSummary' in patch) {
    allowed.llmSummary = patch.llmSummary ?? null
  }

  if ('llmCalls' in patch) {
    allowed.llmCalls = Array.isArray(patch.llmCalls) ? patch.llmCalls : null
  }

  if ('intermediateSteps' in patch) {
    allowed.intermediateSteps = Array.isArray(patch.intermediateSteps)
      ? patch.intermediateSteps
      : null
  }

  if ('responseSummary' in patch) {
    allowed.responseSummary = patch.responseSummary ?? null
  }

  if ('webhookInputAvailability' in patch) {
    allowed.webhookInputAvailability =
      patch.webhookInputAvailability &&
      typeof patch.webhookInputAvailability === 'object'
        ? patch.webhookInputAvailability
        : null
  }

  if ('runtime' in patch) {
    const runtimeDetails: ExecutionRuntimeDetails | undefined =
      patch.runtime && typeof patch.runtime === 'object'
        ? patch.runtime
        : undefined
    allowed.runtime = runtimeDetails
  }

  await executionViewerService.updateSnapshot(sessionId, snapshotId, allowed)
  return json({
    success: true,
    hydratedWebhookInput,
    hydratedTokenUsage,
    hydratedIntermediateSteps: hydratedIntermediateSteps ?? null,
    hydratedZipReferences,
    hydratedZipIds,
    hydratedMessage,
    toolSchemaTokenEstimate,
    hydrationError,
  })
}

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const userId = locals.user?.id
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sessionId = params.sessionId
  if (!sessionId) {
    return json({ error: 'Session ID is required' }, { status: 400 })
  }

  const session = await redis.getSession(sessionId)
  if (!session || session.user_id !== userId) {
    return json({ error: 'Session not found' }, { status: 404 })
  }

  await executionViewerService.clearSnapshots(sessionId)
  return json({ success: true })
}
