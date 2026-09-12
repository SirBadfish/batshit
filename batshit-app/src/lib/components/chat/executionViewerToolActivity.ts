import type { ExecutionConfidenceLevel } from '$lib/types/executionViewer'
import type { ExecutionLlmCall } from '$lib/types/executionViewer'
import {
  formatBatshitToolTargetDisplayName,
  formatToolDisplayName
} from '$lib/utils/toolNameFormatter'
import { estimateTokens } from '$lib/utils/tokens'
import { estimateCoolToolAiTokens } from '$lib/utils/coolToolAiContent'

export type ExecutionToolActivityStatus = 'success' | 'error' | 'partial'

export interface ExecutionToolActivityEntry {
  index: number
  toolCallId?: string | null
  rawToolName: string
  displayName: string
  status: ExecutionToolActivityStatus
  input: any
  output: any
  tokenEstimate: number | null
  tokenConfidence: ExecutionConfidenceLevel
  durationMs: number | null
  timestamp: string | number | null
  notes: string[]
}

function safeKey(value: any): string {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return String(value ?? '')
  }
}

function lastNonEmptySegment(value: string, separator: string): string {
  const parts = value.split(separator).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1]! : value
}

function extractRawToolName(step: any): string {
  const candidates = [
    step?.executedToolName,
    step?.displayToolName,
    step?.toolName,
    step?.tool,
    step?.originalToolName,
    step?.action?.tool,
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate
    }
  }

  return 'tool'
}

/** The broker tool names a Fabric/artifact/CLI call arrives under. */
const BROKER_TOOL_NAMES = new Set(['native_batshit_tool_use', 'batshit_tool_use'])

/**
 * SA-116 (DL-116-12) — the ref a broker step actually ran.
 *
 * A broker step is COMPACTED before it reaches a renderer: `toolArgs` becomes
 * `{ref, target}` and the real input moves under `toolResult.input`. So the ref is read
 * from several shapes, and an unknown one falls back to the broker's own display name
 * rather than guessing.
 */
function extractBrokerRef(step: any): string {
  const candidates = [
    step?.toolArgs?.ref,
    step?.toolInput?.ref,
    step?.args?.ref,
    step?.input?.ref,
    step?.toolResult?.ref,
    step?.toolResult?.input?.ref,
    step?.output?.ref,
    step?.result?.ref
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
  }
  const target = step?.toolArgs?.target ?? step?.toolResult?.target ?? step?.output?.target
  return typeof target === 'string' ? target.trim() : ''
}

function formatExecutionToolName(rawToolName: string, step: any): string {
  if (BROKER_TOOL_NAMES.has(rawToolName)) {
    // Until SA-116 every Fabric call in the Execution Viewer read "Dynamic Tool Use",
    // because the raw broker name is what the step carries. The control is the thing Josh
    // is looking for.
    const controlName = formatBatshitToolTargetDisplayName(extractBrokerRef(step))
    if (controlName) return controlName
  }
  if (rawToolName === 'Agent') return 'Subagent'
  if (rawToolName === 'ToolSearch') return 'Tool Search'
  if (
    rawToolName === 'claude_web_search' ||
    rawToolName === 'codex_web_search' ||
    rawToolName === 'web_search' ||
    rawToolName === 'websearch'
  ) {
    return 'Web Search'
  }

  if (
    rawToolName === 'batshit_server_execute_command' ||
    rawToolName === 'execute_command'
  ) {
    return 'Bash'
  }

  if (rawToolName.startsWith('mcp__')) {
    return formatToolDisplayName(lastNonEmptySegment(rawToolName, '__'))
  }

  if (rawToolName.startsWith('mcp.')) {
    return formatToolDisplayName(lastNonEmptySegment(rawToolName, '.'))
  }

  const executedToolName =
    typeof step?.executedToolName === 'string' && step.executedToolName.trim().length > 0
      ? step.executedToolName
      : null

  if (executedToolName) {
    return formatToolDisplayName(executedToolName)
  }

  return formatToolDisplayName(rawToolName)
}

function extractToolInput(step: any): any {
  if (!step || typeof step !== 'object') return null

  return (
    step.toolInput ??
    step.toolArgs ??
    step.args ??
    step.input ??
    step.action?.toolInput ??
    step.action?.tool_input ??
    step.action?.input ??
    step.action?.messageLog?.find?.((entry: any) => entry?.kwargs?.content)?.kwargs?.content ??
    null
  )
}

function extractToolOutput(step: any): any {
  if (!step || typeof step !== 'object') return null

  return (
    step.toolResult ??
    step.toolOutput ??
    step.observation ??
    step.output ??
    step.result ??
    null
  )
}

function detectStatus(step: any, output: any): ExecutionToolActivityStatus {
  if (step?.type === 'tool_error') return 'error'
  if (typeof step?.error === 'string' && step.error.trim().length > 0) return 'error'
  if (
    output &&
    typeof output === 'object' &&
    !Array.isArray(output) &&
    typeof (output as Record<string, any>).error === 'string' &&
    (output as Record<string, any>).error.trim().length > 0
  ) {
    return 'error'
  }
  return 'success'
}

function estimateToolPayloadTokens(step: any): number | null {
  if (!step || typeof step !== 'object') return null
  const promptTokens =
    step.promptTokens ??
    step.aiTokens ??
    step.metadata?.promptTokens ??
    step.metadata?.aiTokens ??
    (step.metadata?.tokenBasis === 'ai_expanded' ? step.tokens : undefined)
  if (typeof promptTokens === 'number' && Number.isFinite(promptTokens)) {
    return Math.max(0, Math.trunc(promptTokens))
  }

  try {
    return estimateCoolToolAiTokens(
      String(step.toolCallId || step.id || 'execution-tool'),
      {
        content: JSON.stringify(step),
        metadata: step.metadata || {}
      },
      step
    )
  } catch {
    return null
  }
}

export function buildExecutionToolActivityEntries(params: {
  steps?: any[] | null | undefined
  llmCalls?: ExecutionLlmCall[] | null | undefined
}): ExecutionToolActivityEntry[] {
  const steps = Array.isArray(params.steps) ? params.steps : []
  const llmCalls = Array.isArray(params.llmCalls) ? params.llmCalls : []

  const stepEntries = steps
    .map((step, index) => {
      const rawToolName = extractRawToolName(step)
      const input = extractToolInput(step)
      const output = extractToolOutput(step)
      const status = detectStatus(step, output)
      const notes: string[] = []

      if (
        typeof step?.originalToolName === 'string' &&
        step.originalToolName.trim().length > 0 &&
        step.originalToolName !== rawToolName
      ) {
        notes.push(`Original tool: ${step.originalToolName}`)
      }

      if (
        typeof step?.executedToolName === 'string' &&
        step.executedToolName.trim().length > 0 &&
        step.executedToolName !== rawToolName
      ) {
        notes.push(`Executed tool: ${step.executedToolName}`)
      }

      if (typeof step?.error === 'string' && step.error.trim().length > 0) {
        notes.push(step.error)
      }

      return {
        index: index + 1,
        toolCallId:
          typeof step?.toolCallId === 'string' && step.toolCallId.trim().length > 0
            ? step.toolCallId
            : typeof step?.action?.toolCallId === 'string' &&
                step.action.toolCallId.trim().length > 0
              ? step.action.toolCallId
              : null,
        rawToolName,
        displayName: formatExecutionToolName(rawToolName, step),
        status,
        input,
        output,
        tokenEstimate: estimateToolPayloadTokens(step),
        tokenConfidence: 'estimated',
        durationMs:
          typeof step?.executionTime === 'number' && Number.isFinite(step.executionTime)
            ? Math.max(0, Math.trunc(step.executionTime))
            : typeof step?.execution_time === 'number' &&
                Number.isFinite(step.execution_time)
              ? Math.max(0, Math.trunc(step.execution_time))
              : null,
        timestamp:
          typeof step?.timestamp === 'number' || typeof step?.timestamp === 'string'
            ? step.timestamp
            : null,
        notes,
      } satisfies ExecutionToolActivityEntry
    })
    .filter((entry) => Boolean(entry.rawToolName))

  const seenFingerprints = new Set(
    stepEntries.map((entry) =>
      entry.toolCallId && entry.toolCallId.trim().length > 0
        ? `id:${entry.toolCallId}`
        : `${entry.rawToolName}:${safeKey(entry.input)}`,
    ),
  )

  const fallbackEntries: ExecutionToolActivityEntry[] = []
  for (const call of llmCalls) {
    const responsePayload =
      call?.responsePayload && typeof call.responsePayload === 'object'
        ? call.responsePayload
        : null
    const toolCalls = Array.isArray(responsePayload?.toolCalls)
      ? responsePayload.toolCalls
      : []

    for (const toolCall of toolCalls) {
      const rawToolName =
        typeof toolCall?.name === 'string' && toolCall.name.trim().length > 0
          ? toolCall.name
          : 'tool'
      const input = toolCall?.args ?? {}
      const toolCallId =
        typeof toolCall?.toolCallId === 'string' && toolCall.toolCallId.trim().length > 0
          ? toolCall.toolCallId
          : null
      const fingerprint =
        toolCallId && toolCallId.trim().length > 0
          ? `id:${toolCallId}`
          : `${rawToolName}:${safeKey(input)}`
      if (seenFingerprints.has(fingerprint)) continue
      seenFingerprints.add(fingerprint)

      fallbackEntries.push({
        index: 0,
        toolCallId,
        rawToolName,
        displayName: formatExecutionToolName(rawToolName, toolCall),
        status: 'partial',
        input,
        output: {
          note:
            'Tool call was captured in the provider trace, but no matching tool-result payload was stored in intermediateSteps for this run.',
        },
        tokenEstimate: estimateTokens(safeKey(input)),
        tokenConfidence: 'estimated',
        durationMs: null,
        timestamp: null,
        notes: [
          'Tool result payload unavailable in Execution Viewer; provider tool-call trace only.',
        ],
      })
    }
  }

  return [...stepEntries, ...fallbackEntries].map((entry, index) => ({
    ...entry,
    index: index + 1,
  }))
}
