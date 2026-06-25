import { redis } from '$lib/server/redis'
import type { CanonicalStreamEvent } from '$lib/server/services/streamEventAdapter'

const ARTIFACT_RUN_LOG_TTL_SECONDS = 60 * 60 * 24 * 14
const ARTIFACT_RUN_INDEX_LIMIT = 75
const ARTIFACT_RUN_EVENT_LIMIT = 200

export type ArtifactRunStatus = 'running' | 'success' | 'error'

export interface ArtifactRunLogRecord {
  version: 1
  runId: string
  userId: string
  artifactId: string
  artifactName: string | null
  artifactVersion: number | null
  status: ArtifactRunStatus
  startedAt: string
  updatedAt: string
  completedAt: string | null
  durationMs: number | null
  sessionId: string
  messageId: string
  request: {
    mode: string
    brainType: string
    requestedModel: string | null
    promptChars: number
    promptPreview: string | null
    promptOmittedChars: number
    contextKeys: string[]
    fieldKeys: string[]
    options: Record<string, any>
  }
  model: {
    role: string | null
    configuredSource: string | null
    resolvedModel: string | null
    requestModel: string | null
    connectionType: string | null
    connectionService: string | null
    purpose: string | null
    providerSettingKeys: string[]
    chosenTransport: string | null
  }
  result: {
    eventCount: number
    chunkChars: number
    thinkingChars: number
    fileCount: number
    fileMediaTypes: string[]
    fileApproxBytes: number
    audioCount: number
    audioMediaTypes: string[]
    audioApproxBytes: number
    objectPartialCount: number
    objectFinalCount: number
    zipReferenceCount: number
    usage: Record<string, any> | null
    finishReason: string | null
  }
  errors: Array<{
    at: string
    message: string
    source: string
    name?: string | null
    code?: string | null
    stackPreview?: string[]
  }>
  events: ArtifactRunEventSummary[]
}

export interface ArtifactRunEventSummary {
  at: string
  type: string
  summary: Record<string, any>
}

export interface StartArtifactRunLogInput {
  runId: string
  userId: string
  artifactId: string
  artifactName?: string | null
  artifactVersion?: number | null
  sessionId: string
  messageId: string
  mode: string
  brainType: string
  requestedModel?: string | null
  prompt?: string | null
  promptChars: number
  context?: unknown
  fields?: Record<string, any> | null
  requestOptions?: Record<string, any>
}

export interface MarkArtifactRunPreparedInput {
  userId: string
  artifactId: string
  runId: string
  role: string
  configuredSource: string | null
  resolvedModel: string | null
  requestModel: string | null
  connectionType?: string | null
  connectionService?: string | null
  purpose?: string | null
  providerSettings?: Record<string, any> | null
  chosenTransport: string
}

export interface FinishArtifactRunLogInput {
  userId: string
  artifactId: string
  runId: string
  status: ArtifactRunStatus
  errorMessage?: string | null
  error?: unknown
  source?: string
}

function runLogKey(userId: string, artifactId: string, runId: string): string {
  return `artifact_run:${userId}:${artifactId}:${runId}`
}

function artifactRunIndexKey(userId: string, artifactId: string): string {
  return `artifact_runs:${userId}:${artifactId}`
}

function recentRunIndexKey(userId: string): string {
  return `artifact_runs:${userId}:recent`
}

function truncateString(value: string, max = 240): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}...`
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/data:[^,\s]+;base64,[A-Za-z0-9+/=]+/gi, '[data-url omitted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [omitted]')
    .replace(
      /\b(api[_-]?key|authorization|token|secret|password|credential|cookie)\b\s*[:=]\s*["']?[^"'\s,;}]+/gi,
      '$1=[omitted]'
    )
    .replace(/[A-Za-z0-9+/]{180,}={0,2}/g, '[long-base64 omitted]')
}

function buildPromptPreview(prompt?: string | null): { preview: string | null; omittedChars: number } {
  if (typeof prompt !== 'string' || prompt.length === 0) {
    return { preview: null, omittedChars: 0 }
  }
  const compact = redactSensitiveText(prompt).replace(/\s+/g, ' ').trim()
  const max = 240
  return {
    preview: truncateString(compact, max),
    omittedChars: Math.max(0, prompt.length - max)
  }
}

function isSensitiveKey(key: string): boolean {
  return /(api[_-]?key|authorization|bearer|token|secret|password|credential|cookie|base64|audioData|imageData|dataUrl|data_url)/i.test(
    key
  )
}

function safeString(value: string): string {
  if (/^data:/i.test(value)) return '[data-url omitted]'
  return truncateString(value)
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null
  if (typeof value === 'string') return safeString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    if (depth >= 2) return { arrayLength: value.length }
    return value.slice(0, 12).map((entry) => sanitizeValue(entry, depth + 1))
  }
  if (typeof value === 'object') {
    if (depth >= 2) return { objectKeys: Object.keys(value as Record<string, unknown>).slice(0, 20) }
    const output: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        output[key] = '[omitted]'
        continue
      }
      output[key] = sanitizeValue(child, depth + 1)
    }
    return output
  }
  return String(value)
}

function sanitizeStackLine(value: string): string {
  return redactSensitiveText(value)
    .replace(/\/Users\/[^)\s]+/g, '[local-path]')
    .replace(/[A-Za-z]:\\[^)\s]+/g, '[local-path]')
}

function buildStackPreview(error: unknown): string[] | undefined {
  if (!error || typeof error !== 'object') return undefined
  const stack = (error as { stack?: unknown }).stack
  if (typeof stack !== 'string' || !stack.trim()) return undefined
  return stack
    .split('\n')
    .map((line) => sanitizeStackLine(line.trim()))
    .filter(Boolean)
    .slice(0, 5)
}

function errorCodeFrom(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const candidate = (error as { code?: unknown; status?: unknown; statusCode?: unknown }).code ??
    (error as { status?: unknown }).status ??
    (error as { statusCode?: unknown }).statusCode
  if (typeof candidate === 'string' && candidate.trim()) return truncateString(candidate.trim(), 120)
  if (typeof candidate === 'number') return String(candidate)
  return null
}

function summarizeError(input: {
  at: string
  message: string
  source: string
  error?: unknown
}): ArtifactRunLogRecord['errors'][number] {
  const error = input.error
  const name =
    error && typeof error === 'object' && typeof (error as { name?: unknown }).name === 'string'
      ? truncateString(String((error as { name: string }).name), 120)
      : null
  const code = errorCodeFrom(error)
  const stackPreview = buildStackPreview(error)
  return {
    at: input.at,
    message: truncateString(redactSensitiveText(input.message), 500),
    source: input.source,
    ...(name ? { name } : {}),
    ...(code ? { code } : {}),
    ...(stackPreview?.length ? { stackPreview } : {})
  }
}

function estimateBase64Bytes(value: unknown): number {
  if (typeof value !== 'string') return 0
  const base64 = value.includes(',') ? value.split(',').pop() || '' : value
  return Math.max(0, Math.floor((base64.length * 3) / 4))
}

function keysOfRecord(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.keys(value as Record<string, unknown>).sort()
}

function summarizeRequestOptions(options: Record<string, any> = {}): Record<string, any> {
  const providerOptions = options.providerOptions
  return {
    n: options.n ?? null,
    size: options.size ?? null,
    aspectRatio: options.aspectRatio ?? null,
    imageCount: Array.isArray(options.images) ? options.images.length : 0,
    imageMediaTypes: Array.isArray(options.images)
      ? options.images.map((entry: any) => entry?.mediaType || null).filter(Boolean)
      : [],
    providerOptionKeys: keysOfRecord(providerOptions),
    providerOptionNestedKeys:
      providerOptions && typeof providerOptions === 'object'
        ? Object.fromEntries(
            Object.entries(providerOptions).map(([key, value]) => [key, keysOfRecord(value)])
          )
        : {},
    hasSchema: Boolean(options.schema),
    schemaName: typeof options.schemaName === 'string' ? options.schemaName : null,
    voice: typeof options.voice === 'string' ? options.voice : null,
    language: typeof options.language === 'string' ? options.language : null,
    instructionsChars: typeof options.instructions === 'string' ? options.instructions.length : 0
  }
}

function summarizeEvent(event: CanonicalStreamEvent | Record<string, any>): ArtifactRunEventSummary {
  const type = String(event?.type || 'unknown')
  const summary: Record<string, any> = {}

  if (typeof event.content === 'string') {
    summary.contentChars = event.content.length
  }
  if (typeof event.error === 'string') {
    summary.error = truncateString(event.error, 500)
  }
  if (typeof event.mediaType === 'string') {
    summary.mediaType = event.mediaType
  }
  if (typeof event.index === 'number') {
    summary.index = event.index
  }
  if (typeof event.base64 === 'string') {
    summary.omittedBase64Chars = event.base64.length
    summary.approxBytes = estimateBase64Bytes(event.base64)
  }
  if (typeof event.audioData === 'string') {
    summary.omittedAudioChars = event.audioData.length
    summary.approxBytes = estimateBase64Bytes(event.audioData)
  }
  if (event.usage && typeof event.usage === 'object') {
    summary.usage = sanitizeValue(event.usage)
  }
  if (Array.isArray(event.zipReferences)) {
    summary.zipReferenceCount = event.zipReferences.length
  }
  if (event.metadata && typeof event.metadata === 'object') {
    summary.metadata = sanitizeValue(event.metadata)
  }
  if (event.object !== undefined) {
    summary.objectShape = sanitizeValue(event.object, 2)
  }

  return {
    at: new Date().toISOString(),
    type,
    summary
  }
}

function applyEventStats(record: ArtifactRunLogRecord, event: Record<string, any>, summary: ArtifactRunEventSummary) {
  record.result.eventCount += 1

  if (event.type === 'chunk' && typeof event.content === 'string') {
    record.result.chunkChars += event.content.length
  }
  if (event.type === 'thinking' && typeof event.content === 'string') {
    record.result.thinkingChars += event.content.length
  }
  if (event.type === 'file') {
    record.result.fileCount += 1
    if (typeof event.mediaType === 'string' && !record.result.fileMediaTypes.includes(event.mediaType)) {
      record.result.fileMediaTypes.push(event.mediaType)
    }
    record.result.fileApproxBytes += estimateBase64Bytes(event.base64)
  }
  if (event.type === 'audio') {
    record.result.audioCount += 1
    if (typeof event.mediaType === 'string' && !record.result.audioMediaTypes.includes(event.mediaType)) {
      record.result.audioMediaTypes.push(event.mediaType)
    }
    record.result.audioApproxBytes += estimateBase64Bytes(event.audioData)
  }
  if (event.type === 'object_partial') {
    record.result.objectPartialCount += 1
  }
  if (event.type === 'object_final') {
    record.result.objectFinalCount += 1
  }
  if (event.type === 'finish') {
    record.result.usage = sanitizeValue(event.usage ?? summary.summary.usage ?? null) as Record<string, any> | null
    record.result.finishReason =
      typeof event.finishReason === 'string'
        ? event.finishReason
        : typeof event.metadata?.finishReason === 'string'
          ? event.metadata.finishReason
          : record.result.finishReason
  }
  if (event.type === 'end') {
    record.result.zipReferenceCount = Array.isArray(event.zipReferences) ? event.zipReferences.length : 0
  }
  if (event.type === 'error') {
    record.errors.push({
      at: summary.at,
      message: typeof event.error === 'string' ? truncateString(event.error, 500) : 'Artifact run error',
      source: 'server_stream'
    })
  }
}

async function readRunRecord(
  client: any,
  userId: string,
  artifactId: string,
  runId: string
): Promise<ArtifactRunLogRecord | null> {
  const record = await client.json.get(runLogKey(userId, artifactId, runId)).catch(() => null)
  return record && typeof record === 'object' ? (record as ArtifactRunLogRecord) : null
}

export async function startArtifactRunLog(input: StartArtifactRunLogInput): Promise<void> {
  try {
    const now = new Date().toISOString()
    const promptPreview = buildPromptPreview(input.prompt)
    const record: ArtifactRunLogRecord = {
      version: 1,
      runId: input.runId,
      userId: input.userId,
      artifactId: input.artifactId,
      artifactName: input.artifactName ?? null,
      artifactVersion: input.artifactVersion ?? null,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      durationMs: null,
      sessionId: input.sessionId,
      messageId: input.messageId,
      request: {
        mode: input.mode,
        brainType: input.brainType,
        requestedModel: input.requestedModel ?? null,
        promptChars: input.promptChars,
        promptPreview: promptPreview.preview,
        promptOmittedChars: promptPreview.omittedChars,
        contextKeys: keysOfRecord(input.context),
        fieldKeys: keysOfRecord(input.fields),
        options: summarizeRequestOptions(input.requestOptions)
      },
      model: {
        role: null,
        configuredSource: null,
        resolvedModel: null,
        requestModel: input.requestedModel ?? null,
        connectionType: null,
        connectionService: null,
        purpose: null,
        providerSettingKeys: [],
        chosenTransport: null
      },
      result: {
        eventCount: 0,
        chunkChars: 0,
        thinkingChars: 0,
        fileCount: 0,
        fileMediaTypes: [],
        fileApproxBytes: 0,
        audioCount: 0,
        audioMediaTypes: [],
        audioApproxBytes: 0,
        objectPartialCount: 0,
        objectFinalCount: 0,
        zipReferenceCount: 0,
        usage: null,
        finishReason: null
      },
      errors: [],
      events: []
    }

    await redis.execute(async (client) => {
      const key = runLogKey(input.userId, input.artifactId, input.runId)
      const artifactIndex = artifactRunIndexKey(input.userId, input.artifactId)
      const recentIndex = recentRunIndexKey(input.userId)
      const recentEntry = `${input.artifactId}:${input.runId}`
      await client.json.set(key, '$', record as any)
      await client.lPush(artifactIndex, input.runId)
      await client.lTrim(artifactIndex, 0, ARTIFACT_RUN_INDEX_LIMIT - 1)
      await client.lPush(recentIndex, recentEntry)
      await client.lTrim(recentIndex, 0, ARTIFACT_RUN_INDEX_LIMIT - 1)
      await client.expire(key, ARTIFACT_RUN_LOG_TTL_SECONDS)
      await client.expire(artifactIndex, ARTIFACT_RUN_LOG_TTL_SECONDS)
      await client.expire(recentIndex, ARTIFACT_RUN_LOG_TTL_SECONDS)
    })
  } catch (error) {
    console.warn('[ArtifactRunLogs] Failed to start run log:', error)
  }
}

export async function markArtifactRunPrepared(input: MarkArtifactRunPreparedInput): Promise<void> {
  try {
    await redis.execute(async (client) => {
      const record = await readRunRecord(client, input.userId, input.artifactId, input.runId)
      if (!record) return
      record.model = {
        role: input.role,
        configuredSource: input.configuredSource,
        resolvedModel: input.resolvedModel,
        requestModel: input.requestModel,
        connectionType: input.connectionType ?? null,
        connectionService: input.connectionService ?? null,
        purpose: input.purpose ?? null,
        providerSettingKeys: keysOfRecord(input.providerSettings),
        chosenTransport: input.chosenTransport
      }
      record.updatedAt = new Date().toISOString()
      await client.json.set(runLogKey(input.userId, input.artifactId, input.runId), '$', record as any)
    })
  } catch (error) {
    console.warn('[ArtifactRunLogs] Failed to mark run prepared:', error)
  }
}

export async function recordArtifactRunEvent(
  userId: string,
  artifactId: string,
  runId: string,
  event: CanonicalStreamEvent | Record<string, any>
): Promise<void> {
  try {
    const summary = summarizeEvent(event)
    await redis.execute(async (client) => {
      const record = await readRunRecord(client, userId, artifactId, runId)
      if (!record) return
      record.events.push(summary)
      if (record.events.length > ARTIFACT_RUN_EVENT_LIMIT) {
        record.events = record.events.slice(record.events.length - ARTIFACT_RUN_EVENT_LIMIT)
      }
      applyEventStats(record, event, summary)
      record.updatedAt = summary.at
      await client.json.set(runLogKey(userId, artifactId, runId), '$', record as any)
    })
  } catch (error) {
    console.warn('[ArtifactRunLogs] Failed to append run event:', error)
  }
}

export async function finishArtifactRunLog(input: FinishArtifactRunLogInput): Promise<void> {
  try {
    await redis.execute(async (client) => {
      const record = await readRunRecord(client, input.userId, input.artifactId, input.runId)
      if (!record) return
      const now = new Date().toISOString()
      record.status = input.status
      record.updatedAt = now
      record.completedAt = now
      record.durationMs = Math.max(0, Date.parse(now) - Date.parse(record.startedAt))
      if (input.errorMessage) {
        record.errors.push(summarizeError({
          at: now,
          message: input.errorMessage,
          source: input.source ?? 'server',
          error: input.error
        }))
      }
      await client.json.set(runLogKey(input.userId, input.artifactId, input.runId), '$', record as any)
      await client.expire(runLogKey(input.userId, input.artifactId, input.runId), ARTIFACT_RUN_LOG_TTL_SECONDS)
    })
  } catch (error) {
    console.warn('[ArtifactRunLogs] Failed to finish run log:', error)
  }
}

export async function recordArtifactClientRunEvent(input: {
  userId: string
  artifactId: string
  runId: string
  eventType: string
  message?: string | null
  details?: Record<string, any> | null
}): Promise<void> {
  const safeEvent = {
    type: `client_${input.eventType || 'event'}`,
    error: input.message ?? undefined,
    metadata: sanitizeValue(input.details ?? {}) as Record<string, any>
  }
  await recordArtifactRunEvent(input.userId, input.artifactId, input.runId, safeEvent)
}

export function summarizeArtifactRun(record: ArtifactRunLogRecord): Record<string, any> {
  const lastEvent = record.events[record.events.length - 1] ?? null
  const requestModel =
    record.model.requestModel ??
    (record.model as unknown as { requestedModelOverride?: string | null }).requestedModelOverride ??
    record.request.requestedModel ??
    null
  return {
    runId: record.runId,
    artifactId: record.artifactId,
    artifactName: record.artifactName,
    sessionId: record.sessionId,
    messageId: record.messageId,
    status: record.status,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    durationMs: record.durationMs,
    mode: record.request.mode,
    chosenTransport: record.model.chosenTransport,
    model: record.model.resolvedModel,
    modelSource: record.model.configuredSource,
    requestModel,
    promptPreview: record.request.promptPreview ?? null,
    promptChars: record.request.promptChars,
    promptOmittedChars: record.request.promptOmittedChars ?? 0,
    fileCount: record.result.fileCount,
    fileMediaTypes: record.result.fileMediaTypes,
    chunkChars: record.result.chunkChars,
    objectPartialCount: record.result.objectPartialCount,
    errorCount: record.errors.length,
    lastError: record.errors[record.errors.length - 1]?.message ?? null,
    lastEventType: lastEvent?.type ?? null
  }
}

export async function listArtifactRunLogs(options: {
  userId: string
  artifactId: string
  limit?: number
}): Promise<Array<Record<string, any>>> {
  const limit = Math.min(Math.max(1, options.limit ?? 20), ARTIFACT_RUN_INDEX_LIMIT)
  return await redis.execute(async (client) => {
    const runIds = await client.lRange(artifactRunIndexKey(options.userId, options.artifactId), 0, limit - 1)
    const records = await Promise.all(
      runIds.map((runId) => readRunRecord(client, options.userId, options.artifactId, runId))
    )
    return records.filter(Boolean).map((record) => summarizeArtifactRun(record as ArtifactRunLogRecord))
  })
}

export async function getArtifactRunLog(options: {
  userId: string
  artifactId: string
  runId: string
}): Promise<ArtifactRunLogRecord | null> {
  return await redis.execute(async (client) => {
    return await readRunRecord(client, options.userId, options.artifactId, options.runId)
  })
}

export async function deleteArtifactRunLogs(options: {
  userId: string
  artifactId: string
}): Promise<void> {
  await redis.execute(async (client) => {
    const artifactIndex = artifactRunIndexKey(options.userId, options.artifactId)
    const recentIndex = recentRunIndexKey(options.userId)
    const runIds = await client.lRange(artifactIndex, 0, -1)
    const recentEntries = await client.lRange(recentIndex, 0, -1)
    const remainingRecentEntries = recentEntries.filter(
      (entry) => !entry.startsWith(`${options.artifactId}:`)
    )
    const logKeys = runIds.map((runId) => runLogKey(options.userId, options.artifactId, runId))

    if (logKeys.length > 0) {
      await client.del(logKeys)
    }
    await client.del(artifactIndex)
    await client.del(recentIndex)
    if (remainingRecentEntries.length > 0) {
      await client.rPush(recentIndex, remainingRecentEntries)
      await client.expire(recentIndex, ARTIFACT_RUN_LOG_TTL_SECONDS)
    }
  })
}
