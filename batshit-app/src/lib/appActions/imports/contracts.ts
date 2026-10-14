import { refuse } from '../catalog'
import type { ActionContext, ActionOutcome, ImportReceipt } from '../actionTypes'

export const SUPPLIED_FILE_ACTION_IDS = [
  'goon.import_file', 'goon.replace_vrm_file', 'clip.import_files', 'avatar.import_file'
] as const
export type SuppliedFileActionId = typeof SUPPLIED_FILE_ACTION_IDS[number]
export type SourceProfile = 'standard-vrm' | 'guided-custom-vrm' | 'expert-custom-glb'
export type AvatarEntityType = 'user' | 'group' | 'agent' | 'subagent'
export type ImportArgs = {
  'goon.import_file': { sourceProfile: SourceProfile; name?: string; description?: string }
  'goon.replace_vrm_file': { goonId: string }
  'clip.import_files': { sessionId: string | null; attach: boolean }
  'avatar.import_file': { entityType: AvatarEntityType; entityId: string }
}

/** Direct developer input only. This is deliberately absent from JSON/Fabric schemas. */
export type SuppliedFile = File | { filename: string; mimeType: string; bytes: ArrayBuffer | Uint8Array }
export type { ImportPhase, ImportReceipt } from '../actionTypes'
export type ImportOutcome = ActionOutcome & { import: ImportReceipt; detail?: string }

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) refuse('invalid_arguments')
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key) ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value')) refuse('invalid_arguments')
  }
  return value as Record<string, unknown>
}
export function importIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
}
function sessionIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) && value !== '__create__'
}
export function parseImportArgs<I extends SuppliedFileActionId>(id: I, value: unknown): ImportArgs[I] {
  let result: Record<string, unknown>
  if (id === 'goon.import_file') {
    const input = exactRecord(value, ['sourceProfile', 'name', 'description'])
    if (!['standard-vrm', 'guided-custom-vrm', 'expert-custom-glb'].includes(input.sourceProfile as string)) refuse('invalid_arguments')
    result = { sourceProfile: input.sourceProfile }
    for (const [key, limit] of [['name', 256], ['description', 4000]] as const) {
      if (!Object.hasOwn(input, key)) continue
      if (typeof input[key] !== 'string' || input[key].length > limit) refuse('invalid_arguments')
      result[key] = input[key]
    }
  } else if (id === 'goon.replace_vrm_file') {
    const input = exactRecord(value, ['goonId'])
    if (!importIdentifier(input.goonId)) refuse('invalid_arguments')
    result = { goonId: input.goonId }
  } else if (id === 'clip.import_files') {
    const input = exactRecord(value, ['sessionId', 'attach'])
    if (input.sessionId !== null && !sessionIdentifier(input.sessionId)) refuse('invalid_arguments')
    if (typeof input.attach !== 'boolean' || (input.attach && input.sessionId === null)) refuse('invalid_arguments')
    result = { sessionId: input.sessionId, attach: input.attach }
  } else if (id === 'avatar.import_file') {
    const input = exactRecord(value, ['entityType', 'entityId'])
    if (!['user', 'group', 'agent', 'subagent'].includes(input.entityType as string) ||
      !importIdentifier(input.entityId)) refuse('invalid_arguments')
    result = { entityType: input.entityType, entityId: input.entityId }
  } else refuse('unsupported_action')
  return result as ImportArgs[I]
}

/** Detach supplied bytes before the first await. Owners still perform all format validation. */
export function materializeSuppliedFiles(id: SuppliedFileActionId, supplied: readonly SuppliedFile[]): File[] {
  if (!Array.isArray(supplied) || supplied.length < 1 || supplied.length > (id === 'clip.import_files' ? 10 : 1)) refuse('invalid_files')
  // Bound copying by the existing owner maxima: Clips 10 MiB, avatar panels at most
  // 5 MiB, core Goon imports 600 MiB. The user-avatar owner retains its stricter 2 MiB.
  const maxBytes = (id === 'clip.import_files' ? 10 : id === 'avatar.import_file' ? 5 : 600) * 1024 * 1024
  return supplied.map(value => {
    let file: File
    if (typeof File !== 'undefined' && value instanceof File) file = value
    else {
      const input = exactRecord(value, ['filename', 'mimeType', 'bytes'])
      if (typeof input.filename !== 'string' || typeof input.mimeType !== 'string' ||
        !(input.bytes instanceof ArrayBuffer || input.bytes instanceof Uint8Array)) refuse('invalid_files')
      if (input.bytes.byteLength === 0 || input.bytes.byteLength > maxBytes) refuse('invalid_files')
      // File copies its input; a mutable caller buffer cannot change an admitted upload.
      const bytes = input.bytes instanceof Uint8Array ? Uint8Array.from(input.bytes) : new Uint8Array(input.bytes).slice()
      file = new File([bytes], input.filename, { type: input.mimeType })
    }
    if (!file.name || file.name.length > 255 || /[\\/:\u0000-\u001f\u007f]/.test(file.name) ||
      file.name === '.' || file.name === '..' || file.size === 0 || file.size > maxBytes) refuse('invalid_files')
    return file
  })
}

export function emptyImportReceipt(): ImportReceipt {
  return { uploaded: 'not_requested', staged: 'not_requested', saved: 'not_requested', ready: 'not_requested', ids: [] }
}
export function reportImport(context: ActionContext, receipt: ImportReceipt) {
  const outcome: ImportOutcome = { status: 'unknown_outcome', import: structuredClone(receipt) }
  context.report(outcome)
}
