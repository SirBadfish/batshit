/** Shared identity math: storage and backup admission must name the same candidate. */
export function hairImportCandidateIds(job: {
  jobId: string
  target: { kind: 'new' } | { kind: 'refit'; assetId: string; revisionId: string; revision: number }
}) {
  if (job.target.kind === 'refit') {
    return { assetId: job.target.assetId, revisionId: job.target.revisionId, revision: job.target.revision }
  }
  const assetId = `imported-hair-${job.jobId}`.toLowerCase()
  return { assetId, revisionId: `${assetId}-r1`, revision: 1 }
}

export const HAIR_IMPORT_UPLOAD_RECEIPT_CONTRACT = 'hair-import-upload/v1' as const
export type HairImportUploadOwner = { userId: string; jobId: string }
