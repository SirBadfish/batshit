import { afterAll, afterEach, beforeEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

// Global setup owns the temporary run root. Each file and test gets a different child:
// a deliberate unresolved record in one test must never refuse another test's admission.
const runRoot = process.env.BATSHIT_COMMAND_RECORDS_DIR
if (!runRoot) throw new Error('Host command tests require the isolated global record root.')
const fileRoot = path.join(runRoot, `file-${randomUUID()}`)
let cleanupFailed = false
process.env.BATSHIT_COMMAND_RECORDS_DIR = path.join(fileRoot, 'module-setup')
beforeEach(() => {
  process.env.BATSHIT_COMMAND_RECORDS_DIR = path.join(fileRoot, `case-${randomUUID()}`)
})
afterEach(async () => {
  // Only load the process owner in files which actually used it. File hooks run first,
  // then this safety net ends any live fixture left behind by an assertion failure.
  if ((globalThis as any).__batshitOwnedCommandGroupsV1) {
    const { endLiveOwnedCommandGroups } = await import('$lib/server/services/ownedCommandGroup')
    try { await endLiveOwnedCommandGroups() }
    catch (error) {
      cleanupFailed = true
      const { writeFile } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      await writeFile(path.join(runRoot, 'retain-failed-cleanup'), 'A command fixture failed cleanup; inspect retained per-file records.\n')
      throw error
    }
  }
})
afterAll(async () => {
  const { rm } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  try { if (!cleanupFailed) await rm(fileRoot, { recursive: true, force: true }) }
  finally { process.env.BATSHIT_COMMAND_RECORDS_DIR = runRoot }
})
