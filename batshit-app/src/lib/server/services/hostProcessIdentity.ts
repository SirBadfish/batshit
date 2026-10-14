import { execFile } from 'node:child_process'
import { readdir, readFile, readlink } from 'node:fs/promises'
import path from 'node:path'

/** Observation only: persisted identities never authorize signalling a PID or group. */
export type HostProcessIdentity = { pid: number; parent: number; group: number; started: string; state: string; program?: string }
export type HostProcessTable = Map<number, HostProcessIdentity>

export async function readHostProcessTable(): Promise<HostProcessTable> {
  if (process.platform === 'linux') {
    // /proc is available in the slim Docker runtime, which does not install procps.
    // Kernel start ticks also avoid the one-second resolution of macOS ps's lstart.
    const table: HostProcessTable = new Map()
    const deadline = Date.now() + 2_000
    const entries = (await readdir('/proc')).filter((name) => /^\d+$/.test(name))
    for (let offset = 0; offset < entries.length; offset += 64) {
      if (Date.now() > deadline) throw new Error('Host process inspection timed out.')
      await Promise.all(entries.slice(offset, offset + 64).map(async (name) => {
      let stat: string
      try {
        stat = await readFile(`/proc/${name}/stat`, 'utf8')
      } catch (error) {
        // A vanished process is absent; an unreadable process is unknown, not exited.
        if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return
        throw error
      }
      const end = stat.lastIndexOf(') ')
      const fields = stat.slice(end + 2).trim().split(/\s+/)
      if (end < 0 || fields.length < 20 || !/^\d+$/.test(fields[1]) ||
          !/^\d+$/.test(fields[2]) || !/^\d+$/.test(fields[19]) || !/^[A-Za-z]$/.test(fields[0])) {
        throw new Error('Host process inspection received a malformed /proc identity.')
      }
      table.set(Number(name), {
        pid: Number(name), parent: Number(fields[1]), group: Number(fields[2]),
        started: fields[19], state: fields[0],
        program: stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(') ')).slice(0, 80),
      })
      }))
    }
    if (!table.has(process.pid)) throw new Error('Host process inspection could not verify its own process.')
    return table
  }
  const output = await new Promise<string>((resolve, reject) => {
    execFile('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart=,stat=,comm='], {
      timeout: 2_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC0' },
    }, (error, stdout) => error ? reject(error) : resolve(String(stdout)))
  })
  const table: HostProcessTable = new Map()
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+?\d{4})\s+(\S+)\s+(.+)$/)
    if (!line.trim()) continue
    if (!match) throw new Error('Process inspection returned a malformed identity.')
    const [, pid, parent, group, started, state, executable] = match
    table.set(Number(pid), { pid: Number(pid), parent: Number(parent), group: Number(group), started, state, program: path.basename(executable).slice(0, 80) })
  }
  if (table.size === 0) throw new Error('Codex cleanup could not read process identities.')
  return table
}

export type HostBootIdentity = { bootId: string; namespaceId: string }
/** Actual kernel boot identity, never a wall-clock-minus-uptime estimate. */
export async function readHostBootIdentity(): Promise<HostBootIdentity> {
  if (process.platform === 'linux') {
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    const namespaceId = await readlink('/proc/self/ns/pid')
    if (!/^[a-f0-9-]{36}$/i.test(bootId) || !/^pid:\[\d+\]$/.test(namespaceId)) throw new Error('Cannot verify the host boot or process namespace.')
    return { bootId: `linux:${bootId.toLowerCase()}`, namespaceId }
  }
  if (process.platform === 'darwin') {
    const bootId = await new Promise<string>((resolve, reject) => {
      execFile('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout: 2_000, maxBuffer: 1_024
      }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()))
    })
    if (!/^[a-f0-9-]{36}$/i.test(bootId)) throw new Error('Cannot verify the host boot identity.')
    return { bootId: `darwin:${bootId.toLowerCase()}`, namespaceId: 'host' }
  }
  throw new Error('Host process recovery requires macOS or Linux.')
}
