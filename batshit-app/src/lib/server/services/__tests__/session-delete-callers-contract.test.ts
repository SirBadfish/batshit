import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every server delete of a chat goes through `deleteSessionStoppingItsTurn` (2026-09-18).
 *
 * `redis.deleteSession` is the sweep alone. Called under a running reply, it swept at once and the
 * reply's request wrote its message, message list, zip, zip set, and Execution Viewer log back
 * into a chat that no longer existed (`_local/deletemid-proof/before-*.json`). The stop-and-wait
 * rule lives in `sessionDeleteTurnStop.ts` rather than in the facade, because the approval gates
 * import the facade and must not reach the rule's command stopper
 * (`jevNeverApproves.pinning.test.ts`). So nothing else on the server may call the sweep, and
 * `redis.deleteFolder` sweeps a folder's chats only through a deleter its caller hands it.
 */

const SRC_DIR = path.resolve('src')

function serverSources(dir: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      files.push(...serverSources(full))
    } else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !/\.d\.ts$/.test(name)) {
      files.push(full)
    }
  }
  return files
}

describe('who may sweep a chat', () => {
  const files = [
    ...serverSources(path.join(SRC_DIR, 'lib', 'server')),
    ...serverSources(path.join(SRC_DIR, 'routes'))
  ]

  it('only the stop-and-wait rule calls the sweep', () => {
    // The walker sees what it should: the facade, the rule, and both delete routes.
    const names = files.map((file) => path.relative(SRC_DIR, file))
    expect(names).toContain(path.join('lib', 'server', 'redis.ts'))
    expect(names).toContain(path.join('lib', 'server', 'services', 'sessionDeleteTurnStop.ts'))
    expect(names).toContain(path.join('routes', 'api', 'sessions', '[id]', '+server.ts'))

    const callers = files
      .filter((file) => /\b(?:redis|this)\.deleteSession\(/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC_DIR, file))
    expect(callers).toEqual([path.join('lib', 'server', 'services', 'sessionDeleteTurnStop.ts')])
  })

  it('the session route and the folder route both delete through the rule', () => {
    const sessionRoute = readFileSync(
      path.join(SRC_DIR, 'routes', 'api', 'sessions', '[id]', '+server.ts'),
      'utf8'
    )
    expect(sessionRoute).toContain('\n    await deleteSessionStoppingItsTurn(params.id!)\n')

    const folderRoute = readFileSync(
      path.join(SRC_DIR, 'routes', 'api', 'folders', '[id]', '+server.ts'),
      'utf8'
    )
    expect(folderRoute).toContain(
      '\n      deleteSessions ? { deleteSessions: true, deleteSession: deleteSessionStoppingItsTurn } : {}\n'
    )
  })
})
