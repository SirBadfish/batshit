/**
 * BL-135 guard: no test or script in batshit-app flushes a Redis database.
 *
 * FLUSHDB and FLUSHALL drop every Redis Search index on the whole server, not just the
 * flushed database's, so a test lane that flushed DB15 of a developer's own Redis deleted the
 * Native lane's memory indexes on DB0. A test database is emptied with
 * `clearRedisTestDatabase` (`redis-memory.ts`), which deletes that database's keys only.
 *
 * The one place allowed to flush is the memory-search harness, on the disposable server it
 * owns, plus the BL-135 test that shows the reason on that same server.
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const APP_ROOT = process.cwd()
const SCANNED_ROOTS = ['src', 'scripts', 'build-scripts']
const SCANNED = /\.(ts|js|mjs|cjs|svelte)$/
const ALLOWED = new Set([
  'src/lib/test-utils/memory-search-server.ts',
  'src/lib/server/services/memory/__tests__/realRedisLaneCleanup.test.ts',
  'src/lib/test-utils/noRedisFlush.test.ts'
])
// `client.flushDb()`, `client.flushAll()`, and the raw command in a `sendCommand` array.
const FLUSH_CALL = /\.flush(?:db|all)\s*\(|['"`]flush(?:db|all)['"`]/i

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : filesUnder(full)
    return SCANNED.test(entry.name) ? [full] : []
  })
}

describe('no Redis flush in batshit-app tests and scripts (BL-135)', () => {
  it('finds no flush outside the disposable memory-search server', () => {
    const offenders: string[] = []
    let scanned = 0
    for (const root of SCANNED_ROOTS) {
      for (const file of filesUnder(path.join(APP_ROOT, root))) {
        const relative = path.relative(APP_ROOT, file).split(path.sep).join('/')
        scanned += 1
        if (ALLOWED.has(relative)) continue
        fs.readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, index) => {
            if (FLUSH_CALL.test(line)) offenders.push(`${relative}:${index + 1}: ${line.trim()}`)
          })
      }
    }
    // A scan that read nothing would pass for the wrong reason.
    expect(scanned).toBeGreaterThan(1000)
    expect(offenders).toEqual([])
  })

  it('still sees the one allowed flush, so the pattern matches real calls', () => {
    const allowed = fs.readFileSync(
      path.join(APP_ROOT, 'src/lib/test-utils/memory-search-server.ts'),
      'utf8'
    )
    expect(allowed.split('\n').some((line) => FLUSH_CALL.test(line))).toBe(true)
  })
})
