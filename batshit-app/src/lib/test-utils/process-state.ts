import { readFileSync } from 'node:fs'

export type TestProcessState = 'absent' | 'live' | 'zombie' | 'unverified'

/** Read-only observation for tests of live command members, never signal authority. */
export function inspectTestProcessState(pid: number): TestProcessState {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unverified'
  try {
    process.kill(pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'absent' : 'unverified'
  }
  if (process.platform !== 'linux') return 'live'
  try {
    // comm can contain spaces and ')'; the greedy group reaches its closing delimiter.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const match = /^(\d+) \((.*)\) ([RSDZTtWXxKPI]) (.*)$/s.exec(stat.trimEnd())
    if (!match || Number(match[1]) !== pid) return 'unverified'
    // Linux's complete stat record has 52 fields (49 numeric fields after state).
    // A truncated prefix cannot establish death; permit additional future fields.
    const fields = match[4].split(/\s+/)
    if (fields.length < 49 || fields.some(field => !/^-?\d+$/.test(field))) return 'unverified'
    return match[3] === 'Z' ? 'zombie' : 'live'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unverified'
  }
}

const reportedZombies = new Set<number>()

/** A zombie has stopped executing but still has a PID; this does not prove reaping. */
export function isTestProcessRunning(pid: number): boolean {
  const state = inspectTestProcessState(pid)
  if (state === 'zombie' && !reportedZombies.has(pid)) {
    reportedZombies.add(pid)
    console.info('test-process-state', { pid, state })
  }
  return state !== 'absent' && state !== 'zombie'
}
