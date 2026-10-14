import type { APP_ACTIONS_VERSION, SettingsTarget } from './catalog'

// Leaf types shared by owners, documents, transport and supplied-file contracts.
// Importing nothing from those modules keeps the import graph acyclic (BL-1260).

export type ImportPhase = 'not_requested' | 'confirmed' | 'failed' | 'unknown'
export type ImportReceipt = {
  uploaded: ImportPhase
  staged: ImportPhase
  saved: ImportPhase
  ready: 'not_requested' | 'confirmed' | 'pending' | 'unknown'
  ids: string[]
  attachedIds?: string[]
  unresolvedIds?: string[]
  /** Issued mutation completion was not observed; a negative read is not cancellation. */
  unsettledIds?: string[]
}
export type ActionOutcome = {
  status: 'completed' | 'no_op' | 'blocked' | 'failed' | 'unknown_outcome'
  reason?: string
  visible?: 'applied' | 'unchanged' | 'unknown'
  saved?: 'saved' | 'failed' | 'unknown' | 'not_requested'
  settings?: SettingsTarget
  sessionId?: string | null
  viewer?: 'records' | 'empty' | 'no_session'
  /** Developer-supplied byte receipts only; excluded by the strict remote P1 parser. */
  import?: ImportReceipt
  detail?: string
}
export type ActionContext = {
  sessionId: string | null
  check(): void
  effect(): void
  report(outcome: ActionOutcome): void
  signal: AbortSignal
  wait<T>(read: () => T | undefined): Promise<T>
}
export type ActionReceipt = ActionOutcome & {
  requestId: string | null
  actionId: string | null
  documentId: string
  documentEpoch: string
  catalogVersion: typeof APP_ACTIONS_VERSION
}
