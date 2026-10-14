import { access, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Real process tests must never create recovery records beside the user's managed profiles. */
export default async function setup() {
  const previous = process.env.BATSHIT_COMMAND_RECORDS_DIR
  const root = await mkdtemp(path.join(os.tmpdir(), 'batshit-command-records-test-'))
  process.env.BATSHIT_COMMAND_RECORDS_DIR = root
  return async () => {
    if (previous === undefined) delete process.env.BATSHIT_COMMAND_RECORDS_DIR
    else process.env.BATSHIT_COMMAND_RECORDS_DIR = previous
    const retain = await access(path.join(root, 'retain-failed-cleanup')).then(() => true, () => false)
    if (retain) console.error(`Command fixture cleanup failed; retained test records at ${root}`)
    else await rm(root, { recursive: true, force: true })
  }
}
