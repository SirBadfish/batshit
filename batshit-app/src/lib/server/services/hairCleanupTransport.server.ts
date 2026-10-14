import { createHash } from 'node:crypto'
import type { HairCleanupContext } from './hairCleanupContext'

/** Obsolete jobs can contain large inspection arrays. Keep their exact raw CAS
 * locally, but send only a digest; the file service materializes its own raw
 * comparison before BEGIN. Current jobs keep the ordinary version fast path. */
export function hairCleanupContextForTransport(context: HairCleanupContext) {
  const { expectedRaw, ...fields } = context
  return expectedRaw ? { ...fields, expectedRawSha256: createHash('sha256').update(expectedRaw).digest('hex') } : fields
}
