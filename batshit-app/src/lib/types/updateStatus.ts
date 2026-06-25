export type BatshitUpdateStatus = {
  ok: boolean
  updateAvailable: boolean
  currentVersion: string
  latestVersion: string | null
  channel: string
  releaseUrl: string | null
  downloadUrl: string | null
  source: 'github-release' | 'env-override' | 'disabled' | 'unavailable'
  checkedAt: string
  message: string | null
  error: string | null
}
