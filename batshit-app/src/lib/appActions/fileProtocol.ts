import { APP_ACTIONS_VERSION, parseActionRequest, refuse } from './catalog'
import type { ActionRequest } from './catalog'
import { actionTransportRecord, canonicalActionJson, toActionBase64 } from './protocol'
import { materializeSuppliedFiles, parseImportArgs, SUPPLIED_FILE_ACTION_IDS } from './imports/contracts'
import type { ImportArgs, SuppliedFile, SuppliedFileActionId } from './imports/contracts'

/** Developer-supplied uploads may take longer than a five-second view command. */
export const APP_ACTION_FILE_DEADLINE_MS = 300_000
const FILE_FINGERPRINT_CHUNK_BYTES = 4 * 1024 * 1024
export type SuppliedFileRequest = Omit<ActionRequest, 'actionId' | 'args'> & {
  actionId: SuppliedFileActionId
  args: ImportArgs[SuppliedFileActionId]
}
export function parseSuppliedFileRequest(value: unknown): SuppliedFileRequest {
  const input = actionTransportRecord(value, ['requestId', 'catalogVersion', 'documentId', 'documentEpoch', 'expectedSessionId', 'actionId', 'args', 'expiresAt'])
  if (!(SUPPLIED_FILE_ACTION_IDS as readonly unknown[]).includes(input.actionId)) refuse('unsupported_action')
  // Reuse P1's exact identity/session/envelope rules without enlarging its action parser.
  const envelope = parseActionRequest({ ...input, actionId: 'goon.show', args: {} })
  const actionId = input.actionId as SuppliedFileActionId
  return { ...envelope, catalogVersion: APP_ACTIONS_VERSION, actionId, args: parseImportArgs(actionId, input.args) }
}
export function captureSuppliedFiles(id: SuppliedFileActionId, supplied: readonly SuppliedFile[]) {
  // Mutable byte carriers are detached synchronously, before digest/admission can await.
  return materializeSuppliedFiles(id, supplied)
}
export async function suppliedFileIntent(request: SuppliedFileRequest, files: readonly File[], crypto: Crypto) {
  if (!crypto?.subtle) refuse('document_crypto_unavailable')
  const fingerprints = []
  for (const file of files) {
    // Goon files can be 600 MiB. Read/hash one fixed chunk at a time rather than
    // allocating another whole-file buffer during document admission.
    const chunks: string[] = []
    for (let offset = 0; offset < file.size; offset += FILE_FINGERPRINT_CHUNK_BYTES) {
      const bytes = await file.slice(offset, offset + FILE_FINGERPRINT_CHUNK_BYTES).arrayBuffer()
      chunks.push(toActionBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))))
    }
    const content = canonicalActionJson({ domain: 'app-actions-supplied-file/v1',
      chunkBytes: FILE_FINGERPRINT_CHUNK_BYTES, size: file.size, chunks })
    const hash = toActionBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))))
    fingerprints.push({ filename: file.name, mimeType: file.type, size: file.size, hash })
  }
  // Only fingerprints are retained for dedup. No byte data enters JSON or live transport.
  return canonicalActionJson({ request, files: fingerprints })
}
