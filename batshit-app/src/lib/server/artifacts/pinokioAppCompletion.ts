/** Pinokio-only in-process completion owner, shared by the panel and Fabric. */
import { error } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { generateMessageId } from '$lib/utils/messageId'
import { readPinokioArtifactBinding } from '$lib/artifacts/pinokioArtifact'
import { StreamEventAdapter } from '$lib/server/services/streamEventAdapter'
import { ownPinokioOperation, pinokioBindingFingerprint } from '$lib/server/services/pinokioAdmission'
import { enterBackupRestoreHttpRequest } from '$lib/server/services/backupRestoreService'
import { PinokioAppRunError, runPinokioAppArtifact } from '$lib/server/services/pinokioAppRunner'
import { finishArtifactRunLog, markArtifactRunPrepared, recordArtifactRunEvent, startArtifactRunLog } from './artifactRunLogs'

interface PinokioCompletionInput {
  artifact: any
  userId: string
  prompt: string
  sessionId?: string
  mode?: string
  fields?: Record<string, unknown> | null
  context?: unknown
  signal?: AbortSignal
  /** Already-admitted Fabric actor/scope/Stop, supplied only by its server caller. */
  admit?: () => Promise<void>
}

function failureMessage(cause: unknown): string {
  if (typeof cause === 'string' && cause.trim()) return cause
  if (cause && typeof cause === 'object') {
    const value = cause as { message?: unknown; body?: { message?: unknown } }
    if (typeof value.message === 'string') return value.message
    if (typeof value.body?.message === 'string') return value.body.message
  }
  return 'Pinokio app completion failed'
}

function validatePayload(input: PinokioCompletionInput) {
  let files = 0
  const redact = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (typeof entry !== 'string' || !entry.startsWith('data:')) return [key, entry]
      files += entry.length
      return [key, `[data url ${entry.length} chars]`]
    }))
  }
  const text = JSON.stringify({ artifactId: input.artifact?.id, prompt: input.prompt, fields: redact(input.fields), context: redact(input.context), mode: input.mode, sessionId: input.sessionId })
  if (files > 30_000_000) throw error(413, 'Artifact image input payload too large')
  if (text.length > 20_000) throw error(413, 'Artifact completion payload too large')
}

export async function completePinokioAppArtifact(input: PinokioCompletionInput): Promise<Response> {
  validatePayload(input)
  const { artifact, userId } = input
  const artifactId = artifact?.id
  const binding = readPinokioArtifactBinding(artifact)
  if (!binding || artifact.brain_type !== 'pinokio_app') throw error(400, 'This artifact has no valid Pinokio app binding.')
  if (!userId || artifact.user_id !== userId) throw error(403, 'Only the owner may run a Pinokio app artifact.')
  if (typeof input.prompt !== 'string' || !input.prompt) throw error(400, 'artifactId and prompt are required')
  const fingerprint = pinokioBindingFingerprint(artifact)
  const endWork = enterBackupRestoreHttpRequest()
  if (!endWork) throw error(503, 'Pinokio operations are paused while Batshit restores data.')
  const client = new AbortController()
  const abortOriginal = () => client.abort(input.signal?.reason)
  input.signal?.addEventListener('abort', abortOriginal, { once: true })
  if (input.signal?.aborted) abortOriginal()
  let operation: ReturnType<typeof ownPinokioOperation> | undefined
  let runId: string | undefined
  let startedLog = false
  try {
    operation = ownPinokioOperation({ signal: client.signal, admit: async () => {
      await input.admit?.()
      const current = await redis.json.get(`artifact:${artifactId}`) as any
      if (!current || current.user_id !== userId || current.brain_type !== 'pinokio_app' || !readPinokioArtifactBinding(current) || pinokioBindingFingerprint(current) !== fingerprint) {
        throw error(409, 'The saved Pinokio artifact was deleted, changed owner, or rebound. Run it again.')
      }
    } })
    await operation.assert()
    // Same completion limit/key as the existing Artifact route, exactly once on this path.
    const rateKey = `ratelimit:artifact:${userId}:${artifactId}`
    const count = await redis.incr(rateKey)
    if (count === 1) await redis.expire(rateKey, 60)
    if (count > 10) throw error(429, 'Rate limit exceeded')
    const sessionId = input.sessionId || `artifact:${artifactId}:${userId}`
    const messageId = (await generateMessageId(sessionId)) || crypto.randomUUID()
    runId = crypto.randomUUID()
    await startArtifactRunLog({ runId, userId, artifactId, artifactName: artifact.name ?? null, artifactVersion: typeof artifact.version === 'number' ? artifact.version : null,
      sessionId, messageId, mode: input.mode ?? 'complete', brainType: 'pinokio_app', requestedModel: null, prompt: input.prompt, promptChars: input.prompt.length, context: input.context, fields: input.fields })
    startedLog = true
    await markArtifactRunPrepared({ userId, artifactId, runId, role: 'primary', configuredSource: null, resolvedModel: null, requestModel: null, connectionService: 'pinokio', chosenTransport: 'pinokio-app' })
    await operation.assert()
    const ownedOperation = operation
    const ownedRunId = runId
    let streamController!: TransformStreamDefaultController<Uint8Array>
    const stream = new TransformStream<Uint8Array, Uint8Array>({ start(controller) { streamController = controller } })
    const writer = stream.writable.getWriter()
    const encoder = new TextEncoder()
    let clientDisconnected = false
    void writer.closed.catch(() => { if (!ownedOperation.signal.aborted) clientDisconnected = true; client.abort('client_disconnect') })
    const abortWriter = () => {
      // Error our own transform immediately: writer.abort alone can wait behind a write
      // blocked by backpressure when its reader has stopped pulling.
      try { streamController.error(ownedOperation.signal.reason) } catch {}
      void writer.abort(ownedOperation.signal.reason).catch(() => {})
    }
    ownedOperation.signal.addEventListener('abort', abortWriter, { once: true })
    // Bounds even a client that never consumes the first event.
    const timer = setTimeout(() => client.abort('pinokio_completion_timeout'), 30 * 60_000)
    const adapter = new StreamEventAdapter({ sessionId, defaultMetadata: { artifactId, mode: input.mode ?? 'complete' }, forward: async event => {
      try { await writer.write(encoder.encode(JSON.stringify(event) + '\n')) }
      catch (cause) { throw Object.assign(new Error(`Artifact completion stream closed before ${event.type} delivery`, { cause }), { name: 'ArtifactStreamWriteError' }) }
      await recordArtifactRunEvent(userId, artifactId, ownedRunId, event)
    } })
    adapter.setMessageId(messageId)
    const values = { ...(input.context && typeof input.context === 'object' && !Array.isArray(input.context) ? input.context as Record<string, unknown> : {}), ...(input.fields ?? {}) }
    void (async () => {
      let failure: unknown = null
      try {
        await ownedOperation.assert()
        await adapter.emitStart({ messageId, metadata: { transport: 'pinokio-app', runId: ownedRunId, runtimeManager: 'pinokio', appId: binding.appId, ...(binding.machineId ? { machineId: binding.machineId } : {}) } })
        const result = await runPinokioAppArtifact({ artifactId, binding, metadata: artifact.metadata ?? {}, values, userId, signal: ownedOperation.signal, admitFetch: () => ownedOperation.assert() }, {
          chunk: async text => { await adapter.emitChunk({ content: text }) },
          file: async (file, index) => { await adapter.emitFile({ base64: file.base64, mediaType: file.mediaType, index, metadata: file.metadata }) }
        })
        await ownedOperation.assert()
        await adapter.emitFinish({})
        await adapter.emitEnd({ content: result.text, zipReferences: [], metadata: result.metadata })
        await adapter.emitComplete()
        await writer.close()
      } catch (cause) {
        failure = cause
        if (!ownedOperation.signal.aborted && !clientDisconnected) {
          await adapter.emitError({ error: failureMessage(cause), metadata: cause instanceof PinokioAppRunError ? { code: cause.code, ...cause.details } : undefined }).catch(() => {})
          await writer.close().catch(() => {})
        } else { await writer.abort(cause).catch(() => {}) }
      } finally {
        try {
          await finishArtifactRunLog({ userId, artifactId, runId: ownedRunId, status: failure ? 'error' : 'success', errorMessage: failure ? failureMessage(failure) : null, error: failure,
            source: clientDisconnected ? 'client_disconnect' : ownedOperation.signal.aborted ? 'pinokio_cancelled' : 'pinokio_app' })
        } catch (cause) { console.error('[Artifacts] Failed to finish Pinokio app artifact run log:', cause) }
        finally {
          clearTimeout(timer)
          ownedOperation.signal.removeEventListener('abort', abortWriter)
          input.signal?.removeEventListener('abort', abortOriginal)
          ownedOperation.close()
          endWork()
        }
      }
    })().catch(cause => console.error('[Artifacts] Pinokio completion finalization failed:', cause))
    return new Response(stream.readable, { status: 200, headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } })
  } catch (cause) {
    try {
      if (startedLog && runId) await finishArtifactRunLog({ userId, artifactId, runId, status: 'error', errorMessage: failureMessage(cause), error: cause, source: 'pinokio_admission' })
    } finally {
      input.signal?.removeEventListener('abort', abortOriginal)
      operation?.close()
      endWork()
    }
    throw cause
  }
}
