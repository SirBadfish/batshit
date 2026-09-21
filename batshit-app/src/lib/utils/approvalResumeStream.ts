/** Server-authored start envelope for continuing an existing assistant message. */
export type ApprovalResumeStart = {
  version: number
  prior: {
    content: string
    metadata: Record<string, any>
    intermediateSteps?: any[]
  }
}

export function readApprovalResumeStart(metadata: Record<string, any> | null | undefined): ApprovalResumeStart | null {
  const resume = metadata?.approvalResume
  if (!resume || !Number.isSafeInteger(resume.version) || resume.version <= 0) return null
  if (!resume.prior || typeof resume.prior.content !== 'string') return null
  if (!resume.prior.metadata || typeof resume.prior.metadata !== 'object') return null
  return resume as ApprovalResumeStart
}

/** A replay of a completed (or already-started) continuation must never reopen it. */
export function isNewApprovalResume(existingMetadata: Record<string, any> | undefined, resume: ApprovalResumeStart): boolean {
  const previous = existingMetadata?.approvalResumeVersion
  return !Number.isSafeInteger(previous) || resume.version > previous
}

export function approvalResumeStartPatch(resume: ApprovalResumeStart, metadata: Record<string, any>) {
  const { approvalResume: _envelope, ...startMetadata } = metadata
  return {
    content: resume.prior.content ? `${resume.prior.content.trimEnd()}\n\n` : '',
    metadata: { ...resume.prior.metadata, ...startMetadata, approvalResumeVersion: resume.version },
    intermediateSteps: resume.prior.intermediateSteps,
    status: 'in_progress' as const
  }
}
