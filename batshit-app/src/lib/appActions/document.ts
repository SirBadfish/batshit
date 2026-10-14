import { APP_ACTION_CATALOG, APP_ACTIONS_VERSION, AppActionRefusal, parseActionRequest, refuse } from './catalog'
import type { ActionId, ActionRequest } from './catalog'
import { onAppActionNavigation } from './owners'
import type { ActionHandler } from './owners'
import type { ActionContext, ActionOutcome, ActionReceipt } from './actionTypes'
import { APP_ACTION_FILE_DEADLINE_MS, captureSuppliedFiles, parseSuppliedFileRequest, suppliedFileIntent } from './fileProtocol'
import type { SuppliedFileRequest } from './fileProtocol'
import { executeSuppliedFileAction } from './imports/registry'
import type { SuppliedFile } from './imports/contracts'
import { describeAppActionFamily, discoverAppActionFamilies } from './families'

type DocumentRequest = ActionRequest | SuppliedFileRequest

export type { ActionReceipt } from './actionTypes'
type DocumentPorts = {
  documentId: string
  documentEpoch: string
  session(): string | null
  handler(id: ActionId): ActionHandler | undefined
  availability?(id: ActionId): string
  observation?(): Record<string, unknown>
  feedback(receipt: ActionReceipt): void
  now?: () => number
  crypto?: Crypto
}

/** One closure per loaded page. An admitted ID is never evicted or allowed to execute again. */
export function createAppActionsDocument(ports: DocumentPorts) {
  const now = ports.now ?? Date.now
  const receipts = new Map<string, { kind: 'view' | 'file'; payload: string | Promise<string>; promise: Promise<ActionReceipt> }>()
  const cancelled = new Set<string>()
  let mounted = true
  let revision = 0
  let active: AbortController | null = null
  let activeRequestId: string | null = null
  let preparingFileId: string | null = null
  const unsubscribe = onAppActionNavigation(() => { revision++; active?.abort('user_navigation') })
  function receipt(request: Partial<DocumentRequest> | null, outcome: ActionOutcome): ActionReceipt {
    return { ...outcome, requestId: request?.requestId ?? null, actionId: request?.actionId ?? null,
      documentId: ports.documentId, documentEpoch: ports.documentEpoch, catalogVersion: APP_ACTIONS_VERSION }
  }
  function blocked(request: Partial<DocumentRequest> | null, reason: string) {
    const result = receipt(request, { status: 'blocked', reason, visible: 'unchanged', saved: 'not_requested' })
    if (mounted) ports.feedback(result)
    return result
  }
  function state() {
    return { catalogVersion: APP_ACTIONS_VERSION, documentId: ports.documentId,
      documentEpoch: ports.documentEpoch, expectedSessionId: ports.session(), mounted, busy: Boolean(active || preparingFileId),
      view: JSON.parse(JSON.stringify(ports.observation?.() ?? {})), receiptCapacityRemaining: 128 - receipts.size }
  }
  async function run(request: DocumentRequest, capturedRevision: number, fileHandler?: (context: ActionContext) => Promise<ActionOutcome>): Promise<ActionReceipt> {
    const controller = new AbortController()
    let effectStarted = false
    let lastOutcome: ActionOutcome | undefined
    let ownerSettled = false
    const check = () => {
      if (!mounted) refuse('unmounted_document')
      if (cancelled.has(request.requestId)) refuse('caller_stopped')
      if (request.documentId !== ports.documentId || request.documentEpoch !== ports.documentEpoch) refuse('stale_document')
      if (controller.signal.aborted) refuse(String(controller.signal.reason || 'retired_request'))
      if (revision !== capturedRevision) refuse('user_navigation')
      if (ports.session() !== request.expectedSessionId) refuse('stale_session')
      if (now() >= request.expiresAt) refuse('expired_request')
    }
    const context: ActionContext = {
      sessionId: request.expectedSessionId, signal: controller.signal, check, effect: () => { check(); effectStarted = true },
      report: outcome => { lastOutcome = outcome },
      async wait(read) {
        for (;;) {
          check()
          const answer = read()
          if (answer !== undefined) { check(); return answer }
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve() }
            const timer = setTimeout(done, Math.min(25, Math.max(0, request.expiresAt - now())))
            controller.signal.addEventListener('abort', done, { once: true })
          })
        }
      }
    }
    // No action queue. Busy requests receive receipts and never run on a later reconnect.
    if (active || preparingFileId) return blocked(request, 'busy')
    active = controller
    activeRequestId = request.requestId
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      check()
      if (request.expiresAt > now() + (fileHandler ? APP_ACTION_FILE_DEADLINE_MS : 5000)) refuse('expired_request')
      const handler = fileHandler ? (_args: unknown, context: ActionContext) => fileHandler(context) : ports.handler(request.actionId as ActionId)
      if (!handler) refuse('unsupported_document')
      const interrupted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new AppActionRefusal(String(controller.signal.reason))), { once: true })
        timer = setTimeout(() => controller.abort('expired_request'), Math.max(0, request.expiresAt - now()))
      })
      const owner = Promise.resolve().then(() => { check(); return handler(request.args as ActionRequest['args'], context) })
        .then(outcome => { lastOutcome = outcome; return outcome })
        .finally(() => { ownerSettled = true; if (controller.signal.aborted && active === controller) active = null })
      const result = await Promise.race([owner, interrupted])
      check()
      const resultReceipt = receipt(request, result)
      if (mounted) ports.feedback(resultReceipt)
      return resultReceipt
    } catch (error) {
      const reason = error instanceof AppActionRefusal ? error.reason : 'owner_failed'
      const knownFailure = ['panel_load_failed', 'viewer_load_failed', 'missing_entity', 'unsupported_target'].includes(reason)
      const result = receipt(request, { ...lastOutcome,
        status: knownFailure && (effectStarted || reason.endsWith('load_failed')) ? 'failed' : effectStarted ? 'unknown_outcome' : error instanceof AppActionRefusal ? 'blocked' : 'failed',
        reason, visible: lastOutcome?.visible ?? (effectStarted ? 'unknown' : 'unchanged'),
        saved: lastOutcome?.saved ?? (effectStarted && (fileHandler || request.actionId.startsWith('goon.')) ? 'unknown' : 'not_requested') })
      if (mounted) ports.feedback(result)
      return result
    } finally {
      clearTimeout(timer)
      controller.abort('settled_request')
      // An uncertain write still owns its flight until the real owner settles.
      if ((ownerSettled || !timer) && active === controller) active = null
    }
  }
  return {
    state,
    discover(query = '', limit = 5) {
      if (typeof query !== 'string' || query.length > 128 || !Number.isInteger(limit) || limit < 1 || limit > 5) refuse('invalid_discovery')
      const term = query.toLowerCase()
      const matches = APP_ACTION_CATALOG.filter(action => `${action.id} ${action.label}`.toLowerCase().includes(term))
      return { ...state(), count: matches.length, actions: matches.slice(0, limit).map(action => ({
        id: action.id, label: action.label, effects: [...action.effects],
        availability: !mounted ? 'unmounted_document' : active ? 'busy' : ports.handler(action.id)
          ? ports.availability?.(action.id) ?? 'available' : 'unsupported_document'
      })) }
    },
    describe(id: ActionId) {
      const action = APP_ACTION_CATALOG.find(entry => entry.id === id)
      if (!action) refuse('unsupported_action')
      return JSON.parse(JSON.stringify({ catalogVersion: APP_ACTIONS_VERSION, ...action }))
    },
    execute(value: unknown): Promise<ActionReceipt> {
      let request: ActionRequest
      try { request = parseActionRequest(value) }
      catch (error) { return Promise.resolve(blocked(null, error instanceof AppActionRefusal ? error.reason : 'invalid_request')) }
      const payload = JSON.stringify(request)
      const previous = receipts.get(request.requestId)
      if (previous) return previous.kind === 'view' && payload === previous.payload ? previous.promise : Promise.resolve(blocked(request, 'request_id_conflict'))
      if (receipts.size >= 128) return Promise.resolve(blocked(request, 'receipt_capacity'))
      // Navigation retires the submitted intent even before an active owner exists.
      const submittedRevision = revision
      // Defer admission one microtask so even synchronous reentrancy sees the saved promise.
      const promise = Promise.resolve().then(() => run(request, submittedRevision))
      receipts.set(request.requestId, { kind: 'view', payload, promise })
      return promise
    },
    /** Developer convenience only: immutable supplied bytes never enter Fabric/HTTP JSON. */
    executeFile(value: unknown, supplied: readonly SuppliedFile[]): Promise<ActionReceipt> {
      let request: SuppliedFileRequest, files: File[]
      let previous: { kind: 'view' | 'file'; payload: string | Promise<string>; promise: Promise<ActionReceipt> } | undefined
      try {
        request = parseSuppliedFileRequest(value)
        previous = receipts.get(request.requestId)
        if (previous?.kind === 'view') return Promise.resolve(blocked(request, 'request_id_conflict'))
        if (!previous) {
          if (!mounted) refuse('unmounted_document')
          if (request.documentId !== ports.documentId || request.documentEpoch !== ports.documentEpoch) refuse('stale_document')
          if (request.expectedSessionId !== ports.session()) refuse('stale_session')
          if (now() >= request.expiresAt || request.expiresAt > now() + APP_ACTION_FILE_DEADLINE_MS) refuse('expired_request')
          if (active || preparingFileId) refuse('busy')
          if (receipts.size >= 128) refuse('receipt_capacity')
        }
        files = captureSuppliedFiles(request.actionId, supplied)
      } catch (error) { return Promise.resolve(blocked(null, error instanceof AppActionRefusal ? error.reason : 'invalid_files')) }
      const submittedRevision = revision
      if (!previous) preparingFileId = request.requestId
      const payload = suppliedFileIntent(request, files, ports.crypto ?? globalThis.crypto)
      if (previous) return Promise.all([payload, previous.payload]).then(([next, prior]) => next === prior ? previous.promise : blocked(request, 'request_id_conflict'))
          .catch(error => blocked(request, error instanceof AppActionRefusal ? error.reason : 'invalid_files'))
      const promise = payload.then(() => {
        if (preparingFileId === request.requestId) preparingFileId = null
        return run(request, submittedRevision, context => executeSuppliedFileAction(request.actionId, request.args, files, context))
      })
        .catch(error => blocked(request, error instanceof AppActionRefusal ? error.reason : 'invalid_files'))
        .finally(() => { if (preparingFileId === request.requestId) preparingFileId = null })
      receipts.set(request.requestId, { kind: 'file', payload, promise })
      return promise
    },
    discoverFamilies: (query = '', limit = 5, offset = 0) => discoverAppActionFamilies('developer', { query, limit, offset }),
    describeFamily: (id: string) => describeAppActionFamily('developer', id),
    receipt(id: string) { return receipts.get(id)?.promise ?? Promise.resolve(null) },
    /** Internal transport owner only; excluded from the window convenience API. */
    cancel(id: string) {
      if (!receipts.has(id)) return false
      cancelled.add(id)
      if (activeRequestId === id) active?.abort('caller_stopped')
      return true
    },
    retire() { mounted = false; revision++; active?.abort('unmounted_document'); unsubscribe() }
  }
}
export type AppActionsDocument = ReturnType<typeof createAppActionsDocument>
export type AppActionsAPI = Omit<AppActionsDocument, 'retire' | 'cancel'> & {
  inspectSettings?(args: unknown): Promise<unknown>
}
