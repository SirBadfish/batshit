import type { ActionContext } from '../owners'
import { emptyImportReceipt, reportImport, type ImportArgs, type ImportOutcome } from './contracts'

export type AvatarImportPorts = {
  /** Capture/current owner, successful hydration, dirty and outstanding-save gates. */
  check(): void
  stage(url: string): void
  savedAvatar(): string | null
  saveError(): string | null
  saveFailureKind?(): 'failed' | 'unknown'
}

function avatarFileError(file: File, args: ImportArgs['avatar.import_file']): string | null {
  if (!file.type.startsWith('image/')) return 'Please choose an image file for the avatar.'
  const maxMb = args.entityType === 'user' ? 2 : 5
  return file.size > maxMb * 1024 * 1024 ? `Avatar must be ${maxMb}MB or smaller.` : null
}

/** Existing panel upload validation, extracted once for chooser and supplied-byte callers. */
export async function uploadAvatarFile(file: File, args: ImportArgs['avatar.import_file']): Promise<string> {
  const validationError = avatarFileError(file, args)
  if (validationError) throw new Error(validationError)
  const form = new FormData()
  form.append('file', file, file.name)
  form.append('entityType', args.entityType)
  form.append('entityId', args.entityId)
  // The authenticated proxy checks owner + MIME/signature owner downstream. No old picture/delete.
  const response = await fetch('/api/uploads/avatar', { method: 'POST', body: form })
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    const message = [payload?.error, payload?.details, payload?.message, typeof payload === 'string' ? payload : null]
      .find(value => typeof value === 'string' && value.trim())
    throw new Error(message ?? 'Failed to upload avatar')
  }
  const payload = await response.json()
  if (typeof payload?.url !== 'string' || !payload.url) throw new Error('Upload succeeded but no avatar URL was returned')
  return payload.url
}

/** The mounted entity form remains the only stage/save owner; no settings-route imitation. */
export async function performAvatarImport(
  file: File, args: ImportArgs['avatar.import_file'], ports: AvatarImportPorts, context: ActionContext
): Promise<ImportOutcome> {
  const receipt = emptyImportReceipt()
  context.check()
  ports.check()
  // The same front-end validation precedes effect admission, while the actual upload owner
  // retains the signature/MIME and byte-size enforcement.
  if (avatarFileError(file, args)) {
    return { status: 'blocked', reason: 'invalid_avatar_file', import: receipt }
  }
  try {
    context.effect()
    receipt.uploaded = 'unknown'
    reportImport(context, receipt)
    const url = await uploadAvatarFile(file, args)
    receipt.uploaded = 'confirmed'
    receipt.ids = [args.entityId]
    reportImport(context, receipt)
    context.check()
    ports.check()
    ports.stage(url)
    receipt.staged = 'confirmed'
    receipt.saved = 'unknown'
    receipt.ready = 'pending'
    reportImport(context, receipt)
    const saved = await context.wait(() => {
      ports.check()
      if (ports.saveError()) return ports.saveFailureKind?.() ?? 'failed'
      return ports.savedAvatar() === url ? 'confirmed' as const : undefined
    })
    receipt.saved = saved
    const outcome: ImportOutcome = { status: saved === 'confirmed' ? 'completed' : saved === 'failed' ? 'failed' : 'unknown_outcome',
      reason: saved === 'confirmed' ? undefined : saved === 'failed' ? 'avatar_save_failed' : 'avatar_save_unconfirmed', import: receipt }
    context.report(outcome)
    return outcome
  } catch {
    const outcome: ImportOutcome = { status: 'unknown_outcome', reason: 'avatar_import_unconfirmed', import: receipt }
    context.report(outcome)
    return outcome
  }
}
