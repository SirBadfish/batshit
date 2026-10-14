import { APP_ACTIONS_VERSION, parseActionRequest, refuse } from './catalog'
import type { ActionRequest } from './catalog'
import type { ActionReceipt } from './actionTypes'

export const APP_ACTION_TRANSPORT_VERSION = 'app-actions-transport/v1' as const
export const APP_ACTION_LEASE_MS = 60_000
export const APP_ACTION_DEADLINE_MS = 5000
export const APP_ACTION_MAX_BYTES = 16_384
export type DocumentIdentity = {
  catalogVersion: typeof APP_ACTIONS_VERSION
  documentId: string
  documentEpoch: string
  expectedSessionId: string | null
}
export type Registration = DocumentIdentity & {
  registrationId: string
  registrationEpoch: string
  processId: string
  expiresAt: number
}
export type DocumentChallenge = Registration & {
  kind: 'register' | 'renew'
  challengeId: string
  nonce: string
  challengeExpiresAt: number
  keyFingerprint: string
}
export type AppActionCommand = {
  type: 'app_action_requested'
  protocolVersion: typeof APP_ACTION_TRANSPORT_VERSION
  registrationId: string
  registrationEpoch: string
  processId: string
  nonce: string
  actionHash: string
  request: ActionRequest
}
export type AppActionReceiptProof = {
  command: AppActionCommand
  receipt: ActionReceipt
}
export type AppActionCancellation = { type: 'app_action_cancelled'; command: AppActionCommand }
export type AppActionLiveEvent = AppActionCommand | AppActionCancellation

/** Canonical JSON has one encoding on Node and WebCrypto, independent of key insertion order. */
export function canonicalActionJson(value: unknown): string {
  function normalize(item: unknown, depth: number): unknown {
    if (depth > 10) refuse('payload_too_deep')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (Array.isArray(item)) return item.map(entry => normalize(entry, depth + 1))
    if (!item || typeof item !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(item))) refuse('invalid_payload')
    if (Reflect.ownKeys(item).some(key => typeof key !== 'string')) refuse('invalid_payload')
    return Object.fromEntries(Object.keys(item).sort().map(key =>
      [key, normalize((item as Record<string, unknown>)[key], depth + 1)]))
  }
  const encoded = JSON.stringify(normalize(value, 0))
  if (new TextEncoder().encode(encoded).length > APP_ACTION_MAX_BYTES) refuse('payload_too_large')
  return encoded
}
export function actionProofBytes(domain: 'register' | 'renew' | 'receipt', value: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${APP_ACTION_TRANSPORT_VERSION}/${domain}\n${canonicalActionJson(value)}`)
}
export function toActionBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function fromActionBase64(value: unknown, expectedLength: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > expectedLength * 2) refuse('invalid_signature')
  let decoded: string
  try { decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/')) } catch { refuse('invalid_signature') }
  const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0))
  if (bytes.length !== expectedLength || toActionBase64(bytes) !== value) refuse('invalid_signature')
  return bytes
}
export function actionTransportRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))) refuse('invalid_request')
  return value as Record<string, unknown>
}
export function actionTransportId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) refuse('invalid_request')
  return value
}
export function parseDocumentIdentity(value: unknown): DocumentIdentity {
  const source = actionTransportRecord(value, ['catalogVersion', 'documentId', 'documentEpoch', 'expectedSessionId'])
  if (source.catalogVersion !== APP_ACTIONS_VERSION) refuse('stale_catalog')
  return {
    catalogVersion: APP_ACTIONS_VERSION,
    documentId: actionTransportId(source.documentId),
    documentEpoch: actionTransportId(source.documentEpoch),
    expectedSessionId: source.expectedSessionId === null ? null : actionTransportId(source.expectedSessionId)
  }
}
export function parseAppActionCommand(value: unknown): AppActionCommand {
  const source = actionTransportRecord(value, ['type', 'protocolVersion', 'registrationId', 'registrationEpoch', 'processId', 'nonce', 'actionHash', 'request'])
  if (source.type !== 'app_action_requested' || source.protocolVersion !== APP_ACTION_TRANSPORT_VERSION ||
    typeof source.actionHash !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(source.actionHash)) refuse('invalid_command')
  return {
    type: 'app_action_requested', protocolVersion: APP_ACTION_TRANSPORT_VERSION,
    registrationId: actionTransportId(source.registrationId), registrationEpoch: actionTransportId(source.registrationEpoch),
    processId: actionTransportId(source.processId), nonce: actionTransportId(source.nonce),
    actionHash: source.actionHash, request: parseActionRequest(source.request)
  }
}
/** Receipts contain only the current five owners' compact postconditions. */
export function parseAppActionReceipt(value: unknown, request: ActionRequest): ActionReceipt {
  const source = actionTransportRecord(value, ['requestId', 'actionId', 'documentId', 'documentEpoch', 'catalogVersion', 'status', 'reason', 'visible', 'saved', 'settings', 'sessionId', 'viewer'])
  for (const key of ['requestId', 'actionId', 'documentId', 'documentEpoch', 'catalogVersion'] as const) {
    if (source[key] !== request[key]) refuse('receipt_mismatch')
  }
  if (!['completed', 'no_op', 'blocked', 'failed', 'unknown_outcome'].includes(String(source.status))) refuse('invalid_receipt')
  if (source.reason !== undefined && (typeof source.reason !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(source.reason))) refuse('invalid_receipt')
  if (source.visible !== undefined && !['applied', 'unchanged', 'unknown'].includes(String(source.visible))) refuse('invalid_receipt')
  if (source.saved !== undefined && !['saved', 'failed', 'unknown', 'not_requested'].includes(String(source.saved))) refuse('invalid_receipt')
  if (source.viewer !== undefined && !['records', 'empty', 'no_session'].includes(String(source.viewer))) refuse('invalid_receipt')
  if (source.sessionId !== undefined && source.sessionId !== request.expectedSessionId) refuse('receipt_mismatch')
  if (source.settings !== undefined) {
    if (request.actionId !== 'settings.open') refuse('invalid_receipt')
    const target = parseActionRequest({ ...request, args: source.settings }).args
    if (canonicalActionJson(target) !== canonicalActionJson(request.args)) refuse('receipt_mismatch')
  }
  if (request.actionId !== 'execution.open' && source.viewer !== undefined) refuse('invalid_receipt')
  if (!request.actionId.startsWith('goon.') && source.saved !== undefined && source.saved !== 'not_requested') refuse('invalid_receipt')
  return JSON.parse(canonicalActionJson(source)) as ActionReceipt
}
