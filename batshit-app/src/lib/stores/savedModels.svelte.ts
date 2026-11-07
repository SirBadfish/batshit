import type { SavedModel } from '$lib/types/savedModels'

let savedModels = $state<SavedModel[]>([])
let isLoading = $state(false)
let readError = $state<string | null>(null)
let readErrorGeneration = $state(0)
let initialized = false
let generation = 0
let owner: string | null = null
let activeReads = 0
let pendingStored = false
let storedFlight: Promise<void> | undefined
let storedOwner: string | null | undefined
let waiters: Array<(applied: boolean) => void> = []

function modelRows(value: unknown): value is SavedModel[] {
  return Array.isArray(value) && value.length <= 10000 && new Set(value.map(row => row?.id)).size === value.length && value.every(row =>
    row && typeof row === 'object' && typeof row.id === 'string' && !!row.id && typeof row.modelName === 'string' && typeof row.modelId === 'string' && typeof row.provider === 'string' &&
    (row.settings == null || typeof row.settings === 'object' && !Array.isArray(row.settings)))
}
const STORED_AVAILABILITY_UNKNOWN = 'Availability is unconfirmed. Reopen Models to refresh its catalog or account status.'
function displayIdentity(model: SavedModel): string {
  const connection = model.connection
  // These are the actual catalogue match/account/connection identity inputs. Name,
  // copy ID, settings and prices are not a new catalogue/account observation.
  return JSON.stringify([model.provider, model.modelId, model.effectiveModelId, model.catalogModelId, model.vercelSourceId,
    model.isVercelImport, model.purpose, model.purposeOverride, connection?.id, connection?.type, connection?.service, connection?.useDeveloperPrefix])
}
function reconcileDisplay(models: SavedModel[], stored: boolean): SavedModel[] {
  const priorByIdentity = new Map<string, SavedModel>()
  const priorById = new Map(savedModels.map(model => [model.id, model]))
  for (const previous of savedModels) {
    const identity = displayIdentity(previous), prior = priorByIdentity.get(identity)
    if (!prior || !prior.unavailableReason?.trim() && previous.unavailableReason?.trim()) priorByIdentity.set(identity, previous)
  }
  return models.map(model => {
    const identity = displayIdentity(model)
    // A known negative observation wins over an older positive for the same exact identity.
    const prior = priorByIdentity.get(identity), oldId = priorById.get(model.id)
    const changed = oldId !== undefined && displayIdentity(oldId) !== identity
    const next = { ...model }
    if (stored) { delete next.unavailableReason; delete next.reasoningEvidence }
    if (stored || !next.unavailableReason?.trim()) {
      if (prior?.unavailableReason?.trim()) next.unavailableReason = prior.unavailableReason
      else if (changed || stored && !prior) next.unavailableReason = STORED_AVAILABILITY_UNKNOWN
    }
    if (stored || !next.reasoningEvidence) {
      if (prior?.reasoningEvidence) next.reasoningEvidence = JSON.parse(JSON.stringify(prior.reasoningEvidence))
      else if (stored || changed) next.reasoningEvidence = { status: 'unknown', reason: 'Stored configuration only; no new catalog or account observation.' }
    }
    return next
  })
}
function publishReadError(message: string | null) { readError = message; readErrorGeneration += 1 }
function localWrite() {
  generation += 1
  // The event demand outlives its invalidated response. Never carry it across owners.
  if (storedFlight && storedOwner === owner) pendingStored = true
}
/** Read lifetime only, never a save/source revision. All list readers and known local writers
 * share it so a pre-event response cannot erase a newly created preset. */
export function beginSavedModelsRead(mode: 'ordinary' | 'stored' = 'ordinary') {
  const captured = ++generation, user = owner
  activeReads += 1; isLoading = true
  let finished = false
  const current = () => !finished && generation === captured && owner === user
  return { current,
    install(models: SavedModel[]) {
      if (!current()) return false
      if (!modelRows(models)) { publishReadError('The saved model list is unreadable. The last good list is retained.'); return false }
      savedModels = mode === 'stored' ? reconcileDisplay(models, true) : [...models]; initialized = true; publishReadError(null)
      return true
    },
    fail(message: string) { if (current()) publishReadError(message) },
    finish() {
      if (finished) return
      finished = true; activeReads -= 1; isLoading = activeReads > 0
      drainStored()
    } }
}
export function setSavedModelsOwner(userId: string | null) {
  if (owner === userId) return
  owner = userId; generation += 1; pendingStored = false
  waiters.splice(0).forEach(resolve => resolve(false))
  savedModels = []; initialized = false; publishReadError(null)
}
export function setSavedModels(models: SavedModel[]) { localWrite(); savedModels = reconcileDisplay(models, false); initialized = true }
export function upsertSavedModel(model: SavedModel) {
  localWrite()
  const nextModel = reconcileDisplay([model], false)[0]
  const index = savedModels.findIndex(row => row.id === model.id)
  savedModels = index < 0 ? [nextModel, ...savedModels] : savedModels.map((row, offset) => offset === index ? nextModel : row)
  initialized = true
}
export function removeSavedModel(id: string) { localWrite(); savedModels = savedModels.filter(row => row.id !== id) }

export async function loadSavedModels() {
  if (isLoading) return
  const read = beginSavedModelsRead()
  try {
    const response = await fetch('/api/user/saved-models')
    if (!response.ok) throw new Error('Saved models could not be loaded.')
    const data = await response.json(), models = Array.isArray(data) ? data : data?.models
    if (!modelRows(models)) throw new Error('The saved model list is unreadable.')
    read.install(models)
  } catch { read.fail('Saved models could not be loaded. The last good list is retained.') }
  finally { read.finish() }
}

/** Value-free create/reconnect notifications request a fresh, pure stored projection.
 * A notification during any older read invalidates it and queues ONE fresh read after settlement. */
export function refreshStoredSavedModels(): Promise<boolean> {
  generation += 1; pendingStored = true
  const settled = new Promise<boolean>(resolve => waiters.push(resolve))
  drainStored()
  return settled
}
function drainStored() {
  if (!pendingStored || activeReads || storedFlight) return
  pendingStored = false
  const read = beginSavedModelsRead('stored')
  storedOwner = owner
  let applied = false
  storedFlight = Promise.resolve().then(async () => {
    try {
      const models: SavedModel[] = []
      let offset: number | null = 0, total: number | undefined
      while (offset !== null) {
        const response: Response = await fetch(`/api/user/saved-models?projection=stored&offset=${offset}`)
        if (!read.current()) return
        if (!response.ok) throw new Error('Stored presets could not be refreshed.')
        const page: unknown = await response.json()
        if (!read.current()) return
        if (!page || typeof page !== 'object' || !('projection' in page) || page.projection !== 'stored' ||
          !('offset' in page) || page.offset !== offset || !('total' in page) || typeof page.total !== 'number' ||
          !Number.isSafeInteger(page.total) || page.total < 0 || page.total > 10000 || total !== undefined && total !== page.total ||
          !('models' in page) || !modelRows(page.models) || page.models.length !== Math.min(20, Math.max(0, page.total - offset)) ||
          !('nextOffset' in page) || page.nextOffset !== null && typeof page.nextOffset !== 'number' ||
          page.nextOffset !== (offset + page.models.length < page.total ? offset + page.models.length : null)) throw new Error('The stored preset page is incomplete.')
        total = page.total; models.push(...page.models); offset = page.nextOffset
        if (new TextEncoder().encode(JSON.stringify(models)).length > 131072 || !modelRows(models)) throw new Error('The stored preset list is too large or changed while reading.')
      }
      applied = read.install(models)
    } catch { read.fail('Stored presets could not be refreshed. The last good list is retained.') }
    finally {
      storedFlight = undefined; storedOwner = undefined
      // finish may start the single queued post-event read. Its waiters belong to that read.
      const done = pendingStored ? [] : waiters.splice(0)
      read.finish()
      done.forEach(resolve => resolve(applied))
    }
  })
}
export function getSavedModels(): SavedModel[] { return savedModels }
export function getIsLoading(): boolean { return isLoading }
export function getReadError(): string | null { return readError }
export function getReadErrorState() { return { message: readError, generation: readErrorGeneration } }
export function isInitialized(): boolean { return initialized }
export const savedModelsStore = { loadSavedModels, refreshStoredSavedModels, getSavedModels, getIsLoading, getReadError, getReadErrorState, isInitialized, setSavedModels, upsertSavedModel, removeSavedModel }
