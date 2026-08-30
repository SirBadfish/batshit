/**
 * SA-106: `n8n` retired with the n8n Primary Agent type. Execution snapshots recorded
 * before the retirement may still carry it as stored data — the Execution Viewer renders
 * those honestly as "n8n Workflow (retired)" via a raw-string check — but nothing writes
 * it any more, so it is out of the live union.
 */
export type ExecutionRuntimeId = 'vercel' | 'codex' | 'claude'

export type ExecutionRuntimeTransport =
  | 'vercel-sdk'
  | 'codex-sdk'
  | 'codex-cli'
  | 'codex-app-server'
  | 'codex-exec'
  | 'claude-sdk'
  | 'claude-cli'
  | 'unknown'

export type ExecutionSandboxMode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access'

export type ExecutionConfidenceLevel =
  | 'exact'
  | 'near'
  | 'estimated'
  | 'speculative'

export type ExecutionAvailabilityLevel =
  | ExecutionConfidenceLevel
  | 'unavailable'
  | 'not-applicable'

export interface ExecutionFieldAvailability {
  state: ExecutionAvailabilityLevel
  source?: string | null
  note?: string | null
}

export interface ExecutionTokenStat {
  value: number | null
  confidence: ExecutionConfidenceLevel
  source?: string
}

export interface ExecutionTokenUsage {
  inputTokens: ExecutionTokenStat
  outputTokens: ExecutionTokenStat
  totalTokens: ExecutionTokenStat
  cachedInputTokens?: ExecutionTokenStat
  cacheCreationInputTokens?: ExecutionTokenStat
  reasoningTokens?: ExecutionTokenStat
}

export interface ExecutionLlmCall {
  index: number // 1-based
  runtime: ExecutionRuntimeId
  usage: ExecutionTokenUsage
  requestPayload: any
  requestConfidence: ExecutionConfidenceLevel
  responsePayload?: any
  /** Raw provider response payload (Mode 3 only). Use for deep debugging. */
  rawResponsePayload?: any
  responseConfidence?: ExecutionConfidenceLevel
  finishReason?: string | null
  toolCallsCount?: number
  toolResultsCount?: number
  notes?: string[]
}

export interface ExecutionLlmSummary {
  callsCount: ExecutionTokenStat
  totalUsage: ExecutionTokenUsage
  breakdownConfidence: ExecutionConfidenceLevel
}

export interface ExecutionResponseSummary {
  content: { value: string; confidence: ExecutionConfidenceLevel }
  usage: ExecutionTokenUsage
  toolCallsCount: ExecutionTokenStat
  notes?: string[]
}

export interface ExecutionRuntimeDetails {
  runtimeId: ExecutionRuntimeId
  providerId?: string | null
  providerDisplayName?: string | null
  connectionId?: string | null
  modelName?: string | null
  transport?: ExecutionRuntimeTransport | null
  sandboxMode?: ExecutionSandboxMode | null
  allowFileEdits?: boolean
  allowNetwork?: boolean
  workingDirectory?: string | null
  eventLog?: any[] | null
  eventCount?: number | null
  metadata?: Record<string, any> | null
  status?: 'pending' | 'running' | 'succeeded' | 'failed'
  error?: string | null
}

export interface ExecutionSnapshot {
  id: string
  sessionId: string
  userId: string
  agentId: string | null
  agentName: string
  agentType?: string
  createdAt: string
  userMessage?: string
  structuredInput: any
  primarySystemPrompt?: string
  subagentPrompts?: Record<string, string>
  subagentDescription?: Record<string, string>
  compiledMessages?: Array<{ role: string; content: any }>
  compileMetadata?: Record<string, any>
  executionMetadata?: Record<string, any>
  /** n8n-style webhook input: [{ headers, params, query, body }] */
  webhookStyleInput?: any[] | null
  /** Explicit capture state for n8n webhook input visibility in the sheet. */
  webhookInputAvailability?: ExecutionFieldAvailability | null
  /** LLM calls captured for token transparency (exact for Mode 3; best-effort elsewhere) */
  llmSummary?: ExecutionLlmSummary | null
  llmCalls?: ExecutionLlmCall[] | null
  /** Tool-step payloads captured for per-tool activity review across modes. */
  intermediateSteps?: any[] | null
  /** Final response summary (assistant output, tool counts, usage) */
  responseSummary?: ExecutionResponseSummary | null
  selectedGateways?: string[] | null
  selectedTools?: string[] | null
  mcpToolSelections?: import('$lib/types/database').MCPToolSelections | null
  defaultGateways?: string[] | null
  gatewayToolMap?: Record<string, string[]> | null
  voiceMetadata?: Record<string, any>
  assignedSubagents?: any[]
  availableWorkflows?: string[]
  runtime?: ExecutionRuntimeDetails
}
