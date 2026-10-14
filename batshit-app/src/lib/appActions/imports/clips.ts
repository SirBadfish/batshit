import { normalizeClipCompressionSettings } from '../../utils/clipCompressionSettings'
import type { ActionContext } from '../owners'
import { emptyImportReceipt, importIdentifier, reportImport, type ImportArgs, type ImportOutcome, type ImportPhase } from './contracts'

export type UploadedClipFile = {
  originalName: string
  mimetype: string
  url?: string
  displayUrl?: string
  localUrl?: string
  externalUrl?: string
  externalTokens?: number
  localTokens?: number
  clipData: { id: string; tokens?: number; externalTokens?: number; localTokens?: number }
}
export type ClipImportResult = { outcome: ImportOutcome; files: UploadedClipFile[] }

/** One owner for chooser, drop and developer-supplied bytes. No retry, tunnel or path input. */
export async function importClipFiles(
  files: File[], args: ImportArgs['clip.import_files'], context: ActionContext,
  request: typeof fetch = globalThis.fetch
): Promise<ClipImportResult> {
  const receipt = emptyImportReceipt()
  receipt.attachedIds = []
  receipt.unresolvedIds = []
  receipt.unsettledIds = []
  const confirmedFiles: UploadedClipFile[] = []
  let reason = 'clip_settings_unconfirmed'
  let effectRequested = false
  try {
    context.check()
    // BL-1171: an absent settings record is valid; an HTTP/transport/envelope failure is not.
    const settingsResponse = await request('/api/user/settings', { cache: 'no-store', signal: context.signal })
    if (!settingsResponse.ok) throw new Error('clip_settings_unconfirmed')
    const settings = await settingsResponse.json()
    if (!settings || !Object.hasOwn(settings, 'settings') ||
      (settings.settings !== null && (typeof settings.settings !== 'object' || Array.isArray(settings.settings)))) {
      throw new Error('clip_settings_unconfirmed')
    }
    const compressionSettings = normalizeClipCompressionSettings(settings.settings?.ui_settings)
    context.check()
    const form = new FormData()
    for (const file of files) form.append('files', file, file.name)
    if (args.sessionId) form.append('sessionId', args.sessionId)
    form.append('compressionSettings', JSON.stringify(compressionSettings))
    form.append('uploadSettings', JSON.stringify({ strategy: 'local', storage_mode: 'local' }))
    reason = 'clip_upload_unconfirmed'
    context.effect()
    effectRequested = true
    receipt.uploaded = 'unknown'
    receipt.saved = 'unknown'
    receipt.ready = 'unknown'
    reportImport(context, receipt)
    const upload = await request('/api/uploads/clips', { method: 'POST', body: form, signal: context.signal })
    // The multi-file owner can have saved earlier files before a later file failed.
    // An error is not proof that nothing uploaded, and never authorizes an automatic retry.
    if (!upload.ok) throw new Error('clip_upload_unconfirmed')
    const payload = await upload.json()
    if (!Array.isArray(payload?.files) || payload.files.length !== files.length) throw new Error('clip_upload_unconfirmed')
    const uploaded: UploadedClipFile[] = payload.files
    const ids = uploaded.map(file => file?.clipData?.id)
    if (ids.some(id => !importIdentifier(id)) || new Set(ids).size !== files.length) throw new Error('clip_upload_unconfirmed')
    receipt.uploaded = 'confirmed'
    receipt.ids = ids
    reportImport(context, receipt)
    reason = 'clip_save_unconfirmed'
    // BL-512: an upload response alone has not proved setClip persisted the record.
    for (const file of uploaded) {
      context.check()
      const read = await request(`/api/clips/${encodeURIComponent(file.clipData.id)}`, { cache: 'no-store', signal: context.signal })
      if (!read.ok) throw new Error('clip_save_unconfirmed')
      const saved = await read.json()
      if (saved?.id !== file.clipData.id || saved.systemClip !== false) throw new Error('clip_save_unconfirmed')
      confirmedFiles.push(file)
    }
    receipt.saved = 'confirmed'
    receipt.ready = args.attach ? 'pending' : 'confirmed'
    reportImport(context, receipt)
    if (args.attach && args.sessionId) {
      reason = 'clip_attachment_unconfirmed'
      receipt.staged = 'unknown'
      reportImport(context, receipt)
      let attemptedId: string | undefined
      let stateReadAttempted = false
      let stateConfirmed = false
      let completionUnknown = false
      // Reconciliation mutates this receipt across await. Read its current
      // phase through the full type rather than the initial 'unknown' narrowing.
      const readAttachmentStage = (): ImportPhase => receipt.staged
      const reconcile = async () => {
        context.check()
        stateReadAttempted = true
        const stateRead = await request(`/api/session-clips/state/${encodeURIComponent(args.sessionId!)}`, { cache: 'no-store', signal: context.signal })
        if (!stateRead.ok) throw new Error('clip_attachment_unconfirmed')
        const state = await stateRead.json()
        if (state?.sessionId !== args.sessionId || !Array.isArray(state.clips)) throw new Error('clip_attachment_unconfirmed')
        receipt.attachedIds = ids.filter(id => state.clips.some((entry: { clipId?: string }) => entry?.clipId === id))
        receipt.unsettledIds = completionUnknown && attemptedId ? [attemptedId] : []
        receipt.unresolvedIds = receipt.unsettledIds.filter(id => !receipt.attachedIds!.includes(id))
        stateConfirmed = true
        receipt.staged = receipt.attachedIds.length === ids.length ? 'confirmed' : receipt.unsettledIds.length ? 'unknown' : 'failed'
        reportImport(context, receipt)
      }
      try {
        for (const id of ids) {
          attemptedId = id
          receipt.unresolvedIds = [id]
          context.check()
          completionUnknown = true
          receipt.unsettledIds = [id]
          reportImport(context, receipt)
          const attach: Response = await request('/api/session-clips/state', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: args.sessionId, clipId: id, action: 'attach' }), signal: context.signal
          })
          // An actual response proves this handler returned. A rejected fetch
          // does not: the authenticated owner may still be awaiting its write.
          completionUnknown = false
          // BL-1170/1177: HTTP failure can follow a saved state write. It does
          // not prove absence, and never authorizes a mutation retry.
          if (!attach.ok) throw new Error('clip_attachment_unconfirmed')
          const attached: { sessionId?: unknown; clips?: unknown } | null = await attach.json()
          const attachedClips = attached?.clips
          if (attached?.sessionId !== args.sessionId || !Array.isArray(attachedClips) ||
            !attachedClips.some((entry: { clipId?: string }) => entry?.clipId === id)) throw new Error('clip_attachment_unconfirmed')
          receipt.attachedIds = ids.filter(candidate => attachedClips.some((entry: { clipId?: string }) => entry?.clipId === candidate))
          receipt.unresolvedIds = []
          receipt.unsettledIds = []
          reportImport(context, receipt)
        }
        attemptedId = undefined
        await reconcile()
        if (readAttachmentStage() !== 'confirmed') throw new Error('clip_attachment_incomplete')
      } catch {
        receipt.ready = 'unknown'
        if (!stateReadAttempted) {
          try { await reconcile() } catch { /* Preserve per-file known facts and unresolved mutation. */ }
        }
        if (!stateConfirmed) {
          receipt.staged = 'unknown'
          receipt.unresolvedIds = attemptedId && !receipt.attachedIds!.includes(attemptedId) ? [attemptedId] : []
          receipt.unsettledIds = completionUnknown ? [...receipt.unresolvedIds] : []
        }
        const outcome: ImportOutcome = {
          status: stateConfirmed && readAttachmentStage() === 'failed' ? 'failed' : 'unknown_outcome',
          reason: stateConfirmed && readAttachmentStage() === 'failed' ? 'clip_attachment_incomplete' : 'clip_attachment_unconfirmed', import: receipt
        }
        context.report(outcome)
        return { outcome, files: confirmedFiles }
      }
      receipt.ready = 'confirmed'
    }
    context.check()
    const outcome: ImportOutcome = { status: 'completed', import: receipt }
    context.report(outcome)
    return { outcome, files: confirmedFiles }
  } catch (error) {
    const outcome: ImportOutcome = {
      status: effectRequested ? 'unknown_outcome' : 'failed', reason,
      import: receipt
    }
    context.report(outcome)
    return { outcome, files: confirmedFiles }
  }
}
