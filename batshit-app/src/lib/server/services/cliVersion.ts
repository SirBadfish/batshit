/**
 * BL-268 — the version a CLI reports, compared with the version Batshit installs.
 *
 * `claude --version` answers `2.1.280 (Claude Code)`. Only the first `major.minor.patch` is
 * read; a prerelease of a version counts as that version.
 */

export function parseCliVersion(text: string | null | undefined): [number, number, number] | null {
  if (typeof text !== 'string') return null
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Release-specific transport proof must accept the client's actual branded --version
 * line, while refusing prereleases/newer or otherwise unqualified programs. */
export function isExactCliReleaseVersion(runtime: 'claude', found: string | null | undefined, pinned: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(pinned) || typeof found !== 'string') return false
  const value = found.trim()
  return value === pinned || value === `${pinned} (Claude Code)`
}

/** True only when both versions read and `found` is older than `pinned`. */
export function isCliVersionOlder(found: string | null | undefined, pinned: string | null | undefined): boolean {
  const a = parseCliVersion(found)
  const b = parseCliVersion(pinned)
  if (!a || !b) return false
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index]
  }
  return false
}

const VERSION_PROBE_TIMEOUT_MS = 4000

/**
 * What `<executable> --version` prints (first line), or null when it cannot be run in time.
 * Agent Settings reads it for the CLI Batshit found, to say when it is older than the pin.
 */
export async function probeCliVersion(executable: string | null | undefined): Promise<string | null> {
  const target = typeof executable === 'string' ? executable.trim() : ''
  if (!target) return null
  const [{ execFile }, { promisify }, { stripHostOperatorAuthorityFromChildEnv }] = await Promise.all([
    import('node:child_process'),
    import('node:util'),
    import('$lib/server/services/cliChildEnv')
  ])
  try {
    const { stdout } = await promisify(execFile)(target, ['--version'], {
      env: stripHostOperatorAuthorityFromChildEnv({ ...process.env }),
      timeout: VERSION_PROBE_TIMEOUT_MS
    })
    const line = String(stdout ?? '').split('\n')[0]?.trim()
    return line || null
  } catch {
    return null
  }
}
