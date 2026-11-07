/** Finite Pinokio request ownership. Permission remains in the server-supplied callback. */
import { createHash } from 'node:crypto'
import { fencePinokioRemoteStarts } from './pinokioRemoteProvider'
import { registerRuntimeShutdownTask } from './runtimeShutdown'
import { isPinokioRemoteMachineId } from '$lib/pinokio/machines'

export class PinokioAdmissionError extends Error {
  constructor(public code: string, message: string, public status = 409) {
    super(message)
    this.name = 'PinokioAdmissionError'
  }
}

export interface PinokioOperation {
  signal: AbortSignal
  /** A fresh owner/subject/scope check, never a persisted or model-supplied grant. */
  assert(): Promise<void>
  /** Release only after clients, stream and local finalization have settled. */
  close(): void
}

let epoch = 0
let fences = 0
let shutdownRegistered = false
const active = new Map<AbortController, { closed: Promise<void>; close(): void }>()
const heldFences = new Set<() => void>()

export function ownPinokioOperation(options: { signal?: AbortSignal; admit: () => Promise<void> }): PinokioOperation {
  if (fences) throw new PinokioAdmissionError('pinokio_restore_in_progress', 'Pinokio operations are paused while Batshit restores or shuts down.', 503)
  if (typeof options.admit !== 'function') throw new PinokioAdmissionError('pinokio_admission_required', 'This operation needs its server-owned admission.', 403)
  const admittedEpoch = epoch
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve })
  let ended = false
  const close = () => {
    if (ended) return
    ended = true
    controller.abort()
    options.signal?.removeEventListener('abort', abort)
    active.delete(controller)
    resolveClosed()
  }
  active.set(controller, { closed, close })
  if (!shutdownRegistered) {
    registerRuntimeShutdownTask('pinokio-operations', async () => {
      const hold = fencePinokioOperations()
      await hold.settle()
      // Shutdown is terminal: do not reopen admission after observers settle.
    })
    shutdownRegistered = true
  }
  const check = () => {
    if (ended || controller.signal.aborted || fences || admittedEpoch !== epoch) {
      throw new PinokioAdmissionError('pinokio_operation_cancelled', 'This Pinokio operation stopped or lost its originating admission. No further request was sent.')
    }
  }
  return {
    signal: controller.signal,
    assert: async () => { check(); await options.admit(); check() },
    close
  }
}

/** Synchronously fence before ANY restore drain/mutation/recovery await. */
export function fencePinokioOperations(): { release(): void; settle(timeoutMs?: number): Promise<void> } {
  fences += 1
  epoch += 1
  const releaseNative = fencePinokioRemoteStarts()
  const pending = [...active.values()].map((operation) => operation.closed)
  for (const controller of active.keys()) controller.abort()
  let released = false
  const release = () => {
    if (released) return
    released = true
    fences -= 1
    releaseNative()
    heldFences.delete(release)
  }
  heldFences.add(release)
  return {
    release,
    settle: async (timeoutMs = 30_000) => {
      if (!pending.length) return
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          Promise.all(pending),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new PinokioAdmissionError('pinokio_operation_unsettled',
              'Pinokio work has not finished closing. Restore stopped before changing data.', 409)), Math.max(1, timeoutMs))
          })
        ])
      } finally { if (timer) clearTimeout(timer) }
    }
  }
}

/** Preview comparison only, not a capability or a claim of human consent. */
export function pinokioBindingFingerprint(artifact: {
  id?: unknown; user_id?: unknown; brain_type?: unknown; metadata?: Record<string, unknown> | null
}): string {
  const metadata = artifact.metadata ?? {}
  return createHash('sha256').update(JSON.stringify([
    'pinokio-artifact-binding-v1', artifact.user_id, artifact.id, artifact.brain_type,
    metadata.runtime_manager, metadata.source_type,
    typeof metadata.pinokio_app_id === 'string' ? metadata.pinokio_app_id.trim() : metadata.pinokio_app_id,
    Object.hasOwn(metadata, 'pinokio_machine_id') ? metadata.pinokio_machine_id : 'local'
  ])).digest('hex')
}

/** Local page custody covers its observed dependency inventory; local pterm semantics stay unchanged. */
export function pinokioLocalPreviewFingerprint(binding: string, preview: { appId: string; alsoStarts: string[] }): string {
  return createHash('sha256').update(JSON.stringify(['pinokio-local-preview-v1', binding, preview.appId,
    [...new Set(preview.alsoStarts.map((id) => id.trim()))].sort()])).digest('hex')
}

/** Query selection contains no user/host authority. Explicit malformed values never mean local. */
export function pinokioTargetFromQuery(query: URLSearchParams): { machineId?: string; revision?: number } {
  const machineId = query.has('machineId') ? query.get('machineId')! : undefined
  const raw = query.has('revision') ? query.get('revision')! : undefined
  const revision = raw === undefined ? undefined : /^(0|[1-9]\d*)$/.test(raw) ? Number(raw) : NaN
  if (query.getAll('machineId').length > 1 || query.getAll('revision').length > 1 ||
    (machineId !== undefined && machineId !== 'local' && !isPinokioRemoteMachineId(machineId)) ||
    (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) ||
    (machineId === undefined && revision !== undefined) ||
    (machineId === 'local' && revision !== undefined && revision !== 0) ||
    (machineId !== undefined && machineId !== 'local' && revision === 0)) {
    throw new PinokioAdmissionError('pinokio_machine_invalid', 'Choose a valid saved Pinokio computer and target revision.', 400)
  }
  return { ...(machineId !== undefined ? { machineId } : {}), ...(revision !== undefined ? { revision } : {}) }
}

export function __resetPinokioAdmissionForTests() {
  for (const controller of active.keys()) controller.abort()
  for (const operation of [...active.values()]) operation.close()
  for (const release of [...heldFences]) release()
  epoch += 1
  shutdownRegistered = false
}
